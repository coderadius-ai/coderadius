import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import yaml from 'js-yaml';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Per-Repo Configuration (coderadius.yaml)
//
// Four concepts, zero ambiguity:
//
//   packages   — taint engine: what to analyze, what to ignore, SDK→service maps
//   decorators — AST-level deterministic extraction of custom framework decorators
//   databases  — database identity scoping + datastore declarations (unified)
//   hints      — AI prompt injection for proprietary SDK patterns
//
// Placement: repo root alongside .crignore
// Format: See RepoHintsSchema below
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Schema ──────────────────────────────────────────────────────────────────

const HintSchema = z.object({
    /** Keywords or class names that identify this SDK in source code */
    patterns: z.array(z.string()).describe(
        'Keywords, class names, or function names that identify this pattern in source code'
    ),
    /** Free-text description injected verbatim into the LLM prompt */
    description: z.string().describe(
        'Natural language instruction for the LLM. E.g. "Internal wrapper for GCP Pub/Sub. Treat .publish() first arg as the topic name."'
    ),
});

/**
 * A typed SDK entry in packages.analyze.
 * Allows attaching semantic metadata to a package so that buildCustomKnowledgePrompt
 * can generate an LLM hint automatically — same mechanism as manual hints[].
 *
 * Example:
 *   packages:
 *     analyze:
 *       - name: "@acme/notification-client"
 *         kind: http-client
 *         label: "Notification API"
 *         baseUrl: "https://notifications.example.com"
 *       - name: "@acme/wire"
 *         kind: broker-client
 *         provider: rabbitmq        # enables deterministic broker discovery (s2)
 */
const SdkPackageEntrySchema = z.object({
    /** npm package name */
    name: z.string(),
    /**
     * Semantic kind of I/O this SDK performs.
     * Used to generate the correct LLM hint type.
     */
    kind: z.enum(['http-client', 'broker-client', 'db-client']),
    /** Human-readable label used as the APIEndpoint / node name in the graph. */
    label: z.string().optional(),
    /** Base URL (for http-client kind) — helps the LLM produce a correct OUTBOUND node. */
    baseUrl: z.string().optional(),
    /**
     * Broker provider (for broker-client kind) — the contract-grade source for
     * the s2 declared-sink candidate lane. Consumed ONLY by deterministic
     * broker discovery; deliberately NOT injected into LLM prompts so existing
     * customKnowledge output stays byte-identical for entries without it.
     */
    provider: z.enum(['rabbitmq', 'kafka', 'pubsub', 'sqs', 'sns', 'azure-service-bus', 'nats', 'redis-streams', 'pulsar']).optional(),
});

export type SdkPackageEntry = z.infer<typeof SdkPackageEntrySchema>;

/** Union: a packages.analyze entry is either a plain package name or a typed SDK entry. */
const AnalyzeEntrySchema = z.union([z.string(), SdkPackageEntrySchema]);

const PackagesSchema = z.object({
    /** Packages to force-analyze (I/O sinks for taint propagation). Plain strings and typed entries coexist. */
    analyze: z.array(AnalyzeEntrySchema).default([]),
    /** Packages to exclude from taint propagation (observability, logging). */
    ignore: z.array(z.string()).default([]),
});

