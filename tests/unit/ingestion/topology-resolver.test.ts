import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// Unit Tests: topology-resolver.ts
// ═══════════════════════════════════════════════════════════════════════════════

import {
    normalizeDependencyRef,
    selectPrimaryComponent,
    collapseToTopology,
    resolveCatalogPriority,
    weldIdentities,
    deriveUsefulName,
    resolveAutoTopology,
    type DiscoveredComponent,
    type AuxiliaryEntity,
    type WeldResult,
} from '../../../src/ingestion/topology-resolver.js';

// ─── normalizeDependencyRef ─────────────────────────────────────────────────

describe('normalizeDependencyRef', () => {
    it('strips kind and namespace from fully qualified Backstage refs', () => {
        expect(normalizeDependencyRef('component:default/loyalty-service')).toBe('loyalty-service');
    });

    it('strips namespace only', () => {
        expect(normalizeDependencyRef('default/loyalty-service')).toBe('loyalty-service');
    });

    it('strips kind only', () => {
        expect(normalizeDependencyRef('component:loyalty-service')).toBe('loyalty-service');
    });

    it('returns raw name if no prefixes exist (Cortex format)', () => {
        expect(normalizeDependencyRef('loyalty-service')).toBe('loyalty-service');
    });
});

// ─── deriveUsefulName ───────────────────────────────────────────────────────

describe('deriveUsefulName', () => {
    it('returns directory basename for normal paths', () => {
        expect(deriveUsefulName('/repo/api', '/repo', 'my-monorepo')).toBe('api');
    });

    it('returns repo name when path IS the repo root', () => {
        expect(deriveUsefulName('/repo', '/repo', 'my-monorepo')).toBe('my-monorepo');
        expect(deriveUsefulName('/repo/', '/repo', 'my-monorepo')).toBe('my-monorepo');
    });

    it('returns repo name for generic directory names', () => {
        expect(deriveUsefulName('/repo/src', '/repo', 'my-monorepo')).toBe('my-monorepo');
        expect(deriveUsefulName('/repo/app', '/repo', 'my-monorepo')).toBe('my-monorepo');
        expect(deriveUsefulName('/repo/backend', '/repo', 'my-monorepo')).toBe('my-monorepo');
        expect(deriveUsefulName('/repo/frontend', '/repo', 'my-monorepo')).toBe('my-monorepo');
        expect(deriveUsefulName('/repo/main', '/repo', 'my-monorepo')).toBe('my-monorepo');
        expect(deriveUsefulName('/repo/server', '/repo', 'my-monorepo')).toBe('my-monorepo');
        expect(deriveUsefulName('/repo/client', '/repo', 'my-monorepo')).toBe('my-monorepo');
    });

    it('is case-insensitive for blacklist check', () => {
        expect(deriveUsefulName('/repo/SRC', '/repo', 'my-monorepo')).toBe('my-monorepo');
        expect(deriveUsefulName('/repo/App', '/repo', 'my-monorepo')).toBe('my-monorepo');
    });

    it('allows valid directory names that contain blacklisted words as substrings', () => {
        expect(deriveUsefulName('/repo/backend-api', '/repo', 'my-monorepo')).toBe('backend-api');
        expect(deriveUsefulName('/repo/my-app-service', '/repo', 'my-monorepo')).toBe('my-app-service');
    });

    it('walks UP the directory tree when basename is generic (multi-monolith edge case)', () => {
        // /repo/loyalty-service/src → should use "loyalty-service", NOT "my-repo"
        expect(deriveUsefulName('/repo/loyalty-service/src', '/repo', 'my-repo')).toBe('loyalty-service');
        expect(deriveUsefulName('/repo/payment-service/src', '/repo', 'my-repo')).toBe('payment-service');
    });

    it('walks past multiple generic layers', () => {
        // /repo/checkout/src/main → skip "main" (generic), skip "src" (generic), use "checkout"
        expect(deriveUsefulName('/repo/checkout/src/main', '/repo', 'my-repo')).toBe('checkout');
    });

    it('falls back to repoName only when ALL path segments are generic', () => {
        // /repo/src/app → both generic, nothing useful → repoName
        expect(deriveUsefulName('/repo/src/app', '/repo', 'my-repo')).toBe('my-repo');
    });
});

