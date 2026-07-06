import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeAPIInterface,
    mergeAPIEndpoint,
    reclassifyConsumedAPIs,
    weldOpenApiAcrossSpecs,
} from '../../src/graph/mutations/api-contracts.js';

// ─── Vendored-spec reclassification (mis-EXPOSED regression) ──────────────────
//
// A consumer service vendors a provider's OpenAPI spec (.yml AND .json) under a
// client-adapter dir to CALL the provider. The openapi-extractor stamps every
// spec INBOUND → EXPOSES_API, so the consumer looks like it SERVES the provider's
// API. reclassifyConsumedAPIs must demote those copies to CONSUMES_API so the
// cross-spec welder can collapse them into the provider's authoritative endpoint.
//
// The defeat: the matchmaker decorates the vendored endpoints with spurious
// IMPLEMENTS_ENDPOINT edges — (a) cross-service path-match bleed from the
// provider's own route handler, and (b) a consumer caller mis-bound as an
// implementer. The old "ANY IMPLEMENTS edge ⇒ implemented" guard saw those and
// kept the spec EXPOSED → duplicate endpoints in the UI + no cross-repo blast.
//
// The fix counts only GENUINE implementations: a function THIS service owns,
// rewired from a static code route (`rewired`) or resolver (`rewired_from_code`).

