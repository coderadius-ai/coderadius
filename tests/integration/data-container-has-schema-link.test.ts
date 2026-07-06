import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeEmergentSchema,
    linkDataContainerSchemas,
} from '../../src/graph/mutations/data-contracts.js';
import { buildUrn } from '../../src/graph/urn.js';

// ─── HAS_SCHEMA link invariant (Phase 1A regression) ───────────────────────
//
// `linkDataContainerSchemas` joins on a shared Repository: a Service has at
// least one Function READS/WRITES/MAPS_TO the DataContainer, the Service is
// STORED_IN a Repository that ALSO CONTAINS the SourceFile that DEFINES_SCHEMA
// the matching DataStructure.
//
// Bug (orchestrator, 2026-05-16): `persistSchemas` derived `qualifiedRepoName`
// from `relativePath.split('/')[0]` when no explicit value was passed,
// producing a shadow SourceFile with URN `cr:sourcefile:classes:...` instead
// of `cr:sourcefile:acme/orders:...`. The shadow node carried DEFINES_SCHEMA
// but was orphan (no inbound CONTAINS from any Repository), so the join in
// `linkDataContainerSchemas` ALWAYS returned NULL for the SourceFile side
// and the HAS_SCHEMA edge was never created.
//
// These tests pin the invariant: `mergeEmergentSchema` MUST use the caller-
// provided `qualifiedRepoName` so the SourceFile URN coincides with the one
// merkle.ts created and linked under `Repository -[:CONTAINS]-> SourceFile`.

