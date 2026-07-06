import { describe, it, expect } from 'vitest';
import { sanitizeAnalysis } from '../../../src/ai/workflows/sanitizer.js';
import type { UnifiedAnalysis } from '../../../src/ai/agents/unified-analyzer.js';

// ═════════════════════════════════════════════════════════════════════════════
// Sanitizer — MessageChannel regression guards (must NOT drop legitimate names)
//
// The new false-positive rules (Mongo collection, SQL INSERT, SFTP send,
// internal-arg suffix, middle-concat template) MUST NOT regress on shapes
// that the audit team confirmed as legitimate broker channels.
// ═════════════════════════════════════════════════════════════════════════════

function makeAnalysis(infra: any): UnifiedAnalysis {
    return {
        has_io: true,
        intent: 'test',
        infrastructure: [infra],
        capabilities: [],
        produced_payloads: [],
        consumed_payloads: [],
    } as UnifiedAnalysis;
}

describe('Sanitizer — MessageChannel regression positives', () => {
    it('keeps snake_case Kafka topic that resembles a SQL table (no actual SQL in source)', () => {
        const analysis = makeAnalysis({
            name: 'order_events',
            type: 'MessageChannel',
            operation: 'WRITES',
            channelKind: 'topic',
            evidence: 'kafka produce',
        });
        const sourceCode = "this.kafkaProducer.send('order_events', payload);";
        const result = sanitizeAnalysis(analysis, { sourceCode });
        expect(result.infrastructure ?? []).toHaveLength(1);
        expect(result.infrastructure![0].type).toBe('MessageChannel');
        expect(result.infrastructure![0].name).toBe('order_events');
    });

    it('keeps `outbox` as a Kafka channel when no INSERT INTO is in the source', () => {
        // The transactional-outbox reclassification only fires on name shapes
        // matching `_outbox` / `outbox_` / endsWith('outbox') (existing rule).
        // A bare topic literally named 'outbox' passing through publish() is
        // a legitimate channel name when the source has no SQL write context.
        const analysis = makeAnalysis({
            name: 'orders.outbound',
            type: 'MessageChannel',
            operation: 'WRITES',
            channelKind: 'topic',
            evidence: 'kafka produce to outbound',
        });
        const sourceCode = "this.kafkaProducer.send('orders.outbound', payload);";
        const result = sanitizeAnalysis(analysis, { sourceCode });
        expect(result.infrastructure ?? []).toHaveLength(1);
        expect(result.infrastructure![0].type).toBe('MessageChannel');
    });

    it('keeps dotted routing keys like user.activity.log', () => {
        const analysis = makeAnalysis({
            name: 'user.activity.log',
            type: 'MessageChannel',
            operation: 'WRITES',
            channelKind: 'topic',
            evidence: 'amqp publish',
        });
        const sourceCode = "$this->amqpChannel->basic_publish($msg, 'audit', 'user.activity.log');";
        const result = sanitizeAnalysis(analysis, { sourceCode });
        expect(result.infrastructure ?? []).toHaveLength(1);
        expect(result.infrastructure![0].name).toBe('user.activity.log');
    });

    it('keeps a queue named `notifications`', () => {
        const analysis = makeAnalysis({
            name: 'notifications',
            type: 'MessageChannel',
            operation: 'READS',
            channelKind: 'queue',
            evidence: 'consumer subscribe',
        });
        const sourceCode = "this.consumer.subscribe('notifications');";
        const result = sanitizeAnalysis(analysis, { sourceCode });
        expect(result.infrastructure ?? []).toHaveLength(1);
        expect(result.infrastructure![0].name).toBe('notifications');
    });
});
