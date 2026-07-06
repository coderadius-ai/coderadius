import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeMessageBroker,
    linkServiceConnectsToBroker,
    mergeMessageChannelWithKind,
    linkFunctionPublishesTo,
    linkFunctionListensTo,
} from '../../src/graph/mutations/data-contracts.js';
import { runChannelAutopromote } from '../../src/ingestion/processors/channel-autopromoter.js';
import { astGrounding } from '../../src/graph/grounding.js';

describe('channel-autopromoter — logical → physical when broker is unique', () => {
    const PFX = 'cr://test/channel-autopromote/';
    const COMMIT = 'AUTOPROMOTE_TEST';
    const TEST_DOMAIN = 'autopromote-test.acme.example';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await session.run(`MATCH (n) WHERE n.id STARTS WITH 'cr:service:crtest/autop-repo' DETACH DELETE n`);
            await session.run(`MATCH (n:MessageChannel) WHERE n.name STARTS WITH 'autopromote.test.' DETACH DELETE n`);
            await session.run(`MATCH (n:MessageBroker) WHERE n.host CONTAINS '${TEST_DOMAIN}' DETACH DELETE n`);
        } finally { await session.close(); }
    }

    async function createService(urn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = $c, s.valid_to_commit = null`,
                { id: urn, name, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    async function createFunctionInService(fnUrn: string, serviceUrn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (f:Function {id: $fid})
                 SET f.name = $name, f.valid_from_commit = $c, f.valid_to_commit = null
                 WITH f MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:CONTAINS]->(f)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { fid: fnUrn, sid: serviceUrn, name, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    it('promotes a logical channel when all callers converge on a single broker', async () => {
        // Setup: 2 service, ognuno connesso allo stesso :MessageBroker.
        // Una Function publishes_to "order.created" (logical), un'altra listens_to.
        const svcEmitterUrn = `${PFX}service:orders-emitter`;
        const svcConsumerUrn = `${PFX}service:orders-consumer`;
        const fnEmitterUrn = `${PFX}function:orders-emitter:emit`;
        const fnConsumerUrn = `${PFX}function:orders-consumer:consume`;
        const brokerUrn = 'cr:broker:rabbitmq:apt99001:orders';

        await createService(svcEmitterUrn, 'orders-emitter');
        await createService(svcConsumerUrn, 'orders-consumer');
        await createFunctionInService(fnEmitterUrn, svcEmitterUrn, 'emit');
        await createFunctionInService(fnConsumerUrn, svcConsumerUrn, 'consume');

        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'apt99001',
            declaredVia: 'inferred', host: `rabbitmq.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
            grounding: astGrounding('synthesize-message-brokers@v1'),
        }, COMMIT);
        await linkServiceConnectsToBroker(svcEmitterUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);
        await linkServiceConnectsToBroker(svcConsumerUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        // Logical channel + Function edges
        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.order.created', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnEmitterUrn, logicalUrn, COMMIT, {
            routingKey: 'order.created.v1',
            grounding: astGrounding('test-setup@v1'),
        });
        await linkFunctionListensTo(fnConsumerUrn, logicalUrn, COMMIT, {
            consumerGroup: 'orders-consumer-group',
            ackMode: 'manual',
            grounding: astGrounding('test-setup@v1'),
        });

        // ── Run autopromoter
        const result = await runChannelAutopromote(COMMIT);
        expect(result.promoted).toBeGreaterThanOrEqual(1);
        expect(result.ambiguous).toBe(0);

        const session = getNeo4jSession();
        try {
            // Physical channel exists with URN suffix @apt99001
            const r1 = await session.run(
                `MATCH (ch:MessageChannel) WHERE ch.name = 'autopromote.test.order.created' AND ch.scope = 'physical'
                 RETURN ch.id AS id, ch.brokerUrn AS bu`,
            );
            expect(r1.records).toHaveLength(1);
            const physicalUrn = r1.records[0].get('id') as string;
            expect(physicalUrn).toBe('cr:channel:topic:autopromote.test.order.created@apt99001');
            expect(r1.records[0].get('bu')).toBe(brokerUrn);

            // Logical channel still exists (not deleted)
            const r2 = await session.run(
                `MATCH (ch:MessageChannel {id: $id}) RETURN ch.scope AS s`,
                { id: logicalUrn },
            );
            expect(r2.records[0].get('s')).toBe('logical');

            // MANIFESTS_AS edge logical → physical
            const r3 = await session.run(
                `MATCH (l:MessageChannel {id: $lid})-[r:MANIFESTS_AS]->(p:MessageChannel {id: $pid})
                 RETURN count(r) AS n`,
                { lid: logicalUrn, pid: physicalUrn },
            );
            expect(Number(r3.records[0].get('n'))).toBe(1);

            // Physical has HOSTED_ON broker
            const r4 = await session.run(
                `MATCH (p:MessageChannel {id: $pid})-[:HOSTED_ON]->(b:MessageBroker)
                 RETURN b.id AS bid`,
                { pid: physicalUrn },
            );
            expect(r4.records[0].get('bid')).toBe(brokerUrn);

            // PUBLISHES_TO/LISTENS_TO present on PHYSICAL (welded) with original edge props preserved
            const r5 = await session.run(
                `MATCH (:Function {id: $fid})-[rel:PUBLISHES_TO]->(p:MessageChannel {id: $pid})
                 RETURN rel.routingKey AS rk, rel.brokerScopeConfidence AS bsc`,
                { fid: fnEmitterUrn, pid: physicalUrn },
            );
            expect(r5.records[0].get('rk')).toBe('order.created.v1');
            expect(['high', 'medium', 'declared', 'auto-promoted', 'inferred']).toContain(r5.records[0].get('bsc'));

            const r6 = await session.run(
                `MATCH (:Function {id: $fid})-[rel:LISTENS_TO]->(p:MessageChannel {id: $pid})
                 RETURN rel.consumerGroup AS cg, rel.ackMode AS am`,
                { fid: fnConsumerUrn, pid: physicalUrn },
            );
            expect(r6.records[0].get('cg')).toBe('orders-consumer-group');
            expect(r6.records[0].get('am')).toBe('manual');

            // Old edges on LOGICAL channel tombstoned (valid_to_commit set), not DELETE
            const r7 = await session.run(
                `MATCH (:Function {id: $fid})-[rel:PUBLISHES_TO]->(l:MessageChannel {id: $lid})
                 RETURN rel.valid_to_commit AS tomb`,
                { fid: fnEmitterUrn, lid: logicalUrn },
            );
            expect(r7.records).toHaveLength(1);
            expect(r7.records[0].get('tomb')).toBe(COMMIT);
        } finally { await session.close(); }
    });

    it('does NOT promote when 2 different brokers are bound to the publishing services', async () => {
        const svcAUrn = `${PFX}service:svc-a`;
        const svcBUrn = `${PFX}service:svc-b`;
        const fnAUrn = `${PFX}function:svc-a:fn`;
        const fnBUrn = `${PFX}function:svc-b:fn`;
        const brokerAUrn = 'cr:broker:rabbitmq:abi11111:orders';
        const brokerBUrn = 'cr:broker:rabbitmq:abi22222:orders';

        await createService(svcAUrn, 'svc-a');
        await createService(svcBUrn, 'svc-b');
        await createFunctionInService(fnAUrn, svcAUrn, 'fn');
        await createFunctionInService(fnBUrn, svcBUrn, 'fn');

        await mergeMessageBroker({
            urn: brokerAUrn, provider: 'rabbitmq', fingerprint: 'abi11111',
            declaredVia: 'inferred', host: `rabbitmq.a.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await mergeMessageBroker({
            urn: brokerBUrn, provider: 'rabbitmq', fingerprint: 'abi22222',
            declaredVia: 'inferred', host: `rabbitmq.b.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcAUrn, brokerAUrn, 'RABBITMQ_HOST', COMMIT);
        await linkServiceConnectsToBroker(svcBUrn, brokerBUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.ambiguous', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnAUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });
        await linkFunctionPublishesTo(fnBUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        const result = await runChannelAutopromote(COMMIT);
        expect(result.promoted).toBe(0);
        expect(result.ambiguous).toBeGreaterThanOrEqual(1);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel)
                 WHERE ch.name = 'autopromote.test.ambiguous' AND ch.scope = 'physical'
                 RETURN count(ch) AS n`,
            );
            expect(Number(r.records[0].get('n'))).toBe(0);
        } finally { await session.close(); }
    });

    it('idempotent: calling autopromoter twice does not duplicate edges or untombstone', async () => {
        const svcUrn = `${PFX}service:svc-idem`;
        const fnUrn = `${PFX}function:svc-idem:fn`;
        const brokerUrn = 'cr:broker:rabbitmq:idmpot00:orders';

        await createService(svcUrn, 'svc-idem');
        await createFunctionInService(fnUrn, svcUrn, 'fn');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'idmpot00',
            declaredVia: 'inferred', host: `rabbitmq.idem.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.idempotent', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        const r1 = await runChannelAutopromote(COMMIT);
        const r2 = await runChannelAutopromote(COMMIT);

        const session = getNeo4jSession();
        try {
            // exactly 1 physical channel
            const rPhys = await session.run(
                `MATCH (ch:MessageChannel) WHERE ch.name = 'autopromote.test.idempotent' AND ch.scope = 'physical'
                 RETURN count(ch) AS n`,
            );
            expect(Number(rPhys.records[0].get('n'))).toBe(1);

            // exactly 1 MANIFESTS_AS edge
            const rMan = await session.run(
                `MATCH (l:MessageChannel {id: $lid})-[r:MANIFESTS_AS]->()
                 RETURN count(r) AS n`,
                { lid: logicalUrn },
            );
            expect(Number(rMan.records[0].get('n'))).toBe(1);

            // exactly 1 PUBLISHES_TO edge to PHYSICAL (live)
            const rPubPhys = await session.run(
                `MATCH (:Function {id: $fid})-[rel:PUBLISHES_TO]->(ch:MessageChannel)
                 WHERE ch.scope = 'physical' AND rel.valid_to_commit IS NULL
                 RETURN count(rel) AS n`,
                { fid: fnUrn },
            );
            expect(Number(rPubPhys.records[0].get('n'))).toBe(1);

            // PUBLISHES_TO to LOGICAL tombstoned (1 tombstoned, 0 live)
            const rPubLog = await session.run(
                `MATCH (:Function {id: $fid})-[rel:PUBLISHES_TO]->(ch:MessageChannel {id: $lid})
                 RETURN rel.valid_to_commit AS tomb`,
                { fid: fnUrn, lid: logicalUrn },
            );
            expect(rPubLog.records).toHaveLength(1);
            expect(rPubLog.records[0].get('tomb')).toBe(COMMIT);
        } finally { await session.close(); }

        // Both runs report consistent counts (run 2 is a no-op)
        expect(r1.promoted).toBeGreaterThanOrEqual(1);
        expect(r2.promoted).toBeGreaterThanOrEqual(0); // ok 0 = idempotent, or 1 if it returns "would have promoted"
    });

    // ─── Fix 1 — Collapse logical/physical post-autopromote ──────────────────
    // The autopromoter MUST tombstone the logical node when all incoming
    // PUBLISHES_TO/LISTENS_TO have been moved to the physical, OR mark it
    // as needsReview-with-purpose when a DataContract attaches to it (G2).
    // This prevents the T2 transitive duplicate observed in the orchestrator
    // dashboard.

    it('tombstones the logical channel after all edges are moved', async () => {
        const svcUrn = `${PFX}service:tomb-svc`;
        const fnUrn = `${PFX}function:tomb-svc:fn`;
        const brokerUrn = 'cr:broker:rabbitmq:tomb0001:orders';

        await createService(svcUrn, 'tomb-svc');
        await createFunctionInService(fnUrn, svcUrn, 'fn');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'tomb0001',
            declaredVia: 'inferred', host: `rabbitmq.tomb.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.tombstone', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        await runChannelAutopromote(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (l:MessageChannel {id: $lid})
                 RETURN l.valid_to_commit AS tomb, l.tombstoned_by AS by`,
                { lid: logicalUrn },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('tomb')).toBe(COMMIT);
            expect(r.records[0].get('by')).toBe('auto-promote');
        } finally { await session.close(); }
    });

    it('preserves logical with attached DataContract as schema-anchor (needsReview)', async () => {
        const svcUrn = `${PFX}service:schema-svc`;
        const fnUrn = `${PFX}function:schema-svc:fn`;
        const brokerUrn = 'cr:broker:rabbitmq:schma001:orders';
        const contractUrn = `${PFX}contract:OrderPlaced`;

        await createService(svcUrn, 'schema-svc');
        await createFunctionInService(fnUrn, svcUrn, 'fn');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'schma001',
            declaredVia: 'inferred', host: `rabbitmq.schma.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.schema-anchor', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        // Attach a DataContract via DESCRIBES (semantically: this payload schema
        // is described by the contract, the contract lives on the logical).
        const session1 = getNeo4jSession();
        try {
            await session1.run(
                `CREATE (dc:DataContract {id: $cid})
                 SET dc.name = 'OrderPlaced', dc.valid_from_commit = $c, dc.valid_to_commit = null
                 WITH dc MATCH (l:MessageChannel {id: $lid})
                 MERGE (dc)-[r:DESCRIBES]->(l)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { cid: contractUrn, lid: logicalUrn, c: COMMIT },
            );
        } finally { await session1.close(); }

        await runChannelAutopromote(COMMIT);

        const session2 = getNeo4jSession();
        try {
            const r = await session2.run(
                `MATCH (l:MessageChannel {id: $lid})
                 RETURN l.valid_to_commit AS tomb, l.purpose AS purpose, l.needsReview AS needs,
                        l.evidence_extractors AS ext`,
                { lid: logicalUrn },
            );
            expect(r.records).toHaveLength(1);
            // Logical survives (no tombstone) because a DataContract describes it.
            expect(r.records[0].get('tomb')).toBeNull();
            expect(r.records[0].get('purpose')).toBe('schema-anchor');
            expect(r.records[0].get('needs')).toBe(true);
            const extractors = r.records[0].get('ext') as string[] | null;
            expect(extractors).toContain('channel-autopromoter-schema-anchor@v1');

            // DataContract still attached.
            const rDc = await session2.run(
                `MATCH (dc:DataContract {id: $cid})-[r:DESCRIBES]->(l:MessageChannel {id: $lid})
                 WHERE r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { cid: contractUrn, lid: logicalUrn },
            );
            expect(Number(rDc.records[0].get('n'))).toBe(1);
        } finally { await session2.close(); }
    });

    // ─── Fix 6 — CARRIED_BY migrate to physical (NOT preserve logical) ──────

    it('Fix 6: migrates DataStructure CARRIED_BY to physical, tombstones logical', async () => {
        const svcUrn = `${PFX}service:carry-svc`;
        const fnUrn = `${PFX}function:carry-svc:fn`;
        const brokerUrn = 'cr:broker:rabbitmq:carry001:orders';
        const dsAUrn = `${PFX}datastructure:CarryA`;
        const dsBUrn = `${PFX}datastructure:CarryB`;

        await createService(svcUrn, 'carry-svc');
        await createFunctionInService(fnUrn, svcUrn, 'fn');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'carry001',
            declaredVia: 'inferred', host: `rabbitmq.carry.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.carried-by-migrate', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        // Attach 2 DataStructure via CARRIED_BY to the logical channel.
        const s1 = getNeo4jSession();
        try {
            await s1.run(
                `UNWIND [$a, $b] AS dsId
                 CREATE (ds:DataStructure {id: dsId})
                 SET ds.valid_from_commit = $c, ds.valid_to_commit = null
                 WITH ds, dsId
                 MATCH (l:MessageChannel {id: $lid})
                 MERGE (ds)-[r:CARRIED_BY]->(l)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { a: dsAUrn, b: dsBUrn, lid: logicalUrn, c: COMMIT },
            );
        } finally { await s1.close(); }

        await runChannelAutopromote(COMMIT);

        const s2 = getNeo4jSession();
        try {
            // 2 CARRIED_BY ATTIVI su physical (migrated).
            const rPhys = await s2.run(
                `MATCH (ds:DataStructure)-[r:CARRIED_BY]->(p:MessageChannel)
                 WHERE ds.id IN [$a, $b] AND p.name = 'autopromote.test.carried-by-migrate' AND p.scope = 'physical'
                   AND r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { a: dsAUrn, b: dsBUrn },
            );
            expect(Number(rPhys.records[0].get('n'))).toBe(2);

            // 0 CARRIED_BY ATTIVI su logical, ma le vecchie tombstonate.
            const rLogActive = await s2.run(
                `MATCH (ds:DataStructure)-[r:CARRIED_BY]->(l:MessageChannel {id: $lid})
                 WHERE ds.id IN [$a, $b] AND r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { a: dsAUrn, b: dsBUrn, lid: logicalUrn },
            );
            expect(Number(rLogActive.records[0].get('n'))).toBe(0);

            // Lineage tombstone proof: old CARRIED_BY su logical have valid_to_commit = $commit.
            const rLogTomb = await s2.run(
                `MATCH (ds:DataStructure)-[r:CARRIED_BY]->(l:MessageChannel {id: $lid})
                 WHERE ds.id IN [$a, $b]
                 RETURN collect(r.valid_to_commit) AS tombs`,
                { a: dsAUrn, b: dsBUrn, lid: logicalUrn },
            );
            const tombs = rLogTomb.records[0].get('tombs') as string[];
            expect(tombs).toHaveLength(2);
            expect(tombs.every(t => t === COMMIT)).toBe(true);

            // Logical tombstoned normalmente (no DataContract attached).
            const rLog = await s2.run(
                `MATCH (l:MessageChannel {id: $lid})
                 RETURN l.valid_to_commit AS tomb, l.tombstoned_by AS by`,
                { lid: logicalUrn },
            );
            expect(rLog.records[0].get('tomb')).toBe(COMMIT);
            expect(rLog.records[0].get('by')).toBe('auto-promote');
        } finally { await s2.close(); }
    });

    it('Fix 6: DataContract AND CARRIED_BY combined — logical schema-anchor, CARRIED_BY migrato', async () => {
        const svcUrn = `${PFX}service:combo-svc`;
        const fnUrn = `${PFX}function:combo-svc:fn`;
        const brokerUrn = 'cr:broker:rabbitmq:combo001:orders';
        const dcUrn = `${PFX}contract:ComboContract`;
        const dsUrn = `${PFX}datastructure:ComboPayload`;

        await createService(svcUrn, 'combo-svc');
        await createFunctionInService(fnUrn, svcUrn, 'fn');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'combo001',
            declaredVia: 'inferred', host: `rabbitmq.combo.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.combo', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        // Attach BOTH DataContract (DESCRIBES) and DataStructure (CARRIED_BY).
        const s1 = getNeo4jSession();
        try {
            await s1.run(
                `CREATE (dc:DataContract {id: $dcId})
                 SET dc.valid_from_commit = $c, dc.valid_to_commit = null
                 WITH dc
                 MATCH (l:MessageChannel {id: $lid})
                 MERGE (dc)-[r:DESCRIBES]->(l)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null
                 WITH l
                 CREATE (ds:DataStructure {id: $dsId})
                 SET ds.valid_from_commit = $c, ds.valid_to_commit = null
                 MERGE (ds)-[r2:CARRIED_BY]->(l)
                 ON CREATE SET r2.valid_from_commit = $c, r2.valid_to_commit = null`,
                { dcId: dcUrn, dsId: dsUrn, lid: logicalUrn, c: COMMIT },
            );
        } finally { await s1.close(); }

        await runChannelAutopromote(COMMIT);

        const s2 = getNeo4jSession();
        try {
            // Logical schema-anchor sopravvive.
            const rLog = await s2.run(
                `MATCH (l:MessageChannel {id: $lid})
                 RETURN l.valid_to_commit AS tomb, l.purpose AS purpose, l.needsReview AS needs`,
                { lid: logicalUrn },
            );
            expect(rLog.records[0].get('tomb')).toBeNull();
            expect(rLog.records[0].get('purpose')).toBe('schema-anchor');
            expect(rLog.records[0].get('needs')).toBe(true);

            // CARRIED_BY migrato al physical (DS segue il transport, NON il contract).
            const rPhys = await s2.run(
                `MATCH (ds:DataStructure {id: $dsId})-[r:CARRIED_BY]->(p:MessageChannel)
                 WHERE p.name = 'autopromote.test.combo' AND p.scope = 'physical'
                   AND r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { dsId: dsUrn },
            );
            expect(Number(rPhys.records[0].get('n'))).toBe(1);

            // 0 CARRIED_BY ATTIVI su logical (migrato anche se logical vive).
            const rLogActive = await s2.run(
                `MATCH (ds:DataStructure {id: $dsId})-[r:CARRIED_BY]->(l:MessageChannel {id: $lid})
                 WHERE r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { dsId: dsUrn, lid: logicalUrn },
            );
            expect(Number(rLogActive.records[0].get('n'))).toBe(0);

            // DataContract still attached al logical (semantica: spec vive lì).
            const rDc = await s2.run(
                `MATCH (dc:DataContract {id: $dcId})-[r:DESCRIBES]->(l:MessageChannel {id: $lid})
                 WHERE r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { dcId: dcUrn, lid: logicalUrn },
            );
            expect(Number(rDc.records[0].get('n'))).toBe(1);
        } finally { await s2.close(); }
    });

    // ─── Fix 6bis — Low-evidence marker on physical (no structural corroboration) ─

    it('Fix 6bis: LLM-only logical (no discoverySource=config) → physical gets low-evidence marker', async () => {
        const svcUrn = `${PFX}service:llm-svc`;
        const fnUrn = `${PFX}function:llm-svc:fn`;
        const brokerUrn = 'cr:broker:rabbitmq:llmonly0:orders';

        await createService(svcUrn, 'llm-svc');
        await createFunctionInService(fnUrn, svcUrn, 'fn');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'llmonly0',
            declaredVia: 'inferred', host: `rabbitmq.llmonly.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        // LLM-only logical: no discoverySource property set.
        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.llm-only', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.5 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        await runChannelAutopromote(COMMIT);

        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (p:MessageChannel)
                 WHERE p.name = 'autopromote.test.llm-only' AND p.scope = 'physical'
                 RETURN p.needsReview AS needs, p.evidence_extractors AS ext`,
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('needs')).toBe(true);
            const extractors = r.records[0].get('ext') as string[] | null;
            expect(extractors).toContain('channel-autopromoter-low-evidence@v1');
        } finally { await s.close(); }
    });

    it('Fix 6bis: structural logical (discoverySource=config) does NOT get low-evidence marker', async () => {
        const svcUrn = `${PFX}service:struct-svc`;
        const fnUrn = `${PFX}function:struct-svc:fn`;
        const brokerUrn = 'cr:broker:rabbitmq:struct00:orders';

        await createService(svcUrn, 'struct-svc');
        await createFunctionInService(fnUrn, svcUrn, 'fn');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'struct00',
            declaredVia: 'inferred', host: `rabbitmq.struct.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.structural', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.9 },
        );
        // Mark logical as structural-emitted (config-derived).
        const sSetup = getNeo4jSession();
        try {
            await sSetup.run(
                `MATCH (l:MessageChannel {id: $lid}) SET l.discoverySource = 'config'`,
                { lid: logicalUrn },
            );
        } finally { await sSetup.close(); }
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        await runChannelAutopromote(COMMIT);

        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (p:MessageChannel)
                 WHERE p.name = 'autopromote.test.structural' AND p.scope = 'physical'
                 RETURN p.needsReview AS needs, p.evidence_extractors AS ext`,
            );
            expect(r.records).toHaveLength(1);
            // No low-evidence marker: structural corroboration via discoverySource=config.
            const needs = r.records[0].get('needs');
            expect(needs === true).toBe(false);
            const extractors = (r.records[0].get('ext') as string[] | null) ?? [];
            expect(extractors).not.toContain('channel-autopromoter-low-evidence@v1');
        } finally { await s.close(); }
    });

    it('marks ambiguous logical with needsReview when >1 broker', async () => {
        const svcAUrn = `${PFX}service:amb-a`;
        const svcBUrn = `${PFX}service:amb-b`;
        const fnAUrn = `${PFX}function:amb-a:fn`;
        const fnBUrn = `${PFX}function:amb-b:fn`;
        const brokerAUrn = 'cr:broker:rabbitmq:amba0001:orders';
        const brokerBUrn = 'cr:broker:rabbitmq:ambb0001:orders';

        await createService(svcAUrn, 'amb-a');
        await createService(svcBUrn, 'amb-b');
        await createFunctionInService(fnAUrn, svcAUrn, 'fn');
        await createFunctionInService(fnBUrn, svcBUrn, 'fn');
        await mergeMessageBroker({
            urn: brokerAUrn, provider: 'rabbitmq', fingerprint: 'amba0001',
            declaredVia: 'inferred', host: `rabbitmq.amba.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await mergeMessageBroker({
            urn: brokerBUrn, provider: 'rabbitmq', fingerprint: 'ambb0001',
            declaredVia: 'inferred', host: `rabbitmq.ambb.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);
        await linkServiceConnectsToBroker(svcAUrn, brokerAUrn, 'RABBITMQ_HOST', COMMIT);
        await linkServiceConnectsToBroker(svcBUrn, brokerBUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.amb-needs-review', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnAUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });
        await linkFunctionPublishesTo(fnBUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        await runChannelAutopromote(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (l:MessageChannel {id: $lid})
                 RETURN l.valid_to_commit AS tomb, l.needsReview AS needs,
                        l.evidence_extractors AS ext`,
                { lid: logicalUrn },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('tomb')).toBeNull();
            expect(r.records[0].get('needs')).toBe(true);
            const extractors = r.records[0].get('ext') as string[] | null;
            expect(extractors).toContain('channel-autopromoter-ambiguous@v1');
        } finally { await session.close(); }
    });

    it('does NOT promote an uncorroborated CQRS class name — tombstones the phantom', async () => {
        const svcUrn = `${PFX}service:phantom-emitter`;
        const fnUrn = `${PFX}function:phantom-emitter:emit`;
        const brokerUrn = 'cr:broker:rabbitmq:apt77001:orders';
        const PHANTOM = 'TestAutopromotePhantomEvent';

        // CQRS names don't match the prefix-based wipe — self-clean by name.
        const pre = getNeo4jSession();
        try { await pre.run('MATCH (c:MessageChannel) WHERE c.name = $n DETACH DELETE c', { n: PHANTOM }); }
        finally { await pre.close(); }

        await createService(svcUrn, 'phantom-emitter');
        await createFunctionInService(fnUrn, svcUrn, 'emit');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'apt77001',
            declaredVia: 'inferred', host: `rabbitmq.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
            grounding: astGrounding('synthesize-message-brokers@v1'),
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        // Logical CQRS class name, LLM-emitted (no discoverySource='config').
        const logicalUrn = await mergeMessageChannelWithKind(
            PHANTOM, 'topic', 'unknown', COMMIT, { scope: 'logical', confidence: 0.5 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        const result = await runChannelAutopromote(COMMIT);
        expect(result.messageClassPhantom).toBeGreaterThanOrEqual(1);

        const session = getNeo4jSession();
        try {
            const phys = await session.run(
                `MATCH (c:MessageChannel) WHERE c.name = $n AND c.scope = 'physical' AND c.valid_to_commit IS NULL RETURN count(c) AS n`,
                { n: PHANTOM });
            expect(Number(phys.records[0].get('n'))).toBe(0);

            const log = await session.run(
                `MATCH (l:MessageChannel {id: $lid}) RETURN l.valid_to_commit AS tomb, l.tombstoned_by AS by, l.evidence_extractors AS ext`,
                { lid: logicalUrn });
            expect(log.records[0].get('tomb')).toBe(COMMIT);
            expect(log.records[0].get('by')).toBe('auto-promote-message-class-phantom');
            expect(log.records[0].get('ext') as string[]).toContain('channel-autopromoter-message-class-phantom@v1');

            await session.run('MATCH (c:MessageChannel) WHERE c.name = $n DETACH DELETE c', { n: PHANTOM });
        } finally { await session.close(); }
    });

    it('DOES promote a CQRS class name when structurally corroborated (config)', async () => {
        const svcUrn = `${PFX}service:corrob-emitter`;
        const fnUrn = `${PFX}function:corrob-emitter:emit`;
        const brokerUrn = 'cr:broker:rabbitmq:apt77002:orders';
        const NAME = 'TestAutopromoteCorroboratedMessage';

        const pre = getNeo4jSession();
        try { await pre.run('MATCH (c:MessageChannel) WHERE c.name = $n DETACH DELETE c', { n: NAME }); }
        finally { await pre.close(); }

        await createService(svcUrn, 'corrob-emitter');
        await createFunctionInService(fnUrn, svcUrn, 'emit');
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'apt77002',
            declaredVia: 'inferred', host: `rabbitmq.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
            grounding: astGrounding('synthesize-message-brokers@v1'),
        }, COMMIT);
        await linkServiceConnectsToBroker(svcUrn, brokerUrn, 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            NAME, 'topic', 'rabbitmq', COMMIT, { scope: 'logical', confidence: 0.7 },
        );
        // Structural corroboration: config-declared (what symfony-messenger sets).
        const seed = getNeo4jSession();
        try { await seed.run(`MATCH (l:MessageChannel {id: $lid}) SET l.discoverySource = 'config'`, { lid: logicalUrn }); }
        finally { await seed.close(); }
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        const result = await runChannelAutopromote(COMMIT);
        expect(result.promoted).toBeGreaterThanOrEqual(1);

        const session = getNeo4jSession();
        try {
            const phys = await session.run(
                `MATCH (c:MessageChannel) WHERE c.name = $n AND c.scope = 'physical' AND c.valid_to_commit IS NULL RETURN count(c) AS n`,
                { n: NAME });
            expect(Number(phys.records[0].get('n'))).toBe(1);
            await session.run('MATCH (c:MessageChannel) WHERE c.name = $n DETACH DELETE c', { n: NAME });
        } finally { await session.close(); }
    });

    // ─── Evidence ladder + Tier 1 (C4) ───────────────────────────────────────

    const AUTOP_REPO = 'crtest/autop-repo';

    async function createOwnedService(name: string): Promise<{ svcUrn: string; fnUrn: string }> {
        // Real service-URN shape (cr:service:{repo}:{name}) — the Tier-1
        // ownership guard string-matches the repo segment.
        const svcUrn = `cr:service:${AUTOP_REPO}:${name}`;
        const fnUrn = `cr:service:${AUTOP_REPO}:${name}:fn`;
        await createService(svcUrn, name);
        await createFunctionInService(fnUrn, svcUrn, 'fn');
        return { svcUrn, fnUrn };
    }

    async function createConfigPhysical(name: string, brokerUrn: string, repoUrn: string | null): Promise<string> {
        const physicalUrn = `cr:channel:exchange:${name}`;
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (ch:MessageChannel {id: $id})
                 SET ch.name = $name, ch.scope = 'physical', ch.channelKind = 'exchange',
                     ch.technology = 'rabbitmq', ch.discoverySource = 'config',
                     ch.brokerUrn = $brokerUrn, ch._repoUrn = $repoUrn,
                     ch.valid_from_commit = $c, ch.valid_to_commit = null`,
                { id: physicalUrn, name, brokerUrn, c: COMMIT, repoUrn },
            );
        } finally { await session.close(); }
        return physicalUrn;
    }

    async function makeBroker(urn: string, hostLabel: string, opts: { needsReview?: boolean } = {}) {
        await mergeMessageBroker({
            urn, provider: 'rabbitmq', fingerprint: urn.split(':')[3]!,
            declaredVia: 'inferred', host: `${hostLabel}.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
            grounding: opts.needsReview
                ? { source: 'heuristic', quality: 'low', evidence: { extractors: ['broker-key-name@guess'] }, needsReview: true }
                : astGrounding('test-setup@v1'),
        }, COMMIT);
    }

    it('Tier 1: the logical WELDS onto the existing config-declared physical instead of minting a new one', async () => {
        const { fnUrn } = await createOwnedService('orders-app');
        await makeBroker('cr:broker:rabbitmq:t1weld001:orders', 'rabbitmq.t1');
        const physicalUrn = await createConfigPhysical(
            'autopromote.test.t1-weld', 'cr:broker:rabbitmq:t1weld001:orders', `cr:repository:${AUTOP_REPO}`,
        );

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.t1-weld', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        const result = await runChannelAutopromote(COMMIT);
        expect(result.tier1Welded).toBe(1);

        const session = getNeo4jSession();
        try {
            // EXACTLY one physical — the pre-existing config one, no @fingerprint twin.
            const phys = await session.run(
                `MATCH (ch:MessageChannel) WHERE ch.name = 'autopromote.test.t1-weld' AND ch.scope = 'physical'
                 RETURN collect(ch.id) AS ids`,
            );
            expect(phys.records[0].get('ids')).toEqual([physicalUrn]);

            // MANIFESTS_AS declared as 'config' (customer-declared physical).
            const man = await session.run(
                `MATCH (l:MessageChannel {id: $lid})-[r:MANIFESTS_AS]->(p:MessageChannel {id: $pid})
                 RETURN r.declaredVia AS declaredVia`,
                { lid: logicalUrn, pid: physicalUrn },
            );
            expect(man.records).toHaveLength(1);
            expect(man.records[0].get('declaredVia')).toBe('config');

            // Edges moved onto the config physical.
            const pub = await session.run(
                `MATCH (:Function {id: $fid})-[rel:PUBLISHES_TO]->(p:MessageChannel {id: $pid})
                 WHERE rel.valid_to_commit IS NULL RETURN count(rel) AS n`,
                { fid: fnUrn, pid: physicalUrn },
            );
            expect(Number(pub.records[0].get('n'))).toBe(1);
        } finally { await session.close(); }
    });

    it('Tier 1 ownership guard: a config physical of ANOTHER repo never captures the logical', async () => {
        const { svcUrn, fnUrn } = await createOwnedService('orders-app');
        await makeBroker('cr:broker:rabbitmq:t1own0001:orders', 'rabbitmq.t1own');
        // Same name, config-declared, but owned by a DIFFERENT repo.
        await createConfigPhysical(
            'autopromote.test.t1-foreign', 'cr:broker:rabbitmq:t1own0001:orders', 'cr:repository:crtest/other-repo',
        );
        // The publisher service has its own broker → ladder path must fire instead.
        await makeBroker('cr:broker:rabbitmq:t1own0002:orders', 'rabbitmq.own');
        await linkServiceConnectsToBroker(svcUrn, 'cr:broker:rabbitmq:t1own0002:orders', 'RABBITMQ_HOST', COMMIT);

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.t1-foreign', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        const result = await runChannelAutopromote(COMMIT);
        expect(result.tier1Welded).toBe(0);
        expect(result.promoted).toBeGreaterThanOrEqual(1);

        const session = getNeo4jSession();
        try {
            // The ladder minted a NEW physical on the service's own broker —
            // the foreign config physical was not touched.
            const phys = await session.run(
                `MATCH (ch:MessageChannel) WHERE ch.name = 'autopromote.test.t1-foreign' AND ch.scope = 'physical'
                 RETURN collect(ch.brokerUrn) AS brokers`,
            );
            const brokers = (phys.records[0].get('brokers') as string[]).sort();
            expect(brokers).toContain('cr:broker:rabbitmq:t1own0002:orders');
        } finally { await session.close(); }
    });

    it('config edge + strong env edge to DIFFERENT brokers → AMBIGUOUS, no silent config precedence', async () => {
        const { svcUrn, fnUrn } = await createOwnedService('orders-app');
        await makeBroker('cr:broker:rabbitmq:cfgstr001:orders', 'rabbitmq.cfg');
        await makeBroker('cr:broker:rabbitmq:cfgstr002:orders', 'rabbitmq.env');
        await linkServiceConnectsToBroker(svcUrn, 'cr:broker:rabbitmq:cfgstr001:orders', null, COMMIT,
            { sourceType: 'config', via: 'broker-candidate:s4-config-declared' });
        await linkServiceConnectsToBroker(svcUrn, 'cr:broker:rabbitmq:cfgstr002:orders', 'BUS_URL', COMMIT,
            { via: 'broker-candidate:a2' });

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.cfg-vs-strong', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        const result = await runChannelAutopromote(COMMIT);
        expect(result.promoted).toBe(0);
        expect(result.ambiguous).toBeGreaterThanOrEqual(1);
    });

    it('weak-only fallback promotes WITH needsReview + weak-broker tag; strong beats weak', async () => {
        // Service A: weak-only → promotes with triage tag.
        const a = await createOwnedService('weak-only-app');
        await makeBroker('cr:broker:rabbitmq:weak00001:orders', 'rabbitmq.weak', { needsReview: true });
        await linkServiceConnectsToBroker(a.svcUrn, 'cr:broker:rabbitmq:weak00001:orders', 'RABBITMQ_HOST', COMMIT,
            { via: 'broker-candidate:s3-key-name-residual' });
        const weakLogical = await mergeMessageChannelWithKind(
            'autopromote.test.weak-only', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(a.fnUrn, weakLogical, COMMIT, { grounding: astGrounding('test@v1') });

        // Service B: weak + strong to different brokers → strong wins (no ambiguity).
        const b = await createOwnedService('strong-beats-weak-app');
        await makeBroker('cr:broker:rabbitmq:weak00002:orders', 'rabbitmq.weak2', { needsReview: true });
        await makeBroker('cr:broker:rabbitmq:strong001:orders', 'rabbitmq.strong');
        await linkServiceConnectsToBroker(b.svcUrn, 'cr:broker:rabbitmq:weak00002:orders', 'RABBITMQ_HOST', COMMIT,
            { via: 'broker-candidate:s3-key-name-residual' });
        await linkServiceConnectsToBroker(b.svcUrn, 'cr:broker:rabbitmq:strong001:orders', 'BUS_URL', COMMIT,
            { via: 'broker-candidate:a2' });
        const strongLogical = await mergeMessageChannelWithKind(
            'autopromote.test.strong-beats-weak', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(b.fnUrn, strongLogical, COMMIT, { grounding: astGrounding('test@v1') });

        const result = await runChannelAutopromote(COMMIT);
        expect(result.promoted).toBe(2);
        expect(result.ambiguous).toBe(0);

        const session = getNeo4jSession();
        try {
            const weakPhys = await session.run(
                `MATCH (ch:MessageChannel) WHERE ch.name = 'autopromote.test.weak-only' AND ch.scope = 'physical'
                 RETURN ch.needsReview AS nr, ch.evidence_extractors AS ext, ch.brokerUrn AS broker`,
            );
            expect(weakPhys.records).toHaveLength(1);
            expect(weakPhys.records[0].get('nr')).toBe(true);
            expect(weakPhys.records[0].get('ext')).toContain('channel-autopromoter-weak-broker@v1');
            expect(weakPhys.records[0].get('broker')).toBe('cr:broker:rabbitmq:weak00001:orders');

            const strongPhys = await session.run(
                `MATCH (ch:MessageChannel) WHERE ch.name = 'autopromote.test.strong-beats-weak' AND ch.scope = 'physical'
                 RETURN ch.brokerUrn AS broker, ch.evidence_extractors AS ext`,
            );
            expect(strongPhys.records).toHaveLength(1);
            expect(strongPhys.records[0].get('broker')).toBe('cr:broker:rabbitmq:strong001:orders');
            expect(strongPhys.records[0].get('ext') ?? []).not.toContain('channel-autopromoter-weak-broker@v1');
        } finally { await session.close(); }
    });

    it('two weak brokers → ambiguous, no promotion', async () => {
        const { svcUrn, fnUrn } = await createOwnedService('two-weak-app');
        await makeBroker('cr:broker:rabbitmq:twoweak01:orders', 'rabbitmq.w1', { needsReview: true });
        await makeBroker('cr:broker:rabbitmq:twoweak02:orders', 'rabbitmq.w2', { needsReview: true });
        await linkServiceConnectsToBroker(svcUrn, 'cr:broker:rabbitmq:twoweak01:orders', 'RABBITMQ_HOST', COMMIT,
            { via: 'broker-candidate:s3-key-name-residual' });
        await linkServiceConnectsToBroker(svcUrn, 'cr:broker:rabbitmq:twoweak02:orders', 'MQ_HOST', COMMIT,
            { via: 'broker-candidate:s2-declared-sink-residual' });

        const logicalUrn = await mergeMessageChannelWithKind(
            'autopromote.test.two-weak', 'topic', 'rabbitmq', COMMIT,
            { scope: 'logical', confidence: 0.7 },
        );
        await linkFunctionPublishesTo(fnUrn, logicalUrn, COMMIT, { grounding: astGrounding('test@v1') });

        const result = await runChannelAutopromote(COMMIT);
        expect(result.promoted).toBe(0);
        expect(result.ambiguous).toBeGreaterThanOrEqual(1);
    });
});
