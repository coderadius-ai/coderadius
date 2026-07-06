import { describe, expect, it } from 'vitest';
import type { InventoryApi, InventoryRepo } from '@coderadius/shared-types';
import { buildApiRows, deploymentHref, deploymentLabel } from '../../../packages/dashboard-ui/src/components/system-registry/apiCatalogModel';

// ─── Fixture vocabulary (anonymised — acme/orders) ────────────────────────────

function mkRepo(name: string, url: string | null, defaultBranch: string | null = null): InventoryRepo {
    return {
        name, url, org: 'acme', repoHash: null, services: [], fileCount: 0, functionCount: 0,
        teams: [], languages: [], ingestionLevel: 'contracts', branch: null, defaultBranch,
        coreBranches: [], hostingPlatform: null, livenessCommits: null, lastAnalyzedAt: null,
    };
}

function mkApi(overrides: Partial<InventoryApi> = {}): InventoryApi {
    return {
        urn: 'cr:api:openapi:acme-orders',
        title: 'Orders API',
        version: '1.2.0',
        apiSource: 'openapi',
        exposers: [{ service: 'orders-svc', serviceUrn: 'cr:service:acme/shop-api:orders-svc' }],
        team: 'payments-team',
        repository: 'shop-api',
        specPath: 'docs/openapi.yaml',
        deployments: [{ url: 'https://api.acme.example/v1', environment: 'production', visibility: 'public' }],
        endpoints: [{ method: 'GET', path: '/orders' }],
        consumerCount: 2,
        ...overrides,
    };
}

describe('buildApiRows', () => {
    it('builds a clickable spec URL from the exposing repo remote and default branch', () => {
        const rows = buildApiRows(
            [mkApi()],
            [mkRepo('shop-api', 'git@github.com:acme/shop-api.git', 'develop')],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].specUrl).toBe('https://github.com/acme/shop-api/blob/develop/docs/openapi.yaml');
    });

    it('leaves specUrl null when the spec or the repo remote is missing', () => {
        const rows = buildApiRows(
            [
                mkApi({ urn: 'a', specPath: null }),
                mkApi({ urn: 'b', repository: 'unknown-repo' }),
                mkApi({ urn: 'c', repository: 'no-remote' }),
            ],
            [mkRepo('shop-api', 'git@github.com:acme/shop-api.git'), mkRepo('no-remote', null)],
        );
        expect(rows.map(r => r.specUrl)).toEqual([null, null, null]);
    });

    it('links only valid, non-loopback URLs (templates and localhost are not clickable)', () => {
        const dep = (url: string) => ({ url, environment: 'unknown', visibility: 'unknown' });
        expect(deploymentHref(dep('https://api.acme.example/v1'))).toBe('https://api.acme.example/v1');
        expect(deploymentHref(dep('http://pagamenti.dev-acme.example'))).toBe('http://pagamenti.dev-acme.example');
        // Unresolved server templates: shown, never navigable.
        expect(deploymentHref(dep('{schema}{host}:{port}/ws'))).toBeNull();
        expect(deploymentHref(dep('http://localhost:{port}'))).toBeNull();
        // Loopback surfaces are dev artifacts, not destinations.
        expect(deploymentHref(dep('http://localhost:12325'))).toBeNull();
        expect(deploymentHref(dep('http://127.0.0.1:3004'))).toBeNull();
    });

    it('labels a deployment by environment, falling back to the URL host', () => {
        expect(deploymentLabel({ url: 'https://api.acme.example/v1', environment: 'production', visibility: 'public' })).toBe('production');
        expect(deploymentLabel({ url: 'https://api.acme.example/v1', environment: 'unknown', visibility: 'unknown' })).toBe('api.acme.example');
        // Unresolved server templates are shown verbatim, not hidden.
        expect(deploymentLabel({ url: '{schema}{host}:{port}/ws', environment: 'unknown', visibility: 'unknown' })).toBe('{schema}{host}:{port}/ws');
    });

    it('indexes every searchable facet, lowercased', () => {
        const [row] = buildApiRows([mkApi()], [mkRepo('shop-api', null)]);
        for (const term of ['orders api', 'orders-svc', 'payments-team', 'shop-api', '/orders', 'openapi', 'production', 'public', 'api.acme.example']) {
            expect(row.searchText, `searchText should contain "${term}"`).toContain(term);
        }
    });
});
