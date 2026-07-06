import { describe, it, expect } from 'vitest';
import { reclassifyEmergentToGraphQL } from '../../../../src/ai/workflows/sanitizer.js';

describe('reclassifyEmergentToGraphQL', () => {
    it('rewrites a plain HTTP emergent when source declares an inline mutation', () => {
        const call = { method: 'POST', path: '/api', direction: 'OUTBOUND' as const, api_kind: 'rest' as const };
        const src = `
            $query = "mutation CreateOrder(\\$input: OrderInput!) { createOrder(input: \\$input) { id } }";
            $client->post($url, ['json' => ['query' => $query, 'variables' => $vars]]);
        `;
        const result = reclassifyEmergentToGraphQL(call, src);
        expect(result).toEqual({ previousPath: '/api', operationName: 'CreateOrder' });
        expect(call).toMatchObject({
            path: 'GRAPHQL MUTATION CreateOrder',
            api_kind: 'graphql',
            method: null,
        });
    });

    it('rewrites for a query operation', () => {
        const call = { method: 'POST', path: '/graphql', direction: 'OUTBOUND' as const };
        const src = `const Q = gql\`query GetUser($id: ID!) { user(id: $id) { id name } }\`;`;
        expect(reclassifyEmergentToGraphQL(call, src)?.operationName).toBe('GetUser');
        expect(call.path).toBe('GRAPHQL QUERY GetUser');
        expect(call.method).toBeNull();
    });

    it('uses null method for subscription', () => {
        const call: any = { method: 'POST', path: '/api', direction: 'OUTBOUND' };
        const src = `subscription OrderUpdates { orderUpdated { id } }`;
        const result = reclassifyEmergentToGraphQL(call, src);
        expect(result?.operationName).toBe('OrderUpdates');
        expect(call.method).toBeNull();
    });

    it('does not rewrite a call already classified as graphql', () => {
        const call = { method: null, path: 'GRAPHQL QUERY user', direction: 'OUTBOUND' as const, api_kind: 'graphql' as const };
        const src = `query GetUser { user { id } }`;
        expect(reclassifyEmergentToGraphQL(call, src)).toBeNull();
        expect(call.path).toBe('GRAPHQL QUERY user');
    });

    it('does not rewrite INBOUND calls', () => {
        const call = { method: 'POST', path: '/api', direction: 'INBOUND' as const };
        const src = `query GetUser { user { id } }`;
        expect(reclassifyEmergentToGraphQL(call, src)).toBeNull();
    });

    it('does not match a JSON field literally named "query"', () => {
        const call = { method: 'GET', path: '/api/search', direction: 'OUTBOUND' as const };
        // Note: NO operation keyword + name + body — just the word "query" inside an HTTP query string
        const src = `fetch('/api/search?query=' + encodeURIComponent(term))`;
        expect(reclassifyEmergentToGraphQL(call, src)).toBeNull();
    });

    it('does not match identifier-like words without trailing brace', () => {
        const call = { method: 'POST', path: '/api', direction: 'OUTBOUND' as const };
        // "mutation" appears but not followed by name + body — should not trigger
        const src = `// the term mutation is mentioned in this comment`;
        expect(reclassifyEmergentToGraphQL(call, src)).toBeNull();
    });

    it('returns null when sourceCode is empty', () => {
        const call = { method: 'POST', path: '/api', direction: 'OUTBOUND' as const };
        expect(reclassifyEmergentToGraphQL(call, '')).toBeNull();
    });

    it('does NOT rewrite a GET call even when the source declares inline operations', () => {
        // GraphQL-over-HTTP body-shape implies a POST body {query, variables}.
        // A GET emergent with its own concrete path is a REST call that merely
        // COEXISTS with GraphQL documents in the same function — rewriting it
        // would corrupt the REST endpoint into the first document's operation
        // (raw-guzzle regression: GET /api/search → GRAPHQL MUTATION CancelOrder).
        const call = { method: 'GET', path: '/api/search', direction: 'OUTBOUND' as const, api_kind: 'rest' as const };
        const src = `
            $cancel = "mutation CancelOrder(\\$id: ID!) { cancelOrder(id: \\$id) { id } }";
            $this->client->post($this->uri, ['json' => ['query' => $cancel]]);
            $found = $this->client->get('/api/search?query=' . urlencode($term));
        `;
        expect(reclassifyEmergentToGraphQL(call, src)).toBeNull();
        expect(call.path).toBe('/api/search');
        expect(call.method).toBe('GET');
    });

    it('still rewrites POST and method-null calls alongside the GET guard', () => {
        const postCall = { method: 'POST', path: '/api', direction: 'OUTBOUND' as const };
        const src = `$q = "mutation CancelOrder { cancelOrder { id } }";`;
        expect(reclassifyEmergentToGraphQL(postCall, src)?.operationName).toBe('CancelOrder');

        const nullCall: any = { method: null, path: '/api', direction: 'OUTBOUND' };
        expect(reclassifyEmergentToGraphQL(nullCall, src)?.operationName).toBe('CancelOrder');
    });
});
