// ═══════════════════════════════════════════════════════════════════════════════
// Telemetry Collector — Pipeline Funnel Metrics & Cost Estimator
//
// Tracks the full ingestion funnel from Tree-sitter parse through LLM invocation.
// Designed for:
//   1. VC due diligence: "85% of functions are filtered before spending a token"
//   2. Engineering observability: which gate catches what
//   3. Cost estimation: real-time LLM spend tracking (token-based)
//
// Singleton — import `telemetryCollector` from this module.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TokenUsage {
    promptTokens?: number;
    completionTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    cachedInputTokens?: number;
}

// ─── Phase Token Tracking ────────────────────────────────────────────────────

export type TokenPhase =
    | 'infra_discovery'      // infra-discovery scout (per repo)
    | 'symbol_extraction'    // config-symbol-extractor (per config file)
    | 'static_analysis'      // unified-analyzer (per function)
    | 'schema_extraction'    // schema-extractor (per file, deep only)
    | 'endpoint_matchmaking'  // matchmaker (API Endpoint Matchmaking step)
    | 'global_resolution'    // matchmaker reused in Cross-Service Resolution (deep only)
    | 'agentic_metadata'     // agentic-metadata-extractor (per AgenticConfig entity)
    | 'sink_classification'; // sink-classifier (per repo)

export interface PhaseTokens {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
}

export interface FunnelCounters {
    /** Total function chunks extracted by Tree-sitter */
    totalFunctionsParsed: number;
    /** Functions in untainted files — never reached heuristic filter */
    droppedUntainted: number;
    /** Functions that passed via Gate 1 (UseCase entrypoint) */
    passedGate1: number;
    /** Functions that passed via Gate 2 (architectural convention: Repository / Runner / Publisher) */
    passedGate2: number;
    /** Functions that passed via Gate 3 (synthetic chunks: consumer rescue, server actions, ORM metadata) */
    passedGate3: number;
    /** Functions that passed via Gate 4 (tainted symbol detection) */
    passedGate4: number;
    /** Functions that passed via Gate 5 (DI alias detection) */
    passedGate5: number;
    /** Functions that passed via Gate 6 (framework decorator + supplemental static-analyzer rescue) */
    passedGate6: number;
    /** Functions that passed via Gate 7 (Zodios-typed consumer import — post-LLM resolver attaches emergent_api_calls) */
    passedGate7: number;
    /** Functions that failed ALL gates — discarded */
    droppedAllGates: number;
    /** Functions skipped because Merkle hash matched (unchanged code) */
    cacheHits: number;
    /** Files skipped at repo or file level (hash unchanged) */
    fileCacheHits: number;
    /** Actual LLM API calls made */
    llmInvocations: number;
    /** Functions resolved via the static bypass (AST-resolved, zero LLM tokens) */
    staticBypasses: number;
    /** LLM said has_io === false — correctly filtered non-I/O function */
    llmRejections: number;
    /** LLM returned empty/invalid structured output — function at risk of data loss */
    llmFailures: number;
    /** Transient retry attempts triggered by empty structured output */
    llmRetries: number;
    /** Functions recovered via the fallback model after primary returned empty */
    llmFallbackSaves: number;
    /** Retry attempts triggered by upstream 429 / quota exhaustion */
    rateLimitRetries: number;
    /** Functions recovered by the post-batch deferred-retry drain pass */
    deferredRecovered: number;
    /** Deferred functions that still failed (429-exhausted) after the drain pass */
    deferredFinalFailed: number;
    /**
     * Negative telemetry: broker-ish env values seen but never grounded —
     * `:BrokerCandidate` ledger entries left unbound after the bind pass.
     */
    brokerCandidatesUnbound: number;
    /**
     * Service→Broker bindings whose broker is a pure convention-guess
     * (key-name provider, no contract-grade corroboration): visible recall,
     * excluded from cross-service welds until corroborated.
     */
    brokerGuessOnlyBindings: number;
    /** Flat token totals (all phases combined) */
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedTokens: number;
    embeddingTokens: number;
    /** Per-phase token breakdown */
    phaseTokens: Record<TokenPhase, PhaseTokens>;
    /** Agentic metadata enrichment — entities successfully enriched */
    enrichOk: number;
    /** Agentic metadata enrichment — entities that failed LLM extraction */
    enrichFail: number;
    /** Agentic metadata enrichment — total wall-clock time in ms */
    enrichTimeMs: number;

    // ─── Sink Classifier (LLM-driven I/O sink discovery) ─────────────────────
    /** Cache hits in the cross-repo sink classifier cache. */
    sinkClassifierCacheHits: number;
    /** Cache misses (forces an LLM call). */
    sinkClassifierCacheMisses: number;
    /** Cache entries rejected because HMAC signature mismatch. */
    sinkClassifierIntegrityFailures: number;
    /** Actual classifier LLM invocations (after batching). */
    sinkClassifierLLMInvocations: number;
    /** Classifications that passed all anti-hallucination checks. */
    sinkClassifierAccepted: number;
    /** Names that did not appear verbatim in input — rejected. */
    sinkClassifierRejectedHallucination: number;
    /** Confidence below threshold or no evidence — rejected. */
    sinkClassifierRejectedNoEvidence: number;
    /** Looked like a typosquat of a well-known sink — rejected. */
    sinkClassifierRejectedTyposquat: number;
    /** Times the classifier failed entirely and pipeline fell back to hardcoded. */
    sinkClassifierFallbackHardcoded: number;
    /** Distinct package names suppressed by the privacy filter. */
    sinkClassifierPrivacyFiltered: number;
    /** LLM disagreed with hardcoded list (drift signal). */
    sinkClassifierDriftDisagreements: number;
    /** New sinks discovered by LLM that aren't in the hardcoded list. */
    sinkClassifierDriftNewDiscoveries: number;
    /** Times the budget circuit breaker tripped. */
    sinkClassifierBudgetTripped: number;

