import { describe, expect, it } from 'vitest';
import { collapseToTopology, type DiscoveredComponent } from '../../../src/ingestion/topology-resolver';

function mkComp(name: string, type: string | undefined, catalogFile = `/repo/${name}`): DiscoveredComponent {
    return { name, type, catalogFile, source: 'autodiscovery' };
}

describe('collapseToTopology — type-based bucketing', () => {
    it('monorepo: type=service → services, type=library → libraries, type=undefined → pendingTriage', () => {
        const components = [
            mkComp('orders-api', 'service'),
            mkComp('notifications-worker', 'service'),
            mkComp('orders-domain', 'library'),
            mkComp('payment-validation', 'library'),
            mkComp('mystery-tool', undefined),
        ];
        const result = collapseToTopology(components, [], 'monorepo', 'repo', '/tmp/repo', {} as any);
        expect(result.services.map(s => s.component.name).sort())
            .toEqual(['notifications-worker', 'orders-api']);
        expect(result.libraries?.map(l => l.component.name).sort())
            .toEqual(['orders-domain', 'payment-validation']);
        expect(result.pendingTriage?.map(p => p.name).sort())
            .toEqual(['mystery-tool']);
    });

    it('monorepo with only runtime services → empty libraries and pendingTriage arrays (or undefined)', () => {
        const components = [
            mkComp('orders-api', 'service'),
            mkComp('notifications-worker', 'service'),
        ];
        const result = collapseToTopology(components, [], 'monorepo', 'repo', '/tmp/repo', {} as any);
        expect(result.services).toHaveLength(2);
        expect(result.libraries ?? []).toHaveLength(0);
        expect(result.pendingTriage ?? []).toHaveLength(0);
    });

    it('library components do NOT receive ServiceEntry dependency classification', () => {
        const components = [
            mkComp('orders-domain', 'library'),
        ];
        components[0].dependsOn = ['some-other-component'];
        const result = collapseToTopology(components, [], 'monorepo', 'repo', '/tmp/repo', {} as any);
        expect(result.services).toHaveLength(0);
        expect(result.libraries).toHaveLength(1);
        expect(result.libraries![0].component.name).toBe('orders-domain');
    });
});
