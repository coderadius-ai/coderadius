import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { MemgraphGraphStore } from '../../src/graph/write-model/memgraph-applier.js';
import {
    interpretDatastore,
    type DatastoreInterpretContext,
} from '../../src/ingestion/processors/code-pipeline/interpret/datastore.js';
import { buildUrn } from '../../src/graph/urn.js';
import { computeEndpointKey, type DatastoreIdentity } from '../../src/ingestion/processors/db-scope-resolver.js';
import { astGrounding } from '../../src/graph/grounding.js';

// E2E: interpretDatastore output applied through the real
// Memgraph applier must produce the same graph shape the inline
// mergeDatastore / mergeDataContainer / link* mutations produced. This is the
// persistence-parity pin for the persistFunction Database-case switch.

const QUALIFIED = 'acme/inventory-itp';
const COMMIT = 'itp-commit';
const FN_URN = `cr:function:${QUALIFIED}:src/orders.php:saveOrder`;

function identity(): DatastoreIdentity {
    return {
        identityKey: 'orders',
        canonicalHint: {
            dbName: 'orders', technology: 'mysql', host: 'orders-prod.itp.internal',
            port: 3306, sourceFile: 'helm/values.yaml', confidence: 'high',
        },
        environments: [
            { environment: 'production', host: 'orders-prod.itp.internal', port: 3306, dbName: 'orders', sourceFile: 'helm/values.yaml' },
        ],
    } as DatastoreIdentity;
}

function ctx(over: Partial<DatastoreInterpretContext> = {}): DatastoreInterpretContext {
    return {
        functionId: FN_URN,
        qualifiedRepoName: QUALIFIED,
        commitHash: COMMIT,
        repoHints: { databases: [], decorators: [], hints: [] },
        identities: [identity()],
        envVarNames: [],
        allowPlainTextHosts: true,
        ...over,
    };
}

async function readProps(label: string, urn: string): Promise<Record<string, unknown> | undefined> {
    const s = getNeo4jSession();
    try {
        const res = await s.run(`MATCH (n:${label} {id: $urn}) RETURN properties(n) AS p`, { urn });
        return res.records[0]?.get('p') as Record<string, unknown> | undefined;
    } finally { await s.close(); }
}

async function readEdgeProps(type: string, fromUrn: string, toUrn: string): Promise<Record<string, unknown> | undefined> {
    const s = getNeo4jSession();
    try {
        const res = await s.run(
            `MATCH ({id: $fromUrn})-[r:${type}]->({id: $toUrn}) RETURN properties(r) AS p`,
            { fromUrn, toUrn },
        );
        return res.records[0]?.get('p') as Record<string, unknown> | undefined;
    } finally { await s.close(); }
}

async function wipe(): Promise<void> {
    const s = getNeo4jSession();
    try {
        await s.run('MATCH (n) WHERE n.id CONTAINS $marker DETACH DELETE n', { marker: QUALIFIED });
        await s.run("MATCH (ep:DatabaseEndpoint) WHERE ep.host ENDS WITH '.itp.internal' DETACH DELETE ep");
    } finally { await s.close(); }
}

async function seedFunction(): Promise<void> {
    const s = getNeo4jSession();
    try {
        await s.run('MERGE (f:Function {id: $id}) SET f.name = $name', { id: FN_URN, name: 'saveOrder' });
    } finally { await s.close(); }
}