    // ─── DataStructure / DataField (Phase 1-2: scoping, GC, field lineage) ───
    /** Emergent message_payload DataStructures persisted with a scopeKey (Phase 1A). */
    dsScoped: number;
    /** DataStructures persisted with a global URN (deterministic schema or database_table). */
    dsGlobal: number;
    /** Orphan DataStructures removed by the GC sweep (Phase 1C). */
    dsOrphansCleaned: number;
    /** Cascaded orphan DataFields removed when their parent DataStructure was deleted. */
    dsOrphanFieldsCleaned: number;
    /** PRODUCES_FIELD edges created (Phase 2). */
    fieldLineageProduces: number;
    /** CONSUMES_FIELD edges created (Phase 2). */
    fieldLineageConsumes: number;
    /** Field-edges dropped by the per-payload cap (Phase 2). Surfaces monolith schemas. */
    fieldLineageCapped: number;
    /** Phase 1 (Fix #1) — payloads persisted from AST only (LLM didn't surface them). */
    dsAstResolved: number;
    /** Phase 1 — payloads where AST and LLM converged on the same basename (composite). */
    dsAstLlmConverged: number;
    /** Phase 1 — payloads persisted from LLM only (baseline). */
    dsLlmOnly: number;
    /** Phase 3 (Fix #2) — REFERENCES_TYPE edges linked by the welder this run. */
    fieldReferencesLinked: number;
    /** Phase 3 (Fix #2) — REFERENCES_TYPE edges tombstoned (stale from prior commits). */
    fieldReferencesSwept: number;
    /** HAS_SCHEMA edges welded by `weldChannelPayloadsByFunction` (Scope A, channel↔payload). */
    channelPayloadHasSchemaLinked: number;
    /** CARRIED_BY edges welded by `weldChannelPayloadsByFunction` (Scope A, channel↔payload). */
    channelPayloadCarriedByLinked: number;
    /** HAS_REQUEST_SCHEMA edges welded by `weldApiEndpointSchemasByFunction` (Scope B). */
    apiEndpointHasRequestSchemaLinked: number;
    /** HAS_RESPONSE_SCHEMA edges welded by `weldApiEndpointSchemasByFunction` (Scope B). */
    apiEndpointHasResponseSchemaLinked: number;
}

export interface IngestionMetrics {
    startTime: number;
    endTime?: number;
    timings: {
        parsing: number;
        llm: number;
        total: number;
    };
    counts: {
        filesProcessed: number;
        filesSkipped: number;
        functionsIngested: number;
        functionsSkipped: number;
        functionsUnchanged: number;
        errors: number;
    };
    errors: string[];
}

export interface CostEstimate {
    /** Cost of this specific run (incremental — only tokens used this run) */
    totalCost: number;
    /** LLM-only cost (excludes embeddings) */
    llmCost: number;
    /** Embedding cost */
    embeddingCost: number;
    /** Model used for cost calculation */
    modelLabel: string;
    /** Price per 1M input tokens (USD) */
    inputPricePer1M: number;
    /** Price per 1M cached input tokens (USD) */
    cachedInputPricePer1M?: number;
    /** Price per 1M output tokens (USD) */
    outputPricePer1M: number;
    /** Embedding price per 1M tokens (USD) */
    embeddingPricePer1M: number;
}

export interface EnrichmentError {
    repoName: string;
    filePath: string;
    errorMessage: string;
    stackTrace?: string;
    errorType: string;
}

export interface TelemetryReport {
    funnel: FunnelCounters;
    metrics: IngestionMetrics;
    cost: CostEstimate;
    enrichErrors?: EnrichmentError[];
}

// ─── Model → Price Map (Token-Based) ────────────────────────────────────────

interface ModelPricing {
    /** Price per 1M input tokens (USD) */
    inputPricePer1M: number;
    /** Price per 1M cached input tokens (USD) */
    cachedInputPricePer1M?: number;
    /** Price per 1M output tokens (USD) */
    outputPricePer1M: number;
    /** Human-readable label */
    label: string;
}

/**
 * Embedding model pricing (USD per 1M tokens).
 * Keyed by the embedding model name or common prefix.
 */
const EMBEDDING_PRICE_MAP: Record<string, number> = {
    // Gemini embeddings
    'gemini-embedding-001': 0.25,
    'gemini-embedding': 0.25,          // prefix match for variants
    'text-embedding-004': 0.25,
    'text-embedding': 0.25,            // prefix match
    // Vertex AI text-embedding (same billing)
    'textembedding-gecko': 0.025,
    // OpenAI embeddings
    'text-embedding-ada-002': 1.00,
    'text-embedding-3-small': 0.02,
    'text-embedding-3-large': 0.13,
    // Ollama (free)
    'ollama': 0,
};

/**
 * Resolve the embedding price per 1M tokens for the configured embedding model.
 */
function resolveEmbeddingPrice(embeddingModel: string): number {
    // Direct match
    if (EMBEDDING_PRICE_MAP[embeddingModel] !== undefined) {
        return EMBEDDING_PRICE_MAP[embeddingModel];
    }
    // Prefix match
    for (const [key, price] of Object.entries(EMBEDDING_PRICE_MAP)) {
        if (embeddingModel.startsWith(key)) {
            return price;
        }
    }
    // Unknown — assume free
    return 0;
}

