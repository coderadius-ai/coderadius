/**
 * Unit Tests — batch grouping + demux
 *
 * groupTasksForBatching: (file, class|__file__) grouping, static-bypass
 * exclusion, shared-context invariant, MAX_BATCH cap, singleton routing.
 * demuxBatchResponse: function_key → analysis mapping with extra/missing keys.
 */

import { describe, it, expect } from 'vitest';
import {
    MAX_BATCH,
    groupTasksForBatching,
    groupSinglesIntoMixedBatches,
    demuxBatchResponse,
    promptVariantKey,
} from '../../../../../src/ingestion/processors/code-pipeline/semantic-batch-extractor.js';
import type { AnalysisTask } from '../../../../../src/ingestion/processors/code-pipeline/types.js';
import type { UnifiedAnalysis } from '../../../../../src/ai/agents/unified-analyzer.js';

function makeTask(opts: {
    name: string;
    filepath?: string;
    isResolvedStatically?: boolean;
    imports?: string[];
    customKnowledge?: string;
    filterGate?: AnalysisTask['filterGate'];
    sinkCategories?: string[];
}): AnalysisTask {
    const filepath = opts.filepath ?? 'src/Inventory/InventorySyncService.php';
    return {
        kind: 'analysis',
        functionId: `urn:function:acme:${filepath}:${opts.name}`,
        functionHash: `${opts.name}-hash`,
        chunk: {
            name: opts.name,
            filepath,
            sourceCode: `function body of ${opts.name}`,
            language: 'php',
            startLine: 1,
            startColumn: 0,
            endLine: 5,
            endColumn: 1,
        },
        fileContext: { relativePath: filepath } as AnalysisTask['fileContext'],
        imports: opts.imports ?? ['use Acme\\Inventory\\OrdersRepository;'],
        customKnowledge: opts.customKnowledge,
        filterGate: opts.filterGate,
        sinkCategories: opts.sinkCategories,
        ...(opts.isResolvedStatically
            ? { isResolvedStatically: true, staticAnalysis: { has_io: true, intent: 'static', infrastructure: [], capabilities: [] } }
            : {}),
    } as unknown as AnalysisTask;
}

const analysis = (intent: string): UnifiedAnalysis => ({
    has_io: true,
    intent,
    infrastructure: [],
    capabilities: [],
} as unknown as UnifiedAnalysis);

describe('groupTasksForBatching() — shared-class batching', () => {
    it('groups methods of the same class into one batch', () => {
        const tasks = [
            makeTask({ name: 'InventorySyncService.reserveStock' }),
            makeTask({ name: 'InventorySyncService.publishLowStock' }),
            makeTask({ name: 'InventorySyncService.fetchSupplierPrice' }),
        ];
        const { batches, singles } = groupTasksForBatching(tasks);
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(3);
        expect(singles).toHaveLength(0);
    });

    it('routes statically-resolved tasks to singles, never into a batch', () => {
        const tasks = [
            makeTask({ name: 'InventorySyncService.reserveStock' }),
            makeTask({ name: 'InventorySyncService.publishLowStock' }),
            makeTask({ name: 'InventorySyncService.ormMetadata', isResolvedStatically: true }),
        ];
        const { batches, singles } = groupTasksForBatching(tasks);
        expect(batches).toHaveLength(1);
        expect(batches[0].map(t => t.chunk.name)).toEqual([
            'InventorySyncService.reserveStock',
            'InventorySyncService.publishLowStock',
        ]);
        expect(singles.map(t => t.chunk.name)).toEqual(['InventorySyncService.ormMetadata']);
    });

    it('groups top-level functions of one file under __file__', () => {
        const tasks = [
            makeTask({ name: 'handleUpload', filepath: 'src/upload.ts' }),
            makeTask({ name: 'handleDownload', filepath: 'src/upload.ts' }),
        ];
        const { batches, singles } = groupTasksForBatching(tasks);
        expect(batches).toHaveLength(1);
        expect(singles).toHaveLength(0);
    });

    it('keeps different classes in different batches', () => {
        const tasks = [
            makeTask({ name: 'OrderProcessor.persistOrder' }),
            makeTask({ name: 'OrderProcessor.announceShipment' }),
            makeTask({ name: 'PaymentGateway.charge' }),
            makeTask({ name: 'PaymentGateway.refund' }),
        ];
        const { batches } = groupTasksForBatching(tasks);
        expect(batches).toHaveLength(2);
    });

    it('splits a group when shared context diverges (defensive invariant)', () => {
        const tasks = [
            makeTask({ name: 'InventorySyncService.reserveStock', imports: ['use A;'] }),
            makeTask({ name: 'InventorySyncService.publishLowStock', imports: ['use B;'] }),
        ];
        const { batches, singles } = groupTasksForBatching(tasks);
        // Divergent shared blocks cannot share-once: no batch survives.
        expect(batches).toHaveLength(0);
        expect(singles).toHaveLength(2);
    });

    it('caps batches at MAX_BATCH and routes the remainder singleton to singles', () => {
        const tasks = Array.from({ length: MAX_BATCH + 1 }, (_, i) =>
            makeTask({ name: `InventorySyncService.method${i}` }),
        );
        const { batches, singles } = groupTasksForBatching(tasks);
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(MAX_BATCH);
        expect(singles).toHaveLength(1);
    });

    it('routes singleton groups to singles (no batching win)', () => {
        const tasks = [
            makeTask({ name: 'OrderProcessor.persistOrder' }),
            makeTask({ name: 'lonelyHelper', filepath: 'src/util.ts' }),
        ];
        const { batches, singles } = groupTasksForBatching(tasks);
        expect(batches).toHaveLength(0);
        expect(singles).toHaveLength(2);
    });
});