const DecoratorSchema = z.object({
    /**
     * Match target.
     *
     * For `message-consumer`, `http-route`, `scheduled-job`: the AST decorator
     * name (case-insensitive). E.g. `RabbitListener`, `Get`, `Cron`.
     *
     * For `graphql-client`: a fully-qualified `<ClassName>::<method>` selector
     * targeting an opaque transport wrapper. The class part may include PHP
     * namespace separators (escape backslashes in YAML: `"My\\NS\\Cls::send"`)
     * or TypeScript module + name. The matcher canonicalises both `\\` and `/`
     * to a single `\` before comparison against the language plugin's resolved
     * receiver FQCN.
     */
    name: z.string(),
    /** Signal kind: what type of infrastructure this decorator represents. */
    kind: z.enum(['message-consumer', 'http-route', 'scheduled-job', 'graphql-client', 'http-client']),
    /**
     * Args metadata.
     *
     * For `message-consumer` / `http-route` / `scheduled-job`: named args or
     * positional-arg keys that contain the resource name.
     *
     * For `graphql-client`: parameter names of the wrapper method holding,
     * respectively, the GraphQL operation document and the variables map.
     * Defaults to `[query, variables]`. The first arg name is the operation
     * source (string literal or `.gql` file), the second is the variables
     * payload, the runtime extractor uses this to decide which call argument
     * to interpret.
     *
     * For `http-client`: ignored (the path-suffix arg is identified by
     * `pathArgIndex`, see below).
     */
    args: z.array(z.string()).default(['routingKey', 'queue', 'name', 'topic']),
    /**
     * For `http-client` only: zero-based index of the wrapper-method argument
     * that carries the path-suffix (a string literal or const reference).
     * The path-suffix is concatenated with the wrapper's base URI to form
     * the full HTTP path emitted as APIEndpoint(direction=OUTBOUND).
     * Defaults to 0 when omitted.
     */
    pathArgIndex: z.number().int().nonnegative().optional(),
    /**
     * For `http-client` only: HTTP method to stamp on the emitted APIEndpoint.
     * Most opaque transport wrappers POST a payload, so this defaults to POST.
     */
    httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('POST').optional(),
});

const ServiceComponentOverrideSchema = z.object({
    /** Role classification for a discovered component (from any catalog source). */
    role: z.enum(['deployment-facet', 'independent-service']),
});

/**
 * A custom env-var accessor wrapper, e.g. a docker-secrets style helper that
 * reads `KEY_FILE` then falls back to `getenv(KEY)`. The lexical env scanner
 * cannot see through such wrappers (their internal getenv argument is
 * dynamic), so the repo declares them and the scanner harvests:
 *   - the env KEY from the string literal at `keyArg`
 *   - optionally a low-confidence default VALUE from the literal at `defaultArg`
 *
 * Matching rule (trailing segment): the configured callee matches both its
 * fully-qualified form and the short `<ClassTail>::<method>(` form produced
 * by imports/use statements. `\` and `/` are canonicalised before comparison.
 *
 * Example:
 *   envAccessors:
 *     - callee: 'Acme\Platform\EnvVault::fetch'
 *       keyArg: 0
 *       defaultArg: 1
 */
const EnvAccessorSchema = z.object({
    /** FQN or short name of the wrapper, e.g. "Acme\Platform\EnvVault::fetch". */
    callee: z.string(),
    /** Zero-based argument index holding the env key string literal. */
    keyArg: z.number().int().nonnegative().default(0),
    /** Optional argument index holding a literal default value to harvest (confidence: low). */
    defaultArg: z.number().int().nonnegative().optional(),
});

export type EnvAccessor = z.infer<typeof EnvAccessorSchema>;

const ServicesSchema = z.object({
    /**
     * Repository topology declaration.
     *
     * - `monolith`:  All discovered components share a single codebase
     *                (one autoloader, one CI pipeline, one Docker image).
     *                Components are mapped as DeploymentUnit nodes, not
     *                separate Service nodes.
     *
     * - `monorepo`:  Each discovered component is an independently
     *                deployable service.
     *
     * - `auto` (default): Heuristic detection — if all catalog-sourced
     *                components share the same directory, treat as monolith;
     *                otherwise treat as monorepo.
     *
     * Works with any catalog source (Backstage, Cortex, autodiscovery).
     */
    topology: z.enum(['monolith', 'monorepo', 'auto']).default('auto'),
    /**
     * Override service names derived from catalog or directory.
     *
     * Keys are the original catalog name (e.g. Backstage metadata.name),
     * values are the desired "useful" name for the graph.
     *
     * Only needed when identity welding can't auto-derive a good name
     * (e.g. root-level catalog-info.yaml, generic directory names).
     */
    nameOverrides: z.record(z.string(), z.string()).default({}),
    /** Per-component role overrides (keyed by component name). */
    overrides: z.record(z.string(), ServiceComponentOverrideSchema).default({}),
});

