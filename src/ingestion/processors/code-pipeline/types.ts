import type { CodeChunk, ResolvedRepo } from '../../../graph/types.js';
import type { DiscoveredService } from '../../extractors/autodiscovery.js';
import type { MerkleIndex } from '../../core/merkle.js';
import type { UnifiedAnalysis } from '../../../ai/agents/unified-analyzer.js';
import type {
    DependencyMapping,
    FrameworkSignal,
    ResourceDeclaration,
    ClientBinding,
    ResolvedConstant,
} from '../../core/languages/types.js';
import type { DataSchemaExtraction } from '../../../ai/agents/schema-extractor.js';
import type { ZodiosResolvedCall } from './zodios-context-builder.js';

export type { UnifiedAnalysis } from '../../../ai/agents/unified-analyzer.js';

// ─── Phase 1 (AST-first payload extraction) ──────────────────────────────────

/**
 * AST-resolved payload candidate for a function (Phase 1, Fix #1).
 *
 * Pre-computed in `buildDeepTypeMetadata` by combining the language plugin's
 * `extractFunctionPayloadHints` output with the file-level `typeDefIndex`.
 * Plumbed through `AnalysisTask` so graph-writer can merge AST fields with
 * the LLM's payloads, and so the sanitizer can recover `_opaque_reference`
 * markers post-LLM.
 */
export interface AstResolvedPayload {
    direction: 'produced' | 'consumed';
    fqcn: string;
    basename: string;
    origin: 'parameter' | 'return-type' | 'new-expression';
    fields: Array<{ name: string; type: string }>;
    source: 'ast';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pipeline Inter-Stage Contracts
//
// These interfaces define the strict data contracts between the 4 pipeline
// stages. Each stage consumes the output of the previous stage and produces
// a typed output for the next. No stage may bypass the contract.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Stage 1 Output: File Discovery & Routing ────────────────────────────────

/**
 * Classifies a discovered file's ownership within a monorepo.
 * A file can belong to a Service (apps/*), a Library (packages/*),
 * or the root Repository.
 */
export interface OwnershipRouting {
    type: 'service' | 'library' | 'repository';
    /** The entity name (service name, library name, or repo name). */
    name: string;
    /** URN identifier for the entity. */
    urn: string;
}

/**
 * Stage 1 → Stage 2 contract.
 *
 * Represents a single discovered source file, enriched with all the
 * metadata needed for analysis: its owning repo, its path relative to
 * the repo root, its monorepo routing, its current Merkle file hash,
 * and (if applicable) its owning auto-discovered service.
 */
export interface FileContext {
    /** Absolute path to the file on disk. */
    absolutePath: string;
    /** Path relative to the repo root. */
    relativePath: string;
    /** The parent repository. */
    repo: ResolvedRepo;
    /** Monorepo ownership routing (service / library / repository). */
    routing: OwnershipRouting;
    /** SHA-256 hash of the file content (Merkle leaf). */
    fileHash: string;
    /** The auto-discovered service this file belongs to, if any. */
    ownerService: DiscoveredService | null;
    /** Whether this file is a dependency manifest (package.json, composer.json). */
    isManifest: boolean;
}

/**
 * The output of Stage 1 for an entire repo.
 */
export interface DiscoveryResult {
    /** The repository being processed. */
    repo: ResolvedRepo;
    /** Files that are ready for analysis. */
    files: FileContext[];
    /** Previously loaded Merkle index for incremental comparison. */
    merkleIndex: MerkleIndex;
    /** Aggregate file hash for repo-level skip detection. */
    repoHash: string;
    /** Files skipped at discovery level (test files, etc.). */
    skippedCount: number;
    /**
     * All repo-relative file paths — used by language plugins to resolve
     * `require_once`, PSR-4 namespace imports, etc. without I/O.
     */
    allFilePaths: Set<string>;
    /**
     * Dependency namespace→directory mappings loaded from project config
     * (composer.json PSR-4, tsconfig.paths, go.mod, etc.).
     * Populated by the file-discovery stage via each language plugin.
     */
    dependencyMappings: DependencyMapping[];
}

// ─── Stage 2 Output: Static Analysis & Context Engine ────────────────────────

/**
 * Represents a dependency manifest that was parsed but does not need
 * LLM analysis. Produced for package.json / composer.json files.
 */
export interface ManifestResult {
    kind: 'manifest';
    fileContext: FileContext;
    /** Parsed dependencies from the manifest. */
    dependencies: Array<{
        ecosystem: string;
        name: string;
        requiredVersion: string;
        isDev: boolean;
        isInternal: boolean;
    }>;
}

/**
 * Stage 2 → Stage 3 contract.
 *
 * Represents a single function/method that has passed the heuristic gate
 * and is ready for semantic extraction via the LLM. Contains the code
 * chunk plus all contextual metadata needed by the LLM.
 *
 * CRITICAL: In the future, this will be enriched with:
 * - File-level imports (use ... or import ...)
 * - Class-level properties and the constructor (for DI understanding)
 * - The target method/function
 *
 * Currently mirrors the existing CodeChunk + metadata contract.
 */
export interface AnalysisTask {
    kind: 'analysis';
    /** Deterministic URN for this function: urn:function:{repo}:{path}:{name} */
    functionId: string;
    /** SHA-256 hash of the function source code (Merkle leaf). */
    functionHash: string;
    /** The parsed code chunk from Tree-sitter. */
    chunk: CodeChunk;
    /** The file this function belongs to. */
    fileContext: FileContext;
    /** Static filter gate that promoted this function into the LLM queue. */
    filterGate?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
    /** Human-readable reason emitted by the static filter. */
    filterReason?: string;
    /**
     * Structured sink categories (database/broker/cache/storage/http/process)
     * derived from the file's I/O imports at build time. Drives prompt + schema
     * scoping in the analyzer WITHOUT parsing the human-readable taint summary.
     * Undefined = scope cannot be determined safely → analyzer uses full schema.
     */
    sinkCategories?: string[];

