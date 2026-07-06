import { analyzeFunction, analyzeFunctionBatch, analyzeMixedFunctionBatch, type InfraCategory } from '../../../ai/agents/unified-analyzer.js';
import {
    MAX_BATCH,
    batchFunctionContextOf,
    batchSharedContextOf,
    demuxBatchResponse,
    groupSinglesIntoMixedBatches,
    groupTasksForBatching,
    isIoConfirmedTask,
    mixedBatchCommonContextOf,
    mixedBatchKeyOf,
    mixedBatchMemberContextOf,
    taskScopeCategories,
} from './semantic-batch-extractor.js';
import { SingletonBatchPool } from './singleton-batch-pool.js';
import { sanitizeAnalysis } from '../../../ai/workflows/sanitizer.js';
import { extractResolvedEntityContext } from './entity-table-registry.js';
import { extractDataSchema } from '../../../ai/agents/schema-extractor.js';
import { telemetryCollector } from '../../../telemetry/index.js';
import { traceCollector } from '../../../telemetry/index.js';
import { logger } from '../../../utils/logger.js';
import { isConnectionError, MaxRetriesExceededError } from '../../../utils/congestion-control.js';
import type { AIMDSemaphore } from '../../../utils/aimd-semaphore.js';
import type { EnvVarBinding } from '../infra-manifest-resolver.js';
import type {
    AnalysisTask,
    ExtractedFunctionData,
    ExtractedSchemaData,
    SchemaContext,
    SemanticExtractionResult,
    ProgressReporter,
    UnifiedAnalysis,
} from './types.js';
import type { SymbolRegistry } from '../../core/symbol-registry.js';
import { getLanguagePlugin } from '../../core/languages/registry.js';
import type { ScanMode } from '../../../graph/scan-mode.js';
import {
    buildFrameworkSignalOverlay,
    mergeUnifiedAnalysisWithOverlay,
} from '../../core/framework-signal-overlay.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 3: Semantic Extraction
//
// Responsibility:
//   - Take AnalysisTask objects and send them to the LLM for analysis
//   - Apply the Zod-validated schema to the LLM response
//   - Extract data schemas from files flagged by the AST gate
//   - Return fully structured ExtractedFunctionData
//
// This stage knows NOTHING about Tree-sitter, file system traversal,
// heuristics, or Neo4j. It is a pure LLM interaction layer.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Function Analysis ───────────────────────────────────────────────────────

// `isIoConfirmedTask` (Stage 2 strong-gate predicate) is the single source of
// truth in semantic-batch-extractor, re-exported here so the batch grouping
// key, the per-task scoping, and the agent selection cannot drift.

function isUseCaseEntryPointTask(analysisTask: AnalysisTask): boolean {
    if (analysisTask.filterGate !== 1) return false;

    const filepath = analysisTask.chunk.filepath.replace(/\\/g, '/');
    const isUseCaseFile = filepath.includes('/application/')
        || filepath.includes('/usecases/')
        || filepath.includes('/use-cases/')
        || /\.usecase\.[jt]sx?$/i.test(filepath);
    if (!isUseCaseFile) return false;

    return /(?:^|\.)(handle|execute|run)$/.test(analysisTask.chunk.name);
}

type AnalysisPayload = { name: string; fields: { name: string; type: string }[] };
type UnifiedAnalysisWithPayloads = UnifiedAnalysis & {
    produced_payloads?: AnalysisPayload[];
    consumed_payloads?: AnalysisPayload[];
};

function preserveUseCaseEntrypoint(analysisTask: AnalysisTask, analysis: UnifiedAnalysis): UnifiedAnalysis {
    if (analysis.has_io || !isUseCaseEntryPointTask(analysisTask)) {
        return analysis;
    }

    const analysisWithPayloads = analysis as UnifiedAnalysisWithPayloads;

    return {
        ...analysis,
        has_io: true,
        intent: analysis.intent || 'UseCase entry point orchestrates application flow.',
        infrastructure: analysis.infrastructure ?? [],
        capabilities: analysis.capabilities ?? [],
        produced_payloads: analysisWithPayloads.produced_payloads ?? [],
        consumed_payloads: analysisWithPayloads.consumed_payloads ?? [],
        emergent_api_calls: analysis.emergent_api_calls ?? [],
    };
}