const DatabaseSchema = z.object({
    /** Stable logical ID — becomes a URN segment. Must be unique within the repo. */
    id: z.string(),
    /** Technology identifier (mysql, postgres, redis, s3, etc.). */
    technology: z.string(),
    /** If true, the Datastore node uses 'shared' namespace (cross-repo convergence). */
    shared: z.boolean().default(false),
    /**
     * Table name patterns for:
     *   1. URN scope resolution (replaces database_scope)
     *   2. DataContainer → Datastore routing (replaces datastores.tables)
     *
     * Supported patterns:
     *   - exact:  "orders"   → matches only "orders"
     *   - prefix: "wp_*"    → matches "wp_posts", "wp_options", etc.
     *   - suffix: "*_logs"  → matches "audit_logs", "event_logs", etc.
     *   - all:    "*"       → matches every table (escape hatch)
     */
    tables: z.array(z.string()).default([]),
});

const MessageChannelAliasSchema = z.object({
    /** Logical name seen in code or DI, e.g. messaging.topics.sample_user. */
    from: z.string(),
    /** Physical channel name, e.g. Platform-SampleUser. */
    name: z.string(),
    /** Channel semantics. Topics and subscriptions use kinded URNs. */
    channelKind: z.enum(['topic', 'subscription', 'queue', 'exchange']),
    /** Broker technology identifier, e.g. pubsub, kafka, rabbitmq. */
    technology: z.string().optional(),
    /** Optional local payload schema path. */
    schemaPath: z.string().optional(),
    /** Optional payload schema format. */
    schemaFormat: z.enum(['avro', 'json-schema', 'protobuf']).optional(),
    /** For subscriptions: physical topic name this subscription points to. */
    topic: z.string().optional(),
    /** Free-form tags for SDK/framework identification (e.g. ['AcmeBusSDK']). */
    tags: z.array(z.string()).default([]),
});

/**
 * Cross-broker mirror declaration: a single logical event manifests on
 * multiple physical channels (RabbitMQ Shovel/Federation, Kafka MirrorMaker,
 * SNS cross-region replication, etc.).
 *
 * Strict-isolation rule: WITHOUT this declaration, channels on different
 * brokers are NEVER welded. Mirror is opt-in: the customer asserts that the
 * listed physical channels carry the same logical event so the welder can
 * create a (LogicalChannel)-[:MANIFESTS_AS]->(PhysicalChannel) edge to each.
 */
const MessageChannelMirrorPhysicalSchema = z.object({
    /** Broker id from `messageBrokers[].id`. */
    broker: z.string(),
    /** Physical channel name on that broker (exchange, queue, topic name). */
    channel: z.string(),
    /** Channel semantics. */
    kind: z.enum(['topic', 'subscription', 'queue', 'exchange']),
});

const MessageChannelMirrorSchema = z.object({
    /** Stable business name of the logical event (e.g. "OrderCreated"). */
    logical: z.string(),
    /** Optional kind for the logical channel node (defaults to 'topic'). */
    kind: z.enum(['topic', 'subscription', 'queue', 'exchange']).default('topic'),
    /** Physical materializations across brokers. At least one required. */
    physical: z.array(MessageChannelMirrorPhysicalSchema).min(1),
});

export type MessageChannelMirror = z.infer<typeof MessageChannelMirrorSchema>;

/**
 * Explicit CQRS class → routing key override for the class-name bridge.
 * Used when the PHP routing config uses constructs the extractor can't
 * resolve (cross-class constants, dynamic loaders, runtime config services),
 * leaving the LLM-emitted placeholder channel (named after the class)
 * unbridged. The customer can declare the mapping here as a static escape
 * hatch. YAML wins over PHP extraction when both produce a value.
 */
const MessageChannelClassRouteSchema = z.object({
    /** CQRS class short name as emitted by the LLM at the dispatch site (e.g. "OrderPlacedEvent"). */
    class: z.string(),
    /** Canonical routing key the class dispatches to (e.g. "acme.inventory.order.placed"). */
    routing_key: z.string(),
});

