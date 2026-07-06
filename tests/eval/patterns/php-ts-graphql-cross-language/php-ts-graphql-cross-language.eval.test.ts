/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-ts-graphql-cross-language
 *
 * Cross-language case: a PHP service calls a GraphQL operation hosted by a
 * TypeScript NestJS provider. This is the structural shape that drove Fix #2
 * (PHP caller emits emergent GraphQL endpoints; TS provider hosts the SDL).
 *
 * Fixture topology (two separate repos, treated independently by autodiscovery):
 *   ts-provider/apps/orders-api    → :Service + role 'graphql-server' (NestJS GraphQLModule.forRoot)
 *   php-caller                     → :Service (Symfony runtime), NO 'graphql-server' role
 *
 * Asserts that:
 *   ✓ TS provider gets 'graphql-server' role
 *   ✓ PHP caller is classified as service (Dockerfile + symfony/runtime dep marker)
 *   ✓ PHP caller does NOT get 'graphql-server' role (it consumes, does not host)
 *
 * Zero LLM, zero graph DB. Structural classification only. Deterministic.
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
import type { DiscoveredComponent } from '../../../../src/ingestion/topology-resolver.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-ts-graphql-cross-language', () => {
    let tsComponents: DiscoveredComponent[];
    let tsServiceRoots: DiscoveredService[];
    let phpComponents: DiscoveredComponent[];
    let phpServiceRoots: DiscoveredService[];
    let stagedTs: string;
    let stagedPhp: string;

    beforeAll(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cross-eval-'));
        stagedTs = path.join(tmp, 'ts-provider');
        stagedPhp = path.join(tmp, 'php-caller');
        fs.cpSync(path.join(FIXTURE_DIR, 'ts-provider'), stagedTs, { recursive: true });
        fs.cpSync(path.join(FIXTURE_DIR, 'php-caller'), stagedPhp, { recursive: true });

        const tsResult = await discoverAutoComponents(
            [{ name: 'ts-provider', path: stagedTs, org: 'acme' }],
            [],
        );
        tsComponents = tsResult.components;
        tsServiceRoots = tsResult.serviceRoots;

        const phpResult = await discoverAutoComponents(
            [{ name: 'php-caller', path: stagedPhp, org: 'acme' }],
            [],
        );
        phpComponents = phpResult.components;
        phpServiceRoots = phpResult.serviceRoots;
    });

    afterAll(() => {
        if (stagedTs) fs.rmSync(path.dirname(stagedTs), { recursive: true, force: true });
    });

    // ─── TS provider side ───────────────────────────────────────────────────

    it('ts-provider discovers orders-api', () => {
        expect(tsComponents.map(c => c.name)).toContain('orders-api');
    });

    it('orders-api → type=service', () => {
        const comp = tsComponents.find(c => c.name === 'orders-api')!;
        expect(comp.type).toBe('service');
    });

    it('orders-api → frameworkRoles includes graphql-server', () => {
        const svc = tsServiceRoots.find(s => s.name === 'orders-api')!;
        expect(svc.frameworkRoles?.has('graphql-server')).toBe(true);
    });

    // ─── PHP caller side ────────────────────────────────────────────────────

    it('php-caller discovers the aggregator workspace', () => {
        expect(phpComponents.map(c => c.name).sort()).toContain('php-caller');
    });

    it('php-caller → type=service (Symfony runtime + Dockerfile)', () => {
        // The discovered component sits at the repo root (composer.json is the manifest).
        const comp = phpComponents.find(c => c.name === 'php-caller')!;
        expect(comp.type).toBe('service');
    });

    it('php-caller → frameworkRoles does NOT include graphql-server (caller, not host)', () => {
        const svc = phpServiceRoots.find(s => s.name === 'php-caller')!;
        expect(svc.frameworkRoles?.has('graphql-server') ?? false).toBe(false);
    });
});
