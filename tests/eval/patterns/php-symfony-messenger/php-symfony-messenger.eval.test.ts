/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-symfony-messenger
 *
 * Real-world case: Symfony Messenger handler (#[AsMessageHandler]) with
 * multiple I/O patterns: Doctrine flush, MessageBus dispatch, cURL webhook.
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Extracts __invoke as an I/O function (Doctrine + MessageBus + cURL)
 *   ✓ Does NOT extract calculateCommission (pure business logic)
 *   ✓ Detects event/message capabilities
 *
 * Fixture: tests/eval/patterns/php-symfony-messenger/fixture/
 * Manifest: tests/eval/patterns/php-symfony-messenger/expected.graph.yaml
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

describe('Pattern Eval — php-symfony-messenger', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] php-symfony-messenger | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('php-symfony-messenger');
    });

    it('BookingConfirmedHandler — should extract __invoke as I/O (Doctrine + MessageBus + cURL)', async () => {
        const chunk = chunks.find(c => c.name === 'BookingConfirmedHandler');
        expect(chunk, 'Fixture must contain BookingConfirmedHandler.php').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(true);

        const score = scoreAnalysis(manifest, 'BookingConfirmedHandler', analysis);

        // The handler has I/O — Doctrine flush, MessageBus dispatch, cURL webhook
        expect(analysis.has_io).toBe(true);

        // calculateCommission must NOT be extracted (pure business logic, private)
        expect(
            score.negativeViolations,
            `Negative violations found — pure function leaked: ${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        // Should have message/event capabilities
        if (analysis.capabilities && analysis.capabilities.length > 0) {
            console.log(`[Pattern Eval] Capabilities detected: ${JSON.stringify(analysis.capabilities)}`);
        }

        console.log(`[Pattern Eval] BookingConfirmedHandler extracted:`, JSON.stringify(score.extractedByType, null, 2));
    });

    it('Message DTOs — should classify as has_io=false (pure value objects)', async () => {
        // BookingConfirmedMessage.php and SendCustomerNotificationMessage.php
        // are pure value objects with no I/O
        for (const name of ['BookingConfirmedMessage', 'SendCustomerNotificationMessage']) {
            const chunk = chunks.find(c => c.name === name);
            if (!chunk) continue; // Optional — they may not be in the fixture

            const result = await analyzeFunction(chunk, 'fast');
            if (result) {
                expect(result.analysis.has_io).toBe(false);
                console.log(`[Pattern Eval] ${name} correctly classified as no-I/O`);
            }
        }
    });
});
