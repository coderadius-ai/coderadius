import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { deleteOrphanDataContainers } from '../../src/graph/mutations/data-contracts.js';

// ─── Orphan cleanup invariants ─────────────────────────────────────────────
//
// `deleteOrphanDataContainers` reaps DataContainer nodes that have no active
// inbound references. A previous bug ignored MAPS_TO edges (emitted by ORM
// static extractors — Doctrine, Laravel Eloquent, TypeORM `@Entity`).
//
// Liveness model: a DataContainer survives GC when it has at least one live
// (READS|WRITES|MAPS_TO) from a Function, OR a live DEFINES from a SourceFile.
// STORED_IN (DataContainer→Datastore) is NOT load-bearing because it is always
// created alongside a function edge; a DC with only STORED_IN means all
// function edges were tombstoned (e.g. ORM table rename) and the DC is stale.

describe('deleteOrphanDataContainers', () => {
    const PFX = 'cr://test/orphan-cleanup/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally {
            await s.close();
        }
    }

    async function makeDc(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (d:DataContainer {id: $id})
                 SET d.name = $name, d.valid_from_commit = 'TEST', d.valid_to_commit = null`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function makeDs(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (d:Datastore {id: $id})
                 SET d.name = $name, d.valid_from_commit = 'TEST', d.valid_to_commit = null,
                     d.technology = 'mysql'`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function makeFn(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:Function {id: $id})
                 SET f.name = $name, f.valid_from_commit = 'TEST', f.valid_to_commit = null`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function rel(rt: 'READS' | 'WRITES' | 'MAPS_TO' | 'STORED_IN' | 'DEFINES', srcId: string, dstId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (a {id: $sid}), (b {id: $did})
                 MERGE (a)-[r:${rt}]->(b)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { sid: srcId, did: dstId },
            );
        } finally { await s.close(); }
    }

    async function exists(id: string): Promise<boolean> {
        const s = getNeo4jSession();
        try {
            const r = await s.run('MATCH (n {id: $id}) RETURN n LIMIT 1', { id });
            return r.records.length > 0;
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('preserves DataContainer reachable only via MAPS_TO (Doctrine/Laravel/TypeORM entity)', async () => {
        const dc = `${PFX}dc:loyalty_rewards`;
        const fn = `${PFX}fn:DoctrineEntity::__class_metadata`;
        await makeDc(dc, 'loyalty_rewards');
        await makeFn(fn, 'DoctrineEntity::__class_metadata');
        await rel('MAPS_TO', fn, dc);

        await deleteOrphanDataContainers();

        expect(await exists(dc)).toBe(true);
    });

    it('deletes DataContainer reachable only via outbound STORED_IN (no function refs)', async () => {
        // STORED_IN alone is not load-bearing: mergeDataContainer always pairs
        // with linkFunctionReadsOrWritesDataContainer, so a DC with only
        // STORED_IN at GC time means all function edges were tombstoned
        // (e.g. ORM entity table rename) and the DC is stale.
        const dc = `${PFX}dc:orders`;
        const ds = `${PFX}ds:app_main`;
        await makeDc(dc, 'orders');
        await makeDs(ds, 'app_main');
        await rel('STORED_IN', dc, ds);  // DataContainer -[:STORED_IN]-> Datastore

        await deleteOrphanDataContainers();

        expect(await exists(dc)).toBe(false);
    });

    it('preserves DataContainer with READS edge (existing behavior)', async () => {
        const dc = `${PFX}dc:users`;
        const fn = `${PFX}fn:findUser`;
        await makeDc(dc, 'users');
        await makeFn(fn, 'findUser');
        await rel('READS', fn, dc);

        await deleteOrphanDataContainers();

        expect(await exists(dc)).toBe(true);
    });

    it('preserves DataContainer with WRITES edge (existing behavior)', async () => {
        const dc = `${PFX}dc:audit_log`;
        const fn = `${PFX}fn:writeAudit`;
        await makeDc(dc, 'audit_log');
        await makeFn(fn, 'writeAudit');
        await rel('WRITES', fn, dc);

        await deleteOrphanDataContainers();

        expect(await exists(dc)).toBe(true);
    });

    it('deletes DataContainer with NO active inbound or outbound (true orphan)', async () => {
        const dc = `${PFX}dc:zombie`;
        await makeDc(dc, 'zombie');

        await deleteOrphanDataContainers();

        expect(await exists(dc)).toBe(false);
    });

    it('does NOT preserve when only a Function with reversed STORED_IN exists (negative direction)', async () => {
        // Sanity: an inverted STORED_IN edge (Datastore -> DataContainer) is
        // wrong by design and must not be counted as a reference.
        const dc = `${PFX}dc:fake_reverse`;
        const ds = `${PFX}ds:fake_ds`;
        await makeDc(dc, 'fake_reverse');
        await makeDs(ds, 'fake_ds');
        await rel('STORED_IN', ds, dc);   // wrong direction

        await deleteOrphanDataContainers();

        expect(await exists(dc)).toBe(false);
    });

    it('preserves DataContainer when only DEFINES exists from a SourceFile', async () => {
        const dc = `${PFX}dc:defined_only`;
        const sf = `${PFX}sf:Entity.php`;
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:SourceFile {id: $id})
                 SET f.path = $path, f.valid_from_commit = 'TEST', f.valid_to_commit = null`,
                { id: sf, path: 'Entity.php' },
            );
        } finally { await s.close(); }
        await makeDc(dc, 'defined_only');
        await rel('DEFINES', sf, dc);

        await deleteOrphanDataContainers();

        expect(await exists(dc)).toBe(true);
    });

    it('preserves DataContainer when only DEFINES exists from a StructuralFile (migration-declared table)', async () => {
        const dc = `${PFX}dc:migration_declared`;
        const stf = `${PFX}stf:Version20240101.php`;
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:StructuralFile {id: $id}) SET f.path = 'data/Migrations/Version20240101.php'`,
                { id: stf },
            );
        } finally { await s.close(); }
        await makeDc(dc, 'migration_declared');
        await rel('DEFINES', stf, dc);

        await deleteOrphanDataContainers();

        expect(await exists(dc)).toBe(true);
    });
});
