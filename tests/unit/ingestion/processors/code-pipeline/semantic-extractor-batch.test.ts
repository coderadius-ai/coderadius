/**
 * Unit Tests — extractSemantics batch wiring
 *
 * With analyzeFunctionBatch mocked:
 *   (a) one (file, class) group → ONE batch call, N outcomes
 *   (b) missing function_key → that member re-runs via the single path
 *   (c) batch null → every member re-runs via the single path
 *   (d) has_io=false member → rejected, not failed
 *   (e) sanitizer applied per function (generic infra stripped on the
 *       offending member only)
 *   (f) MaxRetriesExceededError on the batch → ALL members deferred
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisTask } from '../../../../../src/ingestion/processors/code-pipeline/types.js';

const { analyzeFunctionMock, analyzeFunctionBatchMock, analyzeMixedFunctionBatchMock } = vi.hoisted(() => ({
    analyzeFunctionMock: vi.fn(),
    analyzeFunctionBatchMock: vi.fn(),
    analyzeMixedFunctionBatchMock: vi.fn(),
}));

vi.mock('../../../../../src/ai/agents/unified-analyzer.js', async () => {
    const actual = await vi.importActual('../../../../../src/ai/agents/unified-analyzer.js');
    return {
        ...actual,
        analyzeFunction: analyzeFunctionMock,
        analyzeFunctionBatch: analyzeFunctionBatchMock,
        analyzeMixedFunctionBatch: analyzeMixedFunctionBatchMock,
    };
});

vi.mock('../../../../../src/telemetry/index.js', () => ({
    telemetryCollector: {
        incrementLLMInvocations: vi.fn(),
        incrementLLMRejections: vi.fn(),
        incrementFunctionsSkipped: vi.fn(),
        incrementErrors: vi.fn(),
        incrementLLMFailures: vi.fn(),
        incrementStaticBypass: vi.fn(),
    },
    traceCollector: {
        traceLLM: vi.fn(),
        traceSanitizer: vi.fn(),
    },
}));

vi.mock('../../../../../src/utils/logger.js', () => ({
    logger: {
        isDebugEnabled: () => false,
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
    },
}));

import { createSemanticBatchPool, extractSemantics } from '../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js';
import { MaxRetriesExceededError } from '../../../../../src/utils/congestion-control.js';

const SOURCE = `
class InventorySync {
    async reserve() { await this.pool.query('INSERT INTO inventory_reservations (sku) VALUES ($1)', [sku]); }
}`;

function makeTask(method: string): AnalysisTask {
    return {
        kind: 'analysis',
        functionId: `urn:function:acme:src/InventorySync.ts:InventorySync.${method}`,
        functionHash: `${method}-hash`,
        chunk: {
            name: `InventorySync.${method}`,
            filepath: 'src/InventorySync.ts',
            sourceCode: SOURCE,
            language: 'typescript',
            startLine: 1,
            startColumn: 1,
            endLine: 5,
            endColumn: 1,
        },
        fileContext: {
            absolutePath: '/tmp/src/InventorySync.ts',
            relativePath: 'src/InventorySync.ts',
            repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
            routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
        },
        imports: ['import { Pool } from "pg";'],
    } as unknown as AnalysisTask;
}

const fastAnalysis = (intent: string, infrastructure: any[] = []) => ({
    _reasoning: 'test',
    has_io: true,
    intent,
    infrastructure,
    capabilities: [],
    emergent_api_calls: [],
});

const usage = { promptTokens: 8_000, completionTokens: 800, cachedInputTokens: 4_000, totalTokens: 8_800 };

function batchResult(byKey: Map<string, any>) {
    return { byKey, usage, sharedChars: 1_000, functionChars: {} };
}

beforeEach(() => {
    analyzeFunctionMock.mockReset();
    analyzeFunctionBatchMock.mockReset();
    analyzeMixedFunctionBatchMock.mockReset();
});

function makeSingletonTask(name: string, filepath: string): AnalysisTask {
    const t = makeTask(name);
    return {
        ...t,
        functionId: `urn:function:acme:${filepath}:${name}`,
        chunk: { ...t.chunk, name, filepath },
        fileContext: { ...t.fileContext, relativePath: filepath },
    } as AnalysisTask;
}

describe('extractSemantics — batch wiring', () => {
    it('(a) sends one class group as ONE batch call with per-function outcomes', async () => {
        const tasks = ['reserve', 'publish', 'fetch', 'format'].map(makeTask);
        analyzeFunctionBatchMock.mockResolvedValue(batchResult(new Map(
            tasks.map((t, i) => [String(i + 1), fastAnalysis(`intent of ${t.chunk.name}`)]),
        )));

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(analyzeFunctionBatchMock).toHaveBeenCalledTimes(1);
        expect(analyzeFunctionMock).not.toHaveBeenCalled();
        expect(result.extractedFunctions).toHaveLength(4);
        expect(result.failedCount).toBe(0);
        // divided token attribution sums back to the batch total
        const inSum = result.extractedFunctions.reduce((a, f) => a + (f.usage?.promptTokens ?? 0), 0);
        expect(inSum).toBe(usage.promptTokens);
    });

    it('(b) re-runs a member via the single path when its key is missing', async () => {
        const tasks = ['reserve', 'publish', 'fetch'].map(makeTask);
        const byKey = new Map(
            tasks.slice(0, 2).map((t, i) => [String(i + 1), fastAnalysis(`intent of ${t.chunk.name}`)]),
        );
        analyzeFunctionBatchMock.mockResolvedValue(batchResult(byKey));
        analyzeFunctionMock.mockResolvedValue({ analysis: fastAnalysis('single fallback'), usage });

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(analyzeFunctionBatchMock).toHaveBeenCalledTimes(1);
        expect(analyzeFunctionMock).toHaveBeenCalledTimes(1);
        expect(result.extractedFunctions).toHaveLength(3);
    });

    it('(c) falls back to N single calls when the batch returns null', async () => {
        const tasks = ['reserve', 'publish', 'fetch', 'format'].map(makeTask);
        analyzeFunctionBatchMock.mockResolvedValue(null);
        analyzeFunctionMock.mockResolvedValue({ analysis: fastAnalysis('single fallback'), usage });

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(analyzeFunctionMock).toHaveBeenCalledTimes(4);
        expect(result.extractedFunctions).toHaveLength(4);
        expect(result.failedCount).toBe(0);
    });

    it('(d) counts a has_io=false member as rejected, not failed', async () => {
        const tasks = ['reserve', 'format'].map(makeTask);
        analyzeFunctionBatchMock.mockResolvedValue(batchResult(new Map([
            ['1', fastAnalysis('writes reservations')],
            ['2', { ...fastAnalysis(''), has_io: false }],
        ])));

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(result.extractedFunctions).toHaveLength(1);
        expect(result.rejectedCount).toBe(1);
        expect(result.failedCount).toBe(0);
    });

    it('(e) applies the sanitizer per function — generic infra stripped on the offender only', async () => {
        const tasks = ['reserve', 'publish'].map(makeTask);
        analyzeFunctionBatchMock.mockResolvedValue(batchResult(new Map([
            // legit: SQL-evidenced table in the shared source
            ['1', fastAnalysis('writes reservations', [
                { name: 'inventory_reservations', type: 'Database', operation: 'WRITES', evidence: "INSERT INTO inventory_reservations (sku) VALUES ($1)" },
            ])],
            // hallucination: bare technology name (GENERIC_INFRA_NAMES drop)
            ['2', fastAnalysis('publishes', [
                { name: 'mongodb', type: 'Database', operation: 'WRITES' },
            ])],
        ])));

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        const reserve = result.extractedFunctions.find(f => f.chunk.name.endsWith('reserve'));
        const publish = result.extractedFunctions.find(f => f.chunk.name.endsWith('publish'));
        expect(reserve?.analysis.infrastructure?.map(i => i.name)).toContain('inventory_reservations');
        expect(publish?.analysis.infrastructure ?? []).toHaveLength(0);
    });

    it('(f) routes ALL batch members to deferredTasks on MaxRetriesExceededError', async () => {
        const tasks = ['reserve', 'publish', 'fetch', 'format'].map(makeTask);
        analyzeFunctionBatchMock.mockRejectedValue(new MaxRetriesExceededError(10));

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(result.deferredTasks).toHaveLength(4);
        expect(result.failedCount).toBe(0);
        expect(analyzeFunctionMock).not.toHaveBeenCalled();
    });
});

describe('extractSemantics — mixed singleton batching', () => {
    it('(g) merges cross-file singletons into ONE mixed batch call', async () => {
        const tasks = [
            makeSingletonTask('OrderArchiver.archive', 'src/a.ts'),
            makeSingletonTask('StockMailer.notify', 'src/b.ts'),
            makeSingletonTask('lookupWarehouse', 'src/c.ts'),
        ];
        analyzeMixedFunctionBatchMock.mockResolvedValue(batchResult(new Map(
            tasks.map((t, i) => [String(i + 1), fastAnalysis(`intent of ${t.chunk.name}`)]),
        )));

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(analyzeMixedFunctionBatchMock).toHaveBeenCalledTimes(1);
        expect(analyzeFunctionBatchMock).not.toHaveBeenCalled();
        expect(analyzeFunctionMock).not.toHaveBeenCalled();
        expect(result.extractedFunctions).toHaveLength(3);
    });

    it('(h) re-runs a mixed member via the single path when its ordinal is missing', async () => {
        const tasks = [
            makeSingletonTask('OrderArchiver.archive', 'src/a.ts'),
            makeSingletonTask('StockMailer.notify', 'src/b.ts'),
        ];
        analyzeMixedFunctionBatchMock.mockResolvedValue(batchResult(new Map([
            ['1', fastAnalysis('archives orders')],
        ])));
        analyzeFunctionMock.mockResolvedValue({ analysis: fastAnalysis('single fallback'), usage });

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(analyzeFunctionMock).toHaveBeenCalledTimes(1);
        expect(result.extractedFunctions).toHaveLength(2);
    });

    it('(i) keeps a statically-resolved singleton out of the mixed batch', async () => {
        const staticTask = {
            ...makeSingletonTask('OrmMeta.table', 'src/d.ts'),
            isResolvedStatically: true,
            staticAnalysis: { has_io: true, intent: 'static', infrastructure: [], capabilities: [] },
        } as unknown as AnalysisTask;
        const tasks = [
            makeSingletonTask('OrderArchiver.archive', 'src/a.ts'),
            makeSingletonTask('StockMailer.notify', 'src/b.ts'),
            staticTask,
        ];
        analyzeMixedFunctionBatchMock.mockResolvedValue(batchResult(new Map([
            ['1', fastAnalysis('archives orders')],
            ['2', fastAnalysis('notifies stock')],
        ])));

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(analyzeMixedFunctionBatchMock).toHaveBeenCalledTimes(1);
        expect(analyzeFunctionMock).not.toHaveBeenCalled(); // static path, no LLM
        expect(result.extractedFunctions).toHaveLength(3);  // 2 batched + 1 static
    });

    it('(j) routes mixed-batch members to deferredTasks on 429 exhaustion', async () => {
        const tasks = [
            makeSingletonTask('OrderArchiver.archive', 'src/a.ts'),
            makeSingletonTask('StockMailer.notify', 'src/b.ts'),
        ];
        analyzeMixedFunctionBatchMock.mockRejectedValue(new MaxRetriesExceededError(10));

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(result.deferredTasks).toHaveLength(2);
        expect(result.failedCount).toBe(0);
    });
});

describe('extractSemantics — cross-call singleton pool', () => {
    it('(k) batches singletons from DIFFERENT extractSemantics calls through one pool', async () => {
        // The orchestrator calls extractSemantics once per file (write-through),
        // so cross-file singletons only meet through the shared per-repo pool.
        analyzeMixedFunctionBatchMock.mockResolvedValue(batchResult(new Map([
            ['1', fastAnalysis('archives orders')],
            ['2', fastAnalysis('notifies stock')],
        ])));
        const pool = createSemanticBatchPool('semantic', undefined, undefined, null, 10);

        const [r1, r2] = await Promise.all([
            extractSemantics([makeSingletonTask('OrderArchiver.archive', 'src/a.ts')], [], undefined, 'semantic', null, undefined, undefined, undefined, pool),
            extractSemantics([makeSingletonTask('StockMailer.notify', 'src/b.ts')], [], undefined, 'semantic', null, undefined, undefined, undefined, pool),
        ]);

        expect(analyzeMixedFunctionBatchMock).toHaveBeenCalledTimes(1);
        expect(analyzeFunctionMock).not.toHaveBeenCalled();
        expect(r1.extractedFunctions).toHaveLength(1);
        expect(r2.extractedFunctions).toHaveLength(1);
    });

    it('(l) a pooled batch rejection defers each member inside its OWN call', async () => {
        analyzeMixedFunctionBatchMock.mockRejectedValue(new MaxRetriesExceededError(10));
        const pool = createSemanticBatchPool('semantic', undefined, undefined, null, 10);

        const [r1, r2] = await Promise.all([
            extractSemantics([makeSingletonTask('OrderArchiver.archive', 'src/a.ts')], [], undefined, 'semantic', null, undefined, undefined, undefined, pool),
            extractSemantics([makeSingletonTask('StockMailer.notify', 'src/b.ts')], [], undefined, 'semantic', null, undefined, undefined, undefined, pool),
        ]);

        expect(r1.deferredTasks).toHaveLength(1);
        expect(r2.deferredTasks).toHaveLength(1);
        expect(r1.failedCount + r2.failedCount).toBe(0);
    });

    it('(m) statically-resolved tasks bypass the pool entirely', async () => {
        const staticTask = {
            ...makeSingletonTask('OrmMeta.table', 'src/d.ts'),
            isResolvedStatically: true,
            staticAnalysis: { has_io: true, intent: 'static', infrastructure: [], capabilities: [] },
        } as unknown as AnalysisTask;
        const pool = createSemanticBatchPool('semantic', undefined, undefined, null, 10);

        const result = await extractSemantics([staticTask], [], undefined, 'semantic', null, undefined, undefined, undefined, pool);

        expect(result.extractedFunctions).toHaveLength(1);
        expect(analyzeMixedFunctionBatchMock).not.toHaveBeenCalled();
        expect(analyzeFunctionMock).not.toHaveBeenCalled();
    });
});
