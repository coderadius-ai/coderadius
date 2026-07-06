// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — backstage-multidoc-partof (one resolution chain for every entity)
//
// A multi-doc catalog-info.yaml declares a primary Component (type: service)
// and a worker Component (type: worker, partOf: the primary) in the SAME
// directory. Identity welding promotes only the primary into the :Service;
// the worker survives as a CatalogEntity. Before this fix the worker fell
// back to DESCRIBES->Repository, losing its declared containment.
//
// Pins the cross-step chain: catalog YAML → Backstage extractor (partOf
// normalized to bare names, excluded from the residual specJson) →
// weldIdentities (primary selection) → collapseToTopology →
// resolveCatalogServiceTarget. The SAME chain resolves both entities: the
// primary at step 1 (identity), the worker at step 2 (partOf). The difference
// is in what the catalog declares, not in the code path.
//
// Deterministic, zero LLM, DB-free (the graph write half is pinned at the
// integration tier: tests/integration/topology-catalog-service-link).
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverBackstageComponents } from '../../../../src/ingestion/extractors/backstage-extractor.js';
import { discoverAutoComponents } from '../../../../src/ingestion/extractors/autodiscovery.js';
import {
    collapseToTopology,
    resolveCatalogServiceTarget,
    weldIdentities,
    type DiscoveredComponent,
    type TopologyResult,
} from '../../../../src/ingestion/topology-resolver.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — backstage-multidoc-partof', () => {
    let catalogComponents: DiscoveredComponent[];
    let topology: TopologyResult;
    let stagedRepo: string;

    beforeAll(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-multidoc-partof-'));
        stagedRepo = path.join(tmp, 'inventory');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });

        const repo = { name: 'inventory', path: stagedRepo, org: 'acme' };
        const backstage = await discoverBackstageComponents([repo]);
        catalogComponents = backstage.components;

        const auto = await discoverAutoComponents([repo], []);
        const weld = weldIdentities(catalogComponents, auto.components, stagedRepo, 'inventory', {});
        topology = collapseToTopology(
            weld.components, backstage.auxiliaryEntities, 'auto',
            'inventory', stagedRepo, {} as never, weld.allCatalogComponents,
        );
    });

    afterAll(() => {
        if (stagedRepo) fs.rmSync(path.dirname(stagedRepo), { recursive: true, force: true });
    });

    it('extractor normalizes partOf to bare names and keeps it out of the residual specJson', () => {
        const worker = catalogComponents.find(c => c.name === 'inventory-consumers');
        expect(worker?.catalogMeta?.partOf).toEqual(['inventory-service']);
        expect(worker?.catalogMeta?.specJson ?? '').not.toContain('partOf');
    });

    it('welding promotes only the primary Component into the Service; the worker survives as catalog entity', () => {
        expect(topology.services).toHaveLength(1);
        expect(topology.services[0].component.name).toBe('inventory');
        expect(topology.services[0].component.catalogName).toBe('inventory-service');
        expect(topology.catalogEntities?.map(c => c.name).sort())
            .toEqual(['inventory-consumers', 'inventory-service']);
    });

    it('the SAME resolution chain anchors both entities to the Service (identity vs partOf)', () => {
        const primary = topology.catalogEntities!.find(c => c.name === 'inventory-service')!;
        const worker = topology.catalogEntities!.find(c => c.name === 'inventory-consumers')!;

        expect(resolveCatalogServiceTarget(primary, topology.services))
            .toEqual({ serviceName: 'inventory', matchedBy: 'identity' });
        expect(resolveCatalogServiceTarget(worker, topology.services))
            .toEqual({ serviceName: 'inventory', matchedBy: 'partOf' });
    });
});