// ─── selectPrimaryComponent ─────────────────────────────────────────────────

describe('selectPrimaryComponent', () => {
    const comp = (name: string, catalogFile: string, type?: string): DiscoveredComponent => ({
        name,
        catalogFile,
        type,
        source: 'backstage',
    });

    it('prefers component whose name matches repo name', () => {
        const result = selectPrimaryComponent(
            [comp('api', '/repo/api/catalog.yaml'), comp('my-app', '/repo/catalog.yaml')],
            'my-app',
        );
        expect(result.name).toBe('my-app');
    });

    it('prefers type:service over type:library', () => {
        const result = selectPrimaryComponent(
            [comp('lib', '/repo/catalog.yaml', 'library'), comp('svc', '/repo/catalog.yaml', 'service')],
            'unrelated-name',
        );
        expect(result.name).toBe('svc');
    });

    it('falls back to shallowest catalog file', () => {
        const result = selectPrimaryComponent(
            [comp('deep', '/repo/a/b/catalog.yaml', 'service'), comp('shallow', '/repo/catalog.yaml', 'service')],
            'unrelated-name',
        );
        expect(result.name).toBe('shallow');
    });

    it('uses alphabetical tie-breaker for same depth and type', () => {
        const result = selectPrimaryComponent(
            [comp('zebra', '/repo/z/catalog.yaml', 'service'), comp('alpha', '/repo/a/catalog.yaml', 'service')],
            'unrelated-name',
        );
        expect(result.name).toBe('alpha');
    });
});

// ─── resolveCatalogPriority ─────────────────────────────────────────────────

describe('resolveCatalogPriority', () => {
    it('returns cortex when both exist (Cortex wins)', () => {
        expect(resolveCatalogPriority(true, true)).toBe('cortex');
    });

    it('returns backstage when only backstage exists', () => {
        expect(resolveCatalogPriority(true, false)).toBe('backstage');
    });

    it('returns cortex when only cortex exists', () => {
        expect(resolveCatalogPriority(false, true)).toBe('cortex');
    });

    it('returns autodiscovery when neither exists', () => {
        expect(resolveCatalogPriority(false, false)).toBe('autodiscovery');
    });
});

// ─── weldIdentities ─────────────────────────────────────────────────────────

