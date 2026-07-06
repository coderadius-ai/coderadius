import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all graph mutations called by writeTopologyToGraph ─────────────────
// vi.hoisted because vi.mock is hoisted above ESM imports — the factory must
// not reference module-level variables that aren't hoisted with it.
const mocks = vi.hoisted(() => ({
    mergeService: vi.fn().mockResolvedValue(undefined),
    linkServiceStoredIn: vi.fn().mockResolvedValue(undefined),
    mergeSystem: vi.fn().mockResolvedValue(undefined),
    mergeDomain: vi.fn().mockResolvedValue(undefined),
    mergeTeam: vi.fn().mockResolvedValue(undefined),
    linkSystemContainsService: vi.fn().mockResolvedValue(undefined),
    linkSystemPartOfDomain: vi.fn().mockResolvedValue(undefined),
    linkTeamOwnsService: vi.fn().mockResolvedValue(undefined),
    linkServiceDependsOnService: vi.fn().mockResolvedValue(undefined),
    linkServiceDependsOnUnresolved: vi.fn().mockResolvedValue(undefined),
    mergeDeploymentUnit: vi.fn().mockResolvedValue(undefined),
    linkServiceDeployedAs: vi.fn().mockResolvedValue(undefined),
    linkSystemContainsDeploymentUnit: vi.fn().mockResolvedValue(undefined),
    mergePackage: vi.fn().mockResolvedValue(undefined),
    linkServiceDependsOnPackage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/graph/mutations/c4.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeService: mocks.mergeService,
    mergeSystem: mocks.mergeSystem,
    mergeDomain: mocks.mergeDomain,
    mergeTeam: mocks.mergeTeam,
    linkSystemContainsService: mocks.linkSystemContainsService,
    linkSystemPartOfDomain: mocks.linkSystemPartOfDomain,
    linkTeamOwnsService: mocks.linkTeamOwnsService,
    linkServiceDependsOnService: mocks.linkServiceDependsOnService,
    linkServiceDependsOnUnresolved: mocks.linkServiceDependsOnUnresolved,
}));
vi.mock('../../../src/graph/mutations/code-graph.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    linkServiceStoredIn: mocks.linkServiceStoredIn,
}));
vi.mock('../../../src/graph/mutations/deployment.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeDeploymentUnit: mocks.mergeDeploymentUnit,
    linkServiceDeployedAs: mocks.linkServiceDeployedAs,
    linkSystemContainsDeploymentUnit: mocks.linkSystemContainsDeploymentUnit,
}));
vi.mock('../../../src/graph/mutations/packages.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergePackage: mocks.mergePackage,
    linkServiceDependsOnPackage: mocks.linkServiceDependsOnPackage,
}));

import { writeTopologyToGraph, type TopologyResult, type DiscoveredComponent } from '../../../src/ingestion/topology-resolver.js';

const repo = { name: 'consumer', org: 'acme', path: '/repo' };

const buildResult = (services: Array<{
    component: DiscoveredComponent;
    externalDeps?: string[];
    internalDeps?: string[];
}>): TopologyResult => ({
    services: services.map(s => ({
        component: s.component,
        deploymentUnits: [],
        internalDeps: s.internalDeps ?? [],
        externalDeps: s.externalDeps ?? [],
    })),
    auxiliaryEntities: [],
    claimedPaths: [],
    effectiveTopology: 'monorepo',
});

describe('writeTopologyToGraph — dependency classification', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockClear();
    });

    it('local catalogName match → direct edge to local Service (no UnresolvedDependency)', async () => {
        // The catalog declares `dependsOn: com.acme.api`, but the local Service
        // is welded to the useful name `api`. Eager bind must recognise this
        // via catalogName and route DEPENDS_ON to the local Service.
        const result = buildResult([
            {
                component: {
                    name: 'consumer-svc',
                    catalogFile: '/repo/svc',
                    source: 'autodiscovery',
                },
                externalDeps: ['com.acme.api'],
            },
            {
                component: {
                    name: 'api',
                    catalogName: 'com.acme.api',
                    catalogFile: '/repo/api',
                    source: 'backstage',
                },
            },
        ]);

        await writeTopologyToGraph(result, repo);

        expect(mocks.linkServiceDependsOnService).toHaveBeenCalledTimes(1);
        expect(mocks.linkServiceDependsOnService).toHaveBeenCalledWith(
            'acme/consumer', 'consumer-svc',
            'acme/consumer', 'api',
            expect.any(String),
            expect.objectContaining({ source: 'autodiscovery' }),
            expect.objectContaining({ source: 'declared', quality: 'exact' }),
        );
        expect(mocks.linkServiceDependsOnUnresolved).not.toHaveBeenCalled();
    });

    it('local name match → direct edge (no UnresolvedDependency)', async () => {
        const result = buildResult([
            {
                component: {
                    name: 'consumer-svc',
                    catalogFile: '/repo/svc',
                    source: 'autodiscovery',
                },
                externalDeps: ['payments'],
            },
            {
                component: {
                    name: 'payments',
                    catalogFile: '/repo/payments',
                    source: 'autodiscovery',
                },
            },
        ]);

        await writeTopologyToGraph(result, repo);

        expect(mocks.linkServiceDependsOnService).toHaveBeenCalledWith(
            'acme/consumer', 'consumer-svc',
            'acme/consumer', 'payments',
            expect.any(String),
            expect.objectContaining({ source: 'autodiscovery' }),
            expect.objectContaining({ source: 'declared', quality: 'exact' }),
        );
        expect(mocks.linkServiceDependsOnUnresolved).not.toHaveBeenCalled();
    });

    it('cross-repo dependency → UnresolvedDependency placeholder, no Service stub', async () => {
        const result = buildResult([
            {
                component: {
                    name: 'consumer-svc',
                    catalogFile: '/repo/svc',
                    source: 'backstage',
                },
                externalDeps: ['order-service'],
            },
        ]);

        await writeTopologyToGraph(result, repo);

        expect(mocks.linkServiceDependsOnUnresolved).toHaveBeenCalledTimes(1);
        expect(mocks.linkServiceDependsOnUnresolved).toHaveBeenCalledWith(
            'acme/consumer', 'consumer-svc',
            'order-service',
            expect.any(String),
            expect.objectContaining({ source: 'backstage' }),
            expect.objectContaining({ source: 'declared', quality: 'exact' }),
        );
        // The legacy stub path must not fire for cross-repo deps anymore.
        expect(mocks.linkServiceDependsOnService).not.toHaveBeenCalled();
    });

    it('mixed deps: local + cross-repo split correctly', async () => {
        const result = buildResult([
            {
                component: {
                    name: 'consumer-svc',
                    catalogFile: '/repo/svc',
                    source: 'backstage',
                },
                externalDeps: ['payments', 'order-service'],
            },
            {
                component: {
                    name: 'payments',
                    catalogFile: '/repo/payments',
                    source: 'autodiscovery',
                },
            },
        ]);

        await writeTopologyToGraph(result, repo);

        expect(mocks.linkServiceDependsOnService).toHaveBeenCalledWith(
            'acme/consumer', 'consumer-svc',
            'acme/consumer', 'payments',
            expect.any(String),
            expect.any(Object),
            expect.objectContaining({ source: 'declared', quality: 'exact' }),
        );
        expect(mocks.linkServiceDependsOnUnresolved).toHaveBeenCalledWith(
            'acme/consumer', 'consumer-svc',
            'order-service',
            expect.any(String),
            expect.any(Object),
            expect.objectContaining({ source: 'declared', quality: 'exact' }),
        );
    });
});
