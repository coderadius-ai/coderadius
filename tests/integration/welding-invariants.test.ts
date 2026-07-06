import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { weldDataContainersByEndpoint } from '../../src/graph/mutations/data-contracts.js';

// ─── Cross-service DataContainer welding invariants ──────────────────────────
//
// When two repositories reference the same physical database table, the
// welding pass MUST collapse them to a single DataContainer node with both
// services reachable via READS|WRITES edges. This protects the impact-explorer
// blast-radius traversal from being silently broken.

describe('weldDataContainersByEndpoint', () => {
    const PFX = 'cr://test/welding/';
    const COMMIT = 'TESTWELD';
    const FP = '0123456789abcdef';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally {
            await s.close();
        }
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

    interface DCOpts {
        physicalEndpointKey?: string | null;
        kindFamily?: string;
        schemaOrNs?: string;
        confidence?: 'high' | 'medium' | 'low';
    }
    async function makeDataContainer(id: string, name: string, opts: DCOpts = {}) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (d:DataContainer {id: $id})
                 SET d.name = $name,
                     d.valid_from_commit = 'TEST',
                     d.valid_to_commit = null,
                     d.physicalEndpointKey = $fp,
                     d.kindFamily = $kf,
                     d.schemaOrNs = $ns,
                     d.physicalEndpointConfidence = $conf`,
                {
                    id, name,
                    fp: opts.physicalEndpointKey ?? null,
                    kf: opts.kindFamily ?? 'rdbms',
                    ns: opts.schemaOrNs ?? null,
                    conf: opts.confidence ?? 'high',
                },
            );
        } finally { await s.close(); }
    }

    async function readsOrWrites(rel: 'READS' | 'WRITES', funcId: string, dcId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (f:Function {id: $fid}), (d:DataContainer {id: $did})
                 MERGE (f)-[r:${rel}]->(d)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: funcId, did: dcId },
            );
        } finally { await s.close(); }
    }

    async function makeDatastore(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (d:Datastore {id: $id})
                 SET d.name = $name, d.valid_from_commit = 'TEST', d.valid_to_commit = null,
                     d.technology = 'mysql'`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function storedIn(dcId: string, dsId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (d:DataContainer {id: $dc}), (s:Datastore {id: $ds})
                 MERGE (d)-[r:STORED_IN]->(s)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { dc: dcId, ds: dsId },
            );
        } finally { await s.close(); }
    }

    async function countContainers(name: string, includeTombstone = false): Promise<number> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                includeTombstone
                    ? 'MATCH (d:DataContainer {name: $n}) WHERE d.id STARTS WITH $p RETURN count(d) AS n'
                    : 'MATCH (d:DataContainer {name: $n}) WHERE d.id STARTS WITH $p AND d.valid_to_commit IS NULL RETURN count(d) AS n',
                { n: name, p: PFX },
            );
            const v = r.records[0]?.get('n') ?? 0;
            return typeof v === 'object' && 'low' in v ? (v as any).low : Number(v);
        } finally { await s.close(); }
    }

    async function countServicesReaching(name: string): Promise<number> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (svc:Service)-[:CONTAINS]->(:Function)-[:READS|WRITES]->(d:DataContainer {name: $n})
                 WHERE svc.id STARTS WITH $p AND d.id STARTS WITH $p AND d.valid_to_commit IS NULL
                 RETURN count(DISTINCT svc) AS n`,
                { n: name, p: PFX },
            );
            const v = r.records[0]?.get('n') ?? 0;
            return typeof v === 'object' && 'low' in v ? (v as any).low : Number(v);
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('welds same-name DataContainers across services when fingerprint matches', async () => {
        const svcA = `${PFX}service:php-quotes`;
        const svcB = `${PFX}service:ts-quotes`;
        const fnA = `${PFX}function:php:save`;
        const fnB = `${PFX}function:ts:findOne`;
        // alphabetically: dc:php < dc:ts → php is the winner.
        const dcA = `${PFX}datacontainer:php-quotes:quotes`;
        const dcB = `${PFX}datacontainer:ts-quotes:quotes`;
        const ds = `${PFX}datastore:shared:app_main`;

        await makeService(svcA, 'php-quotes');
        await makeService(svcB, 'ts-quotes');
        await makeFunction(fnA, svcA, 'save');
        await makeFunction(fnB, svcB, 'findOne');
        await makeDataContainer(dcA, 'quotes', { physicalEndpointKey: FP });
        await makeDataContainer(dcB, 'quotes', { physicalEndpointKey: FP });
        await makeDatastore(ds, 'app_main');
        await readsOrWrites('WRITES', fnA, dcA);
        await readsOrWrites('READS', fnB, dcB);
        await storedIn(dcA, ds);
        await storedIn(dcB, ds);

        expect(await countContainers('quotes')).toBe(2);

        const result = await weldDataContainersByEndpoint(COMMIT);
        expect(result.weldedPairs).toBe(1);
        expect(result.tombstoned).toBe(1);
        expect(result.rewiredEdges).toBeGreaterThanOrEqual(1);

        // Singleton invariant
        expect(await countContainers('quotes')).toBe(1);

        // Both services still reach the canonical
        expect(await countServicesReaching('quotes')).toBe(2);

        // Tombstone exists and points back to the winner
        const tomb = getNeo4jSession();
        try {
            const r = await tomb.run(
                `MATCH (d:DataContainer {name: 'quotes'}) WHERE d.valid_to_commit IS NOT NULL
                 RETURN d.id AS id, d.welded_into AS into`);
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('id')).toBe(dcB);
            expect(r.records[0].get('into')).toBe(dcA);
        } finally { await tomb.close(); }
    });

    it('is idempotent on a re-run', async () => {
        const svcA = `${PFX}service:a`;
        const svcB = `${PFX}service:b`;
        const dcA = `${PFX}datacontainer:a:t`;
        const dcB = `${PFX}datacontainer:b:t`;
        const fA = `${PFX}f:a`;
        const fB = `${PFX}f:b`;
        await makeService(svcA, 'a'); await makeService(svcB, 'b');
        await makeFunction(fA, svcA, 'fa'); await makeFunction(fB, svcB, 'fb');
        await makeDataContainer(dcA, 't', { physicalEndpointKey: FP });
        await makeDataContainer(dcB, 't', { physicalEndpointKey: FP });
        await readsOrWrites('READS', fA, dcA);
        await readsOrWrites('WRITES', fB, dcB);

        const r1 = await weldDataContainersByEndpoint(COMMIT);
        expect(r1.weldedPairs).toBe(1);
        const r2 = await weldDataContainersByEndpoint(COMMIT);
        expect(r2.weldedPairs).toBe(0);
    });

    it('does NOT weld when fingerprints differ', async () => {
        const svcA = `${PFX}service:a`;
        const svcB = `${PFX}service:b`;
        const dcA = `${PFX}datacontainer:a:users`;
        const dcB = `${PFX}datacontainer:b:users`;
        await makeService(svcA, 'a'); await makeService(svcB, 'b');
        await makeDataContainer(dcA, 'users', { physicalEndpointKey: '0000000000000001' });
        await makeDataContainer(dcB, 'users', { physicalEndpointKey: 'ffffffffffffffff' });
        const r = await weldDataContainersByEndpoint(COMMIT);
        expect(r.weldedPairs).toBe(0);
        expect(await countContainers('users')).toBe(2);
    });

    it('does NOT weld when kindFamily differs (MySQL table vs Mongo collection)', async () => {
        const svcA = `${PFX}service:a`;
        const svcB = `${PFX}service:b`;
        const dcA = `${PFX}datacontainer:a:users`;
        const dcB = `${PFX}datacontainer:b:users`;
        await makeService(svcA, 'a'); await makeService(svcB, 'b');
        await makeDataContainer(dcA, 'users', { physicalEndpointKey: FP, kindFamily: 'rdbms' });
        await makeDataContainer(dcB, 'users', { physicalEndpointKey: FP, kindFamily: 'document' });
        const r = await weldDataContainersByEndpoint(COMMIT);
        expect(r.weldedPairs).toBe(0);
        expect(await countContainers('users')).toBe(2);
    });

    it('does NOT weld when fingerprint is null on either side', async () => {
        const svcA = `${PFX}service:a`;
        const svcB = `${PFX}service:b`;
        const dcA = `${PFX}datacontainer:a:t`;
        const dcB = `${PFX}datacontainer:b:t`;
        await makeService(svcA, 'a'); await makeService(svcB, 'b');
        await makeDataContainer(dcA, 't', { physicalEndpointKey: null });
        await makeDataContainer(dcB, 't', { physicalEndpointKey: FP });
        const r = await weldDataContainersByEndpoint(COMMIT);
        expect(r.weldedPairs).toBe(0);
        expect(await countContainers('t')).toBe(2);
    });

    it('does NOT weld when schemaOrNs differs (Postgres safety)', async () => {
        const svcA = `${PFX}service:a`;
        const svcB = `${PFX}service:b`;
        const dcA = `${PFX}datacontainer:a:users`;
        const dcB = `${PFX}datacontainer:b:users`;
        await makeService(svcA, 'a'); await makeService(svcB, 'b');
        await makeDataContainer(dcA, 'users', { physicalEndpointKey: FP, schemaOrNs: 'public' });
        await makeDataContainer(dcB, 'users', { physicalEndpointKey: FP, schemaOrNs: 'audit' });
        const r = await weldDataContainersByEndpoint(COMMIT);
        expect(r.weldedPairs).toBe(0);
        expect(await countContainers('users')).toBe(2);
    });

    it('does NOT weld when confidence is medium on either side', async () => {
        const svcA = `${PFX}service:a`;
        const svcB = `${PFX}service:b`;
        const dcA = `${PFX}datacontainer:a:t`;
        const dcB = `${PFX}datacontainer:b:t`;
        await makeService(svcA, 'a'); await makeService(svcB, 'b');
        await makeDataContainer(dcA, 't', { physicalEndpointKey: FP, confidence: 'medium' });
        await makeDataContainer(dcB, 't', { physicalEndpointKey: FP, confidence: 'high' });
        const r = await weldDataContainersByEndpoint(COMMIT);
        expect(r.weldedPairs).toBe(0);
        expect(await countContainers('t')).toBe(2);
    });

    it('zero-row diagnostic Cypher after weld (regression assertion)', async () => {
        const svcA = `${PFX}service:a`;
        const svcB = `${PFX}service:b`;
        const dcA = `${PFX}datacontainer:a:orders`;
        const dcB = `${PFX}datacontainer:b:orders`;
        await makeService(svcA, 'a'); await makeService(svcB, 'b');
        await makeDataContainer(dcA, 'orders', { physicalEndpointKey: FP });
        await makeDataContainer(dcB, 'orders', { physicalEndpointKey: FP });
        await weldDataContainersByEndpoint(COMMIT);

        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (a:DataContainer), (b:DataContainer)
                 WHERE a.id < b.id
                   AND a.valid_to_commit IS NULL AND b.valid_to_commit IS NULL
                   AND a.physicalEndpointKey IS NOT NULL
                   AND a.physicalEndpointKey = b.physicalEndpointKey
                   AND a.kindFamily IS NOT NULL AND b.kindFamily IS NOT NULL
                   AND a.kindFamily = b.kindFamily
                   AND toLower(a.name) = toLower(b.name)
                   AND a.id STARTS WITH $p AND b.id STARTS WITH $p
                 RETURN count(*) AS n`,
                { p: PFX },
            );
            const v = r.records[0]?.get('n') ?? 0;
            const num = typeof v === 'object' && 'low' in v ? (v as any).low : Number(v);
            expect(num).toBe(0);
        } finally { await s.close(); }
    });
});
