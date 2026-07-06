// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-di-autowire-interface (Phase 3 autowiring)
//
// PHP-DI useAutowiring(true) + a controller injecting an interface with a
// single concrete implementer registered in containerBuilder.php:
//
//   interface NotificationPublisherInterface { function publish(array $p); }
//   final class AmqpNotificationPublisher implements NotificationPublisherInterface { ... }
//
//   // ctor injection on the INTERFACE
//   __construct(private NotificationPublisherInterface $publisher) {}
//   $this->publisher->publish($payload);
//
// DiBindingResolver Phase 3 must register:
//   NotificationPublisherInterface (key)
//      → AmqpNotificationPublisher (boundComponent)
//
// Phase 3 fires because:
//   - the concrete is registered in PHP-DI (Phase 1)
//   - the concrete declares exactly one implemented interface
//   - that interface has exactly one implementer in the repo
//
// Bypass then resolves ctor-injected method calls through the interface
// alias to the concrete's ioTags.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-di-autowire-interface', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('extracts the concrete PHP-DI binding with autowireEnabled=true', () => {
        expect(result.rawBindings).toHaveLength(1);
        const [b] = result.rawBindings;
        expect(b.key).toBe('Acme\\Inventory\\Notification\\AmqpNotificationPublisher');
        expect(b.boundComponent).toBe('Acme\\Inventory\\Notification\\AmqpNotificationPublisher');
        expect(b.autowireEnabled).toBe(true);
    });

    it('Phase 3 registers interface → concrete binding', () => {
        const ifaceBinding = result.registry.getAll().find(b =>
            b.key === 'Acme\\Inventory\\Notification\\NotificationPublisherInterface');
        expect(ifaceBinding).toBeDefined();
        expect(ifaceBinding!.boundComponent).toBe('Acme\\Inventory\\Notification\\AmqpNotificationPublisher');
        expect(ifaceBinding!.physicalName).toBeUndefined();
    });

    it('Phase 3 binding inherits ioTags from the concrete', () => {
        const ifaceBinding = result.registry.getAll().find(b =>
            b.key === 'Acme\\Inventory\\Notification\\NotificationPublisherInterface')!;
        expect(ifaceBinding.ioTags).toBeDefined();
        const tag = ifaceBinding.ioTags!.find(t => t.channelName === 'orders.notifications');
        expect(tag).toBeDefined();
        expect(tag!.method).toBe('publish');
    });

    it('bypass produces the MessageChannel infra item via the interface ctor injection', () => {
        const { staticAnalysis } = runStaticBypassForMethod(
            result,
            'Acme\\Inventory\\Orders\\OrderController',
            'placeOrder',
        );
        expect(staticAnalysis).not.toBeNull();
        const channel = staticAnalysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && i.name === 'orders.notifications');
        expect(channel).toBeDefined();
        expect(channel!.grounding!.source).toBe('ast');
        expect(channel!.grounding!.evidence.extractors).toContain('di-binding-resolver@v1');
    });
});
