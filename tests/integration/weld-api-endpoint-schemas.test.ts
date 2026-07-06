import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { weldApiEndpointSchemasByFunction } from '../../src/graph/mutations/data-contracts.js';

// ─── Scope B (parte fattibile): APIEndpoint ↔ DataStructure via shared Function ─
//
// Outbound client side  →  (f)-[:CALLS]->(ep) + (f)-[:PRODUCES]->(ds)
//   ⇒ (ep)-[:HAS_REQUEST_SCHEMA]->(ds)
//
// Outbound client side  →  (f)-[:CALLS]->(ep) + (f)-[:CONSUMES]->(ds)
//   ⇒ (ep)-[:HAS_RESPONSE_SCHEMA]->(ds)
//
// Inbound server side   →  (f)-[:IMPLEMENTS_ENDPOINT]->(ep) + (f)-[:CONSUMES]->(ds)
//   ⇒ (ep)-[:HAS_REQUEST_SCHEMA]->(ds)
//
// Inbound server side   →  (f)-[:IMPLEMENTS_ENDPOINT]->(ep) + (f)-[:PRODUCES]->(ds)
//   ⇒ (ep)-[:HAS_RESPONSE_SCHEMA]->(ds)
//
// Today only the OUTBOUND CALLS + PRODUCES pattern fires in orchestrator: the LLM
// extracts `payload_schema` as the OUTBOUND request body and graph-writer
// already creates the DataStructure + PRODUCES edge. The other 3 patterns are
// scaffolding for future extraction work (INBOUND body extraction, LLM prompt
// extension for response_schema) — the welder is ready when those land.

