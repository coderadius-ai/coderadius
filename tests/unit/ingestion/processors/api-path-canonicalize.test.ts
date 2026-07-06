/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit — canonicalizeApiPathForDedup (S2.1a, APIEndpoint dedup pivot)
 *
 * `normalizeApiPathLossless` is the STORAGE form: it preserves LLM-extracted
 * variable names ({trackingId}) and has 6 callers that depend on that. It is
 * NOT a dedup key: `/users/123`, `/users/{id}`, `/users/:id`, `/users/${id}`
 * all normalise to DISTINCT strings, so string-equality dedup silently keeps
 * the duplicates (the R4 risk).
 *
 * `canonicalizeApiPathForDedup` is the purpose-built dedup KEY: every
 * parameter syntax AND every concrete id literal collapses to `{param}`, and
 * static segments are case-folded. It NEVER feeds storage — only the dedup map.
 *
 * Conservative on ambiguous literals: pure digits, dashed UUIDs, and long hex
 * (>=24, e.g. Mongo ObjectId / SHA) collapse; short hex and ULID-ish tokens do
 * NOT (they are indistinguishable from real route words like `me`, `active`).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import { canonicalizeApiPathForDedup } from '../../../../src/ingestion/processors/api-path-utils.js';

describe('canonicalizeApiPathForDedup — parameter syntaxes collapse to {param}', () => {
    const PARAM_CASES: Array<[string, string]> = [
        ['/api/users/{userId}', '/api/users/{param}'],     // OpenAPI
        ['/api/users/:userId', '/api/users/{param}'],      // Express/Fastify
        ['/api/users/${userId}', '/api/users/{param}'],    // JS template
        ['/api/users/$userId', '/api/users/{param}'],      // PHP variable
        ['/api/users/{$userId}', '/api/users/{param}'],    // PHP interpolation
        ['/api/users/user-${id}', '/api/users/{param}'],   // embedded template
    ];
    it.each(PARAM_CASES)('%s → %s', (input, expected) => {
        expect(canonicalizeApiPathForDedup(input)).toBe(expected);
    });
});

describe('canonicalizeApiPathForDedup — concrete id literals collapse to {param}', () => {
    const LITERAL_CASES: Array<[string, string]> = [
        ['/api/users/123', '/api/users/{param}'],                                       // numeric
        ['/api/users/123/orders/456', '/api/users/{param}/orders/{param}'],             // multi numeric
        ['/api/orders/550e8400-e29b-41d4-a716-446655440000', '/api/orders/{param}'],    // UUID
        ['/api/orders/507f1f77bcf86cd799439011', '/api/orders/{param}'],                // Mongo ObjectId (24 hex)
    ];
    it.each(LITERAL_CASES)('%s → %s', (input, expected) => {
        expect(canonicalizeApiPathForDedup(input)).toBe(expected);
    });
});

describe('canonicalizeApiPathForDedup — all four forms of the same endpoint collapse identically', () => {
    it('numeric, {id}, :id, ${id} all map to one key', () => {
        const forms = [
            '/api/users/123',
            '/api/users/{id}',
            '/api/users/:id',
            '/api/users/${userId}',
        ];
        const keys = new Set(forms.map(canonicalizeApiPathForDedup));
        expect(keys.size).toBe(1);
        expect([...keys][0]).toBe('/api/users/{param}');
    });
});

describe('canonicalizeApiPathForDedup — case folding on static segments', () => {
    const CASE_CASES: Array<[string, string]> = [
        ['/api/Auto/Marca', '/api/auto/marca'],
        ['/API/Users/{ID}', '/api/users/{param}'],
        ['/api/v2/Users/{id}/Posts/789', '/api/v2/users/{param}/posts/{param}'],
    ];
    it.each(CASE_CASES)('%s → %s', (input, expected) => {
        expect(canonicalizeApiPathForDedup(input)).toBe(expected);
    });
});

describe('canonicalizeApiPathForDedup — does NOT over-collapse real route words', () => {
    const KEEP_CASES: Array<[string, string]> = [
        ['/api/v1/health', '/api/v1/health'],          // version segment kept
        ['/api/users/me', '/api/users/me'],            // word kept
        ['/api/users/active', '/api/users/active'],    // word kept
        ['/api/status/abc123', '/api/status/abc123'],  // short alnum kept (not pure digit / not >=24 hex)
        ['/api/cafe', '/api/cafe'],                    // 4-hex word kept
        ['/', '/'],                                    // root
        ['/health', '/health'],                        // single static
    ];
    it.each(KEEP_CASES)('%s → %s', (input, expected) => {
        expect(canonicalizeApiPathForDedup(input)).toBe(expected);
    });
});

describe('canonicalizeApiPathForDedup — structural invariants', () => {
    it('preserves segment count (no collapsing of distinct routes)', () => {
        expect(canonicalizeApiPathForDedup('/a/123')).not.toBe(canonicalizeApiPathForDedup('/a/123/b'));
    });

    it('keeps distinct static prefixes distinct (no false dedup across resources)', () => {
        // /api/users/{id} and /api/orders/{id} must NOT collapse together.
        expect(canonicalizeApiPathForDedup('/api/users/123'))
            .not.toBe(canonicalizeApiPathForDedup('/api/orders/123'));
    });

    it('passes GraphQL sentinel paths through untouched', () => {
        expect(canonicalizeApiPathForDedup('GRAPHQL:query:getUser')).toBe('GRAPHQL:query:getUser');
    });

    it('normalises duplicate and trailing slashes', () => {
        expect(canonicalizeApiPathForDedup('/api//users/123/')).toBe('/api/users/{param}');
    });
});