const MODEL_PRICE_MAP: Record<string, ModelPricing> = {
    'gemini-3.5-flash': {
        inputPricePer1M: 1.50,
        cachedInputPricePer1M: 0.15,
        outputPricePer1M: 9.00,
        label: 'Gemini 3.5 Flash',
    },
    'gemini-3.1-pro': {
        inputPricePer1M: 2.00,
        cachedInputPricePer1M: 0.05,
        outputPricePer1M: 12.00,
        label: 'Gemini 3.1 Pro',
    },
    'gemini-3.1-flash-lite': {
        inputPricePer1M: 0.25,
        cachedInputPricePer1M: 0.05,
        outputPricePer1M: 1.50,
        label: 'Gemini 3.1 Flash Lite',
    },
    'gemini-3-flash-preview': {
        inputPricePer1M: 0.50,
        cachedInputPricePer1M: 0.05,
        outputPricePer1M: 3.00,
        label: 'Gemini 3 Flash',
    },
    'gemini-3-flash': {
        inputPricePer1M: 0.50,
        cachedInputPricePer1M: 0.05,
        outputPricePer1M: 3.00,
        label: 'Gemini 3 Flash',
    },
    'gemini-3.0-pro': {
        inputPricePer1M: 1.25,
        cachedInputPricePer1M: 0.05,
        outputPricePer1M: 10.00,
        label: 'Gemini 3.0 Pro',
    },
    'gemini-2.5-flash': {
        inputPricePer1M: 0.30,
        cachedInputPricePer1M: 0.03,
        outputPricePer1M: 2.50,
        label: 'Gemini 2.5 Flash',
    },
    'gemini-2.5-flash-lite': {
        inputPricePer1M: 0.10,
        cachedInputPricePer1M: 0.03,
        outputPricePer1M: 0.40,
        label: 'Gemini 2.5 Flash Lite',
    },
    'gemini-2.0-flash': {
        inputPricePer1M: 0.10,
        cachedInputPricePer1M: 0.01,
        outputPricePer1M: 0.40,
        label: 'Gemini 2.0 Flash',
    },
    'gemini-2.0-flash-lite': {
        inputPricePer1M: 0.075,
        cachedInputPricePer1M: 0.01,
        outputPricePer1M: 0.30,
        label: 'Gemini 2.0 Flash Lite',
    },

    // OpenAI
    'gpt-5.5': {
        inputPricePer1M: 5.00,
        cachedInputPricePer1M: 0.50,
        outputPricePer1M: 30.00,
        label: 'GPT-5.5',
    },
    'gpt-5.4': {
        inputPricePer1M: 2.50,
        cachedInputPricePer1M: 0.25,
        outputPricePer1M: 15.00,
        label: 'GPT-5.4',
    },
    'gpt-5.4-mini': {
        inputPricePer1M: 0.75,
        cachedInputPricePer1M: 0.075,
        outputPricePer1M: 4.50,
        label: 'GPT-5.4 Mini',
    },
    'gpt-5.2': {
        inputPricePer1M: 1.75,
        cachedInputPricePer1M: 0.175,
        outputPricePer1M: 14.00,
        label: 'GPT-5.2',
    },
    'gpt-5.1': {
        inputPricePer1M: 1.25,
        cachedInputPricePer1M: 0.125,
        outputPricePer1M: 10.00,
        label: 'GPT-5.1',
    },
    'gpt-5': {
        inputPricePer1M: 1.25,
        cachedInputPricePer1M: 0.125,
        outputPricePer1M: 10.00,
        label: 'GPT-5',
    },
    'gpt-5-mini': {
        inputPricePer1M: 0.25,
        cachedInputPricePer1M: 0.025,
        outputPricePer1M: 2.00,
        label: 'GPT-5 Mini',
    },
    'gpt-5-nano': {
        inputPricePer1M: 0.05,
        cachedInputPricePer1M: 0.005,
        outputPricePer1M: 0.40,
        label: 'GPT-5 Nano',
    },
    'o1': {
        inputPricePer1M: 15.00,
        cachedInputPricePer1M: 1.50,
        outputPricePer1M: 60.00,
        label: 'OpenAI o1',
    },
    'o3': {
        inputPricePer1M: 2.00,
        cachedInputPricePer1M: 0.20,
        outputPricePer1M: 8.00,
        label: 'OpenAI o3',
    },
    'o3-mini': {
        inputPricePer1M: 1.10,
        cachedInputPricePer1M: 0.11,
        outputPricePer1M: 4.40,
        label: 'OpenAI o3-mini',
    },
    'gpt-4o': {
        inputPricePer1M: 2.50,
        cachedInputPricePer1M: 0.25,
        outputPricePer1M: 10.00,
        label: 'GPT-4o',
    },
    'gpt-4o-mini': {
        inputPricePer1M: 0.15,
        cachedInputPricePer1M: 0.015,
        outputPricePer1M: 0.60,
        label: 'GPT-4o Mini',
    },
    'gpt-4.1-mini': {
        inputPricePer1M: 0.40,
        cachedInputPricePer1M: 0.04,
        outputPricePer1M: 1.60,
        label: 'GPT-4.1 Mini',
    },
    'gpt-4.1-nano': {
        inputPricePer1M: 0.10,
        cachedInputPricePer1M: 0.01,
        outputPricePer1M: 0.40,
        label: 'GPT-4.1 Nano',
    },

    // Anthropic
    'claude-opus-4.7': {
        inputPricePer1M: 5.00,
        cachedInputPricePer1M: 0.50,
        outputPricePer1M: 25.00,
        label: 'Claude Opus 4.7',
    },
    'claude-opus-4.6': {
        inputPricePer1M: 5.00,
        cachedInputPricePer1M: 0.50,
        outputPricePer1M: 25.00,
        label: 'Claude Opus 4.6',
    },
    'claude-opus-4.5': {
        inputPricePer1M: 5.00,
        cachedInputPricePer1M: 0.50,
        outputPricePer1M: 25.00,
        label: 'Claude Opus 4.5',
    },
    'claude-opus-4.1': {
        inputPricePer1M: 15.00,
        cachedInputPricePer1M: 1.50,
        outputPricePer1M: 75.00,
        label: 'Claude Opus 4.1',
    },
    'claude-opus-4': {
        inputPricePer1M: 15.00,
        cachedInputPricePer1M: 1.50,
        outputPricePer1M: 75.00,
        label: 'Claude Opus 4',
    },
    'claude-sonnet-4.6': {
        inputPricePer1M: 3.00,
        cachedInputPricePer1M: 0.30,
        outputPricePer1M: 15.00,
        label: 'Claude Sonnet 4.6',
    },
    'claude-sonnet-4.5': {
        inputPricePer1M: 3.00,
        cachedInputPricePer1M: 0.30,
        outputPricePer1M: 15.00,
        label: 'Claude Sonnet 4.5',
    },
    'claude-sonnet-4': {
        inputPricePer1M: 3.00,
        cachedInputPricePer1M: 0.30,
        outputPricePer1M: 15.00,
        label: 'Claude Sonnet 4',
    },
    'claude-haiku-4.5': {
        inputPricePer1M: 1.00,
        cachedInputPricePer1M: 0.10,
        outputPricePer1M: 5.00,
        label: 'Claude Haiku 4.5',
    },
    'claude-3-haiku': {
        inputPricePer1M: 0.25,
        cachedInputPricePer1M: 0.03,
        outputPricePer1M: 1.25,
        label: 'Claude 3 Haiku',
    },
    'claude-3-5-haiku': {
        inputPricePer1M: 0.80,
        cachedInputPricePer1M: 0.08,
        outputPricePer1M: 4.00,
        label: 'Claude 3.5 Haiku',
    },
    'claude-3-5-sonnet': {
        inputPricePer1M: 3.00,
        cachedInputPricePer1M: 0.30,
        outputPricePer1M: 15.00,
        label: 'Claude 3.5 Sonnet',
    },
    'claude-3-7-sonnet': {
        inputPricePer1M: 3.00,
        cachedInputPricePer1M: 0.30,
        outputPricePer1M: 15.00,
        label: 'Claude 3.7 Sonnet',
    },

    // Local
    'ollama': {
        inputPricePer1M: 0,
        cachedInputPricePer1M: 0,
        outputPricePer1M: 0,
        label: 'Ollama (local)',
    },
};

// ─── Collector ───────────────────────────────────────────────────────────────

// Width for separator lines (matches the CLI header box width)
const LINE_WIDTH = 78;
const SEP_THIN = '\x1b[90m' + '─'.repeat(LINE_WIDTH) + '\x1b[0m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(value: string): number {
    return value.replace(ANSI_RE, '').length;
}

