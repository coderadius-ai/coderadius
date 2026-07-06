import { z } from 'zod';
import { telemetryCollector } from '../../telemetry/index.js';
import { traceCollector } from '../../telemetry/index.js';
import { logger } from '../../utils/logger.js';
import { Agent } from '@mastra/core/agent';
import { getModel, getModelByProvider, detectFallbackProvider } from '../models/provider.js';
import { configManager } from '../../config/index.js';
import type { ProviderId } from '../../config/schema.js';
import type { CodeChunk } from '../../graph/types.js';
import type { ScanMode } from '../../graph/scan-mode.js';
import { getLanguagePlugin } from '../../ingestion/core/languages/registry.js';
import { withCongestionControl, isConnectionError, EndpointUnreachableError, MaxRetriesExceededError } from '../../utils/congestion-control.js';
import type { AIMDSemaphore } from '../../utils/aimd-semaphore.js';
import type { GroundingFields } from '../../graph/grounding.js';

// ─── Response Schema ─────────────────────────────────────────────────────────

type InfraType = 'Database' | 'MessageChannel' | 'Cache' | 'ObjectStorage' | 'ExternalAPI' | 'Process';
type InfraOperation = 'READS' | 'WRITES' | 'MAPS_TO';

type InfraRef = {
    name: string;
    type: InfraType;
    operation: InfraOperation;
    evidence?: string;
    channelKind?: 'topic' | 'subscription' | 'queue' | 'exchange';
    schemaFormat?: 'avro' | 'json-schema' | 'protobuf';
    schemaPath?: string;
    technology?: string;
    /**
     * Provenance discriminator. Defaults to `'llm'` (the field is absent on
     * entries returned directly by the unified-analyzer). Set to `'ast'` by
     * the framework-signal overlay so the graph-writer can stamp
     * deterministic-extracted nodes with `ast/exact` grounding instead of
     * `llm/medium`. Stored in `_internal_` style — never sent to the LLM.
     */
    source?: 'ast' | 'llm';
    /**
     * Sub-extractor tag for composite grounding. Optional
     * snake_case string consumed by graph-writer when building the
     * `astGrounding(`static-${resolved_via}@v1`)` half of the composite.
     * Set by the DI-bypass static path to mark items as `di-propagator-hop<N>`
     * provenance without abusing the `source` discriminator.
     */
    resolved_via?: string;
    /**
     * Explicit grounding override. When present, takes precedence over
     * `source` / `resolved_via` heuristics in the graph-writer. Used by the
     * DI binding registry static-bypass path to stamp deterministic-extracted
     * MessageChannel/Database items with composite AST grounding plus DI
     * evidence (`evidence.extractors=['di-binding-resolver@v1','di-propagator-hop<N>@v1']`).
     */
    grounding?: GroundingFields;
    // MessageChannel edge-level metadata. These travel from the LLM extraction
    // all the way to the graph as properties on the PUBLISHES_TO / LISTENS_TO
    // edge so that two `publish(exchange='X', routing_key='Y' / 'Z')` call sites
    // produce two distinct edges instead of collapsing into one.
    routingKey?: string;
    partitionKey?: string;
    consumerGroup?: string;
};

const CANONICAL_INFRA_TYPE: Record<string, InfraType> = {
    database: 'Database',
    messagechannel: 'MessageChannel',
    channel: 'MessageChannel',
    cache: 'Cache',
    objectstorage: 'ObjectStorage',
    externalapi: 'ExternalAPI',
    process: 'Process',
};

function normalizeInfraType(rawType: string): InfraType | null {
    const lower = rawType.toLowerCase().trim();
    if (!lower) return null;

    const exact = CANONICAL_INFRA_TYPE[lower];
    if (exact) return exact;

    if (lower.includes('database') || lower === 'db' || lower.includes('sql') || lower.includes('mongo')) return 'Database';
    if (lower.includes('channel') || lower.includes('broker') || lower.includes('queue') || lower.includes('kafka') || lower.includes('topic') || lower.includes('pubsub') || lower.includes('sqs') || lower.includes('rabbitmq') || lower.includes('event')) return 'MessageChannel';
    if (lower.includes('cache') || lower.includes('redis') || lower.includes('memcached')) return 'Cache';
    if (lower.includes('storage') || lower.includes('bucket') || lower.includes('blob') || lower.includes('s3') || lower.includes('gcs')) return 'ObjectStorage';
    if (lower.includes('api') || lower.includes('external') || lower.includes('http') || lower.includes('rest') || lower.includes('grpc') || lower.includes('webhook')) return 'ExternalAPI';
    if (lower.includes('process') || lower.includes('spawn') || lower.includes('exec') || lower.includes('shell') || lower.includes('fork') || lower.includes('job') || lower.includes('worker') || lower.includes('script') || lower.includes('command')) return 'Process';

    return null;
}

/** LLM synonym → canonical InfraOperation. Same pattern as CANONICAL_INFRA_TYPE. */
const CANONICAL_INFRA_OPERATION: Record<string, InfraOperation> = {
    // DB mutations
    WRITES: 'WRITES', WRITE: 'WRITES', INSERT: 'WRITES', UPDATE: 'WRITES', DELETE: 'WRITES', UPSERT: 'WRITES',
    // Broker emissions
    PUBLISH: 'WRITES', PUBLISHES: 'WRITES', PUBLISHES_TO: 'WRITES', SEND: 'WRITES', EMIT: 'WRITES',
    // Identity
    READS: 'READS', READ: 'READS',
    MAPS_TO: 'MAPS_TO',
};

export function normalizeInfraOperation(val: string): InfraOperation {
    return CANONICAL_INFRA_OPERATION[val.toUpperCase().trim()] ?? 'READS';
}

function cleanInfraName(name: string): string {
    return name.trim().replace(/^['"`]+|['"`]+$/g, '');
}

function dedupeInfrastructure(items: InfraRef[]): InfraRef[] {
    const seen = new Set<string>();
    const out: InfraRef[] = [];
    for (const infra of items) {
        const key = `${infra.type}|${infra.operation}|${infra.channelKind ?? ''}|${infra.name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(infra);
    }
    return out;
}

/**
 * Heuristic: Does this name look like a message broker topic/queue name?
 * Positive patterns: dot-separated (order.created), dash-separated (order-events),
 * underscore-separated (order_created).
 * Negative: PascalCase class names (OrderCreatedEvent), generic terms, HTTP paths.
 */
export function looksLikeBrokerTopic(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 3) return false;

    // Reject HTTP paths
    if (trimmed.startsWith('/') || trimmed.startsWith('http')) return false;

    // Reject PascalCase class names (e.g. OrderCreatedEvent, PaymentRequest)
    // A PascalCase name starts with uppercase and has no separators
    if (/^[A-Z][a-zA-Z0-9]+$/.test(trimmed)) return false;

    // Reject generic/opaque names
    if (/^(OpaquePayload|unknown|any|data|payload|message|event|body)$/i.test(trimmed)) return false;

    // Positive: contains dot, dash, or underscore separator (typical topic patterns)
    if (/[.\-_]/.test(trimmed)) return true;

    return false;
}

const RawInfraRefSchema = z.object({
    name: z.string().describe('The name of the infrastructure (e.g. logical table or topic name)'),
    type: z.string().describe('MUST be exactly one of: Database, MessageChannel, Cache, ObjectStorage, ExternalAPI, Process'),
    operation: z.string()
        .describe(
            'READS = SELECT/FIND/FETCH/SUBSCRIBE/CONSUME/RECEIVE. '
            + 'WRITES = INSERT/UPDATE/DELETE/UPSERT/PUBLISH/SEND/EMIT/DISPATCH. '
            + 'Default: READS.',
        )
        .default('READS'),
    evidence: z.string().optional().describe(
        'For Database type ONLY: the EXACT verbatim code snippet (SQL query fragment, ORM call, or '
        + 'entity annotation) proving this table/collection exists in the source. '
        + 'Copy-paste from the source code exactly. Leave empty or omit if the name '
        + 'comes from a repository method call, variable name, or class name.',
    ),
    channelKind: z.enum(['topic', 'subscription', 'queue', 'exchange']).optional().describe(
        'For MessageChannel only: topic for publishers, subscription for Pub/Sub subscriptions, queue/exchange for broker-specific resources.',
    ),
    schemaFormat: z.enum(['avro', 'json-schema', 'protobuf']).optional().describe(
        'For MessageChannel only: payload schema format if visible.',
    ),
    schemaPath: z.string().optional().describe(
        'For MessageChannel only: local schema file path if a concrete path is visible. Omit for runtime strings.',
    ),
    technology: z.string().optional().describe(
        'For MessageChannels, Databases, Caches, ObjectStorage: The technology if explicitly identifiable from code/imports (e.g., "rabbitmq", "kafka", "pubsub", "sqs", "redis", "postgres"). Omit if not explicitly visible.'
    ),
    // Edge-level routing metadata. Only populated for MessageChannel operations.
    // The LLM should extract the *literal* string visible at the call site
    // (e.g. `basic_publish(exchange='X', routing_key='Y')` → routingKey='Y').
    // If no concrete value is visible in the code, omit the field; do not invent.
    routingKey: z.string().optional().describe(
        'For MessageChannel WRITES only: the routing key passed to the publisher (e.g. `basic_publish(routing_key=...)` in AMQP, `attribute mapping in Pub/Sub publish`). Omit if not visible verbatim in code.',
    ),
    partitionKey: z.string().optional().describe(
        'For MessageChannel WRITES only: the partition key passed to a Kafka producer (e.g. `producer.send(topic, key=...)`).',
    ),
    consumerGroup: z.string().optional().describe(
        'For MessageChannel READS only: the consumer group / subscription name (Kafka consumer-group, Pub/Sub subscription, SQS queue ARN).',
    ),
});

// Shared transform: raw LLM infra ref → cleaned InfraRef (or null to drop).
// Reused by the full schema and the Stage-5 category-scoped schemas. The input
// is loosely typed because scoped schemas omit the broker-only fields (they
// arrive as undefined here, which is handled identically).
type RawInfraInput = {
    name: string;
    type: string;
    operation?: string;
    evidence?: string;
    channelKind?: 'topic' | 'subscription' | 'queue' | 'exchange';
    schemaFormat?: 'avro' | 'json-schema' | 'protobuf';
    schemaPath?: string;
    technology?: string;
    routingKey?: string;
    partitionKey?: string;
    consumerGroup?: string;
};

function toInfraRef(infra: RawInfraInput): InfraRef | null {
    const name = cleanInfraName(infra.name);
    if (!name) return null;

    const type = normalizeInfraType(infra.type);
    if (!type) return null;

    const schemaPath = infra.schemaPath?.trim() || undefined;
    const schemaPathLower = schemaPath?.toLowerCase();
    let schemaFormat = infra.schemaFormat;
    if (!schemaFormat && schemaPathLower?.endsWith('.avsc')) {
        schemaFormat = 'avro';
    } else if (!schemaFormat && schemaPathLower?.endsWith('.proto')) {
        schemaFormat = 'protobuf';
    }

    return {
        name,
        type,
        operation: normalizeInfraOperation(infra.operation ?? 'READS'),
        evidence: infra.evidence?.trim() || undefined,
        channelKind: infra.channelKind,
        schemaFormat,
        schemaPath,
        technology: infra.technology?.trim() || undefined,
        routingKey: infra.routingKey?.trim() || undefined,
        partitionKey: infra.partitionKey?.trim() || undefined,
        consumerGroup: infra.consumerGroup?.trim() || undefined,
    };
}

const InfraRefSchema = RawInfraRefSchema.transform((v) => toInfraRef(v as RawInfraInput));

function normalizeHttpMethod(method: string): 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | null {
    const upper = method.trim().toUpperCase();
    if (upper === 'GET' || upper === 'POST' || upper === 'PUT' || upper === 'DELETE' || upper === 'PATCH') return upper;
    return null;
}

function normalizeApiPath(path: string): string | null {
    const trimmed = path.trim();
    if (!trimmed) return null;
    // GraphQL: canonicalize to 'GRAPHQL OPERATION_UPPERCASE operationName'
    // e.g. 'graphql query user' → 'GRAPHQL QUERY user'
    // Contract: take ONLY parts[2] as operationName.
    // GraphQL identifiers cannot contain spaces — if the LLM hallucinated
    // extra tokens (e.g. 'GRAPHQL QUERY get user'), we take 'get' and discard
    // 'user'. The stored path and the dedupe key are always consistent:
    // both use exactly ['GRAPHQL', 'OP', 'name'] — 3 tokens.
    if (/^graphql\s+/i.test(trimmed)) {
        const parts = trimmed.replace(/\s+/g, ' ').trim().split(' ');
        if (parts.length >= 3) {
            return `GRAPHQL ${parts[1].toUpperCase()} ${parts[2]}`;
        }
        return null; // missing operationName — invalid GQL path
    }
    if (/^\$\{.+\}$/.test(trimmed)) return null;

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            const normalized = `${parsed.host}${parsed.pathname || '/'}${parsed.search}`.trim();
            if (!normalized) return null;
            return normalized.replace(/\/{2,}/g, '/');
        } catch {
            return null;
        }
    }

    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeadingSlash.replace(/\/{2,}/g, '/');
}

function dedupeApiCalls<T extends { method: string | null; path: string; api_kind?: string }>(calls: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const call of calls) {
        let key: string;
        // GraphQL fork: bypass normalizeHttpMethod entirely
        // (it is HTTP-only and would silently drop Subscriptions with method=null).
        // Deduplicate on operation+operationName; normalize path to canonical form.
        //
        // GraphQL invariant (deterministic, not prompt-dependent):
        //   method=null and api_kind='graphql' are FORCED here for every call
        //   classified as GraphQL — by api_kind or by canonical-path shape.
        //   The prompt asks the LLM for method:null on GQL ops, but compliance
        //   is not guaranteed; the Cypher layer already nullifies method for
        //   apiKind='graphql', so enforcing it at the schema layer keeps both
        //   layers consistent.
        if (call.api_kind === 'graphql' || /^GRAPHQL\s+(QUERY|MUTATION|SUBSCRIPTION)\s+\S+$/i.test(call.path)) {
            const normalizedPath = normalizeApiPath(call.path); // uppercases op token, takes parts[2] only
            if (!normalizedPath) continue; // invalid GQL path (missing operationName)
            const parts = normalizedPath.split(' '); // always exactly 3 tokens after normalization
            if (parts.length < 3) continue;          // defensive guard
            key = `graphql|${parts[1]}|${parts[2]}`; // consistent with stored path
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ ...call, path: normalizedPath, method: null, api_kind: 'graphql' });
        } else {
            // HTTP: existing logic — normalize both method and path
            const method = normalizeHttpMethod(call.method ?? '');
            const path = normalizeApiPath(call.path);
            if (!method || !path) continue;
            key = `${method}|${path}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ ...call, method, path }); // restore original normalized form
        }
    }
    return out;
}


