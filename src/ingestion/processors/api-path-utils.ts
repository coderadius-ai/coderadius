/**
 * Utility functions for normalizing and matching API paths
 * across different systems (code extraction, OpenAPI, etc.)
 */

export function stripCommonPrefixes(path: string): string {
    let result = path;
    // Remove /api, /api/v1, /api/v2, etc at the beginning
    result = result.replace(/^\/api(\/v\d+)?\//i, '/');
    result = result.replace(/^\/api(\/v\d+)?$/i, '/');
    return result;
}

export function isDynamicPath(path: string): boolean {
    if (path === 'DYNAMIC') return true;

    // Obvious config/env placeholders
    if (path.includes('{config.') || path.includes('{env.')) return true;

    // Variables representing hosts/base urls
    if (path.match(/^\/?\{base[uU]rl\}/) || path.match(/^\/?\{base[uU]ri\}/) || path.match(/^\/?\{domain\}/) || path.match(/^\/?\{host\}/)) {
        return true;
    }

    // Must have at least one static segment to be matchable, unless it's just '/'
    const segments = path.split('/').filter(Boolean);

    // If it's pure root, it's fine. If no segments and not root, it's dynamic
    if (segments.length === 0 && path !== '/') return true;

    // Check if ALL segments are parameters (like /{id}/{subId})
    const staticSegments = segments.filter(s => !(s.startsWith('{') && s.endsWith('}')) && !s.startsWith(':'));
    if (staticSegments.length === 0 && path !== '/') return true;

    return false;
}

export function normalizePathParams(path: string): string {
    // Replace Express-style ":param" with "{param}"
    let result = path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');

    // Universal parameter replacement for unified matching
    // Turns /users/{userId} and /users/:id both into /users/{param}
    result = result.replace(/\{[^}]+\}/g, '{param}');

    return result;
}

export function normalizeApiPath(path: string): string | null {
    if (path.startsWith('GRAPHQL')) return path;

    if (isDynamicPath(path)) return null;

    let normalized = stripCommonPrefixes(path);
    normalized = normalizePathParams(normalized);

    // Ensure leading slash
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }

    // Reduce duplicate slashes
    normalized = normalized.replace(/\/+/g, '/');

    // Strip trailing slash except for root
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

    return normalized;
}

/**
 * Lossless path normalization for STORAGE/EXTRACTION.
 *
 * Unlike `normalizeApiPath`, this does NOT strip /api/vN/ prefixes.
 * It only:
 *   - Strips protocol://host:port (network layer)
 *   - Normalizes path parameters ({userId}, :id → {param})
 *   - Ensures leading slash, removes trailing slash
 *
 * This preserves API versioning, gateway routing context, and prevents
 * path collisions (e.g. /api/users/sync vs /api/orders/sync).
 */
