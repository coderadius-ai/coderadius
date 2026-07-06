import path from 'node:path';

/**
 * Centralized URN Construction Module
 *
 * All graph node identifiers use the `cr:` (CodeRadius) URN scheme:
 *
 *     cr:{type}:{segment1}:{segment2}:...
 *
 * Follows RFC 8141 conventions: `cr:` is a namespace identifier (like
 * `urn:isbn:` or `mailto:`). No `://` authority — there is no host.
 *
 * Segments are joined with `:` and written **verbatim** — no encoding.
 * File paths, API paths, and scoped package names keep their natural
 * `/`, `@`, and `::` characters, making URNs human-readable both in
 * the graph database and CLI output.
 *
 * Case-insensitive resource types (SQL tables, datastore connectors, etc.)
 * have their segments lowercased to prevent duplicates caused by
 * inconsistent LLM output.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  ⚠  NON-REVERSIBILITY CONTRACT                                 │
 * │                                                                  │
 * │  The `:` delimiter CAN appear inside segment values:             │
 * │    - PHP class methods:  App\Controller::index                   │
 * │    - Port numbers:       localhost:8080                          │
 * │                                                                  │
 * │  Therefore this URN is a FORWARD-ONLY identifier.                │
 * │  You CANNOT recover segments via `urn.split(':')`.               │
 * │                                                                  │
 * │  If you need to parse a URN in the future, implement a           │
 * │  `parseUrn(urn)` function using ONE of these strategies:         │
 * │                                                                  │
 * │  1. Regex per type:                                              │
 * │     /^cr:endpoint:(\w+):(\w+):(.+)$/                             │
 * │                                                                  │
 * │  2. Limited split (the last segment absorbs the remainder):      │
 * │     const [, type, source, method, ...rest] = urn.split(':');    │
 * │     const path = rest.join(':');                                  │
 * │                                                                  │
 * │  3. Schema registry: define the segment count per type and       │
 * │     use `urn.split(':', 2 + segmentCount)` to keep the last      │
 * │     segment raw.                                                 │
 * └──────────────────────────────────────────────────────────────────┘
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The URN scheme prefix for all CodeRadius graph identifiers.
 * **Never hardcode this string in Cypher queries** — always import it.
 */
export const CR_SCHEME = 'cr:';

/**
 * Sentinel HTTP-method value for GraphQL Subscription endpoints.
 *
 * Rationale: Memgraph (and Neo4j) remove a node property when it is SET to
 * null (`SET ep.method = null` silently deletes ep.method).  Subscriptions
 * have no meaningful HTTP method (they use WebSocket / SSE), but we must
 * always store a non-null string so:
 *   1. The property is never silently removed from the node.
 *   2. Frontend code can do `ep.method.toUpperCase()` safely.
 *   3. Queries like `WHERE ep.method IS NOT NULL` still find Subscription nodes.
 *
 * 'WS' is used (not 'null', 'NONE', or 'POST') because it is
 *   - unambiguous (clearly not an HTTP method),
 *   - short (fits existing method column widths),
 *   - a recognized WebSocket abbreviation.
 *
 * Usage: import this in every graph mutation that creates/updates a
 * GraphQL Subscription endpoint instead of passing null to Cypher.
 */
export const GQL_SUBSCRIPTION_METHOD = 'WS' as const;


/**
 * Build a typed prefix for Cypher `STARTS WITH` clauses.
 *
 * @example
 * urnPrefix('endpoint')             // → 'cr:endpoint:'
 * urnPrefix('endpoint', 'emergent') // → 'cr:endpoint:emergent:'
 */
export function urnPrefix(type: string, ...subSegments: string[]): string {
    const parts = [type, ...subSegments];
    return `${CR_SCHEME}${parts.join(':')}:`;
}

// ─── Case Normalisation ──────────────────────────────────────────────────────

