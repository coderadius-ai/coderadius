/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-outbox-publish
 *
 * Transactional Outbox pattern: a NestJS service publishes events via an
 * outbox SDK (outboxService.publish()). The LLM must recognize this as a
 * MessageChannel operation, not just a database write.
 *
 * With the custom domain hint in coderadius.yaml, the pipeline should:
 *   1. Extract the topic config key (orderCreatedTopic) as a MessageChannel
 *   2. NOT classify the class name (OrderPublisher) as a channel
 *   3. NOT classify the DI token (OUTBOX_SERVICE) as a channel
 *
 * This test validates the hint-driven approach to supporting custom SDK
 * patterns without hardcoding client-specific logic in the core.
 *
 * Fixture: tests/eval/patterns/ts-outbox-publish/fixture/
 * Manifest: tests/eval/patterns/ts-outbox-publish/expected.graph.yaml
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

// Custom domain knowledge hint — simulates what coderadius.yaml would inject
const OUTBOX_HINT = `
--- Custom Domain Knowledge (from coderadius.yaml) ---
The following describes proprietary SDKs and wrappers used in this codebase.
Apply these rules when you encounter the listed patterns:
- Patterns [outboxService, OutboxService]: Transactional Outbox SDK for a message broker. outboxService.publish() is a MESSAGE BROKER PUBLISH. The first argument is the topic config key. Emit a MessageChannel entry with the exact config key identifier as the name. For this.topicConfig.orderCreatedTopic, the name is exactly orderCreatedTopic. Do not normalize it to order-created/order.created or infer a physical topic. Set operation=WRITES, channelKind=topic.
--- End Custom Domain Knowledge ---`;

describe('Pattern Eval — ts-outbox-publish', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-outbox-publish | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-outbox-publish');
    });

    it('OrderPublisher.publishOrderCreated — should extract topic config key as MessageChannel', async () => {
        const chunk = chunks.find(c => c.name === 'OrderPublisher' || /\bclass\s+OrderPublisher\b/.test(c.sourceCode));
        expect(chunk, 'Fixture must contain OrderPublisher class').toBeDefined();

        // Inject the custom domain hint to simulate coderadius.yaml
        const result = await analyzeFunction(chunk!, 'fast', undefined, undefined, OUTBOX_HINT);
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;

        // ── Core: must have I/O (outbox publish) ─────────────────────
        expect(analysis.has_io).toBe(true);

        // ── Score against manifest ───────────────────────────────────
        const score = scoreAnalysis(manifest, 'publishOrderCreated', analysis);

        // Expected: MessageChannel with topic config key
        const hasTopicChannel = score.truePositives.some(tp =>
            tp.includes('orderCreatedTopic'),
        );
        expect(
            hasTopicChannel,
            `Expected MessageChannel with 'orderCreatedTopic' in true positives, ` +
            `got: ${JSON.stringify(score.truePositives)}. ` +
            `Extracted infra: ${JSON.stringify(score.extractedByType)}`,
        ).toBe(true);

        // ── Negative assertions: class/DI names must NOT become channels ──
        expect(
            score.negativeViolations,
            `Negative violations found — LLM extracted code identifiers as MessageChannels: ` +
            `${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        // ── Extra: verify extracted infra contains MessageChannel type ─────
        const messageChannels = analysis.infrastructure.filter(
            i => i.type.toLowerCase().includes('message') || i.type.toLowerCase().includes('channel'),
        );
        const channelNames = messageChannels.map(mc => mc.name);
        console.log(`[Pattern Eval] Extracted MessageChannels: ${JSON.stringify(channelNames)}`);

        // The topic config key MUST appear somewhere in the extracted channels
        expect(
            channelNames.some(n =>
                n.toLowerCase().includes('ordercreatedtopic') ||
                n.toLowerCase().includes('order_created_topic') ||
                n.toLowerCase().includes('order-created'),
            ),
            `Expected topic config key in extracted MessageChannels, ` +
            `got: ${JSON.stringify(channelNames)}`,
        ).toBe(true);
    });
});
