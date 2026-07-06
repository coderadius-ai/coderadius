import { describe, it, expect } from 'vitest';
import {
    resolveCatalogServiceTarget,
    type DiscoveredComponent,
    type ServiceEntry,
} from '../../../src/ingestion/topology-resolver.js';

// ── resolveCatalogServiceTarget ──────────────────────────────────────────────
// ONE resolution chain for every CatalogEntity. A primary Component and its
// partOf siblings go through the same function; what differs is which step of
// the chain resolves, driven by what the catalog declares:
//   1. identity — a Service was welded from this entity (catalogName) or shares its name
//   2. partOf   — the entity declares containment in a sibling; the sibling's Service anchors it
//   3. null     — no grounded key; the caller anchors to the Repository instead

const service = (name: string, catalogName?: string): ServiceEntry => ({
    component: { name, catalogName, catalogFile: '/repo', source: 'backstage' },
    deploymentUnits: [],
    internalDeps: [],
    externalDeps: [],
});

const entity = (name: string, partOf?: string[]): DiscoveredComponent => ({
    name,
    catalogFile: '/repo/catalog-info.yaml',
    source: 'backstage',
    catalogMeta: {
        kind: 'Component',
        namespace: 'default',
        entityRef: `component:default/${name}`,
        partOf,
    },
});

describe('resolveCatalogServiceTarget', () => {
    it('resolves by identity when a Service was welded from this entity (catalogName)', () => {
        const services = [service('inventory', 'inventory-service')];
        const target = resolveCatalogServiceTarget(entity('inventory-service'), services);
        expect(target).toEqual({ serviceName: 'inventory', matchedBy: 'identity' });
    });

    it('resolves by identity when a Service shares the entity name', () => {
        const services = [service('inventory')];
        const target = resolveCatalogServiceTarget(entity('inventory'), services);
        expect(target).toEqual({ serviceName: 'inventory', matchedBy: 'identity' });
    });

    it('resolves a worker entity to its parent Service via declared partOf', () => {
        const services = [service('inventory', 'inventory-service')];
        const worker = entity('inventory-consumers', ['inventory-service']);
        const target = resolveCatalogServiceTarget(worker, services);
        expect(target).toEqual({ serviceName: 'inventory', matchedBy: 'partOf' });
    });

    it('identity wins over partOf when both could resolve', () => {
        const services = [service('inventory-consumers'), service('inventory', 'inventory-service')];
        const worker = entity('inventory-consumers', ['inventory-service']);
        const target = resolveCatalogServiceTarget(worker, services);
        expect(target).toEqual({ serviceName: 'inventory-consumers', matchedBy: 'identity' });
    });

    it('multiple partOf refs converging on the SAME Service still resolve', () => {
        const services = [service('inventory', 'inventory-service')];
        const worker = entity('inventory-consumers', ['inventory-service', 'inventory']);
        const target = resolveCatalogServiceTarget(worker, services);
        expect(target).toEqual({ serviceName: 'inventory', matchedBy: 'partOf' });
    });

    it('partOf refs resolving to DIFFERENT Services are ambiguous → null (no guessing)', () => {
        const services = [service('inventory', 'inventory-service'), service('orders', 'orders-service')];
        const worker = entity('shared-consumers', ['inventory-service', 'orders-service']);
        expect(resolveCatalogServiceTarget(worker, services)).toBeNull();
    });

    it('partOf ref that matches no Service → null (Repository fallback, not fabricated)', () => {
        const services = [service('inventory', 'inventory-service')];
        const worker = entity('payment-consumers', ['payment-service']);
        expect(resolveCatalogServiceTarget(worker, services)).toBeNull();
    });

    it('no identity match and no partOf → null', () => {
        const services = [service('inventory', 'inventory-service')];
        expect(resolveCatalogServiceTarget(entity('unrelated'), services)).toBeNull();
    });
});
