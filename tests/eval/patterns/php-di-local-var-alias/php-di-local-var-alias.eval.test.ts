// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-di-local-var-alias (Pattern A)
//
// Pattern A: a consumer pulls a service from the container into a local var,
// then invokes a method on the local:
//
//   $publisher = $this->container->get('acme.notification.publisher');
//   $publisher->publish($payload);
//
// The DI registry must:
//   1. Extract the string-keyed PHP-DI entry from containerBuilder.php.
//   2. Stamp chainedMethod='publish' on the serviceId fact via the local-var
//      alias scan (enricher Pattern A).
//   3. Bypass to a MessageChannel infra item via the bound component.
//
// Deterministic, no LLM.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-di-local-var-alias', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('extracts a class-keyed PHP-DI binding', () => {
        expect(result.rawBindings).toHaveLength(1);
        const [b] = result.rawBindings;
        expect(b.key).toBe('Acme\\Inventory\\Notification\\NotificationPublisher');
        expect(b.boundComponent).toBe('Acme\\Inventory\\Notification\\NotificationPublisher');
    });

    it('local-var taint stamps chainedMethod=publish (Pattern A)', () => {
        const controller = result.files.find(f => f.relPath.endsWith('OrderController.php'))!;
        const serviceIdFacts = controller.criticalInvocations.filter(i =>
            i.resourceRole === 'serviceId');
        expect(serviceIdFacts.length).toBeGreaterThan(0);
        const publishFact = serviceIdFacts.find(f => f.chainedMethod === 'publish');
        expect(publishFact).toBeDefined();
        expect(publishFact!.resourceExpression).toContain('NotificationPublisher');
    });

    it('bypass produces a MessageChannel infra item', () => {
        const { staticAnalysis } = runStaticBypassForMethod(
            result,
            'Acme\\Inventory\\Orders\\OrderController',
            'placeOrder',
        );
        expect(staticAnalysis).not.toBeNull();
        const channel = staticAnalysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && i.name === 'orders.notifications');
        expect(channel).toBeDefined();
        expect(channel!.operation).toBe('WRITES');
        expect(channel!.grounding!.source).toBe('ast');
        expect(channel!.grounding!.evidence.extractors).toContain('di-binding-resolver@v1');
    });
});
