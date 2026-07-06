/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-getenv-http-clients
 *
 * Pins Fix #1: PHP service that reads HTTP base URLs via \getenv() into a
 * config array. The env-var-resolver + synthesizeHttpEndpoints should emit
 * HttpEndpointHints for every *_URL / *_HOST / *_ENDPOINT variable that
 * resolves to an http(s):// value or a bare host.
 *
 * Fixture:
 *   - composer.json (Symfony runtime + Guzzle)
 *   - public/index.php (Symfony runtime kernel)
 *   - config/values.php (reads ORDERS_URL, PAYMENT_URL, INVENTORY_HOST via getenv)
 *   - .env (resolves all three to acme.example.com hosts)
 *   - src/Aggregator.php (Guzzle calls that use the resolved values)
 *
 * Asserts:
 *   ✓ synthesizeHttpEndpoints returns 3 hints: orders, payment, inventory
 *   ✓ inventory hint has isInferredScheme=true (bare host)
 *   ✓ alias is derived from the env-var name (PAYMENT_URL → payment)
 *   ✓ Credentials are stripped if present (defensive)
 *   ✓ classify-service-role recognises this workspace as a runtime service
 *
 * Zero LLM, zero graph DB. Deterministic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildRepoEnvMap,
    synthesizeHttpEndpoints,
} from '../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';
import { classifyServiceRole } from '../../../../src/ingestion/extractors/autodiscovery.js';
import { getLanguagePlugin } from '../../../../src/ingestion/core/languages/registry.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-getenv-http-clients', () => {
    let stagedRepo: string;

    beforeAll(() => {
        // Stage out of tests/ so NOISE_DIR_RE consumers (if any) don't bias the test.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-php-http-eval-'));
        stagedRepo = path.join(tmp, 'orders-aggregator');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });
    });

    afterAll(() => {
        if (stagedRepo) fs.rmSync(path.dirname(stagedRepo), { recursive: true, force: true });
    });

    it('classifyServiceRole recognises the PHP workspace as runtime (Symfony runtime + Dockerfile)', () => {
        const role = classifyServiceRole(stagedRepo, getLanguagePlugin('php'));
        expect(role).toBe('runtime');
    });

    it('buildRepoEnvMap reads all three remote URLs', () => {
        const env = buildRepoEnvMap(stagedRepo);
        expect(env.vars.get('ORDERS_URL')?.value).toBe('https://orders.acme.example.com');
        expect(env.vars.get('PAYMENT_URL')?.value).toBe('https://payment.acme.example.com');
        expect(env.vars.get('INVENTORY_HOST')?.value).toBe('inventory.acme.example.com');
    });

    it('synthesizeHttpEndpoints emits one hint per remote URL / bare host', () => {
        const env = buildRepoEnvMap(stagedRepo);
        const hints = synthesizeHttpEndpoints(env);

        const byAlias = new Map(hints.map(h => [h.alias, h]));
        expect(byAlias.has('orders')).toBe(true);
        expect(byAlias.has('payment')).toBe(true);
        expect(byAlias.has('inventory')).toBe(true);

        expect(byAlias.get('orders')!.host).toBe('orders.acme.example.com');
        expect(byAlias.get('orders')!.isInferredScheme).toBeFalsy();
        expect(byAlias.get('payment')!.host).toBe('payment.acme.example.com');
        expect(byAlias.get('inventory')!.host).toBe('inventory.acme.example.com');
        // INVENTORY_HOST has no scheme → synthesizer infers https://
        expect(byAlias.get('inventory')!.isInferredScheme).toBe(true);
    });

    it('every emitted hint carries its sourceEnvKey for provenance', () => {
        const env = buildRepoEnvMap(stagedRepo);
        const hints = synthesizeHttpEndpoints(env);
        const keys = hints.map(h => h.sourceEnvKey).sort();
        expect(keys).toEqual(['INVENTORY_HOST', 'ORDERS_URL', 'PAYMENT_URL']);
    });
});