    // ─── Future Context Enrichment (Enterprise DI support) ───────────
    // These fields are scaffolded for the next iteration when we add
    // class-level and file-level context extraction.

    /** File-level import statements (future). */
    imports?: string[];
    /** Class constructor source code (future, for DI analysis). */
    constructorSource?: string;
    /** Class-level property declarations (future, for DI analysis). */
    classProperties?: string[];
    /** Auto-generated taint context summary for LLM prompt enrichment. */
    taintContextSummary?: string;
    /** Per-repo custom domain knowledge prompt (from coderadius.yaml). */
    customKnowledge?: string;
    /** Cross-file data structure definitions resolved from AST (deep mode only). */
    resolvedTypeDefinitions?: string;
    /** Resolved entity→table context from static ORM analysis, injected into LLM prompt. */
    entityTableContext?: string;
    /** Decorator/builder-derived framework facts injected into the LLM prompt. */
    frameworkSignalContext?: string;
    /** Raw matched framework signals for deterministic overlays after the LLM call. */
    matchedFrameworkSignals?: FrameworkSignal[];
    /**
     * String/number constants declared in the same file, resolved from AST.
     * Injected into the LLM prompt so it can resolve ClassName.CONSTANT (TS/JS) or
     * ClassName::CONSTANT (PHP) references to their literal string values.
     *
     * Format (example):
     *   --- File Constants (resolved from AST) ---
     *   // Module-level
     *   TOPIC_NAME = 'my.topic'
     *   // Class OrderService
     *   OrderService.EVENT_NAME = 'order.created'
     *   --- End File Constants ---
     *
     * Limitation: only intra-file constants are resolved. Constants imported from
     * another module (e.g. `import { Events } from '../constants'`) are NOT resolved;
     * cross-file constant resolution would require the ImportGraph.
     */
    classConstantsContext?: string;
    /** Deterministic infra declarations extracted beside the LLM path. */
    resourceDeclarations?: ResourceDeclaration[];
    /** Provider-token -> client binding facts extracted from AST. */
    clientBindings?: ClientBinding[];
    /** Local/imported constants resolved to literal values for sanitizer use. */
    resolvedConstants?: ResolvedConstant[];
    /** Prompt block describing DI-resolved client bindings for this task. */
    clientBindingContext?: string;
    /** Prompt block describing imported GraphQL documents referenced by this task. */
    graphQLDocumentContext?: string;
    /** Prompt block describing statically resolved critical I/O invocation arguments. */
    resolvedInvocationContext?: string;
    /** Structured Zodios API calls resolved deterministically from the AST (post-LLM injection). */
    zodiosResolvedCalls?: ZodiosResolvedCall[];
    /** Exact table/collection names from databases[].tables config (ground truth for sanitizer). */
    configuredTableNames?: Set<string>;
    /**
     * Names of TypeScript / PHP interfaces marked as `service` role (method signatures)
     * by the language plugin's typeDefIndex. Hoisted per-file in the task-builder
     * and shared by reference across every task for that file. Used by the sanitizer
     * to drop produced/consumed_payloads whose name matches a service-interface.
     */
    knownServiceInterfaces?: Set<string>;

