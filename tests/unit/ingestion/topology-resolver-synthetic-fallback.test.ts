import { describe, expect, it } from 'vitest';
import { collapseToTopology, type DiscoveredComponent } from '../../../src/ingestion/topology-resolver';

function mkComp(name: string, type: string | undefined, opts: { source?: DiscoveredComponent['source']; catalogFile?: string; language?: string } = {}): DiscoveredComponent {
    return {
        name,
        type,
        catalogFile: opts.catalogFile ?? `/repo/${name}`,
        source: opts.source ?? 'autodiscovery',
        language: opts.language,
    };
}

describe('collapseToTopology — synthetic repo-as-Service fallback', () => {
    const emptyHints = {} as any;

    it('monolith with single library component → synthesizes Service named after the repo', () => {
        const components = [mkComp('inventory-core', 'library', { language: 'php' })];
        const result = collapseToTopology(components, [], 'monolith', 'inventory', '/tmp/inventory', emptyHints);

        expect(result.services).toHaveLength(1);
        expect(result.services[0].component.name).toBe('inventory');
        expect(result.services[0].component.source).toBe('autodiscovery-synthetic');
        expect(result.services[0].component.type).toBe('service');
        expect(result.services[0].component.catalogFile).toBe('/tmp/inventory');
        expect(result.services[0].component.language).toBe('php');
    });

    it('monolith with one pendingTriage (type=undefined) → synthesizes Service', () => {
        const components = [mkComp('mystery-tool', undefined)];
        const result = collapseToTopology(components, [], 'monolith', 'inventory', '/tmp/inventory', emptyHints);

        expect(result.services).toHaveLength(1);
        expect(result.services[0].component.source).toBe('autodiscovery-synthetic');
    });

    it('guard: monolith already has a runtime service → no synthetic', () => {
        const components = [
            mkComp('api', 'service'),
            mkComp('shared', 'library'),
        ];
        const result = collapseToTopology(components, [], 'monolith', 'inventory', '/tmp/inventory', emptyHints);

        expect(result.services).toHaveLength(1);
        expect(result.services[0].component.name).toBe('api');
        expect(result.services[0].component.source).not.toBe('autodiscovery-synthetic');
    });

    it('guard: monorepo with only libraries → no synthetic (preserves multi-library shape)', () => {
        const components = [
            mkComp('inventory-core', 'library'),
            mkComp('orders-domain', 'library'),
            mkComp('payment-validation', 'library'),
        ];
        const result = collapseToTopology(components, [], 'monorepo', 'inventory', '/tmp/inventory', emptyHints);

        expect(result.services).toHaveLength(0);
        expect(result.libraries?.length).toBe(3);
    });

    it('guard: empty components → no synthetic (truly empty repo)', () => {
        const result = collapseToTopology([], [], 'monolith', 'empty-repo', '/tmp/empty-repo', emptyHints);

        expect(result.services).toHaveLength(0);
    });

    it('synthetic picks the first non-unknown language from components', () => {
        const components = [
            mkComp('helper-go', 'library', { language: 'go' }),
            mkComp('helper-ts', 'library', { language: 'typescript' }),
        ];
        const result = collapseToTopology(components, [], 'monolith', 'inventory', '/tmp/inventory', emptyHints);

        expect(result.services).toHaveLength(1);
        expect(result.services[0].component.language).toBe('go');
    });

    it('synthetic falls back to unknown when all components have unknown language', () => {
        const components = [mkComp('weird', 'library', { language: 'unknown' })];
        const result = collapseToTopology(components, [], 'monolith', 'inventory', '/tmp/inventory', emptyHints);

        expect(result.services).toHaveLength(1);
        expect(result.services[0].component.language).toBe('unknown');
    });
});
