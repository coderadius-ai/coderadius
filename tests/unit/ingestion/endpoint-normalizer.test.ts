import { describe, it, expect } from 'vitest';
import {
    normalizePathParams,
    normalizeApiPath,
    normalizeApiPathLossless,
    convertOpenAPIPathToRegex,
    isDynamicPath,
    stripCommonPrefixes,
} from '../../../src/ingestion/processors/api-path-utils.js';

// ═════════════════════════════════════════════════════════════════════════════
// Endpoint Path Normalizer — Unit Tests
//
// Validates that emergent API paths (from code extraction) and OpenAPI paths
// (from spec files) normalize to the same canonical form, enabling structural
// matching in the Matchmaker L1 pipeline.
//
// Key invariant: after normalization, {param}, {saveId}, :id, :partner all
// become the same canonical placeholder so cross-format comparison works.
// ═════════════════════════════════════════════════════════════════════════════

describe('write-time path symmetry (Bug B regression)', () => {
    // After Fix 2, openapi-extractor uses normalizeApiPathLossless so OpenAPI
    // paths land in the graph with the same morphology as code-inferred / emergent
    // paths from graph-writer. This guards the rewireImplementsEdgesToOpenApi
    // raw-path comparison.
    const SAMPLES: Array<{ openapi: string; code: string }> = [
        { openapi: '/api/foo/', code: '/api/foo' },                 // trailing slash on spec
        { openapi: '//api/foo', code: '/api/foo' },                 // double slash on spec
        { openapi: '/api/users/{userId}', code: '/api/users/:userId' },
        { openapi: '/api/foo?ignored=1', code: '/api/foo' },        // query string in spec key
        { openapi: '/api/foo', code: '/api/foo' },                  // already aligned
    ];

    for (const sample of SAMPLES) {
        it(`OpenAPI "${sample.openapi}" matches code "${sample.code}" after normalizeApiPathLossless`, () => {
            const openapi = normalizeApiPathLossless(sample.openapi);
            const code = normalizeApiPathLossless(sample.code);
            expect(openapi).not.toBeNull();
            expect(code).not.toBeNull();
            expect(openapi).toBe(code);
        });
    }
});

describe('normalizePathParams', () => {
    it('should normalize OpenAPI {param} to canonical {param}', () => {
        expect(normalizePathParams('/shipment/web/{param}')).toBe('/shipment/web/{param}');
    });

    it('should normalize OpenAPI {saveId} to canonical {param}', () => {
        expect(normalizePathParams('/shipment/web/{saveId}')).toBe('/shipment/web/{param}');
    });

    it('should normalize Express :id to canonical {param}', () => {
        expect(normalizePathParams('/api/orders/:orderId')).toBe('/api/orders/{param}');
    });

    it('should normalize Express :partner to canonical {param}', () => {
        expect(normalizePathParams('/:partner/issued-policy')).toBe('/{param}/issued-policy');
    });

    it('should make {param} and {retrieve-token} match after normalization', () => {
        const emergent = normalizePathParams('/shipment/web/{param}');
        const openapi = normalizePathParams('/shipment/web/{retrieve-token}');
        expect(emergent).toBe(openapi);
    });

    it('should make /{param}/envelope and /{partner}/issued-policy match structurally', () => {
        // These share the same /{_}/... structure
        const emergent = normalizePathParams('/{param}/envelope');
        const openapi = normalizePathParams('/{partner}/issued-policy');
        // They differ in the static segment, so they should NOT match —
        // normalization only unifies the parameter placeholder, not the path
        expect(emergent).toBe('/{param}/envelope');
        expect(openapi).toBe('/{param}/issued-policy');
        expect(emergent).not.toBe(openapi);
    });

    it('should normalize multiple params in one path', () => {
        expect(normalizePathParams('/{product}/transactions/{transactionId}/select'))
            .toBe('/{param}/transactions/{param}/select');
    });

    it('should normalize mixed Express and OpenAPI params', () => {
        expect(normalizePathParams('/:product/transactions/{transactionId}/select'))
            .toBe('/{param}/transactions/{param}/select');
    });

    it('should leave paths without params unchanged', () => {
        expect(normalizePathParams('/api/ping')).toBe('/api/ping');
    });
});

describe('normalizeApiPath (full pipeline)', () => {
    it('should strip /api/v1 prefixes and normalize params', () => {
        expect(normalizeApiPath('/api/v1/users/{userId}')).toBe('/users/{param}');
    });

    it('should strip /api prefix and normalize Express params', () => {
        expect(normalizeApiPath('/api/orders/:orderId')).toBe('/orders/{param}');
    });

    it('should strip trailing slashes', () => {
        expect(normalizeApiPath('/api/ping/')).toBe('/ping');
    });

    it('should return null for fully dynamic paths', () => {
        expect(normalizeApiPath('{baseUrl}/some/path')).toBeNull();
    });

    it('should return null for paths that are only parameter segments', () => {
        expect(normalizeApiPath('/{id}/{subId}')).toBeNull();
    });

    it('should reduce duplicate slashes', () => {
        // stripCommonPrefixes removes /api, then duplicate slashes are reduced
        // Result: /v1/users (the /v1 prefix is preserved)
        expect(normalizeApiPath('/api//v1//users')).toBe('/v1/users');
    });

    it('should preserve GRAPHQL pseudo-paths as-is', () => {
        expect(normalizeApiPath('GRAPHQL QUERY GetUsers')).toBe('GRAPHQL QUERY GetUsers');
    });

    it('should ensure leading slash', () => {
        expect(normalizeApiPath('users/{id}')).toBe('/users/{param}');
    });
});

