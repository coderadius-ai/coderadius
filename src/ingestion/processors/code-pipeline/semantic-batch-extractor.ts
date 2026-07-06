/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Semantic Batch Extractor — (file, class)-level LLM batching
 *
 * Groups surviving AnalysisTasks that share file/class-scoped prompt context
 * so the shared blocks (customKnowledge, imports, constructor, properties,
 * framework signals, entity tables, constants, client bindings) are shipped
 * ONCE per group instead of once per function. On the acme-platform baseline those
 * blocks are ~84% of user-prompt chars at ~3.5 calls/file.
 *
 * Pure grouping/demux logic only — the LLM round-trip lives in
 * `unified-analyzer.ts:analyzeFunctionBatch` and the per-function
 * post-processing stays in `semantic-extractor.ts` (single source of truth
 * for sanitizer/overlay handling on both paths).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { AnalysisTask } from './types.js';
import type {
    BatchFunctionContext,
    BatchSharedContext,
    MixedBatchCommonContext,
    MixedBatchMemberContext,
    UnifiedAnalysis,
} from '../../../ai/agents/unified-analyzer.js';
import { categorySignature, detectInfraCategories, type InfraCategory } from '../../../ai/agents/unified-analyzer.js';
import { deriveClassName } from './static-analyzer-context.js';

/**
 * Batch size cap. Bounds output-token growth (~N× single-call output),
 * the retry blast radius (a failed batch re-drains N functions), and
 * cross-contamination risk between per-function sections.
 */
export const MAX_BATCH = 6;

// ─── System-prompt variant (the analyzer's cacheable prefix) ─────────────────
//
// Stage 2 strong I/O gates: has_io already known true → the analyzer serves the
// slim, filter-free prompt. Only gate 1 (use-case orchestrator) is LLM-judged.
// Single source of truth (re-exported to semantic-extractor) so the prompt
// variant key, the per-task scoping, and the agent selection agree by
// construction.
const STRONG_IO_GATES: ReadonlySet<number> = new Set([2, 3, 4, 5, 6, 7]);

export const isIoConfirmedTask = (t: AnalysisTask): boolean => STRONG_IO_GATES.has(t.filterGate ?? 1);

/**
 * The sink-category Set that scopes a task's system prompt — mirrors
 * `analyzeFunction`'s `scopeCats`: categories apply ONLY on the io-confirmed
 * path (the full-filter prompt is unscoped). Returns undefined when no scoping
 * applies, matching the agent cacheKey's "no category suffix" case.
 */
export function taskScopeCategories(task: AnalysisTask): Set<InfraCategory> | undefined {
    if (!isIoConfirmedTask(task)) return undefined;
    const cats = task.sinkCategories?.length
        ? new Set(task.sinkCategories as InfraCategory[])
        : detectInfraCategories(task.taintContextSummary);
    return cats ?? undefined;
}

/**
 * Canonical system-prompt variant of a task: the equivalence class of the agent
 * the analyzer would pick — language × io-confirmed × sink-category signature.
 * Two tasks share a system prompt (and so can amortize it inside one batched
 * call, paying the ~3.4K-token prefix once) IFF their promptVariantKey matches.
 */
export function promptVariantKey(task: AnalysisTask): string {
    const io = isIoConfirmedTask(task);
    const cats = taskScopeCategories(task);
    return `${task.chunk.language}:${io ? 'io' : 'full'}:${categorySignature(cats ?? null)}`;
}

/** The shared-context fingerprint that every member of a batch must match
 *  byte-for-byte — share-once is only correct when the blocks are identical. */
function sharedFingerprint(task: AnalysisTask): string {
    return JSON.stringify({
        customKnowledge: task.customKnowledge ?? '',
        frameworkSignal: task.frameworkSignalContext ?? '',
        entityTable: task.entityTableContext ?? '',
        classConstants: task.classConstantsContext ?? '',
        clientBinding: task.clientBindingContext ?? '',
        imports: task.imports ?? [],
        constructorSource: task.constructorSource ?? '',
        classProperties: task.classProperties ?? [],
    });
}

/**
 * Partition tasks into LLM batches and singles.
 *
 * - Grouping key: (fileContext.relativePath, deriveClassName(chunk.name) ?? '__file__').
 * - Statically-resolved tasks NEVER enter a batch: they short-circuit in
 *   extractFunction with zero LLM tokens.
 * - Groups whose members disagree on the shared fingerprint are sub-split;
 *   resulting singletons (and all size-1 groups) route to `singles` — there
 *   is no batching win for one function.
 * - Groups larger than `maxBatch` are sliced; a remainder of one becomes a single.
 */