describe('weldIdentities', () => {
    const catalogComp = (name: string, dir: string, extra: Partial<DiscoveredComponent> = {}): DiscoveredComponent => ({
        name,
        owner: 'team-platform',
        system: 'inventory',
        dependsOn: ['external-svc'],
        type: 'service',
        language: 'unknown',
        catalogFile: `${dir}/catalog-info.yaml`,
        source: 'backstage',
        ...extra,
    });

    const autoComp = (name: string, dir: string, language = 'php'): DiscoveredComponent => ({
        name,
        language,
        catalogFile: dir,
        source: 'autodiscovery',
    });

    it('welds catalog metadata with autodiscovery name by path', () => {
        const catalog = [catalogComp('com.acme.eng.inventory.core.api', '/repo/api')];
        const auto = [autoComp('api', '/repo/api')];

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', {});

        expect(result.components).toHaveLength(1);
        expect(result.unmatchedCatalogComponents).toHaveLength(0);
        expect(result.components[0].name).toBe('api');                            // from auto
        expect(result.components[0].catalogName).toBe('com.acme.eng.inventory.core.api'); // preserved
        expect(result.components[0].catalogSource).toBe('backstage');
        expect(result.components[0].owner).toBe('team-platform');                 // from catalog
        expect(result.components[0].system).toBe('inventory');                    // from catalog
        expect(result.components[0].language).toBe('php');                        // from auto (wins)
    });

    it('applies nameOverride when configured', () => {
        const catalog = [catalogComp('com.acme.platform', '/repo')];
        const auto = [autoComp('acme-platform', '/repo')];
        const overrides = { 'com.acme.platform': 'acme-platform-app' };

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', overrides);

        expect(result.components[0].name).toBe('acme-platform-app');
        expect(result.components[0].catalogName).toBe('com.acme.platform');
    });

    it('falls back to repo name for generic directory names', () => {
        const catalog = [catalogComp('com.acme.main-app', '/repo/src')];
        const auto = [autoComp('src', '/repo/src')];

        const result = weldIdentities(catalog, auto, '/repo', 'my-monolith', {});

        expect(result.components[0].name).toBe('my-monolith'); // not "src"!
        expect(result.components[0].catalogName).toBe('com.acme.main-app');
    });

    it('handles multi-doc YAML: only primary is welded, secondary goes to unmatched', () => {
        // Same directory, two catalog components (Component + Library)
        const catalog = [
            catalogComp('com.acme.api', '/repo/api', { type: 'service' }),
            catalogComp('com.acme.api-utils', '/repo/api', { type: 'library' }),
        ];
        const auto = [autoComp('api', '/repo/api')];

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', {});

        // Primary (type:service) gets welded with auto name "api"
        expect(result.components).toHaveLength(1);
        expect(result.components[0].name).toBe('api');
        expect(result.components[0].catalogName).toBe('com.acme.api');

        // Secondary (type:library) goes to unmatched — NOT a Service node
        expect(result.unmatchedCatalogComponents).toHaveLength(1);
        expect(result.unmatchedCatalogComponents[0].name).toBe('com.acme.api-utils');
    });

    it('per-directory safety net: promotes catalog-only directories as Services', () => {
        // catalog declares a service in /repo/svc, but autodiscovery only found /repo/checkout
        // Per-directory: /repo/svc has no auto coverage → promote catalog
        const catalog = [catalogComp('my-service', '/repo/svc')];
        const auto = [autoComp('checkout', '/repo/checkout')]; // different dir

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', {});

        // BOTH are promoted: auto component + catalog safety net
        expect(result.components).toHaveLength(2);
        expect(result.components.find(c => c.name === 'checkout')).toBeDefined();
        expect(result.components.find(c => c.name === 'my-service')).toBeDefined();
        expect(result.unmatchedCatalogComponents).toHaveLength(0);
    });

    it('safety net: promotes catalog when autodiscovery finds nothing', () => {
        const catalog = [catalogComp('my-service', '/repo/svc')];
        const auto: DiscoveredComponent[] = []; // no autodiscovery

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', {});

        // Safety net fires: catalog promoted
        expect(result.components).toHaveLength(1);
        expect(result.components[0].name).toBe('my-service');
        expect(result.unmatchedCatalogComponents).toHaveLength(0);
    });

    it('safety net applies nameOverrides', () => {
        const catalog = [catalogComp('com.acme.legacy', '/repo')];
        const auto: DiscoveredComponent[] = [];
        const overrides = { 'com.acme.legacy': 'legacy-app' };

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', overrides);

        expect(result.components).toHaveLength(1);
        expect(result.components[0].name).toBe('legacy-app');
        expect(result.components[0].catalogName).toBe('com.acme.legacy');
    });

    it('umbrella catalog at repo root with nested auto components → catalog NOT promoted', () => {
        // Real-world umbrella pattern: catalog-info.yaml at /repo describes the WHOLE
        // monorepo with an admin-style name; autodiscovery finds manifests only in
        // sub-directories. The umbrella catalog must NOT appear as a 9th Service.
        const catalog = [catalogComp('com.acme.eng.shop.core.acme-platform', '/repo')];
        const auto = [
            autoComp('api', '/repo/api'),
            autoComp('console', '/repo/console'),
            autoComp('helper', '/repo/helper'),
        ];

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', {});

        // Only the autodiscovered sub-services become Services.
        expect(result.components).toHaveLength(3);
        const names = result.components.map(c => c.name).sort();
        expect(names).toEqual(['api', 'console', 'helper']);
        // The umbrella catalog is observable as unmatched, never a Service.
        expect(result.unmatchedCatalogComponents).toHaveLength(1);
        expect(result.unmatchedCatalogComponents[0].name).toBe('com.acme.eng.shop.core.acme-platform');
    });

    it('mixed monorepo: React + legacy Java + bash cron (per-directory safety net)', () => {
        // Enterprise monorepo: 3 services declared in catalog, but only React has a manifest
        const catalog = [
            catalogComp('frontend-react', '/repo/frontend-react'),
            catalogComp('backend-legacy-java', '/repo/backend-legacy-java'),
            catalogComp('bash-scripts-cron', '/repo/bash-scripts-cron'),
        ];
        const auto = [
            autoComp('frontend-react', '/repo/frontend-react', 'typescript'), // has package.json
            // backend-legacy-java: no pom.xml (Ant build) → auto misses it
            // bash-scripts-cron: no manifest → auto misses it
        ];

        const result = weldIdentities(catalog, auto, '/repo', 'enterprise-repo', {});

        // ALL 3 services must appear:
        // - frontend-react: welded (auto + catalog)
        // - backend-legacy-java: promoted by per-directory safety net
        // - bash-scripts-cron: promoted by per-directory safety net
        expect(result.components).toHaveLength(3);
        const names = result.components.map(c => c.name).sort();
        expect(names).toEqual(['backend-legacy-java', 'bash-scripts-cron', 'frontend-react']);
        expect(result.unmatchedCatalogComponents).toHaveLength(0);
    });

    it('per-directory safety net: multi-doc in uncovered dir promotes only primary', () => {
        // A catalog-only directory with 2 components (multi-doc) → promote primary only
        const catalog = [
            catalogComp('backend-api', '/repo/backend', { type: 'service' }),
            catalogComp('backend-lib', '/repo/backend', { type: 'library' }),
        ];
        const auto = [autoComp('frontend', '/repo/frontend')]; // different dir

        const result = weldIdentities(catalog, auto, '/repo', 'my-repo', {});

        // frontend passes through, backend-api promoted (primary), backend-lib unmatched
        expect(result.components).toHaveLength(2);
        expect(result.components.find(c => c.name === 'frontend')).toBeDefined();
        expect(result.components.find(c => c.name === 'backend-api')).toBeDefined();
        expect(result.unmatchedCatalogComponents).toHaveLength(1);
        expect(result.unmatchedCatalogComponents[0].name).toBe('backend-lib');
    });

    it('passes through unmatched auto components', () => {
        const catalog: DiscoveredComponent[] = []; // no catalog
        const auto = [autoComp('checkout', '/repo/checkout')];

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', {});

        expect(result.components).toHaveLength(1);
        expect(result.components[0].name).toBe('checkout');
        expect(result.components[0].source).toBe('autodiscovery');
        expect(result.unmatchedCatalogComponents).toHaveLength(0);
    });

    it('handles mixed scenario: welded + unmatched auto + catalog safety net', () => {
        const catalog = [
            catalogComp('com.acme.api', '/repo/api'),
            catalogComp('com.acme.admin', '/repo/admin'),  // no auto match → promoted by safety net
        ];
        const auto = [
            autoComp('api', '/repo/api'),
            autoComp('worker', '/repo/worker'), // no catalog match
        ];

        const result = weldIdentities(catalog, auto, '/repo', 'acme-platform', {});

        // 3 Services: welded api + pure auto worker + safety net admin
        expect(result.components).toHaveLength(3);
        const api = result.components.find(c => c.name === 'api')!;
        expect(api.catalogName).toBe('com.acme.api');
        const worker = result.components.find(c => c.name === 'worker')!;
        expect(worker.source).toBe('autodiscovery');
        const admin = result.components.find(c => c.name === 'com.acme.admin')!;
        expect(admin).toBeDefined();

        // No unmatched — admin was promoted
        expect(result.unmatchedCatalogComponents).toHaveLength(0);
    });

    it('centralized catalog pattern: only local code becomes Service', () => {
        // Centralized catalog-info.yaml lists services from OTHER repos
        // but only one auto component is local code
        const catalog = [
            catalogComp('trust-me', '/repo', { system: 'verified-data' }),
            catalogComp('integration-hub', '/repo', { system: 'integration' }),
        ];
        const auto = [autoComp('repo-code', '/repo')];

        const result = weldIdentities(catalog, auto, '/repo', 'my-repo', {});

        // Only 1 welded Service (primary catalog + auto)
        expect(result.components).toHaveLength(1);
        // Secondary catalog component is unmatched
        expect(result.unmatchedCatalogComponents).toHaveLength(1);
    });

    it('both empty: returns empty result', () => {
        const result = weldIdentities([], [], '/repo', 'acme-platform', {});
        expect(result.components).toHaveLength(0);
        expect(result.unmatchedCatalogComponents).toHaveLength(0);
    });
});

