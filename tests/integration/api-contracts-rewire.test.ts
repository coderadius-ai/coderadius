import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeAPIInterface,
    mergeCodeInferredAPIInterface,
    mergeAPIEndpoint,
    mergeCodeExposedEndpoint,
    mergeSDLGraphQLEndpoint,
    mergeCodeInferredGraphQLEndpoint,
    rewireImplementsEdgesToOpenApi,
    rewireGraphQLCodeToSDL,
    linkServiceExposesAPI,
} from '../../src/graph/mutations/api-contracts.js';

// ─── Multi-tenant safety + Bug A + Bug B regression tests ────────────────────
//
// Verifies that:
//   1. mergeAPIInterface stamps APIInterface.source correctly (Bug A fix).
//   2. rewireImplementsEdgesToOpenApi rewires IMPLEMENTS_ENDPOINT from a
//      code-inferred APIEndpoint to an OpenAPI APIEndpoint when the same
//      service exposes both with matching (method, path).
//   3. The (s:Service) anchor isolates the rewire — two services with
//      colliding paths (e.g. both expose POST /health) MUST NOT cross-fuse.
//   4. mergeAPIInterface accepts 'sdl' source for GraphQL SDL, and that
//      passing 'sdl' as source no longer corrupts the version field
//      (regression for graphql-schema-extractor.ts:258).

