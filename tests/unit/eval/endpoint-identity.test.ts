import { describe, it, expect } from 'vitest';
import {
    endpointIdentityKey,
    isRouteHandlerEdge,
    pruneDuplicateRouteImplementations,
} from '../../../src/eval/endpoint-identity.js';
import type { FileTopologySnapshot, GraphEdgeSnapshot } from '../../../src/eval/types.js';

function makeEdge(overrides: Partial<GraphEdgeSnapshot> = {}): GraphEdgeSnapshot {
    return {
        sourceId: 'cr:function:repo:php:Controller::handle',
        sourceName: 'Controller::handle',
        targetId: 'cr:endpoint:code:POST:/quote',
        targetName: 'POST /quote',
        relType: 'IMPLEMENTS_ENDPOINT',
        sourceFile: 'www/index.php',
        targetType: 'APIEndpoint',
        ...overrides,
    };
}

describe('endpointIdentityKey', () => {
    it('parses code-inferred URN', () => {
        expect(endpointIdentityKey('cr:endpoint:code:POST:/quote', 'POST /quote'))
            .toBe('endpoint:POST:/quote');
    });

    it('parses emergent URN', () => {
        expect(endpointIdentityKey('cr:endpoint:emergent:GET:/users', 'GET /users'))
            .toBe('endpoint:GET:/users');
    });

    it('parses OpenAPI URN with repo namespace and relPath', () => {
        expect(endpointIdentityKey(
            'cr:endpoint:unknown/acme-shop:src/openapi.yml:POST:/quote',
            'POST /quote',
        )).toBe('endpoint:POST:/quote');
    });

    it('preserves colons in the path (Google-style action verb)', () => {
        // Defense-in-depth: paths CAN contain ':' even after normalization
        // (e.g. /v1/users:activate). The parser must rebuild via slice+join.
        expect(endpointIdentityKey(
            'cr:endpoint:code:POST:/v1/users:activate',
            'POST /v1/users:activate',
        )).toBe('endpoint:POST:/v1/users:activate');
    });

    it('preserves colons in OpenAPI URN with multi-segment relPath and colon-path', () => {
        expect(endpointIdentityKey(
            'cr:endpoint:unknown/repo:vendor/service/api.yml:DELETE:/v2/items/{id}:purge',
            'DELETE /v2/items/{id}:purge',
        )).toBe('endpoint:DELETE:/v2/items/{id}:purge');
    });

    it('returns null for GraphQL URN (no HTTP method token)', () => {
        // QUERY/MUTATION are not in HTTP_METHODS — the parser yields null
        // and the caller falls back to full-URN identity. This prevents
        // GraphQL endpoints from accidentally merging with HTTP endpoints.
        expect(endpointIdentityKey(
            'cr:endpoint:graphql:cr:apiinterface:repo:gql:QUERY:listOrders',
            'QUERY listOrders',
        )).toBeNull();
    });

    it('returns null for graphql-code variant', () => {
        expect(endpointIdentityKey(
            'cr:endpoint:graphql-code:cr:apiinterface:repo:gql:MUTATION:placeOrder',
            'MUTATION placeOrder',
        )).toBeNull();
    });

    it('returns null for emergent-graphql variant', () => {
        expect(endpointIdentityKey(
            'cr:endpoint:emergent-graphql:cr:service:repo:checkout:SUBSCRIPTION:orderUpdates',
            'SUBSCRIPTION orderUpdates',
        )).toBeNull();
    });

    it('refuses hybrid URNs where a method token precedes non-path content', () => {
        // Defensive contract: even if a future producer accidentally embedded
        // a GraphQL-shaped path after an HTTP method (e.g. 'POST:GRAPHQL …'),
        // we MUST NOT silently fast-path it as an HTTP endpoint. Falling
        // back to null forces full-URN identity comparison, which is the
        // safe (no-cross-producer-collapse) behaviour. If/when GraphQL
        // dedup becomes a requirement, it must be handled by a dedicated
        // parser, not by a permissive prefix shortcut here.
        expect(endpointIdentityKey(
            'cr:endpoint:code:POST:GRAPHQL QUERY listOrders',
            'whatever',
        )).toBeNull();

        // Other non-path tails after a method token: also null.
        expect(endpointIdentityKey('cr:endpoint:weird:GET:something-without-slash', 'fallback'))
            .toBeNull();
    });

    it('returns null for non-endpoint URN', () => {
        expect(endpointIdentityKey('cr:channel:order.created', 'order.created')).toBeNull();
        expect(endpointIdentityKey('not-a-urn', 'whatever')).toBeNull();
    });

    it('is case-insensitive on the method', () => {
        expect(endpointIdentityKey('cr:endpoint:code:post:/quote', 'post /quote'))
            .toBe('endpoint:POST:/quote');
    });
});