export function normalizeApiPathLossless(path: string): string | null {
    if (path.startsWith('GRAPHQL')) return path;

    if (isDynamicPath(path)) return null;

    // Strip protocol://host:port but preserve the full path
    let normalized = path.replace(/^https?:\/\/[^/]+/, '');

    // Strip query string and fragment — /api/users?page=1 → /api/users
    normalized = normalized.replace(/[?#].*$/, '');

    // Lossless: normalize Express :param → {param} but KEEP existing {varName} as-is
    // This preserves the LLM-extracted variable names (e.g. {trackingId}, {customerId})
    normalized = normalized.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');

    // Ensure leading slash
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }

    // Reduce duplicate slashes
    normalized = normalized.replace(/\/+/g, '/');

    // Strip trailing slash except for root
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

    return normalized;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path segment that is a parameter placeholder OR a concrete id literal. */
function isVariableOrIdSegment(seg: string): boolean {
    // Parameter placeholders: {name}, {$name}, :name, $name, ${name}, pre${x}.
    if (seg.startsWith(':')) return true;
    if (seg.startsWith('$')) return true;
    if (seg.startsWith('{') && seg.endsWith('}')) return true;
    if (seg.includes('${')) return true;
    // Concrete id literals (conservative — see fn doc):
    if (/^\d+$/.test(seg)) return true;             // numeric id
    if (UUID_RE.test(seg)) return true;             // dashed UUID
    if (/^[0-9a-f]{24,}$/i.test(seg)) return true;  // Mongo ObjectId / SHA / long hex
    return false;
}

/**
 * Dedup KEY for API paths. Unlike `normalizeApiPathLossless` (the storage form,
 * which preserves LLM-extracted variable names and has many callers), this
 * collapses EVERY parameter syntax AND EVERY concrete id literal to `{param}`
 * and case-folds static segments, so the four forms `/users/123`,
 * `/users/{id}`, `/users/:id`, `/users/${id}` produce ONE key.
 *
 * Conservative on ambiguous literals: pure digits, dashed UUIDs and long hex
 * (>=24 chars, e.g. Mongo ObjectId / SHA) collapse; short hex and word-like
 * tokens do NOT (indistinguishable from real route words like `me`/`active`).
 *
 * NEVER used for storage — only to group duplicates before persist. Expects a
 * path already stripped of protocol/host/query (i.e. post normalizeApiPathLossless).
 */
export function canonicalizeApiPathForDedup(path: string): string {
    if (path.startsWith('GRAPHQL')) return path;
    const canon = path
        .split('/')
        .map(seg => (seg === '' ? '' : isVariableOrIdSegment(seg) ? '{param}' : seg.toLowerCase()))
        .join('/');
    let result = canon.replace(/\/+/g, '/');
    if (!result.startsWith('/')) result = '/' + result;
    if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1);
    return result;
}

export interface EmergentEndpointRow {
    id: string;
    method: string;
    path: string;
}

export interface EmergentDedupGroup {
    survivorId: string;
    loserIds: string[];
}

/** Count templated segments ({name} / :name) — proxy for how much a path tells us. */
function templateScore(path: string): number {
    return path.split('/').filter(s => s.startsWith('{') || s.startsWith(':')).length;
}

/**
 * Group emergent REST endpoints that are the SAME logical endpoint (equal
 * method + equal `canonicalizeApiPathForDedup` key) but landed as distinct
 * nodes because their stored paths differ (literal ids, ${}, varying names).
 *
 * Returns one group per set of >=2 duplicates. The survivor is the most-
 * templated path (a named `/users/{userId}` beats a literal `/users/123`);
 * ties break on the lexicographically smallest id for determinism. Callers
 * weld every `loserId` into `survivorId`.
 *
 * Pure: no graph, no I/O. The actual rewire is `weldDuplicateEmergentEndpoints`.
 */
export function groupEmergentDuplicates(endpoints: readonly EmergentEndpointRow[]): EmergentDedupGroup[] {
    const byKey = new Map<string, EmergentEndpointRow[]>();
    for (const ep of endpoints) {
        const key = `${(ep.method ?? '').toUpperCase()}|${canonicalizeApiPathForDedup(ep.path)}`;
        const bucket = byKey.get(key);
        if (bucket) bucket.push(ep);
        else byKey.set(key, [ep]);
    }
    const groups: EmergentDedupGroup[] = [];
    for (const members of byKey.values()) {
        if (members.length < 2) continue;
        const sorted = [...members].sort((a, b) => {
            const score = templateScore(b.path) - templateScore(a.path);
            if (score !== 0) return score;                          // more templated wins
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;          // stable tie-break
        });
        const [survivor, ...losers] = sorted;
        groups.push({ survivorId: survivor.id, loserIds: losers.map(l => l.id) });
    }
    return groups;
}

/**
 * Convert an OpenAPI path template into a RegExp for matching concrete paths.
 *
 * Example:
 *   `/inventory/{sku}`     → /^\/inventory\/[^\/]+$/
 *   `/users/{id}/orders`   → /^\/users\/[^\/]+\/orders$/
 *
 * This is used by the Global Edge Resolver (Level 2 — Template Match)
 * to match emergent concrete paths against canonical OpenAPI templates.
 */
export function convertOpenAPIPathToRegex(oasPath: string): RegExp {
    // Escape regex-special characters in the static segments,
    // then replace OpenAPI `{param}` and Express `:param` with a wildcard segment.
    const escaped = oasPath
        .split('/')
        .map(segment => {
            // OpenAPI-style parameter: {paramName}
            if (segment.startsWith('{') && segment.endsWith('}')) {
                return '[^\\/]+';
            }
            // Express-style parameter: :paramName
            if (segment.startsWith(':')) {
                return '[^\\/]+';
            }
            // Static segment — escape regex special chars
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('\\/');

    return new RegExp(`^${escaped}$`);
}