function preserveDeterministicDeclarations(analysisTask: AnalysisTask, analysis: UnifiedAnalysis): UnifiedAnalysis {
    if (analysis.has_io || !analysisTask.resourceDeclarations || analysisTask.resourceDeclarations.length === 0) {
        return analysis;
    }

    const analysisWithPayloads = analysis as UnifiedAnalysisWithPayloads;

    return {
        ...analysis,
        has_io: true,
        intent: analysis.intent || 'Deterministic infrastructure declaration extracted from provider/module configuration.',
        infrastructure: analysis.infrastructure ?? [],
        capabilities: [...new Set([...(analysis.capabilities ?? []), 'infrastructure-provider'])],
        produced_payloads: analysisWithPayloads.produced_payloads ?? [],
        consumed_payloads: analysisWithPayloads.consumed_payloads ?? [],
        emergent_api_calls: analysis.emergent_api_calls ?? [],
    };
}

// ─── Extraction Outcome ──────────────────────────────────────────────────────
//
// Discriminates between three distinct outcomes of a single function extraction:
//   'success'  — LLM confirmed I/O and returned structured data
//   'rejected' — LLM analysed the function and correctly classified it as non-I/O
//                (has_io=false). This is NOT an error — it is the expected path
//                for utility functions, helpers, and pure-computation code.
//   'failed'   — LLM returned an empty or invalid structured output after all
//                retries. This IS a pipeline error: the function was silently
//                dropped and must NOT be counted as a successful rejection.
//                The orchestrator uses failedCount > 0 to set repoHasErrors=true
//                and prevent the Merkle hash from being committed, forcing a
//                re-analysis of this file on the next sync run.
//
// Previously both 'rejected' and 'failed' returned null, so the caller loop
// could not distinguish them and always incremented rejectedCount. This caused
// failedCount to remain 0, the orchestrator to never set INCOMPLETE_DUE_TO_ERROR,
// and the repo hash to be committed to the Merkle cache — poisoning the cache.
export type ExtractionOutcome =
    | { kind: 'success'; data: ExtractedFunctionData }
    | { kind: 'rejected' }
    | { kind: 'failed' }
    // 429-exhausted on a per-member batch fallback: the member re-enters the
    // deferred-retry drain ALONE, without dragging its (already paid)
    // batch siblings along.
    | { kind: 'deferred' };

/** Cross-call singleton pool, owned per-repo by the orchestrator. */
export type SemanticBatchPool = SingletonBatchPool<AnalysisTask, ExtractionOutcome>;

const POOL_FLUSH_DELAY_MS = 50;

/**
 * Build the per-repo singleton pool. The executors close over
 * repo-scoped dependencies (symbol registry, env-var dict), which is why the
 * pool lifecycle MUST be per-repo: a cross-repo batch would sanitize members
 * against the wrong registry.
 */
export function createSemanticBatchPool(
    scanMode: ScanMode,
    symbolRegistry?: SymbolRegistry,
    envVarDict?: Map<string, EnvVarBinding>,
    limiter?: AIMDSemaphore | null,
    flushDelayMs: number = POOL_FLUSH_DELAY_MS,
): SemanticBatchPool {
    return new SingletonBatchPool(
        mixedBatchKeyOf,
        batch => extractFunctionBatch(batch, 'mixed', undefined, scanMode, symbolRegistry, envVarDict, limiter),
        task => extractSingleIsolated(task, undefined, scanMode, symbolRegistry, envVarDict, limiter),
        MAX_BATCH,
        flushDelayMs,
    );
}

/**
 * Run semantic extraction on a single AnalysisTask.
 * Returns a typed ExtractionOutcome to distinguish success, semantic rejection
 * (has_io=false), and LLM pipeline failure (empty structured output).
 */