describe('api-contracts: APIInterface.source + rewire isolation', () => {
    const PFX = 'cr://test/rewire/';

    async function wipeTestNodes() {
        const session = getNeo4jSession();
        try {
            // PFX-scoped fixture nodes (services, functions, openapi endpoints).
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            // Code-inferred endpoints have URNs `cr:endpoint:code:METHOD:PATH` that are
            // NOT PFX-scoped (mergeCodeExposedEndpoint produces deterministic URNs).
            // Wipe the paths this suite creates so re-runs don't leak across tests.
            const paths = ['/api/foo', '/api/bar', '/health', '/pages/inventory/items/add.php', '/api/widgets'];
            await session.run(
                'MATCH (ep:APIEndpoint) WHERE ep.epSource = "code" AND ep.path IN $paths DETACH DELETE ep',
                { paths },
            );
            // GraphQL code-inferred + SDL endpoints created by the rewireGraphQLCodeToSDL
            // suite have URNs derived from PFX-scoped apiUrns, so they fall under the
            // first wipe. Belt-and-suspenders: also drop any graphql endpoints whose
            // operationName matches the fixtures, in case a prior aborted run left
            // them stranded on non-PFX URNs.
            await session.run(
                `MATCH (ep:APIEndpoint) WHERE ep.apiKind = 'graphql' AND ep.operationName IN $names DETACH DELETE ep`,
                { names: ['getOrder', 'createOrder'] },
            );
        } finally {
            await session.close();
        }
    }

    async function createService(serviceUrn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = 'TEST', s.valid_to_commit = null`,
                { id: serviceUrn, name },
            );
        } finally {
            await session.close();
        }
    }

    async function createFunction(functionUrn: string, serviceUrn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (f:Function {id: $fid})
                 SET f.name = $name, f.valid_from_commit = 'TEST', f.valid_to_commit = null
                 WITH f
                 MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:CONTAINS]->(f)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: functionUrn, sid: serviceUrn, name },
            );
        } finally {
            await session.close();
        }
    }

    beforeAll(async () => {
        await initSchema({ silent: true });
        await wipeTestNodes();
    });

    afterAll(async () => {
        await wipeTestNodes();
        await closeNeo4j();
    });

    beforeEach(async () => {
        await wipeTestNodes();
    });

    it('mergeAPIInterface defaults source to "openapi"', async () => {
        const apiUrn = `${PFX}api:default`;
        await mergeAPIInterface(apiUrn, 'X', '1.0', 'COMMIT_A');

        const session = getNeo4jSession();
        try {
            const r = await session.run('MATCH (api:APIInterface {id: $id}) RETURN api.apiSource AS s, api.version AS v', { id: apiUrn });
            expect(r.records[0].get('s')).toBe('openapi');
            expect(r.records[0].get('v')).toBe('1.0');
        } finally {
            await session.close();
        }
    });

    it('mergeAPIInterface accepts explicit "sdl" source without corrupting version', async () => {
        // Regression for graphql-schema-extractor.ts:258 (was passing 'sdl' as version).
        const apiUrn = `${PFX}api:sdl`;
        await mergeAPIInterface(apiUrn, 'GraphQL SDL', '1.0.0', 'COMMIT_A', 'sdl');

        const session = getNeo4jSession();
        try {
            const r = await session.run('MATCH (api:APIInterface {id: $id}) RETURN api.apiSource AS s, api.version AS v', { id: apiUrn });
            expect(r.records[0].get('s')).toBe('sdl');
            expect(r.records[0].get('v')).toBe('1.0.0');
        } finally {
            await session.close();
        }
    });

    it('mergeCodeExposedEndpoint grounding: heuristic/medium for legacy-php, ast/exact otherwise', async () => {
        const sUrn = `${PFX}service:g1`;
        const codeApiUrn = `${PFX}api:g1:code`;
        const fUrn = `${PFX}function:g1:handler`;

        await createService(sUrn, 'g1');
        await createFunction(fUrn, sUrn, 'handler');
        const setup = getNeo4jSession();
        try {
            await setup.run(
                `MERGE (api:APIInterface {id: $aid})
                 ON CREATE SET api.title = 'code', api.apiSource = 'code', api.version = 'code-inferred', api.valid_from_commit = 'TEST', api.valid_to_commit = null
                 WITH api
                 MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:EXPOSES_API]->(api)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { sid: sUrn, aid: codeApiUrn },
            );
        } finally { await setup.close(); }

        await mergeCodeExposedEndpoint(codeApiUrn, 'GET', '/pages/inventory/items/add.php', fUrn, 'COMMIT_A', 'legacy-php');
        await mergeCodeExposedEndpoint(codeApiUrn, 'GET', '/api/widgets', fUrn, 'COMMIT_A', 'slim');

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ep:APIEndpoint) WHERE ep.epSource = 'code' AND ep.path IN $paths
                 RETURN ep.path AS path, ep.source AS source, ep.quality AS quality,
                        ep.framework AS framework, ep.evidence_extractors AS extractors
                 ORDER BY path`,
                { paths: ['/pages/inventory/items/add.php', '/api/widgets'] },
            );
            const rows = Object.fromEntries(r.records.map(rec => [rec.get('path'), rec]));

            const slim = rows['/api/widgets'];
            expect(slim.get('source')).toBe('ast');
            expect(slim.get('quality')).toBe('exact');
            expect(slim.get('framework')).toBe('slim');

            const legacy = rows['/pages/inventory/items/add.php'];
            expect(legacy.get('source')).toBe('heuristic');
            expect(legacy.get('quality')).toBe('medium');
            expect(legacy.get('framework')).toBe('legacy-php');
            expect(legacy.get('extractors')).toEqual(['code-route-extractor@v1']);
        } finally { await session.close(); }
    });

    it('rewireImplementsEdgesToOpenApi fuses code-inferred → OpenAPI within the same service', async () => {
        const sUrn = `${PFX}service:s1`;
        const openApiUrn = `${PFX}api:s1:openapi`;
        const openEpUrn = `${PFX}endpoint:s1:openapi:POST:/api/foo`;
        const fUrn = `${PFX}function:s1:handler`;

        await createService(sUrn, 's1');
        await createFunction(fUrn, sUrn, 'handler');

        await mergeAPIInterface(openApiUrn, 'OAS S1', '1.0', 'COMMIT_A', 'openapi');
        // Wire EXPOSES_API manually (linkServiceExposesAPI uses qualifiedRepoName-based URN scheme).
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (s:Service {id: $sid}), (api:APIInterface {id: $aid})
                 MERGE (s)-[r:EXPOSES_API]->(api)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { sid: sUrn, aid: openApiUrn },
            );
        } finally { await session.close(); }

        await mergeAPIEndpoint(openApiUrn, openEpUrn, '/api/foo', 'POST', 'getFoo', 'open foo', null, 'COMMIT_A', 'openapi');

        // Code-inferred side: use the real code-inferred mutator, but it derives URNs from qualifiedRepoName.
        // Build the code-inferred APIInterface manually so we can pin its URN under PFX.
        const codeApiUrn = `${PFX}api:s1:code`;
        const session2 = getNeo4jSession();
        try {
            await session2.run(
                `MERGE (api:APIInterface {id: $aid})
                 ON CREATE SET api.title = 'code', api.apiSource = 'code', api.version = 'code-inferred', api.valid_from_commit = 'TEST', api.valid_to_commit = null
                 WITH api
                 MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:EXPOSES_API]->(api)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { sid: sUrn, aid: codeApiUrn },
            );
        } finally { await session2.close(); }

        await mergeCodeExposedEndpoint(codeApiUrn, 'POST', '/api/foo', fUrn, 'COMMIT_A');

        // Sanity pre-check: f IMPLEMENTS_ENDPOINT codeEp
        const session3 = getNeo4jSession();
        let preEdges: number;
        try {
            const r = await session3.run(
                `MATCH (f:Function {id: $fid})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint)
                 WHERE ep.epSource = 'code'
                 RETURN count(ep) AS n`,
                { fid: fUrn },
            );
            preEdges = Number(r.records[0].get('n'));
        } finally { await session3.close(); }
        expect(preEdges).toBe(1);

        const rewired = await rewireImplementsEdgesToOpenApi(sUrn, 'COMMIT_REWIRE');
        expect(rewired).toBeGreaterThanOrEqual(1);

        const session4 = getNeo4jSession();
        try {
            // f now implements the OpenAPI endpoint
            const r1 = await session4.run(
                `MATCH (f:Function {id: $fid})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint {id: $oid})
                 RETURN count(ep) AS n`,
                { fid: fUrn, oid: openEpUrn },
            );
            expect(Number(r1.records[0].get('n'))).toBe(1);

            // code-inferred endpoint is tombstoned. Filter by method too — code-inferred
            // URNs (cr:endpoint:code:METHOD:PATH) are NOT PFX-scoped, so other tests'
            // GET /api/foo can pollute the result set if we only filter by path.
            const r2 = await session4.run(
                `MATCH (ep:APIEndpoint) WHERE ep.epSource = 'code' AND ep.path = '/api/foo' AND ep.method = 'POST'
                 RETURN ep.valid_to_commit AS t`,
            );
            expect(r2.records[0].get('t')).toBe('COMMIT_REWIRE');
        } finally { await session4.close(); }
    });

    it('multi-tenant safety: rewire on s1 must not fuse into s2 with same colliding path', async () => {
        const s1 = `${PFX}service:s1`;
        const s2 = `${PFX}service:s2`;
        const open1 = `${PFX}api:s1:openapi`;
        const open2 = `${PFX}api:s2:openapi`;
        const code1 = `${PFX}api:s1:code`;
        const code2 = `${PFX}api:s2:code`;
        const ep1 = `${PFX}endpoint:s1:openapi:GET:/health`;
        const ep2 = `${PFX}endpoint:s2:openapi:GET:/health`;
        const f1 = `${PFX}function:s1:health`;
        const f2 = `${PFX}function:s2:health`;

        await createService(s1, 's1');
        await createService(s2, 's2');
        await createFunction(f1, s1, 'health');
        await createFunction(f2, s2, 'health');

        await mergeAPIInterface(open1, 'OAS s1', '1.0', 'C', 'openapi');
        await mergeAPIInterface(open2, 'OAS s2', '1.0', 'C', 'openapi');

        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (s:Service), (api:APIInterface)
                 WHERE (s.id = $s1 AND api.id = $a1) OR (s.id = $s2 AND api.id = $a2)
                 MERGE (s)-[r:EXPOSES_API]->(api)
                 ON CREATE SET r.valid_from_commit = 'C', r.valid_to_commit = null`,
                { s1, s2, a1: open1, a2: open2 },
            );
            await session.run(
                `MERGE (a1:APIInterface {id: $c1}) ON CREATE SET a1.apiSource='code', a1.title='c', a1.version='code-inferred', a1.valid_from_commit='C', a1.valid_to_commit=null
                 MERGE (a2:APIInterface {id: $c2}) ON CREATE SET a2.apiSource='code', a2.title='c', a2.version='code-inferred', a2.valid_from_commit='C', a2.valid_to_commit=null
                 WITH a1, a2
                 MATCH (s1:Service {id: $s1}), (s2:Service {id: $s2})
                 MERGE (s1)-[:EXPOSES_API {valid_from_commit:'C', valid_to_commit:null}]->(a1)
                 MERGE (s2)-[:EXPOSES_API {valid_from_commit:'C', valid_to_commit:null}]->(a2)`,
                { s1, s2, c1: code1, c2: code2 },
            );
        } finally { await session.close(); }

        await mergeAPIEndpoint(open1, ep1, '/health', 'GET', null, '', null, 'C', 'openapi');
        await mergeAPIEndpoint(open2, ep2, '/health', 'GET', null, '', null, 'C', 'openapi');
        await mergeCodeExposedEndpoint(code1, 'GET', '/health', f1, 'C');
        await mergeCodeExposedEndpoint(code2, 'GET', '/health', f2, 'C');

        // Run rewire ONLY on s1
        const rewired = await rewireImplementsEdgesToOpenApi(s1, 'C2');
        expect(rewired).toBeGreaterThanOrEqual(1);

        const session2 = getNeo4jSession();
        try {
            // f1 implements s1's openapi endpoint
            const r1 = await session2.run(
                `MATCH (f:Function {id: $f})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint {id: $e}) RETURN count(*) AS n`,
                { f: f1, e: ep1 },
            );
            expect(Number(r1.records[0].get('n'))).toBe(1);

            // f1 must NOT implement s2's endpoint
            const r2 = await session2.run(
                `MATCH (f:Function {id: $f})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint {id: $e}) RETURN count(*) AS n`,
                { f: f1, e: ep2 },
            );
            expect(Number(r2.records[0].get('n'))).toBe(0);

            // s2's code endpoint must NOT be tombstoned (rewire didn't run on s2)
            const r3 = await session2.run(
                `MATCH (s:Service {id: $sid})-[:EXPOSES_API]->(api:APIInterface {apiSource: 'code'})
                       -[:HAS_ENDPOINT]->(ep:APIEndpoint)
                 RETURN ep.valid_to_commit AS t`,
                { sid: s2 },
            );
            expect(r3.records[0].get('t')).toBeNull();
        } finally { await session2.close(); }
    });

    it('Bug B regression: paths with trailing slash on OpenAPI side fuse correctly when extractor canonicalizes', async () => {
        // This test simulates the post-Fix-2 state: openapi-extractor now applies
        // normalizeApiPathLossless, so trailing slashes are stripped at write time.
        // The test verifies the rewire's raw path comparison works once both sides agree.
        const sUrn = `${PFX}service:s3`;
        const openApiUrn = `${PFX}api:s3:openapi`;
        const codeApiUrn = `${PFX}api:s3:code`;
        const openEp = `${PFX}endpoint:s3:openapi:POST:/api/bar`;
        const fUrn = `${PFX}function:s3:handler`;

        await createService(sUrn, 's3');
        await createFunction(fUrn, sUrn, 'handler');
        await mergeAPIInterface(openApiUrn, 'OAS', '1.0', 'C', 'openapi');

        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (s:Service {id: $s}), (api:APIInterface {id: $a})
                 MERGE (s)-[r2:EXPOSES_API]->(api)
                 ON CREATE SET r2.valid_from_commit = 'C', r2.valid_to_commit = null
                 MERGE (codeApi:APIInterface {id: $c})
                 ON CREATE SET codeApi.apiSource='code', codeApi.title='c', codeApi.version='code-inferred', codeApi.valid_from_commit='C', codeApi.valid_to_commit=null
                 MERGE (s)-[:EXPOSES_API {valid_from_commit:'C', valid_to_commit:null}]->(codeApi)`,
                { s: sUrn, a: openApiUrn, c: codeApiUrn },
            );
        } finally { await session.close(); }

        // Both sides write the same canonical path '/api/bar' (trailing slash stripped by Fix 2).
        await mergeAPIEndpoint(openApiUrn, openEp, '/api/bar', 'POST', null, '', null, 'C', 'openapi');
        await mergeCodeExposedEndpoint(codeApiUrn, 'POST', '/api/bar', fUrn, 'C');

        const rewired = await rewireImplementsEdgesToOpenApi(sUrn, 'C2');
        expect(rewired).toBe(1);
    });

    // ─── APIInterface.direction field (Fix 4) ────────────────────────────────
    // Direction is required on the node so dashboards can segment INBOUND
    // (services that EXPOSE) vs OUTBOUND (services that CONSUME) without
    // re-deriving via relationship traversal. mergeCodeInferredAPIInterface
    // always writes 'INBOUND'. mergeAPIInterface accepts a parametric direction
    // (default 'INBOUND' since OpenAPI specs describe what the service exposes).

    describe('APIInterface.direction', () => {
        it('mergeCodeInferredAPIInterface writes direction=INBOUND on the node', async () => {
            const sUrn = `${PFX}svc-direction-1`;
            await createService(sUrn, 'svc-direction-1');
            const apiUrn = await mergeCodeInferredAPIInterface('repo-x', 'svc-direction-1', 'C-DIR-1');
            const session = getNeo4jSession();
            try {
                const r = await session.run(
                    'MATCH (api:APIInterface {id: $id}) RETURN api.direction AS direction',
                    { id: apiUrn },
                );
                expect(r.records.length).toBe(1);
                expect(r.records[0].get('direction')).toBe('INBOUND');
            } finally { await session.close(); }
        });

        it('mergeAPIInterface writes direction=INBOUND by default (OpenAPI spec)', async () => {
            const apiUrn = `${PFX}api-openapi-direction`;
            await mergeAPIInterface(apiUrn, 'TestSpec', '1.0.0', 'C-DIR-2', 'openapi');
            const session = getNeo4jSession();
            try {
                const r = await session.run(
                    'MATCH (api:APIInterface {id: $id}) RETURN api.direction AS direction',
                    { id: apiUrn },
                );
                expect(r.records.length).toBe(1);
                expect(r.records[0].get('direction')).toBe('INBOUND');
            } finally { await session.close(); }
        });

        it('direction survives rewireImplementsEdgesToOpenApi', async () => {
            const sUrn = `${PFX}svc-direction-rewire`;
            const fUrn = `${PFX}fn-direction-rewire`;
            const openApiUrn = `${PFX}api-openapi-direction-rewire`;
            await createService(sUrn, 'svc-direction-rewire');
            await createFunction(fUrn, sUrn, 'rewireFn');
            const codeApiUrn = await mergeCodeInferredAPIInterface('repo-x', 'svc-direction-rewire', 'C');
            await mergeAPIInterface(openApiUrn, 'OpenAPI', '1.0.0', 'C', 'openapi');
            await linkServiceExposesAPI('repo-x', 'svc-direction-rewire', openApiUrn, 'C');

            await mergeAPIEndpoint(openApiUrn, `${PFX}ep-openapi`, '/api/foo', 'GET', null, '', null, 'C', 'openapi');
            await mergeCodeExposedEndpoint(codeApiUrn, 'GET', '/api/foo', fUrn, 'C');
            await rewireImplementsEdgesToOpenApi(sUrn, 'C2');

            const session = getNeo4jSession();
            try {
                const r = await session.run(
                    'MATCH (api:APIInterface {id: $id}) RETURN api.direction AS direction',
                    { id: openApiUrn },
                );
                expect(r.records.length).toBe(1);
                expect(r.records[0].get('direction')).toBe('INBOUND');
            } finally { await session.close(); }
        });
    });

    // ─── rewireGraphQLCodeToSDL: post-grounding-rename regression ───────────
    // After the source → epSource rename (grounding rollout), the WHERE
    // clauses in rewireGraphQLCodeToSDL were left filtering on `.source =
    // 'code'/'sdl'`. The grounding builder now writes `.source = 'ast'` for
    // these endpoints, so the filter matches zero rows and the rewire is dead.
    // This test pins the post-rename behaviour: the rewire MUST find the SDL
    // twin via apiKind+epSource and move the IMPLEMENTS_ENDPOINT edge.
    describe('rewireGraphQLCodeToSDL', () => {
        it('rewires Function→code-ep to Function→sdl-ep when twin exists', async () => {
            const sUrn = `${PFX}svc-gql-rewire`;
            const fUrn = `${PFX}fn-gql-rewire`;
            const sdlApiUrn = `${PFX}api-gql-sdl`;
            const codeApiUrn = `${PFX}api-gql-code`;

            await createService(sUrn, 'svc-gql-rewire');
            await createFunction(fUrn, sUrn, 'getOrderResolver');

            await mergeAPIInterface(sdlApiUrn, 'GraphQL SDL', '1.0.0', 'C', 'sdl');
            await mergeAPIInterface(codeApiUrn, 'GraphQL Code', 'code-inferred', 'C', 'code');

            const session = getNeo4jSession();
            try {
                await session.run(
                    `MATCH (s:Service {id: $sid})
                     MATCH (sdl:APIInterface {id: $sdl}), (code:APIInterface {id: $code})
                     MERGE (s)-[r1:EXPOSES_API]->(sdl)
                     ON CREATE SET r1.valid_from_commit = 'C', r1.valid_to_commit = null
                     MERGE (s)-[r2:EXPOSES_API]->(code)
                     ON CREATE SET r2.valid_from_commit = 'C', r2.valid_to_commit = null`,
                    { sid: sUrn, sdl: sdlApiUrn, code: codeApiUrn },
                );
            } finally { await session.close(); }

            const sdlEpUrn = await mergeSDLGraphQLEndpoint(sdlApiUrn, 'QUERY', 'getOrder', 'C');
            const codeEpUrn = await mergeCodeInferredGraphQLEndpoint(codeApiUrn, 'QUERY', 'getOrder', fUrn, 'C');

            // Sanity: pre-rewire, f IMPLEMENTS_ENDPOINT codeEp and NOT sdlEp.
            const pre = getNeo4jSession();
            try {
                const r1 = await pre.run(
                    `MATCH (f:Function {id: $f})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint {id: $e}) RETURN count(*) AS n`,
                    { f: fUrn, e: codeEpUrn },
                );
                expect(Number(r1.records[0].get('n'))).toBe(1);
                const r2 = await pre.run(
                    `MATCH (f:Function {id: $f})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint {id: $e}) RETURN count(*) AS n`,
                    { f: fUrn, e: sdlEpUrn },
                );
                expect(Number(r2.records[0].get('n'))).toBe(0);
            } finally { await pre.close(); }

            const tombstoned = await rewireGraphQLCodeToSDL(sUrn, 'C2');
            expect(Number(tombstoned)).toBe(1);

            const post = getNeo4jSession();
            try {
                // f now IMPLEMENTS_ENDPOINT the SDL twin.
                const r1 = await post.run(
                    `MATCH (f:Function {id: $f})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint {id: $e}) RETURN count(*) AS n`,
                    { f: fUrn, e: sdlEpUrn },
                );
                expect(Number(r1.records[0].get('n'))).toBe(1);

                // The old f → codeEp edge is gone.
                const r2 = await post.run(
                    `MATCH (f:Function {id: $f})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint {id: $e}) RETURN count(*) AS n`,
                    { f: fUrn, e: codeEpUrn },
                );
                expect(Number(r2.records[0].get('n'))).toBe(0);

                // The code-ep is tombstoned with the rewire commit.
                const r3 = await post.run(
                    `MATCH (ep:APIEndpoint {id: $e}) RETURN ep.valid_to_commit AS t`,
                    { e: codeEpUrn },
                );
                expect(r3.records[0].get('t')).toBe('C2');
            } finally { await post.close(); }
        });

        it('does not tombstone code-ep when no SDL twin exists', async () => {
            const sUrn = `${PFX}svc-gql-no-twin`;
            const fUrn = `${PFX}fn-gql-no-twin`;
            const codeApiUrn = `${PFX}api-gql-code-no-twin`;

            await createService(sUrn, 'svc-gql-no-twin');
            await createFunction(fUrn, sUrn, 'createOrderResolver');
            await mergeAPIInterface(codeApiUrn, 'GraphQL Code', 'code-inferred', 'C', 'code');

            const session = getNeo4jSession();
            try {
                await session.run(
                    `MATCH (s:Service {id: $sid}), (api:APIInterface {id: $aid})
                     MERGE (s)-[r:EXPOSES_API]->(api)
                     ON CREATE SET r.valid_from_commit = 'C', r.valid_to_commit = null`,
                    { sid: sUrn, aid: codeApiUrn },
                );
            } finally { await session.close(); }

            const codeEpUrn = await mergeCodeInferredGraphQLEndpoint(codeApiUrn, 'MUTATION', 'createOrder', fUrn, 'C');

            const tombstoned = await rewireGraphQLCodeToSDL(sUrn, 'C2');
            expect(Number(tombstoned)).toBe(0);

            const post = getNeo4jSession();
            try {
                // code-ep still live, edge intact.
                const r = await post.run(
                    `MATCH (f:Function {id: $f})-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint {id: $e})
                     RETURN ep.valid_to_commit AS t`,
                    { f: fUrn, e: codeEpUrn },
                );
                expect(r.records[0].get('t')).toBeNull();
            } finally { await post.close(); }
        });
    });
});
