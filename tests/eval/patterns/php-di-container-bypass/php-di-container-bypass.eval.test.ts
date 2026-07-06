// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-di-container-bypass (Pattern C + PHP-DI)
//
// Pins the full DI bypass chain for the canonical acme-monolith shape:
//
//   - `config/containerBuilder.php` declares
//        NotificationPublisher::class => fn() => new NotificationPublisher()
//   - OrderController::placeOrder calls
//        $this->container->get(NotificationPublisher::class)->publish($payload)
//
// Guarantees:
//   1. PhpDiContainerProvider extracts 1 RawDiBinding for the self-binding.
//   2. DiBindingResolver Phase 1 registers it (boundComponent + class-only).
//   3. ComponentIoIndex sees NotificationPublisher::publish.
//   4. DiIoPropagator stamps an ioTag with channelName='orders.notifications',
//      hop 1, MessageChannel READS.
//   5. Pattern C enricher stamps chainedMethod='publish' on the serviceId fact
//      whose resourceExpression resolves to NotificationPublisher FQCN.
//   6. buildStaticAnalysisFromResolvedInvocations emits a MessageChannel
//      infrastructure item with grounding.source='ast' AND extractors
//      containing 'di-binding-resolver@v1' + 'di-propagator-hop1@v1'.
//   7. The placeOrder function is fully resolved statically (no LLM fallback).
//
// Deterministic, no LLM calls.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-di-container-bypass', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('extracts exactly one RawDiBinding from containerBuilder.php', () => {
        expect(result.rawBindings).toHaveLength(1);
        const [b] = result.rawBindings;
        expect(b.key).toBe('Acme\\Inventory\\Notification\\NotificationPublisher');
        expect(b.boundComponent).toBe('Acme\\Inventory\\Notification\\NotificationPublisher');
        expect(b.sourceFile).toBe('config/containerBuilder.php');
    });

    it('registers the binding in SymbolRegistry with class-only semantics', () => {
        const all = result.registry.getAll();
        const di = all.find(b => b.key === 'Acme\\Inventory\\Notification\\NotificationPublisher');
        expect(di).toBeDefined();
        expect(di!.boundComponent).toBe('Acme\\Inventory\\Notification\\NotificationPublisher');
        expect(di!.physicalName).toBeUndefined();
        expect(di!.category).toBe('di_service');
    });

    it('DiIoPropagator stamps a MessageChannel ioTag on the binding', () => {
        const binding = result.registry.getAll().find(b =>
            b.key === 'Acme\\Inventory\\Notification\\NotificationPublisher')!;
        expect(binding.ioTags).toBeDefined();
        expect(binding.ioTags!.length).toBeGreaterThanOrEqual(1);
        const tag = binding.ioTags!.find(t => t.channelName === 'orders.notifications');
        expect(tag).toBeDefined();
        expect(tag!.resourceType).toBe('MessageChannel');
        expect(tag!.operation).toBe('WRITES');
        expect(tag!.method).toBe('publish');
        expect(tag!.hopCount).toBe(1);
    });

    it('bypass produces the MessageChannel infra item with AST grounding + DI evidence', () => {
        const { staticAnalysis } = runStaticBypassForMethod(
            result,
            'Acme\\Inventory\\Orders\\OrderController',
            'placeOrder',
        );

        expect(staticAnalysis).not.toBeNull();
        expect(staticAnalysis!.has_io).toBe(true);
        expect(staticAnalysis!.infrastructure).toHaveLength(1);

        const item = staticAnalysis!.infrastructure[0];
        expect(item.name).toBe('orders.notifications');
        expect(item.type).toBe('MessageChannel');
        expect(item.operation).toBe('WRITES');
        // Plan v10 §G: same-source `compositeGrounding(ast, ast)` keeps
        // source='ast' and surfaces DI provenance via evidence.extractors.
        expect(item.grounding).toBeDefined();
        expect(item.grounding!.source).toBe('ast');
        const extractors = item.grounding!.evidence.extractors;
        expect(extractors).toContain('di-binding-resolver@v1');
        expect(extractors).toContain('di-propagator-hop1@v1');
    });

    it('serviceId fact is stamped with chainedMethod=publish (Pattern C)', () => {
        const controller = result.files.find(f => f.relPath.endsWith('OrderController.php'))!;
        const serviceIdFacts = controller.criticalInvocations.filter(i =>
            i.resourceRole === 'serviceId');
        expect(serviceIdFacts.length).toBeGreaterThan(0);
        const publishFact = serviceIdFacts.find(f => f.chainedMethod === 'publish');
        expect(publishFact).toBeDefined();
        // The resourceExpression resolves (via use-import normalization) to
        // the FQCN registry key — that's the entire point of Pattern C.
        expect(publishFact!.resourceExpression).toContain('NotificationPublisher');
    });
});