const MessageChannelsSchema = z.object({
    /** Explicit logical/DI alias → physical channel mapping. Overrides guesses. */
    aliases: z.array(MessageChannelAliasSchema).default([]),
    /**
     * Cross-broker mirror declarations (Shovel/Federation/MirrorMaker). Each
     * entry creates a LogicalChannel node and N MANIFESTS_AS edges to physical
     * channels declared in `messageBrokers[]`. Customer-declared only.
     */
    mirrors: z.array(MessageChannelMirrorSchema).default([]),
    /** Class-name bridge overrides. Applied AFTER PHP extraction, YAML wins. */
    class_routes: z.array(MessageChannelClassRouteSchema).default([]),
});

/**
 * Customer-declared broker instance. Used to disambiguate channels when DSNs
 * contain unresolved env-vars, and to anchor `channelAliases[].physical[]`
 * entries. The fingerprint is derived from (provider+host+port+vhost) when
 * not explicitly provided.
 */
const MessageBrokerDeclarationSchema = z.object({
    /** Stable id referenced from `message_channels.mirrors[].physical[].broker`. */
    id: z.string(),
    provider: z.enum([
        'rabbitmq', 'kafka', 'pubsub', 'sqs', 'sns', 'azure-service-bus',
        'nats', 'pulsar', 'redis-streams', 'mqtt', 'mosquitto', 'zeromq',
        'symfony-messenger',
    ]),
    cluster: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    /** RabbitMQ vhost / Pulsar namespace. */
    vhost: z.string().optional(),
    region: z.string().optional(),
    env: z.string().optional(),
    /**
     * Override the fingerprint. When omitted, the loader computes
     * sha256_trunc8(provider:host:port:vhost). Provide this only when the
     * config alone cannot distinguish two brokers (e.g. same host:port with
     * different functional roles).
     */
    fingerprint: z.string().optional(),
});

export type MessageBrokerDeclaration = z.infer<typeof MessageBrokerDeclarationSchema>;

// ─── Crossplane CRD Claims (structural MessageChannel extraction) ────────────

/**
 * Maps a Crossplane claim CRD kind to the MessageChannel semantics it
 * provisions. Consumed by the crossplane-pubsub structural plugin, which
 * ships neutral defaults (AcmePubSubTopicClaim / AcmePubSubTopicSubscriptionClaim).
 * Platform teams declare their own claim kinds here; a configured entry with
 * the same `kind` as a default overrides that default.
 */
const CrossplaneCrdSchema = z.object({
    /**
     * Kubernetes CRD kind to match (exact), e.g. "AcmePubSubTopicClaim".
     * Must end in "Claim" (the Crossplane claim naming convention) — the
     * plugin's content pre-filter fast-fails files without a `*Claim` kind.
     */
    kind: z.string(),
    /** MessageChannel semantics the claim provisions. */
    channelKind: z.enum(['topic', 'subscription']),
    /** Dot-path into the parsed manifest for the channel name, e.g. "spec.topicId". */
    nameField: z.string(),
    /** For subscriptions: dot-path for the linked topic name. */
    topicField: z.string().optional(),
    /** Broker technology identifier. */
    technology: z.string().default('pubsub'),
});

export type CrossplaneCrd = z.infer<typeof CrossplaneCrdSchema>;

const CrossplaneSchema = z.object({
    /** Claim kinds the structural plugin maps to MessageChannel nodes. */
    crds: z.array(CrossplaneCrdSchema).default([]),
});

// ─── Sink Classifier (LLM-driven I/O sink discovery) ─────────────────────────

const SinkClassifierPrivacySchema = z.object({
    /**
     * Glob patterns. Matching packages NEVER reach the LLM.
     * Recommended for any repository containing proprietary or ambiguous
     * packages — the LLM only sees package NAMES, so `@acme/legacy-db-wrapper`
     * is unclassifiable from name alone. Bulk-deny with a glob and choose
     * `on_denied: classify_as_sink` to preserve coverage without leaking names.
     */
    deny_patterns: z.array(z.string()).default([]),
    /**
     * If non-empty, ONLY matching packages reach the LLM. Most restrictive
     * setting — appropriate for air-gapped or regulated tenants where the
     * default posture is "everything is private".
     */
    allow_patterns: z.array(z.string()).default([]),
    /** Default fate for denied packages. */
    on_denied: z.enum(['classify_as_sink', 'classify_as_ignore', 'hardcoded_only']).default('classify_as_sink'),
}).strict();

