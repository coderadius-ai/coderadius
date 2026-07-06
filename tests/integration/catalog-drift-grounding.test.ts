import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { getCatalogDriftReport } from '../../src/graph/queries/drift.js';

// Grounded-identity reconciliation: drift is only asserted between a declared
// dependency that resolves to a real node and the service's observed edge to
// that SAME node. Refs that resolve to nothing are "unverifiable" (off-score),
// never fabricated as drift. Five services exercise every branch.
//
// Scoped wipe (id CONTAINS 'drifttest') so the suite stays isolated; node names
// are 'dg-' prefixed to avoid colliding with another test's identity. The exact
// score/coverage math is unit-tested (drift-classify); here we pin the GRAPH ->
// classification wiring: which array each service lands in. An unverifiable
// service landing OUT of every scored array IS the off-score guarantee.

describe('Catalog drift — grounded reconciliation', () => {
    const C = 'DRIFT_GROUNDING_TEST';

    async function wipe() {
        const s = getNeo4jSession();
        try { await s.run("MATCH (n) WHERE n.id CONTAINS 'drifttest' DETACH DELETE n"); }
        finally { await s.close(); }
    }

    async function seed() {
        const s = getNeo4jSession();
        try {
            await s.run(
                `// catalog Components (declared truth)
                 CREATE (ca:CatalogEntity {id:'cr:catalogentity:drifttest:ca-aligned', name:'dg-aligned', kind:'Component', catalogSource:'backstage', entityRef:'component:default/dg-aligned', dependsOnJson:'["dg-ds-a"]', valid_from_commit:$c})
                 CREATE (cm:CatalogEntity {id:'cr:catalogentity:drifttest:ca-missing', name:'dg-missing', kind:'Component', catalogSource:'backstage', entityRef:'component:default/dg-missing', dependsOnJson:'["dg-ds-b"]', valid_from_commit:$c})
                 CREATE (cu:CatalogEntity {id:'cr:catalogentity:drifttest:ca-unver', name:'dg-unverifiable', kind:'Component', catalogSource:'backstage', entityRef:'component:default/dg-unverifiable', dependsOnJson:'["dg-ghost"]', valid_from_commit:$c})
                 CREATE (cd:CatalogEntity {id:'cr:catalogentity:drifttest:ca-undecl', name:'dg-undeclared', kind:'Component', catalogSource:'backstage', entityRef:'component:default/dg-undeclared', dependsOnJson:'["dg-ds-d"]', valid_from_commit:$c})
                 CREATE (cb:CatalogEntity {id:'cr:catalogentity:drifttest:ca-amb', name:'dg-ambiguous', kind:'Component', catalogSource:'backstage', entityRef:'component:default/dg-ambiguous', dependsOnJson:'["dg-ds-e","dg-ghost2"]', valid_from_commit:$c})
                 // services (code truth)
                 CREATE (sa:Service {id:'cr:service:drifttest:dg-aligned', name:'dg-aligned', valid_from_commit:$c})
                 CREATE (sm:Service {id:'cr:service:drifttest:dg-missing', name:'dg-missing', valid_from_commit:$c})
                 CREATE (su:Service {id:'cr:service:drifttest:dg-unverifiable', name:'dg-unverifiable', valid_from_commit:$c})
                 CREATE (sd:Service {id:'cr:service:drifttest:dg-undeclared', name:'dg-undeclared', valid_from_commit:$c})
                 CREATE (sb:Service {id:'cr:service:drifttest:dg-ambiguous', name:'dg-ambiguous', valid_from_commit:$c})
                 // dependency targets (Datastores)
                 CREATE (da:Datastore {id:'cr:datastore:drifttest:dg-ds-a', name:'dg-ds-a', valid_from_commit:$c})
                 CREATE (db:Datastore {id:'cr:datastore:drifttest:dg-ds-b', name:'dg-ds-b', valid_from_commit:$c})
                 CREATE (dd:Datastore {id:'cr:datastore:drifttest:dg-ds-d', name:'dg-ds-d', valid_from_commit:$c})
                 CREATE (dx:Datastore {id:'cr:datastore:drifttest:dg-ds-extra', name:'dg-ds-extra', valid_from_commit:$c})
                 CREATE (de:Datastore {id:'cr:datastore:drifttest:dg-ds-e', name:'dg-ds-e', valid_from_commit:$c})
                 CREATE (dsib:Datastore {id:'cr:datastore:drifttest:dg-ds-sibling', name:'dg-ds-sibling', valid_from_commit:$c})
                 // catalog -> service
                 CREATE (ca)-[:DESCRIBES {valid_from_commit:$c}]->(sa)
                 CREATE (cm)-[:DESCRIBES {valid_from_commit:$c}]->(sm)
                 CREATE (cu)-[:DESCRIBES {valid_from_commit:$c}]->(su)
                 CREATE (cd)-[:DESCRIBES {valid_from_commit:$c}]->(sd)
                 CREATE (cb)-[:DESCRIBES {valid_from_commit:$c}]->(sb)
                 // observed dependency edges
                 CREATE (sa)-[:CONNECTS_TO {valid_from_commit:$c}]->(da)   // aligned
                 // (sm has NO edge to db -> grounded missing)
                 CREATE (sd)-[:CONNECTS_TO {valid_from_commit:$c}]->(dd)   // aligned part
                 CREATE (sd)-[:CONNECTS_TO {valid_from_commit:$c}]->(dx)   // observed-undeclared
                 CREATE (sb)-[:CONNECTS_TO {valid_from_commit:$c}]->(de)   // aligned part
                 CREATE (sb)-[:CONNECTS_TO {valid_from_commit:$c}]->(dsib) // ambiguous (a declaration is unresolved)`,
                { c: C },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); await seed(); });

    it('classifies each service into aligned / grounded-drift / unverifiable', async () => {
        const report = await getCatalogDriftReport();
        const driftBy = new Map(report.dependencyDrift.map(d => [d.serviceName, d]));
        const unverBy = new Map(report.unverifiable.map(u => [u.serviceName, u]));

        // aligned: no drift, no unverifiable
        expect(driftBy.has('dg-aligned')).toBe(false);
        expect(unverBy.has('dg-aligned')).toBe(false);

        // grounded drift: declared dg-ds-b resolves but the edge is missing
        expect(driftBy.get('dg-missing')?.groundedMissing).toEqual(['dg-ds-b']);
        expect(driftBy.get('dg-missing')?.observedUndeclared).toEqual([]);

        // observed-undeclared drift: fully grounded, an extra edge code-only
        expect(driftBy.get('dg-undeclared')?.observedUndeclared).toEqual(['dg-ds-extra']);
        expect(driftBy.get('dg-undeclared')?.groundedMissing).toEqual([]);

        // unverifiable: declared ref resolves to no node
        expect(unverBy.get('dg-unverifiable')?.refs).toEqual(['dg-ghost']);

        // ambiguity guard: one declaration unresolved -> the extra edge is
        // unverifiable, NOT undeclared drift
        expect(unverBy.get('dg-ambiguous')?.refs.sort()).toEqual(['dg-ds-sibling', 'dg-ghost2']);
    });

    it('unverifiable services are off-score (absent from every scored drift array)', async () => {
        const report = await getCatalogDriftReport();
        // Owner reconciliation and system membership are off-score (grounded-or-
        // unverifiable): only dependency drift, ghosts, and orphans lower the score.
        const scored = new Set([
            ...report.dependencyDrift.map(d => d.serviceName),
            ...report.ghostServices.map(g => g.name),
            ...report.orphanServices.map(o => o.name),
        ]);
        // unverifiable-only services never enter a scored array
        expect(scored.has('dg-unverifiable')).toBe(false);
        expect(scored.has('dg-ambiguous')).toBe(false);
        // grounded-drift services do
        expect(scored.has('dg-missing')).toBe(true);
        expect(scored.has('dg-undeclared')).toBe(true);
        // score + coverage are present and numeric
        expect(typeof report.summary.driftScore).toBe('number');
        expect(typeof report.summary.verifiableCoverage).toBe('number');
    });

    it('reports no API drift dimension', async () => {
        const report = await getCatalogDriftReport();
        expect(report).not.toHaveProperty('apiProvidesDrift');
        expect(report).not.toHaveProperty('apiConsumesDrift');
    });
});