export function groupTasksForBatching(
    tasks: AnalysisTask[],
    maxBatch: number = MAX_BATCH,
): { batches: AnalysisTask[][]; singles: AnalysisTask[] } {
    const singles: AnalysisTask[] = [];
    const groups = new Map<string, AnalysisTask[]>();

    for (const task of tasks) {
        if (task.isResolvedStatically) {
            singles.push(task);
            continue;
        }
        const className = deriveClassName(task.chunk.name) ?? '__file__';
        const key = `${task.fileContext.relativePath}\x00${className}`;
        const group = groups.get(key);
        if (group) group.push(task);
        else groups.set(key, [task]);
    }

    const batches: AnalysisTask[][] = [];
    for (const group of groups.values()) {
        const byFingerprint = new Map<string, AnalysisTask[]>();
        for (const task of group) {
            const fp = sharedFingerprint(task);
            const variant = byFingerprint.get(fp);
            if (variant) variant.push(task);
            else byFingerprint.set(fp, [task]);
        }
        for (const variant of byFingerprint.values()) {
            for (let i = 0; i < variant.length; i += maxBatch) {
                const slice = variant.slice(i, i + maxBatch);
                if (slice.length === 1) singles.push(slice[0]);
                else batches.push(slice);
            }
        }
    }

    return { batches, singles };
}

/**
 * Second-pass grouping: merge LLM-bound singletons into MIXED
 * cross-file batches so they amortize the ~4K-token fixed prefix (system
 * prompt + schema) that every call pays. Statically-resolved tasks and lone
 * leftovers stay in `remaining` (the true single-call lane).
 */
/** Grouping key for mixed (cross-file) batches. Members of a mixed batch share
 *  ONE LLM call, so they must agree on (a) the system prompt — captured by
 *  `promptVariantKey` (language × io × sink categories), the dominant prefix
 *  cost — and (b) `customKnowledge`, the only user block a mixed prompt shares.
 *  Keying on the variant is what lets the ~3.4K system prompt be paid once per
 *  batch instead of fragmenting the cache across calls. Repo segregation is
 *  structural (the pool/grouper lifecycle is per-repo). */
export function mixedBatchKeyOf(task: AnalysisTask): string {
    return `${promptVariantKey(task)}\x00${task.customKnowledge ?? ''}`;
}

export function groupSinglesIntoMixedBatches(
    singles: AnalysisTask[],
    maxBatch: number = MAX_BATCH,
): { mixedBatches: AnalysisTask[][]; remaining: AnalysisTask[] } {
    const remaining: AnalysisTask[] = [];
    const groups = new Map<string, AnalysisTask[]>();

    for (const task of singles) {
        if (task.isResolvedStatically) {
            remaining.push(task);
            continue;
        }
        const key = mixedBatchKeyOf(task);
        const group = groups.get(key);
        if (group) group.push(task);
        else groups.set(key, [task]);
    }

    const mixedBatches: AnalysisTask[][] = [];
    for (const group of groups.values()) {
        for (let i = 0; i < group.length; i += maxBatch) {
            const slice = group.slice(i, i + maxBatch);
            if (slice.length === 1) remaining.push(slice[0]);
            else mixedBatches.push(slice);
        }
    }

    return { mixedBatches, remaining };
}

/** Project the mixed-batch common context out of a member task. */
export function mixedBatchCommonContextOf(task: AnalysisTask): MixedBatchCommonContext {
    return {
        language: task.chunk.language,
        customKnowledge: task.customKnowledge,
    };
}

/** Project a mixed-batch member (own file/class context in the tail). */
export function mixedBatchMemberContextOf(task: AnalysisTask): MixedBatchMemberContext {
    return {
        ...batchFunctionContextOf(task),
        filepath: task.chunk.filepath,
        context: {
            imports: task.imports,
            constructorSource: task.constructorSource,
            classProperties: task.classProperties,
        },
        frameworkSignalContext: task.frameworkSignalContext,
        entityTableContext: task.entityTableContext,
        classConstantsContext: task.classConstantsContext,
        clientBindingContext: task.clientBindingContext,
    };
}

/** Project the batch-shared prompt context out of a member task. */
export function batchSharedContextOf(task: AnalysisTask): BatchSharedContext {
    return {
        filepath: task.chunk.filepath,
        language: task.chunk.language,
        context: {
            imports: task.imports,
            constructorSource: task.constructorSource,
            classProperties: task.classProperties,
        },
        customKnowledge: task.customKnowledge,
        frameworkSignalContext: task.frameworkSignalContext,
        entityTableContext: task.entityTableContext,
        classConstantsContext: task.classConstantsContext,
        clientBindingContext: task.clientBindingContext,
    };
}

/** Project the per-function prompt tail out of a member task. */
export function batchFunctionContextOf(task: AnalysisTask): BatchFunctionContext {
    return {
        chunk: task.chunk,
        taintContextSummary: task.taintContextSummary,
        resolvedTypeDefinitions: task.resolvedTypeDefinitions,
        graphQLDocumentContext: task.graphQLDocumentContext,
        resolvedInvocationContext: task.resolvedInvocationContext || undefined,
    };
}

/**
 * Map batched analyses back onto their tasks by ORDINAL function_key
 * ("1"-based, matching the prompt section headers). Names are never used as
 * keys: PHP FQNs with backslashes are unechoable through JSON escaping.
 * Missing ordinals yield null (the caller re-runs that member via the
 * single-call path); keys the model invented are ignored.
 */
export function demuxBatchResponse(
    tasks: AnalysisTask[],
    byKey: Map<string, UnifiedAnalysis>,
): Array<UnifiedAnalysis | null> {
    return tasks.map((_, i) => byKey.get(String(i + 1)) ?? null);
}
