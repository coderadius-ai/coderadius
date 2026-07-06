import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { weldChannelPayloadsByFunction } from '../../src/graph/mutations/data-contracts.js';

// ─── Scope A: MessageChannel ↔ DataStructure via shared Function ─────────
//
// Producer correlation:  (f)-[:PRODUCES]->(ds)  +  (f)-[:PUBLISHES_TO]->(ch)
//                        ──────────────────────────────────────────────────
//                              ⇒ (ch)-[:HAS_SCHEMA]->(ds)
//                              ⇒ (ds)-[:CARRIED_BY]->(ch)
//
// Consumer correlation:  (f)-[:CONSUMES]->(ds)   +  (f)-[:LISTENS_TO]->(ch)
//                              ⇒ same pair of edges
//
// Pre-fix: orchestrator's graph had 18 MessageChannels and 63 emergent
// payloads — both correctly extracted, but ZERO HAS_SCHEMA / CARRIED_BY
// edges between them. The Avro-file-path welder (`inferAndLinkChannelSchemas`)
// couldn't fire because the payloads were LLM-emergent (no .avsc file).
// This welder uses the Function membership as the bridge.
//
// FP risk (documented): a Function that publishes to N channels and
// produces M payloads creates N×M edges (Cartesian). Most publisher
// functions are 1-1 or 1-many; pure N-many cases are rare in practice
// but produce over-linkage. Documented as a known limitation of Scope A.