const SinkClassifierBudgetSchema = z.object({
    max_llm_tokens_per_run: z.number().int().positive().default(200_000),
    max_usd_per_run: z.number().positive().default(0.50),
    concurrency: z.number().int().positive().default(2),
}).strict();

const SinkClassifierCacheSchema = z.object({
    backend: z.enum(['file']).default('file'),
    ttl_days: z.number().int().positive().default(90),
}).strict();

const SinkClassifierDriftSchema = z.object({
    alert_on_disagreement: z.boolean().default(false),
    alert_threshold: z.number().int().nonnegative().default(5),
}).strict();

const SinkClassifierSchema = z.object({
    /**
     * enabled (default) | disabled | force-refresh.
     * Two cache layers keep the LLM cost negligible on warm runs: a per-repo
     * snapshot fast-path skips classification entirely when the dependency
     * set is unchanged, and a per-package cross-repo cache skips packages
     * already classified anywhere on this tenant.
     */
    mode: z.enum(['disabled', 'enabled', 'force-refresh']).default('enabled'),
    /** When no snapshot exists, blocking waits for first classification; nonblocking proceeds with hardcoded. */
    bootstrap_mode: z.enum(['blocking', 'nonblocking']).default('nonblocking'),
    confidence_threshold: z.number().min(0).max(1).default(0.7),
    max_packages_per_batch: z.number().int().positive().default(200),
    timeout_ms: z.number().int().positive().default(60_000),
    cache: SinkClassifierCacheSchema.default({ backend: 'file', ttl_days: 90 }),
    budget: SinkClassifierBudgetSchema.default({ max_llm_tokens_per_run: 200_000, max_usd_per_run: 0.50, concurrency: 2 }),
    privacy: SinkClassifierPrivacySchema.default({ deny_patterns: [], allow_patterns: [], on_denied: 'classify_as_sink' }),
    drift: SinkClassifierDriftSchema.default({ alert_on_disagreement: false, alert_threshold: 5 }),
}).strict();

export type SinkClassifierConfig = z.infer<typeof SinkClassifierSchema>;

/**
 * Shared field map: single source of truth for BOTH schema variants below.
 */
const repoHintsShape = {
    /** Taint engine configuration: what to analyze, what to ignore, SDK→service maps. */
    packages: PackagesSchema.optional(),
    /** Custom framework decorators for deterministic AST extraction. */
    decorators: z.array(DecoratorSchema).default([]),
    /** Database identity scoping + datastore declarations (unified). */
    databases: z.array(DatabaseSchema).default([]),
    /** AI prompt hints for proprietary SDK patterns. */
    hints: z.array(HintSchema).default([]),
    /** Message channel alias mappings for runtime/DI names that static analysis cannot resolve. */
    message_channels: MessageChannelsSchema.default({ aliases: [], mirrors: [], class_routes: [] }),
    /** Customer-declared broker instances (override DSN env-var resolution + mirror anchor). */
    messageBrokers: z.array(MessageBrokerDeclarationSchema).default([]),
    /** Crossplane claim-kind mappings for structural MessageChannel extraction. */
    crossplane: CrossplaneSchema.optional(),
    /** Custom env-var accessor wrappers the lexical scanner cannot see through. */
    envAccessors: z.array(EnvAccessorSchema).default([]),
    /** LLM sink classifier configuration (Layer 3 of taint analysis). */
    sink_classifier: SinkClassifierSchema.optional(),
    /**
     * Service topology configuration.
     *
     * Controls how Backstage Components are mapped to graph nodes:
     * - `monolith`:  collapse all Components into 1 Service + N DeploymentUnits
     * - `monorepo`:  each Component = independent Service (default behavior)
     * - `auto`:      heuristic detection based on shared manifest presence
     */
    services: ServicesSchema.optional(),
    /**
     * Ingestion tunables for per-repo overrides.
     */
    ingestion: z.object({
        /**
         * Hard cap on PRODUCES_FIELD / CONSUMES_FIELD edges materialised per
         * Function-DataStructure pair. When the schema has more fields than
         * the cap, the first N are linked and `PRODUCES.fieldsCapped=true`
         * is stamped on the PRODUCES edge so the lineage gate knows to fall
         * back to HAS_FIELD for fields beyond the cap. Default 50 keeps the
         * edge cardinality bounded on monolith schemas (e.g. 551-field
         * "save" Frankensteins) while still capturing the common path.
         */
        maxFieldsPerPayload: z.number().int().positive().optional().default(50),
    }).optional(),
};

