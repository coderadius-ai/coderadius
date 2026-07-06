import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeAPIDeployment } from '../../src/graph/mutations/api-deployment.js';
import { ingestGlobalResolution } from '../../src/ingestion/processors/global-resolver.js';

// ─── Global resolver: L0a URL-exact / L0b URL-host welder ────────────────────
//
// Verifies that:
//   1. An emergent endpoint whose caller observed a base URL that matches a
//      provider :APIDeployment.canonicalUrl is welded to the canonical
//      endpoint of the matching :APIInterface, with weldedBy='url-exact' and
//      weldConfidence='exact'. No DEPENDS_ON edge is required between caller
//      and provider services.
//   2. Multi-surface providers (public + internal) — the env-tag tiebreaker
//      picks the deployment whose environment matches the caller's
//      observedEnvironment.
//   3. Cache hash invalidation: adding a new :APIDeployment alone forces the
//      resolver to re-run even when the endpoint set is unchanged.

describe('global-resolver: L0a URL-exact welder', () => {
    const PFX = 'cr://test/url-weld/';
    const COMMIT = 'URL_WELD_TEST';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await session.run(
                `MATCH (d:APIDeployment) WHERE d.canonicalUrl IN $urls DETACH DELETE d`,
                { urls: [
                    'https://api.acme.example.com/v2',
                    'https://orders-api.svc.cluster.local',
                    'https://admin.acme.example.com',
                ] },
            );
            await session.run(`MATCH (m:Meta {id: 'global-resolution-state'}) DETACH DELETE m`);
        } finally { await session.close(); }
    }

    async function createService(urn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (s:Service {id: $id}) SET s.name = $name,
                   s.valid_from_commit = $c, s.valid_to_commit = null`,
                { id: urn, name, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    async function createFunction(urn: string, name: string, serviceUrn: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (s:Service {id: $sid})
                 CREATE (f:Function {id: $id}) SET f.name = $name,
                   f.valid_from_commit = $c, f.valid_to_commit = null
                 MERGE (s)-[r:CONTAINS]->(f)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { id: urn, name, sid: serviceUrn, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    async function createAPIInterface(urn: string, title: string, providerService: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (s:Service {id: $sid})
                 CREATE (api:APIInterface {id: $id})
                 SET api.title = $title, api.apiKind = 'http', api.apiSource = 'openapi',
                     api.valid_from_commit = $c, api.valid_to_commit = null
                 MERGE (s)-[r:EXPOSES_API]->(api)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { id: urn, title, sid: providerService, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    async function createCanonicalEndpoint(urn: string, apiUrn: string, method: string, path: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (api:APIInterface {id: $apiId})
                 CREATE (ep:APIEndpoint {id: $id})
                 SET ep.method = $method, ep.path = $path, ep.apiKind = 'http',
                     ep.epSource = 'openapi',
                     ep.valid_from_commit = $c, ep.valid_to_commit = null
                 MERGE (api)-[r:HAS_ENDPOINT]->(ep)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { id: urn, apiId: apiUrn, method, path, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    async function createEmergentEndpointWithCall(args: {
        emergentId: string;
        callerFn: string;
        method: string;
        path: string;
        observedBaseUrl: string;
        observedEnvironment?: string;
    }) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (f:Function {id: $fid})
                 CREATE (ep:APIEndpoint {id: $eid})
                 SET ep.id = $eid, ep.method = $method, ep.path = $path,
                     ep.apiKind = 'http', ep.epSource = 'emergent',
                     ep.valid_from_commit = $c, ep.valid_to_commit = null
                 CREATE (f)-[r:CALLS]->(ep)
                 SET r.valid_from_commit = $c, r.valid_to_commit = null,
                     r.observedBaseUrl = $observedBaseUrl,
                     r.observedEnvironment = $observedEnvironment,
                     r.declaredBy = 'env-var'`,
                {
                    eid: args.emergentId,
                    fid: args.callerFn,
                    method: args.method,
                    path: args.path,
                    observedBaseUrl: args.observedBaseUrl,
                    observedEnvironment: args.observedEnvironment ?? null,
                    c: COMMIT,
                },
            );
            // Make the emergent endpoint look like the global-resolver query expects
            // (URN prefix `cr:endpoint:emergent:`).
        } finally { await session.close(); }
    }

    beforeAll(async () => {
        await initSchema({ silent: true });
        await wipeFixture();
    });
    afterAll(async () => {
        await wipeFixture();
        await closeNeo4j();
    });
    beforeEach(async () => { await wipeFixture(); });

    it('welds emergent → canonical via L0a URL-exact, no DEPENDS_ON required', async () => {
        // Setup: provider service exposes :APIInterface w/ canonical POST /orders
        // and an :APIDeployment with canonicalUrl https://api.acme.example.com/v2
        const providerSvc = `${PFX}service:orders-api`;
        const callerSvc = `${PFX}service:orders-client`;
        const providerApi = `${PFX}api:orders-api:openapi`;
        const canonicalEp = `${PFX}endpoint:canonical:POST:/orders`;
        // emergent URN has the prefix the resolver looks for
        const emergentEp = `cr:endpoint:emergent:${PFX}orders-client:POST:/orders`;
        const callerFn = `${PFX}function:orders-client:createOrder`;

        await createService(providerSvc, 'orders-api');
        await createService(callerSvc, 'orders-client');
        await createAPIInterface(providerApi, 'Orders API', providerSvc);
        await createCanonicalEndpoint(canonicalEp, providerApi, 'POST', '/orders');
        await mergeAPIDeployment({
            apiUrn: providerApi,
            baseUrl: 'https://api.acme.example.com/v2',
            environment: 'production',
            visibility: 'public',
            declaredBy: 'oas-servers',
            confidence: 'exact',
        }, COMMIT);

        await createFunction(callerFn, 'createOrder', callerSvc);
        await createEmergentEndpointWithCall({
            emergentId: emergentEp,
            callerFn,
            method: 'POST',
            path: '/orders',
            observedBaseUrl: 'https://api.acme.example.com/v2',
            observedEnvironment: 'production',
        });

        const result = await ingestGlobalResolution();
        expect(result.resolvedUrlExact).toBe(1);
        expect(result.resolvedScoped).toBe(0);

        // Canonical CALLS edge has the welded provenance + carried-over caller metadata
        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (f:Function {id: $fid})-[rel:CALLS]->(ep:APIEndpoint {id: $eid})
                 RETURN rel.weldedBy AS wb, rel.weldConfidence AS wc,
                        rel.observedBaseUrl AS u, rel.observedEnvironment AS e`,
                { fid: callerFn, eid: canonicalEp },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('wb')).toBe('url-exact');
            expect(r.records[0].get('wc')).toBe('exact');
            expect(r.records[0].get('u')).toBe('https://api.acme.example.com/v2');
            expect(r.records[0].get('e')).toBe('production');

            // Emergent endpoint detached
            const r2 = await session.run(
                `MATCH (ep:APIEndpoint {id: $id}) RETURN count(ep) AS n`,
                { id: emergentEp },
            );
            expect(Number(r2.records[0].get('n'))).toBe(0);
        } finally { await session.close(); }
    });

    it('multi-surface provider: env-tag tiebreaker picks the matching deployment', async () => {
        // Provider exposes two surfaces: public (api.acme) production and
        // internal mesh (orders-api.svc.cluster.local) production.
        // Caller's observed URL points at the internal one — only that
        // deployment matches via URL-exact.
        const providerSvc = `${PFX}service:provider`;
        const callerSvc = `${PFX}service:caller`;
        const providerApi = `${PFX}api:provider:openapi`;
        const canonicalEp = `${PFX}endpoint:canonical:GET:/orders/123`;
        const emergentEp = `cr:endpoint:emergent:${PFX}caller:GET:/orders/123`;
        const callerFn = `${PFX}function:caller:fetchOrder`;

        await createService(providerSvc, 'provider');
        await createService(callerSvc, 'caller');
        await createAPIInterface(providerApi, 'Orders API', providerSvc);
        await createCanonicalEndpoint(canonicalEp, providerApi, 'GET', '/orders/123');
        // public deployment
        await mergeAPIDeployment({
            apiUrn: providerApi,
            baseUrl: 'https://api.acme.example.com',
            environment: 'production',
            visibility: 'public',
            declaredBy: 'oas-servers',
            confidence: 'exact',
        }, COMMIT);
        // internal deployment
        await mergeAPIDeployment({
            apiUrn: providerApi,
            baseUrl: 'https://orders-api.svc.cluster.local',
            environment: 'production',
            visibility: 'internal',
            declaredBy: 'k8s-ingress',
            confidence: 'high',
        }, COMMIT);

        await createFunction(callerFn, 'fetchOrder', callerSvc);
        await createEmergentEndpointWithCall({
            emergentId: emergentEp,
            callerFn,
            method: 'GET',
            path: '/orders/123',
            observedBaseUrl: 'https://orders-api.svc.cluster.local',
            observedEnvironment: 'production',
        });

        const result = await ingestGlobalResolution();
        expect(result.resolvedUrlExact).toBe(1);

        // Welded → canonical endpoint
        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (f:Function {id: $fid})-[:CALLS]->(ep:APIEndpoint {id: $eid})
                 RETURN count(*) AS n`,
                { fid: callerFn, eid: canonicalEp },
            );
            expect(Number(r.records[0].get('n'))).toBe(1);
        } finally { await session.close(); }
    });

    it('cache invalidates when a new :APIDeployment appears (endpoint set unchanged)', async () => {
        // Run #1: caller has emergent edge, NO :APIDeployment yet → no URL weld.
        const providerSvc = `${PFX}service:provider`;
        const callerSvc = `${PFX}service:caller`;
        const providerApi = `${PFX}api:provider:openapi`;
        const canonicalEp = `${PFX}endpoint:canonical:POST:/orders`;
        const emergentEp = `cr:endpoint:emergent:${PFX}caller:POST:/orders`;
        const callerFn = `${PFX}function:caller:create`;

        await createService(providerSvc, 'provider');
        await createService(callerSvc, 'caller');
        await createAPIInterface(providerApi, 'Orders API', providerSvc);
        await createCanonicalEndpoint(canonicalEp, providerApi, 'POST', '/orders');
        await createFunction(callerFn, 'create', callerSvc);
        await createEmergentEndpointWithCall({
            emergentId: emergentEp,
            callerFn,
            method: 'POST',
            path: '/orders',
            observedBaseUrl: 'https://api.acme.example.com',
            observedEnvironment: 'production',
        });

        const r1 = await ingestGlobalResolution();
        // No deployment → no URL weld (may fall through to L1 if path matches).
        expect(r1.resolvedUrlExact).toBe(0);

        // Run #2: add a deployment matching the observedBaseUrl. Endpoint set unchanged.
        // The cache MUST invalidate on the new deployment so L0a re-runs.
        await mergeAPIDeployment({
            apiUrn: providerApi,
            baseUrl: 'https://api.acme.example.com',
            environment: 'production',
            visibility: 'public',
            declaredBy: 'oas-servers',
            confidence: 'exact',
        }, COMMIT);

        // Recreate emergent endpoint (R1 welded it away to the canonical via L1 exact).
        // For the cache-invalidation test we want a fresh emergent so L0a has work to do.
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (ep:APIEndpoint {id: $id}) DETACH DELETE ep`,
                { id: emergentEp },
            );
        } finally { await session.close(); }
        await createEmergentEndpointWithCall({
            emergentId: emergentEp,
            callerFn,
            method: 'POST',
            path: '/orders',
            observedBaseUrl: 'https://api.acme.example.com',
            observedEnvironment: 'production',
        });

        const r2 = await ingestGlobalResolution();
        // The deployment-count change forces re-run; the recreated emergent has
        // observedBaseUrl matching the deployment → L0a welds it.
        expect(r2.resolvedUrlExact).toBe(1);
    });
});