// ─── resolveAutoTopology ────────────────────────────────────────────────────

describe('resolveAutoTopology', () => {
    const comp = (
        name: string,
        catalogFile: string,
        source: 'backstage' | 'cortex' | 'autodiscovery' = 'backstage',
    ): DiscoveredComponent => ({
        name,
        catalogFile,
        source,
        language: 'typescript',
    });

    it('returns monorepo for empty array', () => {
        expect(resolveAutoTopology([])).toBe('monorepo');
    });

    it('returns monorepo for single component', () => {
        expect(resolveAutoTopology([comp('api', '/repo/catalog-info.yaml')])).toBe('monorepo');
    });

    it('SMART MONOLITH: returns monolith for 1 auto component with nested catalog components', () => {
        expect(resolveAutoTopology([
            comp('root-app', '/repo', 'autodiscovery'),
            comp('api', '/repo/api/catalog-info.yaml', 'backstage'),
            comp('worker', '/repo/worker/catalog-info.yaml', 'backstage'),
        ])).toBe('monolith');
    });

    it('SMART MONOLITH: returns monorepo for 1 auto component with sibling (non-nested) catalog component', () => {
        expect(resolveAutoTopology([
            comp('frontend', '/repo/frontend', 'autodiscovery'),
            comp('backend', '/repo/backend/catalog-info.yaml', 'backstage'),
        ])).toBe('monorepo');
    });

    it('returns monolith when 2 backstage components share same dir', () => {
        expect(resolveAutoTopology([
            comp('svc', '/repo/catalog-info.yaml'),
            comp('worker', '/repo/catalog-info.yaml'),
        ])).toBe('monolith');
    });

    it('returns monorepo when backstage components are in different dirs', () => {
        expect(resolveAutoTopology([
            comp('api', '/repo/api/catalog-info.yaml'),
            comp('worker', '/repo/worker/catalog-info.yaml'),
        ])).toBe('monorepo');
    });

    it('SMART MONOLITH: returns monolith when 1 nested catalog component exists alongside 1 auto component', () => {
        expect(resolveAutoTopology([
            comp('api', '/repo/catalog-info.yaml', 'backstage'),
            comp('auto-svc', '/repo', 'autodiscovery'),
        ])).toBe('monolith');
    });

    it('returns monolith when 2 catalog + 1 autodiscovery share same dir', () => {
        expect(resolveAutoTopology([
            comp('svc', '/repo/catalog-info.yaml', 'backstage'),
            comp('worker', '/repo/catalog-info.yaml', 'backstage'),
            comp('auto-svc', '/repo', 'autodiscovery'),
        ])).toBe('monolith');
    });

    it('returns monorepo for 2 autodiscovery-only components in same dir', () => {
        expect(resolveAutoTopology([
            comp('svc-a', '/repo', 'autodiscovery'),
            comp('svc-b', '/repo', 'autodiscovery'),
        ])).toBe('monorepo');
    });

    it('returns monolith for cortex components in same dir', () => {
        expect(resolveAutoTopology([
            comp('svc', '/repo/cortex.yaml', 'cortex'),
            comp('worker', '/repo/cortex.yaml', 'cortex'),
        ])).toBe('monolith');
    });

    it('returns monolith for mixed backstage + cortex in same dir', () => {
        expect(resolveAutoTopology([
            comp('service-a', '/repo/catalog-info.yaml', 'backstage'),
            comp('service-b', '/repo/catalog-info.yaml', 'cortex'),
        ])).toBe('monolith');
    });

    it('returns monolith for same-dir components regardless of system (code-first handles this)', () => {
        // With code-first welding, catalog-only components from different systems
        // never reach resolveAutoTopology. The heuristic stays simple: same dir = monolith.
        const compA = comp('trust-me', '/repo/catalog-info.yaml', 'backstage');
        compA.system = 'com.acme.inventory.verified-data';
        compA.type = 'service';
        
        const compB = comp('integration-hub', '/repo/catalog-info.yaml', 'backstage');
        compB.system = 'com.acme.inventory.integration';
        compB.type = 'service';

        expect(resolveAutoTopology([compA, compB])).toBe('monolith');
    });

    it('normalizes Windows-style backslashes for directory comparison', () => {
        expect(resolveAutoTopology([
            comp('svc', 'C:\\repo\\catalog-info.yaml', 'backstage'),
            comp('worker', 'C:\\repo\\catalog-info.yaml', 'backstage'),
        ])).toBe('monolith');
    });

    it('returns monolith for 5+ catalog components in same dir', () => {
        expect(resolveAutoTopology([
            comp('api', '/repo/catalog-info.yaml'),
            comp('worker', '/repo/catalog-info.yaml'),
            comp('scheduler', '/repo/catalog-info.yaml'),
            comp('consumer', '/repo/catalog-info.yaml'),
            comp('notifier', '/repo/catalog-info.yaml'),
        ])).toBe('monolith');
    });
});