/**
 * URN types whose name segment is case-insensitive.
 *
 * Rationale per type:
 *   datacontainer  – SQL tables and object storage buckets are case-insensitive by default
 *   datastore      – logical connector names (postgres, mysql, redis)
 *   systemprocess  – cron/worker names are conventionally lowercase
 *   domain/system/team – Backstage catalog identifiers are case-insensitive
 *
 * Explicitly NOT normalised:
 *   envvar         – POSIX env vars are case-sensitive
 *   channel  – Kafka topics / RabbitMQ exchanges are case-sensitive
 *   service/library/repository – directory-derived, case-sensitive
 *   function/sourcefile        – filesystem paths, case-sensitive
 *   endpoint       – HTTP paths are case-sensitive (RFC 7230)
 *   package        – ecosystem package names are case-sensitive
 */
const CASE_INSENSITIVE_TYPES = new Set([
    'datacontainer',
    'datastore',
    'systemprocess',
    'domain',
    'system',
    'team',
    'tenant',
    'deploymentunit',
    'technology',
]);

// ─── URN Builder ─────────────────────────────────────────────────────────────

/**
 * Build a canonical `cr:` identifier for a graph node.
 *
 * Segments are joined with `:` verbatim — no encoding applied.
 * For case-insensitive resource types the segments are lowercased.
 *
 * @example
 * buildUrn('datacontainer', 'Operations')              // → 'cr:datacontainer:operations'
 * buildUrn('service', 'order-service')              // → 'cr:service:order-service'
 * buildUrn('function', 'my-repo', 'ts', 'src/utils/math::calc')
 *   // → 'cr:function:my-repo:ts:src/utils/math::calc'
 */
export function buildUrn(type: string, ...segments: string[]): string {
    const normalised = CASE_INSENSITIVE_TYPES.has(type)
        ? segments.map(s => s.toLowerCase())
        : segments;
    return `${CR_SCHEME}${type}:${normalised.join(':')}`;
}

/**
 * Assert that a SCOPE segment is flat: no `:` inside, non-empty.
 *
 * URN segments in general MAY contain `:` for some node types (e.g. function
 * identifiers like `src/utils/math::calc`). This guard applies only to the
 * segments composed into a `scopeKey` (e.g. `{repoSeg}:{serviceSeg}`), where
 * the colon is the boundary between segments and a `:` inside one of them
 * would silently corrupt the URN parsing.
 *
 * Fail-fast: throws on violation. No silent escape.
 */
export function assertScopeSegment(segment: string, context: string): string {
    if (segment.includes(':')) {
        throw new Error(`[urn] Invalid scope segment in ${context}: "${segment}" contains ':'`);
    }
    if (segment.length === 0) {
        throw new Error(`[urn] Empty scope segment in ${context}`);
    }
    return segment;
}

// ─── Message Broker URN ──────────────────────────────────────────────────────

/**
 * Build the URN for a MessageBroker node.
 *
 * Format: `cr:broker:{provider}:{fingerprint}` (with optional `:{vhost-slug}`).
 *
 * Identity rule: two broker observations collapse iff their `(provider, fingerprint)`
 * pair matches. Fingerprint is a stable hash over the resolved `(host, port, vhost)`
 * tuple computed by the caller (typically sha256_trunc8). When a RabbitMQ vhost is
 * present, it is appended to keep distinct logical instances on the same physical
 * cluster (`/prod` vs `/staging`) addressable.
 *
 * The vhost segment is sanitized: leading slashes stripped, `/` and `:` replaced
 * with `-` so the URN does not collide with the segment delimiter.
 */
export function buildBrokerUrn(provider: string, fingerprint: string, vhost?: string): string {
    const base = `${CR_SCHEME}broker:${provider}:${fingerprint}`;
    if (!vhost || vhost === '/' || vhost === '') return base;
    const slug = vhost.replace(/^\/+/, '').replace(/[/:]/g, '-');
    return slug ? `${base}:${slug}` : base;
}

/**
 * Parsed broker URN. `fingerprintParts` is populated ONLY when the fingerprint
 * is transparent (contains the `~` separator from `buildTransparentIdentity`),
 * otherwise undefined (opaque sha — cannot be decoded).
 *
 * Marker-based decode contract (Fix 10 Phase 2): sha-256 hex is valid base64url
 * charset (`[0-9a-f]` ⊂ `[A-Za-z0-9_-]`), so a "try decode" on opaque
 * fingerprints would succeed silently producing garbage UTF-8. The `~`
 * separator (not in base64url charset) is a structural marker that
 * disambiguates the two shapes safely.
 */
