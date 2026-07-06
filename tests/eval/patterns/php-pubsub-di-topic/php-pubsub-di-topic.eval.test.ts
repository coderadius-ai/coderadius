// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-pubsub-di-topic (Fix #1, Stage 2)
//
// The Pub/Sub topic NAME is DI-injected, not inline: the container factory does
//   new DwhPublisher(new PubSubClient([...]), 'acme-inventory-dwh-streaming', $logger)
// and the wrapper stores it with a classic ctor-body assignment
//   $this->topic = $topic;
// then publishes via the standard accessor
//   $topic = $this->pubSubClient->topic($this->topic); $topic->publish([...]);
//
// Stage 2 resolves $this->topic to the DI literal by joining the captured
// positional ctor scalar (arg index 1) to the ordered ctor params (param
// `topic`) and emitting a literal value-fact keyed by the param name in the
// wrapper's file. The existing `$this->topic = $topic` alias then resolves it.
//
// Pins (deterministic, NO LLM, full multi-file static pipeline):
//   - The accessor channel resolves to the DI-injected literal name.
//   - It is a WRITES topic with AST grounding (no LLM fallback).
//   - SCOPE GUARD: the wrapper method emits NO serviceId fact (no Pattern B).
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    findFileBySuffix,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');
const PUBLISHER = 'Acme\\Inventory\\Streaming\\DwhPublisher';

describe('Pattern Eval — php-pubsub-di-topic', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('captures the DI binding string key + the positional topic scalar', () => {
        const binding = result.rawBindings.find(b => b.key === 'dwh.publisher');
        expect(binding).toBeDefined();
        expect(binding!.boundComponent).toBe(PUBLISHER);
        expect(binding!.ctorScalars).toEqual([
            { position: 1, value: 'acme-inventory-dwh-streaming' },
        ]);
    });

    it('records the ordered ctor param names on the wrapper component', () => {
        const def = result.components.find(c => c.fqcn === PUBLISHER);
        expect(def?.constructorParameterNames).toEqual(['pubSubClient', 'topic', 'logger']);
    });

    it('resolves $this->topic to the DI-injected literal as a WRITES topic channel', () => {
        const { staticAnalysis } = runStaticBypassForMethod(result, PUBLISHER, 'publish');
        expect(staticAnalysis).not.toBeNull();
        const channel = staticAnalysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && i.name === 'acme-inventory-dwh-streaming');
        expect(channel).toBeDefined();
        expect(channel!.operation).toBe('WRITES');
        expect(channel!.channelKind).toBe('topic');
        // No noise channel named after the unresolved property or the accessor.
        const noise = staticAnalysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && /\$|->|topic\(/.test(i.name));
        expect(noise).toBeUndefined();
    });

    it('does NOT emit a serviceId fact on the wrapper method (no Pattern B promotion)', () => {
        const file = findFileBySuffix(result, 'DwhPublisher.php');
        const serviceIdFacts = file.criticalInvocations.filter(i => i.resourceRole === 'serviceId');
        expect(serviceIdFacts).toHaveLength(0);
    });
});