describe('normalizeApiPathLossless', () => {
    it('should preserve /api/v1 prefix', () => {
        expect(normalizeApiPathLossless('/api/v1/charge')).toBe('/api/v1/charge');
    });

    it('should preserve /api/v2 prefix and keep variable names (lossless)', () => {
        expect(normalizeApiPathLossless('/api/v2/returns/{returnId}/status'))
            .toBe('/api/v2/returns/{returnId}/status');
    });

    it('should strip protocol and host from absolute URL', () => {
        expect(normalizeApiPathLossless('https://api.example.com/v2/shipment')).toBe('/v2/shipment');
    });

    it('should strip protocol, host and port from absolute URL', () => {
        expect(normalizeApiPathLossless('http://localhost:3000/api/users')).toBe('/api/users');
    });

    it('should keep literal numeric segments as static path parts', () => {
        expect(normalizeApiPathLossless('/api/v1/users/123')).toBe('/api/v1/users/123');
    });

    it('should reject dynamic base-url placeholders', () => {
        expect(normalizeApiPathLossless('{baseUrl}/charge')).toBeNull();
    });

    it('should preserve GRAPHQL pseudo-paths as-is', () => {
        expect(normalizeApiPathLossless('GRAPHQL QUERY GetUsers')).toBe('GRAPHQL QUERY GetUsers');
    });

    it('should strip query string parameters', () => {
        expect(normalizeApiPathLossless('/api/users?page=1&limit=10')).toBe('/api/users');
    });

    it('should strip hash fragments', () => {
        expect(normalizeApiPathLossless('/api/docs#authentication')).toBe('/api/docs');
    });

    it('should strip query+hash from full URL', () => {
        expect(normalizeApiPathLossless('https://api.example.com/v2/items?sort=date#top')).toBe('/v2/items');
    });
});

describe('convertOpenAPIPathToRegex', () => {
    it('should convert single OpenAPI param to regex', () => {
        const regex = convertOpenAPIPathToRegex('/users/{id}');
        expect(regex.test('/users/123')).toBe(true);
        expect(regex.test('/users/abc-def')).toBe(true);
        expect(regex.test('/users/')).toBe(false);
    });

    it('should convert multiple OpenAPI params to regex', () => {
        const regex = convertOpenAPIPathToRegex('/{product}/transactions/{transactionId}/select');
        expect(regex.test('/auto/transactions/tx-123/select')).toBe(true);
        expect(regex.test('/home/transactions/abc/select')).toBe(true);
        expect(regex.test('/transactions/abc/select')).toBe(false);
    });

    it('should convert Express-style params to regex', () => {
        const regex = convertOpenAPIPathToRegex('/api/orders/:orderId');
        expect(regex.test('/api/orders/12345')).toBe(true);
        expect(regex.test('/api/orders/')).toBe(false);
    });

    it('should match concrete paths against OpenAPI templates', () => {
        const regex = convertOpenAPIPathToRegex('/inventory/{sku}');
        expect(regex.test('/inventory/SKU123')).toBe(true);
        expect(regex.test('/inventory/')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-System Structural Matching Tests
//
// These validate the KEY USE CASE: emergent paths extracted from source code
// by the LLM should match their corresponding OpenAPI spec paths after
// both go through normalization.
// ═════════════════════════════════════════════════════════════════════════════

describe('Cross-System Structural Matching', () => {
    it('should match emergent {param} against OpenAPI {retrieve-token}', () => {
        const emergent = normalizeApiPath('/shipment/web/{param}');
        const openapi = normalizeApiPath('/shipment/web/{retrieve-token}');
        expect(emergent).toBe(openapi);
    });

    it('should match emergent {param} against Express :id', () => {
        const emergent = normalizeApiPath('/qx/agg/{param}');
        const express = normalizeApiPath('/qx/agg/:id');
        expect(emergent).toBe(express);
    });

    it('should match emergent path against OpenAPI spec via regex', () => {
        // Scenario: emergent path = POST /checkout/{param}
        //           OpenAPI path  = PATCH /api/billing/shipments/save/{saveId}
        // These should NOT match — different static segments
        const emergent = normalizeApiPath('/checkout/{param}');
        const openapi = normalizeApiPath('/api/billing/shipments/save/{saveId}');
        expect(emergent).not.toBe(openapi);
    });

    it('should match real-world case: vehicle logistics verification', () => {
        const emergent = normalizeApiPath('/vehicle-logistics-verification/{param}/{param}');
        const openapi = normalizeApiPath('/vehicle-logistics-verification/{plate}/{type}');
        expect(emergent).toBe(openapi);
    });

    it('should match real-world case: renewals endpoint', () => {
        const emergent = normalizeApiPath('/renewals/{param}');
        const openapi = normalizeApiPath('/renewals/{id}');
        expect(emergent).toBe(openapi);
    });
});