describe('isRouteHandlerEdge', () => {
    it('detects synthetic ::__route_handler chunks', () => {
        expect(isRouteHandlerEdge(makeEdge({ sourceName: 'POST /quote::__route_handler' }))).toBe(true);
    });

    it('rejects regular function names', () => {
        expect(isRouteHandlerEdge(makeEdge({ sourceName: 'Controller::handle' }))).toBe(false);
    });
});

describe('pruneDuplicateRouteImplementations', () => {
    function makeSnapshot(edges: GraphEdgeSnapshot[]): FileTopologySnapshot {
        return { filePath: 'www/index.php', nodes: [], edges };
    }

    it('drops controller IMPLEMENTS_ENDPOINT when route handler covers the same endpoint', () => {
        const routeEdge = makeEdge({
            sourceName: 'POST /quote::__route_handler',
            targetId: 'cr:endpoint:unknown/repo:src/openapi.yml:POST:/quote',
            targetName: 'POST /quote',
        });
        const controllerEdge = makeEdge({
            sourceName: 'QuoteController::handle',
            targetId: 'cr:endpoint:code:POST:/quote',
            targetName: 'POST /quote',
        });
        const snapshot = makeSnapshot([routeEdge, controllerEdge]);

        pruneDuplicateRouteImplementations(snapshot);

        expect(snapshot.edges).toHaveLength(1);
        expect(snapshot.edges[0].sourceName).toBe('POST /quote::__route_handler');
    });

    it('keeps controller edge when no route handler covers the endpoint', () => {
        const controllerEdge = makeEdge({
            sourceName: 'QuoteController::handle',
            targetId: 'cr:endpoint:code:POST:/orphan',
            targetName: 'POST /orphan',
        });
        const snapshot = makeSnapshot([controllerEdge]);

        pruneDuplicateRouteImplementations(snapshot);

        expect(snapshot.edges).toHaveLength(1);
    });

    it('does not affect non-IMPLEMENTS_ENDPOINT edges', () => {
        const routeEdge = makeEdge({
            sourceName: 'POST /quote::__route_handler',
            targetId: 'cr:endpoint:code:POST:/quote',
        });
        const writeEdge: GraphEdgeSnapshot = {
            sourceId: 'cr:function:repo:php:Repo::write',
            sourceName: 'Repo::write',
            targetId: 'cr:datacontainer:repo:orders',
            targetName: 'orders',
            relType: 'WRITES',
            sourceFile: 'www/index.php',
            targetType: 'DataContainer',
        };
        const snapshot = makeSnapshot([routeEdge, writeEdge]);

        pruneDuplicateRouteImplementations(snapshot);

        expect(snapshot.edges).toHaveLength(2);
    });

    it('preserves route handler edges with different (method, path) keys', () => {
        const route1 = makeEdge({
            sourceName: 'POST /a::__route_handler',
            targetId: 'cr:endpoint:code:POST:/a',
        });
        const route2 = makeEdge({
            sourceName: 'GET /b::__route_handler',
            targetId: 'cr:endpoint:code:GET:/b',
        });
        const snapshot = makeSnapshot([route1, route2]);

        pruneDuplicateRouteImplementations(snapshot);

        expect(snapshot.edges).toHaveLength(2);
    });
});
