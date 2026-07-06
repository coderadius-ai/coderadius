import { describe, it, expect } from 'vitest';
import { PHPPlugin } from '../../../src/ingestion/core/languages/php.js';
import { TypeScriptPlugin } from '../../../src/ingestion/core/languages/typescript.js';
import { sanitizeAnalysis } from '../../../src/ai/workflows/sanitizer.js';
import type { UnifiedAnalysis } from '../../../src/ai/agents/unified-analyzer.js';

// ═════════════════════════════════════════════════════════════════════════════
// Sanitizer — technology hallucination scrub
//
// The LLM occasionally emits a physical technology label (pubsub, kafka,
// rabbitmq, sqs, ...) on a MessageChannel when the source code contains
// NONE of the corresponding library imports / class markers. This produces
// noise like `NotPurchasableEvent.technology = pubsub` on a Symfony repo
// that never imports any Pub/Sub SDK.
//
// Rule: if `technology` ∈ {pubsub|kafka|rabbitmq|sqs|sns|azure-service-bus|nats}
// AND none of the TECH_SIGNALS regexes match the source, strip the field.
// Fix 3 (channel-technology-welder) will recover it later from broker.provider.
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

describe('Sanitizer — technology hallucination scrub', () => {
    it('strips technology=pubsub when source has no Pub/Sub markers', () => {
        const analysis = makeAnalysis({
            name: 'OrderPlacedEvent',
            type: 'MessageChannel',
            operation: 'WRITES',
            channelKind: 'topic',
            technology: 'pubsub',
            evidence: 'symfony dispatch',
        });
        const sourceCode = "$this->messageBus->dispatch(new OrderPlacedEvent($id));";
        const result = sanitizeAnalysis(analysis, { sourceCode });
        const surviving = result.infrastructure ?? [];
        expect(surviving).toHaveLength(1);
        // The CQRS message name survives but the hallucinated tech is gone.
        expect((surviving[0] as any).technology).toBeUndefined();
    });

    it('keeps technology=pubsub when source actually imports the Pub/Sub SDK', () => {
        const analysis = makeAnalysis({
            name: 'orders.created',
            type: 'MessageChannel',
            operation: 'WRITES',
            channelKind: 'topic',
            technology: 'pubsub',
            evidence: 'pubsub publish',
        });
        const sourceCode = "import { PubSub } from '@google-cloud/pubsub';\nconst pubsub = new PubSub();\npubsub.topic('orders.created').publish(data);";
        const result = sanitizeAnalysis(analysis, { sourceCode, plugin: new TypeScriptPlugin() });
        const surviving = result.infrastructure ?? [];
        expect(surviving).toHaveLength(1);
        expect((surviving[0] as any).technology).toBe('pubsub');
    });

    it('keeps technology=rabbitmq when source imports PhpAmqpLib', () => {
        const analysis = makeAnalysis({
            name: 'order.created',
            type: 'MessageChannel',
            operation: 'WRITES',
            channelKind: 'topic',
            technology: 'rabbitmq',
            evidence: 'amqp publish',
        });
        const sourceCode = "use PhpAmqpLib\\Connection\\AMQPStreamConnection;\n$conn = new AMQPStreamConnection(...);";
        const result = sanitizeAnalysis(analysis, { sourceCode, plugin: new PHPPlugin() });
        const surviving = result.infrastructure ?? [];
        expect(surviving).toHaveLength(1);
        expect((surviving[0] as any).technology).toBe('rabbitmq');
    });

    it('leaves symfony-messenger technology alone (not in the physical-tech whitelist)', () => {
        // Abstract bus technologies are NOT scrubbed — they correctly indicate
        // a meta-broker (Fix 3 welder will refine to the physical provider
        // when carried_by edges resolve).
        const analysis = makeAnalysis({
            name: 'OrderEvent',
            type: 'MessageChannel',
            operation: 'WRITES',
            channelKind: 'topic',
            technology: 'symfony-messenger',
            evidence: 'dispatch',
        });
        const sourceCode = "$this->messageBus->dispatch(new OrderEvent($id));";
        const result = sanitizeAnalysis(analysis, { sourceCode });
        const surviving = result.infrastructure ?? [];
        expect(surviving).toHaveLength(1);
        expect((surviving[0] as any).technology).toBe('symfony-messenger');
    });
});
