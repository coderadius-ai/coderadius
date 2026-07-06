import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { deduplicateMessageChannelsByExactNameDifferentKind } from '../../src/ingestion/processors/dynamic-infra-resolver.js';

// Fix 4: cross-kind dedup. AMQP semantics: a publisher emits to an exchange
// (kind=topic) and a consumer binds a queue (kind=queue) or subscription. When
// the routing key and queue name match (the conventional Symfony Messenger
// setup), the static analyzer extracts them as separate nodes with different
// channelKinds. This pass welds them into a single canonical node.
//
// Idempotence: evidence_mergedFrom is append-only. Running the welder twice on an
// already-merged graph must NOT duplicate the evidence_mergedFrom entries.

describe('deduplicateMessageChannelsByExactNameDifferentKind', () => {
    const PFX = 'cr://test/cross-kind/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally { await s.close(); }
    }

    async function makeService(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = 'TEST', s.valid_to_commit = null`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function makeFunction(id: string, serviceId: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:Function {id: $id})
                 SET f.name = $name, f.valid_from_commit = 'TEST', f.valid_to_commit = null
                 WITH f MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:CONTAINS]->(f)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { id, sid: serviceId, name },
            );
        } finally { await s.close(); }
    }

    async function makeChannel(id: string, name: string, channelKind: string, extra: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (c:MessageChannel {id: $id})
                 SET c.name = $name,
                     c.channelKind = $kind,
                     c.technology = $technology,
                     c.kindFamily = $kindFamily,
                     c.brokerUrn = $brokerUrn,
                     c.valid_from_commit = 'TEST',
                     c.valid_to_commit = null`,
                {
                    id, name,
                    kind: channelKind,
                    technology: extra.technology ?? null,
                    kindFamily: extra.kindFamily ?? null,
                    brokerUrn: extra.brokerUrn ?? null,
                },
            );
        } finally { await s.close(); }
    }

    async function makeBroker(id: string, opts: { needsReview?: boolean } = {}) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (b:MessageBroker {id: $id})
                 SET b.provider = 'rabbitmq', b.fingerprint = 'testfp',
                     b.needsReview = $needsReview,
                     b.valid_from_commit = 'TEST', b.valid_to_commit = null`,
                { id, needsReview: opts.needsReview ?? null },
            );
        } finally { await s.close(); }
    }

    async function publishesTo(funcId: string, channelId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (f:Function {id: $fid}), (c:MessageChannel {id: $cid})
                 MERGE (f)-[r:PUBLISHES_TO]->(c)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: funcId, cid: channelId },
            );
        } finally { await s.close(); }
    }

    async function listensTo(funcId: string, channelId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (f:Function {id: $fid}), (c:MessageChannel {id: $cid})
                 MERGE (f)-[r:LISTENS_TO]->(c)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: funcId, cid: channelId },
            );
        } finally { await s.close(); }
    }

    async function readChannel(id: string): Promise<Record<string, unknown> | null> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (c:MessageChannel {id: $id})
                 RETURN c.name AS name, c.channelKind AS kind, c.technology AS tech,
                        c.kindFamily AS kindFamily,
                        c.source AS source,
                        c.evidence_mergedFrom AS evidence_mergedFrom,
                        c.evidence_extractors AS evidence_extractors`,
                { id },
            );
            if (r.records.length === 0) return null;
            const rec = r.records[0];
            return {
                name: rec.get('name'),
                kind: rec.get('kind'),
                tech: rec.get('tech'),
                kindFamily: rec.get('kindFamily'),
                source: rec.get('source'),
                evidence_mergedFrom: rec.get('evidence_mergedFrom'),
                evidence_extractors: rec.get('evidence_extractors'),
            };
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('merges (topic, X) + (subscription, X) in same service into one node, kind=topic', async () => {
        const svcId = `${PFX}svc/A`;
        const fnPubId = `${PFX}func/Pub.send`;
        const fnConId = `${PFX}func/Con.__invoke`;
        const topicId = `${PFX}channel/topic/acme.inventory.quote.requested`;
        const subId = `${PFX}channel/sub/acme.inventory.quote.requested`;

        await makeService(svcId, 'A');
        await makeFunction(fnPubId, svcId, 'Pub.send');
        await makeFunction(fnConId, svcId, 'Con.__invoke');
        await makeChannel(topicId, 'acme.inventory.quote.requested', 'topic');
        await makeChannel(subId, 'acme.inventory.quote.requested', 'subscription');
        await publishesTo(fnPubId, topicId);
        await listensTo(fnConId, subId);

        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(1);

        expect(await readChannel(subId)).toBeNull();
        const topic = await readChannel(topicId);
        expect(topic).not.toBeNull();
        expect(topic!.kind).toBe('topic');

        const s = getNeo4jSession();
        try {
            const edges = await s.run(
                `MATCH (f:Function)-[r:PUBLISHES_TO|LISTENS_TO]->(c:MessageChannel {id: $id})
                 RETURN f.id AS fid, type(r) AS rtype ORDER BY fid`,
                { id: topicId },
            );
            const out = edges.records.map(r => ({ fid: r.get('fid'), rtype: r.get('rtype') }));
            expect(out).toHaveLength(2);
            expect(out).toContainEqual({ fid: fnPubId, rtype: 'PUBLISHES_TO' });
            expect(out).toContainEqual({ fid: fnConId, rtype: 'LISTENS_TO' });
        } finally { await s.close(); }
    });

    it('merges (topic, X) + (queue, X) the same way', async () => {
        const svcId = `${PFX}svc/B`;
        const fnPubId = `${PFX}func/Pub.send`;
        const fnConId = `${PFX}func/Con.__invoke`;
        const topicId = `${PFX}channel/topic/acme.orders.placed`;
        const queueId = `${PFX}channel/queue/acme.orders.placed`;

        await makeService(svcId, 'B');
        await makeFunction(fnPubId, svcId, 'Pub.send');
        await makeFunction(fnConId, svcId, 'Con.__invoke');
        await makeChannel(topicId, 'acme.orders.placed', 'topic');
        await makeChannel(queueId, 'acme.orders.placed', 'queue');
        await publishesTo(fnPubId, topicId);
        await listensTo(fnConId, queueId);

        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(1);
        expect(await readChannel(queueId)).toBeNull();
        const topic = await readChannel(topicId);
        expect(topic!.kind).toBe('topic');
    });

    it('records evidence_mergedFrom = [<sub-id>] on the surviving topic after weld', async () => {
        const svcId = `${PFX}svc/C`;
        const fnPubId = `${PFX}func/Pub.send`;
        const fnConId = `${PFX}func/Con.__invoke`;
        const topicId = `${PFX}channel/topic/acme.X`;
        const subId = `${PFX}channel/sub/acme.X`;

        await makeService(svcId, 'C');
        await makeFunction(fnPubId, svcId, 'Pub.send');
        await makeFunction(fnConId, svcId, 'Con.__invoke');
        await makeChannel(topicId, 'acme.X', 'topic');
        await makeChannel(subId, 'acme.X', 'subscription');
        await publishesTo(fnPubId, topicId);
        await listensTo(fnConId, subId);

        await deduplicateMessageChannelsByExactNameDifferentKind();
        const topic = await readChannel(topicId);
        expect(topic!.evidence_mergedFrom).toContain(subId);
        // Welder stamps composite source + appends the cross-kind-weld@v1 extractor.
        expect(topic!.source).toBe('composite');
        expect(topic!.evidence_extractors).toContain('cross-kind-weld@v1');
    });

    it('idempotent: running the welder twice does NOT duplicate evidence_mergedFrom', async () => {
        const svcId = `${PFX}svc/D`;
        const fnPubId = `${PFX}func/Pub.send`;
        const fnConId = `${PFX}func/Con.__invoke`;
        const topicId = `${PFX}channel/topic/acme.Y`;
        const subId = `${PFX}channel/sub/acme.Y`;

        await makeService(svcId, 'D');
        await makeFunction(fnPubId, svcId, 'Pub.send');
        await makeFunction(fnConId, svcId, 'Con.__invoke');
        await makeChannel(topicId, 'acme.Y', 'topic');
        await makeChannel(subId, 'acme.Y', 'subscription');
        await publishesTo(fnPubId, topicId);
        await listensTo(fnConId, subId);

        await deduplicateMessageChannelsByExactNameDifferentKind();
        const first = await readChannel(topicId);
        await deduplicateMessageChannelsByExactNameDifferentKind();
        const second = await readChannel(topicId);

        expect(second!.evidence_mergedFrom).toEqual(first!.evidence_mergedFrom);
    });

    it('does NOT merge across different services (cross-service same name is independent)', async () => {
        const svcAId = `${PFX}svc/E1`;
        const svcBId = `${PFX}svc/E2`;
        const fnAId = `${PFX}func/A.send`;
        const fnBId = `${PFX}func/B.recv`;
        const topicId = `${PFX}channel/topic/global.event`;
        const subId = `${PFX}channel/sub/global.event`;

        await makeService(svcAId, 'E1');
        await makeService(svcBId, 'E2');
        await makeFunction(fnAId, svcAId, 'A.send');
        await makeFunction(fnBId, svcBId, 'B.recv');
        await makeChannel(topicId, 'global.event', 'topic');
        await makeChannel(subId, 'global.event', 'subscription');
        await publishesTo(fnAId, topicId);
        await listensTo(fnBId, subId);

        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(0);
        expect(await readChannel(subId)).not.toBeNull();
        expect(await readChannel(topicId)).not.toBeNull();
    });

    it('does NOT merge when only one node exists with that name (single node, no pair)', async () => {
        const svcId = `${PFX}svc/F`;
        const fnPubId = `${PFX}func/Pub.send`;
        const topicId = `${PFX}channel/topic/acme.solo`;

        await makeService(svcId, 'F');
        await makeFunction(fnPubId, svcId, 'Pub.send');
        await makeChannel(topicId, 'acme.solo', 'topic');
        await publishesTo(fnPubId, topicId);

        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(0);
        expect(await readChannel(topicId)).not.toBeNull();
    });

    it('preserves technology and kindFamily from the merged node onto the canonical', async () => {
        const svcId = `${PFX}svc/G`;
        const fnPubId = `${PFX}func/Pub.send`;
        const fnConId = `${PFX}func/Con.__invoke`;
        const topicId = `${PFX}channel/topic/acme.X.Y`;
        const subId = `${PFX}channel/sub/acme.X.Y`;

        await makeService(svcId, 'G');
        await makeFunction(fnPubId, svcId, 'Pub.send');
        await makeFunction(fnConId, svcId, 'Con.__invoke');
        await makeChannel(topicId, 'acme.X.Y', 'topic'); // no tech
        await makeChannel(subId, 'acme.X.Y', 'subscription', { technology: 'rabbitmq', kindFamily: 'broker' });
        await publishesTo(fnPubId, topicId);
        await listensTo(fnConId, subId);

        await deduplicateMessageChannelsByExactNameDifferentKind();
        const topic = await readChannel(topicId);
        expect(topic!.tech).toBe('rabbitmq');
        expect(topic!.kindFamily).toBe('broker');
    });

    // Fix infra-derived merge: when the subordinate (queue/sub) comes from an
    // infra ingest (`discoverySource = 'config'`) there is no Service edge on
    // its side (only `cr analyze code` writes Function nodes). The shared-
    // Service guard must be skipped in this case otherwise the topology
    // declaration never collapses the code-side topic onto its queue.
    it('merges code-topic into infra-derived queue (no shared Service required when discoverySource=config)', async () => {
        const svcId = `${PFX}svc/H`;
        const fnPubId = `${PFX}func/H.send`;
        const topicId = `${PFX}channel/topic/acme.order.placed`;
        const queueId = `${PFX}channel/queue/acme.order.placed`;

        await makeService(svcId, 'H');
        await makeFunction(fnPubId, svcId, 'H.send');
        await makeChannel(topicId, 'acme.order.placed', 'topic');
        await makeChannel(queueId, 'acme.order.placed', 'queue');
        // No publishesTo / listensTo from any Service to the queue (typical
        // of an infra-only emit). Tag the queue as infra-derived.
        const s = getNeo4jSession();
        try {
            await s.run(`MATCH (c:MessageChannel {id: $id}) SET c.discoverySource = 'config'`, { id: queueId });
        } finally { await s.close(); }
        await publishesTo(fnPubId, topicId);

        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(1);
        expect(await readChannel(queueId)).toBeNull();
        const topic = await readChannel(topicId);
        expect(topic!.kind).toBe('topic');
    });

    // ─── Cross-service path: shared CLEAN physical broker is the identity ───
    // Third acceptance path (broker-grounded discovery): same exact name,
    // topic↔subscription/queue, brokerUrn NON-NULL on BOTH sides and equal,
    // and the shared broker is NOT needsReview. The broker parity replaces
    // the shared-Service multi-tenant guard; a guess-born broker must never
    // become load-bearing for a cross-service weld.

    async function seedCrossServicePair(tag: string, opts: {
        topicBroker: string | null;
        subBroker: string | null;
    }): Promise<{ topicId: string; subId: string; fnAId: string; fnBId: string }> {
        const svcAId = `${PFX}svc/${tag}-A`;
        const svcBId = `${PFX}svc/${tag}-B`;
        const fnAId = `${PFX}func/${tag}-A.send`;
        const fnBId = `${PFX}func/${tag}-B.recv`;
        const topicId = `${PFX}channel/topic/${tag}.event`;
        const subId = `${PFX}channel/sub/${tag}.event`;
        await makeService(svcAId, `${tag}-A`);
        await makeService(svcBId, `${tag}-B`);
        await makeFunction(fnAId, svcAId, 'A.send');
        await makeFunction(fnBId, svcBId, 'B.recv');
        await makeChannel(topicId, `${tag}.event`, 'topic', { brokerUrn: opts.topicBroker });
        await makeChannel(subId, `${tag}.event`, 'subscription', { brokerUrn: opts.subBroker });
        await publishesTo(fnAId, topicId);
        await listensTo(fnBId, subId);
        return { topicId, subId, fnAId, fnBId };
    }

    it('cross-service + SAME clean broker → merges into one channel carrying both edges', async () => {
        const brokerId = `${PFX}broker/clean`;
        await makeBroker(brokerId);
        const { topicId, subId, fnAId, fnBId } = await seedCrossServicePair('xsvc-clean', {
            topicBroker: brokerId, subBroker: brokerId,
        });

        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(1);
        expect(await readChannel(subId)).toBeNull();
        const topic = await readChannel(topicId);
        expect(topic).not.toBeNull();
        expect(topic!.source).toBe('composite');

        const s = getNeo4jSession();
        try {
            const edges = await s.run(
                `MATCH (f:Function)-[r:PUBLISHES_TO|LISTENS_TO]->(c:MessageChannel {id: $id})
                 RETURN f.id AS fid, type(r) AS rtype ORDER BY fid`,
                { id: topicId },
            );
            const out = edges.records.map(r => ({ fid: r.get('fid'), rtype: r.get('rtype') }));
            expect(out).toContainEqual({ fid: fnAId, rtype: 'PUBLISHES_TO' });
            expect(out).toContainEqual({ fid: fnBId, rtype: 'LISTENS_TO' });
        } finally { await s.close(); }
    });

    it('cross-service + brokerUrn null on ONE side → no merge (no coalesce parity)', async () => {
        const brokerId = `${PFX}broker/half`;
        await makeBroker(brokerId);
        const { topicId, subId } = await seedCrossServicePair('xsvc-halfnull', {
            topicBroker: brokerId, subBroker: null,
        });
        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(0);
        expect(await readChannel(topicId)).not.toBeNull();
        expect(await readChannel(subId)).not.toBeNull();
    });

    it('cross-service + DIFFERENT brokers → no merge', async () => {
        const b1 = `${PFX}broker/one`;
        const b2 = `${PFX}broker/two`;
        await makeBroker(b1);
        await makeBroker(b2);
        const { topicId, subId } = await seedCrossServicePair('xsvc-diff', {
            topicBroker: b1, subBroker: b2,
        });
        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(0);
        expect(await readChannel(topicId)).not.toBeNull();
        expect(await readChannel(subId)).not.toBeNull();
    });

    it('cross-service + same broker BUT needsReview → no merge (guess never load-bearing)', async () => {
        const brokerId = `${PFX}broker/guessy`;
        await makeBroker(brokerId, { needsReview: true });
        const { topicId, subId } = await seedCrossServicePair('xsvc-guess', {
            topicBroker: brokerId, subBroker: brokerId,
        });
        const result = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(result.merged).toBe(0);
        expect(await readChannel(topicId)).not.toBeNull();
        expect(await readChannel(subId)).not.toBeNull();
    });
});