describe('weldChannelPayloadsByFunction (Scope A)', () => {
    const PFX = 'cr://test/weld-ch-pl/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally { await s.close(); }
    }

    async function makeNode(label: string, id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (n:${label} {id: $id})
                 SET n.name = $name, n.valid_from_commit = 'TEST', n.valid_to_commit = null`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function rel(rt: string, srcId: string, dstId: string) {
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

    async function countEdge(rt: string, srcId: string, dstId: string): Promise<number> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (a {id: $sid})-[r:${rt}]->(b {id: $did})
                 WHERE r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { sid: srcId, did: dstId },
            );
            const v = r.records[0].get('n');
            return typeof v === 'number' ? v : (typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('producer side: PUBLISHES_TO + PRODUCES → HAS_SCHEMA + CARRIED_BY', async () => {
        const fn = `${PFX}fn:publisher`;
        const ch = `${PFX}ch:acme.payment.received`;
        const ds = `${PFX}ds:PaymentEvent`;
        await makeNode('Function', fn, 'publisher');
        await makeNode('MessageChannel', ch, 'acme.payment.received');
        await makeNode('DataStructure', ds, 'PaymentEvent');
        await rel('PUBLISHES_TO', fn, ch);
        await rel('PRODUCES', fn, ds);

        // RED before fix: weldChannelPayloadsByFunction doesn't exist OR
        // doesn't create the edges. After fix: both edges created.
        const res = await weldChannelPayloadsByFunction('TEST');

        expect(await countEdge('HAS_SCHEMA', ch, ds)).toBe(1);
        expect(await countEdge('CARRIED_BY', ds, ch)).toBe(1);
        expect(res.hasSchemaLinked).toBeGreaterThanOrEqual(1);
        expect(res.carriedByLinked).toBeGreaterThanOrEqual(1);
    });

    it('consumer side: LISTENS_TO + CONSUMES → HAS_SCHEMA + CARRIED_BY', async () => {
        const fn = `${PFX}fn:consumer`;
        const ch = `${PFX}ch:acme.order.placed`;
        const ds = `${PFX}ds:OrderPlaced`;
        await makeNode('Function', fn, 'consumer');
        await makeNode('MessageChannel', ch, 'acme.order.placed');
        await makeNode('DataStructure', ds, 'OrderPlaced');
        await rel('LISTENS_TO', fn, ch);
        await rel('CONSUMES', fn, ds);

        await weldChannelPayloadsByFunction('TEST');

        expect(await countEdge('HAS_SCHEMA', ch, ds)).toBe(1);
        expect(await countEdge('CARRIED_BY', ds, ch)).toBe(1);
    });

    it('idempotent: re-running does not duplicate edges', async () => {
        const fn = `${PFX}fn:publisher2`;
        const ch = `${PFX}ch:acme.x`;
        const ds = `${PFX}ds:X`;
        await makeNode('Function', fn, 'publisher2');
        await makeNode('MessageChannel', ch, 'acme.x');
        await makeNode('DataStructure', ds, 'X');
        await rel('PUBLISHES_TO', fn, ch);
        await rel('PRODUCES', fn, ds);

        await weldChannelPayloadsByFunction('TEST');
        await weldChannelPayloadsByFunction('TEST');

        expect(await countEdge('HAS_SCHEMA', ch, ds)).toBe(1);
        expect(await countEdge('CARRIED_BY', ds, ch)).toBe(1);
    });

    it('skips tombstoned source/target nodes and edges (validity filter)', async () => {
        const fn = `${PFX}fn:tomb`;
        const ch = `${PFX}ch:tomb`;
        const ds = `${PFX}ds:tomb`;
        await makeNode('Function', fn, 'tomb');
        await makeNode('MessageChannel', ch, 'tomb');
        await makeNode('DataStructure', ds, 'tomb');
        await rel('PUBLISHES_TO', fn, ch);
        await rel('PRODUCES', fn, ds);

        // Tombstone the PUBLISHES_TO edge.
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH ({id: $fn})-[r:PUBLISHES_TO]->({id: $ch})
                 SET r.valid_to_commit = 'PREV-COMMIT'`,
                { fn, ch },
            );
        } finally { await s.close(); }

        await weldChannelPayloadsByFunction('TEST');

        expect(await countEdge('HAS_SCHEMA', ch, ds)).toBe(0);
        expect(await countEdge('CARRIED_BY', ds, ch)).toBe(0);
    });

    it('tombstones stale edges when the correlation source disappears (mark-and-sweep)', async () => {
        // RUN 1: function f → ch + ds, welder creates HAS_SCHEMA + CARRIED_BY.
        const fn = `${PFX}fn:stale`;
        const ch = `${PFX}ch:stale`;
        const dsOld = `${PFX}ds:stale-OLD`;
        const dsNew = `${PFX}ds:stale-NEW`;
        await makeNode('Function', fn, 'stale');
        await makeNode('MessageChannel', ch, 'stale');
        await makeNode('DataStructure', dsOld, 'StaleOldPayload');
        await makeNode('DataStructure', dsNew, 'StaleNewPayload');
        await rel('PUBLISHES_TO', fn, ch);
        await rel('PRODUCES', fn, dsOld);

        await weldChannelPayloadsByFunction('RUN-1');

        expect(await countEdge('HAS_SCHEMA', ch, dsOld)).toBe(1);
        expect(await countEdge('CARRIED_BY', dsOld, ch)).toBe(1);

        // RUN 2: function stops producing dsOld, starts producing dsNew.
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH ({id: $fn})-[r:PRODUCES]->({id: $dsOld})
                 SET r.valid_to_commit = 'RUN-2'`,
                { fn, dsOld },
            );
            await s.run(
                `MATCH (a {id: $fn}), (b {id: $dsNew})
                 MERGE (a)-[r:PRODUCES]->(b)
                 ON CREATE SET r.valid_from_commit = 'RUN-2', r.valid_to_commit = null`,
                { fn, dsNew },
            );
        } finally { await s.close(); }

        await weldChannelPayloadsByFunction('RUN-2');

        // dsNew should now be welded; dsOld's welded edges should be TOMBSTONED.
        expect(await countEdge('HAS_SCHEMA', ch, dsNew)).toBe(1);
        expect(await countEdge('CARRIED_BY', dsNew, ch)).toBe(1);
        expect(await countEdge('HAS_SCHEMA', ch, dsOld)).toBe(0);
        expect(await countEdge('CARRIED_BY', dsOld, ch)).toBe(0);
    });

    it('one Function publishing to N channels and producing 1 payload → N×1 links', async () => {
        const fn = `${PFX}fn:fanout`;
        const ch1 = `${PFX}ch:fanout-1`;
        const ch2 = `${PFX}ch:fanout-2`;
        const ds = `${PFX}ds:Fanout`;
        await makeNode('Function', fn, 'fanout');
        await makeNode('MessageChannel', ch1, 'fanout-1');
        await makeNode('MessageChannel', ch2, 'fanout-2');
        await makeNode('DataStructure', ds, 'Fanout');
        await rel('PUBLISHES_TO', fn, ch1);
        await rel('PUBLISHES_TO', fn, ch2);
        await rel('PRODUCES', fn, ds);

        await weldChannelPayloadsByFunction('TEST');

        // Both channels should carry the single payload.
        expect(await countEdge('HAS_SCHEMA', ch1, ds)).toBe(1);
        expect(await countEdge('HAS_SCHEMA', ch2, ds)).toBe(1);
        expect(await countEdge('CARRIED_BY', ds, ch1)).toBe(1);
        expect(await countEdge('CARRIED_BY', ds, ch2)).toBe(1);
    });
});
