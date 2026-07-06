/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-legacy-scraper
 *
 * Real-world case: Legacy PHP monolith with procedural scripts, abstract
 * classes, singleton patterns, and dynamic SQL via MagicDbEntity.
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Extracts I/O functions from OOP classes (AbstractScraper, TravelGlobal)
 *   ✓ Detects exec() spawning as I/O
 *   ✓ Handles dynamic SQL in MagicDbEntity.save() gracefully
 *   ✓ Extracts concrete table names (trip_quotes, telemetry, bookings)
 *   ✓ Does NOT leak PHP variable names as DataContainer names
 *
 * Fixture: tests/eval/patterns/php-legacy-scraper/fixture/
 * Manifest: tests/eval/patterns/php-legacy-scraper/expected.graph.yaml
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

describe('Pattern Eval — php-legacy-scraper', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] php-legacy-scraper | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('php-legacy-scraper');
    });

    it('AbstractScraper — should detect I/O and extract concrete table names', async () => {
        const chunk = chunks.find(c => c.name === 'AbstractScraper');
        expect(chunk, 'Fixture must contain AbstractScraper.php').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(true);

        const score = scoreAnalysis(manifest, 'AbstractScraper', analysis);

        // Should extract concrete table names from raw SQL
        expect(
            score.truePositives.some(tp => tp.includes('trip_quotes') || tp.includes('telemetry') || tp.includes('bookings')),
            `Expected at least one concrete table in true positives: ${JSON.stringify(score.truePositives)}`,
        ).toBe(true);

        // No negative violations (PHP vars as DataContainers)
        expect(score.negativeViolations).toHaveLength(0);

        console.log(`[Pattern Eval] AbstractScraper extracted:`, JSON.stringify(score.extractedByType, null, 2));
    });

    it('TravelGlobal — should detect exec() spawning as I/O', async () => {
        const chunk = chunks.find(c => c.name === 'TravelGlobal');
        expect(chunk, 'Fixture must contain TravelGlobal.php').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        // exec() is I/O — this is the core assertion
        expect(analysis.has_io).toBe(true);

        console.log(`[Pattern Eval] TravelGlobal has_io:`, analysis.has_io, 'infra:', JSON.stringify(analysis.infrastructure, null, 2));
    });

    it('MagicDbEntity — should detect dynamic SQL save() as I/O without leaking PHP vars', async () => {
        const chunk = chunks.find(c => c.name === 'MagicDbEntity');
        expect(chunk, 'Fixture must contain MagicDbEntity.php').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(true);

        const score = scoreAnalysis(manifest, 'MagicDbEntity', analysis);

        // Must not leak PHP variable names as DataContainer names
        expect(
            score.negativeViolations,
            `Negative violations found — PHP vars as DataContainers: ${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        console.log(`[Pattern Eval] MagicDbEntity extracted:`, JSON.stringify(score.extractedByType, null, 2));
    });
});
