// ═════════════════════════════════════════════════════════════════════════════
// Pattern Eval — php-pubsub-inline-channel (Fix #1, Stage 1)
//
// Google Cloud Pub/Sub recognizer for the PHP SDK. The canonical usage stores
// the topic/subscription handle in a local var before the I/O call:
//
//   $topic = $this->pubSub->topic('acme-inventory-streaming');
//   $topic->publish(['data' => json_encode($payload)]);
//   $sub   = $this->pubSub->subscription('acme-inventory-updates-sub');
//   $sub->pull(['maxMessages' => 10]);
//
// The NAME lives on the topic()/subscription() accessor (the InfluxDB
// writePoints precedent), so the recognizer fires there, not on publish()/pull().
//
// Pins (deterministic, NO LLM, full multi-file static pipeline):
//   - topic('...') accessor → MessageChannel WRITES with the literal name.
//   - subscription('...') accessor → MessageChannel READS with the literal name.
//   - The name propagates cross-file through the DI bypass (caller → wrapper).
//   - The wrapper class, the bare 'topic'/'subscription'/'pubsub' tokens, and
//     the local-var handle ($topic) never become channels.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
    type DiPipelineResult,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');
const PUBLISHER = 'Acme\\Inventory\\Streaming\\StreamingPublisher';
const CONTROLLER = 'Acme\\Inventory\\Orders\\OrderController';

describe('Pattern Eval — php-pubsub-inline-channel', () => {
    let result: DiPipelineResult;

    beforeAll(() => {
        result = runStaticPipelineOnFixture(FIXTURE_DIR);
    });

    it('recognizes $client->topic("name") as a WRITES MessageChannel (direct)', () => {
        const { staticAnalysis } = runStaticBypassForMethod(result, PUBLISHER, 'publishStreamingEvent');
        expect(staticAnalysis).not.toBeNull();
        const topic = staticAnalysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && i.name === 'acme-inventory-streaming');
        expect(topic).toBeDefined();
        expect(topic!.operation).toBe('WRITES');
        expect(topic!.channelKind).toBe('topic');
    });

    it('recognizes $client->subscription("name") as a READS MessageChannel (direct)', () => {
        const { staticAnalysis } = runStaticBypassForMethod(result, PUBLISHER, 'readOrderUpdates');
        expect(staticAnalysis).not.toBeNull();
        const sub = staticAnalysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && i.name === 'acme-inventory-updates-sub');
        expect(sub).toBeDefined();
        expect(sub!.operation).toBe('READS');
        expect(sub!.channelKind).toBe('subscription');
    });

    it('propagates the topic name cross-file via the DI bypass (caller → wrapper)', () => {
        const { staticAnalysis } = runStaticBypassForMethod(result, CONTROLLER, 'placeOrder');
        expect(staticAnalysis).not.toBeNull();
        const topic = staticAnalysis!.infrastructure.find(i =>
            i.type === 'MessageChannel' && i.name === 'acme-inventory-streaming');
        expect(topic).toBeDefined();
        expect(topic!.operation).toBe('WRITES');
        expect(topic!.grounding!.evidence.extractors).toContain('di-binding-resolver@v1');
    });

    it('does NOT emit phantom channels for the wrapper class, SDK tokens, or the handle var', () => {
        const all = [
            runStaticBypassForMethod(result, PUBLISHER, 'publishStreamingEvent').staticAnalysis,
            runStaticBypassForMethod(result, PUBLISHER, 'readOrderUpdates').staticAnalysis,
            runStaticBypassForMethod(result, CONTROLLER, 'placeOrder').staticAnalysis,
        ];
        const channelNames = all
            .filter(Boolean)
            .flatMap(a => a!.infrastructure.filter(i => i.type === 'MessageChannel').map(i => i.name));

        for (const banned of ['topic', 'subscription', 'pubsub', 'StreamingPublisher', 'PubSubClient']) {
            expect(channelNames).not.toContain(banned);
        }
        // No local-var handle / accessor-expression noise.
        expect(channelNames.some(n => /\$|->|\btopic\(/.test(n))).toBe(false);
    });
});