describe('reclassifyConsumedAPIs — vendored spec mis-EXPOSED', () => {
    const PFX = 'cr://test/vendored-reclassify/';

    const provider = `${PFX}service:orders`;
    const consumer = `${PFX}service:inventory`;

    const authApi = `${PFX}api:orders:src/openapi.yml`;
    const vendoredYml = `${PFX}api:inventory:infra/orders/oas/orders.oas.yml`;
    const vendoredJson = `${PFX}api:inventory:infra/orders/oas/orders.oas.json`;

    const authEp = `${PFX}endpoint:orders:src/openapi.yml:POST:/api/orders/reservations`;
    const epYml = `${PFX}endpoint:inventory:orders.oas.yml:POST:/api/orders/reservations`;
    const epJson = `${PFX}endpoint:inventory:orders.oas.json:POST:/api/orders/reservations`;

    // provider's own route handler (the genuine implementer)
    const fRouteHandler = `${PFX}function:orders:routehandler`;
    // consumer's caller + a consumer repository the matchmaker mis-binds as implementer
    const fCaller = `${PFX}function:inventory:caller`;
    const fRepo = `${PFX}function:inventory:repo`;

    async function run(cypher: string, params: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try { return await s.run(cypher, params); } finally { await s.close(); }
    }
    const wipe = () => run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
    const makeService = (id: string, name: string) =>
        run(`CREATE (s:Service {id:$id}) SET s.name=$name, s.valid_from_commit='TEST', s.valid_to_commit=null`, { id, name });
    const makeFunction = (id: string, sid: string, name: string) =>
        run(`CREATE (f:Function {id:$id}) SET f.name=$name, f.valid_from_commit='TEST', f.valid_to_commit=null
             WITH f MATCH (s:Service {id:$sid}) MERGE (s)-[r:CONTAINS]->(f)
             ON CREATE SET r.valid_from_commit='TEST', r.valid_to_commit=null`, { id, sid, name });
    const exposes = (sid: string, aid: string) =>
        run(`MATCH (s:Service {id:$sid}),(a:APIInterface {id:$aid}) MERGE (s)-[r:EXPOSES_API]->(a)
             ON CREATE SET r.valid_from_commit='TEST', r.valid_to_commit=null`, { sid, aid });
    const calls = (fid: string, eid: string) =>
        run(`MATCH (f:Function {id:$fid}),(e:APIEndpoint {id:$eid}) MERGE (f)-[r:CALLS]->(e)
             ON CREATE SET r.valid_from_commit='TEST', r.valid_to_commit=null`, { fid, eid });
    // IMPLEMENTS_ENDPOINT with optional rewire flag (genuine vs matchmaker-fuzzy)
    const impl = (fid: string, eid: string, flag?: 'rewired' | 'rewired_from_code') =>
        run(`MATCH (f:Function {id:$fid}),(e:APIEndpoint {id:$eid}) MERGE (f)-[r:IMPLEMENTS_ENDPOINT]->(e)
             ON CREATE SET r.valid_from_commit='TEST', r.valid_to_commit=null
             ${flag ? `, r.${flag}=true` : ''}`, { fid, eid });

    async function seedBugState() {
        await wipe();
        await makeService(provider, 'orders');
        await makeService(consumer, 'inventory');
        await makeFunction(fRouteHandler, provider, 'POST /api/orders/reservations::__route_handler');
        await makeFunction(fCaller, consumer, 'ReservationClient.reserve');
        await makeFunction(fRepo, consumer, 'ReservationRepository.fetch');

        await mergeAPIInterface(authApi, 'Orders API', '1.0', 'C', 'openapi');
        await mergeAPIInterface(vendoredYml, 'Orders API (vendored yml)', '1.0', 'C', 'openapi');
        await mergeAPIInterface(vendoredJson, 'Orders API (vendored json)', '1.0', 'C', 'openapi');

        // BUG STATE: openapi-extractor stamped all three INBOUND → consumer EXPOSES too.
        await exposes(provider, authApi);
        await exposes(consumer, vendoredYml);
        await exposes(consumer, vendoredJson);

        await mergeAPIEndpoint(authApi, authEp, '/api/orders/reservations', 'POST', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(vendoredYml, epYml, '/api/orders/reservations', 'POST', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(vendoredJson, epJson, '/api/orders/reservations', 'POST', null, '', null, 'C', 'openapi');

        // GENUINE: provider implements its own endpoint, rewired from a static route.
        await impl(fRouteHandler, authEp, 'rewired');
        // SPURIOUS (a) cross-service path-match bleed onto the consumer copies (no rewire).
        await impl(fRouteHandler, epYml);
        await impl(fRouteHandler, epJson);
        // SPURIOUS (b) consumer repository mis-bound as implementer (no rewire).
        await impl(fRepo, epYml);
        // GENUINE consumption: consumer caller CALLS the vendored copy.
        await calls(fCaller, epJson);
    }

    beforeAll(async () => { await initSchema({ silent: true }); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(seedBugState);

    it('demotes vendored copies to CONSUMES_API and keeps the provider EXPOSED', async () => {
        const reclassified = await reclassifyConsumedAPIs('RC');

        const reclassifiedUrns = reclassified.map(r => r.apiUrn).sort();
        expect(reclassifiedUrns).toEqual([vendoredJson, vendoredYml].sort());

        // Provider keeps EXPOSES_API (genuine rewired implementer present).
        const prov = await run(
            `MATCH (s:Service {id:$s})-[r]->(a:APIInterface {id:$a}) RETURN type(r) AS rel`,
            { s: provider, a: authApi });
        expect(prov.records.map(x => x.get('rel'))).toEqual(['EXPOSES_API']);

        // Consumer now CONSUMES_API both vendored copies, EXPOSES neither.
        const cons = await run(
            `MATCH (s:Service {id:$s})-[r]->(a:APIInterface) WHERE a.id IN [$y,$j]
             RETURN a.id AS api, type(r) AS rel, a.direction AS dir ORDER BY api`,
            { s: consumer, y: vendoredYml, j: vendoredJson });
        for (const rec of cons.records) {
            expect(rec.get('rel')).toBe('CONSUMES_API');
            expect(rec.get('dir')).toBe('OUTBOUND');
        }
        expect(cons.records).toHaveLength(2);
    });

    it('after reclassify, the welder collapses 3 endpoints to 1 and rewires the consumer CALLS', async () => {
        await reclassifyConsumedAPIs('RC');
        const weld = await weldOpenApiAcrossSpecs('WELD');

        // Problem 1: vendored .yml + .json fuse into the provider's authoritative endpoint.
        expect(weld.tombstonedEndpoints).toBe(2);
        expect(weld.ambiguousRoutes).toEqual([]);

        const live = await run(
            `MATCH (e:APIEndpoint) WHERE e.id IN [$a,$y,$j] AND e.valid_to_commit IS NULL RETURN e.id AS id`,
            { a: authEp, y: epYml, j: epJson });
        expect(live.records.map(r => r.get('id'))).toEqual([authEp]);

        // Problem 2: the consumer's CALLS now lands on the provider's endpoint,
        // so a blast traversal from the provider reaches the consumer.
        const reach = await run(
            `MATCH (f:Function {id:$f})-[:CALLS]->(e:APIEndpoint {id:$a}) RETURN count(*) AS n`,
            { f: fCaller, a: authEp });
        expect(Number(reach.records[0].get('n'))).toBe(1);
    });
});
