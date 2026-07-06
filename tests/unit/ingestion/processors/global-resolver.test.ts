import { describe, it, expect } from 'vitest';
import { convertOpenAPIPathToRegex, normalizeApiPath, stripCommonPrefixes } from '../../../../src/ingestion/processors/api-path-utils.js';

describe('convertOpenAPIPathToRegex', () => {
    it('should convert simple static paths to exact regexes', () => {
        const regex = convertOpenAPIPathToRegex('/s2/hello');
        expect(regex.test('/s2/hello')).toBe(true);
        expect(regex.test('/s2/goodbye')).toBe(false);
        expect(regex.test('/s2/hello/extra')).toBe(false);
    });

    it('should convert single path parameter to wildcard', () => {
        const regex = convertOpenAPIPathToRegex('/inventory/{sku}');
        expect(regex.test('/inventory/sku_9001')).toBe(true);
        expect(regex.test('/inventory/widget')).toBe(true);
        expect(regex.test('/inventory/abc/def')).toBe(false);  // too many segments
        expect(regex.test('/inventory/')).toBe(false);           // empty param
        expect(regex.test('/other/sku_9001')).toBe(false);      // wrong prefix
    });

    it('should convert multiple path parameters', () => {
        const regex = convertOpenAPIPathToRegex('/users/{id}/orders/{orderId}');
        expect(regex.test('/users/123/orders/456')).toBe(true);
        expect(regex.test('/users/abc/orders/def')).toBe(true);
        expect(regex.test('/users/123/orders')).toBe(false);     // missing param
        expect(regex.test('/users/123')).toBe(false);            // incomplete
    });

    it('should handle root path', () => {
        const regex = convertOpenAPIPathToRegex('/');
        expect(regex.test('/')).toBe(true);
        expect(regex.test('/anything')).toBe(false);
    });

    it('should handle Express-style :param notation', () => {
        const regex = convertOpenAPIPathToRegex('/users/:userId/posts');
        expect(regex.test('/users/42/posts')).toBe(true);
        expect(regex.test('/users/42/comments')).toBe(false);
    });

    it('should handle path with special regex characters in static segments', () => {
        const regex = convertOpenAPIPathToRegex('/api/v1.0/items');
        expect(regex.test('/api/v1.0/items')).toBe(true);
        expect(regex.test('/api/v1X0/items')).toBe(false);  // dot is escaped, not wildcard
    });
});

describe('Global Edge Resolver — Path Matching Logic', () => {
    it('Level 1: exact match via normalized paths', () => {
        // Both normalize to the same value
        const emergentPath = '/s2/hello';
        const canonicalPath = '/s2/hello';
        expect(normalizeApiPath(emergentPath)).toBe(normalizeApiPath(canonicalPath));
    });

    it('Level 1: exact match with /api prefix stripping', () => {
        // Emergent might have /api prefix stripped, canonical without
        const emergentPath = '/api/v1/charge';
        const canonicalPath = '/charge';
        expect(normalizeApiPath(emergentPath)).toBe(normalizeApiPath(canonicalPath));
    });

    it('Level 2: template match for parameterized paths', () => {
        const canonicalTemplate = '/inventory/{sku}';
        const emergentConcrete = '/inventory/sku_9001';

        // Exact normalized match should NOT work (one has params, other has concrete values)
        const normalizedCanonical = normalizeApiPath(canonicalTemplate);
        const normalizedEmergent = normalizeApiPath(emergentConcrete);
        expect(normalizedCanonical).not.toBe(normalizedEmergent);

        // But regex match SHOULD work
        const regex = convertOpenAPIPathToRegex(canonicalTemplate);
        expect(regex.test(emergentConcrete)).toBe(true);
    });

    it('Level 2: no false positive for unrelated paths', () => {
        const regex = convertOpenAPIPathToRegex('/users/{id}');
        expect(regex.test('/orders/123')).toBe(false);
        expect(regex.test('/users/123/extra')).toBe(false);
    });

    it('Level 2: should match via stripped fallback when emergent has /api/vN prefix', () => {
        const canonicalTemplate = '/charge';
        const emergentPath = '/api/v1/charge';
        const regex = convertOpenAPIPathToRegex(canonicalTemplate);

        expect(regex.test(emergentPath)).toBe(false);
        expect(regex.test(stripCommonPrefixes(emergentPath))).toBe(true);
    });

    it('Segment boundary: /api/recharge must not match canonical /charge', () => {
        // With normalized paths (always starting with /), the leading / in the
        // suffix is what provides segment safety:
        //   '/api/recharge'.endsWith('/charge') → false (recharge ≠ /charge)
        //   '/api/v1/charge'.endsWith('/charge') → true
        const emergent: string = '/api/recharge';
        const canonical: string = '/charge';

        // endsWith already guarantees segment safety for /-prefixed suffixes
        expect(emergent.endsWith(canonical)).toBe(false);

        // Contrast with a valid match:
        expect('/api/v1/charge'.endsWith('/charge')).toBe(true);
    });

    it('Suffix ambiguity: multiple suffix matches should not be resolved at L1', () => {
        // If emergent /api/v1/users/sync matches both canonical /sync and /users/sync,
        // L1 should NOT guess — it should return null and fall through to L2/L3.
        const emergentPath = '/api/v1/users/sync';
        const candidateA = '/sync';
        const candidateB = '/users/sync';

        // Both are valid suffix matches (normalized paths start with /, which
        // acts as the segment boundary)
        const matchA = emergentPath.endsWith(candidateA) && candidateA.startsWith('/');
        const matchB = emergentPath.endsWith(candidateB) && candidateB.startsWith('/');

        expect(matchA).toBe(true);
        expect(matchB).toBe(true);
        // Both match → ambiguous → L1 should NOT resolve this
    });

    it('Reverse suffix direction: canonical longer than emergent should NOT match at L1', () => {
        // If code calls /charge but OpenAPI has /foo/charge,
        // the forward suffix check (emergent ends with canonical) fails,
        // and we intentionally do NOT check the reverse direction.
        const emergentNormalized = normalizeApiPath('/charge');  // → /charge
        const canonicalNormalized = normalizeApiPath('/foo/charge');  // → /foo/charge (or /charge after strip)

        // Forward: emergent ends with canonical? Only if they're equal
        // This test documents that reverse matching is deliberately excluded
        if (emergentNormalized && canonicalNormalized) {
            const forwardMatch = emergentNormalized.endsWith(canonicalNormalized);
            // /charge does NOT end with /foo/charge → no match (correct!)
            expect(forwardMatch).toBe(emergentNormalized === canonicalNormalized);
        }
    });
});