// ─── collapseToTopology ─────────────────────────────────────────────────────

describe('collapseToTopology', () => {
    const makeComp = (name: string, deps: string[] = []): DiscoveredComponent => ({
        name,
        catalogFile: `/repo/${name}/catalog-info.yaml`,
        dependsOn: deps,
        source: 'backstage',
        language: 'typescript',
    });

    const emptyHints = { decorators: [], databases: [], hints: [], message_channels: { aliases: [] } } as any;

    describe('monorepo topology', () => {
        it('creates 1 Service per Component (pass-through)', () => {
            const components = [makeComp('checkout'), makeComp('payments')];
            const result = collapseToTopology(components, [], 'monorepo', 'my-monorepo', '/tmp/my-monorepo', emptyHints);

            expect(result.services).toHaveLength(2);
            expect(result.effectiveTopology).toBe('monorepo');
            expect(result.services[0].component.name).toBe('checkout');
            expect(result.services[1].component.name).toBe('payments');
            expect(result.services[0].deploymentUnits).toHaveLength(0);
            expect(result.services[1].deploymentUnits).toHaveLength(0);
        });

        it('classifies dependencies as internal or external', () => {
            const components = [
                makeComp('api', ['helper-lib', 'external-api']),
                makeComp('helper-lib'),
            ];
            const result = collapseToTopology(components, [], 'monorepo', 'my-repo', '/tmp/my-repo', emptyHints);

            const apiEntry = result.services.find(s => s.component.name === 'api')!;
            expect(apiEntry.internalDeps).toContain('helper-lib');
            expect(apiEntry.externalDeps).toContain('external-api');
        });
    });

    describe('monolith topology', () => {
        it('collapses 3 components into 1 Service + 2 DeploymentUnits', () => {
            const components = [
                makeComp('acme-platform'),
                makeComp('acme-api'),
                makeComp('acme-ws'),
            ];
            const result = collapseToTopology(components, [], 'monolith', 'acme-platform', '/tmp/acme-platform', emptyHints);

            expect(result.services).toHaveLength(1);
            expect(result.effectiveTopology).toBe('monolith');
            expect(result.services[0].component.name).toBe('acme-platform');
            expect(result.services[0].deploymentUnits).toHaveLength(2);
            const duNames = result.services[0].deploymentUnits.map(d => d.name).sort();
            expect(duNames).toEqual(['acme-api', 'acme-ws']);
        });

        it('selects primary by repo name match, not file order', () => {
            const components = [
                makeComp('api-component'),
                makeComp('my-monolith'),
                makeComp('worker'),
            ];
            const result = collapseToTopology(components, [], 'monolith', 'my-monolith', '/tmp/my-monolith', emptyHints);

            expect(result.services[0].component.name).toBe('my-monolith');
        });

        it('reclassifies intra-repo deps as internal, external deps as external', () => {
            const components = [
                makeComp('main-app', ['helper-lib', 'external-svc']),
                makeComp('helper-lib'),
            ];
            const result = collapseToTopology(components, [], 'monolith', 'main-app', '/tmp/main-app', emptyHints);

            expect(result.services[0].internalDeps).toContain('helper-lib');
            expect(result.services[0].externalDeps).toContain('external-svc');
        });

        it('normalizes Backstage-style refs before classifying', () => {
            const comp = makeComp('main-app', ['component:default/helper-lib', 'component:external-svc']);
            const helper = makeComp('helper-lib');
            const result = collapseToTopology([comp, helper], [], 'monolith', 'main-app', '/tmp/main-app', emptyHints);

            expect(result.services[0].internalDeps).toContain('helper-lib');
            expect(result.services[0].externalDeps).toContain('external-svc');
        });

        it('honors independent-service role override in monolith mode', () => {
            const hintsWithOverride = {
                ...emptyHints,
                services: {
                    topology: 'monolith' as const,
                    overrides: { 'sidecar': { role: 'independent-service' as const } },
                },
            };

            const components = [
                makeComp('main-app'),
                makeComp('api-facet'),
                makeComp('sidecar'),
            ];
            const result = collapseToTopology(components, [], 'monolith', 'main-app', '/tmp/main-app', hintsWithOverride);

            expect(result.services).toHaveLength(2);
            const names = result.services.map(s => s.component.name).sort();
            expect(names).toEqual(['main-app', 'sidecar']);

            const mainEntry = result.services.find(s => s.component.name === 'main-app')!;
            expect(mainEntry.deploymentUnits).toHaveLength(1);
            expect(mainEntry.deploymentUnits[0].name).toBe('api-facet');
        });
    });

    // ─── auto topology ──────────────────────────────────────────────────────

    describe('auto topology', () => {
        const makeAutoComp = (
            name: string,
            catalogFile: string,
            source: 'backstage' | 'cortex' | 'autodiscovery' = 'backstage',
            deps: string[] = [],
        ): DiscoveredComponent => ({
            name,
            catalogFile,
            dependsOn: deps,
            source,
            language: 'typescript',
            // Autodiscovery now classifies workspaces explicitly via
            // classifyServiceRole; in the auto-topology tests we mirror what
            // a runtime-classified workspace looks like.
            type: source === 'autodiscovery' ? 'service' : undefined,
        });

        it('collapses 2 same-dir backstage components into monolith', () => {
            const components = [
                makeAutoComp('my-service', '/repo/catalog-info.yaml'),
                makeAutoComp('my-worker', '/repo/catalog-info.yaml'),
            ];
            const result = collapseToTopology(components, [], 'auto', 'my-service', '/tmp/my-service', emptyHints);

            expect(result.effectiveTopology).toBe('monolith');
            expect(result.services).toHaveLength(1);
            expect(result.services[0].component.name).toBe('my-service');
            expect(result.services[0].deploymentUnits).toHaveLength(1);
            expect(result.services[0].deploymentUnits[0].name).toBe('my-worker');
        });

        it('keeps different-dir backstage components as monorepo', () => {
            const components = [
                makeAutoComp('api', '/repo/api/catalog-info.yaml'),
                makeAutoComp('worker', '/repo/worker/catalog-info.yaml'),
            ];
            const result = collapseToTopology(components, [], 'auto', 'my-repo', '/tmp/my-repo', emptyHints);

            expect(result.effectiveTopology).toBe('monorepo');
            expect(result.services).toHaveLength(2);
        });

        it('treats single component as monorepo', () => {
            const components = [makeAutoComp('api', '/repo/catalog-info.yaml')];
            const result = collapseToTopology(components, [], 'auto', 'my-repo', '/tmp/my-repo', emptyHints);

            expect(result.effectiveTopology).toBe('monorepo');
            expect(result.services).toHaveLength(1);
            expect(result.services[0].deploymentUnits).toHaveLength(0);
        });

        it('treats only-autodiscovery components as monorepo', () => {
            const components = [
                makeAutoComp('svc-a', '/repo', 'autodiscovery'),
                makeAutoComp('svc-b', '/repo', 'autodiscovery'),
            ];
            const result = collapseToTopology(components, [], 'auto', 'my-repo', '/tmp/my-repo', emptyHints);

            expect(result.effectiveTopology).toBe('monorepo');
            expect(result.services).toHaveLength(2);
        });

        it('explicit monorepo override wins over auto-monolith detection', () => {
            const hintsMonorepo = {
                ...emptyHints,
                services: { topology: 'monorepo' as const },
            };
            // Same dir → would be auto-monolith, but explicit override wins
            const components = [
                makeAutoComp('svc', '/repo/catalog-info.yaml'),
                makeAutoComp('worker', '/repo/catalog-info.yaml'),
            ];
            const result = collapseToTopology(components, [], 'monorepo', 'my-repo', '/tmp/my-repo', hintsMonorepo);

            expect(result.effectiveTopology).toBe('monorepo');
            expect(result.services).toHaveLength(2);
            expect(result.services[0].deploymentUnits).toHaveLength(0);
        });

        it('explicit monolith override wins over auto-monorepo detection', () => {
            // Different dirs → would be auto-monorepo, but explicit override wins
            const components = [
                makeAutoComp('api', '/repo/api/catalog-info.yaml'),
                makeAutoComp('worker', '/repo/worker/catalog-info.yaml'),
            ];
            const result = collapseToTopology(components, [], 'monolith', 'api', '/tmp/api', emptyHints);

            expect(result.effectiveTopology).toBe('monolith');
            expect(result.services).toHaveLength(1);
            expect(result.services[0].deploymentUnits).toHaveLength(1);
        });

        it('selects primary by repo-name match in auto-monolith', () => {
            const components = [
                makeAutoComp('worker', '/repo/catalog-info.yaml'),
                makeAutoComp('acme-shop', '/repo/catalog-info.yaml'),
                makeAutoComp('consumers', '/repo/catalog-info.yaml'),
            ];
            const result = collapseToTopology(components, [], 'auto', 'acme-shop', '/tmp/acme-shop', emptyHints);

            expect(result.effectiveTopology).toBe('monolith');
            expect(result.services[0].component.name).toBe('acme-shop');
            expect(result.services[0].deploymentUnits).toHaveLength(2);
            const duNames = result.services[0].deploymentUnits.map(d => d.name).sort();
            expect(duNames).toEqual(['consumers', 'worker']);
        });

        it('classifies deps correctly in auto-monolith mode', () => {
            const components = [
                makeAutoComp('main-app', '/repo/catalog-info.yaml', 'backstage', ['helper-lib', 'external-svc']),
                makeAutoComp('helper-lib', '/repo/catalog-info.yaml'),
            ];
            const result = collapseToTopology(components, [], 'auto', 'main-app', '/tmp/main-app', emptyHints);

            expect(result.effectiveTopology).toBe('monolith');
            expect(result.services[0].internalDeps).toContain('helper-lib');
            expect(result.services[0].externalDeps).toContain('external-svc');
        });

        it('honors independent-service role override in auto-monolith', () => {
            const hintsWithOverride = {
                ...emptyHints,
                services: {
                    overrides: { 'sidecar': { role: 'independent-service' as const } },
                },
            };
            const components = [
                makeAutoComp('main-app', '/repo/catalog-info.yaml'),
                makeAutoComp('api-facet', '/repo/catalog-info.yaml'),
                makeAutoComp('sidecar', '/repo/catalog-info.yaml'),
            ];
            const result = collapseToTopology(components, [], 'auto', 'main-app', '/tmp/main-app', hintsWithOverride);

            expect(result.effectiveTopology).toBe('monolith');
            expect(result.services).toHaveLength(2);
            const names = result.services.map(s => s.component.name).sort();
            expect(names).toEqual(['main-app', 'sidecar']);
            const mainEntry = result.services.find(s => s.component.name === 'main-app')!;
            expect(mainEntry.deploymentUnits).toHaveLength(1);
            expect(mainEntry.deploymentUnits[0].name).toBe('api-facet');
        });

        it('auto-detects monolith with cortex components', () => {
            const components = [
                makeAutoComp('api', '/repo/cortex.yaml', 'cortex'),
                makeAutoComp('worker', '/repo/cortex.yaml', 'cortex'),
            ];
            const result = collapseToTopology(components, [], 'auto', 'api', '/tmp/api', emptyHints);

            expect(result.effectiveTopology).toBe('monolith');
            expect(result.services).toHaveLength(1);
            expect(result.services[0].component.name).toBe('api');
            expect(result.services[0].deploymentUnits).toHaveLength(1);
        });

        it('handles 5+ component monolith with correct DU count', () => {
            const components = [
                makeAutoComp('platform', '/repo/catalog-info.yaml'),
                makeAutoComp('api', '/repo/catalog-info.yaml'),
                makeAutoComp('worker', '/repo/catalog-info.yaml'),
                makeAutoComp('scheduler', '/repo/catalog-info.yaml'),
                makeAutoComp('consumer', '/repo/catalog-info.yaml'),
            ];
            const result = collapseToTopology(components, [], 'auto', 'platform', '/tmp/platform', emptyHints);

            expect(result.effectiveTopology).toBe('monolith');
            expect(result.services).toHaveLength(1);
            expect(result.services[0].component.name).toBe('platform');
            expect(result.services[0].deploymentUnits).toHaveLength(4);
        });
    });
});
