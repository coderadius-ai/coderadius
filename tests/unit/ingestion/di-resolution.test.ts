import { describe, it, expect } from 'vitest';

// ═════════════════════════════════════════════════════════════════════════════
// DI Resolution — Unit Tests
//
// Tests the DI resolution logic added to the sanitizer:
//   - normalizeBrokerName() suffix stripping
//   - DI_BROKER_SUFFIXES deterministic isDiKey backup
//   - sanitizeAnalysis() with SymbolRegistry integration
//   - resolved_via tagging
// ═════════════════════════════════════════════════════════════════════════════

import {
    normalizeBrokerName,
    isNoisyBrokerName,
    sanitizeAnalysis,
} from '../../../src/ai/workflows/sanitizer.js';
import { SymbolRegistry } from '../../../src/ingestion/core/symbol-registry.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

type Infra = { name: string; type: string; operation: string; isDiKey?: boolean; evidence?: string };

function makeAnalysis(infra: Infra[]) {
    return {
        has_io: true,
        intent: 'test',
        infrastructure: infra as any,
        capabilities: [],
        emergent_api_calls: [],
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// normalizeBrokerName — Suffix Stripping
// ═════════════════════════════════════════════════════════════════════════════

describe('normalizeBrokerName', () => {
    it('should strip .publisher suffix', () => {
        expect(normalizeBrokerName('notpurchasable.publisher')).toBe('notpurchasable');
    });

    it('should strip .consumer suffix', () => {
        expect(normalizeBrokerName('billing.consumer')).toBe('billing');
    });

    it('should strip .sender suffix', () => {
        expect(normalizeBrokerName('notification.sender')).toBe('notification');
    });

    it('should strip .receiver suffix', () => {
        expect(normalizeBrokerName('payment.receiver')).toBe('payment');
    });

    it('should strip .producer suffix', () => {
        expect(normalizeBrokerName('analytics.producer')).toBe('analytics');
    });

    it('should strip .subscriber suffix', () => {
        expect(normalizeBrokerName('events.subscriber')).toBe('events');
    });

    it('should strip .handler suffix', () => {
        expect(normalizeBrokerName('order.handler')).toBe('order');
    });

    it('should strip .emitter suffix', () => {
        expect(normalizeBrokerName('audit.emitter')).toBe('audit');
    });

    it('should strip .listener suffix', () => {
        expect(normalizeBrokerName('webhook.listener')).toBe('webhook');
    });

    it('should strip .writer suffix', () => {
        expect(normalizeBrokerName('log.writer')).toBe('log');
    });

    it('should strip .reader suffix', () => {
        expect(normalizeBrokerName('data.reader')).toBe('data');
    });

    it('should strip .client suffix', () => {
        expect(normalizeBrokerName('queue.client')).toBe('queue');
    });

    it('should be case-insensitive', () => {
        expect(normalizeBrokerName('billing.Publisher')).toBe('billing');
        expect(normalizeBrokerName('order.CONSUMER')).toBe('order');
    });

    it('should NOT strip non-DI suffixes', () => {
        expect(normalizeBrokerName('order.events')).toBe('order.events');
        expect(normalizeBrokerName('payment.completed')).toBe('payment.completed');
        expect(normalizeBrokerName('user.created')).toBe('user.created');
    });

    it('should NOT strip suffixes from names without dot notation', () => {
        expect(normalizeBrokerName('publisher')).toBe('publisher');
        expect(normalizeBrokerName('NotificationPublisher')).toBe('NotificationPublisher');
    });

    it('should handle compound DI keys with multiple dots', () => {
        expect(normalizeBrokerName('app.messaging.event.publisher')).toBe('app.messaging.event');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// DI_BROKER_SUFFIXES — DI Service Identifier Detection
//
// Names ending in DI suffixes (.publisher, .consumer, etc.) without a
// SymbolRegistry binding are service object references, not routing keys.
// We don't know what topic/queue they actually publish to → drop the ghost
// instead of inventing a bare logical name.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — DI service identifier without registry binding is dropped', () => {

    it('should drop .publisher without registry binding', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'notpurchasable.publisher', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should drop .consumer without registry binding', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'billing.consumer', type: 'MessageChannel', operation: 'READS' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should drop .sender without registry binding', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'email.sender', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should NOT touch non-DI broker names', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'order.created', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('order.created');
        expect((result.infrastructure[0] as any).resolved_via).toBeUndefined();
    });

    it('should NOT touch physical topic names like payment.completed', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'payment.completed', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('payment.completed');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis — SymbolRegistry Integration
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — SymbolRegistry resolution', () => {

    it('should resolve a DI key via SymbolRegistry (isDiKey=true)', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'notpurchasable.publisher',
            value: 'acme.payment.received',
            category: 'di_service',
            sourceFile: 'config/services.yaml',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'notpurchasable.publisher', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('acme.payment.received');
        expect((result.infrastructure[0] as any).resolved_via).toBe('di_registry');
    });

    it('should resolve a DI key via SymbolRegistry (auto-detected suffix)', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'billing.sender',
            value: 'billing.invoice.created',
            category: 'di_service',
            sourceFile: 'config/rabbitmq.php',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'billing.sender', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('billing.invoice.created');
        expect((result.infrastructure[0] as any).resolved_via).toBe('di_registry');
    });

    it('should drop unresolved DI service identifier when registry has no match', () => {
        // 'warehouse.publisher' looks like a DI service ID but registry doesn't know
        // what physical topic/queue it actually publishes to. We can't invent
        // 'warehouse' as a channel name — the publisher's target is opaque to us
        // statically. Drop it; the publisher function still exists in the graph.
        const registry = new SymbolRegistry();

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'warehouse.publisher', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(0);
    });

    it('should drop post-resolution name if it becomes noisy', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'bus.publisher',
            value: 'bus',
            category: 'di_service',
            sourceFile: 'config.php',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'bus.publisher', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        // 'bus' is in NOISY_BROKER_NAMES, so it should be dropped
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should NOT drop valid PascalCase topics (AcmeBus) if resolved via DI', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'this.DATABACKBONE.QUOTE_REQUEST',
            value: 'QuoteRequest',
            category: 'di_service',
            sourceFile: 'AcmeBus.service.ts',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'this.DATABACKBONE.QUOTE_REQUEST', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('QuoteRequest');
    });

    it('should drop post-normalization name if it becomes noisy', () => {
        // After stripping .publisher, we get 'queue' which is noisy
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'queue.publisher', type: 'MessageChannel', operation: 'WRITES' },
        ]));

        expect(result.infrastructure).toHaveLength(0);
    });

    it('should NOT touch non-MessageChannel infrastructure', () => {
        const registry = new SymbolRegistry();

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'users', type: 'Database', operation: 'READS', evidence: 'SELECT * FROM users' },
        ]), { sourceCode: 'SELECT * FROM users WHERE id = :id', symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('users');
        expect((result.infrastructure[0] as any).resolved_via).toBeUndefined();
    });

    it('should resolve class constant broker names when a literal constant map is provided', () => {
        const result = sanitizeAnalysis(
            makeAnalysis([
                { name: 'SystemEventService.EVENT_NAME', type: 'MessageChannel', operation: 'WRITES' },
            ]),
            { resolvedConstants: [{ key: 'SystemEventService.EVENT_NAME', value: '"system.event.created"' }] },
        );

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('system.event.created');
    });
});



