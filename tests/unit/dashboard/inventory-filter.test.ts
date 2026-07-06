import { describe, it, expect } from 'vitest';
import type { InventoryReport, InventoryRepo, InventoryService, InventoryApi } from '@coderadius/shared-types';
import { filterInventoryByOrg } from '../../../packages/dashboard-ui/src/data/filterInventoryByOrg.js';

// Organizations are single-level (GitLab base group, GitHub org, IDP unit):
// the filter is an exact, case-normalized match on the repo's org.

function mkRepo(name: string, org: string | null, teams: string[], fileCount = 1, functionCount = 10): InventoryRepo {
    return {
        name, org, url: null, repoHash: null, services: [], fileCount, functionCount, teams,
        languages: [], ingestionLevel: 'structure', branch: null, defaultBranch: null,
        coreBranches: [], hostingPlatform: null, livenessCommits: null, lastAnalyzedAt: null,
    };
}

function mkService(name: string, repoName: string, team: string | null): InventoryService {
    return {
        urn: `cr:service:${repoName}:${name}`, name, team, languages: [],
        repository: { name: repoName, url: null }, indexedFunctionCount: 0,
        exposedEndpointCount: 0, dependencyCount: 0,
    };
}

function mkApi(title: string, repository: string | null): InventoryApi {
    return {
        urn: `cr:api:openapi:${title.toLowerCase().replace(/\s+/g, '-')}`,
        title, version: '1.0', apiSource: 'openapi',
        exposers: [], team: null, repository,
        specPath: null, deployments: [], endpoints: [], consumerCount: 0,
    };
}

function mkReport(): InventoryReport {
    return {
        repositories: [
            mkRepo('orders', 'acme', ['payments-team'], 10, 100),
            mkRepo('ts-lib', 'acme', ['platform'], 5, 50),
            mkRepo('webapp', 'Acme', ['web'], 3, 30),   // case variant: must match 'acme'
            mkRepo('side', 'acmefoo', ['platform'], 1, 1), // distinct org: must NOT match 'acme'
            mkRepo('legacy', 'beta', ['beta-team'], 2, 20),
            mkRepo('orphan', null, []),                    // null org: excluded when filtered
        ],
        services: [
            mkService('orders-svc', 'orders', 'payments-team'),
            mkService('beta-svc', 'legacy', 'beta-team'),
        ],
        teams: [
            { name: 'payments-team', teamType: null, serviceCount: 1, repoCount: 1, languages: [] },
            { name: 'platform', teamType: null, serviceCount: 0, repoCount: 2, languages: [] },
            { name: 'web', teamType: null, serviceCount: 0, repoCount: 1, languages: [] },
            { name: 'beta-team', teamType: null, serviceCount: 1, repoCount: 1, languages: [] },
        ],
        organizations: [
            { name: 'acme', fullPath: 'acme', repoCount: 3, serviceCount: 1 },
            { name: 'acmefoo', fullPath: 'acmefoo', repoCount: 1, serviceCount: 0 },
            { name: 'beta', fullPath: 'beta', repoCount: 1, serviceCount: 1 },
        ],
        apiCatalog: [
            mkApi('Orders API', 'orders'),
            mkApi('Legacy API', 'legacy'),
            mkApi('Floating API', null), // no repo: excluded when filtered
        ],
        tenant: { name: 'Acme Inc', slug: 'acme-inc' },
        summary: { totalRepos: 6, totalServices: 2, totalTeams: 4, totalFiles: 22, totalFunctions: 211 },
    };
}

describe('filterInventoryByOrg', () => {
    it('returns the report unchanged when no org is selected', () => {
        const report = mkReport();
        expect(filterInventoryByOrg(report, [])).toBe(report);
    });

    it('filters repos by exact org and cascades to services, teams, and the API catalog', () => {
        const out = filterInventoryByOrg(mkReport(), ['acme']);
        // orders, ts-lib, webapp are in acme; side(acmefoo), legacy(beta), orphan(null) excluded.
        expect(out.repositories.map(r => r.name).sort()).toEqual(['orders', 'ts-lib', 'webapp']);
        // only orders-svc survives (its repo survived); beta-svc dropped.
        expect(out.services.map(s => s.name)).toEqual(['orders-svc']);
        // teams present in surviving repos/services: payments-team, platform, web. NOT beta-team.
        expect(out.teams.map(t => t.name).sort()).toEqual(['payments-team', 'platform', 'web']);
        // APIs follow their exposing repo; repo-less APIs drop under a filter.
        expect(out.apiCatalog.map(a => a.title)).toEqual(['Orders API']);
    });

    it('recomputes the summary to the filtered scope', () => {
        const out = filterInventoryByOrg(mkReport(), ['acme']);
        expect(out.summary).toEqual({
            totalRepos: 3,
            totalServices: 1,
            totalTeams: 3,
            totalFiles: 10 + 5 + 3,
            totalFunctions: 100 + 50 + 30,
        });
    });

    it('supports multi-org selection', () => {
        const out = filterInventoryByOrg(mkReport(), ['acme', 'beta']);
        expect(out.repositories.map(r => r.name).sort()).toEqual(['legacy', 'orders', 'ts-lib', 'webapp']);
    });

    it('normalizes case (selecting acme matches a repo stored as Acme)', () => {
        const out = filterInventoryByOrg(mkReport(), ['Acme']);
        expect(out.repositories.map(r => r.name).sort()).toEqual(['orders', 'ts-lib', 'webapp']);
    });

    it('preserves tenant and the full organization list under a filter', () => {
        const out = filterInventoryByOrg(mkReport(), ['beta']);
        expect(out.tenant).toEqual({ name: 'Acme Inc', slug: 'acme-inc' });
        expect(out.organizations.map(o => o.fullPath)).toEqual(['acme', 'acmefoo', 'beta']);
    });
});
