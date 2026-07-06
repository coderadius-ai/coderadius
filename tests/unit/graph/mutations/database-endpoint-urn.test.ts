/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit — DatabaseEndpoint identity (S1.1 Part D, logical/physical split)
 *
 * Pins the paradigm-A identity rules for the physical `:DatabaseEndpoint` node:
 *
 *   - `computeEndpointKey(host, port, dbName)` is the stable cross-repo physical
 *     fingerprint: deterministic, 16-hex, case-insensitive on host/dbName. Two
 *     repos pointing at the same host:port/dbName MUST produce the same key
 *     (cross-repo convergence). Different host/port/dbName MUST differ.
 *
 *   - `buildDatabaseEndpointUrn(endpointKey, environment)` appends the
 *     environment as an explicit URN segment so the SAME physical endpointKey
 *     observed in two environments yields two DISTINCT nodes (anti-collision
 *     dev↔prod), while keeping the physical fingerprint stable for convergence
 *     within one environment.
 *
 * Pure functions. No graph, no LLM. Deterministic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import { buildDatabaseEndpointUrn } from '../../../../src/graph/mutations/data-contracts.js';
import { computeEndpointKey } from '../../../../src/ingestion/processors/db-scope-resolver.js';

describe('computeEndpointKey — physical fingerprint', () => {
    it('is deterministic for the same (host, port, dbName)', () => {
        const a = computeEndpointKey('mysql-prod.acme.internal', 3306, 'orders');
        const b = computeEndpointKey('mysql-prod.acme.internal', 3306, 'orders');
        expect(a).toBe(b);
    });

    it('produces a 16-char hex fingerprint', () => {
        const key = computeEndpointKey('mysql-prod.acme.internal', 3306, 'orders');
        expect(key).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is case-insensitive on host and dbName (cross-repo convergence)', () => {
        const lower = computeEndpointKey('mysql-prod.acme.internal', 3306, 'orders');
        const upper = computeEndpointKey('MySQL-Prod.ACME.internal', 3306, 'Orders');
        expect(lower).toBe(upper);
    });

    it('differs when host, port, or dbName differ', () => {
        const base = computeEndpointKey('mysql-prod.acme.internal', 3306, 'orders');
        expect(computeEndpointKey('mysql-stg.acme.internal', 3306, 'orders')).not.toBe(base);
        expect(computeEndpointKey('mysql-prod.acme.internal', 3307, 'orders')).not.toBe(base);
        expect(computeEndpointKey('mysql-prod.acme.internal', 3306, 'payments')).not.toBe(base);
    });
});

describe('buildDatabaseEndpointUrn — physical identity with environment', () => {
    const KEY = computeEndpointKey('mysql-prod.acme.internal', 3306, 'orders');

    it('namespaces under cr:dbendpoint and carries the endpointKey', () => {
        const urn = buildDatabaseEndpointUrn(KEY, 'production');
        expect(urn.startsWith('cr:dbendpoint:')).toBe(true);
        expect(urn).toContain(KEY);
    });

    it('appends the environment as an explicit URN segment', () => {
        const urn = buildDatabaseEndpointUrn(KEY, 'production');
        expect(urn.endsWith(':production')).toBe(true);
    });

    it('SAME endpointKey in two environments yields two distinct nodes (anti-collision)', () => {
        const prod = buildDatabaseEndpointUrn(KEY, 'production');
        const stg = buildDatabaseEndpointUrn(KEY, 'staging');
        expect(prod).not.toBe(stg);
    });

    it('SAME (endpointKey, environment) is stable (cross-repo convergence within an env)', () => {
        const a = buildDatabaseEndpointUrn(KEY, 'production');
        const b = buildDatabaseEndpointUrn(KEY, 'production');
        expect(a).toBe(b);
    });

    it('different endpointKeys never collide regardless of environment', () => {
        const otherKey = computeEndpointKey('mongo-prod.acme.internal', 27017, 'orders');
        expect(buildDatabaseEndpointUrn(KEY, 'production'))
            .not.toBe(buildDatabaseEndpointUrn(otherKey, 'production'));
    });
});
