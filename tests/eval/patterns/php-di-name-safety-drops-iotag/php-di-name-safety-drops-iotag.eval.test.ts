// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-di-name-safety-drops-iotag (FP guard)
//
// The DI binding + propagator are happy: the publisher's body has a literal
// routing-key argument, the ioTag gets stamped. But the literal itself is
// `'configuration'`, which lives in `NOISY_BROKER_NAMES` because real-world
// queue/topic names never have that exact value — it's almost always a leak
// from a DI container key.
//
// The static-bypass validation (`isNoisyBrokerName` via name-safety) must
// reject the ioTag BEFORE producing the infra item, and the fail-closed
// guard (plan v10 §H, P0 fix #5) must abort the bypass entirely (LLM
// fallback). This is the per-tag FP guard the plan promised.
//
// Pin: even when the parser succeeds, name-safety rejects unsafe names AND
// the bypass returns null rather than emitting a half-bad result.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-di-name-safety-drops-iotag', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('propagator does stamp an ioTag (the parser is happy)', () => {
        const binding = result.registry.getAll().find(b =>
            b.key === 'Acme\\Inventory\\Notification\\NotificationPublisher')!;
        expect(binding.ioTags).toBeDefined();
        // Tag was stamped with the unsafe routing-key literal — this is
        // intentional: the parser is permissive; validation is the gate.
        const noisyTag = binding.ioTags!.find(t => t.channelName === 'configuration');
        expect(noisyTag).toBeDefined();
    });

    it('bypass fails closed when every ioTag is dropped by name-safety', () => {
        const { staticAnalysis } = runStaticBypassForMethod(
            result,
            'Acme\\Inventory\\Orders\\OrderController',
            'placeOrder',
        );
        // Plan v10 §H, P0 fix #5: validationDroppedAllForServiceId → null.
        expect(staticAnalysis).toBeNull();
    });
});
