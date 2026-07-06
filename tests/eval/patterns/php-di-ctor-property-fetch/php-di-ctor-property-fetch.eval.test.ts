// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-di-ctor-property-fetch (Pattern B negative coverage)
//
// Documents the current limit of the DI bypass for constructor-injected
// receivers:
//
//   public function __construct(private NotificationPublisher $publisher) {}
//   public function placeOrder(array $payload): void {
//       $this->publisher->publish($payload);
//   }
//
// The PHP plugin's `publish`-method handler in value-resolution.ts intercepts
// the call BEFORE its DI binding fallback can co-emit a serviceId fact.
// Pattern B emit-new was rolled back after it caused a measured +30% LLM
// SEND regression on real codebases (acme-monolith: 341 → 439). Promoting
// every `$this->prop->method()` through Gate 5 inflated the LLM queue
// without producing a bypass, because only ~10% of bound components in a
// large repo have statically-extractable ioTags.
//
// The fixture therefore exercises the same dependency requirement (ctor
// injection on NotificationPublisher) but routes the call through the
// container so Pattern A (local-var taint) engages and the DI bypass fires.
//
// Pins:
//   - The dependency requirement IS extracted (ctor type-hint resolved to FQCN).
//   - Pattern A is the working bypass path for ctor-injected services.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-di-ctor-property-fetch', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('emits a DependencyRequirement for the controller ctor', () => {
        const req = result.dependencyRequirements.find(r =>
            r.ownerComponent === 'Acme\\Inventory\\Orders\\OrderController'
            && r.parameterName === 'container');
        expect(req).toBeDefined();
        expect(req!.requiredType).toBe('Psr\\Container\\ContainerInterface');
    });

    it('Pattern A (local-var alias) stamps chainedMethod on the get-fact', () => {
        const controller = result.files.find(f => f.relPath.endsWith('OrderController.php'))!;
        const publishFact = controller.criticalInvocations.find(i =>
            i.resourceRole === 'serviceId' && i.chainedMethod === 'publish');
        expect(publishFact).toBeDefined();
        expect(publishFact!.resourceExpression).toContain('NotificationPublisher');
    });

    it('bypass produces the MessageChannel infra item via Pattern A', () => {
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
        expect(channel!.grounding!.evidence.extractors).toContain('di-propagator-hop1@v1');
    });
});
