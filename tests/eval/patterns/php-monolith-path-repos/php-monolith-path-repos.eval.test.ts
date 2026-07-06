/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-monolith-path-repos
 *
 * Real-world case: a legacy PHP monolith whose root composer.json VENDORS its
 * own sub-workspaces via Composer path repositories:
 *
 *   "repositories": [{ "type": "path", "url": "contexts/*" }],
 *   "require": { "acme/orders": "*", ... }
 *
 * Autodiscovery's child-wins pruning assumed every root manifest is workspace
 * tooling and dropped it; with other "runtime" components present (codeless
 * docker build contexts, a JS asset bundle with scripts.start) the synthetic
 * repo-as-Service fallback never fired either. Net effect on a real customer
 * monolith: NO Service node for the application, ~78% of files with
 * ownerService=None, the whole codebase invisible to the service-first
 * explorer.
 *
 * Three engine guarantees this test pins:
 *
 *   1. Monolith-root rescue: a root manifest whose local path dependencies
 *      cover at least one pruned child survives pruning and classifies via
 *      the normal runtime signals (public/index.php → service). The rescue
 *      fires even when decoy runtime components exist (the gap that killed
 *      the synthetic fallback).
 *
 *   2. Discrimination: the SAME tree without `repositories` is a true
 *      monorepo shape and the root stays pruned (child-wins intact).
 *
 *   3. Routing: longest-prefix ownership is preserved. The rescued root owns
 *      the loose application files; child workspaces (vendored libs, asset
 *      bundle) keep owning their own subtrees.
 *
 * Zero LLM, zero graph DB. Pure structural pipeline. Deterministic.
 *
 * Fixture: tests/eval/patterns/php-monolith-path-repos/fixture/
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    discoverAutoComponents,
    type DiscoveredService,
} from '../../../../src/ingestion/extractors/autodiscovery.js';
import {
    collapseToTopology,
    type DiscoveredComponent,
    type TopologyResult,
} from '../../../../src/ingestion/topology-resolver.js';
import { resolveOwnerService } from '../../../../src/ingestion/processors/code-pipeline/file-discovery.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-monolith-path-repos (monolith-root rescue)', () => {
    let tmp: string;
    let stagedRepo: string;
    let components: DiscoveredComponent[];
    let serviceRoots: DiscoveredService[];
    let topology: TopologyResult;

    beforeAll(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-monolith-path-repos-'));
        stagedRepo = path.join(tmp, 'inventory-app');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });

        const result = await discoverAutoComponents(
            [{ name: 'inventory-app', path: stagedRepo, org: 'acme' }],
            [],
        );
        components = result.components;
        serviceRoots = result.serviceRoots;
        topology = collapseToTopology(components, [], 'auto', 'inventory-app', stagedRepo, {} as any);
    });

    afterAll(() => {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('rescues the root as a runtime service component', () => {
        const root = components.find(c => c.catalogFile === stagedRepo);
        expect(root).toBeDefined();
        expect(root!.name).toBe('inventory-app');
        // public/index.php fires the PHP entrypoint signal: real runtime, not
        // a synthetic placeholder.
        expect(root!.type).toBe('service');
        expect(root!.source).toBe('autodiscovery');
        expect(root!.language).toBe('php');
    });

    it('keeps classifying the vendored path-repo workspaces as libraries', () => {
        const orders = components.find(c => c.name === 'orders');
        const shipping = components.find(c => c.name === 'shipping');
        expect(orders?.type).toBe('library');
        expect(shipping?.type).toBe('library');
    });

    it('rescues DESPITE decoy runtime components (docker context + asset bundle)', () => {
        // These two are exactly what made services.length > 0 and killed the
        // old synthetic fallback. The rescue must be independent of them.
        const decoyNames = components.filter(c => c.type === 'service').map(c => c.name).sort();
        expect(decoyNames).toContain('assets');
        expect(decoyNames).toContain('nginx');
        expect(decoyNames).toContain('inventory-app');
    });

    it('topology buckets the root as a Service and the vendored workspaces as Libraries', () => {
        const serviceNames = topology.services!.map(s => s.component.name).sort();
        const libraryNames = (topology.libraries ?? []).map(l => l.component.name).sort();
        expect(serviceNames).toContain('inventory-app');
        expect(libraryNames).toEqual(['orders', 'shipping']);
    });

    it('routes loose application files to the rescued root, child subtrees to their own roots', () => {
        const looseFile = path.join(stagedRepo, 'src/Inventory/StockService.php');
        expect(resolveOwnerService(looseFile, serviceRoots, stagedRepo)?.name).toBe('inventory-app');

        const assetFile = path.join(stagedRepo, 'assets/index.js');
        expect(resolveOwnerService(assetFile, serviceRoots, stagedRepo)?.name).toBe('assets');

        const vendoredFile = path.join(stagedRepo, 'contexts/orders/src/Order.php');
        expect(resolveOwnerService(vendoredFile, serviceRoots, stagedRepo)?.name).toBe('orders');
    });

    it('does NOT rescue the same tree without path repositories (negative control)', async () => {
        const controlRepo = path.join(tmp, 'inventory-monorepo');
        fs.cpSync(FIXTURE_DIR, controlRepo, { recursive: true });
        const manifestPath = path.join(controlRepo, 'composer.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        delete manifest.repositories;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));

        const control = await discoverAutoComponents(
            [{ name: 'inventory-monorepo', path: controlRepo, org: 'acme' }],
            [],
        );
        // Child-wins pruning intact: the root manifest stays dropped.
        expect(control.components.find(c => c.catalogFile === controlRepo)).toBeUndefined();
    });
});
