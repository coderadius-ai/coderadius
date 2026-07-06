import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    linkServiceConnectsToBroker,
    mergeMessageBroker,
    mergeMessageChannelWithKind,
} from '../../src/graph/mutations/data-contracts.js';
import { astGrounding } from '../../src/graph/grounding.js';
import { runChannelBrokerConvergence } from '../../src/ingestion/processors/channel-broker-convergence.js';
import { run } from '../../src/graph/mutations/_run.js';

// ═════════════════════════════════════════════════════════════════════════════
// Channel-to-infra-broker convergence — rewires code-side channels (host-only
// broker, no vhost) onto their infra-derived counterpart's broker (vhost-set)
// when the name match is unique. Required so cross-kind dedup downstream sees
// matching brokerUrn and collapses the topic/queue pair.
// ═════════════════════════════════════════════════════════════════════════════

describe('runChannelBrokerConvergence', () => {
    const PFX = 'cr://test/broker-convergence/';
    const COMMIT = 'CONV_TEST';
    const codeBrokerUrn = `${PFX}broker:code-rabbit`;
    const infraBrokerUrn = `${PFX}broker:infra-rabbit-orders`;
    const otherInfraBrokerUrn = `${PFX}broker:infra-rabbit-notifications`;

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            // mergeMessageChannelWithKind builds URNs as `cr:channel:<kind>:<name>`
            // (no PFX), so seeded channels survive a PFX-only wipe across tests
            // and pollute the next run's queries. Match on test names.
            await s.run(`MATCH (c:MessageChannel)
                         WHERE c.name STARTS WITH 'acme.'
                         DETACH DELETE c`);
        } finally { await s.close(); }
    }

    async function setDiscoverySource(chUrn: string, source: 'config' | 'code') {
        const s = getNeo4jSession();
        try {
            await s.run(`MATCH (c:MessageChannel {id: $id}) SET c.discoverySource = $src`, { id: chUrn, src: source });
        } finally { await s.close(); }
    }

    async function readChannel(id: string): Promise<{ brokerUrn: string | null; extractors: string[] } | null> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (c:MessageChannel {id: $id})
                 RETURN c.brokerUrn AS bu, coalesce(c.evidence_extractors, []) AS ext`,
                { id },
            );
            if (r.records.length === 0) return null;
            return {
                brokerUrn: r.records[0].get('bu') as string | null,
                extractors: r.records[0].get('ext') as string[],
            };
        } finally { await s.close(); }
    }

    async function makeBroker(urn: string, host: string | null, vhost: string | null) {
        await mergeMessageBroker({
            urn,
            provider: 'rabbitmq',
            fingerprint: urn.split(':').pop() ?? 'fp',
            declaredVia: 'inferred',
            host: host ?? undefined,
            vhost: vhost ?? undefined,
            port: 5672,
            fingerprintScope: 'global',
            grounding: astGrounding('test-setup@v1'),
        }, COMMIT);
    }

    async function createServiceWithPublisher(serviceUrn: string, fnUrn: string, channelUrn: string) {
        await run(
            `MERGE (svc:Service {id: $serviceUrn})
             SET svc.name = $serviceUrn, svc.valid_to_commit = null
             MERGE (fn:Function {id: $fnUrn})
             SET fn.name = $fnUrn, fn.valid_to_commit = null
             MERGE (svc)-[:CONTAINS]->(fn)
             WITH fn
             MATCH (ch:MessageChannel {id: $channelUrn})
             MERGE (fn)-[pub:PUBLISHES_TO]->(ch)
             ON CREATE SET pub.valid_from_commit = $commit, pub.valid_to_commit = null
             ON MATCH SET pub.valid_to_commit = null`,
            { serviceUrn, fnUrn, channelUrn, commit: COMMIT },
        );
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('rewires a code-side channel (host-only broker) onto the infra-derived broker when the name uniquely matches', async () => {
        await makeBroker(codeBrokerUrn, 'rabbitmq.acme.example', null);
        await makeBroker(infraBrokerUrn, null, 'orders');

        const codeChannelUrn = await mergeMessageChannelWithKind(
            'acme.order.placed', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBrokerUrn, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const infraChannelUrn = await mergeMessageChannelWithKind(
            'acme.order.placed', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBrokerUrn, confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setDiscoverySource(infraChannelUrn, 'config');

        const result = await runChannelBrokerConvergence(COMMIT);
        expect(result.rewired).toBe(1);

        const code = await readChannel(codeChannelUrn);
        expect(code!.brokerUrn).toBe(infraBrokerUrn);
        expect(code!.extractors).toContain('channel-broker-convergence@v1');
        // The infra channel is untouched.
        const infra = await readChannel(infraChannelUrn);
        expect(infra!.brokerUrn).toBe(infraBrokerUrn);
    });

    it('skips when the name matches MULTIPLE infra brokers (ambiguous)', async () => {
        await makeBroker(codeBrokerUrn, 'rabbitmq.acme.example', null);
        await makeBroker(infraBrokerUrn, null, 'orders');
        await makeBroker(otherInfraBrokerUrn, null, 'notifications');

        const codeChannelUrn = await mergeMessageChannelWithKind(
            'acme.shared.name', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBrokerUrn, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        // Pass brokerFingerprint so the URN carries the broker suffix and the
        // two infra channels are distinct nodes (otherwise the second merge
        // overwrites the first on the same URN).
        const infraA = await mergeMessageChannelWithKind(
            'acme.shared.name', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBrokerUrn, brokerFingerprint: 'orders', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const infraB = await mergeMessageChannelWithKind(
            'acme.shared.name', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: otherInfraBrokerUrn, brokerFingerprint: 'notifications', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setDiscoverySource(infraA, 'config');
        await setDiscoverySource(infraB, 'config');

        const result = await runChannelBrokerConvergence(COMMIT);
        expect(result.rewired).toBe(0);
        const code = await readChannel(codeChannelUrn);
        expect(code!.brokerUrn).toBe(codeBrokerUrn);
    });

    it('skips when the code-side broker is already fully qualified (host + vhost)', async () => {
        await makeBroker(codeBrokerUrn, 'rabbitmq.acme.example', 'orders'); // already vhost
        await makeBroker(infraBrokerUrn, null, 'orders');

        const codeChannelUrn = await mergeMessageChannelWithKind(
            'acme.fully.pinned', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: codeBrokerUrn, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const infraChannelUrn = await mergeMessageChannelWithKind(
            'acme.fully.pinned', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBrokerUrn, confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setDiscoverySource(infraChannelUrn, 'config');

        const result = await runChannelBrokerConvergence(COMMIT);
        expect(result.rewired).toBe(0);
    });

    it('idempotent: second run does not rewire what is already converged', async () => {
        await makeBroker(codeBrokerUrn, 'rabbitmq.acme.example', null);
        await makeBroker(infraBrokerUrn, null, 'orders');

        const codeChannelUrn = await mergeMessageChannelWithKind(
            'acme.idem', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBrokerUrn, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const infraChannelUrn = await mergeMessageChannelWithKind(
            'acme.idem', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBrokerUrn, confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setDiscoverySource(infraChannelUrn, 'config');

        const first = await runChannelBrokerConvergence(COMMIT);
        const second = await runChannelBrokerConvergence(COMMIT);
        expect(first.rewired).toBe(1);
        expect(second.rewired).toBe(0);
    });

    it('creates a channel-convergence CONNECTS_TO edge for the owning service', async () => {
        await makeBroker(codeBrokerUrn, 'rabbitmq.acme.example', null);
        await makeBroker(infraBrokerUrn, null, 'orders');

        const codeChannelUrn = await mergeMessageChannelWithKind(
            'acme.convergence.connected', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBrokerUrn, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const infraChannelUrn = await mergeMessageChannelWithKind(
            'acme.convergence.connected', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBrokerUrn, confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setDiscoverySource(infraChannelUrn, 'config');
        const serviceUrn = `${PFX}service:orders`;
        await createServiceWithPublisher(serviceUrn, `${PFX}function:publish-order`, codeChannelUrn);

        const result = await runChannelBrokerConvergence(COMMIT);
        expect(result.rewired).toBe(1);
        expect(result.serviceLinks).toBe(1);

        const s = getNeo4jSession();
        try {
            const links = await s.run(
                `MATCH (:Service {id: $serviceUrn})-[rel:CONNECTS_TO]->(:MessageBroker {id: $infraBrokerUrn})
                 WHERE rel.valid_to_commit IS NULL
                 RETURN rel.source AS source, rel.via AS via`,
                { serviceUrn, infraBrokerUrn },
            );
            expect(links.records).toHaveLength(1);
            expect(links.records[0].get('source')).toBe('channel-convergence');
            expect(links.records[0].get('via')).toBe('channel-broker-convergence@v1');
        } finally { await s.close(); }
    });

    it('keeps env-var and channel-convergence CONNECTS_TO edges distinct for the same service and broker', async () => {
        await makeBroker(codeBrokerUrn, 'rabbitmq.acme.example', null);
        await makeBroker(infraBrokerUrn, null, 'orders');

        const codeChannelUrn = await mergeMessageChannelWithKind(
            'acme.convergence.coexists', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBrokerUrn, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const infraChannelUrn = await mergeMessageChannelWithKind(
            'acme.convergence.coexists', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBrokerUrn, confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setDiscoverySource(infraChannelUrn, 'config');
        const serviceUrn = `${PFX}service:coexists`;
        await createServiceWithPublisher(serviceUrn, `${PFX}function:coexists`, codeChannelUrn);
        await linkServiceConnectsToBroker(serviceUrn, infraBrokerUrn, 'RABBITMQ_HOST', COMMIT);

        const first = await runChannelBrokerConvergence(COMMIT);
        const second = await runChannelBrokerConvergence(COMMIT);
        expect(first.serviceLinks).toBe(1);
        expect(second.rewired).toBe(0);

        const s = getNeo4jSession();
        try {
            const links = await s.run(
                `MATCH (:Service {id: $serviceUrn})-[rel:CONNECTS_TO]->(:MessageBroker {id: $infraBrokerUrn})
                 WHERE rel.valid_to_commit IS NULL
                 RETURN rel.source AS source ORDER BY source`,
                { serviceUrn, infraBrokerUrn },
            );
            expect(links.records.map(r => r.get('source'))).toEqual(['channel-convergence', 'env-var']);
        } finally { await s.close(); }
    });

    it('does not create CONNECTS_TO when no service owns the publishing function', async () => {
        await makeBroker(codeBrokerUrn, 'rabbitmq.acme.example', null);
        await makeBroker(infraBrokerUrn, null, 'orders');

        const codeChannelUrn = await mergeMessageChannelWithKind(
            'acme.convergence.orphan', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBrokerUrn, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const infraChannelUrn = await mergeMessageChannelWithKind(
            'acme.convergence.orphan', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBrokerUrn, confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setDiscoverySource(infraChannelUrn, 'config');
        await run(
            `MERGE (fn:Function {id: $fnUrn})
             SET fn.name = 'orphan-publisher', fn.valid_to_commit = null
             WITH fn
             MATCH (ch:MessageChannel {id: $codeChannelUrn})
             MERGE (fn)-[pub:PUBLISHES_TO]->(ch)
             ON CREATE SET pub.valid_from_commit = $commit, pub.valid_to_commit = null`,
            { fnUrn: `${PFX}function:orphan`, codeChannelUrn, commit: COMMIT },
        );

        const result = await runChannelBrokerConvergence(COMMIT);
        expect(result.rewired).toBe(1);
        expect(result.serviceLinks).toBe(0);
    });

    it('creates channel-convergence CONNECTS_TO for multiple owning services', async () => {
        await makeBroker(codeBrokerUrn, 'rabbitmq.acme.example', null);
        await makeBroker(infraBrokerUrn, null, 'orders');

        const codeChannelUrn = await mergeMessageChannelWithKind(
            'acme.convergence.multi', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBrokerUrn, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const infraChannelUrn = await mergeMessageChannelWithKind(
            'acme.convergence.multi', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBrokerUrn, confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setDiscoverySource(infraChannelUrn, 'config');
        await createServiceWithPublisher(`${PFX}service:inventory`, `${PFX}function:inventory`, codeChannelUrn);
        await createServiceWithPublisher(`${PFX}service:shipping`, `${PFX}function:shipping`, codeChannelUrn);

        const result = await runChannelBrokerConvergence(COMMIT);
        expect(result.rewired).toBe(1);
        expect(result.serviceLinks).toBe(2);
    });
});
