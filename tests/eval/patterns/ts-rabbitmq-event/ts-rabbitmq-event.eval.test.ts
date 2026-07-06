/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-rabbitmq-event
 *
 * Real-world case: NestJS service with a static readonly class constant used
 * as event name via `emitEvent()`. The LLM must extract the physical topic
 * name from the constant (`system.event.created`), NOT the
 * class name (`SystemEventService`) or method name (`emitEvent`).
 *
 * Bug origin: LLM was extracting code identifiers as MessageChannel names.
 *
 * Fixture: tests/fixtures/ts-rabbitmq-event/
 * Manifest: tests/fixtures/ts-rabbitmq-event/expected.graph.yaml
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

describe('Pattern Eval — ts-rabbitmq-event', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-rabbitmq-event | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-rabbitmq-event');
    });

    it('SystemEventService.emit — should extract physical topic name, not class name', async () => {
        const chunk = chunks.find(c => c.name === 'SystemEventService');
        expect(chunk, 'Fixture must contain SystemEventService.ts').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;

        // ── Core: must have I/O (event emission) ─────────────────────
        expect(analysis.has_io).toBe(true);

        // ── Score against manifest ───────────────────────────────────
        const score = scoreAnalysis(manifest, 'emit', analysis);

        // Expected: MessageChannel:system.event.created
        const hasCorrectChannel = score.truePositives.some(tp =>
            tp.includes('system.event.created'),
        );
        expect(
            hasCorrectChannel,
            `Expected MessageChannel 'system.event.created' in true positives, ` +
            `got: ${JSON.stringify(score.truePositives)}. ` +
            `Extracted infra: ${JSON.stringify(score.extractedByType)}`,
        ).toBe(true);

        // ── Negative assertions: class/method names must NOT become channels ──
        expect(
            score.negativeViolations,
            `Negative violations found — LLM extracted code identifiers as MessageChannels: ` +
            `${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        // ── Extra: verify extracted infra contains the right type ─────
        const messageChannels = analysis.infrastructure.filter(
            i => i.type.toLowerCase().includes('message') || i.type.toLowerCase().includes('channel'),
        );
        const channelNames = messageChannels.map(mc => mc.name);
        console.log(`[Pattern Eval] Extracted MessageChannels: ${JSON.stringify(channelNames)}`);

        // The physical topic MUST appear somewhere in the extracted channels
        expect(
            channelNames.some(n => n.includes('system.event.created')),
            `Expected 'system.event.created' in extracted MessageChannels, ` +
            `got: ${JSON.stringify(channelNames)}`,
        ).toBe(true);
    });
});
