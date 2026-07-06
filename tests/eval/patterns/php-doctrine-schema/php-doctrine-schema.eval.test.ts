/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-doctrine-schema
 *
 * Real-world case: Doctrine ORM entities (Trip.php, Booking.php) are pure
 * DTOs with zero I/O. The heuristic filter should correctly classify them
 * as has_io=false, meaning no Function nodes should be extracted.
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Correctly classifies Doctrine entities as has_io=false
 *   ✓ Does NOT extract getters/setters as functions
 *
 * Fixture: tests/eval/patterns/php-doctrine-schema/fixture/
 * Manifest: tests/eval/patterns/php-doctrine-schema/expected.graph.yaml
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

describe('Pattern Eval — php-doctrine-schema', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] php-doctrine-schema | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('php-doctrine-schema');
    });

    it('Trip.php — should classify as has_io=false (pure Doctrine DTO)', async () => {
        const chunk = chunks.find(c => c.name === 'Trip');
        expect(chunk, 'Fixture must contain Trip.php').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;

        // Doctrine entities are pure DTOs — the EntityManager does the DB work,
        // NOT the entity itself. has_io should be false.
        expect(analysis.has_io).toBe(false);

        // No getter/setter should appear as a negative violation
        const score = scoreAnalysis(manifest, 'Trip', analysis);
        expect(
            score.negativeViolations,
            `Negative violations: ${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        console.log(`[Pattern Eval] Trip.php analysis:`, JSON.stringify({ has_io: analysis.has_io, infra: analysis.infrastructure }, null, 2));
    });

    it('Booking.php — should classify as has_io=false (pure Doctrine DTO)', async () => {
        const chunk = chunks.find(c => c.name === 'Booking');
        expect(chunk, 'Fixture must contain Booking.php').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(false);

        console.log(`[Pattern Eval] Booking.php analysis:`, JSON.stringify({ has_io: analysis.has_io, infra: analysis.infrastructure }, null, 2));
    });
});
