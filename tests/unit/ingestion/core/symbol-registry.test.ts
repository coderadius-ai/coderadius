import { describe, it, expect } from 'vitest';
import {
    SymbolRegistry,
    type SymbolBinding,
    type DiIoTag,
} from '../../../../src/ingestion/core/symbol-registry.js';

function makeBinding(overrides: Partial<SymbolBinding> = {}): SymbolBinding {
    return {
        key: 'acme.notification.publisher',
        value: 'orders.notifications',
        category: 'di_service',
        sourceFile: 'config/services.yaml',
        confidence: 'static',
        ...overrides,
    };
}

function makeIoTag(overrides: Partial<DiIoTag> = {}): DiIoTag {
    return {
        method: 'publish',
        resourceType: 'MessageChannel',
        operation: 'WRITES',
        channelName: 'orders.notifications',
        channelKind: 'topic',
        quality: 'high',
        hopCount: 1,
        viaFiles: ['src/NotificationPublisher.php'],
        evidenceSource: {
            filePath: 'src/NotificationPublisher.php',
            sourceSlice: '$this->bus->dispatch(new OrderCreated($order));',
        },
        ...overrides,
    };
}

describe('SymbolRegistry', () => {
    describe('resolve() class-only binding guard', () => {
        it('drops di_service binding without physicalName (plan v10 P0)', () => {
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                key: 'message_bus.sender',
                value: 'App\\Messaging\\NotificationPublisher',
                // physicalName intentionally undefined — class-only binding
                boundComponent: 'App\\Messaging\\NotificationPublisher',
            }));
            expect(reg.resolve('message_bus.sender')).toBeNull();
        });

        it('returns binding when physicalName is present', () => {
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                physicalName: 'orders.notifications',
            }));
            const out = reg.resolve('acme.notification.publisher');
            expect(out).not.toBeNull();
            expect(out!.physicalName).toBe('orders.notifications');
        });

        it('returns env_var binding unchanged even without physicalName', () => {
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                key: 'DB_HOST',
                value: 'db.acme.internal',
                category: 'env_var',
                // physicalName not applicable to env vars
            }));
            expect(reg.resolve('DB_HOST')?.value).toBe('db.acme.internal');
        });
    });

    describe('resolveDi() method-aware resolution', () => {
        it('returns null when operationName is undefined', () => {
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                boundComponent: 'App\\Messaging\\NotificationPublisher',
                ioTags: [makeIoTag()],
            }));
            expect(reg.resolveDi('acme.notification.publisher', undefined, undefined)).toBeNull();
        });

        it('returns null when no binding exists', () => {
            const reg = new SymbolRegistry();
            expect(reg.resolveDi('nonexistent', undefined, 'publish')).toBeNull();
        });

        it('returns null when binding has no ioTags', () => {
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                boundComponent: 'App\\Messaging\\NotificationPublisher',
                // no ioTags
            }));
            expect(reg.resolveDi('acme.notification.publisher', undefined, 'publish')).toBeNull();
        });

        it('filters ioTags by operation name', () => {
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                boundComponent: 'App\\Messaging\\NotificationPublisher',
                ioTags: [
                    makeIoTag({ method: 'publish', channelName: 'orders.notifications' }),
                    makeIoTag({ method: 'retry', channelName: 'orders.retries' }),
                ],
            }));
            const out = reg.resolveDi('acme.notification.publisher', undefined, 'publish');
            expect(out).not.toBeNull();
            expect(out!.ioTags).toHaveLength(1);
            expect(out!.ioTags[0].method).toBe('publish');
            expect(out!.ioTags[0].channelName).toBe('orders.notifications');
        });

        it('returns null when operation has no matching ioTags', () => {
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                boundComponent: 'App\\Messaging\\NotificationPublisher',
                ioTags: [makeIoTag({ method: 'publish' })],
            }));
            expect(reg.resolveDi('acme.notification.publisher', undefined, 'unknownMethod')).toBeNull();
        });

        it('returns binding even when it is class-only (resolve() would drop)', () => {
            // resolveDi() is the proper entry for class-only DI bindings: the
            // sanitizer guard in resolve() must not block the DI propagator path.
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                key: 'message_bus.sender',
                value: 'App\\Messaging\\NotificationPublisher',
                // physicalName intentionally undefined — class-only
                boundComponent: 'App\\Messaging\\NotificationPublisher',
                ioTags: [makeIoTag()],
            }));
            expect(reg.resolve('message_bus.sender')).toBeNull(); // sanitizer path
            const out = reg.resolveDi('message_bus.sender', undefined, 'publish');
            expect(out).not.toBeNull();
            expect(out!.binding.boundComponent).toBe('App\\Messaging\\NotificationPublisher');
        });

        it('records consumer file in usages for cache invalidation', () => {
            const reg = new SymbolRegistry();
            reg.register(makeBinding({
                boundComponent: 'App\\Messaging\\NotificationPublisher',
                ioTags: [makeIoTag()],
            }));
            reg.resolveDi('acme.notification.publisher', 'src/Consumer.php', 'publish');
            const usages = reg.getUsages();
            const consumers = usages.get('acme.notification.publisher');
            expect(consumers).toBeDefined();
            expect(consumers!.has('src/Consumer.php')).toBe(true);
        });
    });
});
