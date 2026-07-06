import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeMessageBroker,
    linkServiceConnectsToBroker,
    mergeMessageChannelWithKind,
    linkFunctionPublishesTo,
    linkFunctionListensTo,
} from '../../src/graph/mutations/data-contracts.js';
import { astGrounding } from '../../src/graph/grounding.js';
import { runReconcile } from '../../src/ingestion/workflows/reconcile.workflow.js';

// ═════════════════════════════════════════════════════════════════════════════
// runReconcile() — terminal step of every ingest entry point.
//
// Pins three guarantees:
//   1. Deterministic order: autopromote → suffix → cross-kind → technology weld.
//   2. Idempotence: a second run is a no-op on already-reconciled state.
//   3. Cross-kind dedup fires unconditionally (was previously gated by dynamic
//      stubs existing; the gate is now removed by the reconcile extraction).
// ═════════════════════════════════════════════════════════════════════════════

describe('runReconcile (ordering + idempotence)', () => {
    const PFX = 'cr://test/reconcile-workflow/';
    const COMMIT = 'RECONCILE_TEST';
    const FP = 'recon0001';
    const BROKER_URN = `cr:broker:rabbitmq:${FP}:orders`;

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await s.run(`MATCH (b:MessageBroker {id: $id}) DETACH DELETE b`, { id: BROKER_URN });
            await s.run(`MATCH (ch:MessageChannel) WHERE ch.name STARTS WITH 'reconcile.test.' DETACH DELETE ch`);
        } finally { await s.close(); }
    }

    async function createService(urn: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = $c, s.valid_to_commit = null`,
                { id: urn, name, c: COMMIT },
            );
        } finally { await s.close(); }
    }

    async function createFunctionInService(fnUrn: string, serviceUrn: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:Function {id: $fid})
                 SET f.name = $name, f.valid_from_commit = $c, f.valid_to_commit = null
                 WITH f MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:CONTAINS]->(f)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { fid: fnUrn, sid: serviceUrn, name, c: COMMIT },
            );
        } finally { await s.close(); }
    }

    async function seedBroker() {
        await mergeMessageBroker({
            urn: BROKER_URN, provider: 'rabbitmq', fingerprint: FP,
            declaredVia: 'inferred', host: 'rabbitmq.reconcile-test.acme.local',
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
            grounding: astGrounding('test-setup@v1'),
        }, COMMIT);
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('empty graph: runReconcile completes with all-zero counters and no crash', async () => {
        const result = await runReconcile({ repos: [], commitHash: COMMIT });
        expect(result.classBridge.weldedEdges).toBe(0);
        expect(result.channelAliases.manifestsAsEdges).toBe(0);
        expect(result.autopromote.promoted).toBe(0);
        expect(result.suffixDedup.welded).toBe(0);
        expect(result.crossKindDedup.merged).toBe(0);
        expect(result.technologyWeld.welded).toBe(0);
    });

    it('autopromotes a logical channel + stamps technology in a single reconcile pass', async () => {
        const svcEmitter = `${PFX}service:emitter`;
        const svcConsumer = `${PFX}service:consumer`;
        const fnEmitter = `${PFX}function:emitter:emit`;
        const fnConsumer = `${PFX}function:consumer:consume`;

        await createService(svcEmitter, 'orders-emitter');
        await createService(svcConsumer, 'orders-consumer');
        await createFunctionInService(fnEmitter, svcEmitter, 'emit');
        await createFunctionInService(fnConsumer, svcConsumer, 'consume');
        await seedBroker();
        await linkServiceConnectsToBroker(svcEmitter, BROKER_URN, 'RABBITMQ_HOST', COMMIT);
        await linkServiceConnectsToBroker(svcConsumer, BROKER_URN, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'reconcile.test.order.placed', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'logical', confidence: 0.7, grounding: astGrounding('test-setup@v1') },
        );
        // Stamp `discoverySource = 'config'` so the autopromoter's Fix 6bis
        // corroboration check sees structural backing and does NOT mark the
        // promoted physical as `needsReview = true`. Without it, the tech
        // welder skips the channel (its guard excludes needsReview rows).
        {
            const s = getNeo4jSession();
            try {
                await s.run(
                    `MATCH (l:MessageChannel {id: $id}) SET l.discoverySource = 'config'`,
                    { id: logicalUrn },
                );
            } finally { await s.close(); }
        }
        await linkFunctionPublishesTo(fnEmitter, logicalUrn, COMMIT, {
            routingKey: 'order.placed.v1', grounding: astGrounding('test-setup@v1'),
        });
        await linkFunctionListensTo(fnConsumer, logicalUrn, COMMIT, {
            consumerGroup: 'orders-consumer', ackMode: 'manual',
            grounding: astGrounding('test-setup@v1'),
        });

        const result = await runReconcile({ repos: [], commitHash: COMMIT });
        expect(result.autopromote.promoted).toBeGreaterThanOrEqual(1);
        expect(result.technologyWeld.welded).toBeGreaterThanOrEqual(1);

        // The physical channel exists with @<fingerprint> suffix and carries
        // the broker's provider as its technology label.
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (ch:MessageChannel)
                 WHERE ch.name = 'reconcile.test.order.placed' AND ch.scope = 'physical'
                 RETURN ch.id AS id, ch.technology AS tech, ch.brokerUrn AS bu`,
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('tech')).toBe('rabbitmq');
            expect(r.records[0].get('bu')).toBe(BROKER_URN);
        } finally { await s.close(); }
    });

    it('cross-kind dedup runs unconditionally inside reconcile (no dynamic-stub gate)', async () => {
        // Seed: topic + queue with the same name, both touched by the same
        // service. Cross-kind dedup must merge them in a single reconcile.
        const svc = `${PFX}service:cross`;
        const fnPub = `${PFX}function:cross:pub`;
        const fnCon = `${PFX}function:cross:con`;
        await createService(svc, 'cross-kind');
        await createFunctionInService(fnPub, svc, 'pub');
        await createFunctionInService(fnCon, svc, 'con');

        const topicUrn = await mergeMessageChannelWithKind(
            'reconcile.test.order.shipped', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', confidence: 0.9, grounding: astGrounding('test-setup@v1') },
        );
        const queueUrn = await mergeMessageChannelWithKind(
            'reconcile.test.order.shipped', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', confidence: 0.9, grounding: astGrounding('test-setup@v1') },
        );
        await linkFunctionPublishesTo(fnPub, topicUrn, COMMIT, { grounding: astGrounding('test-setup@v1') });
        await linkFunctionListensTo(fnCon, queueUrn, COMMIT, { grounding: astGrounding('test-setup@v1') });

        const result = await runReconcile({ repos: [], commitHash: COMMIT });
        expect(result.crossKindDedup.merged).toBeGreaterThanOrEqual(1);

        // Surviving topic carries the cross-kind-weld extractor stamp; queue is gone.
        const s = getNeo4jSession();
        try {
            const rTopic = await s.run(
                `MATCH (ch:MessageChannel {id: $id})
                 RETURN ch.evidence_extractors AS ext, ch.source AS src`,
                { id: topicUrn },
            );
            expect(rTopic.records[0].get('ext')).toContain('cross-kind-weld@v1');
            expect(rTopic.records[0].get('src')).toBe('composite');
            const rQueue = await s.run(
                `MATCH (ch:MessageChannel {id: $id}) RETURN count(ch) AS n`,
                { id: queueUrn },
            );
            expect(Number(rQueue.records[0].get('n'))).toBe(0);
        } finally { await s.close(); }
    });

    it('idempotent: a second runReconcile on the same graph is a no-op', async () => {
        // Reuse the cross-kind seed.
        const svc = `${PFX}service:idem`;
        const fnPub = `${PFX}function:idem:pub`;
        const fnCon = `${PFX}function:idem:con`;
        await createService(svc, 'idem');
        await createFunctionInService(fnPub, svc, 'pub');
        await createFunctionInService(fnCon, svc, 'con');

        const topicUrn = await mergeMessageChannelWithKind(
            'reconcile.test.idem', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', confidence: 0.9, grounding: astGrounding('test-setup@v1') },
        );
        const queueUrn = await mergeMessageChannelWithKind(
            'reconcile.test.idem', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', confidence: 0.9, grounding: astGrounding('test-setup@v1') },
        );
        await linkFunctionPublishesTo(fnPub, topicUrn, COMMIT, { grounding: astGrounding('test-setup@v1') });
        await linkFunctionListensTo(fnCon, queueUrn, COMMIT, { grounding: astGrounding('test-setup@v1') });

        const first = await runReconcile({ repos: [], commitHash: COMMIT });
        expect(first.crossKindDedup.merged).toBeGreaterThanOrEqual(1);

        const second = await runReconcile({ repos: [], commitHash: COMMIT });
        // Counters that report DOING work are all zero on the second pass.
        expect(second.crossKindDedup.merged).toBe(0);
        expect(second.suffixDedup.welded).toBe(0);
        // Aggregator counters (channelAliases.logicalChannels reports what is
        // currently declared in the registry, not what changed) may be > 0;
        // we don't assert on those.
    });
});
