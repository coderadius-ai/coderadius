import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { pruneIncompatibleStoredInEdges } from '../../src/graph/mutations/data-contracts.js';
import { seedDataContainer } from './_helpers/delta-seeds.js';

// ─── Incompatible STORED_IN cleanup invariants ─────────────────────────────
//
// `pruneIncompatibleStoredInEdges` removes legacy `(DataContainer)-[:STORED_IN]
// ->(Datastore)` edges where the DC's `kindFamily` (set by ORM extractors —
// Doctrine/TypeORM/Mongoose) is incompatible with the Datastore's tech family.
// The mutation:
//   - Tombstones edges (sets `valid_to_commit`); never deletes them.
//   - Skips DCs with no kindFamily (legacy-safe).
//   - Skips Datastores with no technology (insufficient evidence).
//   - Clears `dc.technology` when a DC ends up with zero active STORED_IN.
//   - Idempotent: re-runs find no work.

describe('pruneIncompatibleStoredInEdges', () => {
    const PFX = 'cr://test/cleanup/';
    const COMMIT = 'TESTCLEAN';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally { await s.close(); }
    }

    interface DcOpts {
        kindFamily?: 'rdbms' | 'document' | 'kv' | null;
        technology?: string | null;
    }

    async function makeDc(id: string, name: string, opts: DcOpts = {}) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (d:DataContainer {id: $id})
                 SET d.name = $name,
                     d.valid_from_commit = 'TEST',
                     d.valid_to_commit = null,
                     d.kindFamily = $kf,
                     d.technology = $tech`,
                {
                    id, name,
                    kf: opts.kindFamily ?? null,
                    tech: opts.technology ?? null,
                },
            );
        } finally { await s.close(); }
    }

    async function makeDs(id: string, name: string, technology: string | null) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (d:Datastore {id: $id})
                 SET d.name = $name, d.valid_from_commit = 'TEST', d.valid_to_commit = null,
                     d.technology = $tech`,
                { id, name, tech: technology },
            );
        } finally { await s.close(); }
    }

    async function storedIn(dcId: string, dsId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (dc:DataContainer {id: $dc}), (ds:Datastore {id: $ds})
                 MERGE (dc)-[r:STORED_IN]->(ds)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { dc: dcId, ds: dsId },
            );
        } finally { await s.close(); }
    }

    async function activeEdgeExists(dcId: string, dsId: string): Promise<boolean> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (dc:DataContainer {id: $dc})-[r:STORED_IN]->(ds:Datastore {id: $ds})
                 WHERE r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { dc: dcId, ds: dsId },
            );
            const v = r.records[0]?.get('n');
            const n = typeof v === 'object' && 'low' in v ? (v as any).low : Number(v);
            return n > 0;
        } finally { await s.close(); }
    }

    async function getDcTechnology(dcId: string): Promise<string | null> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                'MATCH (dc:DataContainer {id: $id}) RETURN dc.technology AS tech',
                { id: dcId },
            );
            return r.records[0]?.get('tech') ?? null;
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('A) prunes rdbms DC bound to mongo Datastore', async () => {
        const dc = `${PFX}dc:orders`;
        const ds = `${PFX}ds:legacy-mongo`;
        await makeDc(dc, 'orders', { kindFamily: 'rdbms', technology: 'mongodb' });
        await makeDs(ds, 'legacy-mongo', 'mongodb');
        await storedIn(dc, ds);

        const result = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(result.pruned).toBe(1);
        expect(result.cleared).toBe(1);

        // Edge tombstoned
        expect(await activeEdgeExists(dc, ds)).toBe(false);
        // dc.technology cleared (no remaining active STORED_IN)
        expect(await getDcTechnology(dc)).toBeNull();
    });

    it('B) leaves rdbms DC bound to postgres Datastore intact', async () => {
        const dc = `${PFX}dc:invoices`;
        const ds = `${PFX}ds:warehouse`;
        await makeDc(dc, 'invoices', { kindFamily: 'rdbms', technology: 'postgres' });
        await makeDs(ds, 'warehouse', 'postgres');
        await storedIn(dc, ds);

        const result = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(result.pruned).toBe(0);

        expect(await activeEdgeExists(dc, ds)).toBe(true);
        expect(await getDcTechnology(dc)).toBe('postgres');
    });

    it('C) leaves document DC bound to mongo Datastore intact (legitimate)', async () => {
        const dc = `${PFX}dc:archive`;
        const ds = `${PFX}ds:archive-mongo`;
        await makeDc(dc, 'archive', { kindFamily: 'document', technology: 'mongodb' });
        await makeDs(ds, 'archive-mongo', 'mongodb');
        await storedIn(dc, ds);

        const result = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(result.pruned).toBe(0);

        expect(await activeEdgeExists(dc, ds)).toBe(true);
        expect(await getDcTechnology(dc)).toBe('mongodb');
    });

    it('D) leaves DC with unset kindFamily intact (legacy-safe)', async () => {
        const dc = `${PFX}dc:legacy-no-family`;
        const ds = `${PFX}ds:some-mongo`;
        await makeDc(dc, 'legacy-no-family', { kindFamily: null, technology: 'mongodb' });
        await makeDs(ds, 'some-mongo', 'mongodb');
        await storedIn(dc, ds);

        const result = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(result.pruned).toBe(0);

        expect(await activeEdgeExists(dc, ds)).toBe(true);
    });

    it('E) prunes only the incompatible edge when DC has multiple STORED_IN', async () => {
        const dc = `${PFX}dc:multi`;
        const dsGood = `${PFX}ds:multi-mysql`;
        const dsBad = `${PFX}ds:multi-mongo`;
        await makeDc(dc, 'multi', { kindFamily: 'rdbms', technology: 'mongodb' });
        await makeDs(dsGood, 'multi-mysql', 'mysql');
        await makeDs(dsBad, 'multi-mongo', 'mongodb');
        await storedIn(dc, dsGood);
        await storedIn(dc, dsBad);

        const result = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(result.pruned).toBe(1);

        // Good edge survives, bad edge tombstoned.
        expect(await activeEdgeExists(dc, dsGood)).toBe(true);
        expect(await activeEdgeExists(dc, dsBad)).toBe(false);
        // dc.technology NOT cleared because at least one active STORED_IN remains.
        expect(await getDcTechnology(dc)).toBe('mongodb');
    });

    it('F) re-run is idempotent', async () => {
        const dc = `${PFX}dc:idem`;
        const ds = `${PFX}ds:idem-mongo`;
        await makeDc(dc, 'idem', { kindFamily: 'rdbms', technology: 'mongodb' });
        await makeDs(ds, 'idem-mongo', 'mongodb');
        await storedIn(dc, ds);

        const r1 = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(r1.pruned).toBe(1);

        const r2 = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(r2.pruned).toBe(0);
        expect(r2.cleared).toBe(0);
    });

    it('G) skips Datastore with unset technology (insufficient evidence)', async () => {
        const dc = `${PFX}dc:opaque-ds`;
        const ds = `${PFX}ds:opaque`;
        await makeDc(dc, 'opaque-ds', { kindFamily: 'rdbms' });
        await makeDs(ds, 'opaque', null);
        await storedIn(dc, ds);

        const result = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(result.pruned).toBe(0);

        expect(await activeEdgeExists(dc, ds)).toBe(true);
    });

    it('I) preserves authoritative kindFamily across subsequent merges (regression: Doctrine→LLM overwrite)', async () => {
        // Regression: a Doctrine `__class_metadata` chunk
        // stamped a DC with kindFamily='rdbms' (and no binding, because the
        // gate refused the only available Mongo connection). Then an LLM-only
        // call for the same table — without kindFamily, but resolving to the
        // Mongo connection because the gate is undefined-permissive —
        // re-stamped the DC with kindFamily='document' derived from
        // `family('mongodb')`. The result: 30 relational tables silently
        // labelled 'document'. The fix: kindFamily is first-non-null-wins.
        const scope = `${PFX}cs/scope`;
        const name = 'orders';

        // 1st merge: structural Doctrine signal — kindFamily='rdbms', no binding.
        await seedDataContainer(scope, name, COMMIT, {
            kindFamily: 'rdbms',
        });

        const s1 = getNeo4jSession();
        try {
            const r1 = await s1.run(
                `MATCH (dc:DataContainer {scope:$scope, name:$name}) RETURN dc.kindFamily AS kf`,
                { scope, name },
            );
            expect(r1.records[0].get('kf')).toBe('rdbms');
        } finally { await s1.close(); }

        // 2nd merge: derived signal — same DC, but caller passes kindFamily='document'
        // (e.g. inferred from a Mongo binding by graph-writer). Must NOT overwrite.
        await seedDataContainer(scope, name, COMMIT, {
            kindFamily: 'document',
            technology: 'mongodb',
        });

        const s2 = getNeo4jSession();
        try {
            const r2 = await s2.run(
                `MATCH (dc:DataContainer {scope:$scope, name:$name}) RETURN dc.kindFamily AS kf, dc.technology AS tech`,
                { scope, name },
            );
            expect(r2.records[0].get('kf')).toBe('rdbms');     // structural preserved
            expect(r2.records[0].get('tech')).toBe('mongodb'); // first non-null technology
        } finally { await s2.close(); }
    });

    it('J) stamps kindFamily when it was previously null (legacy upgrade path)', async () => {
        // Forward-compat: a pre-fix DC may exist with kindFamily=null. The first
        // structural caller after the fix should be allowed to stamp it.
        const scope = `${PFX}cs/scope2`;
        const name = 'invoices';

        // 1st merge: legacy — no kindFamily.
        await seedDataContainer(scope, name, COMMIT);

        // 2nd merge: structural Doctrine signal arrives.
        await seedDataContainer(scope, name, COMMIT, {
            kindFamily: 'rdbms',
        });

        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (dc:DataContainer {scope:$scope, name:$name}) RETURN dc.kindFamily AS kf`,
                { scope, name },
            );
            expect(r.records[0].get('kf')).toBe('rdbms');
        } finally { await s.close(); }
    });

    it('H) prunes kv DC bound to mongo Datastore (cross-family check)', async () => {
        const dc = `${PFX}dc:cache-key`;
        const ds = `${PFX}ds:not-a-cache`;
        await makeDc(dc, 'cache-key', { kindFamily: 'kv', technology: 'mongodb' });
        await makeDs(ds, 'not-a-cache', 'mongodb');
        await storedIn(dc, ds);

        const result = await pruneIncompatibleStoredInEdges(COMMIT);
        expect(result.pruned).toBe(1);

        expect(await activeEdgeExists(dc, ds)).toBe(false);
    });
});
