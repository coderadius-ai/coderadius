/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — batch-grouping
 *
 * Pins the batched-extraction behavior end-to-end on real multi-method
 * classes (PHP + TS), through real tree-sitter chunking and the real
 * extractSemantics pipeline with replay-cached LLM responses:
 *
 *   1. Grouping correctness — every LLM-bound method of one class rides ONE
 *      batched call (BATCH_SEND.memberCount = 5).
 *   2. Static-bypass exclusion — an AST-resolved task never enters a batch.
 *   3. Array demux — each method maps to its own analysis by function_key.
 *   4. Per-function extraction quality — DB write / broker publish / HTTP
 *      call land on the RIGHT member; pure helpers are rejected.
 *   5. No cross-member bleed — one member's infrastructure never leaks into
 *      a sibling (per-function sanitizer + anti-contamination rule).
 *
 * Modes: replay (default, deterministic) | live | refresh
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';
import { extractSemantics } from '../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js';
import { traceCollector } from '../../../../src/telemetry/index.js';
import type { AnalysisTask, ExtractedFunctionData } from '../../../../src/ingestion/processors/code-pipeline/types.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import { wireUnifiedAnalyzerReplay } from '../../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../../helpers/llm-replay-cache.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

await wireUnifiedAnalyzerReplay();

// ─── Task assembly from real fixture parses ──────────────────────────────────

function makeTask(chunk: CodeChunk, shared: { imports: string[]; constructorSource?: string }): AnalysisTask {
    return {
        kind: 'analysis',
        functionId: `urn:function:acme:${chunk.filepath}:${chunk.name}`,
        functionHash: `${chunk.name}-hash`,
        chunk,
        fileContext: {
            absolutePath: path.join(FIXTURE_DIR, chunk.filepath),
            relativePath: chunk.filepath,
            repo: { name: 'acme-fixture', path: FIXTURE_DIR, origin: 'local' },
            routing: { type: 'repository', name: 'acme-fixture', urn: 'urn:repository:acme-fixture' },
        },
        imports: shared.imports,
        constructorSource: shared.constructorSource,
    } as unknown as AnalysisTask;
}

function parseFixture(
    plugin: PHPPlugin | TypeScriptPlugin,
    relPath: string,
): { chunks: CodeChunk[]; source: string } {
    const absPath = path.join(FIXTURE_DIR, relPath);
    const source = fs.readFileSync(absPath, 'utf-8');
    const parser = plugin.createParser();
    const tree = parser.parse(source);
    const chunks = plugin.extractFunctions(tree, source, relPath);
    return { chunks, source };
}

function importsOf(source: string, language: 'php' | 'typescript'): string[] {
    const re = language === 'php' ? /^use .+;$/gm : /^import .+;$/gm;
    return source.match(re) ?? [];
}