describe('groupSinglesIntoMixedBatches() — prefix amortization', () => {
    it('merges same-language singletons from different files into one mixed batch', () => {
        const singles = [
            makeTask({ name: 'OrderProcessor.persistOrder', filepath: 'src/a.php' }),
            makeTask({ name: 'StockMailer.notify', filepath: 'src/b.php' }),
            makeTask({ name: 'lookupWarehouse', filepath: 'src/c.php' }),
        ];
        const { mixedBatches, remaining } = groupSinglesIntoMixedBatches(singles);
        expect(mixedBatches).toHaveLength(1);
        expect(mixedBatches[0]).toHaveLength(3);
        expect(remaining).toHaveLength(0);
    });

    it('never folds statically-resolved tasks into a mixed batch', () => {
        const singles = [
            makeTask({ name: 'OrderProcessor.persistOrder', filepath: 'src/a.php' }),
            makeTask({ name: 'StockMailer.notify', filepath: 'src/b.php' }),
            makeTask({ name: 'OrmMeta.table', filepath: 'src/d.php', isResolvedStatically: true }),
        ];
        const { mixedBatches, remaining } = groupSinglesIntoMixedBatches(singles);
        expect(mixedBatches).toHaveLength(1);
        expect(mixedBatches[0]).toHaveLength(2);
        expect(remaining.map(t => t.chunk.name)).toEqual(['OrmMeta.table']);
    });

    it('keeps different languages in different mixed batches (per-language agents)', () => {
        const singles = [
            makeTask({ name: 'a', filepath: 'src/a.php' }),
            makeTask({ name: 'b', filepath: 'src/b.php' }),
            { ...makeTask({ name: 'c', filepath: 'src/c.ts' }), chunk: { ...makeTask({ name: 'c', filepath: 'src/c.ts' }).chunk, language: 'typescript' } } as AnalysisTask,
        ];
        const { mixedBatches, remaining } = groupSinglesIntoMixedBatches(singles);
        expect(mixedBatches).toHaveLength(1);          // the 2 PHP ones
        expect(remaining).toHaveLength(1);             // the lone TS one stays single
    });

    it('separates singletons with different per-repo customKnowledge', () => {
        const singles = [
            makeTask({ name: 'a', filepath: 'src/a.php', customKnowledge: 'KNOWLEDGE-A' }),
            makeTask({ name: 'b', filepath: 'src/b.php', customKnowledge: 'KNOWLEDGE-B' }),
        ];
        const { mixedBatches, remaining } = groupSinglesIntoMixedBatches(singles);
        expect(mixedBatches).toHaveLength(0);
        expect(remaining).toHaveLength(2);
    });

    it('caps mixed batches at MAX_BATCH and leaves a lone remainder single', () => {
        const singles = Array.from({ length: MAX_BATCH + 1 }, (_, i) =>
            makeTask({ name: `fn${i}`, filepath: `src/f${i}.php` }),
        );
        const { mixedBatches, remaining } = groupSinglesIntoMixedBatches(singles);
        expect(mixedBatches).toHaveLength(1);
        expect(mixedBatches[0]).toHaveLength(MAX_BATCH);
        expect(remaining).toHaveLength(1);
    });
});

describe('demuxBatchResponse() — ordinal keys', () => {
    const tasks = [
        makeTask({ name: 'InventorySyncService.reserveStock' }),
        makeTask({ name: 'InventorySyncService.publishLowStock' }),
    ];

    it('maps analyses back to tasks by ORDINAL function_key (1-based)', () => {
        const byKey = new Map([
            ['1', analysis('writes reservations')],
            ['2', analysis('publishes low stock')],
        ]);
        const out = demuxBatchResponse(tasks, byKey);
        expect(out).toHaveLength(2);
        expect(out[0]?.intent).toBe('writes reservations');
        expect(out[1]?.intent).toBe('publishes low stock');
    });

    it('returns null for tasks whose ordinal is missing (single-call fallback marker)', () => {
        const byKey = new Map([
            ['1', analysis('writes reservations')],
        ]);
        const out = demuxBatchResponse(tasks, byKey);
        expect(out[0]).not.toBeNull();
        expect(out[1]).toBeNull();
    });

    it('ignores extra keys the model invented', () => {
        const byKey = new Map([
            ['1', analysis('writes reservations')],
            ['2', analysis('publishes low stock')],
            ['7', analysis('ghost')],
        ]);
        const out = demuxBatchResponse(tasks, byKey);
        expect(out).toHaveLength(2);
        expect(out.every(a => a !== null)).toBe(true);
    });

    it('never matches by function name (the old fragile contract)', () => {
        const byKey = new Map([
            ['InventorySyncService.reserveStock', analysis('writes reservations')],
        ]);
        const out = demuxBatchResponse(tasks, byKey);
        expect(out[0]).toBeNull();
        expect(out[1]).toBeNull();
    });
});

