import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    linkServiceConnectsToBroker,
    mergeMessageBroker,
    mergePhysicalMessageChannel,
} from '../../src/graph/mutations/data-contracts.js';
import { run } from '../../src/graph/mutations/_run.js';
import { astGrounding } from '../../src/graph/grounding.js';
import { computeBrokerFingerprint, makeBrokerUrn } from '../../src/ingestion/core/messaging/broker-registry.js';
import { consolidateDuplicateBrokers } from '../../src/ingestion/processors/broker-consolidation.js';

describe('consolidateDuplicateBrokers', () => {
    const PFX = 'cr://test/broker-consolidation/';
    const COMMIT = 'BROKER_CONSOLIDATION_TEST';
    const host = 'rabbitmq.consolidation.acme.example';
    const vhost = 'orders';

    function canonicalUrn(): string {
        const fp = computeBrokerFingerprint({ provider: 'rabbitmq', host, port: 5672, vhost });
        return makeBrokerUrn('rabbitmq', fp, vhost);
    }

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await s.run(
                `MATCH (b:MessageBroker)
                 WHERE b.host CONTAINS 'consolidation.acme' OR b.id STARTS WITH 'cr:broker:rabbitmq:test-secondary'
                 DETACH DELETE b`,
            );
            await s.run(`MATCH (ch:MessageChannel) WHERE ch.name STARTS WITH 'acme.consolidation.' DETACH DELETE ch`);
        } finally {
            await s.close();
        }
    }

    async function broker(urn: string, fp: string, repoScope?: string, customVhost = vhost) {
        await mergeMessageBroker({
            urn,
            provider: 'rabbitmq',
            fingerprint: fp,
            declaredVia: 'inferred',
            host,
            port: 5672,
            vhost: customVhost,
            fingerprintScope: repoScope ? 'repo' : 'global',
            repoScope,
            grounding: astGrounding(`${fp}@v1`),
        }, COMMIT);
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('merges duplicate broker URNs and rewires HOSTED_ON plus both CONNECTS_TO sources', async () => {
        const primary = canonicalUrn();
        const secondary = 'cr:broker:rabbitmq:test-secondary-transparent:orders';
        await broker(primary, primary.split(':')[3]);
        await broker(secondary, 'test-secondary-transparent');
        await run(
            `MATCH (b:MessageBroker {id: $primary})
             SET b.evidence_extractors = ['primary@v1']
             WITH b
             MATCH (s:MessageBroker {id: $secondary})
             SET s.evidence_extractors = ['secondary@v1']`,
            { primary, secondary },
        );

        const channelUrn = await mergePhysicalMessageChannel(
            'acme.consolidation.order.created',
            'queue',
            'rabbitmq',
            'test-secondary-transparent',
            secondary,
            COMMIT,
            { grounding: astGrounding('test-channel@v1') },
        );
        const serviceUrn = `${PFX}service:orders`;
        await run(
            `MERGE (svc:Service {id: $serviceUrn})
             SET svc.name = 'orders', svc.valid_to_commit = null`,
            { serviceUrn },
        );
        await linkServiceConnectsToBroker(serviceUrn, secondary, 'RABBITMQ_HOST', COMMIT);
        await linkServiceConnectsToBroker(serviceUrn, secondary, null, COMMIT, {
            sourceType: 'channel-convergence',
            via: 'channel-broker-convergence@v1',
        });

        const result = await consolidateDuplicateBrokers(COMMIT);
        expect(result.merged).toBe(1);

        const s = getNeo4jSession();
        try {
            const brokerRows = await s.run(
                `MATCH (b:MessageBroker)
                 WHERE b.id IN [$primary, $secondary]
                 RETURN collect(b.id) AS ids, head(collect(b.evidence_extractors)) AS evidence`,
                { primary, secondary },
            );
            expect(brokerRows.records[0].get('ids')).toEqual([primary]);
            expect(brokerRows.records[0].get('evidence')).toEqual(expect.arrayContaining(['primary@v1', 'secondary@v1']));

            const hosted = await s.run(
                `MATCH (ch:MessageChannel {id: $channelUrn})-[h:HOSTED_ON]->(b:MessageBroker)
                 WHERE h.valid_to_commit IS NULL
                 RETURN ch.brokerUrn AS brokerUrn, b.id AS brokerId`,
                { channelUrn },
            );
            expect(hosted.records[0].get('brokerUrn')).toBe(primary);
            expect(hosted.records[0].get('brokerId')).toBe(primary);

            const connects = await s.run(
                `MATCH (:Service {id: $serviceUrn})-[rel:CONNECTS_TO]->(:MessageBroker {id: $primary})
                 WHERE rel.valid_to_commit IS NULL
                 RETURN rel.source AS source, rel.sourceEnvKey AS key, rel.via AS via
                 ORDER BY source`,
                { serviceUrn, primary },
            );
            expect(connects.records.map(r => r.get('source'))).toEqual(['channel-convergence', 'env-var']);
            expect(connects.records.find(r => r.get('source') === 'env-var')!.get('key')).toBe('RABBITMQ_HOST');
            expect(connects.records.find(r => r.get('source') === 'channel-convergence')!.get('via')).toBe('channel-broker-convergence@v1');
        } finally {
            await s.close();
        }
    });

    it('merges three duplicate broker nodes down to one and is idempotent', async () => {
        const primary = canonicalUrn();
        await broker(primary, primary.split(':')[3]);
        await broker('cr:broker:rabbitmq:test-secondary-a:orders', 'test-secondary-a');
        await broker('cr:broker:rabbitmq:test-secondary-b:orders', 'test-secondary-b');

        const first = await consolidateDuplicateBrokers(COMMIT);
        const second = await consolidateDuplicateBrokers(COMMIT);
        expect(first.merged).toBe(2);
        expect(second.merged).toBe(0);
    });

    it('does not merge brokers with different vhosts (legit multi-vhost setup, no review noise)', async () => {
        await broker(canonicalUrn(), canonicalUrn().split(':')[3], undefined, 'orders');
        await broker('cr:broker:rabbitmq:test-secondary-payments:payments', 'test-secondary-payments', undefined, 'payments');

        const result = await consolidateDuplicateBrokers(COMMIT);
        expect(result.merged).toBe(0);

        // Two KNOWN vhosts on the same host are two logical brokers by
        // design — the vhost policy must NOT flag them for review.
        const s = getNeo4jSession();
        try {
            const flagged = await s.run(
                `MATCH (b:MessageBroker)
                 WHERE b.host = $host AND b.needsReview = true
                 RETURN count(b) AS n`,
                { host },
            );
            expect(Number(flagged.records[0].get('n'))).toBe(0);
        } finally { await s.close(); }
    });

    it('does not merge repo-scoped brokers from different repo scopes', async () => {
        await broker('cr:broker:rabbitmq:test-secondary-repo-a:orders', 'test-secondary-repo-a', 'cr:repository:acme/orders-a');
        await broker('cr:broker:rabbitmq:test-secondary-repo-b:orders', 'test-secondary-repo-b', 'cr:repository:acme/orders-b');

        const result = await consolidateDuplicateBrokers(COMMIT);
        expect(result.merged).toBe(0);
    });

    // ─── Vhost policy: complementary halves (host-only vs host+vhost) ───────
    // Code-side env discovery often yields host WITHOUT vhost (vhost lives
    // mid-DSN or in another file) while infra yields host+vhost. Same
    // provider+host+port: the vhost-NULL broker melts into the UNIQUE
    // vhost-bearing one. '/' is a KNOWN vhost (AMQP default), never adoptable;
    // with ≥2 known vhosts the null broker is ambiguous → needsReview on the
    // NULL broker only (the known-vhost brokers are legit, no noise).

    async function brokerAt(urn: string, fp: string, h: string, customVhost: string | undefined) {
        await mergeMessageBroker({
            urn, provider: 'rabbitmq', fingerprint: fp, declaredVia: 'inferred',
            host: h, port: 5672, vhost: customVhost,
            fingerprintScope: 'global',
            grounding: astGrounding(`${fp}@v1`),
        }, COMMIT);
    }

    it('vhost policy: host-only broker melts into the unique vhost-bearing sibling', async () => {
        const h = 'vp1.consolidation.acme.example';
        const nullUrn = 'cr:broker:rabbitmq:test-secondary-vp1null';
        const vhostUrn = 'cr:broker:rabbitmq:test-secondary-vp1full:orders';
        await brokerAt(nullUrn, 'test-secondary-vp1null', h, undefined);
        await brokerAt(vhostUrn, 'test-secondary-vp1full', h, 'orders');

        // Edges on the null broker must survive the melt.
        const serviceUrn = `${PFX}service:vp1`;
        await run(
            `MERGE (svc:Service {id: $serviceUrn}) SET svc.name = 'vp1', svc.valid_to_commit = null`,
            { serviceUrn },
        );
        await linkServiceConnectsToBroker(serviceUrn, nullUrn, 'SOME_MQ_HOSTNAME', COMMIT);

        const result = await consolidateDuplicateBrokers(COMMIT);
        expect(result.merged).toBe(1);

        const s = getNeo4jSession();
        try {
            const rows = await s.run(
                `MATCH (b:MessageBroker) WHERE b.host = $h AND b.valid_to_commit IS NULL
                 RETURN b.id AS id, b.vhost AS vhost`,
                { h },
            );
            expect(rows.records).toHaveLength(1);
            expect(rows.records[0].get('id')).toBe(vhostUrn);
            expect(rows.records[0].get('vhost')).toBe('orders');

            const connects = await s.run(
                `MATCH (:Service {id: $serviceUrn})-[rel:CONNECTS_TO]->(b:MessageBroker)
                 WHERE rel.valid_to_commit IS NULL
                 RETURN b.id AS bid`,
                { serviceUrn },
            );
            expect(connects.records.map(r => r.get('bid'))).toEqual([vhostUrn]);
        } finally { await s.close(); }
    });

    it('vhost policy: "/" is a KNOWN vhost and never melts into a named one', async () => {
        const h = 'vp2.consolidation.acme.example';
        await brokerAt('cr:broker:rabbitmq:test-secondary-vp2slash', 'test-secondary-vp2slash', h, '/');
        await brokerAt('cr:broker:rabbitmq:test-secondary-vp2named:orders', 'test-secondary-vp2named', h, 'orders');

        const result = await consolidateDuplicateBrokers(COMMIT);
        expect(result.merged).toBe(0);

        const s = getNeo4jSession();
        try {
            const flagged = await s.run(
                `MATCH (b:MessageBroker) WHERE b.host = $h AND b.needsReview = true RETURN count(b) AS n`,
                { h },
            );
            expect(Number(flagged.records[0].get('n'))).toBe(0);
        } finally { await s.close(); }
    });

    it('vhost policy: null broker among ≥2 distinct known vhosts → no melt, needsReview on the NULL broker only', async () => {
        const h = 'vp3.consolidation.acme.example';
        const nullUrn = 'cr:broker:rabbitmq:test-secondary-vp3null';
        await brokerAt(nullUrn, 'test-secondary-vp3null', h, undefined);
        await brokerAt('cr:broker:rabbitmq:test-secondary-vp3a:orders', 'test-secondary-vp3a', h, 'orders');
        await brokerAt('cr:broker:rabbitmq:test-secondary-vp3b:payments', 'test-secondary-vp3b', h, 'payments');

        const result = await consolidateDuplicateBrokers(COMMIT);
        expect(result.merged).toBe(0);

        const s = getNeo4jSession();
        try {
            const rows = await s.run(
                `MATCH (b:MessageBroker) WHERE b.host = $h AND b.valid_to_commit IS NULL
                 RETURN b.id AS id, b.needsReview AS nr ORDER BY id`,
                { h },
            );
            expect(rows.records).toHaveLength(3);
            for (const rec of rows.records) {
                const expected = rec.get('id') === nullUrn ? true : null;
                expect(rec.get('nr')).toBe(expected);
            }
        } finally { await s.close(); }
    });

    it('vhost policy melt is idempotent', async () => {
        const h = 'vp4.consolidation.acme.example';
        await brokerAt('cr:broker:rabbitmq:test-secondary-vp4null', 'test-secondary-vp4null', h, undefined);
        await brokerAt('cr:broker:rabbitmq:test-secondary-vp4full:orders', 'test-secondary-vp4full', h, 'orders');

        const first = await consolidateDuplicateBrokers(COMMIT);
        const second = await consolidateDuplicateBrokers(COMMIT);
        expect(first.merged).toBe(1);
        expect(second.merged).toBe(0);
    });
});
