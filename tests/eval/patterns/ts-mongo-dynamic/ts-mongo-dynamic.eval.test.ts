/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-mongo-dynamic
 *
 * Real-world case: TypeScript service with dynamic MongoDB collection names
 * using string template (`event_${tablePrefix}`).
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Extracts the function as has_io=true
 *   ✓ Does NOT extract template strings as literal collection names
 *   ✓ Does NOT extract JS variable names as DataContainer names
 *
 * Fixture: tests/fixtures/ts-mongo-dynamic/
 * Manifest: tests/fixtures/ts-mongo-dynamic/expected.graph.yaml
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

describe('Pattern Eval — ts-mongo-dynamic', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-mongo-dynamic | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-mongo-dynamic');
    });

    it('EventRepository.findEvents — should detect MongoDB I/O', async () => {
        const chunk = chunks.find(c => c.name === 'EventRepository');
        expect(chunk, 'Fixture must contain EventRepository.ts').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;

        // ── Core: must have I/O (MongoDB collection access) ──────────
        expect(analysis.has_io).toBe(true);

        // ── Score against manifest ───────────────────────────────────
        const score = scoreAnalysis(manifest, 'findEvents', analysis);

        // Expected: Function:findEvents should be in true positives
        expect(
            score.truePositives.some(tp => tp.includes('findEvents')),
            `Expected findEvents in true positives, got: ${JSON.stringify(score.truePositives)}`,
        ).toBe(true);

        // ── Negative assertions: template stubs must NOT appear ──────
        expect(
            score.negativeViolations,
            `Negative violations found: ${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        // ── Print extracted infra for debugging ──────────────────────
        console.log(`[Pattern Eval] Extracted infra:`, JSON.stringify(score.extractedByType, null, 2));
    });
});
