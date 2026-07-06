/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-nestjs-typeorm
 *
 * NestJS service using TypeORM @InjectRepository to access multiple database
 * tables. The DB connection is configured externally via TypeOrmModule.
 * forRootAsync with a Zod-validated config (registerAs pattern).
 *
 * Verifies that the LLM correctly:
 *   ✓ Extracts each TypeORM entity table as a DataContainer
 *   ✓ Uses table names (quotes, saves, renewals), NOT entity class names
 *   ✓ Does NOT extract DI tokens (quoteRepo) as DataContainers
 *   ✓ Does NOT extract service class name as DataContainer
 *
 * Fixture: tests/eval/patterns/ts-nestjs-typeorm/fixture/
 * Manifest: tests/eval/patterns/ts-nestjs-typeorm/expected.graph.yaml
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
    buildFixtureEntityTableContext,
    loadFixtureChunks,
    loadFixtureManifest,
    scoreAnalysis,
} from '../../helpers/pattern-eval.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

// Wire replay cache (generic + per-language agents — see with-replay.ts)
await wireUnifiedAnalyzerReplay();

describe('Pattern Eval — ts-nestjs-typeorm', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-nestjs-typeorm | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-nestjs-typeorm');
    });

    it('static: @Entity table names ground the LLM context (quotes, saves, renewals)', () => {
        // Deterministic pin (no LLM): the entity fixtures declare explicit
        // @Entity('table') names, and the production grounding chain
        // (framework signals → __class_metadata → entity-table registry →
        // entityTableContext) must surface ALL of them for QuoteService.
        const chunk = chunks.find(c => c.name === 'QuoteService');
        const ctx = buildFixtureEntityTableContext(chunks, chunk!);
        expect(ctx, 'entity grounding context must resolve').not.toBeNull();
        for (const table of ['quotes', 'saves', 'renewals']) {
            expect(ctx, `grounding context must carry table "${table}"`).toContain(`table "${table}"`);
        }
    });

    it('QuoteService — should extract TypeORM entity tables as DataContainers', async () => {
        const chunk = chunks.find(c => c.name === 'QuoteService');
        expect(chunk, 'Fixture must contain QuoteService class').toBeDefined();

        // Ground the LLM with the AST-declared table names — without this the
        // model guesses singular/plural from the class name (nondeterministic).
        const entityCtx = buildFixtureEntityTableContext(chunks, chunk!);
        expect(entityCtx).not.toBeNull();

        const result = await analyzeFunction(
            chunk!, 'fast',
            undefined,         // context
            undefined,         // taintContextSummary
            undefined,         // customKnowledge
            undefined,         // resolvedTypeDefinitions
            entityCtx!,        // entityTableContext ← static grounding
        );
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;

        // ── Core: must have I/O (TypeORM repository operations) ─────
        expect(analysis.has_io).toBe(true);

        // ── Score against manifest ──────────────────────────────────
        const score = scoreAnalysis(manifest, 'QuoteService', analysis);

        // Expected: ALL grounded table names (the context says "You MUST use
        // these table names"; with grounding this is deterministic).
        const dataContainers = score.truePositives.filter(tp =>
            tp.startsWith('DataContainer:'));
        expect(
            dataContainers.length,
            `Expected all 3 grounded DataContainers in true positives, ` +
            `got: ${JSON.stringify(score.truePositives)}. ` +
            `Extracted infra: ${JSON.stringify(score.extractedByType)}`,
        ).toBeGreaterThanOrEqual(3);

        // ── Negative assertions: entity/class/DI names must NOT appear ──
        expect(
            score.negativeViolations,
            `Negative violations found — LLM extracted code identifiers as DataContainers: ` +
            `${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        // ── Print extracted infra for debugging ─────────────────────
        console.log(`[Pattern Eval] Extracted infra:`, JSON.stringify(score.extractedByType, null, 2));
    });
});