function normalizeCapabilities(capabilities: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of capabilities) {
        const normalized = raw
            .trim()
            .toLowerCase()
            .replace(/[_\s]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

function truncateForPrompt(text: string, maxChars: number, label: string, chunkName: string): string {
    if (text.length <= maxChars) return text;
    logger.debug(`[UnifiedAnalyzer] Truncated ${label} for ${chunkName} (${text.length} -> ${maxChars} chars)`);
    return `${text.slice(0, maxChars)}\n...[truncated]`;
}

const PayloadFieldSchema = z.object({
    name: z.string().describe('Name of the field (e.g. "orderId")'),
    type: z.string().describe('Type of the field (e.g. "string", "Array<string>")'),
});

const PayloadFieldsSchema = z.array(PayloadFieldSchema).describe(
    'List of fields defining this payload. Values MUST be strings representing the type, NEVER nested objects.',
);

const PayloadSchema = z.object({
    name: z.string().describe('Logical name of the payload/event (e.g. "OrderCreatedEvent", "UserPayload")'),
    fields: PayloadFieldsSchema,
});

const EmergentAPICallSchema = z.object({
    method: z.preprocess(
        (v) => (typeof v === 'string' ? v.toUpperCase() : v),
        z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).nullable(),
    ).describe(
        'HTTP verb for REST endpoints. null for ALL GraphQL operations (transport is irrelevant).',
    ),
    path: z.string().describe(
        'HTTP: parameterized route path e.g. "/api/users/{id}". ' +
        'GraphQL: "GRAPHQL QUERY|MUTATION|SUBSCRIPTION rootFieldName" — ' +
        'use the ROOT FIELD NAME on type Query/Mutation/Subscription. ' +
        'For aliases (me: user) emit the field name ("user"), NOT the alias ("me"). ' +
        'Anonymous operations, multi-root-field ops, introspection (__schema, __type): DO NOT emit.',
    ),
    direction: z.enum(['INBOUND', 'OUTBOUND']).default('OUTBOUND').describe(
        'INBOUND if the function EXPOSES this endpoint to clients (e.g. a Controller handler, @Get decorator, router.get() with inline logic). ' +
        'OUTBOUND if the function CALLS this endpoint (e.g. axios.get(), fetch(), curl). ' +
        'Default to OUTBOUND if unsure.',
    ),
    api_kind: z.enum(['rest', 'graphql']).default('rest').describe(
        '"graphql" for GraphQL operations, "rest" for REST/HTTP calls.',
    ),
    document_operation_name: z.string().nullable().default(null).describe(
        'GraphQL OUTBOUND only: named operation in the document (e.g. \"GetUserById\"). ' +
        'Different from path which contains the root field name. For traceability only. ' +
        'null if no named operation is visible in the gql template.',
    ),
    payload_schema: PayloadFieldsSchema.optional().describe('Request body fields, if any'),
    response_schema: PayloadFieldsSchema.optional().describe(
        'Response body fields, if any. For OUTBOUND calls: the body the caller deserializes from the HTTP response. ' +
        'For INBOUND endpoints: the body the handler serializes and returns to the client. ' +
        'Emit ONLY when the body shape is explicit in the source (e.g. typed response DTOs, deserialized into a struct, JSON.parse into a class). ' +
        'Leave undefined when the response is opaque (raw bytes, untyped JSON forwarded along). NEVER guess — anti-hallucination.',
    ),
});

export const FastUnifiedAnalysisSchema = z.object({
    _reasoning: z.string().min(1).describe(
        'Chain-of-thought: Briefly scan the code line by line. Identify which variables hold real external resources (table names in SQL strings, queue topic literals) vs which are local state, ORM wrappers, or class names. ANTI-HALLUCINATION CHECK: Before adding ANY Database entry, verify the name is a STRING LITERAL from SQL/ORM, NOT a variable/class/interface name. Names ending in Repository, Service, or starting with I+Uppercase are ALWAYS variable names — infrastructure=[] is correct when no literal table name is visible. State WHY each infrastructure entry is or is not real before populating the arrays below. Fill this FIRST.',
    ),
    has_io: z.boolean().describe(
        'Whether the function communicates with the external world (databases, APIs, queues, file system, external processes, etc.)',
    ),
    intent: z.string().describe(
        'A concise description of the function\'s external I/O behavior. Empty string "" if has_io is false.',
    ),
    infrastructure: z.array(InfraRefSchema.catch(null)).default([]).catch([]).transform((items) => {
        const valid = items.filter((infra): infra is InfraRef => infra !== null);
        return dedupeInfrastructure(valid);
    }).describe(
        'External infrastructure the function communicates with. Empty array [] if has_io is false.',
    ),
    capabilities: z.array(z.string()).default([]).catch([]).transform(normalizeCapabilities).describe(
        'Semantic tags describing WHAT this function does. Empty array [] if has_io is false.',
    ),
    emergent_api_calls: z.array(EmergentAPICallSchema).default([]).catch([]).transform((calls) => dedupeApiCalls(calls)).describe(
        'HTTP/REST API calls this function makes (OUTBOUND) or HTTP endpoints it exposes (INBOUND). Empty array [] if none. CRITICAL: ONLY extract OUTBOUND calls if a standard networking library (fetch, axios, curl, HttpClient, Guzzle) is explicitly used in the source code. NEVER extract calls to internal methods, custom domain SDK wrappers, or business logic methods.',
    ),
});

export const DeepUnifiedAnalysisSchema = z.object({
    _reasoning: z.string().min(1).describe(
        'Chain-of-thought: Briefly scan the code line by line. Identify which variables hold real external resources (table names in SQL strings, queue topic literals) vs which are local state, ORM wrappers, or class names. ANTI-HALLUCINATION CHECK: Before adding ANY Database entry, verify the name is a STRING LITERAL from SQL/ORM, NOT a variable/class/interface name. Names ending in Repository, Service, or starting with I+Uppercase are ALWAYS variable names — infrastructure=[] is correct when no literal table name is visible. State WHY each infrastructure entry is or is not real before populating the arrays below. Fill this FIRST.',
    ),
    has_io: z.boolean().describe(
        'Whether the function communicates with the external world (databases, APIs, queues, file system, external processes, etc.)',
    ),
    intent: z.string().describe(
        'A concise description of the function\'s external I/O behavior. Empty string "" if has_io is false.',
    ),
    infrastructure: z.array(InfraRefSchema.catch(null)).default([]).catch([]).transform((items) => {
        const valid = items.filter((infra): infra is InfraRef => infra !== null);
        return dedupeInfrastructure(valid);
    }).describe(
        'External infrastructure the function communicates with. Empty array [] if has_io is false.',
    ),
    capabilities: z.array(z.string()).default([]).catch([]).transform(normalizeCapabilities).describe(
        'Semantic tags describing WHAT this function does (e.g. "http-handler", "event-publisher", "database-writer"). ' +
        'Use concise, lowercase, hyphenated identifiers. Empty array [] if has_io is false.',
    ),
    produced_payloads: z.array(PayloadSchema).default([]).catch([]).describe(
        'Data payloads this function PRODUCES (publishes to queues, sends as HTTP body, writes to streams). Empty array [] if none.',
    ),
    consumed_payloads: z.array(PayloadSchema).default([]).catch([]).describe(
        'Data payloads this function CONSUMES (reads from queues, receives as HTTP body, reads from streams). Empty array [] if none.',
    ),
    emergent_api_calls: z.array(EmergentAPICallSchema).default([]).catch([]).transform((calls) => dedupeApiCalls(calls)).describe(
        'HTTP/REST API calls this function makes to external services. Empty array [] if none. CRITICAL: ONLY extract OUTBOUND calls if a standard networking library (fetch, axios, curl, HttpClient, Guzzle) is explicitly used in the source code. NEVER extract calls to internal methods, custom domain SDK wrappers, or business logic methods.',
    ),
});

export type UnifiedAnalysis = z.infer<typeof DeepUnifiedAnalysisSchema> | z.infer<typeof FastUnifiedAnalysisSchema>;

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 5: sink-category-scoped responseSchema
//
// A taint-selected function touches a known set of sink categories (derived from
// its tainting imports). We send a responseSchema carrying ONLY the fields those
// categories need: the 6 broker-only infra fields are dropped when there is no
// broker, and emergent_api_calls (+ deep payloads) are dropped when there is no
// HTTP/broker. Field-OMISSION is safe (unlike Stage-4 describe-trimming: a field
// that is absent cannot be given a wrong value); kept fields keep their verbatim
// descriptions. On any ambiguity we fall back to the full schema.
// ═══════════════════════════════════════════════════════════════════════════════

export type InfraCategory = 'database' | 'broker' | 'cache' | 'storage' | 'http' | 'process';

const SINK_PREFIX_CATEGORY: Array<[RegExp, InfraCategory]> = [
    [/^(pg|mysql2?|mariadb|mongodb|mongoose|@prisma\/client|typeorm|sequelize|knex|neo4j-driver|cassandra-driver)\b/, 'database'],
    [/^(redis|ioredis|memcached)\b/, 'cache'],
    [/^(amqplib|amqp-connection-manager|kafkajs|node-rdkafka|bullmq|@google-cloud\/pubsub|@nestjs\/microservices)\b/, 'broker'],
    [/^(axios|node-fetch|got|undici|@grpc\/grpc-js|socket\.io|graphql-request|@apollo\/client)\b/, 'http'],
];

// Sinks that span multiple categories (e.g. @aws-sdk → s3/sqs/...) force the
// full schema — we never risk dropping a field a polymorphic SDK might need.
const AMBIGUOUS_SINK = /@aws-sdk\/|^aws-sdk\b/;

/**
 * Detect the infra categories a taint-selected function touches, parsed from the
 * "Direct I/O imports:" line of the taint context. Returns null = "do not scope,
 * use the full schema" (no taint imports, an unknown sink, or an ambiguous SDK).
 */
/**
 * Categorise a list of SINK import sources (already filtered to known sinks by
 * the taint layer). Returns null = "use the full schema" on any ambiguous SDK
 * or any sink we don't map (never risk dropping a field a sink needs). This is
 * the STRUCTURED entry point — the pipeline computes categories from the import
 * graph and passes them through, so prompt scoping never depends on parsing a
 * human-readable log line.
 */
export function categorizeImportSources(sinkSources: readonly string[]): Set<InfraCategory> | null {
    const cats = new Set<InfraCategory>();
    for (const s of sinkSources) {
        if (AMBIGUOUS_SINK.test(s)) return null;
        const hit = SINK_PREFIX_CATEGORY.find(([re]) => re.test(s));
        if (!hit) return null; // unknown sink → don't risk scoping
        cats.add(hit[1]);
    }
    return cats.size > 0 ? cats : null;
}

/**
 * Legacy/fallback: parse categories from the "Direct I/O imports:" line of the
 * taint summary string. Used only when structured categories aren't available
 * (eval cases, direct callers). Prefer passing structured categories.
 */
export function detectInfraCategories(taintContextSummary?: string): Set<InfraCategory> | null {
    if (!taintContextSummary) return null;
    const m = /Direct I\/O imports:\s*([^\n]+)/.exec(taintContextSummary);
    if (!m) return null;
    const imports = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (imports.length === 0) return null;
    return categorizeImportSources(imports);
}

/** Stable signature for agent/cache labelling, e.g. "broker+database". */
export function categorySignature(cats: Set<InfraCategory> | null): string {
    return cats ? [...cats].sort().join('+') : 'full';
}

// Scoped infra element — verbatim descriptions for kept fields; broker fields
// only when a broker sink is present. Shares the toInfraRef transform.
function makeScopedInfraElement(cats: Set<InfraCategory>): z.ZodTypeAny {
    const shape: Record<string, z.ZodTypeAny> = {
        name: z.string().describe('The name of the infrastructure (e.g. logical table or topic name)'),
        type: z.string().describe('MUST be exactly one of: Database, MessageChannel, Cache, ObjectStorage, ExternalAPI, Process'),
        operation: z.string().describe(
            'READS = SELECT/FIND/FETCH/SUBSCRIBE/CONSUME/RECEIVE. '
            + 'WRITES = INSERT/UPDATE/DELETE/UPSERT/PUBLISH/SEND/EMIT/DISPATCH. '
            + 'Default: READS.',
        ).default('READS'),
        evidence: z.string().optional().describe(
            'For Database type ONLY: the EXACT verbatim code snippet (SQL query fragment, ORM call, or '
            + 'entity annotation) proving this table/collection exists in the source. '
            + 'Copy-paste from the source code exactly. Leave empty or omit if the name '
            + 'comes from a repository method call, variable name, or class name.',
        ),
        technology: z.string().optional().describe(
            'For MessageChannels, Databases, Caches, ObjectStorage: The technology if explicitly identifiable from code/imports (e.g., "rabbitmq", "kafka", "pubsub", "sqs", "redis", "postgres"). Omit if not explicitly visible.'
        ),
    };
    if (cats.has('broker')) {
        shape.channelKind = z.enum(['topic', 'subscription', 'queue', 'exchange']).optional().describe(
            'For MessageChannel only: topic for publishers, subscription for Pub/Sub subscriptions, queue/exchange for broker-specific resources.',
        );
        shape.schemaFormat = z.enum(['avro', 'json-schema', 'protobuf']).optional().describe('For MessageChannel only: payload schema format if visible.');
        shape.schemaPath = z.string().optional().describe('For MessageChannel only: local schema file path if a concrete path is visible. Omit for runtime strings.');
        shape.routingKey = z.string().optional().describe('For MessageChannel WRITES only: the routing key passed to the publisher (e.g. `basic_publish(routing_key=...)` in AMQP, `attribute mapping in Pub/Sub publish`). Omit if not visible verbatim in code.');
        shape.partitionKey = z.string().optional().describe('For MessageChannel WRITES only: the partition key passed to a Kafka producer (e.g. `producer.send(topic, key=...)`).');
        shape.consumerGroup = z.string().optional().describe('For MessageChannel READS only: the consumer group / subscription name (Kafka consumer-group, Pub/Sub subscription, SQS queue ARN).');
    }
    return z.object(shape).transform((v) => toInfraRef(v as RawInfraInput));
}

function scopedInfraArray(cats: Set<InfraCategory>): z.ZodTypeAny {
    return z.array(makeScopedInfraElement(cats).catch(null as any)).default([]).catch([]).transform((items) => {
        const valid = (items as Array<InfraRef | null>).filter((infra): infra is InfraRef => infra !== null);
        return dedupeInfrastructure(valid);
    }).describe('External infrastructure the function communicates with. Empty array [] if has_io is false.');
}

const _REASONING_DESC = 'Chain-of-thought: Briefly scan the code line by line. Identify which variables hold real external resources (table names in SQL strings, queue topic literals) vs which are local state, ORM wrappers, or class names. ANTI-HALLUCINATION CHECK: Before adding ANY Database entry, verify the name is a STRING LITERAL from SQL/ORM, NOT a variable/class/interface name. Names ending in Repository, Service, or starting with I+Uppercase are ALWAYS variable names — infrastructure=[] is correct when no literal table name is visible. State WHY each infrastructure entry is or is not real before populating the arrays below. Fill this FIRST.';
const _EMERGENT_DESC = 'HTTP/REST API calls this function makes (OUTBOUND) or HTTP endpoints it exposes (INBOUND). Empty array [] if none. CRITICAL: ONLY extract OUTBOUND calls if a standard networking library (fetch, axios, curl, HttpClient, Guzzle) is explicitly used in the source code. NEVER extract calls to internal methods, custom domain SDK wrappers, or business logic methods.';

/**
 * Build the category-scoped responseSchema for a (mode, categories) pair.
 * emergent_api_calls is included only when an HTTP sink is present; deep
 * payloads only when broker or HTTP. Returns the full schema when cats is null.
 */
export function makeScopedAnalysisSchema(mode: 'fast' | 'deep', cats: Set<InfraCategory> | null): z.ZodTypeAny {
    if (!cats) return mode === 'deep' ? DeepUnifiedAnalysisSchema : FastUnifiedAnalysisSchema;
    const shape: Record<string, z.ZodTypeAny> = {
        _reasoning: z.string().min(1).describe(_REASONING_DESC),
        has_io: z.boolean().describe('Whether the function communicates with the external world (databases, APIs, queues, file system, external processes, etc.)'),
        intent: z.string().describe('A concise description of the function\'s external I/O behavior. Empty string "" if has_io is false.'),
        infrastructure: scopedInfraArray(cats),
        capabilities: z.array(z.string()).default([]).catch([]).transform(normalizeCapabilities).describe('Semantic tags describing WHAT this function does. Empty array [] if has_io is false.'),
    };
    if (mode === 'deep' && (cats.has('broker') || cats.has('http'))) {
        shape.produced_payloads = z.array(PayloadSchema).default([]).catch([]).describe('Data payloads this function PRODUCES (publishes to queues, sends as HTTP body, writes to streams). Empty array [] if none.');
        shape.consumed_payloads = z.array(PayloadSchema).default([]).catch([]).describe('Data payloads this function CONSUMES (reads from queues, receives as HTTP body, reads from streams). Empty array [] if none.');
    }
    if (cats.has('http')) {
        shape.emergent_api_calls = z.array(EmergentAPICallSchema).default([]).catch([]).transform((calls) => dedupeApiCalls(calls)).describe(_EMERGENT_DESC);
    }
    return z.object(shape);
}

/** Ensure conditionally-omitted array fields are present (empty) so downstream
 *  consumers never read undefined. */
function normalizeScopedAnalysis(analysis: Record<string, unknown>, mode: 'fast' | 'deep'): void {
    if (!Array.isArray(analysis.infrastructure)) analysis.infrastructure = [];
    if (!Array.isArray(analysis.capabilities)) analysis.capabilities = [];
    if (!Array.isArray(analysis.emergent_api_calls)) analysis.emergent_api_calls = [];
    if (mode === 'deep') {
        if (!Array.isArray(analysis.produced_payloads)) analysis.produced_payloads = [];
        if (!Array.isArray(analysis.consumed_payloads)) analysis.consumed_payloads = [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Modular Prompt Constants
//
// The prompt is composed from per-concern building blocks. Each constant covers
// one extraction concern. This makes it easy to iterate on individual rules
// without risking side effects on unrelated concerns.
// ═══════════════════════════════════════════════════════════════════════════════

const CORE_DIRECTIVE = `
<core_directive>
1. FILTER: Determine if the function communicates with the external world (I/O).
2. EXTRACT: If it does, extract intent, infrastructure dependencies, semantic capabilities, data contracts, and API calls.
Return the combined result in a single JSON structure.
</core_directive>`;

const FILTER_RULES = `
<filter_rules>
External I/O: database calls (SQL/NoSQL/ORM), HTTP/REST/gRPC calls (including wrapper clients), message queues, persistent file I/O, cross-service communication, cache operations, spawning external scripts/processes (exec, spawn, shell_exec), framework I/O decorators (@Get/@Post/@Put/@Delete/@Patch/@Controller/@Resolver/@Query/@Mutation/@Subscription/@MessagePattern/@EventPattern/@Client).

NOT external I/O:
- Functions that ONLY construct, build, or format URL/endpoint strings (e.g. buildPageUrl(), getApiPath()) without making an actual HTTP call. Building a URL is not the same as calling it.
- Functions that ONLY read from or map over in-memory data structures, even if those structures contain URL strings. The I/O happens in the caller, not here.

Pure computation, type definitions, formatters, validators with NO external I/O: has_io=false, intent="", others=[].
</filter_rules>`;

const CLIENT_STATE_EXCLUSION = `
<client_state_exclusion>
NOT external I/O (has_io=false): browser storage (cookies, localStorage, IndexedDB), React state hooks, DOM manipulation, browser navigation, client timers, route/middleware registration without inline I/O.
</client_state_exclusion>`;

const TELEMETRY_EXCLUSION = `
<telemetry_exclusion>
Observability (metrics, APM/tracing, logging, feature flags) is NOT architectural I/O. Never include in infrastructure.
If a function's only external interaction is telemetry, set has_io=false. If mixed with real I/O, extract only the business I/O.
</telemetry_exclusion>`;

const FP_PATTERNS_RULES = `
<functional_programming_rules>
FUNCTIONAL PROGRAMMING PATTERNS — These ARE external I/O:
- Code using fp-ts TaskEither (TE.tryCatch, TE.chainTaskK, TE.chainFirstTaskK, taskify) indicates async I/O orchestration.
  A function composed with pipe(...) or F.pipe(...) around these combinators performs I/O even when the effect is wrapped in a monad.
- Treat TaskEither pipelines as has_io=true when they wrap Promise-based calls or repository boundaries.
- Arrow-function class properties (for example sendQuote = (...) => pipe(...)) are equivalent to class methods and must be analyzed normally.

REPOSITORY PATTERN — These ARE database operations:
- Methods on classes or files ending in Repository, Repo, Dao, Store are architectural I/O boundaries even when raw SQL is not visible.
- Methods named find*, get*, create*, update*, delete*, save*, exists*, count*, list*, fetch* in Repository, Dao, Store files should be treated as has_io=true.
- The absence of a visible SQL string does NOT make a Repository wrapper pure.
</functional_programming_rules>`;

const DB_RULES = `
   - For Databases: extract the EXACT table/collection name from SQL literals, ORM annotations, or PHPDoc comments. Never use connection strings, DSNs, or env var names.
   - CRITICAL: variable/property names are NOT table names. \`this.xxxRepository.find()\` is I/O (has_io=true), but "xxxRepository" is a DI token, not a table. Only extract from: (a) SQL string literals, (b) ORM Entity/Document annotations, (c) PHPDoc data-dependency comments. If none visible, set infrastructure=[] (empty array with has_io=true is correct).
   - Reject as table names: anything ending in Repository/Repo/Service, TS interfaces (IXxx), constructor params, generic ORM terms (collection, document, model, schema), manager variables ($em, $dm).
   - OPERATION: "WRITES" for INSERT/UPDATE/DELETE/UPSERT, "READS" for SELECT/FIND/FETCH. Same table read+written = two entries. Default "READS".
   - EVIDENCE: every Database entry needs an "evidence" field with the verbatim code fragment proving the table name. No evidence = omit the entry.
   - CONCATENATION: a table name built from a static fragment + variable MUST be emitted as a template stub. PHP: \`'slot_' . $type\` → "slot_{type}". JS/TS template literals too: \`tenant_data_\${tenantId}\` → "tenant_data_{tenantId}". A template-literal SQL string counts as an SQL string literal. Trace SQL variables back to their assignment within the function. NEVER omit these entries and NEVER replace them with "<DYNAMIC>" — the static fragment is the recoverable identity.
   - DYNAMIC SENTINEL: use the exact string "<DYNAMIC>" ONLY when the table name is FULLY opaque — no static fragment at all (e.g. a bare \`$tableName\` parameter with no visible assignment). If ANY static fragment exists, the CONCATENATION rule applies instead.
   - ENV FALLBACK: \`process.env.X || 'fallback'\` = use the fallback literal. No fallback = use "{ENV_VAR_NAME}".
   - ORM/ODM: follow language-specific rules in the language block below.`;

const DB_NEGATIVE_EXAMPLES = '';

// Stage 1 (io-confirmed path only): the reject-list enumeration and the
// has_io-framed anti-hallucination examples are dropped here. has_io is forced
// on this path, so the has_io framing is dead weight; the name-cleanup is kept
// as a single recall line (extract names ONLY from literals/annotations).
const DB_RULES_SLIM = `
   - For Databases: extract the EXACT table/collection name ONLY from SQL literals, ORM annotations, or PHPDoc comments. A repository/DI method call emits no table unless a literal name is visible; otherwise infrastructure=[]. Never connection strings, DSNs, env var names, or the variable/class name.
   - OPERATION: "WRITES" for INSERT/UPDATE/DELETE/UPSERT, "READS" for SELECT/FIND/FETCH. Same table read+written = two entries. Default "READS".
   - EVIDENCE: every Database entry needs an "evidence" field with the verbatim code fragment proving the table name. No evidence = omit the entry.
   - CONCATENATION: a table name built from a static fragment + variable MUST be emitted as a template stub. PHP: \`'slot_' . $type\` → "slot_{type}". JS/TS template literals too: \`tenant_data_\${tenantId}\` → "tenant_data_{tenantId}". A template-literal SQL string counts as an SQL string literal. Trace SQL variables back to their assignment within the function. NEVER omit these entries and NEVER replace them with "<DYNAMIC>".
   - DYNAMIC SENTINEL: use the exact string "<DYNAMIC>" ONLY when the table name is FULLY opaque (a bare \`$tableName\` parameter with no visible assignment). Any static fragment → the CONCATENATION rule applies instead.
   - ENV FALLBACK: \`process.env.X || 'fallback'\` = use the fallback literal. No fallback = use "{ENV_VAR_NAME}".
   - ORM/ODM: follow language-specific rules in the language block below.`;

const DB_ANTI_HALLUCINATION = `
<anti_hallucination_guard>
Repository/DI variable names are NEVER table names:
  this.em.query('SELECT * FROM users') → has_io=true, infrastructure=[{name:'users',type:'Database'}] ✓
  this.saveRepo.findOne({id})          → has_io=true, infrastructure=[] ✓ (never {name:'saveRepository'} and never a guessed {name:'save'})
</anti_hallucination_guard>`;

const BROKER_RULES = `
    - For MessageChannels: use the QUEUE/TOPIC/ROUTING_KEY name (e.g., "order-events"), NOT the class/interface name.
    - Every .publish()/.subscribe()/.emit() MUST create a MessageChannel entry in infrastructure, even if also in payloads.
    - OPERATION: "WRITES" for publish/send/emit/dispatch, "READS" for subscribe/consume/receive/listen. Direction matters for graph correctness; ignore the DI .get() call.
    - channelKind: "topic" for publish targets, "subscription" for Pub/Sub subscriptions. Set schemaPath/schemaFormat if a local schema file is visible.
    - ENV/CONFIG: if the name comes from env vars or config (process.env.X, this.config.get('key')), use the property/key name. It gets resolved downstream.
    - NEVER use generic variables ("topic", "queueName", "$routingKey") as names. Only string literals, env/config keys, or DI service keys.
    - DI CONTAINER: names from DI calls (@Inject('x'), $container->get('x.publisher')) ARE valid, extract them as-is.
    - CQRS/MESSAGE DISPATCH: when a typed message is dispatched to a bus (dispatch(new OrderCreated())), the SHORT CLASS NAME is the channel name (not the bus variable). The symbol registry resolves it downstream.
    - ROUTING KEY: for WRITES, if a literal routing-key argument is visible (e.g., basicPublish(exchange, 'acme.order.created', ...)), set routingKey. Two calls with different literal keys = two entries. Never invent keys.
    - CONSUMER GROUP: for READS, set consumerGroup if a literal group/subscription name is visible.
    - STATIC CONSTANTS: look up ClassName.CONSTANT in the "File Constants" context block. Use the resolved literal value, not the reference expression. If not listed, omit.
    - Language-specific broker patterns are in the language block below.`;

const BROKER_NEGATIVE_EXAMPLES = '';

const INFRA_GENERAL_RULES = `
   - For ObjectStorage: Use the exact bucket name if visible. If the bucket name is dynamic or unresolvable, use the exact sentinel string "<DYNAMIC>".
   - For other resources: Use the LOGICAL NAME as it appears in the code (e.g., queue/topic names like "order-events", ENV variables referencing URLs/endpoints). If returning a file path, preserve the exact relative 'File path' provided.
   - If spawning a background script or executing a binary, use the script/binary name as the logical name.
   - If no logical name is apparent for MessageChannels, Caches, or Processes, OMIT the infrastructure entry rather than using a generic technology name.`;

const INFRA_DEEP_RULES = `
   - Supported types: Database, MessageChannel, Cache, ObjectStorage, ExternalAPI, Process.
   - Process: only OS-level APIs (exec, spawn, fork, proc_open, shell_exec). Dynamic import() is NOT a spawn; curl/file_get_contents are ExternalAPI; error_log/syslog are platform logging (no infra node).
   - Extract the exact logical name, never a bare technology name. Undetectable DB/ObjectStorage = "<DYNAMIC>"; others = omit.
   - NestJS: @MessagePattern('x')/@EventPattern('x') and client.emit('x') = MessageChannel entries.`;

const CAPABILITY_RULES = `
3. **Capabilities**: Classify the function with relevant open-ended semantic tags (e.g. "http-handler", "database-writer").`;

const CAPABILITY_DEEP_RULES = `
3. **Capabilities**:
   - Classify the function with relevant open-ended semantic tags.
   - Tags must be lowercase, hyphenated, self-descriptive nouns or noun-phrases.
   - Examples: "http-handler", "event-publisher", "database-writer", "queue-consumer", "graphql-resolver".
   - Do NOT invent vague tags like "handler" alone — always qualify them.`;

const API_CALL_RULES = `
4. **Emergent API Calls (emergent_api_calls)**:
   - Extract BOTH outbound HTTP calls (fetch, axios, curl, Guzzle) AND exposed endpoints (@Get, router.get). Not route registration (app.use).
   - OUTBOUND: only extract if the code invokes a standard networking library or a "User-configured SDK sink" from Taint Context. Never extract internal methods or domain wrappers unless taint-listed.
   - Do NOT extract broker consumers (@MessagePattern, @EventPattern) as API calls.
   - Combine class-level @Controller('prefix') with method-level path for full route.
   - DIRECTION: "INBOUND" = function exposes this endpoint, "OUTBOUND" = function calls another service. A function can have both. Default "OUTBOUND".
   - PATH: strip protocol/hostname/port, keep path only. Normalize dynamic segments using the ACTUAL variable name: \`\${saveId}\` → "{saveId}". Never "{param}". Default "{id}". A path is "entirely dynamic" ONLY when it has NO literal segments at all (e.g. just \`\${url}\` or \`\${baseUrl}\`) — then omit it. If ANY literal segment is present you MUST emit the path: strip the host/baseUrl prefix, keep every literal segment, replace only per-call variables with their {name} form. Example: \`\${this.baseUrl}/api/v2/payments/\${paymentId}/status\` → "/api/v2/payments/{paymentId}/status". Never drop a call just because a variable appears mid-path. Emit ONE entry per HTTP call site — a class with N request methods yields N entries.
   - GRAPHQL BACKEND: path="GRAPHQL QUERY|MUTATION|SUBSCRIPTION methodName", direction=INBOUND. Root field = resolver method name.
   - GRAPHQL CLIENT: method=null, path="GRAPHQL QUERY|MUTATION|SUBSCRIPTION rootField", direction=OUTBOUND. Alias "myOrder: order" → emit "order". Multi-root = DO NOT emit.`;

const GRAPHQL_RULES = `<graphql_rules>
| Scenario | method | path | direction |
|---|---|---|---|
| Server @Query/@Mutation / #[Query]/#[Mutation] | "POST" | "GRAPHQL QUERY/MUTATION fieldName" | INBOUND |
| Server @Subscription | null | "GRAPHQL SUBSCRIPTION fieldName" | INBOUND |
| Client gql query/mutation | null | "GRAPHQL QUERY/MUTATION rootField" | OUTBOUND |
| Client gql subscription | null | "GRAPHQL SUBSCRIPTION rootField" | OUTBOUND |

Root field = schema field name (resolver method for server, first selection for client). NOT document operation name, NOT alias.
Alias "myOrder: order" → emit "order". Multi-root document → DO NOT emit. Introspection → DO NOT emit.
NEVER use path="/graphql". NEVER use method="POST" for client-side gql.

BODY-SHAPE RULE: POST with {"query": "query/mutation/subscription ...", "variables": ...} = GraphQL OUTBOUND regardless of URL.
Emit { method:null, path:"GRAPHQL <OP> <rootField>", direction:"OUTBOUND", api_kind:"graphql" }.
If .gql loaded from file, use entries from the "Loaded GraphQL Operation Files" context block.
</graphql_rules>`;

const API_CALL_DEEP_RULES = `
6. **Emergent API Calls (emergent_api_calls)**:
   - Extract BOTH outbound HTTP calls (fetch, axios, curl, Guzzle) AND exposed endpoints (@Get, router.get). Not route registration.
   - OUTBOUND: only if code invokes a standard networking library or a taint-listed "User-configured SDK sink". Never internal methods or domain wrappers unless taint-listed.
   - Do NOT extract broker consumers (@MessagePattern, @EventPattern) as API calls.
   - Combine class-level @Controller('prefix') with method-level path.
   - DIRECTION: "INBOUND" = exposes endpoint, "OUTBOUND" = calls another service. Can have both. Default "OUTBOUND".
   - PATH: strip protocol/hostname/port. Normalize dynamic segments with ACTUAL variable names: \`\${saveId}\` → "{saveId}". Never "{param}", default "{id}". "Entirely dynamic" = NO literal segments at all (just \`\${url}\`) — only then omit. Any literal segment present → MUST emit, keeping every literal segment and replacing only per-call variables: \`\${this.baseUrl}/api/v2/payments/\${paymentId}/status\` → "/api/v2/payments/{paymentId}/status". Never drop a call for a mid-path variable. One entry per HTTP call site.
   - SCHEMAS: extract payload_schema from visible request body fields. Extract response_schema from typed response objects (OUTBOUND: deserialized result, INBOUND: returned body). Opaque/untyped = undefined.
${GRAPHQL_RULES}`;

const PAYLOAD_RULES = `
4. **Produced Payloads (produced_payloads)**:
   - Data structures this function PRODUCES: publishes to queues, sends as HTTP body, writes to streams.
   - Provide logical name (event/topic name or type name, NOT function name) and flat field list [{name, type}].
   - Only fields explicitly visible in code. NOT the function's parameter list. NOT simple return values unless sent to an external system.
   - OPAQUE: if payload is generic/untyped, still extract with fields=[{name:"_opaque_reference", type:"true"}]. For queue payloads, name MUST match the routing_key/topic.
   - GraphQL: return types (@ObjectType) as produced_payloads. @MessagePattern event name as payload name.

5. **Consumed Payloads (consumed_payloads)**:
   - Same rules as produced_payloads. Data arriving via I/O (queue body, HTTP body, stream), NOT function parameters.
   - GraphQL: @InputType/@Args as consumed_payloads.

   ORM entities (Doctrine, Eloquent, TypeORM, SQLAlchemy) are NEVER payloads. They represent table schemas. If listed in "Resolved Entity Table Names" context, exclude from payloads.`;

const DI_RESOLUTION_RULES = `
7. **Contextual Resolution (DI)**:
   - Resolve class property types via "Class property types" and "Class constructor" context. Never use the variable name as the resource name.
   - DB/Cache: type identifies technology, but prefer the actual table/collection from SQL or ORM calls.
   - Brokers: a client/wrapper class name is NEVER the channel name. Use the string literal from .publish()/.subscribe().`;

// ─── OPT-5: Wrapper Detection (moved to system prompt for cacheability) ───
// Previously sent in the user message per call (~450 tokens × N calls).
// Now in the system prompt where Vertex caches it after the first call.
const WRAPPER_DETECTION_RULES = `
<wrapper_detection>
If a function is a GENERIC INFRASTRUCTURE WRAPPER (the resource name comes from a PARAMETER, not a literal): set has_io=true with infrastructure=[] — no placeholder names, the binding belongs to the CALLER. Exception: follow Custom Domain Knowledge when it maps the call to infrastructure.
NOT wrappers (always extract): curl_init("https://...") → ExternalAPI | $pdo->prepare("INSERT INTO tbl...") → Database | $this->messageBus->dispatch(new OrderCreated()) → MessageChannel.
The rule applies ONLY when the resource name is dynamic/parameterized; a hardcoded string literal is NEVER a wrapper.
</wrapper_detection>`;

// ─── Composed Instructions ───────────────────────────────────────────────────
// NOTE: Language-specific anti-hallucination rules (PHP curl vs spawn,
// TS dynamic import vs spawn, Go goroutines, etc.) are injected dynamically
// per-chunk via each plugin's promptHints() method.

// OPT-5: Accept optional language-specific hints to bake into the system prompt.
// When provided, Vertex caches the entire prompt (base rules + language rules)
// as a single cacheable prefix, saving ~1,200 tokens/call for monorepo repos.
// Stage 2: when the function was pre-selected by deterministic taint/static
// gates (filterGate ∈ {2,4,5,6,7}), has_io is already known to be true. The
// LLM no longer decides it, so the entire FILTER apparatus (filter rules,
// client-state/telemetry exclusions, fp-ts/Repository has_io detection) is
// dropped — the model EXTRACTS only. Saves ~450-550 tok/call on the dominant
// I/O path and removes the flaky has_io judgement on borderline functions.
const IO_CONFIRMED_PREAMBLE = `You are an expert code analysis engine. The function below was pre-selected by deterministic static/taint analysis and is CONFIRMED to perform external I/O. has_io is ALWAYS true — never reconsider or downgrade it. Your only job is to EXTRACT (intent, infrastructure, capabilities, data contracts, API calls).
<telemetry_note>Observability (metrics, APM/tracing, logging, feature flags) is NOT infrastructure — never extract it as an infrastructure entry.</telemetry_note>`;

export function buildAnalyzerInstructions(mode: 'fast' | 'deep', languageHints?: string, ioConfirmed = false, categories?: Set<InfraCategory>): string {
    // Stage 5 (instruction scoping): when the sink categories are known, drop the
    // extraction addenda for categories the function does not touch. `want` is
    // true for every category when `categories` is undefined → full prompt
    // (current behaviour preserved). Mirrors the category-scoped responseSchema.
    const want = (c: InfraCategory): boolean => !categories || categories.has(c);

    const capabilityRules = mode === 'fast' ? CAPABILITY_RULES : CAPABILITY_DEEP_RULES;
    const infraRules = mode === 'fast' ? INFRA_GENERAL_RULES : INFRA_DEEP_RULES;
    // Payloads (deep only) are relevant to broker/http traffic.
    const payloadRules = (mode === 'fast' || !(want('broker') || want('http'))) ? '' : `${PAYLOAD_RULES}\n`;
    // Emergent-API rules (incl. GRAPHQL_RULES) only when an HTTP sink is present.
    const apiRules = want('http') ? (mode === 'fast' ? API_CALL_RULES : API_CALL_DEEP_RULES) : '';
    const brokerRules = want('broker') ? BROKER_RULES : '';
    const diRules = mode === 'fast' ? '' : `${DI_RESOLUTION_RULES}\n`;
    const intentRules = mode === 'fast'
        ? '1. **Intent**: Describe the function\'s external I/O behavior in ONE short, concise sentence. Focus strictly on what external systems it communicates with.'
        : `1. **Intent**:
   - Describe the function's external I/O behavior in ONE short, concise sentence.
   - Focus strictly on what external systems it communicates with and what data it sends/receives.`;
    const infrastructureIntro = mode === 'fast'
        ? '2. **Infrastructure**: Identify ALL external infrastructure.'
        : `2. **Infrastructure**:
   - Identify ALL external infrastructure the function communicates with.`;

    // OPT-5: Language-specific rules are baked into the system prompt when known.
    // This makes them cacheable by Vertex after the first call, saving ~1,200
    // tokens per call across all N functions in a monorepo.
    const languageBlock = languageHints
        ? `\n\n${languageHints}`
        : '';

    const preamble = ioConfirmed
        ? IO_CONFIRMED_PREAMBLE
        : `You are an expert code analysis engine that performs TWO tasks in a single pass:
${CORE_DIRECTIVE}
${FILTER_RULES}
${CLIENT_STATE_EXCLUSION}
${TELEMETRY_EXCLUSION}
${FP_PATTERNS_RULES}`;

    // Stage 1: on the io-confirmed path, has_io is forced — the reject-list and
    // has_io-framed anti-hallucination examples are dead weight. The full path
    // keeps them (it still relies on them to calibrate the has_io decision).
    // Stage 5: drop the DB block + its anti-hallucination guard when there is no
    // database sink.
    const dbRulesBlock = want('database') ? (ioConfirmed ? DB_RULES_SLIM : DB_RULES) : '';
    const antiHallucinationBlock = (ioConfirmed || !want('database')) ? '' : DB_ANTI_HALLUCINATION;

    // Block ordering is tuned for Vertex implicit prefix caching: every block
    // that does NOT depend on sink categories comes first, then the
    // category-gated blocks (db/broker/anti-hallucination/payload/api) form the
    // TAIL. Two prompts that share (mode, language, ioConfirmed) but differ in
    // sink categories are then byte-identical up to the tail, so the cacheable
    // prefix spans the bulk of the prompt instead of dying at the first gated
    // block. The category tail still lives inside <extraction_rules>.
    return `${preamble}

<extraction_rules>
Only populate these fields when has_io is true:

${intentRules}
${infrastructureIntro}
${infraRules}
${DB_NEGATIVE_EXAMPLES}
${BROKER_NEGATIVE_EXAMPLES}
${capabilityRules}
${diRules}
${WRAPPER_DETECTION_RULES}
${dbRulesBlock}
${brokerRules}
${antiHallucinationBlock}
${payloadRules}${apiRules}
</extraction_rules>${languageBlock}`;
}

const FAST_INSTRUCTIONS = buildAnalyzerInstructions('fast');
const DEEP_INSTRUCTIONS = buildAnalyzerInstructions('deep');


// ─── OPT-5: Per-Language Agent Cache ─────────────────────────────────────────
// Instead of 1 agent per mode (fast/deep), we create per-language variants
// lazily so that language-specific hints are baked into the system prompt
// and cached by Vertex. For a monorepo with 100% TS, the 'fast:typescript'
// agent serves all 798 calls with identical cached system prompt.

const _agentCache = new Map<string, Agent>();

function getOrCreateAgent(mode: 'fast' | 'deep', languageHints?: string, language?: string, ioConfirmed = false, categories?: Set<InfraCategory>): Agent {
    // Cache key includes language only when hints are provided, an io-path
    // suffix so the slim (filter-free) variant is cached separately, and the
    // category signature so each scoped-instruction variant is cached once.
    const ioSuffix = ioConfirmed ? ':io' : '';
    const catSuffix = categories ? `:${categorySignature(categories)}` : '';
    const cacheKey = (languageHints && language ? `${mode}:${language}` : mode) + ioSuffix + catSuffix;

    let agent = _agentCache.get(cacheKey);
    if (!agent) {
        const instructions = languageHints
            ? buildAnalyzerInstructions(mode, languageHints, ioConfirmed, categories)
            : (ioConfirmed || categories
                ? buildAnalyzerInstructions(mode, undefined, ioConfirmed, categories)
                : (mode === 'fast' ? FAST_INSTRUCTIONS : DEEP_INSTRUCTIONS));

        agent = new Agent({
            id: `${cacheKey}-unified-analyzer-agent`,
            name: `${mode === 'fast' ? 'Fast' : 'Deep'} Unified Code Analyzer${language ? ` (${language})` : ''}${ioConfirmed ? ' [io]' : ''}`,
            instructions,
            model: getModel('ingest'),
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
        });
        _agentCache.set(cacheKey, agent);
    }
    return agent;
}

async function registerWithMastraRuntime(agent: Agent): Promise<Agent> {
    if (agent.getMastraInstance?.()) return agent;

    try {
        const { getMastra } = await import('../mastra/index.js');
        (agent as any).__registerMastra?.(getMastra());
    } catch (err) {
        logger.debug(`[UnifiedAnalyzer] Could not register analyzer agent with Mastra runtime: ${(err as Error).message}`);
    }

    return agent;
}

// Exported for Mastra registration (backward-compatible, no language hints)
let _fastAnalyzerAgent: Agent | null = null;
export function getFastAnalyzerAgent(): Agent {
    if (!_fastAnalyzerAgent) {
        _fastAnalyzerAgent = getOrCreateAgent('fast');
    }
    return _fastAnalyzerAgent;
}

let _deepAnalyzerAgent: Agent | null = null;
export function getDeepAnalyzerAgent(): Agent {
    if (!_deepAnalyzerAgent) {
        _deepAnalyzerAgent = getOrCreateAgent('deep');
    }
    return _deepAnalyzerAgent;
}

// ─── Fallback Analyzer Agent ─────────────────────────────────────────────────
// Cross-decoder fallback for prompts the primary model's structured-output
// decoder can't terminate. Symptom: response stream stalls, AbortSignal fires,
// Mastra surfaces finishReason='tripwire'.
//
// Resolution order:
// 1. Explicit config: ai.ingestFallback in settings.json (e.g. "vertex/gemini-2.5-flash")
// 2. Auto-detect: first available cross-provider credentials (vertex > anthropic > openai > google-genai)
// 3. Degraded: same provider as primary (logs a warning, unlikely to help)

let _resolvedFallbackLabel: string | null = null;

export function getResolvedFallbackLabel(): string {
    return _resolvedFallbackLabel ?? 'none';
}

/**
 * Quota-domain key for the primary ingest model. Quotas are per
 * provider/model, so the rate limiter keys on this — a Gemini 429 must not
 * throttle an OpenAI fallback (whose domain is `getResolvedFallbackLabel()`).
 */
function ingestRateDomain(): string {
    const cfg = configManager.getAiConfig('ingest');
    return `${cfg.provider}:${cfg.model}`;
}

function getOrCreateFallbackAgent(mode: 'fast' | 'deep', languageHints?: string, language?: string, ioConfirmed = false, categories?: Set<InfraCategory>): Agent {
    const ioSuffix = ioConfirmed ? ':io' : '';
    const catSuffix = categories ? `:${categorySignature(categories)}` : '';
    const cacheKey = `fallback:${languageHints && language ? `${mode}:${language}` : mode}${ioSuffix}${catSuffix}`;
    let agent = _agentCache.get(cacheKey);
    if (!agent) {
        const instructions = languageHints
            ? buildAnalyzerInstructions(mode, languageHints, ioConfirmed, categories)
            : (ioConfirmed || categories
                ? buildAnalyzerInstructions(mode, undefined, ioConfirmed, categories)
                : (mode === 'fast' ? FAST_INSTRUCTIONS : DEEP_INSTRUCTIONS));
        const cfg = configManager.getAiConfig('ingest');

        let fallbackModel;
        let resolvedProvider: string = cfg.provider;
        let resolvedModelName: string = cfg.model;

        const explicitFallback = configManager.getIngestFallback();
        if (explicitFallback) {
            const parts = explicitFallback.split('/');
            if (parts.length === 2) {
                resolvedProvider = parts[0];
                resolvedModelName = parts[1];
                fallbackModel = getModelByProvider(resolvedProvider as ProviderId, resolvedModelName, cfg);
            } else {
                resolvedModelName = explicitFallback;
                fallbackModel = getModelByProvider(cfg.provider, resolvedModelName, cfg);
            }
        } else {
            const detected = detectFallbackProvider(cfg.provider, cfg);
            if (detected) {
                resolvedProvider = detected.provider;
                resolvedModelName = detected.model;
                fallbackModel = getModelByProvider(detected.provider, detected.model, cfg);
                logger.info(
                    `[UnifiedAnalyzer] Auto-detected fallback: ${detected.provider}/${detected.model} ` +
                    `(primary: ${cfg.provider}/${cfg.model}). Configure ai.ingestFallback to override.`,
                );
            } else {
                logger.warn(
                    `[UnifiedAnalyzer] No cross-provider fallback available. ` +
                    `Fallback will retry the same provider (${cfg.provider}). ` +
                    `Set ai.ingestFallback in settings.json or provide credentials for another provider.`,
                );
                fallbackModel = getModel('ingest');
            }
        }

        if (resolvedProvider === cfg.provider && resolvedModelName === cfg.model) {
            logger.warn(
                `[UnifiedAnalyzer] Fallback model is identical to primary (${resolvedProvider}/${resolvedModelName}). ` +
                `Cross-decoder fallback will not help. Configure a different model via ai.ingestFallback.`,
            );
        }

        _resolvedFallbackLabel = `${resolvedProvider}/${resolvedModelName}`;

        agent = new Agent({
            id: `${cacheKey}-unified-analyzer-agent`,
            name: `Fallback Unified Code Analyzer${language ? ` (${language})` : ''}`,
            instructions,
            model: fallbackModel,
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
        });
        _agentCache.set(cacheKey, agent);
    }
    return agent;
}

let _fastFallbackAnalyzerAgent: Agent | null = null;
export function getFastFallbackAnalyzerAgent(): Agent {
    if (!_fastFallbackAnalyzerAgent) {
        _fastFallbackAnalyzerAgent = getOrCreateFallbackAgent('fast');
    }
    return _fastFallbackAnalyzerAgent;
}

let _deepFallbackAnalyzerAgent: Agent | null = null;
export function getDeepFallbackAnalyzerAgent(): Agent {
    if (!_deepFallbackAnalyzerAgent) {
        _deepFallbackAnalyzerAgent = getOrCreateFallbackAgent('deep');
    }
    return _deepFallbackAnalyzerAgent;
}

export async function getFallbackAnalyzerStrategy(scanMode: ScanMode, language?: string, ioConfirmed = false, categories?: Set<InfraCategory>): Promise<Agent> {
    const mode = scanMode === 'contracts' ? 'deep' : 'fast';
    const plugin = language ? getLanguagePlugin(language) : undefined;
    const hints = plugin?.promptHints?.();
    if (hints && language) {
        return registerWithMastraRuntime(getOrCreateFallbackAgent(mode, hints, language, ioConfirmed, categories));
    }
    if (ioConfirmed || categories) {
        return registerWithMastraRuntime(getOrCreateFallbackAgent(mode, undefined, undefined, ioConfirmed, categories));
    }
    return scanMode === 'contracts' ? getDeepFallbackAnalyzerAgent() : getFastFallbackAnalyzerAgent();
}

// OPT-5: Language-aware strategy resolver.
// Returns a per-language agent when hints are available, falling back to
// the generic agent otherwise. Per-language agents get Vertex cache hits
// on the full system prompt (base rules + language-specific rules).
export async function getAnalyzerStrategy(scanMode: ScanMode, language?: string, ioConfirmed = false, categories?: Set<InfraCategory>): Promise<Agent> {
    const mode = scanMode === 'contracts' ? 'deep' : 'fast';
    const plugin = language ? getLanguagePlugin(language) : undefined;
    const hints = plugin?.promptHints?.();
    if (hints && language) {
        return registerWithMastraRuntime(getOrCreateAgent(mode, hints, language, ioConfirmed, categories));
    }
    if (ioConfirmed || categories) {
        return registerWithMastraRuntime(getOrCreateAgent(mode, undefined, undefined, ioConfirmed, categories));
    }
    // Fallback: generic agent via Mastra registry
    const { getMastra } = await import('../mastra/index.js');
    return getMastra().getAgent(scanMode === 'contracts' ? 'deepAnalyzerAgent' : 'fastAnalyzerAgent');
}

// ─── Unified Analysis Function ───────────────────────────────────────────────

// ─── Prompt anatomy ──────────────────────────────────────────────────────────

/**
 * Named blocks of the user prompt, in Vertex cache-stability order.
 * `buildAnalysisPrompt` is the single source of truth for both the prompt
 * composition AND the per-section size accounting: `sectionChars` measures the
 * exact strings interpolated into the prompt (post-truncation), so trace
 * consumers can attribute token spend per section without re-deriving the
 * assembly logic.
 */
export const PROMPT_SECTION_NAMES = [
    'sourceCode',
    'customKnowledge',
    'frameworkSignal',
    'entityTable',
    'classConstants',
    'diContext',
    'clientBinding',
    'taint',
    'typeDefs',
    'graphqlDoc',
    'resolvedInvocation',
] as const;

export type PromptSectionName = (typeof PROMPT_SECTION_NAMES)[number];

/** Block sizes as shipped, plus DI sub-components (pre-outer-clamp detail). */
export type PromptSectionChars = Record<PromptSectionName, number> & {
    di_imports: number;
    di_constructorSource: number;
    di_classProperties: number;
};

export interface AnalysisPromptInputs {
    chunk: CodeChunk;
    scanMode?: ScanMode;
    context?: { imports?: string[]; constructorSource?: string; classProperties?: string[] };
    taintContextSummary?: string;
    customKnowledge?: string;
    resolvedTypeDefinitions?: string;
    entityTableContext?: string;
    frameworkSignalContext?: string;
    classConstantsContext?: string;
    clientBindingContext?: string;
    graphQLDocumentContext?: string;
    resolvedInvocationContext?: string;
}

/** Shared (repo/file/class-scoped) prompt blocks — identical for every
 *  function of one (file, class) group, shipped once per batch in L1. */
interface SharedPromptBlocks {
    customKnowledgeBlock: string;
    frameworkSignalBlock: string;
    entityTableBlock: string;
    classConstantsBlock: string;
    contextBlock: string;
    clientBindingBlock: string;
    diImportsChars: number;
    diConstructorChars: number;
    diPropertiesChars: number;
}

function composeSharedBlocks(
    inputs: Pick<AnalysisPromptInputs, 'context' | 'customKnowledge' | 'frameworkSignalContext' | 'entityTableContext' | 'classConstantsContext' | 'clientBindingContext'>,
    labelName: string,
): SharedPromptBlocks {
    const { context } = inputs;

    // Build context sections for the prompt
    let diImportsChars = 0;
    let diConstructorChars = 0;
    let diPropertiesChars = 0;
    const contextSections: string[] = [];
    if (context?.imports && context.imports.length > 0) {
        const importsBlock = truncateForPrompt(context.imports.join('\n'), 8_000, 'imports context', labelName);
        const section = `File imports:\n${importsBlock}`;
        diImportsChars = section.length;
        contextSections.push(section);
    }
    if (context?.constructorSource) {
        const constructorBlock = truncateForPrompt(context.constructorSource, 8_000, 'constructor context', labelName);
        const section = `Class constructor (for DI resolution):\n\`\`\`\n${constructorBlock}\n\`\`\``;
        diConstructorChars = section.length;
        contextSections.push(section);
    }
    if (context?.classProperties && context.classProperties.length > 0) {
        const propertiesBlock = truncateForPrompt(context.classProperties.join('\n'), 6_000, 'class properties context', labelName);
        const section = `Class property types:\n${propertiesBlock}`;
        diPropertiesChars = section.length;
        contextSections.push(section);
    }
    const contextBlock = contextSections.length > 0
        ? `\n\n--- DI Context (use this to resolve infrastructure names) ---\n${truncateForPrompt(contextSections.join('\n\n'), 18_000, 'DI context', labelName)}\n--- End DI Context ---\n`
        : '';

    // Custom domain knowledge from coderadius.yaml
    const customKnowledgeBlock = inputs.customKnowledge
        ? `${truncateForPrompt(inputs.customKnowledge, 8_000, 'custom knowledge', labelName)}

IMPORTANT: Custom Domain Knowledge overrides generic wrapper detection. If it says a call argument is a resource name or config key, extract that resource using the exact visible identifier/property name from the code. Do not omit it as dynamic, and do not invent or normalize a physical name.`
        : '';

    // Entity table context — resolved ORM entity→table mappings from static analysis
    const entityTableBlock = inputs.entityTableContext
        ? truncateForPrompt(inputs.entityTableContext, 3_000, 'entity table context', labelName)
        : '';
    const frameworkSignalBlock = inputs.frameworkSignalContext
        ? truncateForPrompt(inputs.frameworkSignalContext, 4_000, 'framework signal context', labelName)
        : '';

    // File constants context — AST-resolved intra-file string/number constants
    // Allows the LLM to resolve ClassName.CONSTANT → literal value without guessing.
    const classConstantsBlock = inputs.classConstantsContext
        ? truncateForPrompt(inputs.classConstantsContext, 2_000, 'file constants context', labelName)
        : '';
    const clientBindingBlock = inputs.clientBindingContext
        ? truncateForPrompt(inputs.clientBindingContext, 2_000, 'client binding context', labelName)
        : '';

    return {
        customKnowledgeBlock,
        frameworkSignalBlock,
        entityTableBlock,
        classConstantsBlock,
        contextBlock,
        clientBindingBlock,
        diImportsChars,
        diConstructorChars,
        diPropertiesChars,
    };
}

/** Function-scoped prompt blocks — unique per function, batch tails in L1. */
interface FunctionPromptBlocks {
    sourceCodeForPrompt: string;
    taintBlock: string;
    typeDefsBlock: string;
    graphQLDocumentBlock: string;
    resolvedInvocationBlock: string;
}

function composeFunctionBlocks(
    inputs: Pick<AnalysisPromptInputs, 'chunk' | 'taintContextSummary' | 'resolvedTypeDefinitions' | 'graphQLDocumentContext' | 'resolvedInvocationContext'>,
    isDeepScan: boolean,
): FunctionPromptBlocks {
    const { chunk } = inputs;
    const sourceCodeForPrompt = truncateForPrompt(chunk.sourceCode, isDeepScan ? 30_000 : 20_000, 'source code', chunk.name);

    // Taint context enrichment — auto-generated from the import graph
    const taintBlock = inputs.taintContextSummary ? truncateForPrompt(inputs.taintContextSummary, 6_000, 'taint context', chunk.name) : '';

    // OPT-5: Language-specific hints are now baked into the system prompt via
    // per-language agents (see getAnalyzerStrategy). No longer sent per call.

    // Cross-file type definitions (deep mode only)
    const typeDefsBlock = inputs.resolvedTypeDefinitions
        ? truncateForPrompt(inputs.resolvedTypeDefinitions, 4_000, 'type definitions', chunk.name)
        : '';
    const graphQLDocumentBlock = inputs.graphQLDocumentContext
        ? truncateForPrompt(inputs.graphQLDocumentContext, 4_000, 'graphql document context', chunk.name)
        : '';
    const resolvedInvocationBlock = inputs.resolvedInvocationContext
        ? truncateForPrompt(inputs.resolvedInvocationContext, 3_000, 'resolved critical invocation context', chunk.name)
        : '';

    return { sourceCodeForPrompt, taintBlock, typeDefsBlock, graphQLDocumentBlock, resolvedInvocationBlock };
}

export function buildAnalysisPrompt(
    inputs: AnalysisPromptInputs,
): { prompt: string; sectionChars: PromptSectionChars } {
    const { chunk } = inputs;
    const isDeepScan = inputs.scanMode === 'contracts';
    const shared = composeSharedBlocks(inputs, chunk.name);
    const fn = composeFunctionBlocks(inputs, isDeepScan);

    // Block ordering matters for Vertex implicit prefix caching: blocks are
    // listed by decreasing stability so the cached prefix extends as far as
    // possible across calls. Order:
    //   PER-REPO (customKnowledge) → PER-FILE (framework, entity table,
    //   constants, imports/ctor/props) → PER-CLASS (clientBinding) →
    //   PER-FUNCTION (function name, file path, taint, types, GraphQL,
    //   resolved invocation, source code).
    // The first byte that differs across calls breaks the cache, so anything
    // PER-FUNCTION must come AFTER everything more stable.
    const prompt = `Analyze the following function. First determine if it performs external I/O. If yes, extract its intent, infrastructure dependencies, and capabilities.
${shared.customKnowledgeBlock}${shared.frameworkSignalBlock}${shared.entityTableBlock}${shared.classConstantsBlock}${shared.contextBlock}${shared.clientBindingBlock}
Function name: ${chunk.name}
File path: ${chunk.filepath}
Language: ${chunk.language}
${fn.taintBlock}${fn.typeDefsBlock}${fn.graphQLDocumentBlock}${fn.resolvedInvocationBlock}
\`\`\`
${fn.sourceCodeForPrompt}
\`\`\``;

    const sectionChars: PromptSectionChars = {
        sourceCode: fn.sourceCodeForPrompt.length,
        customKnowledge: shared.customKnowledgeBlock.length,
        frameworkSignal: shared.frameworkSignalBlock.length,
        entityTable: shared.entityTableBlock.length,
        classConstants: shared.classConstantsBlock.length,
        diContext: shared.contextBlock.length,
        clientBinding: shared.clientBindingBlock.length,
        taint: fn.taintBlock.length,
        typeDefs: fn.typeDefsBlock.length,
        graphqlDoc: fn.graphQLDocumentBlock.length,
        resolvedInvocation: fn.resolvedInvocationBlock.length,
        di_imports: shared.diImportsChars,
        di_constructorSource: shared.diConstructorChars,
        di_classProperties: shared.diPropertiesChars,
    };

    return { prompt, sectionChars };
}

// ─── Batched analysis ────────────────────────────────────────────────────────
//
// One LLM call per (file, class) group: the shared blocks above are shipped
// ONCE, followed by one tail per function. Fast mode only — deep scans stay
// 1:1 (rare, payload-heavy, worst output-growth profile).

/** Shared context of a batch: identical for every member by construction
 *  (the grouper enforces byte-identity before forming a batch). */
export interface BatchSharedContext {
    filepath: string;
    language: CodeChunk['language'];
    context?: { imports?: string[]; constructorSource?: string; classProperties?: string[] };
    customKnowledge?: string;
    frameworkSignalContext?: string;
    entityTableContext?: string;
    classConstantsContext?: string;
    clientBindingContext?: string;
}

/** Per-function tail of a batch prompt. */
export interface BatchFunctionContext {
    chunk: CodeChunk;
    taintContextSummary?: string;
    resolvedTypeDefinitions?: string;
    graphQLDocumentContext?: string;
    resolvedInvocationContext?: string;
}

export const BatchedFastAnalysisSchema = z.object({
    analyses: z.array(
        FastUnifiedAnalysisSchema.extend({
            // Ordinal key, NOT the function name: PHP FQNs with backslashes are
            // unechoable through JSON escaping (55/59 batches key-missed on a
            // real PHP corpus). A bare number survives any tokenizer. z.coerce
            // accepts the model emitting 3 instead of "3".
            function_key: z.coerce.string().describe(
                'The function\'s NUMBER exactly as shown in its section header (e.g. "3"). Never invent, merge, or renumber.',
            ),
        }),
    ).describe('Exactly one entry per function in the batch.'),
});

export function buildBatchAnalysisPrompt(
    shared: BatchSharedContext,
    functions: BatchFunctionContext[],
): { prompt: string; sharedChars: number; functionChars: Record<string, number> } {
    const blocks = composeSharedBlocks(shared, shared.filepath);

    // Same Vertex ordering as the single-call prompt: per-repo → per-file →
    // per-class blocks first, then the per-function tails. The batch header
    // carries the anti-cross-contamination rule (batch-specific, so it lives
    // in the user prompt, NOT in the cached system prompt).
    const header = `${BATCH_HEADER_RULE}
${blocks.customKnowledgeBlock}${blocks.frameworkSignalBlock}${blocks.entityTableBlock}${blocks.classConstantsBlock}${blocks.contextBlock}${blocks.clientBindingBlock}
File path: ${shared.filepath}
Language: ${shared.language}
`;

    const tails = functions.map((fnCtx, i) => {
        const fn = composeFunctionBlocks(fnCtx, false);
        return `===== FUNCTION ${i + 1} of ${functions.length} — function_key: "${i + 1}" =====
Function name: ${fnCtx.chunk.name}
${fn.taintBlock}${fn.typeDefsBlock}${fn.graphQLDocumentBlock}${fn.resolvedInvocationBlock}
\`\`\`
${fn.sourceCodeForPrompt}
\`\`\``;
    });

    const prompt = header + tails.join('\n');
    const functionChars = Object.fromEntries(functions.map((f, i) => [f.chunk.name, tails[i].length]));
    return { prompt, sharedChars: header.length, functionChars };
}

/** Common context of a MIXED batch: cross-file singletons of one
 *  language. Only per-repo blocks are shared; everything file/class-scoped
 *  rides in each member's tail. */
export interface MixedBatchCommonContext {
    language: CodeChunk['language'];
    customKnowledge?: string;
}

/** A mixed-batch member: a singleton function with its own file/class context. */
export interface MixedBatchMemberContext extends BatchFunctionContext {
    filepath: string;
    context?: { imports?: string[]; constructorSource?: string; classProperties?: string[] };
    frameworkSignalContext?: string;
    entityTableContext?: string;
    classConstantsContext?: string;
    clientBindingContext?: string;
}

const BATCH_HEADER_RULE = 'Analyze EACH function below independently. Return one "analyses" array entry per function, with "function_key" set to the function\'s NUMBER as shown in its section header. Each entry\'s infrastructure and api_calls MUST derive ONLY from that function\'s own source block. Never copy an entry from one function to another.';

/**
 * Cross-file singleton batch. Functions that share NO file/class
 * context still share the ~4K-token fixed prefix (system prompt + schema):
 * merging N singleton calls into one amortizes it by (N−1)×prefix. Per-repo
 * customKnowledge is the only shared user block; each tail carries its own
 * DI/framework/entity/constants context plus the per-function blocks.
 */
export function buildMixedBatchAnalysisPrompt(
    common: MixedBatchCommonContext,
    members: MixedBatchMemberContext[],
): { prompt: string; sharedChars: number; functionChars: Record<string, number> } {
    const repoBlocks = composeSharedBlocks({ customKnowledge: common.customKnowledge }, 'mixed-batch');

    const header = `${BATCH_HEADER_RULE}
${repoBlocks.customKnowledgeBlock}
Language: ${common.language}
`;

    const tails = members.map((member, i) => {
        const blocks = composeSharedBlocks(member, member.filepath);
        const fn = composeFunctionBlocks(member, false);
        return `===== FUNCTION ${i + 1} of ${members.length} — function_key: "${i + 1}" =====
Function name: ${member.chunk.name}
File path: ${member.filepath}
${blocks.frameworkSignalBlock}${blocks.entityTableBlock}${blocks.classConstantsBlock}${blocks.contextBlock}${blocks.clientBindingBlock}${fn.taintBlock}${fn.typeDefsBlock}${fn.graphQLDocumentBlock}${fn.resolvedInvocationBlock}
\`\`\`
${fn.sourceCodeForPrompt}
\`\`\``;
    });

    const prompt = header + tails.join('\n');
    const functionChars = Object.fromEntries(members.map((m, i) => [m.chunk.name, tails[i].length]));
    return { prompt, sharedChars: header.length, functionChars };
}

/** Result of one batched LLM call, demuxable by function_key. */
export interface BatchAnalysisResult {
    byKey: Map<string, UnifiedAnalysis>;
    usage: { totalTokens?: number;[key: string]: any };
    sharedChars: number;
    functionChars: Record<string, number>;
}

/**
 * Shared LLM round-trip for both batch flavors. Returns null on soft failure
 * (empty/invalid structured output) so the caller falls back to single calls;
 * auth errors propagate to fail fast, MaxRetriesExceededError and connection
 * errors propagate so the caller routes the batch to the deferred-retry drain.
 */
async function runBatchGenerate(
    language: CodeChunk['language'],
    prompt: string,
    memberCount: number,
    contextLabel: string,
    limiter?: AIMDSemaphore | null,
    ioConfirmed = false,
    categories?: Set<InfraCategory>,
): Promise<{ analyses: Array<Record<string, any>>; usage: { totalTokens?: number;[key: string]: any } } | null> {
    // Scope the agent's system prompt to (io, categories) — identical to the
    // single-call path — so a batch's members share one byte-identical prompt
    // and that prompt is cacheable across same-variant batches.
    const agent = await getAnalyzerStrategy('semantic', language, ioConfirmed, categories);
    logger.debug(`[UnifiedAnalyzer] Starting batch generate for ${memberCount} fn (${contextLabel}, strategy: ${agent.id})`);

    const startTime = telemetryCollector.startTimer();
    // Batch prompts are longer than single ones; widen the timeout tiers.
    const timeoutMs = prompt.length > 35_000 ? 120_000
        : prompt.length > 20_000 ? 90_000
        : 60_000;
    let response;
    try {
        response = await withCongestionControl(
            () => agent.generate(prompt, {
                structuredOutput: { schema: BatchedFastAnalysisSchema },
                modelSettings: { maxRetries: 0, temperature: 0 },
                abortSignal: AbortSignal.timeout(timeoutMs),
            }),
            { limiter, rateDomain: ingestRateDomain() },
        );
    } catch (err) {
        const msg = (err as Error).message?.toLowerCase() ?? '';
        if (/(credentials|api key|authentication|unauthorized)/.test(msg)) throw err;
        if (
            err instanceof MaxRetriesExceededError ||
            (err as { code?: string } | null)?.code === 'MAX_RETRIES_EXCEEDED'
        ) {
            throw err; // batch → deferred-retry drain, per-member
        }
        if (isConnectionError(err)) {
            // Endpoint-global transport failure: fanning out to per-member
            // single calls would multiply one dead-endpoint discovery into N
            // queue waits + timeouts. The batch rejects as a unit and the
            // caller routes every member to the deferred-retry drain.
            throw err;
        }
        logger.warn(`[UnifiedAnalyzer] Batch generate failed for ${contextLabel} (${memberCount} fn): ${(err as Error).message} — falling back to single calls`);
        return null;
    }
    const duration = telemetryCollector.stopTimer(startTime);
    telemetryCollector.addLLMTime(duration);
    telemetryCollector.addTokensForPhase('static_analysis', response.usage);

    const analyses = response.object?.analyses;
    if (!analyses?.length) {
        logger.warn(`[UnifiedAnalyzer] Batch returned empty analyses for ${contextLabel} (${memberCount} fn) — falling back to single calls`);
        return null;
    }
    return { analyses, usage: response.usage };
}

function demuxAnalysesByOrdinal(analyses: Array<Record<string, any>>): Map<string, UnifiedAnalysis> {
    const byKey = new Map<string, UnifiedAnalysis>();
    for (const entry of analyses) {
        const { function_key, ...analysis } = entry;
        const key = String(function_key); // z.coerce.string() types the field as unknown
        if (!byKey.has(key)) byKey.set(key, analysis as UnifiedAnalysis);
    }
    return byKey;
}

/**
 * One LLM call for a whole (file, class) batch. Returns null when the model
 * yields an empty/invalid structured output — the caller falls back to
 * single-function calls for every member (preserving today's exact quality
 * for anything the batch mishandles). MaxRetriesExceededError and connection
 * errors propagate so the caller can route the batch to the deferred-retry
 * drain.
 */
export async function analyzeFunctionBatch(
    shared: BatchSharedContext,
    functions: BatchFunctionContext[],
    limiter?: AIMDSemaphore | null,
    ioConfirmed = false,
    categories?: Set<InfraCategory>,
): Promise<BatchAnalysisResult | null> {
    const { prompt, sharedChars, functionChars } = buildBatchAnalysisPrompt(shared, functions);
    const result = await runBatchGenerate(shared.language, prompt, functions.length, shared.filepath, limiter, ioConfirmed, categories);
    if (!result) return null;
    const byKey = demuxAnalysesByOrdinal(result.analyses);
    // Stage 2: the whole batch is gate-confirmed I/O — force has_io so a
    // borderline model judgement on any member can't drop it.
    if (ioConfirmed) {
        for (const a of byKey.values()) {
            if ((a as { has_io?: boolean }).has_io === false) (a as { has_io: boolean }).has_io = true;
        }
    }
    return { byKey, usage: result.usage, sharedChars, functionChars };
}

/**
 * One LLM call for a cross-file singleton batch. Same failure
 * semantics as analyzeFunctionBatch.
 */
export async function analyzeMixedFunctionBatch(
    common: MixedBatchCommonContext,
    members: MixedBatchMemberContext[],
    limiter?: AIMDSemaphore | null,
    ioConfirmed = false,
    categories?: Set<InfraCategory>,
): Promise<BatchAnalysisResult | null> {
    const { prompt, sharedChars, functionChars } = buildMixedBatchAnalysisPrompt(common, members);
    const result = await runBatchGenerate(common.language, prompt, members.length, `mixed:${members[0]?.filepath ?? '?'}`, limiter, ioConfirmed, categories);
    if (!result) return null;
    const byKey = demuxAnalysesByOrdinal(result.analyses);
    // Variant-pure io-confirmed mixed batch: every member passed a strong gate,
    // so force has_io exactly as analyzeFunctionBatch does (the slim prompt no
    // longer asks the model to re-judge it).
    if (ioConfirmed) {
        for (const a of byKey.values()) {
            if ((a as { has_io?: boolean }).has_io === false) (a as { has_io: boolean }).has_io = true;
        }
    }
    return { byKey, usage: result.usage, sharedChars, functionChars };
}

/**
 * Perform a single LLM call that both filters for I/O relevance AND extracts
 * full metadata (intent, infrastructure, capabilities) when relevant.
 *
 * This replaces the old two-step pipeline of filterAgent → intentAgent,
 * cutting per-function LLM calls from 2 to 1.
 */
export async function analyzeFunction(
    chunk: CodeChunk,
    scanMode: ScanMode = 'semantic',
    context?: { imports?: string[]; constructorSource?: string; classProperties?: string[] },
    taintContextSummary?: string,
    customKnowledge?: string,
    resolvedTypeDefinitions?: string,
    entityTableContext?: string,
    frameworkSignalContext?: string,
    functionId?: string,
    classConstantsContext?: string,
    clientBindingContext?: string,
    graphQLDocumentContext?: string,
    resolvedInvocationContext?: string,
    limiter?: AIMDSemaphore | null,
    ioConfirmed = false,
    sinkCategories?: InfraCategory[],
): Promise<{ analysis: UnifiedAnalysis; usage: { totalTokens?: number;[key: string]: any }; sectionChars: PromptSectionChars } | null> {
    const isDeepScan = scanMode === 'contracts';
    const functionTarget = functionId ?? chunk.name;
    // Stage 5: sink categories scope BOTH the instructions (agent) and the
    // responseSchema. Prefer the structured categories passed by the pipeline
    // (robust); fall back to parsing the taint summary (eval / legacy callers).
    const scopeCats = ioConfirmed
        ? (sinkCategories?.length ? new Set(sinkCategories) : detectInfraCategories(taintContextSummary))
        : null;
    const { prompt, sectionChars } = buildAnalysisPrompt({
        chunk,
        scanMode,
        context,
        taintContextSummary,
        customKnowledge,
        resolvedTypeDefinitions,
        entityTableContext,
        frameworkSignalContext,
        classConstantsContext,
        clientBindingContext,
        graphQLDocumentContext,
        resolvedInvocationContext,
    });
    try {
        const agent = await getAnalyzerStrategy(scanMode, chunk.language, ioConfirmed, scopeCats ?? undefined);
        logger.debug(`[UnifiedAnalyzer] Starting generate for ${chunk.name} (strategy: ${agent.id})`);
        const startTime = telemetryCollector.startTimer();
        // Stage 5: the responseSchema is scoped to the same sink categories that
        // scoped the instructions above (computed once, used for both).
        const schema = makeScopedAnalysisSchema(isDeepScan ? 'deep' : 'fast', scopeCats);
        const timeoutMs = prompt.length > 35_000 ? 90_000
            : prompt.length > 20_000 ? 75_000
            : (isDeepScan ? 60_000 : 45_000);
        let response;
        try {
            response = await withCongestionControl(
                () => agent.generate(prompt, {
                    structuredOutput: { schema },
                    modelSettings: { maxRetries: 0, temperature: 0 },
                    abortSignal: AbortSignal.timeout(timeoutMs),
                }),
                { limiter, rateDomain: ingestRateDomain() },
            );
        } catch (primaryErr) {
            const pmsg = (primaryErr as Error).message?.toLowerCase() ?? '';
            if (/(credentials|api key|authentication|unauthorized)/.test(pmsg)) throw primaryErr;
            // Transport failures skip the model fallback: that path exists
            // for model-quality failures (empty/blocked output), not for a
            // socket that never opened. Connection errors and the open
            // circuit propagate so the caller defers the function instead of
            // burning a second queue wait + timeout on the same dead network.
            if (isConnectionError(primaryErr) || primaryErr instanceof EndpointUnreachableError) {
                throw primaryErr;
            }
            response = {
                object: undefined,
                finishReason: undefined as any,
                text: (primaryErr as Error).message,
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                error: primaryErr,
            };
        }
        const duration = telemetryCollector.stopTimer(startTime);
        logger.debug(`[UnifiedAnalyzer] Finished generate for ${chunk.name} in ${Math.round(duration)}ms`);

        telemetryCollector.addLLMTime(duration);
        telemetryCollector.addTokensForPhase('static_analysis', response.usage);

        // Mastra returns response.object = undefined when aborted by signal (no throw),
        // but may also return undefined for content-filter blocks, schema validation
        // failures, or genuine empty model output. Diagnostic fields below distinguish.
        // Path: primary returns empty -> immediately fall back to a different model
        // (no same-model retry: if the primary hung once, it will likely hang again
        // on the identical prompt, wasting another timeout budget).
        if (!response.object) {
            const finishReason = response.finishReason;
            const errMsg = response.error
                ? `${(response.error as Error).name}: ${(response.error as Error).message?.slice(0, 100)}`
                : undefined;
            const responseText = response.text?.slice(0, 200) || undefined;
            const isTimeout = finishReason === 'tripwire';

            const fallbackAgent = await getFallbackAnalyzerStrategy(scanMode, chunk.language, ioConfirmed, scopeCats ?? undefined);
            const fallbackLabel = getResolvedFallbackLabel();
            logger.warn(
                `[UnifiedAnalyzer] ${isTimeout ? 'Timeout' : 'Empty response'} for ${chunk.name} on primary, falling back to ${fallbackLabel}...`
                + ` [finishReason=${finishReason ?? 'n/a'}, err=${errMsg ?? 'none'}, latency=${Math.round(duration)}ms, promptLen=${prompt.length}]`,
            );
            traceCollector.traceLLM('FALLBACK', functionTarget, 'primary returned empty, switching to fallback model', {
                filePath: chunk.filepath,
                functionName: chunk.name,
                functionId,
                fallbackModel: fallbackLabel,
                finishReason,
                errMsg,
                latencyMs: Math.round(duration),
                promptLen: prompt.length,
                responseText,
            });
            const fallbackStart = telemetryCollector.startTimer();
            const fallbackResponse = await withCongestionControl(
                () => fallbackAgent.generate(prompt, {
                    // maxRetries:0 — congestion-control + the per-attempt rate
                    // token are the SOLE retry authority. An SDK-internal retry
                    // would fire a second HTTP request the rate bucket never
                    // counts, leaking past the quota cap (per-attempt promise).
                    structuredOutput: { schema },
                    modelSettings: { maxRetries: 0, temperature: 0 },
                    abortSignal: AbortSignal.timeout(timeoutMs),
                }),
                { limiter, rateDomain: getResolvedFallbackLabel() },
            );
            const fallbackDuration = telemetryCollector.stopTimer(fallbackStart);
            telemetryCollector.addLLMTime(fallbackDuration);

            if (!fallbackResponse.object) {
                const fbFinishReason = fallbackResponse.finishReason;
                const fbErrMsg = fallbackResponse.error
                    ? `${(fallbackResponse.error as Error).name}: ${(fallbackResponse.error as Error).message?.slice(0, 100)}`
                    : undefined;
                const fbResponseText = fallbackResponse.text?.slice(0, 200) || undefined;

                const warnMsg = `[UnifiedAnalyzer] Empty response for ${chunk.name} on BOTH primary and fallback (function dropped from graph)`
                    + ` [primaryFinishReason=${finishReason ?? 'n/a'}, fallbackFinishReason=${fbFinishReason ?? 'n/a'}, fallbackLatency=${Math.round(fallbackDuration)}ms]`;
                logger.warn(warnMsg);
                telemetryCollector.incrementErrors(warnMsg);
                traceCollector.traceLLM('FAIL', functionTarget, 'empty response on both primary and fallback', {
                    filePath: chunk.filepath,
                    functionName: chunk.name,
                    functionId,
                    primaryFinishReason: finishReason,
                    fallbackFinishReason: fbFinishReason,
                    fallbackErrMsg: fbErrMsg,
                    fallbackLatencyMs: Math.round(fallbackDuration),
                    promptLen: prompt.length,
                    fallbackResponseText: fbResponseText,
                });
                return null;
            }

            // Fallback succeeded: count save, merge usage, continue.
            telemetryCollector.incrementFallbackSaves();
            telemetryCollector.addTokensForPhase('static_analysis', fallbackResponse.usage);
            response = fallbackResponse;
        }

        // ── Deterministic Reconciliation (Phase 1B policy, op-aware) ─────────
        //
        // Single source of truth for topic-as-payload classification. The policy:
        //
        //   For each payload p in produced_payloads / consumed_payloads:
        //     - hasContract = (fields.length > 0) AND NOT isOpaqueOnly
        //       where isOpaqueOnly = fields == [{name:'_opaque_reference'}]
        //     - isTopic = looksLikeBrokerTopic(p.name)
        //     - matchesChannel = any existing MessageChannel infra with this name
        //
        //     SYNTHESIS (op-aware, independent of drop):
        //       if (matchesChannel || isTopic) AND this (name, operation) not yet
        //       covered in infrastructure -> synthesize a MessageChannel entry
        //       with that operation, cloning metadata (channelKind/technology)
        //       from any same-name prototype.
        //
        //     DROP (per direction, by index):
        //       if (matchesChannel || isTopic) AND NOT hasContract ->
        //       drop this specific payload index. Drop by index, not by name:
        //       LLM may emit two entries with same name in same direction
        //       (one with contract, one without); name-based drop would kill
        //       the good one too.
        //
        // Two sets:
        //   existingBrokerNames    Set<lowercase-name>          -> matchesChannel
        //   existingBrokerOpKeys   Set<`${name}|${operation}`>  -> "this direction covered?"
        // dedupeInfrastructure keys on operation: WRITES and READS are distinct
        // entries, so we must synthesize per (name, operation), not just per name.
        const analysis = response.object as UnifiedAnalysis;
        // Stage 2: has_io was determined by the deterministic gate, not the LLM.
        // Force it true so a borderline model judgement can never drop a
        // gate-confirmed I/O function (an unrecoverable false negative).
        if (ioConfirmed && analysis && analysis.has_io === false) {
            analysis.has_io = true;
        }
        // Stage 5: a scoped schema may omit conditionally-irrelevant array
        // fields — re-add them empty so downstream consumers never see undefined.
        if (scopeCats && analysis) {
            normalizeScopedAnalysis(analysis as Record<string, unknown>, isDeepScan ? 'deep' : 'fast');
        }
        if (analysis.has_io && 'produced_payloads' in analysis) {
            const deepAnalysis = analysis as z.infer<typeof DeepUnifiedAnalysisSchema>;
            const channelEntries = deepAnalysis.infrastructure.filter(i => i.type === 'MessageChannel');
            const existingBrokerNames = new Set(channelEntries.map(i => i.name.toLowerCase()));
            const existingBrokerOpKeys = new Set(channelEntries.map(i => `${i.name.toLowerCase()}|${i.operation}`));

            const synthesized: InfraRef[] = [];
            const producedDropIdx = new Set<number>();
            const consumedDropIdx = new Set<number>();

            const isOpaqueOnly = (p: { fields?: Array<{ name?: string }> }): boolean =>
                p.fields?.length === 1 && p.fields[0]?.name === '_opaque_reference';
            const hasContract = (p: { fields?: Array<unknown> }): boolean =>
                (p.fields?.length ?? 0) > 0 && !isOpaqueOnly(p as { fields?: Array<{ name?: string }> });

            const classify = (
                p: { name: string; fields?: Array<{ name?: string }> },
                index: number,
                direction: 'produced' | 'consumed',
            ): void => {
                const lname = p.name.toLowerCase();
                const operation: 'WRITES' | 'READS' = direction === 'produced' ? 'WRITES' : 'READS';
                const opKey = `${lname}|${operation}`;
                const isTopic = looksLikeBrokerTopic(p.name);
                const matchesChannel = existingBrokerNames.has(lname);
                const opAlreadyCovered = existingBrokerOpKeys.has(opKey);
                const hasContractFlag = hasContract(p);
                const dropIdx = direction === 'produced' ? producedDropIdx : consumedDropIdx;

                // Synthesis: this name is channel-like (matches or topic-shaped)
                // AND this direction not yet covered. Clone metadata from a
                // same-name prototype to preserve channelKind/technology
                // (queue stays queue, subscription stays subscription).
                if ((matchesChannel || isTopic) && !opAlreadyCovered) {
                    const prototype = channelEntries.find(i => i.name.toLowerCase() === lname);
                    const entry: InfraRef = prototype
                        ? { ...prototype, name: p.name, type: 'MessageChannel', operation }
                        : { name: p.name, type: 'MessageChannel', operation };
                    synthesized.push(entry);
                    existingBrokerNames.add(lname);
                    existingBrokerOpKeys.add(opKey);
                }

                // Drop: channel-like AND no contract = mislabel.
                if ((matchesChannel || isTopic) && !hasContractFlag) {
                    dropIdx.add(index);
                }

                // Drop also when the name EXACTLY equals an existing
                // MessageChannel even WITH contract. In practice this is
                // never a legitimate payload: an event/payload name that
                // is byte-identical to a broker topic is the LLM emitting
                // the channel string in the wrong field. The channel
                // already carries any genuine schema via the welder
                // (PRODUCES + PUBLISHES_TO bridge). The exact-match drop
                // is stricter than `matchesChannel`, which lowercases —
                // we require a case-insensitive equality with an explicit
                // entry in `existingBrokerNames` to avoid catching mere
                // dotted-name collisions.
                if (matchesChannel) {
                    dropIdx.add(index);
                }
            };

            (deepAnalysis.produced_payloads ?? []).forEach((p, i) => classify(p, i, 'produced'));
            (deepAnalysis.consumed_payloads ?? []).forEach((p, i) => classify(p, i, 'consumed'));

            if (producedDropIdx.size > 0) {
                deepAnalysis.produced_payloads = (deepAnalysis.produced_payloads ?? [])
                    .filter((_, i) => !producedDropIdx.has(i));
            }
            if (consumedDropIdx.size > 0) {
                deepAnalysis.consumed_payloads = (deepAnalysis.consumed_payloads ?? [])
                    .filter((_, i) => !consumedDropIdx.has(i));
            }
            if (synthesized.length > 0) {
                deepAnalysis.infrastructure = dedupeInfrastructure([...deepAnalysis.infrastructure, ...synthesized]);
                logger.debug(`[UnifiedAnalyzer] Reconciled ${synthesized.length} MessageChannel(s) from payloads for ${chunk.name}: ${synthesized.map(s => `${s.name}/${s.operation}`).join(', ')}; dropped produced=${producedDropIdx.size}, consumed=${consumedDropIdx.size}`);
                traceCollector.traceLLM('TRANSFORM', functionTarget, 'reconciled MessageChannels from payloads', {
                    filePath: chunk.filepath,
                    functionName: chunk.name,
                    functionId,
                    synthesizedChannels: synthesized.map(s => `${s.name}/${s.operation}`),
                    droppedProduced: producedDropIdx.size,
                    droppedConsumed: consumedDropIdx.size,
                });
            }
        }

        return {
            analysis: analysis as UnifiedAnalysis,
            usage: response.usage,
            sectionChars,
        };
    } catch (err) {
        const msg = (err as Error).message?.toLowerCase() ?? '';
        const name = (err as Error).name?.toLowerCase() ?? '';
        const isAuthError = /(credentials|api key|authentication|unauthorized)/.test(msg);
        const isAbortError = name === 'aborterror'
            || name === 'timeouterror'
            || msg.includes('abort')
            || msg.includes('timeout')
            || msg.includes('timed out')
            || msg.includes('deadline');
        
        if (isAbortError) {
            const warnMsg = `[UnifiedAnalyzer] Aborted for ${chunk.name} (deadline exceeded)`;
            logger.warn(warnMsg);
            telemetryCollector.incrementErrors(warnMsg);
            traceCollector.traceLLM('FAIL', functionTarget, 'deadline exceeded', {
                filePath: chunk.filepath,
                functionName: chunk.name,
                functionId,
            });
            return null;
        }

        if (!isAuthError) {
            logger.error(`[UnifiedAnalyzer] Failed for ${chunk.name}: ${(err as Error).message}`);
        }
        throw err;
    }
}
