/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-rabbitmq-consumer
 *
 * Real-world case: PHP RabbitMQ consumer (NotificationConsumer) with explicit
 * queue/exchange binding, and GCP PubSub publisher (PubSubPublisher).
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Extracts physical queue/exchange names (orders_exchange, notification-events)
 *   ✓ Detects PDO database access (users table)
 *   ✓ Does NOT extract class names as MessageChannel names
 *   ✓ Detects PubSub topic/subscription correctly
 *
 * Fixture: tests/eval/patterns/php-rabbitmq-consumer/fixture/
 * Manifest: tests/eval/patterns/php-rabbitmq-consumer/expected.graph.yaml
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

describe('Pattern Eval — php-rabbitmq-consumer', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] php-rabbitmq-consumer | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('php-rabbitmq-consumer');
    });

    it('NotificationConsumer — should extract physical queue/exchange names and DB access', async () => {
        const chunk = chunks.find(c => c.name === 'NotificationConsumer');
        expect(chunk, 'Fixture must contain NotificationConsumer.php').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(true);

        const score = scoreAnalysis(manifest, 'NotificationConsumer', analysis);

        // Should detect PDO access to users table
        const hasUsersTable = score.truePositives.some(tp =>
            tp.includes('users'),
        );
        expect(
            hasUsersTable,
            `Expected 'users' DataContainer in true positives: ${JSON.stringify(score.truePositives)}`,
        ).toBe(true);

        // Should extract at least one message broker / queue / exchange name
        // The LLM may name it as orders_exchange, order_notifications, order.created, etc.
        const messageChannels = analysis.infrastructure.filter(
            i => i.type.toLowerCase().includes('message') || i.type.toLowerCase().includes('channel')
                || i.type.toLowerCase().includes('queue') || i.type.toLowerCase().includes('exchange'),
        );
        expect(
            messageChannels.length,
            `Expected at least one MessageChannel/Queue from RabbitMQ binding, got: ${JSON.stringify(analysis.infrastructure)}`,
        ).toBeGreaterThan(0);

        // Must NOT have class names as MessageChannel
        expect(
            score.negativeViolations,
            `Negative violations — class names as MessageChannel: ${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        console.log(`[Pattern Eval] NotificationConsumer extracted:`, JSON.stringify(score.extractedByType, null, 2));
    });

    it('PubSubPublisher — should extract GCP PubSub topic name', async () => {
        const chunk = chunks.find(c => c.name === 'PubSubPublisher');
        expect(chunk, 'Fixture must contain PubSubPublisher.php').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();

        const analysis = result!.analysis;
        expect(analysis.has_io).toBe(true);

        const score = scoreAnalysis(manifest, 'PubSubPublisher', analysis);

        // Should extract the physical topic name (notification-events)
        const hasTopic = score.truePositives.some(tp =>
            tp.includes('notification-events'),
        );
        expect(
            hasTopic,
            `Expected 'notification-events' in true positives: ${JSON.stringify(score.truePositives)}`,
        ).toBe(true);

        // Must NOT have PascalCase class names as MessageChannel
        expect(
            score.negativeViolations,
            `Negative violations — PascalCase as MessageChannel: ${JSON.stringify(score.negativeViolations, null, 2)}`,
        ).toHaveLength(0);

        console.log(`[Pattern Eval] PubSubPublisher extracted:`, JSON.stringify(score.extractedByType, null, 2));
    });
});
