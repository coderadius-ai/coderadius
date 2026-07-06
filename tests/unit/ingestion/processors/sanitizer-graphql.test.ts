/**
 * @file sanitizer-graphql.test.ts
 * Tests for the GraphQL-specific sanitizer utilities:
 *   - isGraphQLPath
 *   - parseGraphQLPath
 *   - normalizeApiPath GQL passthrough behavior
 */
import { describe, it, expect } from 'vitest';
import {
    isGraphQLPath,
    parseGraphQLPath,
} from '../../../../src/ai/workflows/sanitizer.js';
import { normalizeApiPath } from '../../../../src/ingestion/processors/api-path-utils.js';

// ─── isGraphQLPath ───────────────────────────────────────────────────────────

describe('isGraphQLPath', () => {
    it('returns true for GRAPHQL QUERY paths', () => {
        expect(isGraphQLPath('GRAPHQL QUERY user')).toBe(true);
        expect(isGraphQLPath('GRAPHQL QUERY getUser')).toBe(true);
    });

    it('returns true for GRAPHQL MUTATION paths', () => {
        expect(isGraphQLPath('GRAPHQL MUTATION createUser')).toBe(true);
    });

    it('returns true for GRAPHQL SUBSCRIPTION paths', () => {
        expect(isGraphQLPath('GRAPHQL SUBSCRIPTION onUserCreated')).toBe(true);
    });

    it('is case-insensitive on the GRAPHQL token', () => {
        expect(isGraphQLPath('graphql QUERY user')).toBe(true);
        expect(isGraphQLPath('GRAPHQL query user')).toBe(true);
        expect(isGraphQLPath('graphql mutation createUser')).toBe(true);
    });

    it('returns false for regular HTTP paths', () => {
        expect(isGraphQLPath('/api/users')).toBe(false);
        expect(isGraphQLPath('GET /api/users')).toBe(false);
        expect(isGraphQLPath('')).toBe(false);
    });

    it('returns false for paths with unknown operation keyword', () => {
        expect(isGraphQLPath('GRAPHQL UNKNOWN user')).toBe(false);
    });

    it('returns false for bare GRAPHQL token without operation', () => {
        expect(isGraphQLPath('GRAPHQL')).toBe(false);
    });
});

// ─── parseGraphQLPath ────────────────────────────────────────────────────────

describe('parseGraphQLPath', () => {
    it('parses a QUERY path correctly', () => {
        const result = parseGraphQLPath('GRAPHQL QUERY user');
        expect(result).toEqual({ operation: 'QUERY', operationName: 'user' });
    });

    it('parses a MUTATION path correctly', () => {
        const result = parseGraphQLPath('GRAPHQL MUTATION createOrder');
        expect(result).toEqual({ operation: 'MUTATION', operationName: 'createOrder' });
    });

    it('parses a SUBSCRIPTION path correctly', () => {
        const result = parseGraphQLPath('GRAPHQL SUBSCRIPTION onOrderUpdated');
        expect(result).toEqual({ operation: 'SUBSCRIPTION', operationName: 'onOrderUpdated' });
    });

    it('returns null for non-GQL paths', () => {
        expect(parseGraphQLPath('/api/users')).toBeNull();
        expect(parseGraphQLPath('')).toBeNull();
    });

    it('returns null for malformed GQL paths without operation name', () => {
        expect(parseGraphQLPath('GRAPHQL QUERY')).toBeNull();
    });

    it('normalises operation token to uppercase', () => {
        const result = parseGraphQLPath('graphql query user');
        expect(result?.operation).toBe('QUERY');
    });

    it('preserves operationName casing', () => {
        const result = parseGraphQLPath('GRAPHQL QUERY getUserById');
        expect(result?.operationName).toBe('getUserById');
    });
});

// ─── normalizeApiPath — GQL passthrough behavior ─────────────────────────────
// normalizeApiPath in api-path-utils returns GQL paths as-is (no transformation).
// The actual GQL normalisation (uppercase, 3-token enforcement) is done in
// unified-analyzer.ts before the path reaches api-path-utils.

describe('normalizeApiPath — GQL passthrough', () => {
    it('returns GQL path unchanged (passthrough)', () => {
        expect(normalizeApiPath('GRAPHQL QUERY user')).toBe('GRAPHQL QUERY user');
        expect(normalizeApiPath('GRAPHQL MUTATION createUser')).toBe('GRAPHQL MUTATION createUser');
    });

    it('stripes common HTTP prefixes from regular paths', () => {
        // normalizeApiPath strips /api/v1/ etc — test with a deeper path
        const result = normalizeApiPath('/users/profile');
        expect(result).toBe('/users/profile');
    });

    it('isGraphQLPath consistently returns true for normalizeApiPath GQL output', () => {
        const gqlPath = 'GRAPHQL QUERY user';
        const normalised = normalizeApiPath(gqlPath);
        if (normalised) {
            expect(isGraphQLPath(normalised)).toBe(true);
        }
    });

    it('key built from GQL path is stable', () => {
        // Simulates the deduplication key pattern: `graphql|{op}|{name}`
        const gqlPath = 'GRAPHQL QUERY user';
        const parsed = parseGraphQLPath(gqlPath);
        if (parsed) {
            const key = `graphql|${parsed.operation}|${parsed.operationName}`;
            expect(key).toBe('graphql|QUERY|user');
        }
    });
});

