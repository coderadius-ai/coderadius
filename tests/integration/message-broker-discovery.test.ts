import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeMessageBroker,
    linkServiceConnectsToBroker,
    mergePhysicalMessageChannel,
} from '../../src/graph/mutations/data-contracts.js';
import { astGrounding } from '../../src/graph/grounding.js';

describe('mergeMessageBroker — extended with fingerprintScope + alternateHostsSeen', () => {
    const PFX = 'cr://test/broker-discovery/';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await session.run('MATCH (n:MessageBroker) WHERE n.host CONTAINS "acme-test" DETACH DELETE n');
            await session.run('MATCH (n:MessageChannel) WHERE n.name STARTS WITH "test.broker-discovery." DETACH DELETE n');
        } finally { await session.close(); }
    }

    async function createService(urn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = 'TEST', s.valid_to_commit = null`,
                { id: urn, name },
            );
        } finally { await session.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    it('mergeMessageBroker writes fingerprintScope + repoScope + alternateHostsSeen properties', async () => {
        const urn = 'cr:broker:rabbitmq:abc12345:orders';
        await mergeMessageBroker({
            urn,
            provider: 'rabbitmq',
            fingerprint: 'abc12345',
            declaredVia: 'inferred',
            host: 'rabbitmq',
            port: 5672,
            vhost: 'orders',
            fingerprintScope: 'repo',
            repoScope: 'acme-test/repo-A',
            alternateHostsSeen: ['rabbitmq.staging.acme-test.example', 'localhost'],
            grounding: astGrounding('synthesize-message-brokers@v1'),
        }, 'TEST_COMMIT');

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (b:MessageBroker {id: $id})
                 RETURN b.fingerprintScope AS scope, b.repoScope AS repoScope,
                        b.alternateHostsSeen AS alt`,
                { id: urn },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('scope')).toBe('repo');
            expect(r.records[0].get('repoScope')).toBe('acme-test/repo-A');
            expect(r.records[0].get('alt')).toEqual(['rabbitmq.staging.acme-test.example', 'localhost']);
        } finally { await session.close(); }
    });

    it('global-scope broker omits repoScope', async () => {
        const urn = 'cr:broker:rabbitmq:def67890:orders';
        await mergeMessageBroker({
            urn,
            provider: 'rabbitmq',
            fingerprint: 'def67890',
            declaredVia: 'inferred',
            host: 'rabbitmq.prod.acme-test.example',
            port: 5672,
            vhost: 'orders',
            fingerprintScope: 'global',
            grounding: astGrounding('synthesize-message-brokers@v1'),
        }, 'TEST_COMMIT');

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (b:MessageBroker {id: $id})
                 RETURN b.fingerprintScope AS scope, b.repoScope AS repoScope`,
                { id: urn },
            );
            expect(r.records[0].get('scope')).toBe('global');
            expect(r.records[0].get('repoScope')).toBeNull();
        } finally { await session.close(); }
    });

    it('linkServiceConnectsToBroker creates Service-[:CONNECTS_TO]->MessageBroker with sourceEnvKey', async () => {
        const sUrn = `${PFX}service:caller`;
        const bUrn = 'cr:broker:rabbitmq:bcd99999:orders';
        await createService(sUrn, 'caller');
        await mergeMessageBroker({
            urn: bUrn, provider: 'rabbitmq', fingerprint: 'bcd99999',
            declaredVia: 'inferred', host: 'rabbitmq.prod.acme-test.example',
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, 'TEST');
        await linkServiceConnectsToBroker(sUrn, bUrn, 'RABBITMQ_HOST', 'TEST');

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (s:Service {id: $sid})-[rel:CONNECTS_TO]->(b:MessageBroker {id: $bid})
                 RETURN rel.sourceEnvKey AS k, rel.source AS source`,
                { sid: sUrn, bid: bUrn },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('k')).toBe('RABBITMQ_HOST');
            expect(r.records[0].get('source')).toBe('env-var');
        } finally { await session.close(); }
    });

    it('linkServiceConnectsToBroker idempotent', async () => {
        const sUrn = `${PFX}service:caller-idem`;
        const bUrn = 'cr:broker:rabbitmq:fea99999:orders';
        await createService(sUrn, 'caller-idem');
        await mergeMessageBroker({
            urn: bUrn, provider: 'rabbitmq', fingerprint: 'fea99999',
            declaredVia: 'inferred', host: 'rabbitmq.prod.acme-test.example',
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, 'TEST');
        await linkServiceConnectsToBroker(sUrn, bUrn, 'RABBITMQ_HOST', 'TEST');
        await linkServiceConnectsToBroker(sUrn, bUrn, 'RABBITMQ_HOST', 'TEST');

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (:Service {id: $sid})-[rel:CONNECTS_TO]->(:MessageBroker {id: $bid})
                 RETURN count(rel) AS n`,
                { sid: sUrn, bid: bUrn },
            );
            expect(Number(r.records[0].get('n'))).toBe(1);
        } finally { await session.close(); }
    });

    it('linkServiceConnectsToBroker upgrades legacy source-less env-var edge instead of duplicating', async () => {
        const sUrn = `${PFX}service:caller-legacy`;
        const bUrn = 'cr:broker:rabbitmq:leg99999:orders';
        await createService(sUrn, 'caller-legacy');
        await mergeMessageBroker({
            urn: bUrn, provider: 'rabbitmq', fingerprint: 'leg99999',
            declaredVia: 'inferred', host: 'rabbitmq.prod.acme-test.example',
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, 'TEST');

        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (s:Service {id: $sid}), (b:MessageBroker {id: $bid})
                 MERGE (s)-[rel:CONNECTS_TO]->(b)
                 SET rel.valid_from_commit = 'OLD', rel.valid_to_commit = null`,
                { sid: sUrn, bid: bUrn },
            );
        } finally { await session.close(); }

        await linkServiceConnectsToBroker(sUrn, bUrn, 'RABBITMQ_HOST', 'TEST');

        const check = getNeo4jSession();
        try {
            const r = await check.run(
                `MATCH (:Service {id: $sid})-[rel:CONNECTS_TO]->(:MessageBroker {id: $bid})
                 RETURN count(rel) AS n, collect(rel.source) AS sources, collect(rel.sourceEnvKey) AS keys`,
                { sid: sUrn, bid: bUrn },
            );
            expect(Number(r.records[0].get('n'))).toBe(1);
            expect(r.records[0].get('sources')).toEqual(['env-var']);
            expect(r.records[0].get('keys')).toEqual(['RABBITMQ_HOST']);
        } finally { await check.close(); }
    });
});

