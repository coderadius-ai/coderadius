import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { getGhostServices, getOrphanServices } from '../../src/graph/queries/drift.js';

// Catalog↔code alignment is bound at the Repository grain (a Backstage Component
// usually maps to a repo: CatalogEntity -[:DESCRIBES]-> Repository). Drift must
// count that as aligned, not only Service-level matches — otherwise a correctly
// matched component reads as a ghost and its code service as an orphan (the
// acme-monolith 0% false positive).

describe('Catalog drift — repository-level alignment', () => {
    const COMMIT = 'DRIFT_REPO_TEST';

    async function wipe() {
        const s = getNeo4jSession();
        try { await s.run("MATCH (n) WHERE n.id CONTAINS 'drifttest' DETACH DELETE n"); }
        finally { await s.close(); }
    }

    async function seed() {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (c:CatalogEntity {id: 'cr:catalogentity:drifttest:component', name: 'drifttest-component', kind: 'Component', catalogSource: 'backstage', entityRef: 'component:default/drifttest-component', valid_from_commit: $commit})
                 CREATE (g:CatalogEntity {id: 'cr:catalogentity:drifttest:ghost', name: 'drifttest-ghost', kind: 'Component', catalogSource: 'backstage', entityRef: 'component:default/drifttest-ghost', valid_from_commit: $commit})
                 CREATE (r:Repository {id: 'cr:repository:drifttest-repo', name: 'drifttest-repo', valid_from_commit: $commit})
                 CREATE (svc:Service {id: 'cr:service:drifttest-repo:drifttest-svc', name: 'drifttest-svc', valid_from_commit: $commit})
                 MERGE (c)-[rel1:DESCRIBES]->(r) ON CREATE SET rel1.valid_from_commit = $commit
                 MERGE (svc)-[rel2:STORED_IN]->(r) ON CREATE SET rel2.valid_from_commit = $commit`,
                { commit: COMMIT },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('a Component describing a Repository is aligned (not a ghost); one describing nothing stays a ghost', async () => {
        await seed();
        const names = (await getGhostServices()).map(g => g.name);
        expect(names).not.toContain('drifttest-component'); // aligned via Repository
        expect(names).toContain('drifttest-ghost');          // control: describes nothing → ghost
    });

    it('a Service whose Repository is described by a Component is not an orphan', async () => {
        await seed();
        const orphans = (await getOrphanServices()).map(o => o.name);
        expect(orphans).not.toContain('drifttest-svc');
    });
});
