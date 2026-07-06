/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-monorepo-apps-vs-libs
 *
 * Pins the runtime-vs-library classification in a TypeScript monorepo.
 *
 * Fixture topology:
 *   - apps/orders-api          → Dockerfile + scripts.start + NestFactory.create  → :Service
 *   - apps/notifications-worker → Dockerfile + scripts.start                       → :Service
 *   - libs/orders-domain       → pure exports, no scripts.start, no entrypoint     → :Library
 *   - libs/payment-validation  → pure exports, no scripts.start, no entrypoint     → :Library
 *
 * Asserts that:
 *   ✓ apps/* are classified as `type: 'service'` and go to the services bucket
 *   ✓ libs/* are classified as `type: 'library'` and go to the libraries bucket
 *   ✓ no workspace falls into pendingTriage (TS plugin signals always decide)
 *
 * Zero LLM, zero graph DB. Pure structural pipeline. Deterministic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    discoverAutoComponents,
} from '../../../../src/ingestion/extractors/autodiscovery.js';
import {
    collapseToTopology,
    type DiscoveredComponent,
    type TopologyResult,
} from '../../../../src/ingestion/topology-resolver.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — ts-monorepo-apps-vs-libs', () => {
    let components: DiscoveredComponent[];
    let topology: TopologyResult;
    let stagedRepo: string;

    beforeAll(async () => {
        // autodiscovery skips any path under tests/, fixtures/, etc. (NOISE_DIR_RE).
        // Stage the canonical fixture out of the tests tree so the scanner sees
        // it as a real repo.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-monorepo-eval-'));
        stagedRepo = path.join(tmp, 'orders-monorepo');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });

        const result = await discoverAutoComponents(
            [{ name: 'orders-monorepo', path: stagedRepo, org: 'acme' }],
            [],
        );
        components = result.components;
        topology = collapseToTopology(components, [], 'monorepo', 'orders-monorepo', '/tmp/orders-monorepo', {} as any);
    });

    afterAll(() => {
        if (stagedRepo) {
            const parent = path.dirname(stagedRepo);
            fs.rmSync(parent, { recursive: true, force: true });
        }
    });

    it('discovers four workspaces (2 apps + 2 libs)', () => {
        const names = components.map(c => c.name).sort();
        expect(names).toEqual(['notifications-worker', 'orders-api', 'orders-domain', 'payment-validation']);
    });

    it('apps/orders-api is classified as service', () => {
        const comp = components.find(c => c.name === 'orders-api')!;
        expect(comp.type).toBe('service');
    });

    it('apps/notifications-worker is classified as service', () => {
        const comp = components.find(c => c.name === 'notifications-worker')!;
        expect(comp.type).toBe('service');
    });

    it('libs/orders-domain is classified as library', () => {
        const comp = components.find(c => c.name === 'orders-domain')!;
        expect(comp.type).toBe('library');
    });

    it('libs/payment-validation is classified as library', () => {
        const comp = components.find(c => c.name === 'payment-validation')!;
        expect(comp.type).toBe('library');
    });

    it('topology services bucket contains exactly the two apps', () => {
        const names = topology.services.map(s => s.component.name).sort();
        expect(names).toEqual(['notifications-worker', 'orders-api']);
    });

    it('topology libraries bucket contains exactly the two libs', () => {
        const names = (topology.libraries ?? []).map(l => l.component.name).sort();
        expect(names).toEqual(['orders-domain', 'payment-validation']);
    });

    it('topology pendingTriage bucket is empty (TS plugin signals decide for all four)', () => {
        expect(topology.pendingTriage ?? []).toEqual([]);
    });
});