describe('weldApiEndpointSchemasByFunction (Scope B parte fattibile)', () => {
    const PFX = 'cr://test/weld-ep-sch/';

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

    it('OUTBOUND request: CALLS + PRODUCES → HAS_REQUEST_SCHEMA', async () => {
        const fn = `${PFX}fn:client`;
        const ep = `${PFX}ep:POST_/api/orders`;
        const ds = `${PFX}ds:OrderCreateRequest`;
        await makeNode('Function', fn, 'client');
        await makeNode('APIEndpoint', ep, '/api/orders');
        await makeNode('DataStructure', ds, 'OrderCreateRequest');
        await rel('CALLS', fn, ep);
        await rel('PRODUCES', fn, ds);

        const res = await weldApiEndpointSchemasByFunction('TEST');

        expect(await countEdge('HAS_REQUEST_SCHEMA', ep, ds)).toBe(1);
        expect(res.hasRequestSchemaLinked).toBeGreaterThanOrEqual(1);
    });

    it('OUTBOUND response: CALLS + CONSUMES → HAS_RESPONSE_SCHEMA', async () => {
        const fn = `${PFX}fn:client-resp`;
        const ep = `${PFX}ep:GET_/api/orders`;
        const ds = `${PFX}ds:OrderListResponse`;
        await makeNode('Function', fn, 'client-resp');
        await makeNode('APIEndpoint', ep, '/api/orders');
        await makeNode('DataStructure', ds, 'OrderListResponse');
        await rel('CALLS', fn, ep);
        await rel('CONSUMES', fn, ds);

        const res = await weldApiEndpointSchemasByFunction('TEST');

        expect(await countEdge('HAS_RESPONSE_SCHEMA', ep, ds)).toBe(1);
        expect(res.hasResponseSchemaLinked).toBeGreaterThanOrEqual(1);
    });

    it('INBOUND request: IMPLEMENTS_ENDPOINT + CONSUMES → HAS_REQUEST_SCHEMA', async () => {
        const fn = `${PFX}fn:handler`;
        const ep = `${PFX}ep:POST_/api/handler`;
        const ds = `${PFX}ds:HandlerRequest`;
        await makeNode('Function', fn, 'handler');
        await makeNode('APIEndpoint', ep, '/api/handler');
        await makeNode('DataStructure', ds, 'HandlerRequest');
        await rel('IMPLEMENTS_ENDPOINT', fn, ep);
        await rel('CONSUMES', fn, ds);

        await weldApiEndpointSchemasByFunction('TEST');

        expect(await countEdge('HAS_REQUEST_SCHEMA', ep, ds)).toBe(1);
    });

    it('INBOUND response: IMPLEMENTS_ENDPOINT + PRODUCES → HAS_RESPONSE_SCHEMA', async () => {
        const fn = `${PFX}fn:handler-resp`;
        const ep = `${PFX}ep:GET_/api/handler`;
        const ds = `${PFX}ds:HandlerResponse`;
        await makeNode('Function', fn, 'handler-resp');
        await makeNode('APIEndpoint', ep, '/api/handler');
        await makeNode('DataStructure', ds, 'HandlerResponse');
        await rel('IMPLEMENTS_ENDPOINT', fn, ep);
        await rel('PRODUCES', fn, ds);

        await weldApiEndpointSchemasByFunction('TEST');

        expect(await countEdge('HAS_RESPONSE_SCHEMA', ep, ds)).toBe(1);
    });

    it('idempotent: re-running does not duplicate edges', async () => {
        const fn = `${PFX}fn:idem`;
        const ep = `${PFX}ep:idem`;
        const ds = `${PFX}ds:idem`;
        await makeNode('Function', fn, 'idem');
        await makeNode('APIEndpoint', ep, 'idem');
        await makeNode('DataStructure', ds, 'idem');
        await rel('CALLS', fn, ep);
        await rel('PRODUCES', fn, ds);

        await weldApiEndpointSchemasByFunction('TEST');
        await weldApiEndpointSchemasByFunction('TEST');

        expect(await countEdge('HAS_REQUEST_SCHEMA', ep, ds)).toBe(1);
    });

    it('skips tombstoned source/target nodes and edges', async () => {
        const fn = `${PFX}fn:tomb`;
        const ep = `${PFX}ep:tomb`;
        const ds = `${PFX}ds:tomb`;
        await makeNode('Function', fn, 'tomb');
        await makeNode('APIEndpoint', ep, 'tomb');
        await makeNode('DataStructure', ds, 'tomb');
        await rel('CALLS', fn, ep);
        await rel('PRODUCES', fn, ds);

        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH ({id: $fn})-[r:CALLS]->({id: $ep})
                 SET r.valid_to_commit = 'PREV-COMMIT'`,
                { fn, ep },
            );
        } finally { await s.close(); }

        await weldApiEndpointSchemasByFunction('TEST');

        expect(await countEdge('HAS_REQUEST_SCHEMA', ep, ds)).toBe(0);
    });

    it('tombstones stale edges when the correlation source disappears', async () => {
        const fn = `${PFX}fn:stale`;
        const ep = `${PFX}ep:stale`;
        const dsOld = `${PFX}ds:stale-OLD`;
        const dsNew = `${PFX}ds:stale-NEW`;
        await makeNode('Function', fn, 'stale');
        await makeNode('APIEndpoint', ep, 'stale');
        await makeNode('DataStructure', dsOld, 'StaleOldRequest');
        await makeNode('DataStructure', dsNew, 'StaleNewRequest');
        await rel('CALLS', fn, ep);
        await rel('PRODUCES', fn, dsOld);

        await weldApiEndpointSchemasByFunction('RUN-1');
        expect(await countEdge('HAS_REQUEST_SCHEMA', ep, dsOld)).toBe(1);

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

        await weldApiEndpointSchemasByFunction('RUN-2');

        expect(await countEdge('HAS_REQUEST_SCHEMA', ep, dsNew)).toBe(1);
        expect(await countEdge('HAS_REQUEST_SCHEMA', ep, dsOld)).toBe(0);
    });

    it('does NOT cross-pollinate: PRODUCES with IMPLEMENTS_ENDPOINT goes to RESPONSE not REQUEST', async () => {
        // Sanity: ensure the welder discriminates by Function-Endpoint relation kind.
        const fn = `${PFX}fn:sanity`;
        const ep = `${PFX}ep:sanity`;
        const ds = `${PFX}ds:sanity`;
        await makeNode('Function', fn, 'sanity');
        await makeNode('APIEndpoint', ep, 'sanity');
        await makeNode('DataStructure', ds, 'sanity');
        await rel('IMPLEMENTS_ENDPOINT', fn, ep);
        await rel('PRODUCES', fn, ds);

        await weldApiEndpointSchemasByFunction('TEST');

        // Server PRODUCES → response (outgoing reply), NOT request.
        expect(await countEdge('HAS_REQUEST_SCHEMA', ep, ds)).toBe(0);
        expect(await countEdge('HAS_RESPONSE_SCHEMA', ep, ds)).toBe(1);
    });
});
