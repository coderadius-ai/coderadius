/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-mongoose-embedded
 *
 * Regression fixture: Mongoose @Schema({ _id: false }) embedded subdocument
 * must NOT produce a phantom DataContainer (e.g. `quote_id_sub`).
 *
 * This eval covers BOTH the static extraction path (framework-signals +
 * static-infra) and the LLM analysis path. The static path is the primary
 * regression surface — the bug was that `@Schema({ _id: false })` was treated
 * as a standalone ORM entity, triggering fallbackOrmName → `quote_id_sub`.
 *
 * Fixture: tests/eval/patterns/ts-mongoose-embedded/fixture/
 * Manifest: tests/eval/patterns/ts-mongoose-embedded/expected.graph.yaml
 *
 * Modes: replay (default, ~1s) | live | refresh
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { analyzeFunction} from '../../../../src/ai/agents/unified-analyzer.js';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';
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

const plugin = new TypeScriptPlugin();
const parser = plugin.createParser();

describe('Pattern Eval — ts-mongoose-embedded', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-mongoose-embedded | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-mongoose-embedded');
    });

    // ── Static Path: framework-signals + static-infra ────────────────────
    // This is the core regression test — no LLM needed

    it('static: @Schema({ _id: false }) must NOT emit orm-entity signal or __class_metadata chunk', () => {
        const entityChunk = chunks.find(c => c.name === 'ValidationErrorLog.entity');
        expect(entityChunk, 'Fixture must contain ValidationErrorLog.entity.ts').toBeDefined();

        const tree = parser.parse(entityChunk!.sourceCode);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, entityChunk!.sourceCode, entityChunk!.filepath);

        // QuoteIdSubEntity has @Schema({ _id: false }) → must NOT be orm-entity
        expect(
            signals.some(s => s.kind === 'orm-entity' && s.ownerName === 'QuoteIdSubEntity'),
            'QuoteIdSubEntity (@Schema({ _id: false })) must NOT emit orm-entity signal',
        ).toBe(false);

        // ValidationErrorLogEntity has @Schema({ collection: '...' }) → MUST be orm-entity
        expect(
            signals.some(s => s.kind === 'orm-entity' && s.ownerName === 'ValidationErrorLogEntity'),
            'ValidationErrorLogEntity must emit orm-entity signal',
        ).toBe(true);

        // Verify no __class_metadata chunk is emitted for the subdocument
        const metadataChunks = plugin.extractFunctions(tree, entityChunk!.sourceCode, entityChunk!.filepath);
        expect(
            metadataChunks.find(c => c.name === 'QuoteIdSubEntity::__class_metadata'),
            'No __class_metadata chunk for embedded subdocument',
        ).toBeUndefined();
    });

    it('static: standalone @Schema({ collection }) must resolve to correct collection name', () => {
        const entityChunk = chunks.find(c => c.name === 'ValidationErrorLog.entity');
        expect(entityChunk).toBeDefined();

        const tree = parser.parse(entityChunk!.sourceCode);
        const metadataChunks = plugin.extractFunctions(tree, entityChunk!.sourceCode, entityChunk!.filepath);
        const parentChunk = metadataChunks.find(c => c.name === 'ValidationErrorLogEntity::__class_metadata');
        expect(parentChunk, 'Parent collection must have __class_metadata chunk').toBeDefined();

        const staticInfra = plugin.extractStaticInfra(tree.rootNode, parentChunk!);
        expect(staticInfra).not.toBeNull();
        expect(staticInfra!.infrastructure[0]).toMatchObject({
            name: 'validation_error_log',
            type: 'Database',
            operation: 'MAPS_TO',
            kindFamily: 'document',
        });
    });

    // ── LLM Path: service function analysis ──────────────────────────────

    it('LLM: FormValidationService — should detect MongoDB I/O without phantom subdocument names', async () => {
        const serviceChunk = chunks.find(c => c.name === 'FormValidationService');
        expect(serviceChunk, 'Fixture must contain FormValidationService').toBeDefined();

        // Ground the LLM with the @Schema({ collection }) declared name —
        // without this the model invents a collection from the class name
        // ('ValidationErrorLogEntity' / 'validationerrorlogentities').
        const entityCtx = buildFixtureEntityTableContext(chunks, serviceChunk!);
        expect(entityCtx, 'collection grounding context must resolve').not.toBeNull();
        expect(entityCtx).toContain('table "validation_error_log"');

        const result = await analyzeFunction(
            serviceChunk!, 'fast',
            undefined,         // context
            undefined,         // taintContextSummary
            undefined,         // customKnowledge
            undefined,         // resolvedTypeDefinitions
            entityCtx!,        // entityTableContext ← static grounding
        );
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(true);

        const score = scoreAnalysis(manifest, 'FormValidationService', analysis);

        // ── Negative: phantom subdocument names must NOT appear ──────
        expect(
            score.negativeViolations,
            `Negative violations found — phantom subdocument names in LLM output: ` +
            `${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        console.log(`[Pattern Eval] Extracted infra:`, JSON.stringify(score.extractedByType, null, 2));
    });
});