/**
 * Runtime schema: LENIENT by contract. Unknown keys are tolerated (catchall)
 * because loadRepoHints must never reject a customer file at ingestion time —
 * it degrades to defaults on hard errors and ignores extra keys otherwise.
 */
export const RepoHintsSchema = z.object(repoHintsShape).strict().catchall(z.unknown());

/**
 * Authoring/validation twin: STRICT at the top level so section-name typos
 * (`decoratorss:`) surface as unrecognized-keys errors. Used by `cr validate`
 * and the generated JSON Schema — never by the runtime loader.
 */
export const RepoHintsStrictSchema = z.strictObject(repoHintsShape);

export type RepoHints = z.infer<typeof RepoHintsSchema>;
export type MessageChannelAlias = z.infer<typeof MessageChannelAliasSchema>;

// ─── Computed Accessors ──────────────────────────────────────────────────────
// Pure derivations from the flat schema. Zero data duplication.

/** Effective list of extra sink packages (plain names only — typed entries included by name). */
export function getExtraSinks(hints: RepoHints): string[] {
    if (!hints.packages) return [];
    return hints.packages.analyze.map(entry =>
        typeof entry === 'string' ? entry : entry.name,
    );
}

/** Effective list of packages to ignore from taint. */
export function getIgnorePackages(hints: RepoHints): string[] {
    return hints.packages?.ignore ?? [];
}

/** Sink classifier configuration, with safe defaults when omitted.
 *  `CODERADIUS_SINK_CLASSIFIER_MODE` overrides the mode for the whole
 *  process — operational kill-switch for CI/test hermeticity (the
 *  classifier performs live LLM calls when its snapshot misses). */
export function getSinkClassifierConfig(hints: RepoHints): SinkClassifierConfig {
    const base = hints.sink_classifier ?? SinkClassifierSchema.parse({}); // all defaults
    const envMode = process.env.CODERADIUS_SINK_CLASSIFIER_MODE;
    if (envMode === 'disabled' || envMode === 'enabled' || envMode === 'force-refresh') {
        return { ...base, mode: envMode };
    }
    return base;
}

/** Declared env-accessor wrappers (empty when none configured). */
export function getEnvAccessors(hints: RepoHints): EnvAccessor[] {
    return hints.envAccessors ?? [];
}

/** Configured Crossplane CRD claim mappings (empty when none declared). */
export function getCrossplaneCrds(hints: RepoHints): CrossplaneCrd[] {
    return hints.crossplane?.crds ?? [];
}

// ─── Loader ──────────────────────────────────────────────────────────────────

const HINTS_FILENAMES = ['coderadius.yaml', 'coderadius.yml'];

/**
 * Module-level memoization: load repo hints at most once per repo path
 * per process. Eliminates redundant YAML file reads across all consumers
 * (static-analyzer, graph-writer, orchestrator, ephemeral-extractor, workflow).
 */
const _hintsCache = new Map<string, RepoHints>();

/**
 * Load repo-level hints from a `coderadius.yaml` (or fallback names) 
 * in the repo root. Returns a validated RepoHints object, or default empty 
 * hints if no file exists or the file is invalid.
 *
 * Results are memoized per repo path. Call clearRepoHintsCache() to invalidate.
 */
export function loadRepoHints(repoRoot: string): RepoHints {
    if (_hintsCache.has(repoRoot)) return _hintsCache.get(repoRoot)!;
    const hints = _loadFromDisk(repoRoot);
    _hintsCache.set(repoRoot, hints);
    return hints;
}