    /**
     * Phase 1 (Fix #1) — AST-resolved payload candidates for this function.
     * Cross-referenced against the file-level `typeDefIndex` to attach
     * concrete `fields`. Used by the graph-writer to merge with LLM-emitted
     * payloads and by the sanitizer for opaque-recovery.
     */
    astResolvedPayloads?: AstResolvedPayload[];

    // ─── Static-First: AST-Resolved Analysis (LLM bypass) ────────────

    /**
     * Pre-extracted infrastructure from deterministic AST analysis.
     * When present, this is ground-truth data that should NOT be overridden by LLM.
     * When `isResolvedStatically` is true, the LLM call is skipped entirely.
     */
    staticAnalysis?: UnifiedAnalysis;

    /**
     * If true, this task's analysis is fully resolved from AST metadata
     * and does not require an LLM call. The semantic-extractor will
     * synthesize an ExtractedFunctionData from staticAnalysis directly.
     */
    isResolvedStatically?: boolean;
}

/**
 * A reference to a function that was unchanged (Merkle match) and still
 * needs its SourceFile→Function link persisted in Neo4j.
 */
export interface UnchangedFunctionRef {
    /** Deterministic URN for this function. */
    functionId: string;
    /** Path relative to repo root. */
    relativePath: string;
    /** Repository name (needed for the link query). */
    repoName: string;
}

/**
 * A file that was skipped due to Merkle cache hit (unchanged since last ingestion).
 */
export interface CacheHitResult {
    kind: 'cache-hit';
    fileContext: FileContext;
    /** Number of functions that were unchanged (from Merkle index). */
    unchangedFunctionCount: number;
    /** Unchanged function references that need link persistence. */
    unchangedFunctions: UnchangedFunctionRef[];
}

/**
 * Schema extraction task context, produced when the AST gate detects
 * potential schema definitions in the file.
 */
export interface SchemaContext {
    /** Absolute file path. */
    filePath: string;
    /** Path relative to repo root, used as schema identifier. */
    relativePath: string;
    /**
     * Canonical repo qualifier (`{org}/{name}`) propagated from `FileContext.repo`.
     * Used to construct the SourceFile URN consistently with merkle's
     * `Repository -[:CONTAINS]-> SourceFile` link. Required: deriving it from
     * `relativePath.split('/')[0]` as a fallback created shadow SourceFile
     * nodes and broke `linkDataContainerSchemas` for Doctrine-style entities.
     */
    qualifiedRepoName: string;
    /** Raw file content for the schema extraction LLM. */
    fileContent: string;
    /** Optional framework/decorator metadata to enrich schema extraction. */
    frameworkSignalContext?: string;
}

/**
 * The aggregate output of Stage 2 for a single file.
 */
export interface StaticAnalysisResult {
    fileContext: FileContext;
    /** Functions that passed heuristics and are ready for LLM analysis. */
    analysisTasks: AnalysisTask[];
    /** Functions that were skipped by the heuristic gate (no I/O). */
    skippedFunctionCount: number;
    /** Functions unchanged since last ingestion (Merkle match). */
    unchangedFunctionCount: number;
    /** Unchanged function references that need link persistence. */
    unchangedFunctions: UnchangedFunctionRef[];
    /** References to deleted functions (VNames) that were in the graph but are missing on disk. */
    deletedFunctions: string[];
    /** Schema extraction context, if AST gate passed. */
    schemaContext: SchemaContext | null;
    /** Detected language identifier. */
    language: string;
}

// ─── Stage 3 Output: Semantic Extraction ─────────────────────────────────────

/**
 * Stage 3 → Stage 4 contract.
 *
 * The fully extracted, LLM-enriched function data ready for graph
 * persistence. This is the terminal enrichment — no further transformation
 * should happen after this point.
 */
export interface ExtractedFunctionData {
    /** Deterministic URN for this function. */
    functionId: string;
    /** SHA-256 hash of the function source code. */
    functionHash: string;
    /** The parsed code chunk (name, source, language, lines). */
    chunk: CodeChunk;
    /** The file context (path, repo, routing, owner). */
    fileContext: FileContext;
    /** Structured LLM analysis output. */
    analysis: UnifiedAnalysis;
    /** Deterministic infra declarations extracted beside the LLM path. */
    resourceDeclarations?: ResourceDeclaration[];
    /** Provider-token -> client binding facts extracted from AST. */
    clientBindings?: ClientBinding[];
    /** Local/imported constants resolved to literal values for sanitizer use. */
    resolvedConstants?: ResolvedConstant[];
    /**
     * Phase 1 (Fix #1) — propagated from `AnalysisTask.astResolvedPayloads`
     * so the graph-writer can override LLM payload fields with AST ground
     * truth before persisting.
     */
    astResolvedPayloads?: AstResolvedPayload[];
    /** LLM token usage for metrics. */
    usage: { totalTokens?: number;[key: string]: any };
    /** LLM response latency in milliseconds. */
    latencyMs: number;
}

/**
 * Schema extraction result from the LLM.
 */
export interface ExtractedSchemaData {
    /** Path relative to repo root. */
    relativePath: string;
    /**
     * Canonical repo qualifier propagated from SchemaContext. Used by
     * `persistSchemas` to construct the SourceFile URN; see SchemaContext
     * for rationale.
     */
    qualifiedRepoName: string;
    /** Extracted schemas from the LLM. */
    schemas: DataSchemaExtraction[];
}

/**
 * The aggregate output of Stage 3.
 */
export interface SemanticExtractionResult {
    /** Functions that the LLM confirmed as having I/O and enriched. */
    extractedFunctions: ExtractedFunctionData[];
    /** Functions the LLM rejected (has_io === false). */
    rejectedCount: number;
    /** Functions that failed unexpectedly (e.g. LLM errors, rate limits timeout). */
    failedCount: number;
    /** Extracted schema data, if applicable. */
    extractedSchemas: ExtractedSchemaData[];
    /** Whether schema extraction failed unexpectedly. */
    schemaFailed: boolean;
    /**
     * Tasks whose LLM call exhausted the 10-attempt 429 retry budget
     * (MaxRetriesExceededError). These are NOT failures: the orchestrator
     * drains them in a second pass after the main batch completes, when
     * the global limiter is idle. Terminal-failed deferred tasks land in
     * metrics.errors via the orchestrator drain.
     */
    deferredTasks: AnalysisTask[];
}

// ─── Stage 4 Output: Graph Persistence ───────────────────────────────────────

/**
 * Stage 4 result after Neo4j persistence.
 */
export interface PersistenceResult {
    /** Number of Function nodes created/updated. */
    functionsIngested: number;
    /** Number of LogicalResource nodes linked. */
    resourcesLinked: number;
    /** Number of EnvVar nodes linked. */
    envVarsLinked: number;
    /** Number of Schema nodes created. */
    schemasCreated: number;
    /** Number of emergent APIEndpoint nodes linked. */
    apiEndpointsLinked: number;
    /** Number of DataStructure data contracts linked. */
    dataContractsLinked: number;
}

// ─── Pipeline-Wide Types ─────────────────────────────────────────────────────

/**
 * Aggregate metrics from a complete pipeline run across all repos.
 */
export interface PipelineMetrics {
    filesProcessed: number;
    filesSkipped: number;
    functionsIngested: number;
    functionsSkipped: number;
    functionsUnchanged: number;
    errors: string[];
}

export type { ProgressReporter } from '../../core/progress.js';
