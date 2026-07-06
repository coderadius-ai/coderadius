import { describe, it, expect, afterEach } from 'vitest';
import type Parser from 'tree-sitter';
import { TypeScriptPlugin } from '../../../../../src/ingestion/core/languages/typescript.js';
import {
    extractTypeScriptFrameworkSignals,
    registerCustomMessageConsumerDecorator,
    clearCustomMessageConsumerDecorators,
} from '../../../../../src/ingestion/core/languages/typescript/framework-signals.js';
import { matchFrameworkSignalsToChunk } from '../../../../../src/ingestion/core/framework-signal-overlay.js';

// ═════════════════════════════════════════════════════════════════════════════
// Custom Message Consumer Decorator Registration — Unit Tests
//
// Tests the decorators configuration feature:
//   1. registerCustomMessageConsumerDecorator() registers a decorator
//   2. extractTypeScriptFrameworkSignals() detects it in source
//   3. clearCustomMessageConsumerDecorators() removes all registrations
// ═════════════════════════════════════════════════════════════════════════════

const plugin = new TypeScriptPlugin();
const parser = plugin.createParser();

function parseRoot(source: string): Parser.SyntaxNode {
    return parser.parse(source).rootNode;
}

afterEach(() => {
    // Always clean up so tests don't leak registrations
    clearCustomMessageConsumerDecorators();
});

describe('registerCustomMessageConsumerDecorator + clear', () => {
    it('should detect a custom decorator after registration', () => {
        registerCustomMessageConsumerDecorator('MessageConsumer');

        const source = `
export class PaymentConsumer {
    @MessageConsumer('order.created.save.ready')
    async handleSave(msg: any) {
    }
}
`;
        const signals = extractTypeScriptFrameworkSignals(parseRoot(source), source, 'test.ts');
        const consumerSignals = signals.filter(s => s.kind === 'message-consumer');
        expect(consumerSignals.length).toBeGreaterThanOrEqual(1);
        // The signal should capture the routing key from the decorator
        const routingSignal = consumerSignals.find(s => s.resolvedName === 'order.created.save.ready');
        expect(routingSignal).toBeDefined();
    });

    it('should NOT detect MessageConsumer when not registered', () => {
        // No registration — the decorator should be ignored
        const source = `
export class PaymentConsumer {
    @MessageConsumer('order.created.save.ready')
    async handleSave(msg: any) {}
}
`;
        const signals = extractTypeScriptFrameworkSignals(parseRoot(source), source, 'test.ts');
        const consumerSignals = signals.filter(s => s.kind === 'message-consumer');
        expect(consumerSignals).toHaveLength(0);
    });

    it('should clear all custom decorators', () => {
        registerCustomMessageConsumerDecorator('MessageConsumer');
        registerCustomMessageConsumerDecorator('CustomBroker');

        clearCustomMessageConsumerDecorators();

        const source = `
export class TestConsumer {
    @MessageConsumer('test.topic')
    async handle(msg: any) {}
}
`;
        const signals = extractTypeScriptFrameworkSignals(parseRoot(source), source, 'test.ts');
        const consumerSignals = signals.filter(s => s.kind === 'message-consumer');
        expect(consumerSignals).toHaveLength(0);
    });

    it('should support custom arg keys via object literal', () => {
        registerCustomMessageConsumerDecorator('MyConsumer', ['queue', 'exchange']);

        const source = `
export class TestConsumer {
    @MyConsumer({ queue: 'order-events', exchange: 'main' })
    async handle(msg: any) {
    }
}
`;
        const signals = extractTypeScriptFrameworkSignals(parseRoot(source), source, 'test.ts');
        const consumerSignals = signals.filter(s => s.kind === 'message-consumer');
        expect(consumerSignals.length).toBeGreaterThanOrEqual(1);
        expect(consumerSignals[0].resolvedName).toBe('order-events');
    });

    it('should detect a class-level custom decorator with object args', () => {
        registerCustomMessageConsumerDecorator('CustomConsumer', ['routingKey', 'queue', 'name', 'topic']);
        const source = `
@CustomConsumer({ routingKey: 'domain.events.entity-updated', queue: 'consumer_queue' })
export class EntityUpdateConsumer {
    async handleEvent(event: any) {
        return this.useCase(event);
    }
}`;
        const signals = extractTypeScriptFrameworkSignals(parseRoot(source), source, 'test.ts');
        const consumerSignals = signals.filter(s => s.kind === 'message-consumer');
        expect(consumerSignals).toHaveLength(1);
        expect(consumerSignals[0].resolvedName).toBe('domain.events.entity-updated');
        expect(consumerSignals[0].scope).toBe('class');
    });

    it('class-level consumer overlay applies to handleEvent', () => {
        registerCustomMessageConsumerDecorator('CustomConsumer', ['routingKey', 'queue']);
        const source = `
@CustomConsumer({ routingKey: 'domain.events.entity-updated', queue: 'consumer_queue' })
export class EntityUpdateConsumer {
    async handleEvent(event: any) {}
}`;
        const signals = extractTypeScriptFrameworkSignals(parseRoot(source), source, 'test.ts');
        const matched = matchFrameworkSignalsToChunk('EntityUpdateConsumer.handleEvent', signals);
        expect(matched).toHaveLength(1);
        expect(matched[0].kind).toBe('message-consumer');
    });

    it('class-level consumer overlay does NOT apply to constructor or helpers', () => {
        registerCustomMessageConsumerDecorator('CustomConsumer', ['routingKey', 'queue']);
        const source = `
@CustomConsumer({ routingKey: 'domain.events.entity-updated', queue: 'consumer_queue' })
export class EntityUpdateConsumer {
    constructor() {}
    async logFailure() {}
}`;
        const signals = extractTypeScriptFrameworkSignals(parseRoot(source), source, 'test.ts');
        expect(matchFrameworkSignalsToChunk('EntityUpdateConsumer.constructor', signals)).toHaveLength(0);
        expect(matchFrameworkSignalsToChunk('EntityUpdateConsumer.logFailure', signals)).toHaveLength(0);
    });

    it('class-level consumer overlay applies to __invoke (PHP pattern)', () => {
        registerCustomMessageConsumerDecorator('CustomConsumer', ['routingKey']);
        const source = `
@CustomConsumer({ routingKey: 'domain.events.entity-updated' })
export class EntityUpdateConsumer {
    async __invoke(event: any) {}
}`;
        const signals = extractTypeScriptFrameworkSignals(parseRoot(source), source, 'test.ts');
        const matched = matchFrameworkSignalsToChunk('EntityUpdateConsumer.__invoke', signals);
        expect(matched).toHaveLength(1);
        expect(matched[0].kind).toBe('message-consumer');
    });
});
