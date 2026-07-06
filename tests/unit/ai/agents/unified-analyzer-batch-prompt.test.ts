/**
 * Unit Tests — batch prompt assembly
 *
 * One LLM call per (file, class) group: shared blocks shipped ONCE, then N
 * per-function tails. Pure string assertions, no LLM.
 */

import { describe, it, expect } from 'vitest';
import {
    buildBatchAnalysisPrompt,
    buildMixedBatchAnalysisPrompt,
    type BatchSharedContext,
    type BatchFunctionContext,
    type MixedBatchMemberContext,
} from '../../../../src/ai/agents/unified-analyzer.js';
import type { CodeChunk } from '../../../../src/graph/types.js';

function makeChunk(name: string, sourceCode: string): CodeChunk {
    return {
        name,
        filepath: 'src/Inventory/InventorySyncService.php',
        sourceCode,
        language: 'php',
        startLine: 1,
        startColumn: 0,
        endLine: 10,
        endColumn: 1,
    } as CodeChunk;
}

const shared: BatchSharedContext = {
    filepath: 'src/Inventory/InventorySyncService.php',
    language: 'php',
    customKnowledge: 'CUSTOM-KNOWLEDGE-MARKER',
    frameworkSignalContext: 'FRAMEWORK-SIGNAL-MARKER',
    context: {
        imports: ['use Acme\\Inventory\\OrdersRepository;'],
        constructorSource: 'public function __construct(private OrdersRepository $ordersRepository) {}',
        classProperties: ['private OrdersRepository $ordersRepository'],
    },
};

const functions: BatchFunctionContext[] = [
    { chunk: makeChunk('InventorySyncService.reserveStock', 'function reserveStock() { /* sql */ }'), taintContextSummary: 'TAINT-A' },
    { chunk: makeChunk('InventorySyncService.publishLowStock', 'function publishLowStock() { /* amqp */ }'), taintContextSummary: 'TAINT-B' },
    { chunk: makeChunk('InventorySyncService.fetchSupplierPrice', 'function fetchSupplierPrice() { /* http */ }') },
];

describe('buildBatchAnalysisPrompt() — shared-class batching', () => {
    it('ships every shared block exactly once', () => {
        const { prompt } = buildBatchAnalysisPrompt(shared, functions);

        const count = (needle: string) => prompt.split(needle).length - 1;
        expect(count('CUSTOM-KNOWLEDGE-MARKER')).toBe(1);
        expect(count('FRAMEWORK-SIGNAL-MARKER')).toBe(1);
        expect(count('OrdersRepository $ordersRepository')).toBeGreaterThanOrEqual(1);
        expect(count('--- DI Context')).toBe(1);
    });

    it('emits one per-function tail per function, keyed by ORDINAL and in order', () => {
        const { prompt } = buildBatchAnalysisPrompt(shared, functions);

        // Ordinal keys: PHP FQNs with backslashes are unechoable by the model
        // (JSON escaping mangles them — 55/59 batches fell back on a large legacy repo).
        // The key is the function's number; the name stays visible for context.
        const k1 = prompt.indexOf('function_key: "1"');
        const k2 = prompt.indexOf('function_key: "2"');
        const k3 = prompt.indexOf('function_key: "3"');
        expect(k1).toBeGreaterThan(-1);
        expect(k2).toBeGreaterThan(k1);
        expect(k3).toBeGreaterThan(k2);

        // function names still present for analysis context
        expect(prompt).toContain('InventorySyncService.reserveStock');
        expect(prompt).toContain('InventorySyncService.publishLowStock');

        // per-function content rides inside its own tail
        const taintA = prompt.indexOf('TAINT-A');
        const taintB = prompt.indexOf('TAINT-B');
        expect(taintA).toBeGreaterThan(k1);
        expect(taintA).toBeLessThan(k2);
        expect(taintB).toBeGreaterThan(k2);
        expect(taintB).toBeLessThan(k3);
    });

    it('places all shared blocks before the first function tail (Vertex prefix order)', () => {
        const { prompt } = buildBatchAnalysisPrompt(shared, functions);

        const firstTail = prompt.indexOf('function_key:');
        expect(prompt.indexOf('CUSTOM-KNOWLEDGE-MARKER')).toBeLessThan(firstTail);
        expect(prompt.indexOf('FRAMEWORK-SIGNAL-MARKER')).toBeLessThan(firstTail);
        expect(prompt.indexOf('--- DI Context')).toBeLessThan(firstTail);
    });

    it('carries the anti-cross-contamination instruction in the batch header', () => {
        const { prompt } = buildBatchAnalysisPrompt(shared, functions);

        const firstTail = prompt.indexOf('function_key:');
        const ruleIdx = prompt.indexOf('Never copy an entry from one function to another');
        expect(ruleIdx).toBeGreaterThan(-1);
        expect(ruleIdx).toBeLessThan(firstTail);
    });

    it('reports shared and per-function char accounting', () => {
        const { sharedChars, functionChars } = buildBatchAnalysisPrompt(shared, functions);

        expect(sharedChars).toBeGreaterThan(0);
        expect(Object.keys(functionChars)).toEqual([
            'InventorySyncService.reserveStock',
            'InventorySyncService.publishLowStock',
            'InventorySyncService.fetchSupplierPrice',
        ]);
        for (const v of Object.values(functionChars)) expect(v).toBeGreaterThan(0);
    });
});

