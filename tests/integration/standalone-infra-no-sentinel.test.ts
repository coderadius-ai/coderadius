import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { ingestStandaloneInfraFile } from '../../src/ingestion/structural/standalone-ingest.js';
import { clearMessageBrokerRegistry } from '../../src/ingestion/core/messaging/broker-registry.js';

describe('standalone infra ingest', () => {
    const fixture = path.resolve('tests/eval/patterns/rabbitmq-messenger-routing/fixture/rabbitmq/definitions.json');

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run(`MATCH (n) WHERE n.id IN ['cr:repository:local-infra', 'cr:repository:standalone-infra'] DETACH DELETE n`);
            await s.run(`MATCH (sf:StructuralFile) WHERE sf.path = $fixture DETACH DELETE sf`, { fixture });
            await s.run(`MATCH (ch:MessageChannel) WHERE ch.name STARTS WITH 'acme.' DETACH DELETE ch`);
            await s.run(`MATCH (b:MessageBroker) WHERE b.provider = 'rabbitmq' AND b.vhost = '/prod' DETACH DELETE b`);
        } finally {
            await s.close();
        }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { clearMessageBrokerRegistry(); await wipe(); });

    it('persists RabbitMQ topology without synthetic Repository or absolute-path StructuralFile', async () => {
        const result = await ingestStandaloneInfraFile(fixture);
        expect(result.pluginName).toBe('rabbitmq-config');
        expect(result.entitiesPersisted).toBeGreaterThan(0);
        expect(result.edgesPersisted).toBeGreaterThan(0);

        const s = getNeo4jSession();
        try {
            const sentinels = await s.run(
                `MATCH (r:Repository)
                 WHERE r.id IN ['cr:repository:local-infra', 'cr:repository:standalone-infra']
                 RETURN count(r) AS n`,
            );
            expect(Number(sentinels.records[0].get('n'))).toBe(0);

            const structuralFiles = await s.run(
                `MATCH (sf:StructuralFile)
                 WHERE sf.path = $fixture OR sf.id CONTAINS $fixture
                 RETURN count(sf) AS n`,
                { fixture },
            );
            expect(Number(structuralFiles.records[0].get('n'))).toBe(0);

            const topology = await s.run(
                `MATCH (exchange:MessageChannel {name: 'acme.orders'})-[route:ROUTES_TO]->(queue:MessageChannel)
                 WHERE route.valid_to_commit IS NULL
                 RETURN count(DISTINCT exchange) AS exchanges,
                        count(DISTINCT queue) AS queues,
                        count(route) AS routes`,
            );
            expect(Number(topology.records[0].get('exchanges'))).toBe(1);
            expect(Number(topology.records[0].get('queues'))).toBe(2);
            expect(Number(topology.records[0].get('routes'))).toBe(2);
        } finally {
            await s.close();
        }
    });

    it('is idempotent when the same standalone file is ingested twice', async () => {
        await ingestStandaloneInfraFile(fixture);
        await ingestStandaloneInfraFile(fixture);

        const s = getNeo4jSession();
        try {
            const routes = await s.run(
                `MATCH (:MessageChannel {name: 'acme.orders'})-[route:ROUTES_TO]->(:MessageChannel)
                 WHERE route.valid_to_commit IS NULL
                 RETURN count(route) AS n`,
            );
            expect(Number(routes.records[0].get('n'))).toBe(2);
        } finally {
            await s.close();
        }
    });
});