// Owner drift is grounded-or-unverifiable; system membership (catalog-only) is a
// completeness signal. Neither lowers the alignment score: a catalog-vs-CODEOWNERS
// owner name mismatch we can't ground stays OFF-score (a name spelling must never
// fabricate drift), and a declared-but-unbuilt System surfaces as completeness,
// not drift.
describe('Catalog drift — owner & system are off-score', () => {
    const C = 'DRIFT_GROUNDING_TEST';

    async function wipe() {
        const s = getNeo4jSession();
        try { await s.run("MATCH (n) WHERE n.id CONTAINS 'drifttest' DETACH DELETE n"); }
        finally { await s.close(); }
    }

    async function seed() {
        const s = getNeo4jSession();
        try {
            await s.run(
                `// services (all described by a catalog entity -> not ghosts/orphans)
                 CREATE (s1:Service {id:'cr:service:drifttest:dg-own-mismatch', name:'dg-own-mismatch', valid_from_commit:$c})
                 CREATE (s2:Service {id:'cr:service:drifttest:dg-own-aligned', name:'dg-own-aligned', valid_from_commit:$c})
                 CREATE (s3:Service {id:'cr:service:drifttest:dg-own-aliased', name:'dg-own-aliased', valid_from_commit:$c})
                 CREATE (s4:Service {id:'cr:service:drifttest:dg-sys-gap', name:'dg-sys-gap', valid_from_commit:$c})
                 CREATE (s5:Service {id:'cr:service:drifttest:dg-sys-ok', name:'dg-sys-ok', valid_from_commit:$c})
                 CREATE (e1:CatalogEntity {id:'cr:catalogentity:drifttest:e1', name:'dg-own-mismatch', kind:'Component', catalogSource:'backstage', valid_from_commit:$c})
                 CREATE (e2:CatalogEntity {id:'cr:catalogentity:drifttest:e2', name:'dg-own-aligned', kind:'Component', catalogSource:'backstage', valid_from_commit:$c})
                 CREATE (e3:CatalogEntity {id:'cr:catalogentity:drifttest:e3', name:'dg-own-aliased', kind:'Component', catalogSource:'backstage', valid_from_commit:$c})
                 CREATE (e4:CatalogEntity {id:'cr:catalogentity:drifttest:e4', name:'dg-sys-gap', kind:'Component', catalogSource:'backstage', system:'dg-sys-checkout', valid_from_commit:$c})
                 CREATE (e5:CatalogEntity {id:'cr:catalogentity:drifttest:e5', name:'dg-sys-ok', kind:'Component', catalogSource:'backstage', system:'dg-sys-billing', valid_from_commit:$c})
                 CREATE (e1)-[:DESCRIBES {valid_from_commit:$c}]->(s1)
                 CREATE (e2)-[:DESCRIBES {valid_from_commit:$c}]->(s2)
                 CREATE (e3)-[:DESCRIBES {valid_from_commit:$c}]->(s3)
                 CREATE (e4)-[:DESCRIBES {valid_from_commit:$c}]->(s4)
                 CREATE (e5)-[:DESCRIBES {valid_from_commit:$c}]->(s5)
                 // s1: genuine identity mismatch, no alias -> owner review (off-score)
                 CREATE (tc1:Team {id:'cr:team:drifttest:dg-team-platform', name:'dg-team-platform', valid_from_commit:$c})
                 CREATE (td1:Team {id:'cr:team:drifttest:dg-team-platform-squad', name:'dg-team-platform-squad', valid_from_commit:$c})
                 CREATE (tc1)-[:OWNS {source:'backstage', valid_from_commit:$c}]->(s1)
                 CREATE (td1)-[:OWNS {source:'codeowners', valid_from_commit:$c}]->(s1)
                 // s2: same Team identity via both sources -> aligned (not flagged)
                 CREATE (t2:Team {id:'cr:team:drifttest:dg-team-orders', name:'dg-team-orders', valid_from_commit:$c})
                 CREATE (t2)-[:OWNS {source:'backstage', valid_from_commit:$c}]->(s2)
                 CREATE (t2)-[:OWNS {source:'codeowners', valid_from_commit:$c}]->(s2)
                 // s3: two identities reconciled by an approved TeamAlias -> aligned
                 CREATE (tc3:Team {id:'cr:team:drifttest:dg-team-pay', name:'dg-team-pay', valid_from_commit:$c})
                 CREATE (td3:Team {id:'cr:team:drifttest:dg-team-pay-team', name:'dg-team-pay-team', valid_from_commit:$c})
                 CREATE (tc3)-[:OWNS {source:'backstage', valid_from_commit:$c}]->(s3)
                 CREATE (td3)-[:OWNS {source:'codeowners', valid_from_commit:$c}]->(s3)
                 CREATE (al:TeamAlias {id:'cr:teamalias:drifttest:dg-team-pay-team', status:'approved', phantomName:'dg-team-pay-team', valid_from_commit:$c})
                 CREATE (al)-[:PROPOSED_ALIAS_OF]->(tc3)
                 // s4: declares a system but no System node -> completeness gap (off-score)
                 // s5: declares a system AND the System contains it -> not flagged
                 CREATE (sys5:System {id:'cr:system:drifttest:dg-sys-billing', name:'dg-sys-billing', valid_from_commit:$c})
                 CREATE (sys5)-[:CONTAINS {valid_from_commit:$c}]->(s5)`,
                { c: C },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); await seed(); });

    it('owner: only an unreconciled identity mismatch lands in ownerReview', async () => {
        const report = await getCatalogDriftReport();
        const review = new Set(report.ownerReview.map(o => o.serviceName));
        expect(review.has('dg-own-mismatch')).toBe(true);   // genuine mismatch, no alias
        expect(review.has('dg-own-aligned')).toBe(false);   // same Team identity
        expect(review.has('dg-own-aliased')).toBe(false);   // approved alias reconciles
        const item = report.ownerReview.find(o => o.serviceName === 'dg-own-mismatch');
        expect(item?.catalogOwner).toBe('dg-team-platform');
        expect(item?.codeOwner).toBe('dg-team-platform-squad');
    });

    it('system: a declared-but-unbuilt System is a completeness gap, not drift', async () => {
        const report = await getCatalogDriftReport();
        const gaps = new Set(report.systemCompleteness.map(x => x.serviceName));
        expect(gaps.has('dg-sys-gap')).toBe(true);
        expect(gaps.has('dg-sys-ok')).toBe(false);
    });

    it('owner & system never enter a scored array (off-score)', async () => {
        const report = await getCatalogDriftReport();
        const scored = new Set([
            ...report.dependencyDrift.map(d => d.serviceName),
            ...report.ghostServices.map(g => g.name),
            ...report.orphanServices.map(o => o.name),
        ]);
        for (const n of ['dg-own-mismatch', 'dg-own-aligned', 'dg-own-aliased', 'dg-sys-gap', 'dg-sys-ok']) {
            expect(scored.has(n)).toBe(false);
        }
        // the old score-lowering shapes are gone
        expect(report).not.toHaveProperty('ownerDrift');
        expect(report).not.toHaveProperty('systemDrift');
    });
});
