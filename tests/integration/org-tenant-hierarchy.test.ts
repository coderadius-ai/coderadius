import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeRepository } from '../../src/graph/mutations/code-graph.js';
import {
    mergeTenant,
    linkRootOrganizationsToTenant,
} from '../../src/graph/mutations/organization.js';
import { getInventoryReport } from '../../src/graph/queries/inventory.js';
import { runReconcile } from '../../src/ingestion/workflows/reconcile.workflow.js';
import { configManager } from '../../src/config/index.js';
import { buildUrn } from '../../src/graph/urn.js';

// ═════════════════════════════════════════════════════════════════════════════
// Organization / Tenant, single-level model.
//
// (a) Direct mutations: tenant -> base orgs -> repo topology + idempotency
//     (PART_OF edge count + Tenant evidence array stable on re-run). Subgroup
//     paths collapse into the base org; no nesting is ever materialised.
// (b) Wiring guard: runReconcile reads tenant from config and materialises the
//     Tenant + PART_OF edges. This is the test that catches the inert-scaffolding
//     regression (mergeTenant/linkRoot... wired into the terminal pass).
//
// Org/Tenant URNs are not PFX-scoped (buildUrn), so wipe() targets all :Tenant
// (a new, deployment-singleton concept) plus the distinctive `crtestorg` org
// and its repos, leaving unrelated graph data untouched.
// ═════════════════════════════════════════════════════════════════════════════

describe('Organization/Tenant hierarchy', () => {
    const COMMIT = 'ORG_TENANT_TEST';
    const TENANT = { slug: 'cr-test-tenant', name: 'CR Test Tenant', description: 'integration fixture' };
    const TENANT_URN = buildUrn('tenant', TENANT.slug); // cr:tenant:cr-test-tenant
    const ROOT = 'crtestorg';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (t:Tenant) DETACH DELETE t');
            // linkRootOrganizationsToTenant links ALL orgs, so this test owns a
            // clean Organization space (drop any leaked from other suites).
            await s.run('MATCH (o:Organization) DETACH DELETE o');
            await s.run('MATCH (r:Repository) WHERE r.id STARTS WITH $p DETACH DELETE r', { p: `cr:repository:${ROOT}` });
        } finally { await s.close(); }
    }

    async function seedRepos() {
        // mergeRepository derives the base Organization + BELONGS_TO via the real path.
        // Subgroup paths stay in the repo IDENTITY but collapse for the org node.
        await mergeRepository('orders', undefined, COMMIT, `${ROOT}/payments`);
        await mergeRepository('ts-lib', undefined, COMMIT, `${ROOT}/lib/ts`);
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('builds tenant -> base org -> repo and is idempotent (direct mutations)', async () => {
        async function seed() {
            await mergeTenant(TENANT.slug, TENANT.name, TENANT.description, COMMIT);
            await seedRepos();
            await linkRootOrganizationsToTenant(TENANT.slug, COMMIT);
        }
        await seed();

        const s = getNeo4jSession();
        try {
            // Tenant exists and is grounded as a customer declaration (not ast).
            const t = await s.run('MATCH (t:Tenant {id: $id}) RETURN t.source AS source, t.name AS name, t.slug AS slug', { id: TENANT_URN });
            expect(t.records).toHaveLength(1);
            expect(t.records[0].get('source')).toBe('declared');
            expect(t.records[0].get('name')).toBe(TENANT.name);
            expect(t.records[0].get('slug')).toBe(TENANT.slug);

            // Both subgroup repos collapsed into ONE base org; it is the only org.
            const orgs = await s.run('MATCH (o:Organization) RETURN o.fullPath AS fullPath ORDER BY o.fullPath');
            expect(orgs.records.map(r => r.get('fullPath'))).toEqual([ROOT]);

            // PART_OF from the base org.
            const partOf = await s.run(
                'MATCH (o:Organization)-[:PART_OF]->(:Tenant {id: $id}) RETURN o.fullPath AS fullPath',
                { id: TENANT_URN });
            expect(partOf.records.map(r => r.get('fullPath'))).toEqual([ROOT]);

            // Full traversal: Tenant <- PART_OF <- org <- BELONGS_TO <- Repository.
            const traversal = await s.run(
                `MATCH (:Tenant {id: $id})<-[:PART_OF]-(:Organization)<-[:BELONGS_TO]-(r:Repository)
                 RETURN DISTINCT r.name AS repo ORDER BY r.name`,
                { id: TENANT_URN });
            expect(traversal.records.map(r => r.get('repo'))).toEqual(['orders', 'ts-lib']);

            // Idempotency baselines.
            const partOfCount = async () =>
                Number((await s.run('MATCH (:Organization)-[r:PART_OF]->(:Tenant {id: $id}) RETURN count(r) AS c', { id: TENANT_URN })).records[0].get('c'));
            const extractorLen = async () =>
                Number((await s.run('MATCH (t:Tenant {id: $id}) RETURN size(t.evidence_extractors) AS n', { id: TENANT_URN })).records[0].get('n'));
            const beforeEdges = await partOfCount();
            const beforeExtractors = await extractorLen();
            expect(beforeEdges).toBe(1);

            // Second run is a no-op: no duplicate edges, no evidence-array ballooning.
            await seed();
            expect(await partOfCount()).toBe(beforeEdges);
            expect(await extractorLen()).toBe(beforeExtractors);
        } finally { await s.close(); }
    });

    it('runReconcile materialises the Tenant + PART_OF from config (wiring guard)', async () => {
        // Repo ingestion builds orgs but never a Tenant (today's inert state).
        await seedRepos();
        const s = getNeo4jSession();
        try {
            const pre = await s.run('MATCH (t:Tenant {id: $id}) RETURN count(t) AS c', { id: TENANT_URN });
            expect(Number(pre.records[0].get('c'))).toBe(0);
        } finally { await s.close(); }

        // Inject tenant config, preserving the rest of the real config so the
        // other (graph-only) reconcile passes behave normally.
        const realConfig = configManager.getRawConfig();
        vi.spyOn(configManager, 'getRawConfig').mockReturnValue({ ...realConfig, tenant: TENANT });

        await runReconcile({ repos: [], commitHash: COMMIT });

        const s2 = getNeo4jSession();
        try {
            const linked = await s2.run(
                'MATCH (o:Organization)-[:PART_OF]->(t:Tenant {id: $id}) RETURN t.name AS name, collect(o.fullPath) AS roots',
                { id: TENANT_URN });
            expect(linked.records).toHaveLength(1);
            expect(linked.records[0].get('name')).toBe(TENANT.name);
            expect(linked.records[0].get('roots')).toContain(ROOT);
        } finally { await s2.close(); }

        // The inventory report (what the dashboard consumes) now carries the tenant.
        const report = await getInventoryReport();
        expect(report.tenant?.name).toBe(TENANT.name);
        expect(report.tenant?.slug).toBe(TENANT.slug);

        // Single-level: the only org is the base group.
        const myOrgs = report.organizations.filter(o => o.fullPath.startsWith(ROOT));
        expect(myOrgs.map(o => o.fullPath)).toEqual([ROOT]);

        // Repository org is read from the BELONGS_TO edge (base group).
        const orders = report.repositories.find(r => r.name === 'orders' && (r.org ?? '').startsWith(ROOT));
        expect(orders?.org).toBe(ROOT);
    });
});
