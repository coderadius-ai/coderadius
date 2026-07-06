import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeRepository } from '../../src/graph/mutations/code-graph.js';
import { collapseNestedOrganizations } from '../../src/graph/mutations/organization.js';
import { getQualifiedRepoName, buildUrn } from '../../src/graph/urn.js';

// Organizations are SINGLE-LEVEL: GitLab subgroup paths collapse into the base
// group, because orgs may equally come from GitHub or a corporate IDP/LDAP
// where there is no nesting. Repo identity keeps the full subgroup path.

const PREFIX = 'orgsl';

async function wipe() {
    const s = getNeo4jSession();
    try {
        await s.run('MATCH (o:Organization) WHERE o.fullPath STARTS WITH $p DETACH DELETE o', { p: PREFIX });
        await s.run('MATCH (r:Repository) WHERE r.id STARTS WITH $p DETACH DELETE r', { p: `cr:repository:${PREFIX}` });
    } finally { await s.close(); }
}

describe('Single-level organizations', () => {
    const COMMIT = 'ORG_SL_TEST';

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('merges a subgroup repo under the BASE org only, with full-path identity', async () => {
        const org = `${PREFIX}group/platform/tools`;
        await mergeRepository('inventory-svc', `git@gitlab.acme.example:${org}/inventory-svc.git`, COMMIT, org);

        const s = getNeo4jSession();
        try {
            // One single org node: the base group. No nested nodes, no CHILD_OF.
            const orgs = await s.run(
                'MATCH (o:Organization) WHERE o.fullPath STARTS WITH $p RETURN o.fullPath AS path', { p: PREFIX });
            expect(orgs.records.map((r: any) => r.get('path'))).toEqual([`${PREFIX}group`]);

            // The repo belongs to the base org, but its identity keeps the full path.
            const repoUrn = buildUrn('repository', getQualifiedRepoName({ name: 'inventory-svc', org }));
            const belongs = await s.run(
                'MATCH (r:Repository {id: $id})-[:BELONGS_TO]->(o:Organization) RETURN o.fullPath AS org', { id: repoUrn });
            expect(belongs.records).toHaveLength(1);
            expect(belongs.records[0].get('org')).toBe(`${PREFIX}group`);
        } finally { await s.close(); }
    });

    it('collapseNestedOrganizations relinks repos and deletes legacy nested nodes', async () => {
        const s = getNeo4jSession();
        try {
            // Simulate a legacy graph: nested org chain + repo linked to the leaf.
            await s.run(
                `CREATE (root:Organization {id: 'cr:organization:${PREFIX}legacy', name: '${PREFIX}legacy', fullPath: '${PREFIX}legacy', level: 0})
                 CREATE (leaf:Organization {id: 'cr:organization:${PREFIX}legacy/sub', name: 'sub', fullPath: '${PREFIX}legacy/sub', level: 1})
                 CREATE (leaf)-[:CHILD_OF]->(root)
                 CREATE (r:Repository {id: 'cr:repository:${PREFIX}legacy/sub/old-repo', name: 'old-repo'})
                 CREATE (r)-[:BELONGS_TO]->(leaf)`, {});

            await collapseNestedOrganizations(COMMIT);

            const orgs = await s.run(
                'MATCH (o:Organization) WHERE o.fullPath STARTS WITH $p RETURN o.fullPath AS path', { p: PREFIX });
            expect(orgs.records.map((r: any) => r.get('path'))).toEqual([`${PREFIX}legacy`]);

            const belongs = await s.run(
                `MATCH (r:Repository {id: 'cr:repository:${PREFIX}legacy/sub/old-repo'})-[:BELONGS_TO]->(o:Organization)
                 RETURN o.fullPath AS org`, {});
            expect(belongs.records).toHaveLength(1);
            expect(belongs.records[0].get('org')).toBe(`${PREFIX}legacy`);
        } finally { await s.close(); }
    });

    it('is idempotent on an already-flat graph', async () => {
        const org = `${PREFIX}flat`;
        await mergeRepository('orders-svc', `git@github.com:${org}/orders-svc.git`, COMMIT, org);
        await collapseNestedOrganizations(COMMIT);

        const s = getNeo4jSession();
        try {
            const orgs = await s.run(
                'MATCH (o:Organization) WHERE o.fullPath STARTS WITH $p RETURN o.fullPath AS path', { p: PREFIX });
            expect(orgs.records.map((r: any) => r.get('path'))).toEqual([`${PREFIX}flat`]);
        } finally { await s.close(); }
    });
});