/**
 * Invalidate the repo hints cache. Called by --force mode and test cleanup.
 * If repoRoot is provided, only that entry is cleared; otherwise the entire cache is flushed.
 */
export function clearRepoHintsCache(repoRoot?: string): void {
    if (repoRoot) { _hintsCache.delete(repoRoot); _loadErrors.delete(repoRoot); }
    else { _hintsCache.clear(); _loadErrors.clear(); }
}

/**
 * Last load failure per repo path, recorded by _loadFromDisk. loadRepoHints
 * keeps its silent-default contract (ingestion must never fail on a bad
 * customer file); callers that talk to a human (analyze workflow, CLI)
 * surface this so the failure stops being invisible.
 */
const _loadErrors = new Map<string, string>();

export function getLastHintsLoadError(repoRoot: string): string | null {
    return _loadErrors.get(repoRoot) ?? null;
}

/** @internal Load hints from disk — the actual I/O and validation logic. */
function _loadFromDisk(repoRoot: string): RepoHints {
    for (const filename of HINTS_FILENAMES) {
        const filePath = path.join(repoRoot, filename);
        if (!fs.existsSync(filePath)) continue;

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = yaml.load(raw);

            if (!parsed || typeof parsed !== 'object') {
                _loadErrors.set(repoRoot, `${filename} is empty or not an object`);
                logger.warn(`[RepoHints] ${filename} is empty or not an object — using defaults`);
                return getDefaultHints();
            }

            const result = RepoHintsSchema.safeParse(parsed);
            if (result.success) {
                const hints = result.data;
                const hintsCount = countHints(hints);
                if (hintsCount > 0) {
                    logger.debug(`[RepoHints] Loaded ${hintsCount} hint(s) from ${filename}`);
                }
                return hints;
            } else {
                const detail = result.error.issues[0]?.message ?? 'unknown error';
                _loadErrors.set(repoRoot, `Invalid ${filename}: ${detail}`);
                logger.warn(`[RepoHints] Invalid ${filename}: ${detail} — using defaults`);
                return getDefaultHints();
            }
        } catch (err) {
            _loadErrors.set(repoRoot, `Failed to read ${filename}: ${(err as Error).message}`);
            logger.warn(`[RepoHints] Failed to read ${filename}: ${(err as Error).message} — using defaults`);
            return getDefaultHints();
        }
    }

    return getDefaultHints();
}

// ─── Prompt Generation ───────────────────────────────────────────────────────

/**
 * Convert loaded RepoHints into an LLM prompt block that can be injected
 * alongside the taint context and language-specific hints.
 * 
 * Returns undefined if no hints are configured.
 */
/**
 * Broker-client packages whose provider the customer declared. The pair
 * (package name, provider) feeds the s2 declared-sink candidate lane: package
 * name = co-import gate, provider = contract-grade classification.
 */
export function getDeclaredBrokerClients(hints: RepoHints): Array<{ name: string; provider: NonNullable<SdkPackageEntry['provider']> }> {
    const out: Array<{ name: string; provider: NonNullable<SdkPackageEntry['provider']> }> = [];
    for (const entry of hints.packages?.analyze ?? []) {
        if (typeof entry === 'string') continue;
        if (entry.kind !== 'broker-client' || !entry.provider) continue;
        out.push({ name: entry.name, provider: entry.provider });
    }
    return out;
}

