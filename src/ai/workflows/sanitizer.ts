// ═══════════════════════════════════════════════════════════════════════════════
// LLM Output Sanitizer — Deterministic Post-LLM Filters
//
// Extracted from graph-writer.ts to serve as Step 3 (Sanitize) in the
// semantic-extraction workflow.
//
// These filters catch hallucinated infrastructure names, dynamic table
// names, noisy broker class names, and template variable artifacts that
// the LLM returns despite prompt instructions.
//
// Zero LLM calls. Pure deterministic string matching.
// ═══════════════════════════════════════════════════════════════════════════════

import { logger } from '../../utils/logger.js';
import { traceCollector } from '../../telemetry/index.js';
import type { UnifiedAnalysis } from '../agents/unified-analyzer.js';
import type { SymbolRegistry } from '../../ingestion/core/symbol-registry.js';
import type { EnvVarBinding } from '../../ingestion/processors/infra-manifest-resolver.js';
import { resolveMessageChannelName } from '../../ingestion/processors/code-pipeline/interpret/message-channel.js';
import { normalizeEnvPlaceholder } from '../../ingestion/processors/dynamic-infra-resolver.js';
import {
    GENERIC_INFRA_NAMES,
    NOISY_BROKER_NAMES,
    BROKER_CLASS_SUFFIX,
    isSqlReservedTokenName,
    CQRS_MESSAGE_PATTERN,
    INFRA_HOSTNAME_SUFFIX,
    CQRS_METHOD_NAME_PREFIX,
    ABSTRACT_BUS_TECHNOLOGIES,
    DI_BROKER_SUFFIXES,
    SYSTEM_DATABASE_NAMES,
    LOCAL_IO_DATABASE_NAMES,
    PROPERTY_NAME_DATABASE_SUFFIX,
    isStorageTypeOrTransportToken,
    isDiServiceLocatorKey,
    splitCloudObjectName,
    isNoisyBrokerName,
    normalizeBrokerName,
    isHallucinatedTable,
    isUnresolvedTemplateName,
    isTemplatedPayloadName,
    isDynamicTableStub,
    isPurelyDynamicPlaceholder,
    extractDynamicPrefix,
} from '../../ingestion/core/name-safety.js';

// Re-export for backwards compatibility with downstream consumers
// (e.g. eval/ephemeral-extractor.ts imports GENERIC_INFRA_NAMES from here).
export {
    GENERIC_INFRA_NAMES,
    NOISY_BROKER_NAMES,
    BROKER_CLASS_SUFFIX,
    CQRS_MESSAGE_PATTERN,
    INFRA_HOSTNAME_SUFFIX,
    CQRS_METHOD_NAME_PREFIX,
    ABSTRACT_BUS_TECHNOLOGIES,
    DI_BROKER_SUFFIXES,
    SYSTEM_DATABASE_NAMES,
    LOCAL_IO_DATABASE_NAMES,
    PROPERTY_NAME_DATABASE_SUFFIX,
    isNoisyBrokerName,
    normalizeBrokerName,
    isHallucinatedTable,
    isUnresolvedTemplateName,
    isTemplatedPayloadName,
    isDynamicTableStub,
    isPurelyDynamicPlaceholder,
    extractDynamicPrefix,
};

// ─── Filter Functions ────────────────────────────────────────────────────────
// Generic name-safety predicates and constants moved to src/ingestion/core/name-safety.ts
// (shared with the static-bypass path that builds infrastructure items without LLM).
// All originally-defined symbols are re-exported above for backwards compatibility.

// ─── GraphQL Path Helpers ────────────────────────────────────────────────────

/**
 * Returns true if path matches the canonical GraphQL operation format:
 *   'GRAPHQL QUERY|MUTATION|SUBSCRIPTION rootFieldName'
 * Case-insensitive — normalizeApiPath guarantees uppercase on LLM output,
 * but callers from tests or non-LLM paths may use lowercase.
 */
export function isGraphQLPath(path: string): boolean {
    return /^GRAPHQL\s+(QUERY|MUTATION|SUBSCRIPTION)\s+[A-Za-z_][A-Za-z0-9_]*$/i.test(path);
}

/**
 * Parses a canonical GraphQL path into its components.
 * Returns null for invalid / non-canonical format.
 */
export function parseGraphQLPath(path: string): {
    operation: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';
    operationName: string;
} | null {
    const m = path.match(/^GRAPHQL\s+(QUERY|MUTATION|SUBSCRIPTION)\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (!m) return null;
    return { operation: m[1].toUpperCase() as 'QUERY' | 'MUTATION' | 'SUBSCRIPTION', operationName: m[2] };
}

/**
 * Body-shape rule: if a function's source code declares an inline GraphQL
 * operation (`mutation Foo { ... }` / `query Bar(...)` / `subscription Baz`),
 * any plain-HTTP emergent OUTBOUND call we emitted on the same chunk is most
 * likely a misclassified GraphQL operation. Rewrite the call's path/api_kind
 * to the canonical `GRAPHQL <op> <name>` shape so the L0 GQL weld branch in
 * the global resolver matches it against an SDL endpoint.
 *
 * Anchored regex `(query|mutation|subscription)\s+<Name>\s*[({]` — the
 * trailing `(` or `{` ensures we match a real operation declaration rather
 * than the literal word "query" appearing in REST URLs or JSON keys.
 *
 * Mutates `call` in place. Returns rewrite metadata, or null if no rewrite.
 */
export function reclassifyEmergentToGraphQL(
    call: { method?: string | null; path: string; direction?: 'INBOUND' | 'OUTBOUND'; api_kind?: 'rest' | 'graphql' },
    sourceCode: string,
): { previousPath: string; operationName: string } | null {
    if (!sourceCode) return null;
    if (call.api_kind === 'graphql') return null;
    if ((call.direction ?? 'OUTBOUND') !== 'OUTBOUND') return null;
    if (isGraphQLPath(call.path)) return null;
    // GraphQL-over-HTTP body-shape implies a POST body {query, variables}.
    // A GET emergent with its own concrete path is a REST call that merely
    // coexists with GraphQL documents in the same function body — rewriting
    // it would corrupt the REST endpoint into the first declared operation.
    if ((call.method ?? '').toUpperCase() === 'GET') return null;

    const m = sourceCode.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[({]/i);
    if (!m) return null;

    const op = m[1].toUpperCase() as 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';
    const name = m[2];
    const previousPath = call.path;
    call.path = `GRAPHQL ${op} ${name}`;
    call.api_kind = 'graphql';
    call.method = null;
    return { previousPath, operationName: name };
}

/**
 * Garbage collection filter for emergent API endpoints.
 * Returns true if the path is noisy and should NOT be persisted.
 *
 * GraphQL canonical paths ('GRAPHQL QUERY|MUTATION|SUBSCRIPTION name') are
 * NOT noisy — they are structured identifiers. Introspection operations
 * (__schema, __type) are the only GraphQL paths we reject.
 */
export function isNoisyEndpoint(path: string): boolean {
    if (path.includes(' ')) {
        const parsed = parseGraphQLPath(path);
        if (!parsed) return true;                                // non-GQL with spaces = noisy
        if (parsed.operationName.startsWith('__')) return true;  // introspection
        return false;                                            // canonical GQL = legitimate
    }
    // Skip paths that are ONLY a template variable like '{path}' or '{url}'
    if (/^\{[^}]+\}$/.test(path)) return true;
    // Skip raw URLs without a useful path (e.g. 'http://example.com' with no path)
    if (/^https?:\/\/[^/]+\/?$/i.test(path)) return true;
    return false;
}

/**
 * Evidence-Based guard for LLM-inferred INBOUND endpoints.
 *
 * A legitimate INBOUND path must appear in the function's sourceCode as a
 * quoted string literal — either in a router call, framework attribute, or
 * annotation. A path purely deduced from the class/function name is an LLM
 * class-name hallucination.
 *
 * Two-pass strategy:
 *   Pass 1 — Exact match: the full path must appear quoted in source.
 *             Handles: PHP/JS annotations, direct router declarations.
 *   Pass 2 — Last-segment match: the last significant segment must appear
 *             quoted. Handles: Slim/Laravel route groups, Express .use() prefixes
 *             where the full path is split across lines.
 *             Guard: segments shorter than 4 chars are skipped to reduce false
 *             positives from common words like 'api', 'v1', 'id'.
 *
 * NOT applied to OUTBOUND paths — those may be dynamically constructed from
 * config variables and template strings.
 */
export function isInboundPathEvident(path: string, sourceCode: string): boolean {
    const Q = "['\"]";

    // Pass 1: exact quoted match ('/api/v1/records/archive' or "/api/v1/records/archive")
    const exactEscaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(Q + exactEscaped + Q).test(sourceCode)) return true;

    // Pass 2: last significant segment, quoted (handles route groups/prefix splitting)
    // Filters out path param placeholders ({param}) and short ambiguous segments (<4 chars)
    const segments = path.split('/').filter(s =>
        s.length >= 4 && !s.startsWith('{'),
    );
    if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        const segEscaped = lastSegment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match: '/archive', 'archive', '/archive/', 'archive/' — all valid forms across frameworks.
        // PHP/Slim: '/archive', Django: 'calculate/', Java: '/archive', Express: '/archive'
        // NOTE: leading slash is intentionally optional — Django urls.py uses 'segment/'
        // without a leading slash. Language-specific false-positive guards belong in the
        // language extractor (e.g. route-extractor-php.ts) not here.
        if (new RegExp(Q + '/?'  + segEscaped + '/?'  + Q).test(sourceCode)) return true;
    }

    return false;
}

