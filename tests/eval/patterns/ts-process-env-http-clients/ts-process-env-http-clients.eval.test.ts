/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-process-env-http-clients
 *
 * Pins Fix #1 on TypeScript: a workspace that reads HTTP base URLs via
 * `process.env.X`. The env-var-resolver + synthesizeHttpEndpoints must
 * surface every remote URL/host into an HttpEndpointHint.
 *
 * Fixture:
 *   - root: package.json + tsconfig.json (TS monorepo)
 *   - apps/orders-aggregator/: scripts.start + Dockerfile, the only Service
 *   - apps/orders-aggregator/.env: 4 remote URLs (URL, BASE_URL, HOST with port, ENDPOINT)
 *   - apps/orders-aggregator/src/OrderAggregator.ts: process.env.{ORDERS_URL,...}
 *
 * Asserts:
 *   ✓ Per-service buildRepoEnvMap(serviceRoot) picks up the 4 remote vars
 *   ✓ synthesizeHttpEndpoints emits 4 hints, deduplicated, with the right
 *     alias and port for INVENTORY_HOST.
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

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — ts-process-env-http-clients', () => {
    let stagedRepo: string;

    beforeAll(() => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ts-http-eval-'));
        stagedRepo = path.join(tmp, 'orders-monorepo');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });
    });

    afterAll(() => {
        if (stagedRepo) fs.rmSync(path.dirname(stagedRepo), { recursive: true, force: true });
    });

    it('per-service env-map captures only the service-local .env, with priority', () => {
        const serviceRoot = path.join(stagedRepo, 'apps', 'orders-aggregator');
        const env = buildRepoEnvMap(stagedRepo, { serviceRoot });
        expect(env.vars.get('ORDERS_URL')?.value).toBe('https://orders.acme.example.com');
        expect(env.vars.get('PAYMENT_BASE_URL')?.value).toBe('https://payment.acme.example.com/v1');
        expect(env.vars.get('INVENTORY_HOST')?.value).toBe('inventory.acme.example.com:8081');
        expect(env.vars.get('NOTIFICATIONS_ENDPOINT')?.value).toBe('https://notifications.acme.example.com');
    });

    it('synthesizeHttpEndpoints emits 4 hints (orders, payment, inventory, notifications)', () => {
        const serviceRoot = path.join(stagedRepo, 'apps', 'orders-aggregator');
        const env = buildRepoEnvMap(stagedRepo, { serviceRoot });
        const hints = synthesizeHttpEndpoints(env);
        const byAlias = new Map(hints.map(h => [h.alias, h]));
        expect(byAlias.size).toBe(4);
        expect(byAlias.has('orders')).toBe(true);
        expect(byAlias.has('payment')).toBe(true);
        expect(byAlias.has('inventory')).toBe(true);
        expect(byAlias.has('notifications')).toBe(true);
    });

    it('INVENTORY_HOST: bare host + explicit port → captured, isInferredScheme=true', () => {
        const serviceRoot = path.join(stagedRepo, 'apps', 'orders-aggregator');
        const hints = synthesizeHttpEndpoints(buildRepoEnvMap(stagedRepo, { serviceRoot }));
        const inv = hints.find(h => h.alias === 'inventory')!;
        expect(inv.host).toBe('inventory.acme.example.com');
        expect(inv.port).toBe(8081);
        expect(inv.isInferredScheme).toBe(true);
    });

    it('PAYMENT_BASE_URL alias derives correctly (drops trailing _BASE_URL)', () => {
        const serviceRoot = path.join(stagedRepo, 'apps', 'orders-aggregator');
        const hints = synthesizeHttpEndpoints(buildRepoEnvMap(stagedRepo, { serviceRoot }));
        const p = hints.find(h => h.sourceEnvKey === 'PAYMENT_BASE_URL')!;
        expect(p.alias).toBe('payment');
    });
});
