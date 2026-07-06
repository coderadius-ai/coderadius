import { describe, it, expect } from 'vitest';
import { SymbolRegistry } from '../../../src/ingestion/core/symbol-registry.js';

// ═════════════════════════════════════════════════════════════════════════════
// SymbolRegistry — Unit Tests
//
// Tests the priority-aware global symbol table that holds DI service-to-physical
// infrastructure bindings. Validates CRUD, priority resolution, and cache
// serialization.
// ═════════════════════════════════════════════════════════════════════════════

describe('SymbolRegistry', () => {

    // ─── Basic Registration & Resolution ──────────────────────────────────

    it('should register and resolve a binding', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'notpurchasable.publisher',
            value: 'acme.payment.received',
            category: 'di_service',
            sourceFile: 'config/services.yaml',
            confidence: 'static',
        });

        const result = reg.resolve('notpurchasable.publisher');
        expect(result).not.toBeNull();
        expect(result!.value).toBe('acme.payment.received');
        expect(result!.confidence).toBe('static');
    });

    it('should return null for unregistered keys', () => {
        const reg = new SymbolRegistry();
        expect(reg.resolve('nonexistent.key')).toBeNull();
    });

    it('should track size correctly', () => {
        const reg = new SymbolRegistry();
        expect(reg.size).toBe(0);

        reg.register({
            key: 'a.publisher',
            value: 'topic-a',
            category: 'di_service',
            sourceFile: 'config.php',
            confidence: 'static',
        });
        expect(reg.size).toBe(1);

        reg.register({
            key: 'b.consumer',
            value: 'topic-b',
            category: 'di_service',
            sourceFile: 'config.php',
            confidence: 'static',
        });
        expect(reg.size).toBe(2);
    });

    // ─── Priority Resolution ──────────────────────────────────────────────

    it('should prefer manual over static confidence', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'billing.sender',
            value: 'billing.events.v1',
            category: 'di_service',
            sourceFile: 'config/services.yaml',
            confidence: 'static',
        });
        reg.register({
            key: 'billing.sender',
            value: 'billing.invoice.created',
            category: 'di_service',
            sourceFile: 'coderadius.yaml',
            confidence: 'manual',
        });

        const result = reg.resolve('billing.sender');
        expect(result!.value).toBe('billing.invoice.created');
        expect(result!.confidence).toBe('manual');
    });

    it('should prefer static over llm_inferred confidence', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'order.handler',
            value: 'order.queue.inferred',
            category: 'di_service',
            sourceFile: 'OrderService.php',
            confidence: 'inferred',
        });
        reg.register({
            key: 'order.handler',
            value: 'order.queue.from.config',
            category: 'di_service',
            sourceFile: 'config/queue.php',
            confidence: 'static',
        });

        const result = reg.resolve('order.handler');
        expect(result!.value).toBe('order.queue.from.config');
    });

    it('should NOT downgrade manual → static on re-register', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'x.publisher',
            value: 'override-value',
            category: 'di_service',
            sourceFile: 'coderadius.yaml',
            confidence: 'manual',
        });
        reg.register({
            key: 'x.publisher',
            value: 'auto-detected',
            category: 'di_service',
            sourceFile: 'config.php',
            confidence: 'static',
        });

        // Manual should still win
        const result = reg.resolve('x.publisher');
        expect(result!.value).toBe('override-value');
        expect(result!.confidence).toBe('manual');
    });

    it('should NOT downgrade static → llm_inferred on re-register', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'z.consumer',
            value: 'from-config',
            category: 'di_service',
            sourceFile: 'services.yaml',
            confidence: 'static',
        });
        reg.register({
            key: 'z.consumer',
            value: 'guessed-by-llm',
            category: 'di_service',
            sourceFile: 'SomeClass.php',
            confidence: 'inferred',
        });

        const result = reg.resolve('z.consumer');
        expect(result!.value).toBe('from-config');
    });

    // ─── Technology Metadata ──────────────────────────────────────────────

    it('should store and retrieve technology metadata', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'events.publisher',
            value: 'order.events',
            category: 'di_service',
            sourceFile: 'config/rabbitmq.php',
            confidence: 'static',
            technology: 'RabbitMQ',
        });

        const result = reg.resolve('events.publisher');
        expect(result!.technology).toBe('RabbitMQ');
    });

    // ─── Serialization (Cache) ────────────────────────────────────────────

    it('should serialize to and deserialize from cache format', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'a.publisher',
            value: 'topic-a',
            category: 'di_service',
            sourceFile: 'config.php',
            confidence: 'static',
            technology: 'Kafka',
        });
        reg.register({
            key: 'b.consumer',
            value: 'topic-b',
            category: 'di_service',
            sourceFile: 'coderadius.yaml',
            confidence: 'manual',
        });

        const serialized = reg.serialize();
        expect(typeof serialized).toBe('string');

        const restored = SymbolRegistry.deserialize(serialized);
        expect(restored.size).toBe(2);
        expect(restored.resolve('a.publisher')!.value).toBe('topic-a');
        expect(restored.resolve('a.publisher')!.technology).toBe('Kafka');
        expect(restored.resolve('b.consumer')!.value).toBe('topic-b');
        expect(restored.resolve('b.consumer')!.confidence).toBe('manual');
    });

    it('should handle empty registry serialization', () => {
        const reg = new SymbolRegistry();
        const serialized = reg.serialize();
        const restored = SymbolRegistry.deserialize(serialized);
        expect(restored.size).toBe(0);
    });

    // ─── Edge Cases ───────────────────────────────────────────────────────

    it('should handle case-sensitive keys', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'Billing.Publisher',
            value: 'billing-topic',
            category: 'di_service',
            sourceFile: 'config.php',
            confidence: 'static',
        });

        // Exact key should match
        expect(reg.resolve('Billing.Publisher')!.value).toBe('billing-topic');
        // Different case should NOT match
        expect(reg.resolve('billing.publisher')).toBeNull();
    });

    it('should accept multiple categories', () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'db.connection',
            value: 'postgres://localhost/mydb',
            category: 'config_value',
            sourceFile: 'config/database.php',
            confidence: 'static',
        });

        const result = reg.resolve('db.connection');
        expect(result!.category).toBe('config_value');
    });
});