/**
 * Symmetric OUTBOUND guard for class-name hallucinations.
 *
 * Failure pattern (orchestrator, 2026-05-21): the PSR-18 HTTP wrapper that holds
 * the real path literal is dropped by the static gates (`createRequest` +
 * `sendRequest` not recognised as HTTP I/O). The thin delegation adapter that
 * just forwards `$this->client->method($args)` passes via DI-Alias and reaches
 * the LLM with NO path literal. The LLM then hallucinates the wrapper class /
 * method name as the path:
 *
 *     `/OrderClient`, `/InventoryAdapter`               (single PascalCase)
 *     `/OrderClient.init`, `/PaymentAdapter.send`       (class.method)
 *     `/NotificationService:{publish}`                  (class:{method})
 *     `/api.acme.com/v2/orders`                         (host kept after protocol strip)
 *
 * `isInboundPathEvident` is INBOUND-only (OUTBOUND comment explicitly opts out
 * because OUTBOUND paths may be built from config). This function is the
 * complement: deterministic shape rules that drop paths that cannot plausibly
 * be REST routes, plus a cross-check against the function's `infrastructure[]`
 * ExternalAPI names to detect double-counting.
 *
 * Source-literal evidence wins over shape rules. If the path appears verbatim
 * as a quoted literal in source, keep it even if it shape-matches — the LLM
 * may genuinely be calling a route named `/OrderClient`.
 */
export function isHallucinatedOutboundPath(
    path: string,
    sourceCode: string,
    infrastructure: ReadonlyArray<{ name: string; type: string }>,
): boolean {
    // GraphQL canonical paths contain a space; handled by isNoisyEndpoint.
    if (path.includes(' ')) return false;

    const segments = path.split('/').filter(s => s.length > 0);
    if (segments.length === 0) return false;
    const firstSeg = segments[0];

    // Source-literal evidence wins. If the path appears verbatim in source, trust it.
    const Q = "['\"]";
    const pathEscaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(Q + pathEscaped + Q).test(sourceCode)) return false;

    // class:{method} template — never a legitimate REST path.
    if (/:\{[^}]+\}/.test(path)) return true;

    // class.method pattern in any segment (PascalCase id `.` lowerCamelCase id).
    // Restricted to PascalCase head to avoid `/api/v1.0/orders`, `/users/{id}.json`.
    if (segments.some(s => /^[A-Z][A-Za-z0-9]+\.[a-z][A-Za-z0-9]*$/.test(s))) return true;

    // First segment shaped like a hostname (label.tld with optional sub-labels).
    // Catches `/api.acme.com/...`, `/www.acme.com/...`. Edge case: `/data.csv`
    // would also match; accepted, REST paths almost never start with `<word>.<word>`.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(firstSeg)) return true;

    // Double-counting with infrastructure[]: the LLM often emits the wrapper class
    // as BOTH an ExternalAPI infra entry AND a phantom endpoint path. Keep the
    // infra node, drop the endpoint.
    const head = firstSeg.split('.')[0];
    const externalApiNames = infrastructure
        .filter(i => i.type === 'ExternalAPI')
        .map(i => i.name);
    if (externalApiNames.includes(head) || externalApiNames.includes(firstSeg)) {
        return true;
    }

    // Single PascalCase segment, long enough to be a class name (not `/Users`).
    // Already guaranteed not to be in source (source-literal check ran above).
    if (segments.length === 1
        && /^[A-Z][A-Za-z0-9]+$/.test(firstSeg)
        && firstSeg.length >= 7) {
        return true;
    }

    return false;
}

/**
 * Layer 2 defense: detect schema/payload names containing unresolved template
 * variables from PHP, JS, or Python (e.g. "policy.{$eventType}", "queue_${name}").
 *
 * Catches:
 * - PHP `${name}` / `{$name}`, JS `${name}`, Python `%s/%d` interpolation
 * - UPPER_CASE config placeholders (`{ENV}`, `{CLUSTER}`, `{ENVIRONMENT}`)
 * - The known lowercase env placeholder set used by Symfony/PHP and matched by
 *   `dynamic-infra-resolver.normalizeEnvPlaceholder`: `{envSuffix}`, `{env}`,
 *   `{environment}`, `{tablePrefix}`, `{prefix}`, `{suffix}`. If the resolver
 *   skips a node (e.g. on incremental sync) these would otherwise reach the
 *   graph as literal substrings — pollute URN identity. Listed explicitly so
 *   we don't catch legitimate REST path params (`{userId}`, `{orderId}`).
 */
// `isUnresolvedTemplateName` moved to src/ingestion/core/name-safety.ts

/**
 * Stricter sibling of `isUnresolvedTemplateName`, specialised for
 * payload / event / table identifiers (NOT URL paths).
 *
 * `isUnresolvedTemplateName` is intentionally conservative: it must
 * preserve REST path params (`/api/users/{userId}`) that legitimately
 * use curly-brace notation. As a consequence it does NOT catch
 * lowercase placeholders like `{tipo}` / `{type}` / `{nome}`, which
 * are syntactically indistinguishable from REST path params.
 *
 * `isTemplatedPayloadName` applies to contexts where braces are NEVER
 * legitimate: a payload / event / class / table identifier cannot
 * contain `{` or `}` in any data model (SQL identifiers, broker topic
 * names, JS/PHP class names, Avro/Protobuf schema names). Any brace
 * in such a context is an unresolved template that leaked from the
 * LLM or static extractor.
 *
 * Use sites: `graph-writer.ts:persistFunction` for the LLM-produced
 * `produced_payloads[].name` and `consumed_payloads[].name` filters.
 */
// `isTemplatedPayloadName` moved to src/ingestion/core/name-safety.ts

// ─── Composite Sanitizer ─────────────────────────────────────────────────────

/**
 * Returns true if this Database name is a dynamic stub that should be
 * preserved for post-ingestion expansion by DataEntityPostProcessor.
 * These are NOT dropped — they survive to Stage 4 as wildcard nodes.
 *
 * Examples that return true:
 *   "booking_slot_{type}"   (curly-brace template from LLM)
 *   "res_archive_"          (trailing underscore stub)
 */
// `isDynamicTableStub` moved to src/ingestion/core/name-safety.ts

/**
 * Returns true if the infrastructure name is entirely wrapped in braces
 * with no static prefix or suffix — indicating raw variable interpolation
 * that leaked from the LLM output.
 *
 * This is a cross-language guard:
 *   TS:     {args.ts}, {config.dbName}     → true
 *   Python: {args.output_file}, {self.x}   → true
 *   Go:     {args.OutputFile}, {cfg.Name}  → true
 *   PHP:    {$this->tableName}             → true
 *
 * Legitimate dynamic stubs always have a static prefix:
 *   booking_slot_{type}                    → false
 *   fulfillment.shipment{envSuffix}.save   → false
 */
// `isPurelyDynamicPlaceholder` moved to src/ingestion/core/name-safety.ts

/**
 * If `name` is a dynamic table stub (trailing `_` or `{var}` suffix),
 * return the static prefix string used for STARTS WITH matching.
 * Otherwise return null.
 *
 * Examples:
 *   "res_archive_"        → "res_archive_"   (trailing _ kept for STARTS WITH)
 *   "booking_slot_{type}" → "booking_slot_"  (split on '{', take [0])
 *   "booking_slot_hotel"  → null
 */
// `extractDynamicPrefix` moved to src/ingestion/core/name-safety.ts

/**
 * Evidence-Based Guardrail (Layer 2): verifies that the LLM's claimed
 * Database evidence actually exists in the source code.
 *
 * Catches ghost table hallucinations where the LLM:
 * 1. Provides no evidence at all (variable name confusion)
 * 2. Provides repository/ORM wrapper calls as evidence (not direct SQL)
 * 3. Fabricates plausible SQL that doesn't exist in the source code
 *
 * Returns true if the table name is likely hallucinated.
 */
// `isHallucinatedTable` moved to src/ingestion/core/name-safety.ts

/**
 * Apply all deterministic filters to an LLM analysis result.
 * Returns a cleaned copy with hallucinated infrastructure, broker names,
 * API calls, and payloads removed.
 *
 * Dynamic Database stubs (trailing _ or {var} templates) are intentionally
 * preserved — they are written to the graph as wildcard nodes and expanded
 * by DataEntityPostProcessor after ingestion completes.
 *
 * This is Step 3 of the semantic-extraction workflow.
 */