function padVisibleEnd(value: string, width: number): string {
    return value + ' '.repeat(Math.max(0, width - visibleLength(value)));
}

function padVisibleStart(value: string, width: number): string {
    return ' '.repeat(Math.max(0, width - visibleLength(value))) + value;
}

function reportRule(width = LINE_WIDTH): string {
    return `  \x1b[90m${'─'.repeat(width)}\x1b[0m`;
}

class TelemetryCollector {
    // ── Funnel counters ──────────────────────────────────────────────────
    private funnel: FunnelCounters = {
        totalFunctionsParsed: 0,
        droppedUntainted: 0,
        passedGate1: 0,
        passedGate2: 0,
        passedGate3: 0,
        passedGate4: 0,
        passedGate5: 0,
        passedGate6: 0,
        passedGate7: 0,
        droppedAllGates: 0,
        cacheHits: 0,
        fileCacheHits: 0,
        llmInvocations: 0,
        staticBypasses: 0,
        llmRejections: 0,
        llmFailures: 0,
        llmRetries: 0,
        llmFallbackSaves: 0,
        rateLimitRetries: 0,
        deferredRecovered: 0,
        deferredFinalFailed: 0,
        brokerCandidatesUnbound: 0,
        brokerGuessOnlyBindings: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        embeddingTokens: 0,
        phaseTokens: {
            infra_discovery: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            symbol_extraction: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            static_analysis: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            schema_extraction: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            endpoint_matchmaking: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            global_resolution: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            agentic_metadata: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            sink_classification: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        },
        enrichOk: 0,
        enrichFail: 0,
        enrichTimeMs: 0,
        sinkClassifierCacheHits: 0,
        sinkClassifierCacheMisses: 0,
        sinkClassifierIntegrityFailures: 0,
        sinkClassifierLLMInvocations: 0,
        sinkClassifierAccepted: 0,
        sinkClassifierRejectedHallucination: 0,
        sinkClassifierRejectedNoEvidence: 0,
        sinkClassifierRejectedTyposquat: 0,
        sinkClassifierFallbackHardcoded: 0,
        sinkClassifierPrivacyFiltered: 0,
        sinkClassifierDriftDisagreements: 0,
        sinkClassifierDriftNewDiscoveries: 0,
        sinkClassifierBudgetTripped: 0,
        // Phase 1-2 DataStructure / field-lineage counters
        dsScoped: 0,
        dsGlobal: 0,
        dsOrphansCleaned: 0,
        dsOrphanFieldsCleaned: 0,
        fieldLineageProduces: 0,
        fieldLineageConsumes: 0,
        fieldLineageCapped: 0,
        dsAstResolved: 0,
        dsAstLlmConverged: 0,
        dsLlmOnly: 0,
        fieldReferencesLinked: 0,
        fieldReferencesSwept: 0,
        channelPayloadHasSchemaLinked: 0,
        channelPayloadCarriedByLinked: 0,
        apiEndpointHasRequestSchemaLinked: 0,
        apiEndpointHasResponseSchemaLinked: 0,
    };

    // ── Performance metrics ──────────────────────────────────────────────
    private metrics: IngestionMetrics = {
        startTime: Date.now(),
        timings: { parsing: 0, llm: 0, total: 0 },
        counts: {
            filesProcessed: 0,
            filesSkipped: 0,
            functionsIngested: 0,
            functionsSkipped: 0,
            functionsUnchanged: 0,
            errors: 0,
        },
        errors: [],
    };

    // ── Active model (set at CLI startup) ────────────────────────────────
    private activeProvider: string = '';
    private activeModel: string = '';
    private activeEmbeddingModel: string = '';

    // ── Enterprise Error Logging ─────────────────────────────────────────
    private enrichErrors: EnrichmentError[] = [];
    private enrichmentCrashDumpPath: string | null = null;

    // ═════════════════════════════════════════════════════════════════════
    // Model configuration
    // ═════════════════════════════════════════════════════════════════════

    /**
     * Set the active model from config. Called once at CLI startup.
     */
    setModel(provider: string, model: string, embeddingModel?: string) {
        this.activeProvider = provider;
        this.activeModel = model;
        if (embeddingModel) this.activeEmbeddingModel = embeddingModel;
    }

    getActiveModel(): { provider: string; model: string } {
        return { provider: this.activeProvider, model: this.activeModel };
    }