async function extractFunction(
    analysisTask: AnalysisTask,
    task?: ProgressReporter,
    scanMode: ScanMode = 'semantic',
    symbolRegistry?: SymbolRegistry,
    envVarDict?: Map<string, EnvVarBinding>,
    limiter?: AIMDSemaphore | null,
): Promise<ExtractionOutcome> {
    // ── Static-First: bypass LLM entirely for AST-resolved tasks ─────
    if (analysisTask.isResolvedStatically && analysisTask.staticAnalysis) {
        traceCollector.traceLLM('STATIC', analysisTask.functionId, 'resolved from AST (LLM skipped)', {
            filePath: analysisTask.fileContext.relativePath,
            functionName: analysisTask.chunk.name,
            infrastructure: analysisTask.staticAnalysis.infrastructure?.map((i: any) => ({
                name: i.name, type: i.type, operation: i.operation,
            })),
        });
        telemetryCollector.incrementStaticBypass(); // Static path: never an LLM call

        if (task && logger.isDebugEnabled()) {
            task.report(`  \x1b[35m⚡\x1b[0m ${analysisTask.chunk.name} → STATIC (LLM bypassed)`);
        }

        return {
            kind: 'success',
            data: {
                functionId: analysisTask.functionId,
                functionHash: analysisTask.functionHash,
                chunk: analysisTask.chunk,
                fileContext: analysisTask.fileContext,
                analysis: analysisTask.staticAnalysis,  // NO sanitizer — AST data is trusted
                resourceDeclarations: analysisTask.resourceDeclarations,
                clientBindings: analysisTask.clientBindings,
                resolvedConstants: analysisTask.resolvedConstants,
                usage: { totalTokens: 0 },               // Zero LLM cost
                latencyMs: 0,                             // Instant
            },
        };
    }

    // ── Standard LLM flow ────────────────────────────────────────────
    const startMs = Date.now();
    const context = {
        imports: analysisTask.imports,
        constructorSource: analysisTask.constructorSource,
        classProperties: analysisTask.classProperties,
    };
    // Pass resolvedInvocationContext to the LLM as-is.
    // Zodios calls are NO LONGER injected here — they are merged post-LLM
    // deterministically in the block below (after sanitizeAnalysis).
    const mergedInvocationContext = analysisTask.resolvedInvocationContext || undefined;

    const result = await analyzeFunction(
        analysisTask.chunk,
        scanMode,
        context,
        analysisTask.taintContextSummary,
        analysisTask.customKnowledge,
        analysisTask.resolvedTypeDefinitions,
        analysisTask.entityTableContext,
        analysisTask.frameworkSignalContext,
        analysisTask.functionId,
        analysisTask.classConstantsContext,
        analysisTask.clientBindingContext,
        analysisTask.graphQLDocumentContext,
        mergedInvocationContext,
        limiter,
        isIoConfirmedTask(analysisTask),
        analysisTask.sinkCategories as InfraCategory[] | undefined,
    );

    // Trace: LLM request sent (full code chunk for forensic analysis)
    traceSendEvent(analysisTask, result?.sectionChars);
    const latencyMs = Date.now() - startMs;

    return processAnalysisOutcome(analysisTask, result, latencyMs, task, symbolRegistry, envVarDict);
}

/** Emit the per-function SEND trace event (single and batch paths). */
function traceSendEvent(
    analysisTask: AnalysisTask,
    sectionChars: Record<string, number> | undefined,
    batchId?: string,
): void {
    traceCollector.traceLLM('SEND', analysisTask.functionId, 'prompt sent to LLM', {
        filePath: analysisTask.fileContext.relativePath,
        functionName: analysisTask.chunk.name,
        promptLength: analysisTask.chunk.sourceCode.length,
        codeChunk: analysisTask.chunk.sourceCode,
        imports: analysisTask.imports,
        constructorSource: analysisTask.constructorSource,
        classProperties: analysisTask.classProperties,
        taintContext: analysisTask.taintContextSummary,
        resolvedInvocationContext: analysisTask.resolvedInvocationContext || undefined,
        // Surface optional context blocks so trace dumps can answer
        // "did the LLM actually see this?" for hallucination forensics.
        classConstantsContext: analysisTask.classConstantsContext,
        frameworkSignalContext: analysisTask.frameworkSignalContext,
        // Per-section prompt anatomy: exact post-truncation char count
        // of every block shipped to the LLM. Undefined when the call failed
        // before returning (consumers must feature-detect).
        sectionChars,
        language: analysisTask.chunk.language,
        ...(batchId ? { batchId } : {}),
    });
}

/**
 * Everything downstream of the LLM response for ONE function: overlays,
 * deterministic preservation, sanitizer, Zodios injection, trace + telemetry,
 * outcome construction. Shared verbatim by the single-call path
 * (extractFunction) and the batch path (extractFunctionBatch) so the two can
 * never drift.
 */
