// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine — Shared APIEndpoint identity helpers
//
// Single source of truth for keying APIEndpoint nodes/edges across the diff
// pipeline. Used by both:
//   - src/graph/queries/eval-snapshot.ts (DB → snapshot)
//   - src/eval/graph-differ.ts (snapshot diff)
//   - src/eval/ephemeral-extractor.ts (post-extraction pruning)
//
// Why a shared module:
//   - Prevents drift between current (DB) and proposed (ephemeral) sides.
//   - Centralises the URN parsing logic (defense-in-depth: paths CAN contain ':').
// ═══════════════════════════════════════════════════════════════════════════════

import type { GraphEdgeSnapshot, FileTopologySnapshot } from './types.js';

export const HTTP_METHODS = new Set([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE',
    'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'WS',
]);

const ROUTE_HANDLER_SUFFIX = '::__route_handler';

/** Synthetic chunks emitted by route extractors (see src/ingestion/processors/route-extractor-php.ts). */
export function isRouteHandlerEdge(edge: GraphEdgeSnapshot): boolean {
    return edge.sourceName.endsWith(ROUTE_HANDLER_SUFFIX);
}

/**
 * Extract a canonical (method, path) identity from an HTTP APIEndpoint URN.
 * Returns null when the URN does not match an HTTP endpoint shape, so the
 * caller can fall back to full-URN comparison.
 *
 * Supported (HTTP-only) forms:
 *   cr:endpoint:code:METHOD:/path
 *   cr:endpoint:emergent:METHOD:/path
 *   cr:endpoint:<repoQualified>:<relPath>:METHOD:/path
 *
 * GraphQL endpoints are intentionally NOT supported here. Their URNs
 *   cr:endpoint:graphql:<apiUrn>:<QUERY|MUTATION|SUBSCRIPTION>:<opName>
 *   cr:endpoint:graphql-code:…   cr:endpoint:emergent-graphql:…
 * carry no HTTP token, so `findIndex` returns -1 and we yield null —
 * the caller falls back to full-URN identity, which is the right behaviour
 * for GraphQL (no provider-variant collapsing is currently in scope).
 * If GraphQL endpoints ever need cross-producer dedup like HTTP does, add a
 * dedicated parser here (e.g. via `isGraphQLPath` in sanitizer.ts) — do NOT
 * rely on a string-prefix shortcut.
 *
 * Defense-in-depth: HTTP paths CAN contain ':' (Google-style '/v1/foo:action',
 * legacy data that bypassed normalization, OAS imported da terzi). We MUST
 * NOT assume `parts[length-2]` is the method — we search for the first
 * HTTP-method-like segment (`findIndex`, index >= 2) and rebuild the tail
 * with `slice(methodIndex+1).join(':')` so colons in the path survive.
 *
 * The inverse risk (a namespace token equal to an HTTP method) is not
 * realistic: source prefixes are an enumerated set
 * (code|emergent|graphql|graphql-code|emergent-graphql|<repoQualified>:<relPath>)
 * and none collide with HTTP_METHODS. Any relPath segment containing a method
 * substring would still not be an exact match (it would have a slash or a
 * file extension, e.g. 'apis/POST.yml').
 */
export function endpointIdentityKey(
    endpointUrn: string,
    fallbackPath: string,
): string | null {
    const parts = endpointUrn.split(':');
    if (parts[0] !== 'cr' || parts[1] !== 'endpoint') return null;

    const methodIndex = parts.findIndex(
        (part, index) => index >= 2 && HTTP_METHODS.has(part.toUpperCase()),
    );
    if (methodIndex === -1) return null;

    const method = parts[methodIndex].toUpperCase();

    // Rebuild the path with join(':') so colons in the path survive the split.
    const tail = parts.slice(methodIndex + 1).join(':');

    // Anti-false-match: the tail must look like an HTTP path. If the matched
    // "method" segment is actually part of a namespace and the remainder is
    // not a path (e.g. a hybrid URN that happens to embed 'POST' before
    // non-path content), refuse to match and fall back to full-URN identity.
    if (!tail.startsWith('/')) return null;

    return `endpoint:${method}:${tail || fallbackPath}`;
}

/**
 * Drop non-route-handler IMPLEMENTS_ENDPOINT edges when a synthetic
 * `::__route_handler` edge already covers the same (method, path) endpoint.
 *
 * Run on BOTH sides of the diff (DB snapshot and ephemeral extraction)
 * to keep the comparison symmetric — otherwise an LLM-detected controller
 * INBOUND would survive on one side only and produce a phantom delta.
 *
 * Mutates `snapshot.edges` in place.
 */
export function pruneDuplicateRouteImplementations(
    snapshot: FileTopologySnapshot,
): void {
    const routeKeys = new Set(
        snapshot.edges
            .filter(edge =>
                edge.relType === 'IMPLEMENTS_ENDPOINT'
                && edge.targetType === 'APIEndpoint'
                && isRouteHandlerEdge(edge),
            )
            .map(edge => endpointIdentityKey(edge.targetId, edge.targetName))
            .filter((key): key is string => key !== null),
    );

    if (routeKeys.size === 0) return;

    snapshot.edges = snapshot.edges.filter(edge => {
        if (edge.relType !== 'IMPLEMENTS_ENDPOINT') return true;
        if (edge.targetType !== 'APIEndpoint') return true;
        if (isRouteHandlerEdge(edge)) return true;
        const key = endpointIdentityKey(edge.targetId, edge.targetName);
        return !key || !routeKeys.has(key);
    });
}
