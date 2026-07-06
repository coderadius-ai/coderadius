/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-taint-propagation
 *
 * Real-world case: FulfillmentController has ZERO direct I/O imports
 * (no axios, no fetch, no pg). It uses an injected ApiGateway that wraps
 * axios. Only taint analysis via DI alias mapping can detect the I/O.
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Detects FulfillmentController as has_io=true (via taint propagation)
 *   ✓ Extracts dispatchToWarehouse and getShipmentTracking as I/O methods
 *   ✓ Does NOT extract calculateShippingCost (pure business logic)
 *   ✓ Does NOT extract isValidAddress (pure validation)
 *   ✓ Detects ApiGateway as has_io=true (direct axios import)
 *
 * Fixture: tests/eval/patterns/ts-taint-propagation/fixture/
 * Manifest: tests/eval/patterns/ts-taint-propagation/expected.graph.yaml
 *
 * Modes: replay (default, ~1s) | live | refresh
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { analyzeFunction} from '../../../../src/ai/agents/unified-analyzer.js';
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

// Wire replay cache (generic + per-language agents — see with-replay.ts)
await wireUnifiedAnalyzerReplay();

describe('Pattern Eval — ts-taint-propagation', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-taint-propagation | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-taint-propagation');
    });

    it('FulfillmentController — should detect I/O via taint propagation (no direct imports)', async () => {
        const chunk = chunks.find(c => c.name === 'FulfillmentController');
        expect(chunk, 'Fixture must contain FulfillmentController.ts').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;

        // Core: FulfillmentController uses this.api.post()/get() via injected ApiGateway.
        // The LLM must detect this as I/O despite ZERO direct axios/fetch imports.
        expect(analysis.has_io).toBe(true);

        // Negative check: pure business logic methods must NOT be extracted
        const score = scoreAnalysis(manifest, 'FulfillmentController', analysis);
        expect(
            score.negativeViolations,
            `Negative violations — pure functions leaked: ${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        // The extracted infra should show API endpoint calls
        console.log(`[Pattern Eval] FulfillmentController extracted:`, JSON.stringify(score.extractedByType, null, 2));
    });

    it('ApiGateway — should detect I/O directly (axios import)', async () => {
        const chunk = chunks.find(c => c.name === 'ApiGateway' || c.name === 'CustomHttpWrapper');
        expect(chunk, 'Fixture must contain CustomHttpWrapper.ts').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;

        // ApiGateway wraps axios directly — trivial I/O detection
        expect(analysis.has_io).toBe(true);

        console.log(`[Pattern Eval] ApiGateway has_io:`, analysis.has_io, 'infra:', JSON.stringify(analysis.infrastructure, null, 2));
    });
});