function processAnalysisOutcome(
    analysisTask: AnalysisTask,
    result: { analysis: UnifiedAnalysis; usage: { totalTokens?: number;[key: string]: any } } | null,
    latencyMs: number,
    task?: ProgressReporter,
    symbolRegistry?: SymbolRegistry,
    envVarDict?: Map<string, EnvVarBinding>,
    batchId?: string,
): ExtractionOutcome {
    if (!result) {
        // LLM returned null (empty/invalid structured output, even after retry).
        // This is a PIPELINE FAILURE, not a semantic rejection.
        // Returning { kind: 'failed' } causes the caller to increment failedCount,
        // which the orchestrator uses to set repoHasErrors=true and prevent the
        // Merkle hash from being committed — forcing a re-analysis on the next run.
        telemetryCollector.incrementLLMFailures();
        traceCollector.traceLLM('FAIL', analysisTask.functionId, 'empty structured output', {
            filePath: analysisTask.fileContext.relativePath,
            functionName: analysisTask.chunk.name,
            latencyMs,
        });
        return { kind: 'failed' };
    }
    const frameworkOverlay = buildFrameworkSignalOverlay(
        analysisTask.chunk.name,
        analysisTask.matchedFrameworkSignals ?? [],
    );
    const mergedAnalysis = preserveUseCaseEntrypoint(
        analysisTask,
        mergeUnifiedAnalysisWithOverlay(result.analysis, frameworkOverlay),
    );
    const preservedAnalysis = preserveDeterministicDeclarations(analysisTask, mergedAnalysis);
    let preservedAnalysisWithZodiosFlag = preservedAnalysis;
    if (analysisTask.zodiosResolvedCalls?.length) {
        preservedAnalysisWithZodiosFlag = { ...preservedAnalysis, has_io: true };
    }

    if (!preservedAnalysisWithZodiosFlag.has_io) {
        // LLM understood the function and correctly classified it as non-I/O.
        // This is an intentional SEMANTIC REJECTION — not a pipeline error.
        // Returning { kind: 'rejected' } ensures it does NOT increment failedCount.
        telemetryCollector.incrementLLMRejections();
        traceCollector.traceLLM('REJECT', analysisTask.functionId, 'has_io=false', {
            filePath: analysisTask.fileContext.relativePath,
            functionName: analysisTask.chunk.name,
            has_io: false,
            latencyMs,
            tokens: {
                in: result.usage?.promptTokens || result.usage?.inputTokens || 0,
                out: result.usage?.completionTokens || result.usage?.outputTokens || 0,
                cached: result.usage?.cachedInputTokens || result.usage?.cachedTokens || 0,
            },
            ...(batchId ? { batchId } : {}),
        });
        return { kind: 'rejected' };
    }

    if (!result.analysis.has_io && mergedAnalysis.has_io && isUseCaseEntryPointTask(analysisTask)) {
        traceCollector.traceLLM('TRANSFORM', analysisTask.functionId, 'UseCase entry point preserved after has_io=false', {
            filePath: analysisTask.fileContext.relativePath,
            functionName: analysisTask.chunk.name,
            filterGate: analysisTask.filterGate,
            filterReason: analysisTask.filterReason,
        });
    }
    if (!result.analysis.has_io && preservedAnalysis.has_io && analysisTask.resourceDeclarations?.length) {
        traceCollector.traceLLM('TRANSFORM', analysisTask.functionId, 'deterministic resource declarations preserved after has_io=false', {
            filePath: analysisTask.fileContext.relativePath,
            functionName: analysisTask.chunk.name,
            declarations: analysisTask.resourceDeclarations.map(d => `${d.technology}:${d.logicalId}`),
        });
    }
    if (!result.analysis.has_io && preservedAnalysisWithZodiosFlag.has_io && analysisTask.zodiosResolvedCalls?.length) {
        traceCollector.traceLLM('TRANSFORM', analysisTask.functionId, 'has_io forced true by Zodios resolved calls (pre-gate)', {
            filePath: analysisTask.fileContext.relativePath,
            functionName: analysisTask.chunk.name,
            zodiosCallCount: analysisTask.zodiosResolvedCalls.length,
        });
    }

    telemetryCollector.incrementLLMInvocations();
    const { usage } = result;
    const resolvedContext = extractResolvedEntityContext(analysisTask.entityTableContext);
    // Merge ORM-resolved table names with config-declared tables (from databases[].tables)
    const mergedTableNames = new Set([
        ...(resolvedContext?.tableNames ?? []),
        ...(analysisTask.configuredTableNames ?? []),
    ]);

    const plugin = getLanguagePlugin(analysisTask.chunk.language) ?? undefined;

    let analysis = sanitizeAnalysis(preservedAnalysisWithZodiosFlag, {
        sourceCode: analysisTask.chunk.sourceCode,
        symbolRegistry,
        consumerFilePath: analysisTask.chunk.filepath,
        functionName: analysisTask.chunk.name,
        entityClassNames: resolvedContext?.entityNames,
        allowedTableNames: mergedTableNames.size > 0 ? mergedTableNames : undefined,
        allowedApiPaths: frameworkOverlay?.allowedInboundPaths,
        plugin,
        functionId: analysisTask.functionId,
        resolvedConstants: analysisTask.resolvedConstants,
        envVarDict,
        knownServiceInterfaces: analysisTask.knownServiceInterfaces,
        astResolvedPayloads: analysisTask.astResolvedPayloads?.map(p => ({
            direction: p.direction,
            basename: p.basename,
            fields: p.fields,
        })),
    });

    // ── Post-LLM: Deterministic Zodios API Call Injection ───────────────────────
    //
    // The zodios-context-builder has already resolved, via AST, exactly which
    // Zodios aliases are called in this chunk and what HTTP endpoints they map to.
    // We inject them directly into emergent_api_calls here — 100% deterministic,
    // zero LLM tokens, zero IP leaking into cached system prompts.
    if (analysisTask.zodiosResolvedCalls?.length) {
        const existingPaths = new Set(
            (analysis.emergent_api_calls ?? []).map(c => `${c.method}:${c.path}`),
        );
        const newCalls = analysisTask.zodiosResolvedCalls
            .filter(c => !existingPaths.has(`${c.method}:${c.path}`))
            .map(c => ({
                method: c.method as import('@coderadius/shared-types').HttpMethod,
                path: c.path,
                direction: 'OUTBOUND' as const,
                api_kind: 'rest' as const,
                document_operation_name: null,
            }));

        if (newCalls.length > 0) {
            analysis = {
                ...analysis,
                has_io: true,
                emergent_api_calls: [...(analysis.emergent_api_calls ?? []), ...newCalls],
            };
            traceCollector.traceLLM('TRANSFORM', analysisTask.functionId,
                'deterministic Zodios API calls merged (post-LLM)', {
                    filePath: analysisTask.fileContext.relativePath,
                    functionName: analysisTask.chunk.name,
                    calls: newCalls.map(c => `${c.method} ${c.path}`),
                    sourceTypes: analysisTask.zodiosResolvedCalls.map(c => c.sourceType),
                },
            );
        }
    }

    const intentText = analysis.intent || '';

    // Trace: LLM response received with I/O confirmed
    traceCollector.traceLLM('RECEIVE', analysisTask.functionId, intentText || 'has_io=true', {
        filePath: analysisTask.fileContext.relativePath,
        functionName: analysisTask.chunk.name,
        has_io: true,
        intent: intentText,
        infrastructure: analysis.infrastructure?.map(i => ({ name: i.name, type: i.type, operation: i.operation })),
        capabilities: analysis.capabilities,
        latencyMs,
        tokens: {
            in: usage?.promptTokens || usage?.inputTokens || 0,
            out: usage?.completionTokens || usage?.outputTokens || 0,
            cached: usage?.cachedInputTokens || usage?.cachedTokens || 0,
        },
        ...(batchId ? { batchId } : {}),
    });

    if (task && logger.isDebugEnabled()) {
        const capsStr = analysis.capabilities?.length ? ` +${analysis.capabilities.length}caps` : '';
        const tokensStr = usage?.totalTokens ? ` | ${usage.totalTokens}tk (${usage.cachedInputTokens || usage.cachedTokens || 0}c)` : '';
        task.report(`[${latencyMs}ms${tokensStr}${capsStr}] ${analysisTask.chunk.name} — ${intentText.substring(0, 40)}...`);
    }

    return {
        kind: 'success',
        data: {
            functionId: analysisTask.functionId,
            functionHash: analysisTask.functionHash,
            chunk: analysisTask.chunk,
            fileContext: analysisTask.fileContext,
            analysis,
            resourceDeclarations: analysisTask.resourceDeclarations,
            clientBindings: analysisTask.clientBindings,
            resolvedConstants: analysisTask.resolvedConstants,
            astResolvedPayloads: analysisTask.astResolvedPayloads,
            usage,
            latencyMs,
        },
    };
}