describe('DataContainer HAS_SCHEMA link — SourceFile URN consistency', () => {
    const REPO_NAME = 'acme/orders';
    const REPO_URN = buildUrn('repository', REPO_NAME);
    const SERVICE_URN = buildUrn('service', REPO_NAME, 'orders-service');
    const FN_URN = buildUrn('function', REPO_NAME, 'classes/Repository/SaveRepo.php', 'findAll');
    const DC_URN = buildUrn('datacontainer', REPO_NAME, 'quotes_archive');
    const ENTITY_RELPATH = 'classes/Entity/Snapshot.php';
    const SF_URN_CORRECT = buildUrn('sourcefile', REPO_NAME, ENTITY_RELPATH);
    const DS_URN = buildUrn('schema', 'database_table', 'quotes_archive');

    async function wipe() {
        const s = getNeo4jSession();
        try {
            // Wipe everything touched by these tests (URN-based, so other
            // suites are unaffected).
            await s.run(
                `MATCH (n) WHERE
                   n.id = $repo OR n.id = $svc OR n.id = $fn OR n.id = $dc
                   OR n.id STARTS WITH 'cr:sourcefile:acme/orders:'
                   OR n.id STARTS WITH 'cr:sourcefile:classes:'
                   OR n.id = $ds
                   OR n.id STARTS WITH 'cr:schema:database_table:quotes_'
                   OR n.id STARTS WITH 'cr:schema:database_table:quotes_archive:'
                 DETACH DELETE n`,
                { repo: REPO_URN, svc: SERVICE_URN, fn: FN_URN, dc: DC_URN, ds: DS_URN },
            );
        } finally { await s.close(); }
    }

    async function seedConsumerSide() {
        // Repository + Service (STORED_IN) + Function (CONTAINS) + DataContainer (READS)
        // + Repository CONTAINS SourceFile (correct URN), as merkle would have built.
        // Memgraph quirk: literal `null` is not allowed inside CREATE/MERGE
        // property maps — assign via SET in a follow-up clause.
        const s = getNeo4jSession();
        try {
            await s.run(`
                CREATE (r:Repository {id: $repo})
                SET r.name = 'orders', r.valid_from_commit = 'TEST', r.valid_to_commit = null
                CREATE (svc:Service {id: $svc})
                SET svc.name = 'orders-service', svc.valid_from_commit = 'TEST', svc.valid_to_commit = null
                CREATE (fn:Function {id: $fn})
                SET fn.name = 'findAll', fn.valid_from_commit = 'TEST', fn.valid_to_commit = null
                CREATE (dc:DataContainer {id: $dc})
                SET dc.name = 'quotes_archive', dc.valid_from_commit = 'TEST', dc.valid_to_commit = null
                CREATE (sf:SourceFile {id: $sfCorrect})
                SET sf.name = 'Snapshot.php', sf.path = $relPath, sf.valid_from_commit = 'TEST', sf.valid_to_commit = null
                MERGE (svc)-[a:STORED_IN]->(r) ON CREATE SET a.valid_from_commit = 'TEST', a.valid_to_commit = null
                MERGE (svc)-[b:CONTAINS]->(fn) ON CREATE SET b.valid_from_commit = 'TEST', b.valid_to_commit = null
                MERGE (fn)-[c:READS]->(dc) ON CREATE SET c.valid_from_commit = 'TEST', c.valid_to_commit = null
                MERGE (r)-[d:CONTAINS]->(sf) ON CREATE SET d.valid_from_commit = 'TEST', d.valid_to_commit = null
            `, { repo: REPO_URN, svc: SERVICE_URN, fn: FN_URN, dc: DC_URN, sfCorrect: SF_URN_CORRECT, relPath: ENTITY_RELPATH });
        } finally { await s.close(); }
    }

    async function countSourceFilesByPath(): Promise<{ id: string; hasCarbonContains: boolean }[]> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(`
                MATCH (sf:SourceFile) WHERE sf.path = $relPath AND sf.valid_to_commit IS NULL
                OPTIONAL MATCH (repo:Repository)-[:CONTAINS]->(sf)
                RETURN sf.id AS id, repo.id AS repoId
                ORDER BY sf.id
            `, { relPath: ENTITY_RELPATH });
            return r.records.map(rec => ({
                id: rec.get('id') as string,
                hasCarbonContains: rec.get('repoId') != null,
            }));
        } finally { await s.close(); }
    }

    async function hasSchemaEdge(): Promise<boolean> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(`
                MATCH (dc:DataContainer {id: $dc})-[r:HAS_SCHEMA]->(ds:DataStructure {id: $ds})
                WHERE r.valid_to_commit IS NULL
                RETURN r LIMIT 1
            `, { dc: DC_URN, ds: DS_URN });
            return r.records.length > 0;
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('creates HAS_SCHEMA edge when mergeEmergentSchema uses the correct qualifiedRepoName', async () => {
        await seedConsumerSide();

        // mergeEmergentSchema with the SAME qualifiedRepoName that merkle used
        // for the Repository CONTAINS SourceFile link. The SourceFile URN
        // produced (`cr:sourcefile:acme/orders:...`) matches the one already
        // present, so the MERGE no-ops on the existing node instead of
        // creating a shadow.
        await mergeEmergentSchema({
            qualifiedRepoName: REPO_NAME,
            filepath: ENTITY_RELPATH,
            schemaName: 'quotes_archive',
            schemaType: 'database_table',
            fields: [{ name: 'id', type: 'int', required: true }],
            commitHash: 'TEST',
        });

        // Single SourceFile node, properly contained by the Repository.
        const sources = await countSourceFilesByPath();
        expect(sources).toHaveLength(1);
        expect(sources[0].id).toBe(SF_URN_CORRECT);
        expect(sources[0].hasCarbonContains).toBe(true);

        // Run the welder.
        await linkDataContainerSchemas('TEST');

        // HAS_SCHEMA edge exists on OUR specific DataContainer/DataStructure
        // pair (we don't assert on the global `linked` count because other
        // tests may have left state in the shared DB).
        expect(await hasSchemaEdge()).toBe(true);
    });

    it('regression guard: BUG simulation — wrong qualifiedRepoName creates shadow SourceFile and HAS_SCHEMA is missing', async () => {
        await seedConsumerSide();

        // Simulate the pre-fix bug: persistSchemas used `relativePath.split('/')[0]`
        // which produced `qualifiedRepoName='classes'` instead of 'acme/orders'.
        // The SourceFile MERGE creates a SHADOW node with URN
        // `cr:sourcefile:classes:classes/Entity/Snapshot.php`, orphan
        // because no Repository node has id `cr:repository:classes`.
        await mergeEmergentSchema({
            qualifiedRepoName: 'classes',  // <-- the bug
            filepath: ENTITY_RELPATH,
            schemaName: 'quotes_archive',
            schemaType: 'database_table',
            fields: [{ name: 'id', type: 'int', required: true }],
            commitHash: 'TEST',
        });

        // Two SourceFile nodes for the same path: one correct (from seed),
        // one shadow (from mergeEmergentSchema with wrong qualifiedRepoName).
        const sources = await countSourceFilesByPath();
        expect(sources).toHaveLength(2);

        const correct = sources.find(s => s.id === SF_URN_CORRECT);
        const shadow = sources.find(s => s.id !== SF_URN_CORRECT);
        expect(correct).toBeDefined();
        expect(correct!.hasCarbonContains).toBe(true);
        expect(shadow).toBeDefined();
        expect(shadow!.hasCarbonContains).toBe(false);  // orphan

        // linkDataContainerSchemas fails to create HAS_SCHEMA on OUR pair
        // because the DEFINES_SCHEMA-bearing SourceFile (shadow) has no
        // Repository edge.
        await linkDataContainerSchemas('TEST');
        expect(await hasSchemaEdge()).toBe(false);
    });
});
