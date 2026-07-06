// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — catalog-drift-grounding (declared-ref → drift identity contract)
//
// Grounded drift resolves a declared `dependsOn` ref to a real graph node by
// EXACT name (node.catalogName / node.name), no string normalization at compare
// time. That only works if the catalog extractor emits BARE names. This pins the
// catalog-parse half of the cross-file chain: a real catalog-info.yaml, through
// the Backstage extractor, yields exactly the ref strings the drift resolver
// matches against. If the extractor ever kept the `kind:ns/` prefix, drift would
// silently resolve nothing and over-report "unverifiable" — caught here.
//
// The graph -> drift half (aligned / grounded-drift / unverifiable / score) is
// pinned at the integration tier (tests/integration/catalog-drift-grounding).
//
// Deterministic, zero LLM, DB-free (the eval harness has no Memgraph).
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { discoverBackstageComponents } from '../../../../src/ingestion/extractors/backstage-extractor.js';
import type { DiscoveredComponent } from '../../../../src/ingestion/extractors/backstage-extractor.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — catalog-drift-grounding', () => {
    let inventory: DiscoveredComponent;

    beforeAll(async () => {
        const result = await discoverBackstageComponents([
            { name: 'acme/inventory', path: FIXTURE_DIR },
        ]);
        const found = result.components.find(c => c.name === 'inventory');
        expect(found, 'inventory Component should be discovered').toBeDefined();
        inventory = found!;
    });

    it('emits dependsOn as BARE names (the exact strings drift resolves by)', () => {
        // component:default/orders -> orders, resource:default/acme-postgres ->
        // acme-postgres, payment -> payment. These match node.catalogName/name.
        expect(inventory.dependsOn).toEqual(['orders', 'acme-postgres', 'payment']);
    });

    it('parses provides/consumes APIs to bare names (kept off drift, per design)', () => {
        // APIs have no grounded key (no spec.definition/URL), so they are NOT a
        // drift dimension. We still verify the extractor normalizes them, so the
        // dimension can be re-introduced cleanly when a grounded key exists.
        expect(inventory.catalogMeta?.providesApis).toEqual(['inventory-api']);
        expect(inventory.catalogMeta?.consumesApis).toEqual(['orders-api']);
    });
});
