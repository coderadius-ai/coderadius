/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Integration — Datastore → N DatabaseEndpoint{environment} (S1.1 Part D)
 *
 * Pins the graph-mutation layer of the logical/physical split (paradigm A):
 *
 *   - ONE logical `:Datastore` (no host, no `environments` blob).
 *   - N physical `:DatabaseEndpoint{environment}`, one per deployment surface,
 *     each linked `(:Datastore)-[:SERVED_BY]->(:DatabaseEndpoint)`.
 *   - The same physical endpointKey observed in two environments yields two
 *     DISTINCT nodes (anti-collision dev↔prod).
 *   - Idempotent: re-merging the same surfaces does not duplicate nodes.
 *
 * Requires the Memgraph test DB (docker-compose.test.yml, bolt://localhost:7688).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { buildDatabaseEndpointUrn } from '../../src/graph/mutations/data-contracts.js';
import { seedDatastore, seedDatabaseEndpoint, seedServedBy } from './_helpers/delta-seeds.js';
import { computeEndpointKey } from '../../src/ingestion/processors/db-scope-resolver.js';
import { astGrounding } from '../../src/graph/grounding.js';

const NS = 'acme/orders-itest';
const COMMIT_A = 'ITEST_COMMIT_A';

interface Surface { environment: string; host: string; port: number; dbName: string; }

const SURFACES: Surface[] = [
    { environment: 'production',  host: 'orders-prod.itest.internal', port: 3306, dbName: 'orders' },
    { environment: 'staging',     host: 'orders-stg.itest.internal',  port: 3306, dbName: 'orders' },
    { environment: 'development', host: 'orders-dev.itest.internal',  port: 3306, dbName: 'orders' },
];

async function wipe() {
    const session = getNeo4jSession();
    try {
        await session.run(`MATCH (d:Datastore) WHERE d.namespace = $ns DETACH DELETE d`, { ns: NS });
        await session.run(
            `MATCH (ep:DatabaseEndpoint) WHERE ep.host ENDS WITH '.itest.internal' DETACH DELETE ep`,
        );
    } finally { await session.close(); }
}

async function seed(commit: string): Promise<string> {
    const dsUrn = await seedDatastore(NS, 'orders', 'mysql', commit, astGrounding('connection-extractor@v1'));
    for (const s of SURFACES) {
        const epUrn = await seedDatabaseEndpoint({
            endpointKey: computeEndpointKey(s.host, s.port, s.dbName),
            environment: s.environment,
            dbName: s.dbName,
            technology: 'mysql',
            host: s.host,
            port: s.port,
            allowPlainTextHosts: true,
            grounding: astGrounding('connection-extractor@v1'),
        }, commit);
        await seedServedBy(dsUrn, epUrn, commit);
    }
    return dsUrn;
}

describe('Datastore → N DatabaseEndpoint{environment} (paradigm A)', () => {
    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('creates ONE logical Datastore with no host/environments property', async () => {
        await seed(COMMIT_A);
        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (d:Datastore) WHERE d.namespace = $ns
                 RETURN count(d) AS n, collect(d.environments)[0] AS envs, collect(d.host)[0] AS host, collect(d.technology)[0] AS tech`,
                { ns: NS },
            );
            expect(Number(r.records[0].get('n'))).toBe(1);
            expect(r.records[0].get('envs')).toBeNull();   // no JSON blob
            expect(r.records[0].get('host')).toBeNull();    // host lives on the endpoint
            expect(r.records[0].get('tech')).toBe('mysql');
        } finally { await session.close(); }
    });

    it('creates three DatabaseEndpoints, one per environment, all SERVED_BY the Datastore', async () => {
        await seed(COMMIT_A);
        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (d:Datastore)-[:SERVED_BY]->(ep:DatabaseEndpoint)
                 WHERE d.namespace = $ns
                 RETURN collect(ep.environment) AS envs, count(ep) AS n, collect(DISTINCT ep.host) AS hosts`,
                { ns: NS },
            );
            expect(Number(r.records[0].get('n'))).toBe(3);
            expect((r.records[0].get('envs') as string[]).sort())
                .toEqual(['development', 'production', 'staging']);
            expect((r.records[0].get('hosts') as string[]).length).toBe(3);
        } finally { await session.close(); }
    });

    it('the same physical endpointKey in two environments yields two distinct nodes', async () => {
        // Same host:port/dbName, two environments → distinct URNs via env segment.
        const key = computeEndpointKey('shared-host.itest.internal', 5432, 'orders');
        const dsUrn = await seedDatastore(NS, 'orders', 'postgres', COMMIT_A, astGrounding('connection-extractor@v1'));
        for (const env of ['production', 'staging']) {
            const epUrn = await seedDatabaseEndpoint({
                endpointKey: key, environment: env, dbName: 'orders', technology: 'postgres',
                host: 'shared-host.itest.internal', port: 5432, allowPlainTextHosts: true,
                grounding: astGrounding('connection-extractor@v1'),
            }, COMMIT_A);
            await seedServedBy(dsUrn, epUrn, COMMIT_A);
        }
        expect(buildDatabaseEndpointUrn(key, 'production')).not.toBe(buildDatabaseEndpointUrn(key, 'staging'));
        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ep:DatabaseEndpoint) WHERE ep.endpointKey = $key RETURN count(ep) AS n`,
                { key },
            );
            expect(Number(r.records[0].get('n'))).toBe(2);
        } finally { await session.close(); }
    });

    it('is idempotent — re-seeding the same surfaces does not duplicate nodes', async () => {
        await seed(COMMIT_A);
        await seed(COMMIT_A);
        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (d:Datastore)-[:SERVED_BY]->(ep:DatabaseEndpoint)
                 WHERE d.namespace = $ns RETURN count(DISTINCT ep) AS n`,
                { ns: NS },
            );
            expect(Number(r.records[0].get('n'))).toBe(3);
        } finally { await session.close(); }
    });
});
