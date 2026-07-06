import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeRepository } from '../../src/graph/mutations/code-graph.js';
import { mergeService, mergeTeam, linkTeamOwnsService } from '../../src/graph/mutations/c4.js';
import { linkServiceStoredIn } from '../../src/graph/mutations/code-graph.js';
import {
    mergeAPIInterface,
    mergeAPIEndpoint,
    linkServiceExposesAPI,
    linkServiceConsumesAPI,
} from '../../src/graph/mutations/api-contracts.js';
import { mergeAPIDeployment } from '../../src/graph/mutations/api-deployment.js';
import { linkSourceFileDefinesAPI } from '../../src/graph/mutations/merkle.js';
import { getInventoryReport } from '../../src/graph/queries/inventory.js';
import { getQualifiedRepoName, buildUrn } from '../../src/graph/urn.js';

// The API catalog row: one entry per exposed APIInterface with everything the
// System Registry needs — exposing service + owner team, deployment surfaces
// (url / environment / visibility), the OAS spec file, endpoints, consumers.

const ORG = 'apicatorg';
const COMMIT = 'API_CATALOG_TEST';
const REPO_QRN = getQualifiedRepoName({ name: 'shop-api', org: ORG });
const API_URN = `cr:api:openapi:${ORG}-orders`;

async function wipe() {
    const s = getNeo4jSession();
    try {
        await s.run('MATCH (o:Organization) WHERE o.fullPath STARTS WITH $p DETACH DELETE o', { p: ORG });
        await s.run('MATCH (r:Repository) WHERE r.id STARTS WITH $p DETACH DELETE r', { p: `cr:repository:${ORG}` });
        await s.run('MATCH (s:Service) WHERE s.id STARTS WITH $p DETACH DELETE s', { p: `cr:service:${ORG}` });
        await s.run('MATCH (t:Team {name: $n}) DETACH DELETE t', { n: 'apicat-payments-team' });
        await s.run('MATCH (api:APIInterface) WHERE api.id STARTS WITH $p DETACH DELETE api', { p: `cr:api:openapi:${ORG}` });
        await s.run('MATCH (ep:APIEndpoint) WHERE ep.id STARTS WITH $p DETACH DELETE ep', { p: `cr:endpoint:${ORG}` });
        await s.run('MATCH (d:APIDeployment) WHERE d.host = $h DETACH DELETE d', { h: 'api.apicat-test.example' });
        await s.run('MATCH (sf:SourceFile) WHERE sf.id STARTS WITH $p DETACH DELETE sf', { p: `cr:sourcefile:${ORG}` });
    } finally { await s.close(); }
}

async function seed() {
    await mergeRepository('shop-api', `git@github.com:${ORG}/shop-api.git`, COMMIT, ORG);
    await mergeService(REPO_QRN, 'orders-svc', 'php', undefined, undefined, undefined, undefined, undefined, COMMIT);
    await linkServiceStoredIn(REPO_QRN, 'orders-svc', REPO_QRN, '.', COMMIT);
    await mergeTeam('apicat-payments-team', COMMIT);
    await linkTeamOwnsService('apicat-payments-team', REPO_QRN, 'orders-svc', COMMIT);

    await mergeAPIInterface(API_URN, 'Orders API', '1.2.0', COMMIT, 'openapi', 'INBOUND');
    await linkServiceExposesAPI(REPO_QRN, 'orders-svc', API_URN, COMMIT);
    await mergeAPIEndpoint(API_URN, `cr:endpoint:${ORG}:GET:/orders`, '/orders', 'GET', null, 'List orders', null, COMMIT, 'openapi');
    await mergeAPIEndpoint(API_URN, `cr:endpoint:${ORG}:POST:/orders`, '/orders', 'POST', null, 'Create order', null, COMMIT, 'openapi');
    await mergeAPIDeployment({
        apiUrn: API_URN,
        baseUrl: 'https://api.apicat-test.example/v1',
        environment: 'production',
        visibility: 'public',
        declaredBy: 'oas-servers',
        confidence: 'exact',
    }, COMMIT);
    await linkSourceFileDefinesAPI('docs/openapi.yaml', REPO_QRN, API_URN, COMMIT);

    // A consumer service in a second repo.
    await mergeRepository('storefront', `git@github.com:${ORG}/storefront.git`, COMMIT, ORG);
    const consumerQrn = getQualifiedRepoName({ name: 'storefront', org: ORG });
    await mergeService(consumerQrn, 'web-svc', 'ts', undefined, undefined, undefined, undefined, undefined, COMMIT);
    await linkServiceConsumesAPI(buildUrn('service', consumerQrn, 'web-svc'), API_URN, 'ORDERS_API_URL', COMMIT);
}