    /**
     * Resolve pricing for the active model. Returns undefined if unknown.
     */
    private resolveModelPricing(): ModelPricing | undefined {
        // Direct match
        if (MODEL_PRICE_MAP[this.activeModel]) {
            return MODEL_PRICE_MAP[this.activeModel];
        }
        // Prefix match (e.g. "gemini-2.0-flash-001" → "gemini-2.0-flash")
        for (const [key, pricing] of Object.entries(MODEL_PRICE_MAP)) {
            if (this.activeModel.startsWith(key)) {
                return pricing;
            }
        }
        return undefined;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Funnel counter methods
    // ═════════════════════════════════════════════════════════════════════

    incrementTotalFunctionsParsed(count: number = 1) {
        this.funnel.totalFunctionsParsed += count;
    }

    incrementDroppedUntainted(count: number = 1) {
        this.funnel.droppedUntainted += count;
    }

    incrementPassedGate(gate: 1 | 2 | 3 | 4 | 5 | 6 | 7) {
        if (gate === 1) this.funnel.passedGate1++;
        else if (gate === 2) this.funnel.passedGate2++;
        else if (gate === 3) this.funnel.passedGate3++;
        else if (gate === 4) this.funnel.passedGate4++;
        else if (gate === 5) this.funnel.passedGate5++;
        else if (gate === 6) this.funnel.passedGate6++;
        else if (gate === 7) this.funnel.passedGate7++;
    }

    incrementDroppedAllGates() {
        this.funnel.droppedAllGates++;
    }

    incrementCacheHits(count: number = 1) {
        this.funnel.cacheHits += count;
    }

    // ─── DataStructure / DataField counters (Phase 1-2) ──────────────────────
    incrementDsScoped(count: number = 1) { this.funnel.dsScoped += count; }
    incrementDsGlobal(count: number = 1) { this.funnel.dsGlobal += count; }
    incrementDsOrphansCleaned(structures: number, fields: number) {
        this.funnel.dsOrphansCleaned += structures;
        this.funnel.dsOrphanFieldsCleaned += fields;
    }
    incrementFieldLineage(produces: number, consumes: number, capped: number) {
        this.funnel.fieldLineageProduces += produces;
        this.funnel.fieldLineageConsumes += consumes;
        this.funnel.fieldLineageCapped += capped;
    }
    incrementDsAstResolved(count: number = 1) { this.funnel.dsAstResolved += count; }
    incrementDsAstLlmConverged(count: number = 1) { this.funnel.dsAstLlmConverged += count; }
    incrementDsLlmOnly(count: number = 1) { this.funnel.dsLlmOnly += count; }
    incrementFieldReferencesType(linked: number, swept: number) {
        this.funnel.fieldReferencesLinked += linked;
        this.funnel.fieldReferencesSwept += swept;
    }
    incrementChannelPayloadWeld(hasSchema: number, carriedBy: number) {
        this.funnel.channelPayloadHasSchemaLinked += hasSchema;
        this.funnel.channelPayloadCarriedByLinked += carriedBy;
    }
    incrementApiEndpointSchemaWeld(hasRequest: number, hasResponse: number) {
        this.funnel.apiEndpointHasRequestSchemaLinked += hasRequest;
        this.funnel.apiEndpointHasResponseSchemaLinked += hasResponse;
    }

    incrementFileCacheHits(count: number = 1) {
        this.funnel.fileCacheHits += count;
    }

    incrementLLMInvocations() {
        this.funnel.llmInvocations++;
    }

    /** Function resolved via the static bypass (AST-resolved, zero LLM tokens) */
    incrementStaticBypass() {
        this.funnel.staticBypasses++;
    }

    /** Negative telemetry from bindBrokerCandidates(): unbound ledger entries. */
    addBrokerCandidatesUnbound(n: number) {
        this.funnel.brokerCandidatesUnbound += n;
    }

    /** Bindings landing on guess-only (needsReview) brokers this run. */
    addBrokerGuessOnlyBindings(n: number) {
        this.funnel.brokerGuessOnlyBindings += n;
    }

    incrementLLMRejections() {
        this.funnel.llmRejections++;
    }

    /** LLM returned empty/invalid structured output — distinct from a clean rejection */
    incrementLLMFailures() {
        this.funnel.llmFailures++;
    }

    /** Counts a single retry attempt triggered by empty structured output */
    incrementRetries() {
        this.funnel.llmRetries++;
    }

    /** Counts a function recovered via the fallback model after primary returned empty */
    incrementFallbackSaves() {
        this.funnel.llmFallbackSaves++;
    }

    /** Counts a single retry attempt triggered by upstream 429 / quota exhaustion */
    incrementRateLimitRetries(count: number = 1) {
        this.funnel.rateLimitRetries += count;
    }

    /** Counts a function recovered by the post-batch deferred-retry drain pass */
    incrementDeferredRecovered(count: number = 1) {
        this.funnel.deferredRecovered += count;
    }

    /** Counts a deferred function that still failed after the drain pass (429-exhausted) */
    incrementDeferredFinalFailed(count: number = 1) {
        this.funnel.deferredFinalFailed += count;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Agentic Metadata Enrichment counters
    // ═════════════════════════════════════════════════════════════════════

    incrementEnrichOk(count: number = 1) {
        this.funnel.enrichOk += count;
    }

    incrementEnrichFail(count: number = 1) {
        this.funnel.enrichFail += count;
    }

    addEnrichError(error: EnrichmentError) {
        this.enrichErrors.push(error);
    }

    addEnrichTime(ms: number) {
        this.funnel.enrichTimeMs += ms;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Sink Classifier counters
    // ═════════════════════════════════════════════════════════════════════

    incrementSinkClassifierCounter(
        name:
            | 'CacheHits'
            | 'CacheMisses'
            | 'IntegrityFailures'
            | 'LLMInvocations'
            | 'Accepted'
            | 'RejectedHallucination'
            | 'RejectedNoEvidence'
            | 'RejectedTyposquat'
            | 'FallbackHardcoded'
            | 'PrivacyFiltered'
            | 'DriftDisagreements'
            | 'DriftNewDiscoveries'
            | 'BudgetTripped',
        delta: number = 1,
    ) {
        const key = `sinkClassifier${name}` as keyof FunnelCounters;
        const current = this.funnel[key] as number;
        (this.funnel[key] as number) = current + delta;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Legacy MetricsCollector methods (backward compat)
    // ═════════════════════════════════════════════════════════════════════

    startTimer(): number {
        return Date.now();
    }

    stopTimer(startTime: number): number {
        return Date.now() - startTime;
    }

    addParsingTime(ms: number) {
        this.metrics.timings.parsing += ms;
    }

    addLLMTime(ms: number) {
        this.metrics.timings.llm += ms;
    }

    addTokens(usage?: TokenUsage) {
        if (!usage) return;
        this.funnel.inputTokens += usage.promptTokens ?? usage.inputTokens ?? 0;
        this.funnel.outputTokens += usage.completionTokens ?? usage.outputTokens ?? 0;
        this.funnel.totalTokens += usage.totalTokens
            ?? ((usage.promptTokens ?? usage.inputTokens ?? 0) + (usage.completionTokens ?? usage.outputTokens ?? 0));
        this.funnel.cachedTokens += usage.cachedInputTokens ?? usage.cachedTokens ?? 0;
    }

    /**
     * Add tokens for a specific pipeline phase. Also increments flat totals
     * for backward compatibility. Use this instead of addTokens() in agents.
     */
    addTokensForPhase(phase: TokenPhase, usage?: TokenUsage) {
        if (!usage) return;
        const inTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
        const outTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
        const cachedTokens = usage.cachedInputTokens ?? usage.cachedTokens ?? 0;
        const totalTokens = usage.totalTokens ?? (inTokens + outTokens);
        // Flat totals (backward compat)
        this.funnel.inputTokens += inTokens;
        this.funnel.outputTokens += outTokens;
        this.funnel.totalTokens += totalTokens;
        this.funnel.cachedTokens += cachedTokens;
        // Per-phase
        this.funnel.phaseTokens[phase].inputTokens += inTokens;
        this.funnel.phaseTokens[phase].outputTokens += outTokens;
        this.funnel.phaseTokens[phase].cachedTokens += cachedTokens;
    }

    addEmbeddingTokens(tokens: number) {
        this.funnel.embeddingTokens += tokens;
    }

    incrementFilesProcessed() {
        this.metrics.counts.filesProcessed++;
    }

    incrementFilesSkipped(count: number = 1) {
        this.metrics.counts.filesSkipped += count;
    }

    incrementFunctionsIngested() {
        this.metrics.counts.functionsIngested++;
    }

    incrementFunctionsSkipped() {
        this.metrics.counts.functionsSkipped++;
    }

    incrementFunctionsUnchanged(count: number = 1) {
        this.metrics.counts.functionsUnchanged += count;
    }

    incrementErrors(msg?: string) {
        this.metrics.counts.errors++;
        if (msg) {
            this.metrics.errors.push(msg);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Reports & Estimation
    // ═════════════════════════════════════════════════════════════════════

    getReport(): IngestionMetrics {
        this.metrics.endTime = Date.now();
        this.metrics.timings.total = this.metrics.endTime - this.metrics.startTime;
        return { ...this.metrics };
    }

    getFunnel(): FunnelCounters {
        return { ...this.funnel };
    }

    getEnrichErrors(): EnrichmentError[] {
        return [...this.enrichErrors];
    }

    /**
     * Set the file path where the crash dump was saved so we can print it
     * in the final summary.
     */
    setEnrichmentCrashDumpPath(dumpPath: string) {
        this.enrichmentCrashDumpPath = dumpPath;
    }

    /**
     * Estimate LLM cost based on actual token usage.
     * Uses active model pricing if available.
     */
    estimateCost(opts?: {
        inputPricePer1M?: number;
        cachedInputPricePer1M?: number;
        outputPricePer1M?: number;
        modelLabel?: string;
    }): CostEstimate {
        const modelPricing = this.resolveModelPricing();
        const inputPrice = opts?.inputPricePer1M ?? modelPricing?.inputPricePer1M ?? 0;
        const cachedInputPrice = opts?.cachedInputPricePer1M ?? modelPricing?.cachedInputPricePer1M ?? inputPrice;
        const outputPrice = opts?.outputPricePer1M ?? modelPricing?.outputPricePer1M ?? 0;
        const modelLabel = opts?.modelLabel ?? modelPricing?.label ?? `${this.activeProvider}/${this.activeModel}`;

        const inputTokens = this.funnel.inputTokens;
        const outputTokens = this.funnel.outputTokens;
        const cachedTokens = this.funnel.cachedTokens;

        // LLM cost (accounting for cached tokens discount)
        const billedInputTokens = Math.max(0, inputTokens - cachedTokens);
        const llmCost = (billedInputTokens * inputPrice / 1_000_000) +
            (cachedTokens * cachedInputPrice / 1_000_000) +
            (outputTokens * outputPrice / 1_000_000);

        // Embedding cost
        const embeddingPricePer1M = resolveEmbeddingPrice(this.activeEmbeddingModel);
        const embeddingCost = this.funnel.embeddingTokens * embeddingPricePer1M / 1_000_000;

        const totalCost = llmCost + embeddingCost;

        return {
            totalCost,
            llmCost,
            embeddingCost,
            modelLabel,
            inputPricePer1M: inputPrice,
            outputPricePer1M: outputPrice,
            embeddingPricePer1M,
        };
    }

    /**
     * Generate the unified ASCII report for terminal output.
     * Context-aware: shows/hides sections based on what data is available.
     * Works for both `ingest code` (full funnel) and `ingest meta` (enrichment only).
     */
    generateFunnelReport(): string {
        const f = this.funnel;
        const m = this.getReport();
        const fmt = (n: number) => n.toLocaleString();
        const money = (n: number) => `$${n.toFixed(4)}`;

        const hasCodePipeline = f.totalFunctionsParsed > 0;
        const hasEnrichment = f.enrichOk > 0 || f.enrichFail > 0;
        const hasTokens = f.inputTokens > 0 || f.outputTokens > 0;

        const labelWidth = 26;
        const row = (label: string, value: string, color: 'cyan' | 'red' = 'cyan') => {
            const labelCell = padVisibleEnd(label, labelWidth);
            const c = color === 'red' ? '\x1b[31m' : '\x1b[36m';
            const lc = color === 'red' ? '\x1b[31m' : '\x1b[90m';
            return `   ${lc}${labelCell}\x1b[0m \x1b[90m│\x1b[0m ${c}${value}\x1b[0m`;
        };
        const section = (title: string) => `\n  \x1b[1m${title}\x1b[0m\n${reportRule()}`;

        const lines = [
            '',
            `  \x1b[36m⬢\x1b[0m \x1b[1mIngestion Report\x1b[0m`,
            section('PERFORMANCE'),
            row('Duration', `${(m.timings.total / 1000).toFixed(2)}s`),
        ];

        if (hasCodePipeline) {
            lines.push(
                row('LLM Time', `${(m.timings.llm / 1000).toFixed(2)}s`),
                row('Parsing Time', `${(m.timings.parsing / 1000).toFixed(2)}s`),
                row('Files', `${fmt(m.counts.filesProcessed)} processed, ${fmt(m.counts.filesSkipped)} skipped`),
                row('Functions', `${fmt(m.counts.functionsIngested)} ingested, ${fmt(m.counts.functionsUnchanged)} unchanged`),
            );
        }

        // Errors (if any)
        if (m.counts.errors > 0) {
            lines.push(`\n  \x1b[31mErrors (${m.counts.errors})\x1b[0m`);
            const maxDisplay = 5;
            const toDisplay = m.errors.slice(0, maxDisplay);
            for (const err of toDisplay) {
                lines.push(`   \x1b[31mx\x1b[0m \x1b[90m${err}\x1b[0m`);
            }
            if (m.errors.length > maxDisplay) {
                lines.push(`   \x1b[90m... and ${m.errors.length - maxDisplay} more errors.\x1b[0m`);
            }
        }

        // ── Code Pipeline Funnel (only for ingest code) ─────────────────
        if (hasCodePipeline) {
            const totalParsed = f.totalFunctionsParsed || 1;
            const pct = (n: number) => `${((n / totalParsed) * 100).toFixed(1)}%`;
            const survivingFunctions = f.passedGate1 + f.passedGate2 + f.passedGate3 + f.passedGate4 + f.passedGate5 + f.passedGate6 + f.passedGate7;
            const filterRate = ((survivingFunctions / totalParsed) * 100).toFixed(1);

            lines.push(
                section('PIPELINE FUNNEL'),
                row('Total Parsed', fmt(f.totalFunctionsParsed)),
                row('Dropped (Untainted)', `${fmt(f.droppedUntainted)} (${pct(f.droppedUntainted)})`),
                row('Dropped (All Gates)', `${fmt(f.droppedAllGates)} (${pct(f.droppedAllGates)})`),
                row('Passed Gate 1 (UseCase)', fmt(f.passedGate1)),
                row('Passed Gate 2 (Convention)', fmt(f.passedGate2)),
                row('Passed Gate 3 (Synthetic)', fmt(f.passedGate3)),
                row('Passed Gate 4 (Taint)', fmt(f.passedGate4)),
                row('Passed Gate 5 (DI)', fmt(f.passedGate5)),
                row('Passed Gate 6 (Framework)', fmt(f.passedGate6)),
                row('Passed Gate 7 (API Client)', fmt(f.passedGate7)),
                row('Surviving Functions', `${fmt(survivingFunctions)} (${filterRate}% filter rate)`),
                row('Function Cache Hits', `${fmt(f.cacheHits)} (unchanged code)`),
            );

            // Static bypass: AST-resolved functions that never reached the LLM
            if (f.staticBypasses > 0) {
                const resolved = f.staticBypasses + f.llmInvocations;
                const bypassRate = resolved > 0 ? ((f.staticBypasses / resolved) * 100).toFixed(1) : '0.0';
                lines.push(row(
                    'Static Bypass',
                    `${fmt(f.staticBypasses)} (${bypassRate}% of resolved functions, zero LLM tokens)`,
                ));
            }

            // LLM quality indicators — shown when non-zero
            if (f.llmRetries > 0) {
                lines.push(row('LLM Retries', `${fmt(f.llmRetries)} (transient structured output failures)`));
            }
            if (f.rateLimitRetries > 0) {
                lines.push(row('Rate-limit Retries', `${fmt(f.rateLimitRetries)} (429 quota backoff)`));
            }
            if (f.llmFailures > 0) {
                lines.push(row('LLM Failures', `${fmt(f.llmFailures)} function(s) lost to invalid structured output`, 'red'));
            }
            if (f.llmFallbackSaves > 0) {
                lines.push(row('LLM Fallback Saves', `${fmt(f.llmFallbackSaves)} (recovered via fallback model)`));
            }
            if (f.deferredRecovered > 0 || f.deferredFinalFailed > 0) {
                lines.push(row(
                    'Deferred-retry pass',
                    `${fmt(f.deferredRecovered)} recovered, ${fmt(f.deferredFinalFailed)} final-failed`,
                ));
            }

            // Broker discovery negative telemetry — broker-ish evidence that
            // could not be grounded must be visible, never silently dropped.
            if (f.brokerCandidatesUnbound > 0) {
                lines.push(row(
                    'Broker Candidates Unbound',
                    `${fmt(f.brokerCandidatesUnbound)} (broker-ish env values with no anchor/sink — see cr review pending)`,
                    'red',
                ));
            }
            if (f.brokerGuessOnlyBindings > 0) {
                lines.push(row(
                    'Broker Guess-only Bindings',
                    `${fmt(f.brokerGuessOnlyBindings)} (key-name provider, excluded from cross-service welds)`,
                ));
            }

            if (f.fileCacheHits > 0) {
                lines.push(row('File Cache Hits', `${fmt(f.fileCacheHits)} (unchanged file/repo)`));
            }
        }

        // ── Agentic Metadata Enrichment (only if it ran) ────────────────
        if (hasEnrichment) {
            const enrichTotal = f.enrichOk + f.enrichFail;
            const enrichSec = (f.enrichTimeMs / 1000).toFixed(1);
            lines.push(
                section('AGENTIC METADATA'),
                row('Entities Enriched', `${fmt(f.enrichOk)} / ${fmt(enrichTotal)}`),
            );

            lines.push(row('Enrichment Time', `${enrichSec}s`));

            // Enterprise Error Bucketing
            if (f.enrichFail > 0 && this.enrichErrors.length > 0) {
                // Bucketing by error type
                const buckets = new Map<string, number>();
                for (const err of this.enrichErrors) {
                    buckets.set(err.errorType, (buckets.get(err.errorType) || 0) + 1);
                }

                const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);

                lines.push(`\n  \x1b[31mFAILED ENTITIES (${fmt(f.enrichFail)})\x1b[0m`);
                lines.push(reportRule());

                const maxDisplay = 5;
                const toDisplay = sortedBuckets.slice(0, maxDisplay);
                for (const [type, count] of toDisplay) {
                    lines.push(`   \x1b[31m•\x1b[0m (${count}x) ${type}`);
                }

                if (sortedBuckets.length > maxDisplay) {
                    const otherCounts = sortedBuckets.slice(maxDisplay).reduce((acc, [, c]) => acc + c, 0);
                    lines.push(`   \x1b[90m... and ${otherCounts} more errors across ${sortedBuckets.length - maxDisplay} other types.\x1b[0m`);
                }

                if (this.enrichmentCrashDumpPath) {
                    lines.push('');
                    lines.push(`   \x1b[90mFull stack traces: \x1b[4m${this.enrichmentCrashDumpPath}\x1b[0m`);
                }
            } else if (f.enrichFail > 0) {
                lines.push(row('Failed Entities', fmt(f.enrichFail)));
            }
        }

        // ── Tokens ──────────────────────────────────────────────────────
        if (hasTokens) {
            lines.push(
                section('TOKEN USAGE'),
                row('Input Tokens', fmt(f.inputTokens)),
                row('Cached Tokens', fmt(f.cachedTokens)),
                row('Output Tokens', fmt(f.outputTokens)),
                row('Total Tokens', fmt(f.totalTokens)),
            );
            // Cache rate: share of input tokens served from the Vertex prefix cache
            if (f.inputTokens > 0) {
                const cacheRate = ((f.cachedTokens / f.inputTokens) * 100).toFixed(1);
                lines.push(row('Cache Rate', `${cacheRate}% of input tokens`));
            }
            if (f.embeddingTokens > 0) {
                lines.push(row('Embedding Tokens', fmt(f.embeddingTokens)));
            }

            // Per-phase breakdown (only if multiple phases have tokens)
            const pt = f.phaseTokens;
            const activePhases = (
                Object.entries(pt) as Array<[TokenPhase, PhaseTokens]>
            ).filter(([, v]) => v.inputTokens > 0 || v.outputTokens > 0);

            if (activePhases.length > 1) {
                const phaseLabels: Record<TokenPhase, string> = {
                    infra_discovery: 'Infra Discovery',
                    symbol_extraction: 'Symbol Extraction',
                    static_analysis: 'Static Analysis',
                    schema_extraction: 'Schema Extraction',
                    endpoint_matchmaking: 'API Matchmaking',
                    global_resolution: 'Global Resolution',
                    agentic_metadata: 'Agentic Metadata',
                    sink_classification: 'Sink Classification',
                };
                const phaseLabelWidth = Math.max(
                    18,
                    ...activePhases.map(([phase]) => visibleLength(phaseLabels[phase])),
                );
                const inputWidth = Math.max(
                    visibleLength('Input'),
                    ...activePhases.map(([, tokens]) => visibleLength(`${fmt(tokens.inputTokens)}`)),
                );
                const cachedWidth = Math.max(
                    visibleLength('Cached'),
                    ...activePhases.map(([, tokens]) => visibleLength(`${fmt(tokens.cachedTokens)}`)),
                );
                const outputWidth = Math.max(
                    visibleLength('Output'),
                    ...activePhases.map(([, tokens]) => visibleLength(`${fmt(tokens.outputTokens)}`)),
                );

                lines.push(
                    `\n  \x1b[90mBreakdown\x1b[0m`,
                    `   \x1b[90m${padVisibleEnd('Phase', phaseLabelWidth)}  ${padVisibleStart('Input', inputWidth)}  ${padVisibleStart('Cached', cachedWidth)}  ${padVisibleStart('Output', outputWidth)}\x1b[0m`,
                );
                for (const [phase, tokens] of activePhases) {
                    const label = phaseLabels[phase];
                    const input = `${fmt(tokens.inputTokens)}`;
                    const cached = `${fmt(tokens.cachedTokens)}`;
                    const output = `${fmt(tokens.outputTokens)}`;
                    lines.push(
                        `   \x1b[90m${padVisibleEnd(label, phaseLabelWidth)}\x1b[0m  ` +
                        `\x1b[36m${padVisibleStart(input, inputWidth)}\x1b[0m  ` +
                        `\x1b[36m${padVisibleStart(cached, cachedWidth)}\x1b[0m  ` +
                        `\x1b[36m${padVisibleStart(output, outputWidth)}\x1b[0m`,
                    );
                }
            }
        }

        // ── Economics (only if model pricing is known) ───────────────────
        if (hasTokens) {
            const modelPricing = this.resolveModelPricing();
            if (modelPricing) {
                const cost = this.estimateCost();
                lines.push(
                    section('ECONOMICS'),
                    row('LLM Cost', money(cost.llmCost)),
                    row('Model', cost.modelLabel),
                );
                if (cost.embeddingCost > 0 || f.embeddingTokens > 0) {
                    lines.push(row('Embedding Cost', money(cost.embeddingCost)));
                    lines.push(row('Total Estimated', money(cost.totalCost)));
                } else {
                    lines.push(row('Total Estimated', money(cost.totalCost)));
                }
            }
        }

        lines.push('', SEP_THIN, '');
        return lines.join('\n');
    }

    /**
     * Writes the collected agentic metadata enrichment errors to a JSON dump file
     * if there are any errors. Returns the absolute path of the dump file.
     */
    exportEnrichmentCrashDump(): string | null {
        if (this.enrichErrors.length === 0) return null;

        const fs = require('fs');
        const path = require('path');
        const { paths } = require('../config/paths.js');

        try {
            const dir = paths.logs.dir;
            fs.mkdirSync(dir, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dumpPath = path.join(dir, `ingest-errors-${timestamp}.json`);

            const payload = {
                timestamp: new Date().toISOString(),
                totalErrors: this.enrichErrors.length,
                errors: this.enrichErrors,
            };

            fs.writeFileSync(dumpPath, JSON.stringify(payload, null, 2));
            this.setEnrichmentCrashDumpPath(dumpPath);
            return dumpPath;
        } catch (err) {
            // Failsafe in case filesystem is unwritable
            return null;
        }
    }

    /**
     * Machine-readable export of all telemetry data.
     */
    toJSON(): TelemetryReport {
        return {
            funnel: this.getFunnel(),
            metrics: this.getReport(),
            cost: this.estimateCost(),
            enrichErrors: this.getEnrichErrors(),
        };
    }

    /**
     * Reset all counters (useful for tests).
     */
    reset() {
        this.funnel = {
            totalFunctionsParsed: 0,
            droppedUntainted: 0,
            passedGate1: 0,
            passedGate2: 0,
            passedGate3: 0,
            passedGate4: 0,
            passedGate5: 0,
            passedGate6: 0,
            passedGate7: 0,
            droppedAllGates: 0,
            cacheHits: 0,
            fileCacheHits: 0,
            llmInvocations: 0,
            staticBypasses: 0,
            llmRejections: 0,
            llmFailures: 0,
            llmRetries: 0,
            llmFallbackSaves: 0,
            rateLimitRetries: 0,
            deferredRecovered: 0,
            deferredFinalFailed: 0,
            brokerCandidatesUnbound: 0,
            brokerGuessOnlyBindings: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cachedTokens: 0,
            embeddingTokens: 0,
            phaseTokens: {
                infra_discovery: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                symbol_extraction: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                static_analysis: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                schema_extraction: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                endpoint_matchmaking: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                global_resolution: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                agentic_metadata: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                sink_classification: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            },
            enrichOk: 0,
            enrichFail: 0,
            enrichTimeMs: 0,
            sinkClassifierCacheHits: 0,
            sinkClassifierCacheMisses: 0,
            sinkClassifierIntegrityFailures: 0,
            sinkClassifierLLMInvocations: 0,
            sinkClassifierAccepted: 0,
            sinkClassifierRejectedHallucination: 0,
            sinkClassifierRejectedNoEvidence: 0,
            sinkClassifierRejectedTyposquat: 0,
            sinkClassifierFallbackHardcoded: 0,
            sinkClassifierPrivacyFiltered: 0,
            sinkClassifierDriftDisagreements: 0,
            sinkClassifierDriftNewDiscoveries: 0,
            sinkClassifierBudgetTripped: 0,
            dsScoped: 0,
            dsGlobal: 0,
            dsOrphansCleaned: 0,
            dsOrphanFieldsCleaned: 0,
            fieldLineageProduces: 0,
            fieldLineageConsumes: 0,
            fieldLineageCapped: 0,
            dsAstResolved: 0,
            dsAstLlmConverged: 0,
            dsLlmOnly: 0,
            fieldReferencesLinked: 0,
            fieldReferencesSwept: 0,
            channelPayloadHasSchemaLinked: 0,
            channelPayloadCarriedByLinked: 0,
            apiEndpointHasRequestSchemaLinked: 0,
            apiEndpointHasResponseSchemaLinked: 0,
        };
        this.metrics = {
            startTime: Date.now(),
            timings: { parsing: 0, llm: 0, total: 0 },
            counts: {
                filesProcessed: 0,
                filesSkipped: 0,
                functionsIngested: 0,
                functionsSkipped: 0,
                functionsUnchanged: 0,
                errors: 0,
            },
            errors: [],
        };
        this.enrichErrors = [];
        this.enrichmentCrashDumpPath = null;
        this.activeProvider = '';
        this.activeModel = '';
    }
}

export const telemetryCollector = new TelemetryCollector();