function constructorOf(source: string, language: 'php' | 'typescript'): string | undefined {
    const re = language === 'php'
        ? /public function __construct\([\s\S]*?\)\s*(?:\{[\s\S]*?\})?/
        : /constructor\([\s\S]*?\)\s*\{[\s\S]*?\}/;
    return source.match(re)?.[0];
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Pattern Eval — batch-grouping', () => {
    const traceSpy = vi.spyOn(traceCollector, 'traceLLM');

    let extracted: ExtractedFunctionData[] = [];
    let rejectedCount = 0;
    let staticTaskId = '';

    const findExtraction = (suffix: string) =>
        extracted.find(f => f.chunk.name.endsWith(suffix));

    beforeAll(async () => {
        console.log(`[Pattern Eval] batch-grouping | Mode: ${EVAL_LLM_MODE}`);

        const php = parseFixture(new PHPPlugin(), 'src/Inventory/InventorySyncService.php');
        const ts = parseFixture(new TypeScriptPlugin(), 'src/orders/OrderProcessor.ts');
        // Singleton classes (one I/O method each): merged into a MIXED batch (R2)
        const lookup = parseFixture(new PHPPlugin(), 'src/Inventory/WarehouseLookup.php');
        const webhook = parseFixture(new PHPPlugin(), 'src/Shipping/CarrierWebhook.php');

        const sharedOf = (src: string, lang: 'php' | 'typescript') => ({
            imports: importsOf(src, lang),
            constructorSource: constructorOf(src, lang),
        });
        const phpShared = sharedOf(php.source, 'php');
        const tsShared = sharedOf(ts.source, 'typescript');

        const isMethod = (c: CodeChunk) =>
            c.name.includes('.') && !/\.(?:__construct|constructor)$/.test(c.name);
        const phpTasks = php.chunks.filter(isMethod).map(c => makeTask(c, phpShared));
        const tsTasks = ts.chunks.filter(isMethod).map(c => makeTask(c, tsShared));
        const singletonTasks = [
            ...lookup.chunks.filter(isMethod).map(c => makeTask(c, sharedOf(lookup.source, 'php'))),
            ...webhook.chunks.filter(isMethod).map(c => makeTask(c, sharedOf(webhook.source, 'php'))),
        ];

        expect(phpTasks.length, 'PHP fixture must yield 5 method chunks').toBe(5);
        expect(tsTasks.length, 'TS fixture must yield 5 method chunks').toBe(5);
        expect(singletonTasks.length, 'singleton fixtures must yield 1 method each').toBe(2);

        // Static-bypass exclusion guard: an AST-resolved sixth member of the
        // PHP class must never enter the batch.
        const staticTask = {
            ...makeTask(
                { ...phpTasks[0].chunk, name: 'InventorySyncService.ormMetadata' },
                phpShared,
            ),
            isResolvedStatically: true,
            staticAnalysis: { has_io: true, intent: 'static ORM metadata', infrastructure: [], capabilities: [] },
        } as unknown as AnalysisTask;
        staticTaskId = staticTask.functionId;

        const result = await extractSemantics(
            [...phpTasks, staticTask, ...tsTasks, ...singletonTasks],
            [],
            undefined,
            'semantic',
        );
        extracted = result.extractedFunctions;
        rejectedCount = result.rejectedCount;

        expect(result.failedCount, 'no member may fail').toBe(0);
        expect(result.deferredTasks).toHaveLength(0);
    }, 240_000);

    it('1. groups each class into ONE shared batch of 5; singletons into ONE mixed batch', () => {
        const batchSends = traceSpy.mock.calls.filter(c => c[0] === 'BATCH_SEND');
        const shared = batchSends.filter(c => (c[3] as any).kind === 'shared');
        const mixed = batchSends.filter(c => (c[3] as any).kind === 'mixed');

        expect(shared).toHaveLength(2);
        for (const call of shared) expect((call[3] as any).memberCount).toBe(5);

        expect(mixed).toHaveLength(1);
        expect((mixed[0][3] as any).memberCount).toBe(2);
    });

    it('2. never folds a statically-resolved task into a batch', () => {
        const batchSends = traceSpy.mock.calls.filter(c => c[0] === 'BATCH_SEND');
        for (const call of batchSends) {
            expect((call[3] as any).functionIds).not.toContain(staticTaskId);
        }
        const staticEvents = traceSpy.mock.calls.filter(
            c => c[0] === 'STATIC' && c[1] === staticTaskId,
        );
        expect(staticEvents).toHaveLength(1);
    });

    it('3. demuxes per-function analyses with batch attribution', () => {
        const receives = traceSpy.mock.calls.filter(
            c => c[0] === 'RECEIVE' && (c[3] as any)?.batchId,
        );
        expect(receives.length).toBeGreaterThanOrEqual(5);
    });

    it('4a. PHP: reserveStock writes the inventory_reservations table', () => {
        const fn = findExtraction('reserveStock');
        expect(fn, 'reserveStock must be extracted').toBeDefined();
        const dbNames = fn!.analysis.infrastructure
            ?.filter(i => i.type === 'Database')
            .map(i => i.name);
        expect(dbNames).toContain('inventory_reservations');
    });

    it('4b. PHP: publishLowStock publishes the inventory.low_stock routing key', () => {
        const fn = findExtraction('publishLowStock');
        expect(fn, 'publishLowStock must be extracted').toBeDefined();
        // The structured form (exchange as channel name + routingKey field) is
        // the canonical one: PUBLISHES_TO edges are keyed by routingKey.
        const channels = (fn!.analysis.infrastructure ?? [])
            .filter(i => i.type === 'MessageChannel' && i.operation === 'WRITES');
        expect(channels.length).toBeGreaterThanOrEqual(1);
        expect(channels.some(i =>
            ((i as any).routingKey ?? '').toLowerCase().includes('low_stock')
            || i.name.toLowerCase().includes('low_stock'),
        )).toBe(true);
    });

    it('4c. PHP: fetchSupplierPrice calls the supplier prices endpoint', () => {
        const fn = findExtraction('fetchSupplierPrice');
        expect(fn, 'fetchSupplierPrice must be extracted').toBeDefined();
        const paths = (fn!.analysis.emergent_api_calls ?? []).map(c => c.path);
        expect(paths.some(p => p.includes('/api/v1/suppliers/prices'))).toBe(true);
    });

    it('4d. TS: persistOrder writes order_ledger; announceShipment publishes the shipment key', () => {
        const persist = findExtraction('persistOrder');
        expect(persist).toBeDefined();
        expect(
            persist!.analysis.infrastructure?.filter(i => i.type === 'Database').map(i => i.name),
        ).toContain('order_ledger');

        const announce = findExtraction('announceShipment');
        expect(announce).toBeDefined();
        const channels = (announce!.analysis.infrastructure ?? [])
            .filter(i => i.type === 'MessageChannel' && i.operation === 'WRITES');
        expect(channels.length).toBeGreaterThanOrEqual(1);
        expect(channels.some(i =>
            ((i as any).routingKey ?? '').toLowerCase().includes('shipment')
            || i.name.toLowerCase().includes('shipment'),
        )).toBe(true);
    });

    it('4e. rejects the pure helpers (formatSku, validateQuantity, normalizeOrderId, computeVolume)', () => {
        for (const helper of ['formatSku', 'validateQuantity', 'normalizeOrderId', 'computeVolume']) {
            expect(findExtraction(helper), `${helper} must not be extracted`).toBeUndefined();
        }
        expect(rejectedCount).toBeGreaterThanOrEqual(4);
    });

    it('6. MIXED batch: each singleton gets its own correct extraction, no bleed', () => {
        const lookup = findExtraction('findNearestWarehouse');
        expect(lookup, 'findNearestWarehouse must be extracted').toBeDefined();
        const lookupDb = (lookup!.analysis.infrastructure ?? [])
            .filter(i => i.type === 'Database')
            .map(i => i.name);
        expect(lookupDb).toContain('warehouse_locations');

        const webhook = findExtraction('notifyCarrier');
        expect(webhook, 'notifyCarrier must be extracted').toBeDefined();
        const webhookPaths = (webhook!.analysis.emergent_api_calls ?? []).map(c => c.path);
        expect(webhookPaths.some(p => p.includes('/api/v2/shipments/notifications'))).toBe(true);

        // no bleed across mixed siblings (different files!)
        const webhookNames = (webhook!.analysis.infrastructure ?? []).map(i => i.name.toLowerCase());
        expect(webhookNames).not.toContain('warehouse_locations');
        const lookupPaths = (lookup!.analysis.emergent_api_calls ?? []).map(c => c.path);
        expect(lookupPaths.some(p => p.includes('/api/v2/shipments'))).toBe(false);
    });

    it('5. no cross-member bleed between batched siblings', () => {
        const reserve = findExtraction('reserveStock');
        const publish = findExtraction('publishLowStock');
        const reserveNames = (reserve?.analysis.infrastructure ?? []).map(i => i.name.toLowerCase());
        const publishNames = (publish?.analysis.infrastructure ?? []).map(i => i.name.toLowerCase());

        expect(reserveNames.some(n => n.includes('low_stock'))).toBe(false);
        expect(publishNames.some(n => n.includes('inventory_reservations'))).toBe(false);
    });
});