// ═════════════════════════════════════════════════════════════════════════════
// Regression: Config-property names (evtTopicSave) without isDiKey flag
//
// The LLM extracts config property names like `evtTopicSave` from code like
// `this.evtConfig.evtTopicSave`, but does NOT set isDiKey=true. These names
// must still be resolved via the SymbolRegistry before the noisy broker filter
// drops them as pureCamelCase.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — config-property registry resolution (no isDiKey)', () => {

    it('should resolve evtTopicSave → QuoteRequest via SymbolRegistry even without isDiKey', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'evtTopicSave',
            value: 'QuoteRequest',
            category: 'di_service',
            sourceFile: 'EventBus.config.ts',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'evtTopicSave', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('QuoteRequest');
        expect((result.infrastructure[0] as any).resolved_via).toBe('di_registry');
    });

    it('should resolve evtTopicShipmentBundleV2 → ShipmentProposal via SymbolRegistry even without isDiKey', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'evtTopicShipmentBundleV2',
            value: 'ShipmentProposal',
            category: 'di_service',
            sourceFile: 'EventBus.config.ts',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'evtTopicShipmentBundleV2', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('ShipmentProposal');
        expect((result.infrastructure[0] as any).resolved_via).toBe('di_registry');
    });

    it('should still drop pureCamelCase names NOT in registry', () => {
        const registry = new SymbolRegistry();

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'evtTopicSave', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        // No registry match → isDi remains false → pureCamelCase → DROP
        expect(result.infrastructure).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Regression: Existing broker filter tests still pass
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — broker filter regression', () => {

    it('should still DROP class-suffix broker names like RabbitMQClient', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'RabbitMQClient', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should still DROP this.xxx broker patterns', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'this.config.topicName', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should still DROP generic noisy names like messagebus', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'messagebus', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(0);
    });

    it('should KEEP legitimate physical topic names', () => {
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'order.created', type: 'MessageChannel', operation: 'WRITES' },
            { name: 'payment-completed', type: 'MessageChannel', operation: 'WRITES' },
            { name: 'notification-events', type: 'MessageChannel', operation: 'WRITES' },
        ]));
        expect(result.infrastructure).toHaveLength(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fix 1.8: Snake-case → PascalCase DI Registry Fallback
//
// The LLM converts PHP message class names to snake_case:
//   ProductQuoteMessage → product_quote_message
//   SaveUpdatedMessage → save_updated_message
//
// The SymbolRegistry has the binding under the PascalCase key:
//   ProductQuoteMessage → acme.inventory.quote.product.requested
//
// The sanitizer should try the inverse transformation when the snake_case
// name doesn't match the registry but the PascalCase version does.
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeAnalysis — snake→PascalCase DI resolution fallback', () => {

    it('should resolve product_quote_message → ProductQuoteMessage → physical routing key', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'ProductQuoteMessage',
            value: 'acme.inventory.quote.product.requested',
            category: 'di_service',
            sourceFile: 'classes/Inventory/Messenger/AmqpConfig.php',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'product_quote_message', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('acme.inventory.quote.product.requested');
    });

    it('should resolve save_updated_message → SaveUpdatedMessage → physical routing key', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'SaveUpdatedMessage',
            value: 'shop.order.save.updated',
            category: 'di_service',
            sourceFile: 'classes/Inventory/Messenger/AmqpConfig.php',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'save_updated_message', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('shop.order.save.updated');
    });

    it('should NOT transform snake_case if PascalCase is also not in registry', () => {
        const registry = new SymbolRegistry();

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'some_unknown_message', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        // Name survives as-is (no registry match either way)
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0].name).toBe('some_unknown_message');
    });

    it('should NOT transform names without underscores', () => {
        const registry = new SymbolRegistry();
        registry.register({
            key: 'OrderCreated',
            value: 'order.created.v2',
            category: 'di_service',
            sourceFile: 'config.php',
            confidence: 'static',
        });

        // 'ordercreated' is lowercase-no-separator → should NOT try snake→pascal
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'ordercreated', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        // This should be unchanged (no underscore → no snake→pascal attempt)
        expect(result.infrastructure[0].name).toBe('ordercreated');
    });

    it('should NOT transform mixed names with dots and underscores', () => {
        // The snake→pascal fallback is for pure snake_case PHP message classes
        // (e.g. product_quote_message → ProductQuoteMessage). Mixed names like
        // 'acme.order_created' (contains both '.' and '_') would split on '_'
        // producing nonsense like 'Acme.orderCreated' — guaranteed registry miss
        // and a wasted lookup. Guard prevents the spurious attempt.
        const registry = new SymbolRegistry();
        registry.register({
            key: 'Acme.orderCreated',  // Even if registry pathologically had this
            value: 'should.not.match',
            category: 'di_service',
            sourceFile: 'config.php',
            confidence: 'static',
        });

        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'acme.order_created', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });

        // Name passes through unchanged — guard skipped the snake→pascal attempt
        expect(result.infrastructure[0].name).toBe('acme.order_created');
    });

    it('should NOT transform kebab+snake names', () => {
        const registry = new SymbolRegistry();
        const result = sanitizeAnalysis(makeAnalysis([
            { name: 'foo-bar_baz', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });
        expect(result.infrastructure[0].name).toBe('foo-bar_baz');
    });

    it('should NOT transform names with leading/trailing underscores', () => {
        const registry = new SymbolRegistry();
        const result = sanitizeAnalysis(makeAnalysis([
            { name: '_leading_underscore', type: 'MessageChannel', operation: 'WRITES' },
        ]), { symbolRegistry: registry });
        expect(result.infrastructure[0].name).toBe('_leading_underscore');
    });
});

