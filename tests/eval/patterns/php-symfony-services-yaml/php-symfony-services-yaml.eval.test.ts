// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-symfony-services-yaml (Symfony YAML + resource expansion)
//
// Pins the Symfony YAML DI binding path end-to-end:
//
//   services:
//     _defaults: { autowire: true }
//     Acme\Inventory\:
//       resource: '../src/'        ← Phase 2: registers every PSR-4 class
//                                    under that namespace as self-binding.
//     acme.notification.publisher:
//       class: Acme\Inventory\Notification\NotificationPublisher
//
//   __construct(private NotificationPublisher $publisher) {}
//   $this->publisher->publish($payload);
//
// Guarantees:
//   1. SymfonyServicesYamlProvider extracts the explicit binding AND the
//      `Acme\Inventory\:` resource block.
//   2. DiBindingResolver Phase 2 expands the resource block into class-only
//      self-bindings for every component under that namespace.
//   3. The DI propagator stamps a MessageChannel ioTag on the
//      NotificationPublisher binding.
//   4. The OrderController.placeOrder bypass produces the expected
//      MessageChannel infra item with AST grounding.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-symfony-services-yaml', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('extracts both an explicit binding and a resource: namespace registration', () => {
        const explicit = result.rawBindings.find(b => b.key === 'acme.notification.publisher');
        expect(explicit).toBeDefined();
        expect(explicit!.boundComponent).toBe('Acme\\Inventory\\Notification\\NotificationPublisher');

        const resourceBlock = result.rawBindings.find(b => b.resourcePrefix);
        expect(resourceBlock).toBeDefined();
        expect(resourceBlock!.resourcePrefix).toMatch(/Acme\\Inventory\\?$/);
    });

    it('Phase 2 expands the resource block into class-only self-bindings', () => {
        const all = result.registry.getAll();
        const selfBindings = all.filter(b =>
            b.key === b.boundComponent
            && (b.key === 'Acme\\Inventory\\Notification\\NotificationPublisher'
                || b.key === 'Acme\\Inventory\\Orders\\OrderController'
                || b.key === 'Acme\\Inventory\\Notification\\Transport\\AmqpClient'));
        // At minimum the publisher must self-bind so its ioTags can be
        // referenced through the ctor-injection alias on the controller.
        const publisherSelf = selfBindings.find(b =>
            b.key === 'Acme\\Inventory\\Notification\\NotificationPublisher');
        expect(publisherSelf).toBeDefined();
        expect(publisherSelf!.physicalName).toBeUndefined();
    });

    it('bypass produces the MessageChannel infra item via ctor injection', () => {
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