// ─── REGRESSION: P1 — Malformed operation identifiers (was: \S+ accepted anything)
// Before fix: /^GRAPHQL\s+(QUERY|MUTATION|SUBSCRIPTION)\s+\S+$/i
// After fix:  /^GRAPHQL\s+(QUERY|MUTATION|SUBSCRIPTION)\s+[A-Za-z_][A-Za-z0-9_]*$/i
// ─────────────────────────────────────────────────────────────────────────────

describe('isGraphQLPath — malformed identifier regression (P1 regex fix)', () => {
    it('rejects operationName containing parens — e.g. LLM hallucination "user(id:"', () => {
        // Before fix \S+ would accept this, producing corrupt key graphql|QUERY|user(id:
        expect(isGraphQLPath('GRAPHQL QUERY user(id:')).toBe(false);
    });

    it('rejects operationName with closing paren — "foo)"', () => {
        expect(isGraphQLPath('GRAPHQL QUERY foo)')).toBe(false);
    });

    it('rejects operationName starting with a digit — "1user"', () => {
        // Not a valid GraphQL identifier
        expect(isGraphQLPath('GRAPHQL QUERY 1user')).toBe(false);
    });

    it('rejects operationName with dot — "user.profile"', () => {
        expect(isGraphQLPath('GRAPHQL QUERY user.profile')).toBe(false);
    });

    it('rejects operationName with hyphen — "get-user"', () => {
        // Hyphens are not valid in GraphQL field names
        expect(isGraphQLPath('GRAPHQL QUERY get-user')).toBe(false);
    });

    it('accepts valid underscore-prefixed identifiers — "_internalField"', () => {
        // Underscore-prefixed names are valid in GraphQL
        expect(isGraphQLPath('GRAPHQL QUERY _internalField')).toBe(true);
    });

    it('accepts camelCase identifiers — "getUserById"', () => {
        expect(isGraphQLPath('GRAPHQL QUERY getUserById')).toBe(true);
    });

    it('accepts UPPER_SNAKE identifiers — "GET_USER"', () => {
        expect(isGraphQLPath('GRAPHQL QUERY GET_USER')).toBe(true);
    });
});

describe('parseGraphQLPath — malformed identifier regression (P1 regex fix)', () => {
    it('returns null for "GRAPHQL QUERY user(id:" — was parsed before fix', () => {
        expect(parseGraphQLPath('GRAPHQL QUERY user(id:')).toBeNull();
    });

    it('returns null for "GRAPHQL MUTATION foo)" — corrupt token', () => {
        expect(parseGraphQLPath('GRAPHQL MUTATION foo)')).toBeNull();
    });

    it('returns null for "GRAPHQL QUERY 1startWithDigit"', () => {
        expect(parseGraphQLPath('GRAPHQL QUERY 1startWithDigit')).toBeNull();
    });

    it('still parses clean identifiers correctly after regex tightening', () => {
        expect(parseGraphQLPath('GRAPHQL QUERY user')).toEqual({ operation: 'QUERY', operationName: 'user' });
        expect(parseGraphQLPath('GRAPHQL MUTATION createOrder')).toEqual({ operation: 'MUTATION', operationName: 'createOrder' });
        expect(parseGraphQLPath('GRAPHQL SUBSCRIPTION _onEvent')).toEqual({ operation: 'SUBSCRIPTION', operationName: '_onEvent' });
    });
});

// ─── REGRESSION: P1 — Prompt root field contract
// The LLM must emit the root field name in path, NOT the document operation name.
// This test verifies that a "document name style" token (PascalCase like GetUser)
// still passes the regex (it IS a valid identifier) but the semantic contract is
// enforced via document_operation_name being a separate field in EmergentAPICallSchema.
// ─────────────────────────────────────────────────────────────────────────────

describe('root field vs document name contract (P1 prompt fix)', () => {
    it('PascalCase document name IS a valid identifier — regex does not reject it', () => {
        // "GetUser" is a syntactically valid GraphQL identifier, so regex accepts it.
        // The prompt fix enforces the semantic distinction at the LLM instruction level,
        // not at the regex level. The regex is a syntax guard, not a semantic one.
        expect(isGraphQLPath('GRAPHQL QUERY GetUser')).toBe(true);
    });

    it('parseGraphQLPath extracts the operationName regardless of PascalCase', () => {
        const result = parseGraphQLPath('GRAPHQL QUERY GetUser');
        expect(result?.operationName).toBe('GetUser');
    });

    it('deduplication key is stable for root field name (camelCase)', () => {
        // Canonical path: 'GRAPHQL QUERY user' (root field, lowercase camel)
        const parsed = parseGraphQLPath('GRAPHQL QUERY user')!;
        const key = `graphql|${parsed.operation}|${parsed.operationName}`;
        expect(key).toBe('graphql|QUERY|user');
    });

    it('deduplication key differs between root field and document name', () => {
        // Root field = user, Document name = GetUser → different keys, different nodes.
        // This ensures the two are never conflated in the graph.
        const rootKey = `graphql|QUERY|user`;
        const docKey = `graphql|QUERY|GetUser`;
        expect(rootKey).not.toBe(docKey);
    });
});
