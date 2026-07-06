import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeRepository } from '../../src/graph/mutations/code-graph.js';
import { mergeContextProvenanceEdges } from '../../src/graph/mutations/context-provenance.js';
import { getInventoryReport } from '../../src/graph/queries/inventory.js';
import { getQualifiedRepoName, buildUrn } from '../../src/graph/urn.js';
import type { ContextProvenance } from '../../src/ingestion/core/source-resolver.js';

// A context-import source repo (created by mergeContextProvenanceEdges, not the
// analyze path) must get its org on the BELONGS_TO edge, like any other repo —
// not as a stale `source.org` property the edge-based read no longer sees.
//
// Organizations are single-level: a subgroup path like `ctxtestsrc/docs`
// collapses to the base group `ctxtestsrc`. Repo IDENTITY keeps the full path.

describe('Context-provenance source repo org (Phase 1 completion)', () => {
    const COMMIT = 'CTX_PROV_TEST';
    const CONSUMER_ORG = 'ctxtestcons';
    const SOURCE_ORG = 'ctxtestsrc/docs';
    const consumerQRN = getQualifiedRepoName({ name: 'consumer-repo', org: CONSUMER_ORG });
    const SOURCE_URN = buildUrn('repository', getQualifiedRepoName({ name: 'ctx-source', org: SOURCE_ORG }));

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (o:Organization) WHERE o.fullPath STARTS WITH $a OR o.fullPath STARTS WITH $b DETACH DELETE o', { a: 'ctxtestcons', b: 'ctxtestsrc' });
            await s.run('MATCH (r:Repository) WHERE r.id STARTS WITH $a OR r.id STARTS WITH $b DETACH DELETE r', { a: 'cr:repository:ctxtestcons', b: 'cr:repository:ctxtestsrc' });
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('builds the BELONGS_TO org edge for a context-import source repo', async () => {
        // The consumer must exist for the mutation's MATCH.
        await mergeRepository('consumer-repo', `git@github.com:${CONSUMER_ORG}/consumer-repo.git`, COMMIT, CONSUMER_ORG);

        const provenance: ContextProvenance[] = [{
            sourceName: 'ctx-source',
            sourceUri: 'git@gitlab.acme.example:ctxtestsrc/docs/ctx-source.git',
            mechanism: 'git_submodule',
            mountPoint: '.ai/rules',
            sourceOrg: SOURCE_ORG,
        }];
        await mergeContextProvenanceEdges(consumerQRN, provenance);

        const s = getNeo4jSession();
        try {
            // The subgroup path collapsed: the edge points at the BASE org.
            const belongs = await s.run(
                'MATCH (r:Repository {id: $id})-[:BELONGS_TO]->(o:Organization) RETURN o.fullPath AS org',
                { id: SOURCE_URN });
            expect(belongs.records).toHaveLength(1);
            expect(belongs.records[0].get('org')).toBe('ctxtestsrc');

            // Single-level model: no nested Organization node was materialised.
            const nested = await s.run(
                'MATCH (o:Organization {fullPath: $leaf}) RETURN o',
                { leaf: SOURCE_ORG });
            expect(nested.records).toHaveLength(0);
        } finally { await s.close(); }

        // getRepositories projects the org from the edge (base group).
        const report = await getInventoryReport();
        expect(report.repositories.find(r => r.name === 'ctx-source')?.org).toBe('ctxtestsrc');
    });
});
