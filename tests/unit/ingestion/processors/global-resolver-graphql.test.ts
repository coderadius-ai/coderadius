/**
 * @file global-resolver-graphql.test.ts
 * Tests for the GraphQL-aware path utilities used inside global-resolver:
 *   - isGraphQLPath correctly classifies paths so GQL endpoints exit the HTTP loop
 *   - parseGraphQLPath returns structured {operation, operationName}
 *   - findUniqueGQLMatch logic (field-level via isGraphQLPath + parseGraphQLPath)
 *
 * NOTE: The full ingestGlobalResolution function is not tested here because it
 * depends on live DB queries. These tests verify the pure helper logic that
 * drives the GQL branch decision.
 */
import { describe, it, expect } from 'vitest';
import { isGraphQLPath, parseGraphQLPath } from '../../../../src/ai/workflows/sanitizer.js';

// ─── GQL branch gate ─────────────────────────────────────────────────────────

describe('global-resolver GQL branch gate', () => {
    it('identifies GQL emergent paths — enters GQL branch', () => {
        expect(isGraphQLPath('GRAPHQL QUERY user')).toBe(true);
        expect(isGraphQLPath('GRAPHQL MUTATION createOrder')).toBe(true);
        expect(isGraphQLPath('GRAPHQL SUBSCRIPTION onEvent')).toBe(true);
    });

    it('identifies HTTP paths — enters HTTP branch', () => {
        expect(isGraphQLPath('/api/users')).toBe(false);
        expect(isGraphQLPath('/v1/orders/{id}')).toBe(false);
        expect(isGraphQLPath('')).toBe(false);
    });
});

// ─── GQL unique match semantics ───────────────────────────────────────────────

describe('findUniqueGQLMatch semantics', () => {
    // Simulate what findUniqueGQLMatch does: parse emergent + candidate, compare
    function simulateFindUniqueGQLMatch(
        emergentPath: string,
        candidatePaths: string[],
    ): string | null {
        const emergentParsed = parseGraphQLPath(emergentPath);
        if (!emergentParsed) return null;

        const matches = candidatePaths.filter(cp => {
            const cp_parsed = parseGraphQLPath(cp);
            return cp_parsed
                && cp_parsed.operation === emergentParsed.operation
                && cp_parsed.operationName === emergentParsed.operationName;
        });

        return matches.length === 1 ? matches[0] : null;
    }

    it('returns unique candidate when exactly 1 match', () => {
        const result = simulateFindUniqueGQLMatch(
            'GRAPHQL QUERY user',
            ['GRAPHQL QUERY user', 'GRAPHQL MUTATION user'],
        );
        expect(result).toBe('GRAPHQL QUERY user');
    });

    it('returns null when 0 candidates match (operation name miss)', () => {
        const result = simulateFindUniqueGQLMatch(
            'GRAPHQL QUERY getUser',
            ['GRAPHQL QUERY listUsers', 'GRAPHQL QUERY user'],
        );
        expect(result).toBeNull();
    });

    it('returns null when >1 candidates match (ambiguous)', () => {
        // Two SDL candidates with same operation+name — cross-service collision scenario
        const result = simulateFindUniqueGQLMatch(
            'GRAPHQL QUERY user',
            ['GRAPHQL QUERY user', 'GRAPHQL QUERY user'],
        );
        expect(result).toBeNull();
    });

    it('does not match across different operation types', () => {
        const result = simulateFindUniqueGQLMatch(
            'GRAPHQL MUTATION user',
            ['GRAPHQL QUERY user'],  // Same name, different operation
        );
        expect(result).toBeNull();
    });

    it('returns null for unparseable emergent path', () => {
        const result = simulateFindUniqueGQLMatch(
            '/api/graphql',  // Not a GRAPHQL QRY path
            ['GRAPHQL QUERY user'],
        );
        expect(result).toBeNull();
    });
});

// ─── Subscription handling ───────────────────────────────────────────────────

describe('GQL Subscription path handling', () => {
    it('parses Subscription operation correctly', () => {
        const parsed = parseGraphQLPath('GRAPHQL SUBSCRIPTION onOrderUpdated');
        expect(parsed?.operation).toBe('SUBSCRIPTION');
        expect(parsed?.operationName).toBe('onOrderUpdated');
    });

    it('isGraphQLPath returns true for Subscription', () => {
        expect(isGraphQLPath('GRAPHQL SUBSCRIPTION onOrderUpdated')).toBe(true);
    });

    it('Subscription matches against same Subscription only', () => {
        const parsed = parseGraphQLPath('GRAPHQL SUBSCRIPTION onOrderUpdated')!;
        const candidates = [
            parseGraphQLPath('GRAPHQL QUERY onOrderUpdated'),
            parseGraphQLPath('GRAPHQL SUBSCRIPTION onOrderUpdated'),
        ];
        const matches = candidates.filter(c =>
            c && c.operation === parsed.operation && c.operationName === parsed.operationName
        );
        expect(matches).toHaveLength(1);
    });
});