describe('promptVariantKey() — system-prompt variant (mirrors the agent cacheKey)', () => {
    it('non-io tasks share ONE variant regardless of sink categories (full filter prompt)', () => {
        const a = makeTask({ name: 'a', filterGate: 1, sinkCategories: ['database'] });
        const b = makeTask({ name: 'b', filterGate: 1, sinkCategories: ['broker'] });
        expect(promptVariantKey(a)).toBe(promptVariantKey(b));
    });

    it('io-confirmed tasks with DIFFERENT sink categories get different variants', () => {
        const db = makeTask({ name: 'db', filterGate: 4, sinkCategories: ['database'] });
        const broker = makeTask({ name: 'broker', filterGate: 4, sinkCategories: ['broker'] });
        expect(promptVariantKey(db)).not.toBe(promptVariantKey(broker));
    });

    it('io-confirmed tasks with the SAME sink categories share a variant (even across strong gates)', () => {
        const a = makeTask({ name: 'a', filterGate: 4, sinkCategories: ['database'] });
        const b = makeTask({ name: 'b', filterGate: 5, sinkCategories: ['database'] });
        expect(promptVariantKey(a)).toBe(promptVariantKey(b));
    });

    it('category order does not affect the variant (sorted signature)', () => {
        const a = makeTask({ name: 'a', filterGate: 4, sinkCategories: ['database', 'broker'] });
        const b = makeTask({ name: 'b', filterGate: 4, sinkCategories: ['broker', 'database'] });
        expect(promptVariantKey(a)).toBe(promptVariantKey(b));
    });

    it('io vs non-io for the same categories are different variants', () => {
        const io = makeTask({ name: 'io', filterGate: 4, sinkCategories: ['database'] });
        const nonio = makeTask({ name: 'nonio', filterGate: 1, sinkCategories: ['database'] });
        expect(promptVariantKey(io)).not.toBe(promptVariantKey(nonio));
    });

    it('different languages are different variants (per-language agents)', () => {
        const php = makeTask({ name: 'a', filterGate: 4, sinkCategories: ['database'] });
        const ts = { ...php, chunk: { ...php.chunk, language: 'typescript' } } as AnalysisTask;
        expect(promptVariantKey(php)).not.toBe(promptVariantKey(ts));
    });
});

describe('groupSinglesIntoMixedBatches() — variant-pure cross-file batching (cost reduction)', () => {
    it('does NOT merge io-confirmed singletons whose sink categories differ', () => {
        const singles = [
            makeTask({ name: 'a', filepath: 'src/a.php', filterGate: 4, sinkCategories: ['database'] }),
            makeTask({ name: 'b', filepath: 'src/b.php', filterGate: 4, sinkCategories: ['broker'] }),
        ];
        const { mixedBatches, remaining } = groupSinglesIntoMixedBatches(singles);
        // Different system prompts → they cannot share one call's cached prefix.
        expect(mixedBatches).toHaveLength(0);
        expect(remaining).toHaveLength(2);
    });

    it('merges io-confirmed singletons that share sink categories into one mixed batch', () => {
        const singles = [
            makeTask({ name: 'a', filepath: 'src/a.php', filterGate: 4, sinkCategories: ['database'] }),
            makeTask({ name: 'b', filepath: 'src/b.php', filterGate: 5, sinkCategories: ['database'] }),
        ];
        const { mixedBatches } = groupSinglesIntoMixedBatches(singles);
        expect(mixedBatches).toHaveLength(1);
        expect(mixedBatches[0]).toHaveLength(2);
    });

    it('does NOT merge io-confirmed singletons with non-io singletons (different preamble)', () => {
        const singles = [
            makeTask({ name: 'a', filepath: 'src/a.php', filterGate: 4, sinkCategories: ['database'] }),
            makeTask({ name: 'b', filepath: 'src/b.php', filterGate: 1, sinkCategories: ['database'] }),
        ];
        const { mixedBatches, remaining } = groupSinglesIntoMixedBatches(singles);
        expect(mixedBatches).toHaveLength(0);
        expect(remaining).toHaveLength(2);
    });
});