// ─── Schema Extraction ───────────────────────────────────────────────────────

/**
 * Extract data schemas from a file whose AST passed the schema gate.
 */
async function extractSchemas(
    schemaContext: SchemaContext,
    task?: ProgressReporter,
    limiter?: AIMDSemaphore | null,
): Promise<ExtractedSchemaData> {
    if (task) task.report(`Extracting schemas: ${schemaContext.relativePath}`);

    const schemas = await extractDataSchema(
        schemaContext.fileContent,
        schemaContext.relativePath,
        schemaContext.frameworkSignalContext,
        limiter,
    );

    return {
        relativePath: schemaContext.relativePath,
        qualifiedRepoName: schemaContext.qualifiedRepoName,
        schemas,
    };
}

/**
 * Single-call extraction with per-member error isolation, used by the batch
 * fallback paths. A 429-exhausted member becomes a 'deferred' outcome (it
 * re-enters the drain alone); any other failure becomes 'failed'. Auth
 * errors still propagate to fail fast.
 */
async function extractSingleIsolated(
    member: AnalysisTask,
    task?: ProgressReporter,
    scanMode: ScanMode = 'semantic',
    symbolRegistry?: SymbolRegistry,
    envVarDict?: Map<string, EnvVarBinding>,
    limiter?: AIMDSemaphore | null,
): Promise<ExtractionOutcome> {
    try {
        return await extractFunction(member, task, scanMode, symbolRegistry, envVarDict, limiter);
    } catch (err) {
        const msg = (err as Error).message.toLowerCase();
        if (msg.includes('credentials') || msg.includes('api key') || msg.includes('authentication') || msg.includes('unauthorized')) {
            throw err;
        }
        // 429-exhaustion and connection outages are both transient: the
        // deferred drain retries them once at end of run, when the quota
        // window has reset or connectivity is back.
        if (
            err instanceof MaxRetriesExceededError ||
            (err as { code?: string } | null)?.code === 'MAX_RETRIES_EXCEEDED' ||
            isConnectionError(err)
        ) {
            return { kind: 'deferred' };
        }
        const errStr = `[SemanticExtractor] Failed for ${member.chunk.name}: ${(err as Error).message}`;
        logger.error(errStr);
        telemetryCollector.incrementErrors(errStr);
        return { kind: 'failed' };
    }
}