export interface SanitizeOptions {
    sourceCode?: string;
    symbolRegistry?: SymbolRegistry;
    consumerFilePath?: string;
    functionName?: string;
    entityClassNames?: Set<string>;
    allowedTableNames?: Set<string>;
    allowedApiPaths?: Set<string>;
    plugin?: {
        validateInboundPath?(path: string, sourceCode: string): boolean | undefined;
        recognizesServiceLocatorKey?(name: string, sourceCode: string): boolean;
        recognizesFrameworkDiHandle?(name: string, kind: 'channel' | 'container'): boolean;
        recognizesPlatformIoBuiltin?(name: string, sourceCode: string): boolean;
        recognizesInProcessEvent?(name: string, sourceCode: string): boolean;
        recognizesPublishPayloadConstruction?(name: string, sourceCode: string): boolean;
        recognizesDocumentCollectionContainer?(name: string, sourceCode: string): boolean;
        recognizesDocumentCollectionAccess?(sourceCode: string): boolean;
        inferBrokerTechnology?(sourceCode: string): string | undefined;
    };
    functionId?: string;
    /** Array-shaped (NOT Map): preserved verbatim from prior signature. */
    resolvedConstants?: Array<{ key: string; value: string }>;
    envVarDict?: Map<string, EnvVarBinding>;
    /**
     * AST-grounded service-interface names from typeDefIndex.kind='interface'
     * AND interfaceRole='service'. Dropped from produced/consumed_payloads.
     */
    knownServiceInterfaces?: Set<string>;
    /**
     * Phase 2 (Fix #3) — AST-resolved payload candidates produced by
     * `extractFunctionPayloadHints`. When the LLM emits `_opaque_reference`
     * for a payload whose `basename` matches an entry here, the sanitizer
     * replaces the opaque fields with the AST-resolved ones.
     *
     * Matching is direct string equality on `basename` (the plugin already
     * stripped the FQCN). The core never normalizes.
     */
    astResolvedPayloads?: Array<{
        direction: 'produced' | 'consumed';
        basename: string;
        fields: Array<{ name: string; type: string }>;
    }>;
}

