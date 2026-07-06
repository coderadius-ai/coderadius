import type { CodeChunk } from '../../../graph/types.js';
import type { ScanMode } from '../../../graph/scan-mode.js';
import type {
    ClassPropertyAlias,
    DependencyBinding,
    FileImportMap,
} from '../../core/import-graph.js';
import type {
    ComponentDefinition,
    DataStructureDefinition,
    DependencyMapping,
    DependencyRequirement,
    FrameworkSignal,
    FunctionPayloadHints,
    StaticInfraResult,
    StaticSupplementalResult,
} from '../../core/languages/types.js';
import type {
    CriticalInvocationFact,
    ValueFact,
} from '../../core/value-resolution/index.js';

// ─── Parse Worker Protocol ───────────────────────────────────────────────────
//
// Message contract between the parse pool (main thread) and parse workers.
// tree-sitter is a NATIVE binding: SyntaxNode handles cannot cross threads,
// so the worker owns ALL per-file AST work and returns only flat,
// structured-clone-serializable data. Cross-file passes (import graph, taint,
// contagion, type-index merge, task gating) stay on the main thread.
// ─────────────────────────────────────────────────────────────────────────────

/** One-time worker initialization payload (passed via `workerData`). */
export interface ParseWorkerInit {
    /** Repo-relative paths of every discovered file (import resolution). */
    allFilePaths: string[];
    /** Namespace→directory mappings from project config (PSR-4, tsconfig paths, ...). */
    dependencyMappings: DependencyMapping[];
    /** Scan depth; 'contracts' enables deep type-metadata extraction. */
    scanMode: ScanMode;
}

/** Per-file work order. */
export interface ParseWorkTask {
    /** Discovery-order index; results are reassembled by this index. */
    taskId: number;
    absolutePath: string;
    relativePath: string;
    /**
     * 'fresh' runs the full extraction (chunks + per-chunk static data +
     * task-builder context). 'cache-hit' rebuilds only the light per-file
     * context the cross-file passes need (signals, constants, value facts,
     * DI metadata) — mirroring the historical cache-hit re-parse.
     */
    mode: 'fresh' | 'cache-hit';
    /**
     * Extract importMap/classAliases/dependencyBindings. False when the
     * merkle index already carries them (cache-hit) or when a contagion
     * re-dispatch keeps the previously assembled import graph.
     */
    needsImportMap: boolean;
}

/**
 * Per-chunk AST facts, index-aligned with `WorkerParseResult.chunks`.
 * Precomputed in the worker so `buildAnalysisTasks` never needs the AST.
 */
export interface ChunkStaticData {
    /** Deterministic full-bypass extraction (plugin.extractStaticInfra). */
    staticInfra: StaticInfraResult | null;
    /** Deterministic supplemental facts (plugin.extractStaticSupplements). */
    supplements: StaticSupplementalResult | null;
    /**
     * Result of the Gate-4 AST checker (hasInjectedDependencyCallsInRange,
     * falling back to hasServiceCallsInRange). Undefined when the plugin
     * implements neither. The override fires only on `=== false`.
     */
    gate4HasCalls: boolean | undefined;
    /** Result of plugin.hasServiceCallsInRange for the Gate-2 override. */
    gate2HasCalls: boolean | undefined;
}

export interface WorkerParseResult {
    taskId: number;
    relativePath: string;
    language: string;
    fileContent: string;
    /** Empty in cache-hit mode (chunks come from the merkle index instead). */
    chunks: CodeChunk[];
    frameworkSignals: FrameworkSignal[];
    fileConstants: Array<{ scope: string; name: string; value: string }>;
    valueFacts: ValueFact[];
    criticalInvocations: CriticalInvocationFact[];
    componentDefinitions: ComponentDefinition[];
    dependencyRequirements: DependencyRequirement[];
    /** Null when not extracted (needsImportMap=false or unsupported file). */
    importMap: FileImportMap | null;
    classAliases: ClassPropertyAlias[];
    dependencyBindings: DependencyBinding[];
    // ── Fresh mode only (empty/default in cache-hit mode) ──
    chunkStaticData: ChunkStaticData[];
    importStatements: string[];
    constructorSources: Map<string, string>;
    mayContainSchemas: boolean;
    // ── Deep scan (scanMode === 'contracts'), null when not extracted ──
    typeDefinitions: Map<string, DataStructureDefinition> | null;
    referencedTypes: Map<string, string[]> | null;
    payloadHints: Map<string, FunctionPayloadHints> | null;
    // ── Telemetry (folded into the main-thread collectors) ──
    parseDurationMs: number;
}

/** Worker → main messages. */
export type WorkerOutMessage =
    | { kind: 'ready' }
    | { kind: 'result'; result: WorkerParseResult }
    | { kind: 'task-error'; taskId: number; relativePath: string; error: string };

/** Main → worker messages (worker_threads transport; init rides `workerData`). */
export type WorkerInMessage = { kind: 'task'; task: ParseWorkTask };

/**
 * Main → worker messages for the CHILD-PROCESS transport (ProcessParsePool).
 * Unlike worker_threads, a spawned process has no `workerData`, so the one-time
 * ParseWorkerInit is delivered as the first IPC message; the worker replies
 * `ready` only after it is applied. Output reuses WorkerOutMessage.
 */
export type WorkerProcessInMessage =
    | { kind: 'init'; init: ParseWorkerInit }
    | { kind: 'task'; task: ParseWorkTask }
    | { kind: 'shutdown' };

/** Per-task pool outcome, index-aligned with the submitted task list. */
export type ParsePoolOutcome =
    | { ok: true; result: WorkerParseResult }
    | { ok: false; taskId: number; relativePath: string; error: string };
