// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-di-multi-implementer-no-bypass (ambiguity guard)
//
// NotificationPublisherInterface has TWO implementers (Rabbit + Kafka) but
// the container does NOT register a concrete for the interface. The DI
// resolver must NOT pick one arbitrarily — both Phase 3 (autowiring) and
// Phase 4 (dep-requirement cross-check) abstain when impls.size > 1.
//
// Consumer's static-bypass returns null → LLM fallback.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-di-multi-implementer-no-bypass', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('discovers two implementers of the interface', () => {
        const impls = result.componentIo.getImplementers('Acme\\Inventory\\Notification\\NotificationPublisherInterface');
        expect(impls.sort()).toEqual([
            'Acme\\Inventory\\Notification\\KafkaNotificationPublisher',
            'Acme\\Inventory\\Notification\\RabbitNotificationPublisher',
        ]);
    });

    it('DiBindingResolver does NOT register the ambiguous interface', () => {
        const ifaceBinding = result.registry.getAll().find(b =>
            b.key === 'Acme\\Inventory\\Notification\\NotificationPublisherInterface');
        expect(ifaceBinding).toBeUndefined();
    });

    it('consumer static bypass returns null (LLM fallback)', () => {
        const { staticAnalysis } = runStaticBypassForMethod(
            result,
            'Acme\\Inventory\\Orders\\OrderController',
            'placeOrder',
        );
        expect(staticAnalysis).toBeNull();
    });
});