describe('datastore interpreter → Memgraph applier (persistence parity)', () => {
    const store = new MemgraphGraphStore();
    const dsUrn = buildUrn('datastore', QUALIFIED, 'orders');
    const dcUrn = buildUrn('datacontainer', QUALIFIED, 'orders_table');

    beforeAll(async () => { await initSchema({ silent: true }); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); await seedFunction(); });

    it('persists the full sole-candidate shape: Datastore, endpoint, DataContainer, all four edges', async () => {
        const { delta } = interpretDatastore({ name: 'orders_table', operation: 'WRITES' }, ctx());
        const result = await store.apply(delta, { commitHash: COMMIT });
        expect(result.skippedEdges).toEqual([]);

        const ds = await readProps('Datastore', dsUrn);
        expect(ds).toMatchObject({
            name: 'orders', namespace: QUALIFIED, technology: 'mysql',
            valid_from_commit: COMMIT, source: 'ast', quality: 'exact',
        });
        expect(ds!.valid_to_commit ?? null).toBeNull();
        expect(ds!.createdAt).toBeDefined();

        const epKey = computeEndpointKey('orders-prod.itp.internal', 3306, 'orders');
        const ep = await readProps('DatabaseEndpoint', buildUrn('dbendpoint', epKey, 'production'));
        expect(ep).toMatchObject({ endpointKey: epKey, environment: 'production', dbName: 'orders', technology: 'mysql' });

        const dc = await readProps('DataContainer', dcUrn);
        expect(dc).toMatchObject({
            name: 'orders_table', scope: QUALIFIED, scopeSource: 'repo_fallback',
            sourceRepo: QUALIFIED, kindFamily: 'rdbms', technology: 'mysql',
            datastoreUrn: dsUrn, physicalEndpointConfidence: 'high', source: 'composite',
        });

        const writes = await readEdgeProps('WRITES', FN_URN, dcUrn);
        expect(writes).toMatchObject({ valid_from_commit: COMMIT });
        const storedIn = await readEdgeProps('STORED_IN', dcUrn, dsUrn);
        expect(storedIn).toMatchObject({ bindingReason: 'sole-candidate', source: 'ast' });
        const connects = await readEdgeProps('CONNECTS_TO', FN_URN, dsUrn);
        expect(connects).toMatchObject({ valid_from_commit: COMMIT });
        const served = await readEdgeProps('SERVED_BY', dsUrn, buildUrn('dbendpoint', epKey, 'production'));
        expect(served).toBeDefined();
    });

    it('re-apply is idempotent and preserves first-non-null kindFamily on the DataContainer', async () => {
        const first = interpretDatastore({ name: 'orders_table', operation: 'WRITES', kindFamily: 'rdbms' }, ctx({ identities: [] }));
        await store.apply(first.delta, { commitHash: COMMIT });

        // Second touch arrives without the structural kindFamily signal but
        // with an LLM technology hint that maps elsewhere — must not clobber.
        const second = interpretDatastore({ name: 'orders_table', operation: 'READS' }, ctx({ identities: [] }));
        await store.apply(second.delta, { commitHash: 'itp-commit-2' });

        const dc = await readProps('DataContainer', dcUrn);
        expect(dc!.kindFamily).toBe('rdbms');
        expect(dc!.valid_from_commit).toBe(COMMIT);
        expect(dc!.lastSeenCommit).toBe('itp-commit-2');

        expect(await readEdgeProps('WRITES', FN_URN, dcUrn)).toBeDefined();
        expect(await readEdgeProps('READS', FN_URN, dcUrn)).toBeDefined();
    });

    it('tombstoned edges revive on re-apply (valid_to_commit cleared)', async () => {
        const { delta } = interpretDatastore({ name: 'orders_table', operation: 'WRITES' }, ctx());
        await store.apply(delta, { commitHash: COMMIT });

        const s = getNeo4jSession();
        try {
            await s.run(
                'MATCH ({id: $fn})-[r]->() SET r.valid_to_commit = $c',
                { fn: FN_URN, c: COMMIT },
            );
        } finally { await s.close(); }

        await store.apply(delta, { commitHash: COMMIT });
        const writes = await readEdgeProps('WRITES', FN_URN, dcUrn);
        expect(writes!.valid_to_commit ?? null).toBeNull();
    });

    it('grounding ast/exact lands on AST-grounded explicit items', async () => {
        const { delta } = interpretDatastore(
            {
                name: 'orders_table', operation: 'WRITES',
                grounding: astGrounding('di-binding-resolver@v1'),
            },
            ctx({ identities: [] }),
        );
        await store.apply(delta, { commitHash: COMMIT });
        const dc = await readProps('DataContainer', dcUrn);
        expect(dc).toMatchObject({ source: 'ast', quality: 'exact' });
        expect(dc!.evidence_extractors).toEqual(['di-binding-resolver@v1']);
    });
});