export function buildCustomKnowledgePrompt(hints: RepoHints): string | undefined {
    const sections: string[] = [];

    // ── Manual hints[] ────────────────────────────────────────────────────────
    for (const item of hints.hints ?? []) {
        sections.push(`- Patterns [${item.patterns.join(', ')}]: ${item.description}`);
    }

    // ── Auto-generated hints from typed packages.analyze entries ─────────────
    // Typed entries (with `kind`) know what type of I/O the SDK performs,
    // so we can generate an LLM instruction that overrides the generic
    // wrapper suppression rule — same mechanism as manual hints.
    for (const entry of hints.packages?.analyze ?? []) {
        if (typeof entry === 'string') continue; // plain strings: taint only, no hint

        const label = entry.label ?? entry.name;
        // Derive a class-name-like pattern from the package name
        // e.g. @acme/notification-client → NotificationClient
        const classNameGuess = entry.name
            .split('/')
            .pop()!
            .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
            .replace(/^([a-z])/, (_, c: string) => c.toUpperCase());

        let description: string;
        if (entry.kind === 'http-client') {
            const urlSuffix = entry.baseUrl ? ` (base URL: ${entry.baseUrl})` : '';
            description = `${entry.name} / ${classNameGuess} is an HTTP API client SDK${urlSuffix}. ` +
                `Any method call on it (e.g. .send(), .get(), .post(), .sendEmail(), etc.) is an OUTBOUND HTTP API call. ` +
                `Emit an APIEndpoint OUTBOUND node with name="${label}".`;
        } else if (entry.kind === 'broker-client') {
            description = `${entry.name} / ${classNameGuess} is a message broker client SDK. ` +
                `Any publish/emit/send call on it is a MessageChannel WRITES operation. ` +
                `Emit a MessageChannel node with name="${label}".`;
        } else {
            description = `${entry.name} / ${classNameGuess} is a database client SDK. ` +
                `Treat any read/write call on it as DataContainer I/O with name="${label}".`;
        }

        sections.push(`- Patterns [${entry.name}, ${classNameGuess}]: ${description}`);
    }

    if (sections.length === 0) return undefined;

    return `\n--- Custom Domain Knowledge (from coderadius.yaml) ---\nThe following describes proprietary SDKs and wrappers used in this codebase.\nApply these rules when you encounter the listed patterns:\n${sections.join('\n')}\n--- End Custom Domain Knowledge ---`;
}

/**
 * Extract exact table/collection names from databases[].tables config.
 * Only non-glob entries are returned (no '*', no 'prefix_*', no '*_suffix').
 * These serve as config-declared ground truth for the sanitizer allowlist.
 */
export function getExactConfiguredTables(hints: RepoHints): Set<string> {
    const tables = new Set<string>();
    for (const db of hints.databases) {
        for (const pattern of db.tables) {
            if (!pattern.includes('*')) {
                tables.add(pattern);
            }
        }
    }
    return tables;
}

/** Resolve a logical channel name seen in code/DI to a configured physical channel. */
export function resolveMessageChannelAlias(
    hints: RepoHints,
    name: string,
): MessageChannelAlias | undefined {
    return hints.message_channels?.aliases?.find(alias => alias.from === name);
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDefaultHints(): RepoHints {
    return {
        decorators: [],
        databases: [],
        hints: [],
        message_channels: { aliases: [], mirrors: [], class_routes: [] },
        messageBrokers: [],
        envAccessors: [],
    };
}

// ─── Services Topology Accessors ─────────────────────────────────────────────

/**
 * Get the declared topology for the repository.
 * Returns 'auto' (default) if no explicit topology is configured.
 */
export function getTopology(hints: RepoHints): 'monolith' | 'monorepo' | 'auto' {
    return hints.services?.topology ?? 'auto';
}

/**
 * Get the role override for a specific component.
 * Returns undefined if no override is configured.
 */
export function getComponentRoleOverride(
    hints: RepoHints,
    componentName: string,
): 'deployment-facet' | 'independent-service' | undefined {
    return hints.services?.overrides?.[componentName]?.role;
}

/**
 * Get the name override map for identity welding.
 * Keys are original catalog names, values are desired "useful" names.
 */
export function getNameOverrides(hints: RepoHints): Record<string, string> {
    return hints.services?.nameOverrides ?? {};
}

function countHints(hints: RepoHints): number {
    let count = hints.hints.length;
    count += hints.decorators.length;
    count += hints.databases.length;
    count += hints.envAccessors.length;
    count += hints.crossplane?.crds?.length ?? 0;
    count += hints.message_channels?.aliases?.length ?? 0;
    if (hints.packages) {
        count += hints.packages.analyze.length;
        count += hints.packages.ignore.length;
    }
    return count;
}