export interface ParsedBrokerUrn {
    provider: string;
    /** Raw fingerprint segment (sha hex or base64url-encoded multi-part). */
    fingerprint: string;
    /** Decoded parts when transparent; undefined for opaque sha fingerprints. */
    fingerprintParts?: string[];
    /** Optional trailing vhost slug segment. */
    vhost?: string;
}

/**
 * Parse a broker URN built by `buildBrokerUrn`.
 *
 * Decode strategy:
 *   - Default: decode if `fingerprint.includes('~')` (transparent shape) else opaque.
 *   - `opts.transparent === true`: force decode, throws if `~` missing
 *     (caller bug — opaque shape cannot be decoded).
 *   - `opts.transparent === false`: never decode, even if `~` present.
 *
 * Throws on transparent shape that decodes to fewer than 2 parts (broker
 * fingerprint always carries at least host+port).
 */
export function parseBrokerUrn(urn: string, opts?: { transparent?: boolean }): ParsedBrokerUrn {
    const prefix = `${CR_SCHEME}broker:`;
    if (!urn.startsWith(prefix)) {
        throw new Error(`parseBrokerUrn: expected URN to start with '${prefix}', got '${urn}'`);
    }
    const rest = urn.slice(prefix.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx <= 0) {
        throw new Error(`parseBrokerUrn: missing fingerprint segment in '${urn}'`);
    }
    const provider = rest.slice(0, colonIdx);
    const tail = rest.slice(colonIdx + 1);
    // tail = `${fingerprint}` or `${fingerprint}:${vhostSlug}`.
    // Fingerprint may itself contain `:` (opaque sha never does, transparent base64url
    // never does either since charset excludes ':'), so split on first ':' after.
    // For transparent URNs the fingerprint contains `~` (joiner) but NEVER `:`.
    // For opaque URNs the fingerprint is sha hex (no `:`). Either way, split on first ':'.
    let fingerprint: string;
    let vhost: string | undefined;
    const vhostSepIdx = tail.indexOf(':');
    if (vhostSepIdx < 0) {
        fingerprint = tail;
    } else {
        fingerprint = tail.slice(0, vhostSepIdx);
        vhost = tail.slice(vhostSepIdx + 1);
    }

    const explicit = opts?.transparent;
    if (explicit === true && !fingerprint.includes('~')) {
        throw new Error(
            `parseBrokerUrn: fingerprint '${fingerprint}' missing '~' separator, cannot decode as transparent`,
        );
    }
    const isTransparent = explicit ?? fingerprint.includes('~');
    if (!isTransparent) {
        return { provider, fingerprint, vhost };
    }
    const parts = parseTransparentIdentityForUrn(fingerprint);
    if (parts.length < 2) {
        throw new Error(
            `parseBrokerUrn: transparent fingerprint '${fingerprint}' decoded to ${parts.length} part(s), broker requires at least host+port`,
        );
    }
    return { provider, fingerprint, fingerprintParts: parts, vhost };
}

// Local inline of parseTransparentIdentity to avoid circular import on graph layer.
// Mirror of src/utils/urn-transparency.ts:parseTransparentIdentity.
import { Buffer as _NodeBuffer } from 'node:buffer';
function parseTransparentIdentityForUrn(encoded: string): string[] {
    return encoded.split('~').map(p => {
        try {
            return _NodeBuffer.from(p, 'base64url').toString('utf-8');
        } catch {
            const standard = p.replace(/-/g, '+').replace(/_/g, '/');
            const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
            return _NodeBuffer.from(padded, 'base64').toString('utf-8');
        }
    });
}

// ─── Repository Namespace ────────────────────────────────────────────────

