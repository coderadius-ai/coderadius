import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    deleteOrphanDataContainers,
    reconcileRenamedEntityTables,
} from '../../src/graph/mutations/data-contracts.js';

// ─── Entity table rename GC ────────────────────────────────────────────────
//
// When an ORM entity changes its @Table(name=...) annotation, the pipeline
// re-processes the __class_metadata function and writes a new MAPS_TO edge.
// But Merkle-cached functions still have READS/WRITES edges to the OLD
// DataContainer, and the old DC→Datastore STORED_IN edge is never
// tombstoned by tombstoneFunctionRelationships (Function→* only).
//
// reconcileRenamedEntityTables + the updated deleteOrphanDataContainers
// must retire stale edges and GC the orphaned DataContainer.

describe('entity table rename GC', () => {
    const PFX = 'cr://test/entity-rename-gc/';
    const COMMIT = 'RENAME_RUN';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally {
            await s.close();
        }
    }

    async function createNode(label: string, id: string, props: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try {
            const propEntries = Object.entries(props)
                .map(([k, _v], i) => `n.${k} = $p${i}`)
                .join(', ');
            const setClause = propEntries
                ? `SET n.valid_from_commit = 'TEST', n.valid_to_commit = null, ${propEntries}`
                : `SET n.valid_from_commit = 'TEST', n.valid_to_commit = null`;
            const params: Record<string, unknown> = { id };
            Object.values(props).forEach((v, i) => { params[`p${i}`] = v; });
            await s.run(`CREATE (n:${label} {id: $id}) ${setClause}`, params);
        } finally {
            await s.close();
        }
    }

    async function createEdge(
        fromId: string, rel: string, toId: string,
        validToCommit: string | null = null,
    ) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (a {id: $from}), (b {id: $to})
                 CREATE (a)-[r:${rel}]->(b)
                 SET r.valid_from_commit = 'TEST', r.valid_to_commit = $vtc`,
                { from: fromId, to: toId, vtc: validToCommit },
            );
        } finally {
            await s.close();
        }
    }

    async function countLiveNodes(label: string): Promise<number> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (n:${label}) WHERE n.id STARTS WITH $p AND n.valid_to_commit IS NULL RETURN count(n) AS c`,
                { p: PFX },
            );
            const v = r.records[0]?.get('c') ?? 0;
            return typeof v === 'object' && 'low' in v ? (v as any).low : Number(v);
        } finally {
            await s.close();
        }
    }

    async function countLiveEdges(fromId: string, rel: string): Promise<number> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (a {id: $id})-[r:${rel}]->() WHERE r.valid_to_commit IS NULL RETURN count(r) AS c`,
                { id: fromId },
            );
            const v = r.records[0]?.get('c') ?? 0;
            return typeof v === 'object' && 'low' in v ? (v as any).low : Number(v);
        } finally {
            await s.close();
        }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('STORED_IN alone does not keep DataContainer alive after all function edges are tombstoned', async () => {
        // Setup: DC with a tombstoned MAPS_TO from a function, but live STORED_IN to a Datastore
        const dcId = `${PFX}dc:old_table`;
        const dsId = `${PFX}ds:mysql`;
        const funcId = `${PFX}fn:Entity\\Acme::__class_metadata`;

        await createNode('DataContainer', dcId, { name: 'old_table' });
        await createNode('Datastore', dsId, { name: 'mysql', technology: 'mysql' });
        await createNode('Function', funcId, { name: 'Entity\\Acme::__class_metadata' });

        // MAPS_TO is tombstoned (function was re-processed)
        await createEdge(funcId, 'MAPS_TO', dcId, COMMIT);
        // STORED_IN is still live (not touched by tombstoneFunctionRelationships)
        await createEdge(dcId, 'STORED_IN', dsId);

        expect(await countLiveNodes('DataContainer')).toBe(1);

        await deleteOrphanDataContainers();

        expect(await countLiveNodes('DataContainer')).toBe(0);
    });

    it('reconcileRenamedEntityTables tombstones stale edges from cached functions', async () => {
        // Setup: __class_metadata has tombstoned MAPS_TO to old DC, live MAPS_TO to new DC
        // Another function (cached) still has READS edge to old DC
        const metaFuncId = `${PFX}fn:Entity\\Acme::__class_metadata`;
        const cachedFuncId = `${PFX}fn:AcmeRepository.find`;
        const oldDcId = `${PFX}dc:old_table`;
        const newDcId = `${PFX}dc:new_table`;
        const dsId = `${PFX}ds:mysql`;

        await createNode('Function', metaFuncId, { name: 'Entity\\Acme::__class_metadata' });
        await createNode('Function', cachedFuncId, { name: 'AcmeRepository.find' });
        await createNode('DataContainer', oldDcId, { name: 'old_table' });
        await createNode('DataContainer', newDcId, { name: 'new_table' });
        await createNode('Datastore', dsId, { name: 'mysql', technology: 'mysql' });

        // __class_metadata: tombstoned MAPS_TO to old, live MAPS_TO to new
        await createEdge(metaFuncId, 'MAPS_TO', oldDcId, COMMIT);
        await createEdge(metaFuncId, 'MAPS_TO', newDcId);

        // Cached function: live READS to old DC (stale from previous ingestion)
        await createEdge(cachedFuncId, 'READS', oldDcId);

        // Old DC still has live STORED_IN to Datastore
        await createEdge(oldDcId, 'STORED_IN', dsId);

        // Before reconciliation: old DC has live refs
        expect(await countLiveEdges(cachedFuncId, 'READS')).toBe(1);
        expect(await countLiveEdges(oldDcId, 'STORED_IN')).toBe(1);

        const tombstoned = await reconcileRenamedEntityTables(COMMIT);
        expect(tombstoned).toBeGreaterThan(0);

        // After reconciliation: stale edges are tombstoned
        expect(await countLiveEdges(cachedFuncId, 'READS')).toBe(0);
        expect(await countLiveEdges(oldDcId, 'STORED_IN')).toBe(0);

        // GC should now delete the old DC
        await deleteOrphanDataContainers();
        expect(await countLiveNodes('DataContainer')).toBe(1); // only new_table survives
    });

    it('reconcileRenamedEntityTables is a no-op when no entity table was renamed', async () => {
        const metaFuncId = `${PFX}fn:Entity\\Acme::__class_metadata`;
        const dcId = `${PFX}dc:stable_table`;

        await createNode('Function', metaFuncId, { name: 'Entity\\Acme::__class_metadata' });
        await createNode('DataContainer', dcId, { name: 'stable_table' });
        await createEdge(metaFuncId, 'MAPS_TO', dcId);

        const tombstoned = await reconcileRenamedEntityTables(COMMIT);
        expect(tombstoned).toBe(0);
    });
});
