import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeService,
    linkServiceDependsOnService,
    linkServiceDependsOnUnresolved,
    bindUnresolvedDependencies,
} from '../../src/graph/mutations/c4.js';
import { astGrounding, declaredGrounding } from '../../src/graph/grounding.js';

// A catalog `dependsOn` is a customer-DECLARED fact. The placeholder node, the
// placeholder edge, and the late-bound DEPENDS_ON edge must all carry `declared`
// grounding (never the untagged heuristic/speculative default), so a catalog edge
// is distinguishable from a code-inferred one, and the bound edge records HOW it
// resolved (matchedBy: catalogName | name).

describe('Catalog dependsOn grounding (declared, not untagged)', () => {
    const C = 'DEP_GROUND_TEST';
    const REPO_A = 'depgroundtest/consumer-repo';
    const REPO_B = 'depgroundtest/target-repo';

    async function wipe() {
        const s = getNeo4jSession();
        try { await s.run("MATCH (n) WHERE n.id CONTAINS 'depgroundtest' DETACH DELETE n"); }
        finally { await s.close(); }
    }

    async function edgeGrounding(relType: string, fromName: string, toName: string) {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (a {name: $fromName})-[rel:${relType}]->(b {name: $toName})
                 RETURN rel.source AS source, rel.matchedBy AS matchedBy,
                        rel.evidence_extractors AS extractors, rel.needsReview AS needsReview
                 LIMIT 1`,
                { fromName, toName },
            );
            return r.records[0] ?? null;
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => {
        await wipe();
        // consumer (depgroundtest-consumer) + target whose catalogName is the declared ref
        await mergeService(REPO_A, 'depgroundtest-consumer', undefined, undefined, undefined, 'backstage', undefined, undefined, C, astGrounding('test-seed@v1'));
        await mergeService(REPO_B, 'depgroundtest-target', undefined, undefined, 'depgroundtest-dep', 'backstage', undefined, undefined, C, astGrounding('test-seed@v1'));
    });

    it('placeholder node + edge are grounded declared (not untagged)', async () => {
        await linkServiceDependsOnUnresolved(
            REPO_A, 'depgroundtest-consumer', 'depgroundtest-dep', C,
            { source: 'backstage' }, declaredGrounding('catalog-dependson@v1'),
        );

        const s = getNeo4jSession();
        try {
            const node = await s.run(
                `MATCH (u:UnresolvedDependency {name: 'depgroundtest-dep'})
                 RETURN u.source AS source, u.evidence_extractors AS extractors, u.needsReview AS needsReview`,
            );
            const n = node.records[0];
            expect(n?.get('source')).toBe('declared');
            expect(n?.get('extractors')).toContain('catalog-dependson@v1');
            expect(n?.get('needsReview')).not.toBe(true);  // declared, not untagged
        } finally { await s.close(); }

        const edge = await edgeGrounding('DEPENDS_ON', 'depgroundtest-consumer', 'depgroundtest-dep');
        expect(edge?.get('source')).toBe('declared');
        expect(edge?.get('extractors')).toContain('catalog-dependson@v1');
    });

    it('late-bound DEPENDS_ON carries declared grounding + matchedBy=catalogName', async () => {
        await linkServiceDependsOnUnresolved(
            REPO_A, 'depgroundtest-consumer', 'depgroundtest-dep', C,
            { source: 'backstage' }, declaredGrounding('catalog-dependson@v1'),
        );
        const result = await bindUnresolvedDependencies(C);
        expect(result.boundEdges).toBeGreaterThanOrEqual(1);

        // consumer now points at the real target (catalogName match), placeholder gone
        const edge = await edgeGrounding('DEPENDS_ON', 'depgroundtest-consumer', 'depgroundtest-target');
        expect(edge?.get('source')).toBe('declared');
        expect(edge?.get('matchedBy')).toBe('catalogName');

        const s = getNeo4jSession();
        try {
            const leftover = await s.run("MATCH (u:UnresolvedDependency {name: 'depgroundtest-dep'}) RETURN count(u) AS c");
            expect(Number(leftover.records[0]?.get('c') ?? -1)).toBe(0);
        } finally { await s.close(); }
    });

    it('intra-repo direct DEPENDS_ON edge is grounded declared', async () => {
        await linkServiceDependsOnService(
            REPO_A, 'depgroundtest-consumer', REPO_B, 'depgroundtest-target', C,
            { source: 'backstage' }, declaredGrounding('catalog-dependson@v1'),
        );
        const edge = await edgeGrounding('DEPENDS_ON', 'depgroundtest-consumer', 'depgroundtest-target');
        expect(edge?.get('source')).toBe('declared');
        expect(edge?.get('extractors')).toContain('catalog-dependson@v1');
    });
});