/**
 * Build an org-qualified repository name for use in URN construction.
 *
 * Returns `{org}/{name}` (e.g. `acme/docs/ai-rules`) to guarantee
 * globally unique Repository identifiers across GitLab/GitHub sub-groups.
 *
 * When `org` is missing (local repos without a remote URL), falls back to
 * `local/{name}` so the URN format is always `cr:repository:{namespace}/{name}`.
 *
 * This is the **single source of truth** for the Repository namespace.
 * All code that constructs a Repository URN MUST use this helper.
 */
export function getQualifiedRepoName(repo: { name: string; org?: string }): string {
    return `${repo.org ?? 'local'}/${repo.name}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalise resource name for a given URN type.
 *
 * Useful when the caller needs the normalised name itself (e.g. for
 * building composite URNs like schema field URNs).
 */
export function normalizeResourceName(type: string, name: string): string {
    return CASE_INSENSITIVE_TYPES.has(type) ? name.toLowerCase() : name;
}

// ─── Function Signature Builder ──────────────────────────────────────────────

export interface FunctionLocation {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

function formatFunctionLocation(location: FunctionLocation): string {
    // Include ONLY the start position in the URN.
    //
    // Rationale: endLine/endColumn are UNSTABLE — they change whenever the
    // function body grows or shrinks (e.g. adding a log line, adding return
    // statements). Including them caused the Merkle diff to classify the
    // unchanged function as deleted + replaced, producing spurious tombstones
    // and duplicate Function nodes in the graph on every refactor.
    //
    // startLine:startColumn is sufficient for uniqueness within a file:
    // no two class/top-level methods start at the same line+column.
    //
    // Note: endLine and endColumn are still stored as node *properties*
    // (for source range display and embedding context) — they just do not
    // participate in the identity key.
    return '';
}

/**
 * Builds a stable signature for a function based on its context.
 *
 * **Position-free for unambiguous names:**
 * Source positions are excluded from the URN when `nameIsAmbiguous` is false.
 * Including positions caused two classes of spurious tombstones:
 *   1. "Body growth" bug: endLine changes when the function body is extended.
 *   2. "Import shift" bug: startLine changes when lines are added above the
 *      function (e.g. a new import at the top of the file).
 *
 * **Tiebreaker for ambiguous names:**
 * When `nameIsAmbiguous` is true, the start position is appended as a suffix
 * so that different chunks with the same derived name remain distinct.
 * This flag MUST be set by the language plugin at chunk-extraction time —
 * urn.ts is language-agnostic and does not inspect name patterns.
 *
 * @param chunkName       The extracted function/method name
 * @param filepath        The relative filepath of the source file
 * @param language        The primary language of the file
 * @param location        The precise source location of the chunk
 * @param nameIsAmbiguous When true, appends @L{start}:C{col} as a tiebreaker
 */
export function buildFunctionSignature(
    chunkName: string,
    filepath: string,
    language: string,
    location: FunctionLocation,
    nameIsAmbiguous = false,
): string {
    const locationSuffix = nameIsAmbiguous
        ? `@L${location.startLine}:C${location.startColumn}`
        : '';

    if (language === 'php') {
        // PHP extracts fully qualified names (e.g. App\\Http\\OrderService::calculateTotal)
        if (chunkName.includes('\\') || chunkName.includes('::')) {
            return `${chunkName}${locationSuffix}`;
        }
        // Fallback for standalone PHP scripts
        const basename = path.basename(filepath, path.extname(filepath));
        return `${basename}::${chunkName}${locationSuffix}`;
    }

    if (language === 'typescript' || language === 'javascript') {
        // Use relative filepath without extension to prevent `index.ts` collisions across directories
        // e.g. src/components/Button/index.ts -> src/components/Button/index
        const parsed = path.parse(filepath);
        // Normalize to POSIX style for uniform IDs
        const normalizedDir = parsed.dir === '' ? '' : parsed.dir.split(path.sep).join('/');
        const modulePath = normalizedDir ? `${normalizedDir}/${parsed.name}` : parsed.name;
        return `${modulePath}::${chunkName}${locationSuffix}`;
    }

    // Default fallback
    const basename = path.basename(filepath, path.extname(filepath));
    return `${basename}::${chunkName}${locationSuffix}`;
}
