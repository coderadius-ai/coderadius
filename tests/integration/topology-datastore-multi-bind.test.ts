import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { getTopologyMap } from '../../src/graph/queries/topology.js';

/**
 * Topology payload — a DataContainer with an ambiguous multi-candidate bind
 * (STORED_IN two Datastores) must surface BOTH stores, not just the first.
 *
 * Regression pin for the lossy read projection: the query fans a multi-STORED_IN
 * container into one row per datastore, and the upsert used to keep only the
 * first row's store (first-write-wins), silently dropping the co-candidate. The
 * payload field is now an array accumulated across rows, deduped by name.
 */
describe('getTopologyMap — DataContainer.datastore is the full STORED_IN set', () => {
    const PFX = 'cr:topology-multibind-test:';
    const svc = `${PFX}svc`;
    const fn = `${PFX}fn`;
    const dc = `${PFX}dc`;
    const dsA = `${PFX}dsArchive`;
    const dsB = `${PFX}dsHub`;

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n`,
                { p: PFX },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('accumulates both STORED_IN datastores into a 2-element array (no first-write-wins drop)', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE
                   (svc:Service       { id: $svc, name: 'archiver', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fn:Function       { id: $fn, name: 'archiveQuote', filepath: 'src/Archive.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (dc:DataContainer  { id: $dc, name: 'quote_{var}', kindFamily: 'document', technology: 'mongodb', needsReview: true, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (dsA:Datastore     { id: $dsA, name: 'archive', technology: 'mongodb', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (dsB:Datastore     { id: $dsB, name: 'integration-hub', technology: 'mongodb', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (svc)-[:CONTAINS   { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fn),
                   (fn)-[:READS       { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(dc),
                   (dc)-[:STORED_IN   { valid_from_commit: 'SYSTEM', valid_to_commit: null, bindingReason: 'ambiguous-multi-candidate' }]->(dsA),
                   (dc)-[:STORED_IN   { valid_from_commit: 'SYSTEM', valid_to_commit: null, bindingReason: 'ambiguous-multi-candidate' }]->(dsB)`,
                { svc, fn, dc, dsA, dsB },
            );
        } finally { await s.close(); }

        const topology = await getTopologyMap();

        const dcNode = topology.nodes[dc];
        expect(dcNode).toBeDefined();
        expect(dcNode.type).toBe('DataContainer');
        expect(dcNode.needsReview).toBe(true);

        const stores = (dcNode.datastore ?? []).map(d => d.name).sort();
        expect(stores).toEqual(['archive', 'integration-hub']);
    });

    it('keeps a single STORED_IN datastore as a 1-element array', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE
                   (svc:Service       { id: $svc, name: 'archiver', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fn:Function       { id: $fn, name: 'readOne', filepath: 'src/One.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (dc:DataContainer  { id: $dc, name: 'orders', kindFamily: 'rdbms', technology: 'mysql', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (dsA:Datastore     { id: $dsA, name: 'archive', technology: 'mysql', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (svc)-[:CONTAINS   { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fn),
                   (fn)-[:READS       { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(dc),
                   (dc)-[:STORED_IN   { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(dsA)`,
                { svc, fn, dc, dsA },
            );
        } finally { await s.close(); }

        const topology = await getTopologyMap();
        const stores = (topology.nodes[dc].datastore ?? []).map(d => d.name);
        expect(stores).toEqual(['archive']);
    });
});
