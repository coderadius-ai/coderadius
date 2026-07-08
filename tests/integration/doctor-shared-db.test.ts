import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { findSharedDbCandidates, groupSharedDbSuggestions } from '../../src/graph/queries/doctor.js';

// ─── `cr doctor` shared-database suggester ────────────────────────────────────
//
// When two repos each own a same-named DataContainer in their OWN scope,
// stored in per-repo Datastores whose endpoints resolve the same database
// name, the welder has no physical fingerprint to merge on (compose hosts are
// unfingerprintable). Doctor must surface the pair as a `databases[]`
// declaration candidate — and must NOT surface same-named tables whose
// endpoints resolve different databases.

describe('findSharedDbCandidates', () => {
    const PFX = 'cr://test/doctor/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally {
            await s.close();
        }
    }

    interface RepoSeed {
        repo: string;       // qualified repo name (DataContainer.sourceRepo, Datastore.namespace)
        table: string;      // DataContainer.name
        dbName: string;     // DatabaseEndpoint.dbName
        technology?: string;
        namespace?: string; // Datastore.namespace override (e.g. 'shared')
    }

    /** Seed one repo's chain: DataContainer → STORED_IN → Datastore → SERVED_BY → DatabaseEndpoint. */
    async function seedChain(key: string, seed: RepoSeed) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (dc:DataContainer {id: $dcId})
                 SET dc.name = $table, dc.scope = $repo, dc.sourceRepo = $repo,
                     dc.valid_from_commit = 'TEST', dc.valid_to_commit = null
                 CREATE (ds:Datastore {id: $dsId})
                 SET ds.name = 'db', ds.namespace = $namespace, ds.technology = $technology,
                     ds.valid_from_commit = 'TEST', ds.valid_to_commit = null
                 CREATE (ep:DatabaseEndpoint {id: $epId})
                 SET ep.dbName = $dbName, ep.environment = 'development',
                     ep.valid_from_commit = 'TEST', ep.valid_to_commit = null
                 CREATE (dc)-[:STORED_IN {valid_from_commit: 'TEST', valid_to_commit: null}]->(ds)
                 CREATE (ds)-[:SERVED_BY {valid_from_commit: 'TEST', valid_to_commit: null}]->(ep)`,
                {
                    dcId: `${PFX}dc/${key}`,
                    dsId: `${PFX}ds/${key}`,
                    epId: `${PFX}ep/${key}`,
                    table: seed.table,
                    repo: seed.repo,
                    namespace: seed.namespace ?? seed.repo,
                    technology: seed.technology ?? 'mysql',
                    dbName: seed.dbName,
                },
            );
        } finally { await s.close(); }
    }

    /** Only candidates from this test's seeds (the DB may hold other data). */
    async function testCandidates() {
        const rows = await findSharedDbCandidates();
        return rows.filter(r => r.repoA?.startsWith('acme/') && r.repoB?.startsWith('acme/'));
    }

    beforeAll(async () => {
        await initSchema();
        await wipe();
    });

    beforeEach(async () => {
        await wipe();
    });

    afterAll(async () => {
        await wipe();
        await closeNeo4j();
    });

    it('surfaces cross-repo same-named tables whose endpoints share a dbName root', async () => {
        await seedChain('orders', { repo: 'acme/orders', table: 'shipments', dbName: 'commerce-dev' });
        await seedChain('billing', { repo: 'acme/billing', table: 'shipments', dbName: 'commerce' });

        const rows = await testCandidates();
        expect(rows).toHaveLength(1);
        expect(rows[0].tableName).toBe('shipments');
        expect([rows[0].repoA, rows[0].repoB].sort()).toEqual(['acme/billing', 'acme/orders']);

        const suggestions = groupSharedDbSuggestions(rows);
        expect(suggestions).toEqual([{
            id: 'commerce',
            technology: 'mysql',
            repos: ['acme/billing', 'acme/orders'],
            tables: ['shipments'],
        }]);
    });

    it('still returns the raw pair when dbNames differ, but grouping rejects it', async () => {
        await seedChain('orders', { repo: 'acme/orders', table: 'users', dbName: 'orders' });
        await seedChain('billing', { repo: 'acme/billing', table: 'users', dbName: 'billing' });

        const rows = await testCandidates();
        expect(rows).toHaveLength(1); // the scan is broad by design…
        expect(groupSharedDbSuggestions(rows)).toEqual([]); // …the dbName gate is the filter
    });

    it('ignores containers in the same scope (single-repo duplicates are not cross-repo sharing)', async () => {
        await seedChain('a', { repo: 'acme/orders', table: 'shipments', dbName: 'commerce' });
        await seedChain('b', { repo: 'acme/orders', table: 'shipments', dbName: 'commerce' });

        expect(await testCandidates()).toEqual([]);
    });

    it('ignores tombstoned containers', async () => {
        await seedChain('orders', { repo: 'acme/orders', table: 'shipments', dbName: 'commerce' });
        await seedChain('billing', { repo: 'acme/billing', table: 'shipments', dbName: 'commerce' });
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (dc:DataContainer {id: $id}) SET dc.valid_to_commit = 'DEAD'`,
                { id: `${PFX}dc/billing` },
            );
        } finally { await s.close(); }

        expect(await testCandidates()).toEqual([]);
    });

    it('skips datastores already declared shared', async () => {
        await seedChain('orders', { repo: 'acme/orders', table: 'shipments', dbName: 'commerce', namespace: 'shared' });
        await seedChain('billing', { repo: 'acme/billing', table: 'shipments', dbName: 'commerce' });

        const rows = await testCandidates();
        expect(groupSharedDbSuggestions(rows)).toEqual([]);
    });
});
