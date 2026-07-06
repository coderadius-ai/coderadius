import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeRepository, mergeFunction } from '../../src/graph/mutations/code-graph.js';
import { mergeService, mergeTeam, linkTeamOwnsService } from '../../src/graph/mutations/c4.js';
import { getInventoryReport } from '../../src/graph/queries/inventory.js';
import { buildUrn } from '../../src/graph/urn.js';
import { astGrounding } from '../../src/graph/grounding.js';

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2: `language` is a unified Technology node + WRITTEN_IN edge, not a
// scalar property. The languages[] DTO arrays must stay byte-identical so the
// dashboard is unaffected.
// ═════════════════════════════════════════════════════════════════════════════

describe('Technology node — language via WRITTEN_IN (Phase 2)', () => {
    const COMMIT = 'TECH_LANG_TEST';
    const ORG = 'crtechorg';
    const QRN = `${ORG}/billing`;
    const REPO_URN = buildUrn('repository', QRN);
    const SVC_URN = buildUrn('service', QRN, 'billing-svc');
    const FN_URN = buildUrn('function', QRN, 'billing-svc', 'computeTotal');
    const TEAM = 'crtechteam';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (t:Technology) DETACH DELETE t');
            await s.run('MATCH (o:Organization) WHERE o.fullPath STARTS WITH $p DETACH DELETE o', { p: ORG });
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: `cr:repository:${ORG}` });
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: `cr:service:${ORG}` });
            await s.run('MATCH (f:Function {id: $id}) DETACH DELETE f', { id: FN_URN });
            await s.run('MATCH (t:Team {id: $id}) DETACH DELETE t', { id: buildUrn('team', TEAM) });
        } finally { await s.close(); }
    }

    async function seed() {
        await mergeRepository('billing', undefined, COMMIT, ORG);
        await mergeService(QRN, 'billing-svc', 'php', undefined, undefined, undefined, undefined, undefined, COMMIT, astGrounding('test@v1'));
        await mergeFunction(FN_URN, 'computeTotal', 'src/x.ts', null, [], null, 'typescript', 1, 10, undefined, COMMIT);
        await mergeTeam(TEAM, COMMIT);
        await linkTeamOwnsService(TEAM, QRN, 'billing-svc', COMMIT);
        const s = getNeo4jSession();
        try {
            await s.run(
                'MATCH (svc:Service {id: $svc}), (r:Repository {id: $repo}) MERGE (svc)-[rel:STORED_IN]->(r) ON CREATE SET rel.valid_from_commit = $c, rel.valid_to_commit = null',
                { svc: SVC_URN, repo: REPO_URN, c: COMMIT });
            await s.run(
                'MATCH (svc:Service {id: $svc}), (f:Function {id: $fn}) MERGE (svc)-[rel:CONTAINS]->(f) ON CREATE SET rel.valid_from_commit = $c, rel.valid_to_commit = null',
                { svc: SVC_URN, fn: FN_URN, c: COMMIT });
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('writes language as a Technology node + WRITTEN_IN edge (service + function)', async () => {
        await seed();
        const s = getNeo4jSession();
        try {
            const svc = await s.run('MATCH (s:Service {id: $id})-[:WRITTEN_IN]->(t:Technology) RETURN t.kind AS kind, t.slug AS slug', { id: SVC_URN });
            expect(svc.records).toHaveLength(1);
            expect(svc.records[0].get('kind')).toBe('language');
            expect(svc.records[0].get('slug')).toBe('php');

            const fn = await s.run('MATCH (f:Function {id: $id})-[:WRITTEN_IN]->(t:Technology) RETURN t.slug AS slug', { id: FN_URN });
            expect(fn.records[0].get('slug')).toBe('typescript');
        } finally { await s.close(); }
    });

    it('projects the same languages[] DTO arrays from the edge', async () => {
        await seed();
        const report = await getInventoryReport();
        expect(report.repositories.find(r => r.name === 'billing')?.languages.slice().sort()).toEqual(['php', 'typescript']);
        expect(report.services.find(s => s.name === 'billing-svc')?.languages.slice().sort()).toEqual(['php', 'typescript']);
        expect(report.teams.find(t => t.name === TEAM)?.languages.slice().sort()).toEqual(['php', 'typescript']);
    });

    it('is idempotent (one Technology node + one WRITTEN_IN edge per language)', async () => {
        await seed();
        await seed();
        const s = getNeo4jSession();
        try {
            const techCount = await s.run("MATCH (t:Technology {kind: 'language'}) WHERE t.slug IN ['php', 'typescript'] RETURN count(t) AS c");
            expect(Number(techCount.records[0].get('c'))).toBe(2);
            const edgeCount = await s.run('MATCH (s:Service {id: $id})-[w:WRITTEN_IN]->(:Technology) RETURN count(w) AS c', { id: SVC_URN });
            expect(Number(edgeCount.records[0].get('c'))).toBe(1);
        } finally { await s.close(); }
    });
});
