import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeAPIInterface,
    mergeAPIEndpoint,
    weldOpenApiAcrossSpecs,
} from '../../src/graph/mutations/api-contracts.js';

// ─── Cross-spec OpenAPI weld (Bug C regression) ──────────────────────────────
//
// Consumer repos commonly vendor copies of provider OpenAPI specs (sometimes
// .json AND .yml). Each spec file produces a distinct APIInterface and
// APIEndpoint per logical route. weldOpenApiAcrossSpecs reconciles vendored
// copies into the authoritative provider-side endpoint after
// reclassifyConsumedAPIs has tagged the consumer-side as CONSUMES_API.

describe('weldOpenApiAcrossSpecs', () => {
    const PFX = 'cr://test/cross-spec/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally {
            await s.close();
        }
    }

    async function makeService(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = 'TEST', s.valid_to_commit = null`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function makeFunction(id: string, serviceId: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:Function {id: $id})
                 SET f.name = $name, f.valid_from_commit = 'TEST', f.valid_to_commit = null
                 WITH f MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:CONTAINS]->(f)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { id, sid: serviceId, name },
            );
        } finally { await s.close(); }
    }

    async function exposes(serviceId: string, apiId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (s:Service {id: $sid}), (api:APIInterface {id: $aid})
                 MERGE (s)-[r:EXPOSES_API]->(api)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { sid: serviceId, aid: apiId },
            );
        } finally { await s.close(); }
    }

    async function consumes(serviceId: string, apiId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (s:Service {id: $sid}), (api:APIInterface {id: $aid})
                 MERGE (s)-[r:CONSUMES_API]->(api)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { sid: serviceId, aid: apiId },
            );
        } finally { await s.close(); }
    }

    async function calls(functionId: string, endpointId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (f:Function {id: $fid}), (e:APIEndpoint {id: $eid})
                 MERGE (f)-[r:CALLS]->(e)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: functionId, eid: endpointId },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('welds vendored .yml + .json copies into the authoritative provider endpoint', async () => {
        const provider = `${PFX}service:provider`;
        const consumer = `${PFX}service:consumer`;
        const fCaller = `${PFX}function:consumer:caller`;

        const authApi = `${PFX}api:provider:src/openapi.yml`;
        const vendoredJson = `${PFX}api:consumer:vendor/provider.oas.json`;
        const vendoredYml = `${PFX}api:consumer:vendor/provider.oas.yml`;

        const authEp = `${PFX}endpoint:provider:src/openapi.yml:POST:/api/foo`;
        const epJson = `${PFX}endpoint:consumer:vendor/provider.oas.json:POST:/api/foo`;
        const epYml = `${PFX}endpoint:consumer:vendor/provider.oas.yml:POST:/api/foo`;

        await makeService(provider, 'provider');
        await makeService(consumer, 'consumer');
        await makeFunction(fCaller, consumer, 'caller');

        await mergeAPIInterface(authApi, 'Authoritative', '1.0', 'C', 'openapi');
        await mergeAPIInterface(vendoredJson, 'Vendored JSON', '1.0', 'C', 'openapi');
        await mergeAPIInterface(vendoredYml, 'Vendored YML', '1.0', 'C', 'openapi');

        await exposes(provider, authApi);
        await consumes(consumer, vendoredJson);
        await consumes(consumer, vendoredYml);

        await mergeAPIEndpoint(authApi, authEp, '/api/foo', 'POST', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(vendoredJson, epJson, '/api/foo', 'POST', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(vendoredYml, epYml, '/api/foo', 'POST', null, '', null, 'C', 'openapi');

        // Caller talks to the .json vendored copy (typical when codegen prefers JSON)
        await calls(fCaller, epJson);

        const result = await weldOpenApiAcrossSpecs('WELD');

        expect(result.weldedEdges).toBe(1);
        expect(result.tombstonedEndpoints).toBe(2); // both .json and .yml vendored copies
        expect(result.ambiguousRoutes).toEqual([]);

        // Caller now points at the authoritative endpoint
        const s = getNeo4jSession();
        try {
            const r1 = await s.run(
                `MATCH (f:Function {id: $f})-[:CALLS]->(e:APIEndpoint {id: $e})
                 RETURN count(*) AS n`,
                { f: fCaller, e: authEp },
            );
            expect(Number(r1.records[0].get('n'))).toBe(1);

            const r2 = await s.run(
                `MATCH (f:Function {id: $f})-[:CALLS]->(e:APIEndpoint {id: $e})
                 RETURN count(*) AS n`,
                { f: fCaller, e: epJson },
            );
            expect(Number(r2.records[0].get('n'))).toBe(0);

            // Both vendored endpoints are tombstoned
            const r3 = await s.run(
                `MATCH (e:APIEndpoint) WHERE e.id IN [$j, $y]
                 RETURN e.id AS id, e.valid_to_commit AS t, e.welded_into AS w`,
                { j: epJson, y: epYml },
            );
            for (const rec of r3.records) {
                expect(rec.get('t')).toBe('WELD');
                expect(rec.get('w')).toBe(authEp);
            }

            // Authoritative endpoint untouched (still active)
            const r4 = await s.run(
                `MATCH (e:APIEndpoint {id: $e}) RETURN e.valid_to_commit AS t`,
                { e: authEp },
            );
            expect(r4.records[0].get('t')).toBeNull();
        } finally { await s.close(); }
    });

    it('skips ambiguous routes (>1 authoritative provider with same path)', async () => {
        const p1 = `${PFX}service:p1`;
        const p2 = `${PFX}service:p2`;
        const consumer = `${PFX}service:consumer`;

        const a1 = `${PFX}api:p1:openapi`;
        const a2 = `${PFX}api:p2:openapi`;
        const v = `${PFX}api:consumer:vendor`;

        const e1 = `${PFX}endpoint:p1:GET:/health`;
        const e2 = `${PFX}endpoint:p2:GET:/health`;
        const ev = `${PFX}endpoint:consumer:GET:/health`;

        await makeService(p1, 'p1');
        await makeService(p2, 'p2');
        await makeService(consumer, 'consumer');
        await mergeAPIInterface(a1, 'p1 OAS', '1.0', 'C', 'openapi');
        await mergeAPIInterface(a2, 'p2 OAS', '1.0', 'C', 'openapi');
        await mergeAPIInterface(v, 'vendored', '1.0', 'C', 'openapi');
        await exposes(p1, a1);
        await exposes(p2, a2);
        await consumes(consumer, v);
        await mergeAPIEndpoint(a1, e1, '/health', 'GET', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(a2, e2, '/health', 'GET', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(v, ev, '/health', 'GET', null, '', null, 'C', 'openapi');

        const result = await weldOpenApiAcrossSpecs('WELD');

        expect(result.weldedEdges).toBe(0);
        expect(result.tombstonedEndpoints).toBe(0);
        expect(result.ambiguousRoutes).toHaveLength(1);
        expect(result.ambiguousRoutes[0]).toMatchObject({ method: 'GET', path: '/health' });
        expect(result.ambiguousRoutes[0].candidates).toEqual(expect.arrayContaining([e1, e2]));

        // Vendored endpoint must remain ACTIVE — we didn't fuse it
        const s = getNeo4jSession();
        try {
            const r = await s.run(`MATCH (e:APIEndpoint {id: $e}) RETURN e.valid_to_commit AS t`, { e: ev });
            expect(r.records[0].get('t')).toBeNull();
        } finally { await s.close(); }
    });

    it('does not weld two CONSUMES_API together (no authoritative side)', async () => {
        const c1 = `${PFX}service:c1`;
        const c2 = `${PFX}service:c2`;

        const v1 = `${PFX}api:c1:vendor`;
        const v2 = `${PFX}api:c2:vendor`;
        const ep1 = `${PFX}endpoint:c1:GET:/items`;
        const ep2 = `${PFX}endpoint:c2:GET:/items`;

        await makeService(c1, 'c1');
        await makeService(c2, 'c2');
        await mergeAPIInterface(v1, 'v1', '1.0', 'C', 'openapi');
        await mergeAPIInterface(v2, 'v2', '1.0', 'C', 'openapi');
        await consumes(c1, v1);
        await consumes(c2, v2);
        await mergeAPIEndpoint(v1, ep1, '/items', 'GET', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(v2, ep2, '/items', 'GET', null, '', null, 'C', 'openapi');

        const result = await weldOpenApiAcrossSpecs('WELD');

        expect(result.weldedEdges).toBe(0);
        expect(result.tombstonedEndpoints).toBe(0);
        expect(result.ambiguousRoutes).toEqual([]);

        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (e:APIEndpoint) WHERE e.id IN [$a,$b]
                 RETURN count(CASE WHEN e.valid_to_commit IS NULL THEN 1 END) AS active`,
                { a: ep1, b: ep2 },
            );
            expect(Number(r.records[0].get('active'))).toBe(2);
        } finally { await s.close(); }
    });

    it('is idempotent: a second invocation is a no-op', async () => {
        const provider = `${PFX}service:provider`;
        const consumer = `${PFX}service:consumer`;
        const f = `${PFX}function:consumer:caller`;
        const auth = `${PFX}api:provider:openapi`;
        const vendor = `${PFX}api:consumer:vendor`;
        const eAuth = `${PFX}endpoint:auth:GET:/x`;
        const eVendor = `${PFX}endpoint:vendor:GET:/x`;

        await makeService(provider, 'provider');
        await makeService(consumer, 'consumer');
        await makeFunction(f, consumer, 'caller');
        await mergeAPIInterface(auth, 'auth', '1.0', 'C', 'openapi');
        await mergeAPIInterface(vendor, 'vendor', '1.0', 'C', 'openapi');
        await exposes(provider, auth);
        await consumes(consumer, vendor);
        await mergeAPIEndpoint(auth, eAuth, '/x', 'GET', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(vendor, eVendor, '/x', 'GET', null, '', null, 'C', 'openapi');
        await calls(f, eVendor);

        const r1 = await weldOpenApiAcrossSpecs('WELD1');
        expect(r1.weldedEdges).toBe(1);
        expect(r1.tombstonedEndpoints).toBe(1);

        const r2 = await weldOpenApiAcrossSpecs('WELD2');
        expect(r2.weldedEdges).toBe(0);
        expect(r2.tombstonedEndpoints).toBe(0);
    });
});
