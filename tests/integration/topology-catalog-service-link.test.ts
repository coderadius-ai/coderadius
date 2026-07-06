import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { writeTopologyToGraph, type TopologyResult } from '../../src/ingestion/topology-resolver.js';

// The catalog→Service link (linkCatalogEntityToService) MATCHes an existing
// :Service node, so it must run AFTER mergeService. When it ran inside the
// catalog loop (before the service merge) the MATCH bound nothing → no edge,
// and the if/else swallowed the repo fallback for entities matched by name.
// (Real graph required: a mocked-queries unit test can't catch MATCH timing.)

describe('writeTopologyToGraph — catalog entity links to its Service', () => {
    const repo = { name: 'topotest-repo', org: 'topotestorg', path: '/tmp/topotest' };

    async function wipe() {
        const s = getNeo4jSession();
        try { await s.run("MATCH (n) WHERE n.id CONTAINS 'topotest' DETACH DELETE n"); }
        finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('a Component matched to a Service by catalogName gets DESCRIBES->Service', async () => {
        const result = {
            services: [{
                component: { name: 'topotest-svc', catalogName: 'topotest-component', catalogFile: '/tmp/topotest', source: 'backstage' },
                deploymentUnits: [],
                internalDeps: [],
                externalDeps: [],
            }],
            catalogEntities: [{
                name: 'topotest-component',
                catalogSource: 'backstage',
                source: 'backstage',
                type: 'service',
                catalogMeta: { kind: 'Component', namespace: 'default' },
            }],
            auxiliaryEntities: [],
            claimedPaths: [],
            effectiveTopology: 'monorepo',
        } as unknown as TopologyResult;

        await writeTopologyToGraph(result, repo);

        const s = getNeo4jSession();
        try {
            const r = await s.run(
                "MATCH (c:CatalogEntity)-[rel:DESCRIBES]->(svc:Service) WHERE c.name = 'topotest-component' RETURN svc.name AS service, rel.matchedBy AS matchedBy",
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('service')).toBe('topotest-svc');
            expect(r.records[0].get('matchedBy')).toBe('identity');
        } finally { await s.close(); }
    });

    it('a worker Component declaring partOf gets DESCRIBES->Service of its parent, not the Repository fallback', async () => {
        const result = {
            services: [{
                component: { name: 'topotest-svc', catalogName: 'topotest-component', catalogFile: '/tmp/topotest', source: 'backstage' },
                deploymentUnits: [],
                internalDeps: [],
                externalDeps: [],
            }],
            catalogEntities: [
                {
                    name: 'topotest-component',
                    catalogSource: 'backstage',
                    source: 'backstage',
                    type: 'service',
                    catalogMeta: { kind: 'Component', namespace: 'default' },
                },
                {
                    name: 'topotest-consumers',
                    catalogSource: 'backstage',
                    source: 'backstage',
                    type: 'worker',
                    catalogMeta: { kind: 'Component', namespace: 'default', partOf: ['topotest-component'] },
                },
            ],
            auxiliaryEntities: [],
            claimedPaths: [],
            effectiveTopology: 'monolith',
        } as unknown as TopologyResult;

        await writeTopologyToGraph(result, repo);

        const s = getNeo4jSession();
        try {
            const svc = await s.run(
                "MATCH (c:CatalogEntity {name: 'topotest-consumers'})-[rel:DESCRIBES]->(svc:Service) RETURN svc.name AS service, rel.matchedBy AS matchedBy",
            );
            expect(svc.records).toHaveLength(1);
            expect(svc.records[0].get('service')).toBe('topotest-svc');
            expect(svc.records[0].get('matchedBy')).toBe('partOf');

            // The repo fallback must NOT fire when partOf resolves.
            const repoEdge = await s.run(
                "MATCH (c:CatalogEntity {name: 'topotest-consumers'})-[:DESCRIBES]->(r:Repository) RETURN r",
            );
            expect(repoEdge.records).toHaveLength(0);

            // Declared containment survives on the node as a first-class property.
            const node = await s.run(
                "MATCH (c:CatalogEntity {name: 'topotest-consumers'}) RETURN c.partOfJson AS partOfJson",
            );
            expect(node.records[0].get('partOfJson')).toBe('["topotest-component"]');
        } finally { await s.close(); }
    });

    it('re-ingest heals a stale Repository fallback once the entity resolves to a Service (anchors are exclusive)', async () => {
        const worker = {
            name: 'topotest-consumers',
            catalogSource: 'backstage',
            source: 'backstage',
            type: 'worker',
            catalogMeta: { kind: 'Component', namespace: 'default', partOf: ['topotest-component'] },
        };
        const svc = {
            component: { name: 'topotest-svc', catalogName: 'topotest-component', catalogFile: '/tmp/topotest', source: 'backstage' },
            deploymentUnits: [],
            internalDeps: [],
            externalDeps: [],
        };
        const base = { auxiliaryEntities: [], claimedPaths: [], effectiveTopology: 'monolith' };

        // The Repository node is created by the repo merge upstream of the
        // topology writer — seed it so the fallback edge has a target.
        const seed = getNeo4jSession();
        try {
            await seed.run(
                "MERGE (r:Repository {id: 'cr:repository:topotestorg/topotest-repo'}) SET r.name = 'topotest-repo'",
            );
        } finally { await seed.close(); }

        // First ingest: no Service resolves (no partOf match) → Repository fallback fires.
        await writeTopologyToGraph({
            ...base, services: [], catalogEntities: [worker],
        } as unknown as TopologyResult, repo);

        const mid = getNeo4jSession();
        try {
            const r = await mid.run(
                "MATCH (c:CatalogEntity {name: 'topotest-consumers'})-[:DESCRIBES]->(t) RETURN labels(t)[0] AS lbl",
            );
            expect(r.records.map(x => x.get('lbl'))).toEqual(['Repository']);
        } finally { await mid.close(); }

        // Second ingest: partOf now resolves → the stale repo anchor must be replaced.
        await writeTopologyToGraph({
            ...base, services: [svc], catalogEntities: [worker],
        } as unknown as TopologyResult, repo);

        const s = getNeo4jSession();
        try {
            const edges = await s.run(
                "MATCH (c:CatalogEntity {name: 'topotest-consumers'})-[:DESCRIBES]->(t) RETURN labels(t)[0] AS lbl",
            );
            expect(edges.records.map(r => r.get('lbl'))).toEqual(['Service']);
        } finally { await s.close(); }
    });
});