export function sanitizeAnalysis(
    analysis: UnifiedAnalysis,
    opts: SanitizeOptions = {},
): UnifiedAnalysis {
    const {
        sourceCode,
        symbolRegistry,
        consumerFilePath,
        functionName,
        entityClassNames,
        allowedTableNames,
        allowedApiPaths,
        plugin,
        functionId,
        resolvedConstants,
        envVarDict,
        knownServiceInterfaces,
        astResolvedPayloads,
    } = opts;
    if (!analysis.has_io) return analysis;

    // Clone to avoid mutation
    const clean = { ...analysis };
    const traceSanitizer = (
        action: 'PASS' | 'DROP' | 'TRANSFORM' | 'INFO',
        resourceTarget: string,
        reason: string,
        data?: Record<string, unknown>,
    ) => {
        traceCollector.traceSanitizer(
            action,
            functionId ?? resourceTarget,
            reason,
            {
                filePath: consumerFilePath,
                functionName,
                functionId,
                resourceTarget,
                ...data,
            },
        );
    };
    const resolvedConstantMap = new Map((resolvedConstants ?? []).map(constant => [constant.key, constant.value]));

    // ── Filter infrastructure ────────────────────────────────────────────
    if (clean.infrastructure) {
        const originalCount = clean.infrastructure.length;
        clean.infrastructure = clean.infrastructure.filter(infra => {
            // Drop generic technology names (mysql, postgres, etc.)
            if (GENERIC_INFRA_NAMES.has(infra.name.toLowerCase())) {
                logger.debug(`[Sanitizer] Dropped generic infra: "${infra.name}"`);
                traceSanitizer('DROP', `infra:${infra.type}:${infra.name}`, 'generic technology name', { resourceType: infra.type, resourceName: infra.name });
                return false;
            }

            // ── Evidence-based DI guard (language plugin), non-channel types ──
            // A name the source uses ONLY as a service-locator getter arg
            // (PSR-11 / ServiceManager contract) is a DI handle, never a
            // physical table/bucket — whatever its shape. No name lists: any
            // other occurrence of the name is counter-evidence and the plugin
            // returns false. MessageChannel is EXEMPT here: channel DI keys go
            // through the registry RESOLUTION step first (diKey → physical
            // name); the locator guard for channels runs post-resolution.
            if (infra.type !== 'MessageChannel'
                && sourceCode && plugin?.recognizesServiceLocatorKey?.(infra.name, sourceCode)) {
                logger.debug(`[Sanitizer] Dropped service-locator key: "${infra.name}"`);
                traceSanitizer('DROP', `infra:${infra.type}:${infra.name}`, 'service-locator key (sole occurrence is a container ->get arg)', { resourceType: infra.type, resourceName: infra.name });
                return false;
            }

            // ── Guard: purely dynamic placeholders ────────────────
            // Infrastructure names that are entirely {variable} (no static prefix)
            // indicate unresolved variable interpolation from the source code.
            // Language-agnostic: catches TS {args.ts}, Python {self.x}, Go {cfg.Name}.
            // Must be BEFORE isDynamicTableStub check — {type} without prefix is useless.
            // Skip MessageChannel here because it performs DI resolution later.
            if (infra.type !== 'MessageChannel' && isPurelyDynamicPlaceholder(infra.name)) {
                logger.debug(`[Sanitizer] Dropped purely dynamic placeholder: "${infra.name}"`);
                traceSanitizer('DROP', `infra:${infra.type}:${infra.name}`, 'purely dynamic placeholder — no static prefix (cross-language guard)');
                return false;
            }

            if (infra.type === 'Database') {
                // Backslash guard: no table/collection identifier grammar
                // admits backslashes. Catches namespace-qualified class
                // identifiers ('Entity\OrderRenewal') that the LLM emits
                // instead of the mapped table value, and escape artifacts.
                if (infra.name.includes('\\')) {
                    logger.debug(`[Sanitizer] Dropped namespaced class identifier as table: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'namespaced class identifier (backslash)');
                    return false;
                }

                // Shared identifier-shape guards (same predicates as the
                // static-bypass path in value-resolution — both provenances):
                // bare SQL reserved words are query-fragment echoes, spaced
                // names are not unquoted identifiers. Framework DI-handle
                // shapes (doctrine.*, messenger.*) are ecosystem grammar:
                // the language plugin owns them via the hook.
                if (isSqlReservedTokenName(infra.name)
                    || /\s/.test(infra.name.trim())
                    || plugin?.recognizesFrameworkDiHandle?.(infra.name, 'container')) {
                    logger.debug(`[Sanitizer] Dropped non-identifier table name: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'identifier-shape guard (SQL token / spaced / framework DI id)');
                    return false;
                }
                // MongoDB driver collection (Fix C): the LLM emits a
                // `$client->selectCollection($db, 'name')` collection as a generic
                // Database with no technology, so in a mixed Mongo+SQL function the
                // downstream default-RDBMS binder mis-binds it to the SQL datastore.
                // When the source shows this container was produced by the standard
                // MongoDB driver's selectCollection, stamp document/mongodb so it
                // binds to the Mongo datastore. Container-specific (the name, or a
                // dynamic stub's literal prefix, must appear as a selectCollection
                // arg), so a SQL table in the same function — which appears in a SQL
                // string, not selectCollection — is never mis-stamped. Runs BEFORE
                // the dynamic-stub preserve so the family rides the preserved stub.
                if (sourceCode && !infra.technology && plugin?.recognizesDocumentCollectionContainer?.(infra.name, sourceCode)) {
                    infra.technology = 'mongodb';
                    (infra as any).kindFamily = 'document';
                    traceSanitizer('TRANSFORM', `infra:Database:${infra.name}`, 'MongoDB selectCollection container → document/mongodb', { resourceName: infra.name });
                }
                // Preserve dynamic stubs — they survive to Stage 4 for post-processing
                if (isDynamicTableStub(infra.name)) {
                    logger.debug(`[Sanitizer] Preserved dynamic stub for post-processing: "${infra.name}"`);
                    traceSanitizer('PASS', `infra:Database:${infra.name}`, 'dynamic stub preserved for post-processing');
                    return true;
                }
                // Drop true hallucinations: unknown, placeholder, class names, PHP vars
                if (/unknown|placeholder/i.test(infra.name) || isUnresolvedTemplateName(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped hallucinated table: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'hallucinated table (unknown/placeholder)');
                    return false;
                }
                // Drop system/infrastructure database names that the LLM extracts from
                // connection setup code (e.g. MongoDB admin auth database, MySQL system schemas).
                if (SYSTEM_DATABASE_NAMES.has(infra.name.toLowerCase())) {
                    logger.debug(`[Sanitizer] Dropped system database: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'system database (not application data)');
                    return false;
                }
                // Drop generic local-IO names that the LLM emits when a function
                // does file/disk I/O without a real data store
                // (e.g. file_get_contents, fopen). These are not C4 DataContainers.
                if (LOCAL_IO_DATABASE_NAMES.has(infra.name.toLowerCase())) {
                    logger.debug(`[Sanitizer] Dropped local-IO concept as Database: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'local-IO concept (not a data store)');
                    return false;
                }
                // Storage mechanism / transport tokens not already in LOCAL_IO
                // ('sftp', 'ftp', ...) that the LLM mislabels as Database.
                if (isStorageTypeOrTransportToken(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped storage mechanism/transport token as Database: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'storage mechanism/transport token, not a data container');
                    return false;
                }
                // Drop PHP/JS class property names misclassified as table names.
                // Pattern: camelCase ending in a known config/IO suffix
                // (Path, FilePath, FileName, Filename, Pathname, Url, Uri, URL,
                //  URI, Endpoint, Hostname). Source: e.g.
                //   `file_get_contents($this->keyFilePath)` → LLM extracts
                //   `keyFilePath` as the "table". Real DB tables never use
                //   these tails. Snake_case (e.g. `user_path`) is exempt
                //   because that COULD be a real table.
                if (PROPERTY_NAME_DATABASE_SUFFIX.test(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped property-name as Database: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'property/variable name (not a table)');
                    return false;
                }
                // Cloud object storage names (`googlecloudstorage.bucket`,
                // `s3.bucket`, ...) are valid DataContainers, but the LLM emits
                // the `<provider>.` prefix and types them Database. REPAIR in
                // place: rename to the bare bucket, stamp kindFamily=object +
                // technology, and RETYPE to ObjectStorage so graph-writer routes
                // through its bucket path (promotes the object Datastore). A
                // bucket is a legitimate non-table container — never dropped.
                const cloud = splitCloudObjectName(infra.name);
                if (cloud) {
                    const oldName = infra.name;
                    infra.name = cloud.bucket;
                    (infra as any).kindFamily = 'object';
                    if (!infra.technology) infra.technology = cloud.technology;
                    (infra as any).type = 'ObjectStorage';
                    traceSanitizer('TRANSFORM', `infra:Database:${oldName}`, `cloud object storage repaired: bucket='${infra.name}', type=ObjectStorage, kindFamily=object, tech=${infra.technology}`, { resourceName: oldName, repairedName: infra.name, technology: infra.technology });
                    return true;
                }
                // Drop DI service-locator keys (e.g. 'archive.mongodb.client'):
                // the LLM extracts the container HANDLE as a table. The final
                // dotted segment is a data-handle suffix (client/manager/...),
                // never a logical container. Cloud buckets already returned above,
                // so this cannot touch a legitimately prefixed bucket.
                if (isDiServiceLocatorKey(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped DI service-locator key as Database: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'DI service-locator key (handle, not a data container)');
                    return false;
                }
                // Drop file-path leaks: the LLM sometimes misclassifies schema file references
                // (e.g. "schema/avro/output/save.avsc") as database table names.
                // Real table names never contain path separators or file extensions.
                if (infra.name.includes('/') || /\.\w{2,5}$/.test(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped file-path leak as Database: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:Database:${infra.name}`, 'file path leaked as table name');
                    return false;
                }
                // EVIDENCE-MANDATORY: every Database node must prove its existence.
                // If evidence is absent OR cannot be found in the source code, drop it.
                // This is the primary defense against LLM hallucinations.
                if (sourceCode) {
                    // Ground truth: if the table was explicitly resolved via ORM entity mapping, 
                    // it is NOT a hallucination even if the literal string is missing from this chunk.
                    if (allowedTableNames?.has(infra.name)) {
                        logger.debug(`[Sanitizer] Preserved ground-truth table: "${infra.name}"`);
                        traceSanitizer('PASS', `infra:Database:${infra.name}`, 'ground-truth table (ORM mapping)');
                        return true;
                    }

                    const evidence = (infra as any).evidence as string | undefined;
                    if (isHallucinatedTable(infra.name, evidence, sourceCode)) {
                        logger.debug(`[Sanitizer] Dropped hallucinated table (no valid evidence): "${infra.name}"`);
                        traceSanitizer('DROP', `infra:Database:${infra.name}`, 'no valid evidence in source code', { evidence });
                        return false;
                    }
                }
            }
            // Drop noisy broker names
            if (infra.type === 'MessageChannel') {
                // ── Source-Code False-Positive Guards ──────────────────────
                // Orchestrator audit revealed the LLM frequently mis-labels
                // non-broker I/O as MessageChannel when the function performs
                // DB / file-transport / internal dispatch. Run BEFORE any
                // resolution because some of these reclassify type→Database.

                // Document-DB collection access → Database (the driver
                // syntax is plugin grammar: PHP `->selectCollection(`,
                // Node `.getCollection(`).
                if (sourceCode && plugin?.recognizesDocumentCollectionAccess?.(sourceCode)) {
                    traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`, 'document collection access → Database', { from: 'MessageChannel', to: 'Database', resourceName: infra.name });
                    infra.type = 'Database';
                    return true;
                }

                // SQL write (INSERT INTO / UPDATE / DELETE FROM) → Database with the
                // table name extracted from the SQL literal (overrides whatever
                // name the LLM emitted as channel).
                //
                // BYPASS for write-then-publish: when the same function does both a
                // DB write AND a broker publish/consume, the LLM legitimately emits
                // one infra per side. The unconditional override here previously
                // hijacked the publisher/consumer infra as Database, losing the
                // MessageChannel and breaking DI-key resolution. Skip the transform
                // when the LLM's name is DI-shaped or already in the SymbolRegistry
                // — both signal a real broker reference, not a misclassified table.
                if (sourceCode) {
                    const sqlMatch = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"\[]?([a-zA-Z_][\w]*)/i.exec(sourceCode);
                    if (sqlMatch) {
                        const isDiBackedName =
                            DI_BROKER_SUFFIXES.test(infra.name)
                            || symbolRegistry?.resolve(infra.name, consumerFilePath) != null;
                        if (!isDiBackedName) {
                            traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`, 'SQL write → Database', { from: 'MessageChannel', to: 'Database', table: sqlMatch[1] });
                            infra.type = 'Database';
                            infra.name = sqlMatch[1];
                            return true;
                        }
                        traceSanitizer('PASS', `infra:MessageChannel:${infra.name}`, 'SQL write coexists with DI-backed broker — preserved', { sqlTable: sqlMatch[1] });
                    }
                }

                // File-transport senders (SftpSender, FtpClient, S3Uploader, ...).
                // These are remote file I/O wrappers, never broker channels.
                if (sourceCode && /\b(?:sftp|ftp|s3|gcs|blob|azure)[A-Za-z]*(?:Sender|Client|Uploader|Writer|Adapter)\b/.test(sourceCode)) {
                    logger.debug(`[Sanitizer] Dropped file-transport sender leak: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'file-transport sender (sftp/ftp/s3/gcs/blob)');
                    return false;
                }

                // Internal argument / parameter / payload / options names leak
                // as channel topics. Real routing keys never end in these tokens.
                if (/_(?:args|params|payload|options|context)$/i.test(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped internal argument-shaped channel: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'internal argument/option suffix');
                    return false;
                }

                // Middle-concat templates: `prefix_{var}_suffix`. The existing
                // `isUnresolvedTemplateName` only catches names anchored to
                // `^{...}$`. Mid-string `{var}` markers come from PHP/TS string
                // concatenation. Two policies based on placeholder casing:
                //
                //   {UPPERCASE} (e.g. {ENV}, {CLUSTER}): unresolvable deployment
                //   markers → drop unconditionally (existing rule pinned by
                //   infra-drop-filter.test.ts lines 978-990).
                //
                //   {lowercase|camelCase} (e.g. {envSuffix}, {tipo}): environment
                //   qualifiers → try envVarDict first; otherwise stem-strip the
                //   placeholder, collapse double separators, and keep only if
                //   the resulting stem is topic-shaped (contains `.`, length ≥ 3).
                //   This preserves `acme.inventory{envSuffix}.X.Y` (stems to
                //   `acme.inventory.X.Y`) but drops `quote_{tipo}` (stems to
                //   `quote`, no separator).
                if (!/^\{[^}]+\}$/.test(infra.name)) {
                    if (/\{[A-Z][A-Z0-9_]*\}/.test(infra.name)) {
                        logger.debug(`[Sanitizer] Dropped middle-concat with uppercase env marker: "${infra.name}"`);
                        traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'middle-concat uppercase env marker (unresolvable)');
                        return false;
                    }
                    if (/\{[a-z_][\w]*\}/.test(infra.name)) {
                        let resolved = infra.name;
                        if (envVarDict && envVarDict.size > 0) {
                            resolved = infra.name.replace(/\{([a-z_][\w]*)\}/g, (m, varName) => {
                                const binding = envVarDict.get(varName);
                                if (!binding) return m;
                                return typeof binding === 'string' ? binding : binding.value;
                            });
                        }
                        if (/\{[a-z_][\w]*\}/.test(resolved)) {
                            const stem = resolved
                                .replace(/\{[a-z_][\w]*\}/g, '')
                                .replace(/\.{2,}/g, '.')
                                .replace(/_{2,}/g, '_')
                                .replace(/^[._]+|[._]+$/g, '');
                            if (!stem || stem.length < 3 || !stem.includes('.')) {
                                logger.debug(`[Sanitizer] Dropped middle-concat unresolvable: "${infra.name}" stems to "${stem}" (not topic-shaped)`);
                                traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'middle-concat unresolvable to topic-shaped stem', { stem });
                                return false;
                            }
                            resolved = stem;
                        }
                        if (resolved !== infra.name) {
                            traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`, 'middle-concat resolved/stem-normalized', { from: infra.name, to: resolved });
                            infra.name = resolved;
                        }
                    }
                }

                // Technology hallucination scrub: the LLM stamps physical
                // technology labels (pubsub|kafka|rabbitmq|...) when nothing
                // in the source code supports it. Strip the field — Fix 3
                // (channel-technology-welder) will recover it from the broker
                // provider once edges resolve. Abstract bus labels
                // (symfony-messenger, mediatr, ...) are left alone.
                // The SDK-marker grammar lives in the language plugin
                // (`inferBrokerTechnology`): the declared tech is supported
                // when the plugin infers ANY physical transport from the
                // source (abstract-bus inferences like symfony-messenger do
                // not corroborate a physical label).
                const PHYSICAL_TECHS = new Set(['pubsub', 'kafka', 'rabbitmq', 'sqs', 'sns', 'azure-service-bus', 'nats']);
                const declaredTech = ((infra as any).technology ?? '').toLowerCase();
                if (sourceCode && PHYSICAL_TECHS.has(declaredTech)) {
                    const inferred = plugin?.inferBrokerTechnology?.(sourceCode);
                    const supported = inferred !== undefined && PHYSICAL_TECHS.has(inferred);
                    if (!supported) {
                        traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`, 'unsupported physical technology scrubbed', { from: declaredTech, to: null });
                        delete (infra as any).technology;
                    }
                }

                // ── AMQP Exchange Guard ────────────────────────────────────
                // Exchange declarations are infrastructure topology, not business events.
                // CodeRadius models message flow at the routing-key level.
                // Drop channels with pre-set channelKind='exchange' before any resolution.
                if (infra.channelKind === 'exchange') {
                    // Repair: an exchange entry that CARRIES a concrete,
                    // evidence-grounded routing key is a publish call (information
                    // complete), not a bare topology declaration. Promote the
                    // routing key to the channel identity instead of dropping —
                    // PUBLISHES_TO edges are keyed by routingKey downstream.
                    const routingKey = (infra as any).routingKey as string | undefined;
                    if (routingKey && sourceCode?.includes(routingKey)) {
                        traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`, 'exchange + evidence-grounded routing key → routing-key channel', {
                            exchange: infra.name,
                            routingKey,
                        });
                        infra.name = routingKey;
                        infra.channelKind = 'topic';
                        return true;
                    }
                    logger.debug(`[Sanitizer] Dropped AMQP exchange declaration: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'AMQP exchange (not a routing key)');
                    return false;
                }

                const normalizedConstantKey = infra.name.replace(/::/g, '.');
                const resolvedLiteral = resolvedConstantMap.get(infra.name) ?? resolvedConstantMap.get(normalizedConstantKey);
                if (resolvedLiteral) {
                    traceSanitizer('TRANSFORM', 'infra:MessageChannel', 'resolved constant to literal', {
                        from: infra.name,
                        to: resolvedLiteral,
                    });
                    infra.name = resolvedLiteral.replace(/^['"]|['"]$/g, '');
                }

                // ── DI Resolution ────────────────────────────────────────
                // Try SymbolRegistry first (physical name from config)
                // We always check the registry because LLM-extracted config properties
                // (like evtTopicSave) may lack DI suffixes and the LLM no longer emits isDiKey.
                const binding = symbolRegistry?.resolve(infra.name, consumerFilePath);

                if (binding) {
                        const originalName = infra.name;

                        // ── Source-Evidence Cross-Check ──────────────────────
                        // If the LLM emitted a DI key that doesn't appear in
                        // this function's source code, it may have confused
                        // sibling config keys from the same file.
                        // Strategy 1: Check if a sibling key IS in the source.
                        // Strategy 2: Use functionName semantic proximity as tiebreaker.
                        let finalBinding = binding;
                        if (sourceCode && !sourceCode.includes(originalName)) {
                            // Extract prefix: appChannelSave → appChannel
                            const prefixMatch = originalName.match(/^([a-z]+[A-Z][a-zA-Z]*?(?=[A-Z][a-z]))/);
                            const prefix = prefixMatch ? prefixMatch[1] : null;
                            if (prefix && symbolRegistry) {
                                // Collect all sibling keys with the same prefix
                                const siblings = symbolRegistry.getAll().filter(
                                    c => c.key !== originalName && c.key.startsWith(prefix),
                                );

                                // Strategy 1: source-code evidence
                                const sourceMatch = siblings.find(c => sourceCode.includes(c.key));
                                if (sourceMatch) {
                                    logger.debug(`[Sanitizer] DI cross-check: LLM emitted "${originalName}" but source contains sibling "${sourceMatch.key}" → "${sourceMatch.value}"`);
                                    traceSanitizer('TRANSFORM', 'infra:MessageChannel', 'DI cross-check corrected via source evidence', {
                                        from: originalName, llmSuggested: binding.value,
                                        correctedKey: sourceMatch.key, to: sourceMatch.value, method: 'di_cross_check',
                                    });
                                    finalBinding = sourceMatch;
                                }
                                // Strategy 2: function-name semantic proximity
                                // e.g. functionName="sendShipmentV2" → tokens ["shipment", "v2"]
                                // sibling key "appChannelShipmentBundleV2" → tokens ["Shipment", "Bundle", "V2"]
                                // Better match than "appChannelSave" → tokens ["Save"]
                                else if (functionName && siblings.length > 0) {
                                    const fnLower = functionName.toLowerCase();
                                    // Score each sibling: how many of its suffix tokens appear in the function name
                                    let bestCandidate: typeof siblings[0] | null = null;
                                    let bestScore = 0;
                                    for (const sibling of siblings) {
                                        const suffix = sibling.key.slice(prefix.length);
                                        // Split camelCase suffix into tokens
                                        const tokens = suffix.replace(/([A-Z])/g, ' $1').trim().toLowerCase().split(/\s+/);
                                        const score = tokens.filter(t => t.length >= 2 && fnLower.includes(t)).length;
                                        if (score > bestScore) {
                                            bestScore = score;
                                            bestCandidate = sibling;
                                        }
                                    }
                                    // Also score the original binding
                                    const origSuffix = originalName.slice(prefix.length);
                                    const origTokens = origSuffix.replace(/([A-Z])/g, ' $1').trim().toLowerCase().split(/\s+/);
                                    const origScore = origTokens.filter(t => t.length >= 2 && fnLower.includes(t)).length;

                                    if (bestCandidate && bestScore > origScore) {
                                        logger.debug(`[Sanitizer] DI cross-check: function "${functionName}" semantically matches sibling "${bestCandidate.key}" (score ${bestScore}) over "${originalName}" (score ${origScore})`);
                                        traceSanitizer('TRANSFORM', 'infra:MessageChannel', 'DI cross-check corrected via function-name semantics', {
                                            from: originalName, llmSuggested: binding.value,
                                            correctedKey: bestCandidate.key, to: bestCandidate.value,
                                            method: 'di_semantic_check', scores: { original: origScore, corrected: bestScore },
                                        });
                                        finalBinding = bestCandidate;
                                    }
                                }
                            }
                        }

                        infra.name = finalBinding.value;
                        (infra as any).resolved_via = finalBinding === binding ? 'di_registry' : 'di_cross_check';
                        
                        // ── Infer channelKind to prevent URN duplicates ──────────
                        if (!infra.channelKind) {
                            const searchStr = `${originalName} ${infra.name}`.toLowerCase();
                            if (searchStr.includes('topic') || searchStr.includes('publish') || searchStr.includes('producer')) {
                                infra.channelKind = 'topic';
                            } else if (searchStr.includes('queue')) {
                                infra.channelKind = 'queue';
                            } else if (searchStr.includes('sub') || searchStr.includes('consumer') || searchStr.includes('pull')) {
                                infra.channelKind = 'subscription';
                            } else if (searchStr.includes('exchange')) {
                                infra.channelKind = 'exchange';
                            } else {
                                infra.channelKind = infra.operation === 'WRITES' ? 'topic' : 'subscription';
                            }
                        }
                        
                        logger.debug(`[Sanitizer] DI resolved "${originalName}" → "${finalBinding.value}" via ${(infra as any).resolved_via} (kind: ${infra.channelKind})`);
                        traceSanitizer('TRANSFORM', 'infra:MessageChannel', 'DI resolved via registry', {
                            from: originalName,
                            to: finalBinding.resolvedValue ?? finalBinding.value,
                            rawValue: finalBinding.rawValue,
                            symbolKey: finalBinding.key,
                            sourceFile: finalBinding.sourceFile,
                            method: (infra as any).resolved_via,
                        });
                    } else {
                        // ── Step 1b: Snake→PascalCase fallback ────────────────────
                        // The LLM converts PHP message class names to snake_case:
                        //   ProductQuoteMessage → product_quote_message
                        // The SymbolRegistry has the binding under PascalCase.
                        // Try the inverse transformation only on PURE snake_case
                        // names: `^[a-z][a-z0-9]*(_[a-z0-9]+)+$`. Mixed names like
                        // `acme.order_created` (dot+underscore) would split on '_'
                        // and produce nonsense PascalCase that's a guaranteed
                        // registry miss — skip the wasted lookup.
                        if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(infra.name)) {
                            const pascalCase = infra.name
                                .split('_')
                                .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
                                .join('');
                            const pascalBinding = symbolRegistry?.resolve(pascalCase, consumerFilePath);
                            if (pascalBinding) {
                                const originalName = infra.name;
                                infra.name = pascalBinding.value;
                                (infra as any).resolved_via = 'di_registry';
                                if (!infra.channelKind) {
                                    infra.channelKind = infra.operation === 'WRITES' ? 'topic' : 'subscription';
                                }
                                logger.debug(`[Sanitizer] DI resolved via snake→pascal: "${originalName}" → "${pascalCase}" → "${pascalBinding.value}"`);
                                traceSanitizer('TRANSFORM', 'infra:MessageChannel', 'DI resolved via snake→pascal conversion', {
                                    from: originalName, pascalKey: pascalCase, to: pascalBinding.value,
                                    method: 'snake_to_pascal',
                                });
                            }
                        }
                    }

                    if (!binding && !((infra as any).resolved_via) && ((infra as any).isDiKey === true || DI_BROKER_SUFFIXES.test(infra.name))) {
                        // ── Step 2: Drop unresolved DI service identifiers ─────────
                        // Names matching DI suffixes (.publisher, .consumer, .sender, etc.)
                        // without a SymbolRegistry binding are service object references,
                        // not routing keys. We don't know what physical topic/queue they
                        // actually publish to or consume from — stripping the suffix to
                        // produce a bare logical name (e.g. 'notpurchasable.publisher' →
                        // 'notpurchasable') creates a meaningless ghost MessageChannel.
                        // The publisher/consumer function still exists in the graph; only
                        // the channel link is omitted because it's unknowable statically.
                        logger.debug(`[Sanitizer] Dropped unresolved DI service identifier: "${infra.name}"`);
                        traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'unresolved DI service identifier (no registry binding)');
                        return false;
                    }


                // ── Property-Access & Class-Constant Guard ─────────────────
                // MUST run BEFORE exchange-prefix stripping: PHP double-colon patterns
                // (e.g. MyAmqpConfig::QUEUE_NAME) contain ':', so the split below would
                // reduce them to just 'QUEUE_NAME' before this guard could fire.
                // Drops:
                //   - Instance property access : this.xxx, self.xxx
                //   - Static class constants   : ClassName.CONSTANT (TS/JS/Java)
                //                                ClassName::CONSTANT (PHP/C++)
                // Heuristic: PascalCase prefix (upper + lower + rest) + '.' or '::'.
                // Excludes lowercase routing keys like 'order.created.result.preferred'.
                if (/^(this|self)\./i.test(infra.name) || /^[A-Z][\w]*(\.|(::))\w+/.test(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped property-access broker: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'property-access pattern');
                    return false;
                }

                // ── Exchange-Prefix Stripping ──────────────────────────────
                // If the resolved/extracted name contains ':' (e.g., "payments_exchange:payment.completed.v2"),
                // it's an exchange:routing_key concatenation. Strip the exchange prefix to prevent
                // duplicate nodes (the raw routing key may already exist as a separate node).
                // NOTE: PHP ClassName::CONSTANT patterns are already dropped above.
                if (infra.name.includes(':')) {
                    const parts = infra.name.split(':');
                    const routingKey = parts[parts.length - 1];
                    logger.debug(`[Sanitizer] Stripped exchange prefix: "${infra.name}" → "${routingKey}"`);
                    traceSanitizer('TRANSFORM', 'infra:MessageChannel', 'stripped exchange prefix', { from: infra.name, to: routingKey });
                    infra.name = routingKey;
                }
                // ── DI Token / Constant Guard ───────────────────────────────
                // Fully-uppercase names with underscores are DI tokens, enum values,
                // or class constants — NEVER physical queue/topic/routing key names.
                // Real MessageChannels use: dot.separated, kebab-case, camelCase, or PascalCase.
                // Defense-in-depth: before dropping, try resolving via common access patterns
                // (this.NAME, self.NAME) against the resolvedConstantMap.
                const isUpperSnakeCase = /^[A-Z0-9_]+$/.test(infra.name) && infra.name.includes('_');
                if (isUpperSnakeCase) {
                    const prefixVariants = [`this.${infra.name}`, `self.${infra.name}`, infra.name];
                    const resolvedUpper = prefixVariants
                        .map(key => resolvedConstantMap.get(key))
                        .find(Boolean);
                    if (resolvedUpper) {
                        const originalUpper = infra.name;
                        infra.name = resolvedUpper.replace(/^['"]|['"]$/g, '');
                        traceSanitizer('TRANSFORM', `infra:MessageChannel:${originalUpper}`, 'resolved uppercase constant via fallback', {
                            from: originalUpper, to: infra.name,
                        });
                    } else {
                        logger.debug(`[Sanitizer] Dropped DI token/constant: "${infra.name}"`);
                        traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'uppercase constant (DI token / enum)');
                        return false;
                    }
                }

                // ── Transactional Outbox Pattern ────────────────────────────
                // Names containing '_outbox' or 'outbox_' are database tables
                // (Transactional Outbox pattern), NOT message channels.
                // Reclassify them to Database so the graph-writer creates a
                // DataContainer node instead of a MessageChannel.
                // ── DI Service Key Suffix Guard ──────────────────────────────
                // PHP Symfony DI container keys like "acme-partner.acme-vendor.adapter" are
                // fetched via $container->get(). These dot-separated names look like
                // routing keys but are service identifiers. Drop names ending with
                // known DI-convention suffixes that are never routing key terminators.
                //
                // Overlap note (intentional, defense-in-depth):
                // - `.client` / `.handler` would also be dropped earlier by
                //   `DI_BROKER_SUFFIXES` in the unresolved-DI guard (line ~728).
                // - `.service` would be dropped later by `INFRA_HOSTNAME_SUFFIX`
                //   in `isNoisyBrokerName` (line ~115).
                // Listing them explicitly here keeps this guard self-sufficient:
                // if either of the other two regexes is refactored or removed,
                // we still drop the same set of DI service identifiers.
                const DI_SERVICE_KEY_SUFFIX = /\.(adapter|factory|provider|connection|transport|manager|resolver|gateway|mapper|proxy|decorator|service|client|handler)$/i;
                if (DI_SERVICE_KEY_SUFFIX.test(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped DI service key: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'DI service key suffix');
                    return false;
                }

                const nameLower = infra.name.toLowerCase();
                if (nameLower.includes('_outbox') || nameLower.includes('outbox_') || nameLower.endsWith('outbox')) {
                    logger.debug(`[Sanitizer] Reclassified outbox table: "${infra.name}" MessageChannel → Database`);
                    traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`, 'transactional outbox pattern → reclassified to Database', {
                        from: 'MessageChannel', to: 'Database', resourceName: infra.name,
                    });
                    infra.type = 'Database';
                    return true; // Keep it — but now as a Database node
                }

                // In-process events are NOT broker channels (PHP: Symfony
                // EventDispatcher `dispatch(new XxxEvent(...))` is a
                // synchronous notification; transport markers in the same
                // source win and keep the channel). The language plugin owns
                // the dispatcher/transport grammar.
                if (sourceCode && plugin?.recognizesInProcessEvent?.(infra.name, sourceCode)) {
                    logger.debug(`[Sanitizer] Dropped in-process event: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'in-process event dispatch (not a broker channel)');
                    return false;
                }

                // CQRS class constructed as a PUBLISH PAYLOAD is not a channel.
                // The event class sent as the message BODY of a physical
                // publish call is a DTO; the channel is the topic the
                // publisher targets, resolved elsewhere. The generic CQRS
                // name gate stays here; the construction grammar (PHP:
                // `->publish(new \Ns\OrderPlacedEvent(...))`, verb-scoped so
                // abstract-bus `->dispatch(new X)` is NOT matched) is
                // plugin-owned. Fires even when the wrapper hides the SDK
                // import so the transport is unknown (the keystone field
                // case: publish through a custom PubSubPublisher wrapper).
                if (sourceCode && CQRS_MESSAGE_PATTERN.test(infra.name)
                    && plugin?.recognizesPublishPayloadConstruction?.(infra.name, sourceCode)) {
                    logger.debug(`[Sanitizer] Dropped publish-payload class: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'CQRS class constructed as a publish payload (not a channel)');
                    return false;
                }

                // Platform-local I/O builtin masquerading as MessageChannel
                // (PHP: `error_log()`, `syslog()`, `openlog()` write to the
                // local logging facility, not to a broker). The language
                // plugin owns the builtin grammar AND the source-evidence
                // scan (string/comment-masked call check — no name-only
                // blocklist, per memory rule).
                if (sourceCode && plugin?.recognizesPlatformIoBuiltin?.(infra.name, sourceCode)) {
                    logger.debug(`[Sanitizer] Dropped platform I/O builtin: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'platform I/O builtin (plugin grammar)');
                    return false;
                }

                // ── Technology Inference from source context ──────────────
                // MUST run BEFORE the noisy-broker gate AND channelKind inference:
                // technology gates the CQRS exemption. A *Event/*Message class is a
                // routing contract on an abstract bus (symfony-messenger) but a DTO
                // payload over a physical transport (Pub/Sub, Kafka, ...), so the gate
                // can only drop the phantom once the source-inferred transport is known.
                if (!(infra as any).technology && sourceCode) {
                    // SDK-marker → technology tables are ecosystem grammar:
                    // each language plugin owns its own ordered table
                    // (`inferBrokerTechnology`); the sanitizer only consumes
                    // the inferred id.
                    const inferredTech = plugin?.inferBrokerTechnology?.(sourceCode);
                    if (inferredTech) {
                        (infra as any).technology = inferredTech;
                        traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`,
                            `inferred technology=${inferredTech} from source context`);
                    }
                }

                // Framework DI ids are handles, not channels — even when a
                // resolver stamped resolved_via (a name still shaped like the
                // DI namespace was not resolved to a physical name). The
                // language plugin owns the ecosystem grammar (doctrine.*,
                // rabbitmq.producer.*, *_transport); checked BEFORE the
                // resolved-trust bypass inside isNoisyBrokerName.
                if (plugin?.recognizesFrameworkDiHandle?.(infra.name, 'channel')) {
                    logger.debug(`[Sanitizer] Dropped framework DI handle: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'framework DI handle (plugin grammar)');
                    return false;
                }

                // No matter how it was resolved, if the final name is purely generic ("bus"), drop it.
                // But if it was successfully resolved via the DI registry, we trust its PascalCase shape.
                const wasResolved = (infra as any).resolved_via === 'di_registry' || (infra as any).resolved_via === 'di_cross_check';
                if (isNoisyBrokerName(infra.name, wasResolved, (infra as any).technology)) {
                    logger.debug(`[Sanitizer] Dropped noisy broker: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'noisy broker name');
                    return false;
                }

                // Evidence-based DI guard, POST-resolution: an UNRESOLVED name
                // whose sole source occurrence is a service-locator getter arg
                // (PSR-11 / ServiceManager contract) is a DI handle the
                // registry could not map to a physical channel — drop it.
                // Resolved names already carry the physical identity and are
                // exempt (the resolution pipeline is the intended path).
                if (!wasResolved && sourceCode
                    && plugin?.recognizesServiceLocatorKey?.(infra.name, sourceCode)) {
                    logger.debug(`[Sanitizer] Dropped unresolved service-locator channel key: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'service-locator key (unresolved DI handle)');
                    return false;
                }
                // Drop broker names with unresolved config templates (e.g. {ENV}, {CLUSTER})
                // This catches names resolved from SymbolRegistry that still contain placeholders.
                // BEFORE dropping, attempt resolution via envVarDict — the deployment config
                // may have the physical value (e.g. {BUS_TOPIC_SAVE} → "Acme-OrderCreated").
                if (isUnresolvedTemplateName(infra.name)) {
                    let resolved = false;
                    if (envVarDict && envVarDict.size > 0) {
                        // Strip the curly braces to get the raw env var name
                        const rawEnvVar = infra.name.replace(/^\{|\}$/g, '');
                        const envResolved = resolveMessageChannelName(rawEnvVar, envVarDict);
                        if (envResolved !== rawEnvVar) {
                            logger.debug(`[Sanitizer] Resolved template via envVarDict: "${infra.name}" -> "${envResolved}"`);
                            traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`, 'resolved config template via envVarDict', { from: infra.name, to: envResolved });
                            infra.name = envResolved;
                            resolved = true;
                        }
                    }
                    if (!resolved) {
                        // Stem normalization: strip known env-suffix placeholders
                        // ({envSuffix}, {env}, etc.) to recover the canonical topic
                        // identity. Mirrors the downstream dynamic-infra-resolver
                        // behavior, applied earlier in the pipeline so the channel
                        // survives the LLM->graph hop with its canonical name.
                        const stemmed = normalizeEnvPlaceholder(infra.name);
                        if (stemmed) {
                            logger.debug(`[Sanitizer] Stem-normalized env placeholder: "${infra.name}" -> "${stemmed}"`);
                            traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`, 'stem-normalized env placeholder', { from: infra.name, to: stemmed });
                            infra.name = stemmed;
                        } else {
                            logger.debug(`[Sanitizer] Dropped broker with unresolved template: "${infra.name}"`);
                            traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'unresolved config template');
                            return false;
                        }
                    }
                }

                if (isPurelyDynamicPlaceholder(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped purely dynamic broker placeholder: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:MessageChannel:${infra.name}`, 'purely dynamic placeholder — no static prefix');
                    return false;
                }

                // ── Universal channelKind Inference (ALL surviving channels) ──────────
                // Guarantees every MessageChannel gets a channelKind before reaching
                // the graph-writer. This prevents kindless URN duplicates.
                if (!infra.channelKind) {
                    const tech = ((infra as any).technology ?? '').toLowerCase();
                    const isAbstractBus = !tech || ABSTRACT_BUS_TECHNOLOGIES.has(tech);

                    if (isAbstractBus && CQRS_MESSAGE_PATTERN.test(infra.name)) {
                        // CQRS class → topic (publisher + consumer converge on same URN)
                        infra.channelKind = 'topic';
                    } else {
                        const hint = `${infra.name} ${tech}`.toLowerCase();
                        if (hint.includes('exchange')) {
                            infra.channelKind = 'exchange';
                        } else if (hint.includes('queue') || hint.includes('dlq')) {
                            infra.channelKind = 'queue';
                        } else if (/\bsub(?:scription)?\b/.test(hint) && !hint.includes('submit')) {
                            infra.channelKind = 'subscription';
                        } else {
                            // Default: topic (universal entrypoint)
                            infra.channelKind = 'topic';
                        }
                    }
                    traceSanitizer('TRANSFORM', `infra:MessageChannel:${infra.name}`,
                        `inferred channelKind=${infra.channelKind} (universal fallback)`);
                }
            }
            if (infra.type === 'ObjectStorage') {
                // Repair a <provider>.<bucket> name (the LLM types cloud storage as
                // ObjectStorage, per unified-analyzer normalizeInfraType, and keeps
                // the prefix): rename to the bare bucket and stamp kindFamily=object
                // + technology so graph-writer promotes the object Datastore. A
                // bucket is a legitimate non-table container — repaired, not dropped.
                const cloudOs = splitCloudObjectName(infra.name);
                if (cloudOs) {
                    const oldName = infra.name;
                    infra.name = cloudOs.bucket;
                    (infra as any).kindFamily = 'object';
                    if (!infra.technology) infra.technology = cloudOs.technology;
                    traceSanitizer('TRANSFORM', `infra:ObjectStorage:${oldName}`, `cloud object storage repaired: bucket='${infra.name}', kindFamily=object, tech=${infra.technology}`, { resourceName: oldName, repairedName: infra.name, technology: infra.technology });
                    return true;
                }
                // Drop the storage mechanism/transport word itself (the LLM
                // emits file I/O as ObjectStorage, so 'filesystem'/'sftp'/'ftp'
                // arrive here as a bare token). The TYPE is not a container.
                if (isStorageTypeOrTransportToken(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped storage mechanism/transport token as ObjectStorage: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:ObjectStorage:${infra.name}`, 'storage mechanism/transport token, not a data container');
                    return false;
                }
                // DI service-locator keys mislabeled as ObjectStorage (handle, not a bucket).
                if (isDiServiceLocatorKey(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped DI service-locator key as ObjectStorage: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:ObjectStorage:${infra.name}`, 'DI service-locator key (handle, not a data container)');
                    return false;
                }
                if (infra.name.includes('/') || /\.\w{2,5}$/.test(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped file-path leak as ObjectStorage: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:ObjectStorage:${infra.name}`, 'file path leaked as resource name');
                    return false;
                }
                // Same property-name guard as Database: e.g. when the LLM emits
                // `$this->keyFilePath` as ObjectStorage instead of Database.
                // PHP/JS class property names ending in Path/FilePath/Url/Endpoint
                // are NEVER real cloud-storage container names.
                if (PROPERTY_NAME_DATABASE_SUFFIX.test(infra.name)) {
                    logger.debug(`[Sanitizer] Dropped property-name as ObjectStorage: "${infra.name}"`);
                    traceSanitizer('DROP', `infra:ObjectStorage:${infra.name}`, 'property/variable name (not a resource)');
                    return false;
                }
            }
            return true;
        });
        const dropped = originalCount - clean.infrastructure.length;
        if (dropped > 0) {
            logger.debug(`[Sanitizer] Filtered ${dropped} infrastructure item(s)`);
            traceSanitizer('INFO', consumerFilePath || 'unknown', `filtered ${dropped} infrastructure items`, { droppedCount: dropped, survivingCount: clean.infrastructure.length });
        }
    }

    // ── Reclassify body-shape GraphQL emergents (defense-in-depth) ───────
    // Even with graphQLDocumentContext injected upstream, the LLM occasionally
    // emits a plain HTTP emergent for a call whose source clearly declares a
    // GraphQL operation (e.g. `file_get_contents('Foo.gql')` whose contents
    // start with `mutation Foo { ... }`, or an inline gql template). Rewrite
    // those to the canonical `GRAPHQL <op> <name>` shape so the L0 GQL weld
    // branch in global-resolver picks them up.
    if ('emergent_api_calls' in clean && clean.emergent_api_calls && sourceCode) {
        for (const call of clean.emergent_api_calls) {
            const reclassified = reclassifyEmergentToGraphQL(call, sourceCode);
            if (reclassified) {
                traceSanitizer(
                    'TRANSFORM',
                    `api:${call.method ?? 'NULL'} ${call.path}`,
                    'reclassified HTTP emergent → GraphQL via body-shape rule',
                    { previousPath: reclassified.previousPath, operationName: reclassified.operationName },
                );
            }
        }
    }

    // ── Filter emergent API calls ────────────────────────────────────────
    if ('emergent_api_calls' in clean && clean.emergent_api_calls) {
        clean.emergent_api_calls = clean.emergent_api_calls.filter(call => {
            if (isNoisyEndpoint(call.path)) {
                logger.debug(`[Sanitizer] Dropped noisy endpoint: "${call.path}"`);
                traceSanitizer('DROP', `api:${call.method || 'UNKNOWN'} ${call.path}`, 'noisy endpoint', { path: call.path });
                return false;
            }

            // Evidence-Based guard for INBOUND paths:
            // A legitimate INBOUND endpoint MUST be declared as a string literal
            // in the function's sourceCode (annotation, router call, attribute).
            // OUTBOUND has its own (looser) shape guard below to catch class-name
            // hallucinations from PSR-18 wrapper delegations.
            //
            // Delegation order (Strategy Pattern):
            //   1. plugin.validateInboundPath() — language-specific evidence rules
            //   2. isInboundPathEvident()        — generic polyglot fallback
            const direction = (call as any).direction ?? 'OUTBOUND';

            if (direction === 'OUTBOUND' && sourceCode && !isGraphQLPath(call.path)) {
                const infra = ('infrastructure' in clean ? (clean.infrastructure ?? []) : []) as ReadonlyArray<{ name: string; type: string }>;
                if (isHallucinatedOutboundPath(call.path, sourceCode, infra)) {
                    logger.debug(`[Sanitizer] Dropped OUTBOUND class-name hallucination: "${call.path}"`);
                    traceSanitizer('DROP', `api:${call.method || 'UNKNOWN'} ${call.path}`, 'OUTBOUND path shape: class-name / class.method / hostname-kept / infra-double-count', { path: call.path });
                    return false;
                }
            }

            if (direction === 'INBOUND' && sourceCode) {
                if (allowedApiPaths?.has(call.path)) {
                    traceSanitizer('PASS', `api:${call.method || 'UNKNOWN'} ${call.path}`, 'ground-truth inbound path (framework signal)', { path: call.path });
                    return true;
                }

                if (isGraphQLPath(call.path)) {
                    // GraphQL INBOUND: soft guard — plugin may return true (confirmed) or
                    // undefined (defer to LLM). Only drop on explicit false (strong counter-evidence).
                    // We never default-drop GQL INBOUND because evidence patterns are too varied
                    // (builder APIs, codegen, resolver maps) to be reliably checked by regex.
                    const evident = plugin?.validateInboundPath?.(call.path, sourceCode);
                    if (evident === false) {
                        logger.debug(`[Sanitizer] Dropped GQL INBOUND (strong counter-evidence): "${call.path}"`);
                        traceSanitizer('DROP', `api:${call.method || 'UNKNOWN'} ${call.path}`, 'GQL INBOUND counter-evidence', { path: call.path });
                        return false;
                    }
                    // undefined | true → keep (trust LLM for GraphQL)
                } else {
                    // HTTP INBOUND: strict evidence guard (existing logic)
                    const evident = plugin?.validateInboundPath?.(call.path, sourceCode)
                        ?? isInboundPathEvident(call.path, sourceCode);
                    if (!evident) {
                        logger.debug(`[Sanitizer] Dropped INBOUND ghost (class-name inference): "${call.path}"`);
                        traceSanitizer('DROP', `api:${call.method || 'UNKNOWN'} ${call.path}`, 'INBOUND path not in source (class-name inference)', { path: call.path });
                        return false;
                    }
                }
            }

            return true;
        });
    }

    // ── Phase 2 (Fix #3): AST opaque-recovery ───────────────────────────
    // BEFORE the drop filters below: when the LLM marked a payload with
    // `_opaque_reference`, the AST may still have walked the literal class
    // definition. Match on `basename` (already plugin-stripped) and
    // override the fields. The drop filters then operate on the recovered
    // payload, so a recovered payload that happens to match a service
    // interface still gets dropped — recovery is fields-only.
    if (astResolvedPayloads && astResolvedPayloads.length > 0) {
        if ('produced_payloads' in clean && clean.produced_payloads) {
            for (const payload of clean.produced_payloads) {
                const isOpaque = payload.fields?.some(f => f.name === '_opaque_reference');
                if (!isOpaque) continue;
                const match = astResolvedPayloads.find(
                    a => a.direction === 'produced' && a.basename === payload.name,
                );
                if (match) {
                    payload.fields = match.fields.map(f => ({ ...f, required: true }));
                    traceSanitizer('TRANSFORM', `produced_payload:${payload.name}`, 'opaque → AST-resolved');
                }
            }
        }
        if ('consumed_payloads' in clean && clean.consumed_payloads) {
            for (const payload of clean.consumed_payloads) {
                const isOpaque = payload.fields?.some(f => f.name === '_opaque_reference');
                if (!isOpaque) continue;
                const match = astResolvedPayloads.find(
                    a => a.direction === 'consumed' && a.basename === payload.name,
                );
                if (match) {
                    payload.fields = match.fields.map(f => ({ ...f, required: true }));
                    traceSanitizer('TRANSFORM', `consumed_payload:${payload.name}`, 'opaque → AST-resolved');
                }
            }
        }
    }

    // ── Filter payload names with unresolved templates ───────────────────
    if ('produced_payloads' in clean && clean.produced_payloads) {
        clean.produced_payloads = clean.produced_payloads.filter(p => {
            if (isUnresolvedTemplateName(p.name)) {
                logger.debug(`[Sanitizer] Dropped produced payload with template name: "${p.name}"`);
                traceSanitizer('DROP', `produced_payload:${p.name}`, 'unresolved template variable');
                return false;
            }
            // Drop ORM entity class names — these are database schemas, not message payloads
            if (entityClassNames && entityClassNames.has(p.name)) {
                logger.debug(`[Sanitizer] Dropped produced payload matching ORM entity: "${p.name}"`);
                traceSanitizer('DROP', `produced_payload:${p.name}`, 'ORM entity class (not a message payload)');
                return false;
            }
            // Drop names that match AST-grounded service-interfaces (interfaces with
            // method signatures). These are service contracts (e.g. UserRepository),
            // not message payloads. Data-interfaces (interface User { id: string })
            // have interfaceRole='data' and are NOT in the set, so they're preserved.
            if (knownServiceInterfaces && knownServiceInterfaces.has(p.name)) {
                logger.debug(`[Sanitizer] Dropped produced payload matching service-interface: "${p.name}"`);
                traceSanitizer('DROP', `produced_payload:${p.name}`, 'service-interface (AST-verified, has method signatures)');
                return false;
            }
            return true;
        });
    }
    if ('consumed_payloads' in clean && clean.consumed_payloads) {
        clean.consumed_payloads = clean.consumed_payloads.filter(p => {
            if (isUnresolvedTemplateName(p.name)) {
                logger.debug(`[Sanitizer] Dropped consumed payload with template name: "${p.name}"`);
                traceSanitizer('DROP', `consumed_payload:${p.name}`, 'unresolved template variable');
                return false;
            }
            // Drop ORM entity class names — these are database schemas, not message payloads
            if (entityClassNames && entityClassNames.has(p.name)) {
                logger.debug(`[Sanitizer] Dropped consumed payload matching ORM entity: "${p.name}"`);
                traceSanitizer('DROP', `consumed_payload:${p.name}`, 'ORM entity class (not a message payload)');
                return false;
            }
            // Symmetric service-interface filter on consumed side: without it,
            // half the noise (functions that "consume" a service-interface) passes.
            if (knownServiceInterfaces && knownServiceInterfaces.has(p.name)) {
                logger.debug(`[Sanitizer] Dropped consumed payload matching service-interface: "${p.name}"`);
                traceSanitizer('DROP', `consumed_payload:${p.name}`, 'service-interface (AST-verified, has method signatures)');
                return false;
            }
            return true;
        });
    }

    return clean;
}
