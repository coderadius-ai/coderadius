import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { pruneDatastoreNameEchoContainers } from '../../src/graph/mutations/data-contracts.js';

// ─── Datastore-name echo cleanup ───────────────────────────────────────────
//
// The LLM extracts a database SELECTION (e.g. `selectDatabase('archive')` in DI
// / container-builder config) as if it were a collection, producing a self-echo:
//   (:DataContainer{name:'archive'})-[:STORED_IN]->(:Datastore{name:'archive'})
// The database identity already IS the Datastore; the duplicate container is a
// false node. `pruneDatastoreNameEchoContainers` hard-deletes any DataContainer
// whose name equals a Datastore it is STORED_IN. Structural, no hardcoded names.

describe('pruneDatastoreNameEchoContainers', () => {
    const PFX = 'cr://test/name-echo/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally { await s.close(); }
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

    async function makeDs(id: string, name: string, technology: string) {
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

    async function nodeExists(id: string, label: string): Promise<boolean> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(`MATCH (n:${label} {id: $id}) RETURN count(n) AS n`, { id });
            const v = r.records[0]?.get('n');
            const n = typeof v === 'object' && v && 'low' in v ? (v as any).low : Number(v);
            return n > 0;
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('A) deletes a DataContainer whose name echoes its own Datastore', async () => {
        const dc = `${PFX}dc:archive`;
        const ds = `${PFX}ds:archive`;
        await makeDc(dc, 'archive');
        await makeDs(ds, 'archive', 'mongodb');
        await storedIn(dc, ds);

        const removed = await pruneDatastoreNameEchoContainers();
        expect(removed).toBe(1);
        expect(await nodeExists(dc, 'DataContainer')).toBe(false);
        // The Datastore (the real database identity) MUST survive.
        expect(await nodeExists(ds, 'Datastore')).toBe(true);
    });

    it('B) GUARDRAIL: a real collection (different name) STORED_IN the datastore survives', async () => {
        const echo = `${PFX}dc:archive`;
        const real = `${PFX}dc:orders`;
        const ds = `${PFX}ds:archive`;
        await makeDc(echo, 'archive');
        await makeDc(real, 'orders');
        await makeDs(ds, 'archive', 'mongodb');
        await storedIn(echo, ds);
        await storedIn(real, ds);

        const removed = await pruneDatastoreNameEchoContainers();
        expect(removed).toBe(1);
        expect(await nodeExists(echo, 'DataContainer')).toBe(false);
        expect(await nodeExists(real, 'DataContainer')).toBe(true);
        expect(await nodeExists(ds, 'Datastore')).toBe(true);
    });

    it('C) deletes the echo node even when it is also STORED_IN a differently-named datastore', async () => {
        // The observed field shape: a single 'archive' container STORED_IN both the
        // 'archive' datastore (echo) and the 'integration-hub' datastore. The
        // node qualifies via the echo edge, so the whole node (and both edges) go.
        const dc = `${PFX}dc:archive`;
        const dsEcho = `${PFX}ds:archive`;
        const dsOther = `${PFX}ds:integration-hub`;
        await makeDc(dc, 'archive');
        await makeDs(dsEcho, 'archive', 'mongodb');
        await makeDs(dsOther, 'integration-hub', 'mongodb');
        await storedIn(dc, dsEcho);
        await storedIn(dc, dsOther);

        const removed = await pruneDatastoreNameEchoContainers();
        expect(removed).toBe(1);
        expect(await nodeExists(dc, 'DataContainer')).toBe(false);
        expect(await nodeExists(dsEcho, 'Datastore')).toBe(true);
        expect(await nodeExists(dsOther, 'Datastore')).toBe(true);
    });

    it('D) GUARDRAIL: a real table NOT stored in a same-named datastore survives', async () => {
        const dc = `${PFX}dc:orders`;
        const ds = `${PFX}ds:warehouse`;
        await makeDc(dc, 'orders');
        await makeDs(ds, 'warehouse', 'postgres');
        await storedIn(dc, ds);

        const removed = await pruneDatastoreNameEchoContainers();
        expect(removed).toBe(0);
        expect(await nodeExists(dc, 'DataContainer')).toBe(true);
    });

    it('E) re-run is idempotent', async () => {
        const dc = `${PFX}dc:archive`;
        const ds = `${PFX}ds:archive`;
        await makeDc(dc, 'archive');
        await makeDs(ds, 'archive', 'mongodb');
        await storedIn(dc, ds);

        expect(await pruneDatastoreNameEchoContainers()).toBe(1);
        expect(await pruneDatastoreNameEchoContainers()).toBe(0);
    });
});
