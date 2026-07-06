import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { linkDataContainerStoredIn } from '../../src/graph/mutations/data-contracts.js';
import { seedDatastore, seedDataContainer } from './_helpers/delta-seeds.js';

// ─── ObjectStorage bucket → tech-named object Datastore (Phase 3) ───────────
//
// A cloud-object DataContainer (a bucket) must be STORED_IN an object :Datastore
// identified BY TECHNOLOGY (gcs/s3), mirroring how kv/timeseries stores are
// tech-named. resolveDatastoreBinding is connection-string based and returns
// nothing for buckets, so graph-writer's ObjectStorage case synthesizes the
// datastore from the bucket's intrinsic object technology and links STORED_IN.
// This pins the persistence shape those mutations produce + idempotency.

describe('ObjectStorage bucket → tech-named object Datastore', () => {
    const REPO = 'acme/objtest-p3';
    const COMMIT = 'TESTP3';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run("MATCH (n) WHERE n.id CONTAINS 'objtest-p3' DETACH DELETE n");
        } finally { await s.close(); }
    }

    async function q(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(cypher, params);
            const v = r.records[0]?.get('n');
            return typeof v === 'object' && v && 'low' in v ? (v as any).low : Number(v ?? 0);
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    async function promote() {
        await seedDataContainer(REPO, 'acme-invoices', COMMIT, { kindFamily: 'object', technology: 'gcs' });
        const dsUrn = await seedDatastore(REPO, 'gcs', 'gcs', COMMIT);
        await linkDataContainerStoredIn(REPO, 'acme-invoices', dsUrn, COMMIT, 'object-tech-autopromote', REPO);
        return dsUrn;
    }

    it('stamps the bucket kindFamily=object / technology=gcs with its bare name', async () => {
        await promote();
        const n = await q(
            `MATCH (c:DataContainer)
             WHERE c.id CONTAINS 'objtest-p3' AND c.name = 'acme-invoices'
               AND c.kindFamily = 'object' AND c.technology = 'gcs'
             RETURN count(c) AS n`,
        );
        expect(n).toBe(1);
    });

    it('promotes a tech-named gcs object Datastore and STORED_IN the bucket (no orphan)', async () => {
        const dsUrn = await promote();
        expect(dsUrn).toBe('cr:datastore:acme/objtest-p3:gcs');

        const dsCount = await q(
            `MATCH (d:Datastore) WHERE d.id = $urn AND d.technology = 'gcs' RETURN count(d) AS n`,
            { urn: dsUrn },
        );
        expect(dsCount).toBe(1);

        const edge = await q(
            `MATCH (c:DataContainer {name:'acme-invoices'})-[:STORED_IN]->(d:Datastore {id:$urn})
             WHERE c.id CONTAINS 'objtest-p3' RETURN count(*) AS n`,
            { urn: dsUrn },
        );
        expect(edge).toBe(1);
    });

    it('is idempotent: re-promote yields ONE object Datastore and ONE STORED_IN edge', async () => {
        await promote();
        await promote();

        const dsCount = await q(
            `MATCH (d:Datastore) WHERE d.id = 'cr:datastore:acme/objtest-p3:gcs' RETURN count(d) AS n`,
        );
        expect(dsCount).toBe(1);

        const edges = await q(
            `MATCH (c:DataContainer {name:'acme-invoices'})-[r:STORED_IN]->(:Datastore)
             WHERE c.id CONTAINS 'objtest-p3' RETURN count(r) AS n`,
        );
        expect(edges).toBe(1);
    });
});
