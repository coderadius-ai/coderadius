import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { analyzeFunction } from '../../../../src/ai/agents/unified-analyzer.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import { wireUnifiedAnalyzerReplay } from '../../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../../helpers/llm-replay-cache.js';
import {
    loadFixtureChunks,
    loadFixtureManifest,
    scoreAnalysis,
} from '../../helpers/pattern-eval.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

// Wire replay cache
await wireUnifiedAnalyzerReplay();

describe('Pattern Eval — ts-env-vars', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-env-vars | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-env-vars');
    });

    it('OrderController — should detect I/O for createOrder, getOrderStatus, notifyPaymentService', async () => {
        const chunk = chunks.find(c => c.name === 'OrderController');
        expect(chunk, 'Fixture must contain OrderController.ts').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast'); // Force deep mode
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(true);

        const score = scoreAnalysis(manifest, 'OrderController', analysis);

        // Core assertions for expected nodes
        expect(score.truePositives).toContain('DataContainer:orders');
        expect(score.truePositives).toContain('DataContainer:users');
        expect(score.truePositives).toContain('MessageChannel:orders_exchange');

        expect(score.negativeViolations).toHaveLength(0);
    });

    it('OrderRouter — should detect API endpoints', async () => {
        const chunk = chunks.find(c => c.name === 'OrderRouter');
        expect(chunk, 'Fixture must contain OrderRouter.ts').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(true);

        const paths = analysis.emergent_api_calls!.map(a => a.path);
        expect(paths).toContain('/orders');
        expect(paths).toContain('/orders/{id}');
        expect(paths).toContain('/orders/forward-webhook');
    });
});