describe('API catalog (inventory)', () => {
    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); await seed(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });

    it('returns one row per exposed API with service, team, repo, spec, deployments, endpoints, consumers', async () => {
        const report = await getInventoryReport();
        const api = report.apiCatalog.find(a => a.urn === API_URN);

        expect(api).toBeDefined();
        expect(api!.title).toBe('Orders API');
        expect(api!.version).toBe('1.2.0');
        expect(api!.apiSource).toBe('openapi');
        expect(api!.exposers).toEqual([
            { service: 'orders-svc', serviceUrn: buildUrn('service', REPO_QRN, 'orders-svc') },
        ]);
        expect(api!.team).toBe('apicat-payments-team');
        // Bare repo name, same convention as the repositories list (org-filter joins on it).
        expect(api!.repository).toBe('shop-api');
        expect(api!.specPath).toBe('docs/openapi.yaml');

        expect(api!.deployments).toEqual([{
            url: 'https://api.apicat-test.example/v1',
            environment: 'production',
            visibility: 'public',
        }]);

        // Endpoints sorted by path then method for stable rendering.
        expect(api!.endpoints).toEqual([
            { method: 'GET', path: '/orders' },
            { method: 'POST', path: '/orders' },
        ]);

        expect(api!.consumerCount).toBe(1);
    });

    it('falls back to unknown/null for optional facets without exploding the row', async () => {
        const BARE_URN = `cr:api:openapi:${ORG}-bare`;
        await mergeAPIInterface(BARE_URN, 'Bare API', 'v1', COMMIT, 'code', 'INBOUND');
        await linkServiceExposesAPI(REPO_QRN, 'orders-svc', BARE_URN, COMMIT);

        const report = await getInventoryReport();
        const bare = report.apiCatalog.find(a => a.urn === BARE_URN);

        expect(bare).toBeDefined();
        expect(bare!.specPath).toBeNull();
        expect(bare!.deployments).toEqual([]);
        expect(bare!.endpoints).toEqual([]);
        expect(bare!.consumerCount).toBe(0);
    });

    it('groups per-endpoint synthetic APIs into one logical surface per service', async () => {
        // Code-inferred ingestion mints ONE APIInterface node per endpoint, all
        // titled "<service> (Code-Inferred)". The catalog row is the logical
        // surface, so same (service, title, version, source) collapses.
        const SYN_A = `cr:api:openapi:${ORG}-code-a`;
        const SYN_B = `cr:api:openapi:${ORG}-code-b`;
        for (const [urn, path] of [[SYN_A, '/internal/health'], [SYN_B, '/internal/metrics']] as const) {
            await mergeAPIInterface(urn, 'orders-svc (Code-Inferred)', 'code-inferred', COMMIT, 'code', 'INBOUND');
            await linkServiceExposesAPI(REPO_QRN, 'orders-svc', urn, COMMIT);
            await mergeAPIEndpoint(urn, `cr:endpoint:${ORG}:GET:${path}`, path, 'GET', null, '', null, COMMIT, 'code');
        }

        const report = await getInventoryReport();
        const grouped = report.apiCatalog.filter(a => a.title === 'orders-svc (Code-Inferred)');
        expect(grouped).toHaveLength(1);
        expect(grouped[0].endpoints).toEqual([
            { method: 'GET', path: '/internal/health' },
            { method: 'GET', path: '/internal/metrics' },
        ]);
    });

    it('merges the same API exposed by two services into one row listing both exposers', async () => {
        // Same spec exposed by two services in the same repo (e.g. an http API
        // and its event-consumer sibling): ONE surface, two exposers.
        const SHARED_URN = `cr:api:openapi:${ORG}-shared`;
        await mergeService(REPO_QRN, 'orders-consumer', 'php', undefined, undefined, undefined, undefined, undefined, COMMIT);
        await linkServiceStoredIn(REPO_QRN, 'orders-consumer', REPO_QRN, '.', COMMIT);
        await mergeAPIInterface(SHARED_URN, 'Shared API', '2.0.0', COMMIT, 'openapi', 'INBOUND');
        await linkServiceExposesAPI(REPO_QRN, 'orders-svc', SHARED_URN, COMMIT);
        await linkServiceExposesAPI(REPO_QRN, 'orders-consumer', SHARED_URN, COMMIT);
        await mergeAPIEndpoint(SHARED_URN, `cr:endpoint:${ORG}:GET:/shared`, '/shared', 'GET', null, '', null, COMMIT, 'openapi');

        const report = await getInventoryReport();
        const shared = report.apiCatalog.filter(a => a.title === 'Shared API');
        expect(shared).toHaveLength(1);
        expect(shared[0].exposers.map(e => e.service).sort()).toEqual(['orders-consumer', 'orders-svc']);
        // Endpoints are not duplicated by the second exposer.
        expect(shared[0].endpoints).toEqual([{ method: 'GET', path: '/shared' }]);
    });

    it('carries SDL endpoints without an HTTP method (GraphQL operations)', async () => {
        const SDL_URN = `cr:api:openapi:${ORG}-graphql`;
        await mergeAPIInterface(SDL_URN, 'Orders GraphQL', '1.0.0', COMMIT, 'sdl', 'INBOUND');
        await linkServiceExposesAPI(REPO_QRN, 'orders-svc', SDL_URN, COMMIT);
        // SDL extraction persists operations as endpoints with no HTTP method.
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (api:APIInterface {id: $apiUrn})
                 CREATE (ep:APIEndpoint {id: $epUrn, name: $path, path: $path, apiKind: 'graphql',
                                         valid_from_commit: $commit, valid_to_commit: null})
                 CREATE (api)-[:HAS_ENDPOINT {valid_from_commit: $commit, valid_to_commit: null}]->(ep)`,
                { apiUrn: SDL_URN, epUrn: `cr:endpoint:${ORG}:graphql:ordersByStatus`, path: 'query ordersByStatus', commit: COMMIT });
        } finally { await s.close(); }

        const report = await getInventoryReport();
        const sdl = report.apiCatalog.find(a => a.urn === SDL_URN);
        expect(sdl).toBeDefined();
        expect(sdl!.endpoints).toEqual([{ method: null, path: 'query ordersByStatus' }]);
    });

    it('does not list consumed-only APIs (the catalog is the exposed surface)', async () => {
        const report = await getInventoryReport();
        // The consumer edge alone must not mint a catalog row for a foreign API.
        const rows = report.apiCatalog.filter(a => a.urn.startsWith(`cr:api:openapi:${ORG}`));
        expect(rows.map(a => a.title).sort()).toEqual(['Bare API', 'Orders API', 'Orders GraphQL', 'Shared API', 'orders-svc (Code-Inferred)']);
    });
});