describe('mergePhysicalMessageChannel — wrapper enforcing physical scope', () => {
    const PFX = 'cr://test/physical-channel/';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await session.run(
                `MATCH (n:MessageChannel) WHERE n.name STARTS WITH "test.physical.channel." DETACH DELETE n`,
            );
            await session.run(
                `MATCH (n:MessageBroker) WHERE n.host CONTAINS "physical-channel-test" DETACH DELETE n`,
            );
        } finally { await session.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    it('creates :MessageChannel{scope:physical} with URN suffix @<fp>', async () => {
        const brokerUrn = 'cr:broker:rabbitmq:phy99999:orders';
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'phy99999',
            declaredVia: 'inferred', host: 'rabbitmq.physical-channel-test.example',
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, 'TEST');

        const channelUrn = await mergePhysicalMessageChannel(
            'test.physical.channel.order-created',
            'topic',
            'rabbitmq',
            'phy99999',
            brokerUrn,
            'TEST',
            { grounding: astGrounding('channel-autopromoter@v1') },
        );

        expect(channelUrn).toBe('cr:channel:topic:test.physical.channel.order-created@phy99999');

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id})
                 OPTIONAL MATCH (ch)-[:HOSTED_ON]->(b:MessageBroker)
                 RETURN ch.scope AS scope, ch.brokerUrn AS bu, b.id AS hostId`,
                { id: channelUrn },
            );
            expect(r.records[0].get('scope')).toBe('physical');
            expect(r.records[0].get('bu')).toBe(brokerUrn);
            expect(r.records[0].get('hostId')).toBe(brokerUrn);
        } finally { await session.close(); }
    });
});