describe('buildMixedBatchAnalysisPrompt() — cross-file singletons', () => {
    const members: MixedBatchMemberContext[] = [
        {
            chunk: makeChunk('OrderArchiver.archive', 'function archive() { /* sql */ }'),
            filepath: 'src/Orders/OrderArchiver.php',
            context: { imports: ['use Acme\\Orders\\ArchivePdo;'], constructorSource: 'public function __construct(private ArchivePdo $pdo) {}' },
            taintContextSummary: 'TAINT-ARCHIVE',
        },
        {
            chunk: makeChunk('StockMailer.notify', 'function notify() { /* http */ }'),
            filepath: 'src/Inventory/StockMailer.php',
            context: { imports: ['use GuzzleHttp\\Client;'] },
            frameworkSignalContext: 'FRAMEWORK-MAILER',
        },
    ];

    it('ships per-repo customKnowledge ONCE in the header, per-member context inside each tail', () => {
        const { prompt } = buildMixedBatchAnalysisPrompt(
            { language: 'php', customKnowledge: 'CUSTOM-KNOWLEDGE-MARKER' },
            members,
        );

        const count = (needle: string) => prompt.split(needle).length - 1;
        expect(count('CUSTOM-KNOWLEDGE-MARKER')).toBe(1);

        const k1 = prompt.indexOf('function_key: "1"');
        const k2 = prompt.indexOf('function_key: "2"');
        expect(prompt.indexOf('CUSTOM-KNOWLEDGE-MARKER')).toBeLessThan(k1);

        // each member's file-scoped blocks live inside ITS OWN tail
        const archiveDi = prompt.indexOf('ArchivePdo');
        const mailerImports = prompt.indexOf('GuzzleHttp');
        const mailerSignal = prompt.indexOf('FRAMEWORK-MAILER');
        expect(archiveDi).toBeGreaterThan(k1);
        expect(archiveDi).toBeLessThan(k2);
        expect(mailerImports).toBeGreaterThan(k2);
        expect(mailerSignal).toBeGreaterThan(k2);
    });

    it('carries per-member file paths in the tails (no shared File path header)', () => {
        const { prompt } = buildMixedBatchAnalysisPrompt({ language: 'php' }, members);

        const k1 = prompt.indexOf('function_key: "1"');
        const p1 = prompt.indexOf('File path: src/Orders/OrderArchiver.php');
        const p2 = prompt.indexOf('File path: src/Inventory/StockMailer.php');
        expect(p1).toBeGreaterThan(k1);
        expect(p2).toBeGreaterThan(p1);
    });

    it('keeps the anti-cross-contamination rule and ordinal keys', () => {
        const { prompt, functionChars } = buildMixedBatchAnalysisPrompt({ language: 'php' }, members);

        expect(prompt).toContain('Never copy an entry from one function to another');
        expect(prompt).toContain('function_key: "1"');
        expect(prompt).toContain('function_key: "2"');
        expect(Object.keys(functionChars)).toEqual(['OrderArchiver.archive', 'StockMailer.notify']);
    });
});