// ─── Batched extraction ──────────────────────────────────────────────────────

/**
 * Run ONE LLM call for a (file, class) batch and demux per-function outcomes.
 *
 * Failure semantics:
 *   - MaxRetriesExceededError propagates (caller routes ALL members to the
 *     deferred-retry drain).
 *   - Empty/invalid batch response → every member falls back to the existing
 *     single-call path (today's exact quality for anything the batch
 *     mishandles).
 *   - A member whose function_key is missing from the response falls back to
 *     a single call, bounded by MAX_BATCH.
 *
 * Telemetry: `analyzeFunctionBatch` records phase tokens ONCE with the real
 * usage; per-function RECEIVE/REJECT events carry usage/batchSize so the
 * funnel columns still sum to the batch totals.
 */
async function extractFunctionBatch(
    batch: AnalysisTask[],
    kind: 'shared' | 'mixed',
    task?: ProgressReporter,
    scanMode: ScanMode = 'semantic',
    symbolRegistry?: SymbolRegistry,
    envVarDict?: Map<string, EnvVarBinding>,
    limiter?: AIMDSemaphore | null,
): Promise<ExtractionOutcome[]> {
    const startMs = Date.now();
    const batchId = `${kind}:${batch[0].functionId}+${batch.length - 1}`;

    traceCollector.traceLLM('BATCH_SEND', batchId, `batched prompt for ${batch.length} functions`, {
        filePath: batch[0].fileContext.relativePath,
        memberCount: batch.length,
        functionIds: batch.map(t => t.functionId),
        language: batch[0].chunk.language,
        kind,
    });

    // A batch is io-confirmed only when EVERY member passed a strong I/O gate
    // (an io-mixed batch keeps the full FILTER prompt — the slim prompt would
    // wrongly force has_io on a gate-1 member). When io-confirmed, the sink
    // categories scope the system prompt exactly as on the single-call path;
    // batch[0] is representative because the grouping key is variant-pure
    // (mixedBatchKeyOf) or same-file (shared → same per-file categories).
    const batchIoConfirmed = batch.every(isIoConfirmedTask);
    const batchCategories = batchIoConfirmed ? taskScopeCategories(batch[0]) : undefined;
    const result = kind === 'shared'
        ? await analyzeFunctionBatch(batchSharedContextOf(batch[0]), batch.map(batchFunctionContextOf), limiter, batchIoConfirmed, batchCategories)
        : await analyzeMixedFunctionBatch(mixedBatchCommonContextOf(batch[0]), batch.map(mixedBatchMemberContextOf), limiter, batchIoConfirmed, batchCategories);
    const latencyMs = Date.now() - startMs;

    if (!result) {
        // Whole-batch miss: preserve today's quality via N single calls,
        // each with per-member error isolation.
        return Promise.all(
            batch.map(member => extractSingleIsolated(member, task, scanMode, symbolRegistry, envVarDict, limiter)),
        );
    }

    traceCollector.traceLLM('BATCH_RECEIVE', batchId, `batched response for ${batch.length} functions`, {
        filePath: batch[0].fileContext.relativePath,
        memberCount: batch.length,
        latencyMs,
        sharedChars: result.sharedChars,
        functionChars: result.functionChars,
        tokens: {
            in: result.usage?.promptTokens || result.usage?.inputTokens || 0,
            out: result.usage?.completionTokens || result.usage?.outputTokens || 0,
            cached: result.usage?.cachedInputTokens || result.usage?.cachedTokens || 0,
        },
    });

    const analyses = demuxBatchResponse(batch, result.byKey);

    // Per-function token attribution: divide the batch totals so the
    // per-function funnel columns sum back to the real usage. The exact
    // figures live on the BATCH_RECEIVE event above.
    const divide = (v: number) => Math.round(v / batch.length);
    const dividedUsage = {
        promptTokens: divide(result.usage?.promptTokens || result.usage?.inputTokens || 0),
        completionTokens: divide(result.usage?.completionTokens || result.usage?.outputTokens || 0),
        cachedInputTokens: divide(result.usage?.cachedInputTokens || result.usage?.cachedTokens || 0),
        totalTokens: divide(result.usage?.totalTokens || 0),
    };

    return Promise.all(batch.map(async (member, i) => {
        const analysis = analyses[i];
        if (!analysis) {
            // Model dropped or renamed this function_key — single-call fallback.
            traceCollector.traceLLM('FALLBACK', member.functionId, 'function_key missing from batch response — single-call fallback', {
                filePath: member.fileContext.relativePath,
                functionName: member.chunk.name,
                batchId,
            });
            return extractSingleIsolated(member, task, scanMode, symbolRegistry, envVarDict, limiter);
        }
        traceSendEvent(member, undefined, batchId);
        return processAnalysisOutcome(member, { analysis, usage: dividedUsage }, latencyMs, task, symbolRegistry, envVarDict, batchId);
    }));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run semantic extraction on a batch of AnalysisTasks and SchemaContexts.
 *
 * This is the sole LLM interaction point in the pipeline.
 * All tasks are processed and returned as a typed SemanticExtractionResult.
 *
 * Concurrency control: the caller passes the orchestrator-owned AIMDSemaphore
 * via `limiter`. The slot is acquired per-LLM-attempt inside
 * `withCongestionControl` (at the agent boundary), so retry sleeps never hold
 * a slot (G1) and 429s feed back into the AIMD controller (G2). When `limiter`
 * is omitted, callers fall back to the process singleton.
 */
export async function extractSemantics(
    analysisTasks: AnalysisTask[],
    schemaContexts: SchemaContext[],
    task?: ProgressReporter,
    scanMode: ScanMode = 'semantic',
    limiter?: AIMDSemaphore | null,
    symbolRegistry?: SymbolRegistry,
    envVarDict?: Map<string, EnvVarBinding>,
    /**
     * Optional shutdown signal. Aborts pending tasks early on Ctrl+C so the
     * outer orchestrator does not hang on `Promise.all(extractPromises)`.
     */
    signal?: AbortSignal,
    /**
     * Optional per-repo singleton pool: leftover singletons are
     * submitted here so concurrent per-file calls share mixed batches and
     * amortize the fixed prompt prefix across files.
     */
    batchPool?: SemanticBatchPool | null,
): Promise<SemanticExtractionResult> {
    const isDeepScan = scanMode === 'contracts';
    const extractedFunctions: ExtractedFunctionData[] = [];
    const deferredTasks: AnalysisTask[] = [];
    let rejectedCount = 0;
    let failedCount = 0;

    // Shared per-outcome accounting for the single and batch paths.
    const recordOutcome = (analysisTask: AnalysisTask, outcome: ExtractionOutcome): void => {
        let tokensUsed = { in: 0, out: 0, cached: 0 };
        if (outcome.kind === 'deferred') {
            // Per-member 429 exhaustion inside a batch fallback: only this
            // member re-enters the drain; its siblings keep their outcomes.
            deferredTasks.push(analysisTask);
            return;
        }
        if (outcome.kind === 'success') {
            extractedFunctions.push(outcome.data);
            tokensUsed = {
                in: outcome.data.usage?.promptTokens || outcome.data.usage?.inputTokens || 0,
                out: outcome.data.usage?.completionTokens || outcome.data.usage?.outputTokens || 0,
                cached: outcome.data.usage?.cachedInputTokens || outcome.data.usage?.cachedTokens || 0,
            };
            if (task) task.report(`${analysisTask.chunk.name}...`);
        } else if (outcome.kind === 'rejected') {
            // LLM correctly classified this function as non-I/O — expected path.
            rejectedCount++;
            telemetryCollector.incrementFunctionsSkipped();
        } else {
            // outcome.kind === 'failed': LLM returned empty/invalid output.
            // Must increment failedCount so the orchestrator sets repoHasErrors=true
            // and prevents the Merkle hash from being committed — forcing a
            // re-analysis of this file on the next sync run.
            failedCount++;
        }
        if (task?.increment) {
            task.increment(1, tokensUsed);
        }
    };

    /** Classify an extraction error; returns true when handled (non-fatal). */
    const handleExtractionError = (err: unknown, members: AnalysisTask[]): void => {
        const msg = (err as Error).message.toLowerCase();
        // Re-throw critical auth/init errors to fail fast
        if (msg.includes('credentials') || msg.includes('api key') || msg.includes('authentication') || msg.includes('unauthorized')) {
            throw err;
        }
        // 429-exhaustion and connection outages: route to deferred queue for
        // a single drain pass after the main batch completes (quota window
        // reset / connectivity restored → far better odds than retrying now).
        // Detected by instanceof OR code field for cross-module identity safety.
        if (
            err instanceof MaxRetriesExceededError ||
            (err as { code?: string } | null)?.code === 'MAX_RETRIES_EXCEEDED' ||
            isConnectionError(err)
        ) {
            deferredTasks.push(...members);
            return;
        }
        const names = members.map(m => m.chunk.name).join(', ');
        const errStr = `[SemanticExtractor] Failed for ${names}: ${(err as Error).message}`;
        logger.error(errStr);
        telemetryCollector.incrementErrors(errStr);
        failedCount += members.length; // JS-level exception — also a pipeline failure
        if (task?.increment) task.increment(members.length, { in: 0, out: 0 });
    };

    const assertNotAborted = () => {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new Error('extraction aborted');
        }
    };

    // ── Function extraction ──────────────────────────────────────────────
    // Fast scans batch (file, class) groups into single LLM calls, and
    // leftover singletons are merged into cross-file MIXED batches
    // to amortize the ~4K-token fixed prefix every call pays.
    // Deep scans stay 1:1 (rare, payload-heavy, worst output-growth profile).
    const { batches, singles } = isDeepScan
        ? { batches: [] as AnalysisTask[][], singles: analysisTasks }
        : groupTasksForBatching(analysisTasks);
    const { mixedBatches, remaining } = isDeepScan
        ? { mixedBatches: [] as AnalysisTask[][], remaining: singles }
        : groupSinglesIntoMixedBatches(singles);

    // Statics resolve instantly in-process; pooling them would only add latency.
    const usesPool = (analysisTask: AnalysisTask): boolean =>
        Boolean(batchPool) && !isDeepScan && !analysisTask.isResolvedStatically;

    const singlePromises = remaining.map(analysisTask => (async () => {
        assertNotAborted();
        try {
            const outcome = usesPool(analysisTask)
                ? await batchPool!.submit(analysisTask)
                : await extractFunction(analysisTask, task, scanMode, symbolRegistry, envVarDict, limiter);
            recordOutcome(analysisTask, outcome);
        } catch (err) {
            handleExtractionError(err, [analysisTask]);
        }
    })());

    const runBatch = (batch: AnalysisTask[], kind: 'shared' | 'mixed') => (async () => {
        assertNotAborted();
        try {
            const outcomes = await extractFunctionBatch(batch, kind, task, scanMode, symbolRegistry, envVarDict, limiter);
            outcomes.forEach((outcome, i) => recordOutcome(batch[i], outcome));
        } catch (err) {
            handleExtractionError(err, batch);
        }
    })();

    await Promise.all([
        ...singlePromises,
        ...batches.map(batch => runBatch(batch, 'shared')),
        ...mixedBatches.map(batch => runBatch(batch, 'mixed')),
    ]);

    // ── Schema extraction ────────────────────────────────────────────────
    const extractedSchemas: ExtractedSchemaData[] = [];
    let schemaFailed = false;

    if (isDeepScan) {
        for (const schemaContext of schemaContexts) {
            try {
                const result = await extractSchemas(schemaContext, task, limiter);
                if (result.schemas.length > 0) {
                    extractedSchemas.push(result);
                }
            } catch (err) {
                const msg = (err as Error).message.toLowerCase();
                if (msg.includes('credentials') || msg.includes('api key') || msg.includes('authentication') || msg.includes('unauthorized')) {
                    throw err;
                }
                const errStr = `[SemanticExtractor] Schema extraction failed for ${schemaContext.relativePath}: ${(err as Error).message}`;
                logger.error(errStr);
                telemetryCollector.incrementErrors(errStr);
                schemaFailed = true; // Mark as failed
            }
        }
    }

    return {
        extractedFunctions,
        rejectedCount,
        failedCount,
        extractedSchemas,
        schemaFailed,
        deferredTasks,
    };
}
