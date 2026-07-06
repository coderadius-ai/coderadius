import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { MemgraphGraphStore } from '../../src/graph/write-model/memgraph-applier.js';
import { GraphDeltaSchema } from '../../src/graph/write-model/delta.js';
import { astGrounding, llmGrounding } from '../../src/graph/grounding.js';

// The Memgraph applier is the single write path for the
// GraphDelta write-model — batched UNWIND MERGE per label, one transaction
// per apply(), grounding stamped via the shared groundingWriteClause.
// These tests pin the contract the InMemoryGraphStore double mirrors.

const PFX = 'cr:test:writemodel:';
const OPTS = { commitHash: 'writemodel-commit-1' };

function delta(input: unknown) {
    return GraphDeltaSchema.parse(input);
}

async function readNode(label: string, urn: string): Promise<Record<string, unknown> | undefined> {
    const s = getNeo4jSession();
    try {
        const res = await s.run(`MATCH (n:${label} {id: $urn}) RETURN properties(n) AS p`, { urn });
        return res.records[0]?.get('p') as Record<string, unknown> | undefined;
    } finally {
        await s.close();
    }
}

async function readEdge(type: string, fromUrn: string, toUrn: string): Promise<Record<string, unknown> | undefined> {
    const s = getNeo4jSession();
    try {
        const res = await s.run(
            `MATCH ({id: $fromUrn})-[r:${type}]->({id: $toUrn}) RETURN properties(r) AS p`,
            { fromUrn, toUrn },
        );
        return res.records[0]?.get('p') as Record<string, unknown> | undefined;
    } finally {
        await s.close();
    }
}

async function wipe(): Promise<void> {
    const s = getNeo4jSession();
    try {
        await s.run(
            'MATCH (n) WHERE n.id STARTS WITH $p OR n.spanId STARTS WITH $p DETACH DELETE n',
            { p: PFX },
        );
    } finally {
        await s.close();
    }
}

describe('MemgraphGraphStore applier', () => {
    const store = new MemgraphGraphStore();

    beforeAll(async () => { await initSchema({ silent: true }); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('upserts node batches with props and stamped grounding', async () => {
        const result = await store.apply(
            delta({
                nodes: [
                    {
                        label: 'Datastore',
                        urn: `${PFX}orders-db`,
                        props: { name: 'orders-db', technology: 'postgres', port: 5432 },
                        grounding: astGrounding('test-interpreter@v1'),
                    },
                    {
                        label: 'Datastore',
                        urn: `${PFX}billing-db`,
                        props: { name: 'billing-db' },
                        grounding: astGrounding('test-interpreter@v1'),
                    },
                    {
                        label: 'Function',
                        urn: `${PFX}fn-save`,
                        props: { name: 'save' },
                        grounding: astGrounding('ast-function-walk@v1'),
                    },
                ],
            }),
            OPTS,
        );

        expect(result.nodesUpserted).toBe(3);
        const node = await readNode('Datastore', `${PFX}orders-db`);
        expect(node).toBeDefined();
        expect(node!.name).toBe('orders-db');
        expect(Number(node!.port)).toBe(5432);
        expect(node!.source).toBe('ast');
        expect(node!.quality).toBe('exact');
        expect(node!.evidence_extractors).toEqual(['test-interpreter@v1']);
        expect(node!.lastSeenCommit).toBe('writemodel-commit-1');
    });

    it('merges on the per-label constraint key (TraceSpan uses spanId, not id)', async () => {
        await store.apply(
            delta({
                nodes: [{
                    label: 'TraceSpan',
                    urn: `${PFX}span-1`,
                    props: { name: 'GET /orders' },
                    grounding: astGrounding('test-interpreter@v1'),
                }],
            }),
            OPTS,
        );

        const s = getNeo4jSession();
        try {
            const res = await s.run(
                'MATCH (n:TraceSpan {spanId: $k}) RETURN properties(n) AS p',
                { k: `${PFX}span-1` },
            );
            expect(res.records).toHaveLength(1);
        } finally {
            await s.close();
        }
    });

    it('propsOnce lands on create only; props overwrite on re-apply; createdAt stamped once', async () => {
        const make = (technology: string, commit: string) =>
            delta({
                nodes: [{
                    label: 'Datastore',
                    urn: `${PFX}orders-db`,
                    props: { technology },
                    propsOnce: { valid_from_commit: commit },
                    grounding: astGrounding('test-interpreter@v1'),
                }],
            });

        await store.apply(make('postgres', 'c-111'), OPTS);
        const created = Number((await readNode('Datastore', `${PFX}orders-db`))!.createdAt);
        await store.apply(make('mysql', 'c-222'), { commitHash: 'writemodel-commit-2' });

        const node = await readNode('Datastore', `${PFX}orders-db`);
        expect(node!.technology).toBe('mysql');
        expect(node!.valid_from_commit).toBe('c-111');
        expect(Number(node!.createdAt)).toBe(created);
        expect(node!.lastSeenCommit).toBe('writemodel-commit-2');
    });

    it('propsIfMissing fills once and never overwrites (first-non-null-wins on Memgraph)', async () => {
        const make = (kindFamily: string) =>
            delta({
                nodes: [{
                    label: 'DataContainer',
                    urn: `${PFX}orders-table`,
                    props: {},
                    propsIfMissing: { kindFamily },
                    grounding: astGrounding('test-interpreter@v1'),
                }],
            });

        await store.apply(make('rdbms'), OPTS);
        await store.apply(make('document'), OPTS);

        const node = await readNode('DataContainer', `${PFX}orders-table`);
        expect(node!.kindFamily).toBe('rdbms');
    });

    it('edge propsOnce applies on create only', async () => {
        const d = (commit: string) =>
            delta({
                nodes: [
                    { label: 'Function', urn: `${PFX}fn-save`, props: {}, grounding: astGrounding('t@v1') },
                    { label: 'Datastore', urn: `${PFX}orders-db`, props: {}, grounding: astGrounding('t@v1') },
                ],
                edges: [{
                    type: 'CONNECTS_TO',
                    from: { label: 'Function', urn: `${PFX}fn-save` },
                    to: { label: 'Datastore', urn: `${PFX}orders-db` },
                    props: {},
                    propsOnce: { valid_from_commit: commit },
                    grounding: astGrounding('t@v1'),
                }],
            });

        await store.apply(d('c-1'), OPTS);
        await store.apply(d('c-2'), OPTS);
        const edge = await readEdge('CONNECTS_TO', `${PFX}fn-save`, `${PFX}orders-db`);
        expect(edge!.valid_from_commit).toBe('c-1');
    });

    it('re-apply unions grounding accumulator arrays without duplicates', async () => {
        const node = (grounding: unknown) =>
            delta({
                nodes: [{
                    label: 'Datastore',
                    urn: `${PFX}orders-db`,
                    props: {},
                    grounding,
                }],
            });

        await store.apply(node(astGrounding('test-interpreter@v1')), OPTS);
        await store.apply(node(llmGrounding('vertex/gemini', 'h1', 'unified-analyzer@v1', 'medium')), OPTS);
        await store.apply(node(astGrounding('test-interpreter@v1')), OPTS);

        const stored = await readNode('Datastore', `${PFX}orders-db`);
        expect(stored!.evidence_extractors).toEqual(['test-interpreter@v1', 'unified-analyzer@v1']);
        expect(stored!.source).toBe('ast');
    });

    it('creates edges between existing endpoints with grounding on the relationship', async () => {
        const result = await store.apply(
            delta({
                nodes: [
                    { label: 'Function', urn: `${PFX}fn-save`, props: {}, grounding: astGrounding('t@v1') },
                    { label: 'Datastore', urn: `${PFX}orders-db`, props: {}, grounding: astGrounding('t@v1') },
                ],
                edges: [{
                    type: 'CONNECTS_TO',
                    from: { label: 'Function', urn: `${PFX}fn-save` },
                    to: { label: 'Datastore', urn: `${PFX}orders-db` },
                    props: { protocol: 'bolt' },
                    grounding: astGrounding('t@v1'),
                }],
            }),
            OPTS,
        );

        expect(result.edgesUpserted).toBe(1);
        expect(result.skippedEdges).toEqual([]);
        const edge = await readEdge('CONNECTS_TO', `${PFX}fn-save`, `${PFX}orders-db`);
        expect(edge).toBeDefined();
        expect(edge!.protocol).toBe('bolt');
        expect(edge!.source).toBe('ast');
        expect(edge!.lastSeenCommit).toBe('writemodel-commit-1');
    });

    it('skips and reports edges whose endpoints are missing — no ghost nodes', async () => {
        const result = await store.apply(
            delta({
                nodes: [
                    { label: 'Function', urn: `${PFX}fn-save`, props: {}, grounding: astGrounding('t@v1') },
                ],
                edges: [
                    {
                        type: 'CONNECTS_TO',
                        from: { label: 'Function', urn: `${PFX}fn-save` },
                        to: { label: 'Datastore', urn: `${PFX}ghost-db` },
                        props: {},
                        grounding: astGrounding('t@v1'),
                    },
                    {
                        type: 'CONNECTS_TO',
                        from: { label: 'Function', urn: `${PFX}fn-save` },
                        to: { label: 'Function', urn: `${PFX}fn-save` },
                        props: {},
                        grounding: astGrounding('t@v1'),
                    },
                ],
            }),
            OPTS,
        );

        // The self-edge resolves (both endpoints exist); the ghost-db edge is reported.
        expect(result.edgesUpserted).toBe(1);
        expect(result.skippedEdges).toEqual([
            { type: 'CONNECTS_TO', fromUrn: `${PFX}fn-save`, toUrn: `${PFX}ghost-db`, reason: 'missing-endpoint' },
        ]);
        expect(await readNode('Datastore', `${PFX}ghost-db`)).toBeUndefined();
    });

    it('keyProps participate in the MERGE identity on Memgraph (distinct routing keys → distinct edges)', async () => {
        const publish = (routingKey: string | null) => ({
            type: 'PUBLISHES_TO',
            from: { label: 'Function', urn: `${PFX}fn-save` },
            to: { label: 'MessageChannel', urn: `${PFX}orders-topic` },
            keyProps: { routingKey },
            props: {},
            grounding: astGrounding('t@v1'),
        });
        const base = {
            nodes: [
                { label: 'Function', urn: `${PFX}fn-save`, props: {}, grounding: astGrounding('t@v1') },
                { label: 'MessageChannel', urn: `${PFX}orders-topic`, props: {}, grounding: astGrounding('t@v1') },
            ],
        };

        await store.apply(delta({ ...base, edges: [publish('order.created'), publish('order.cancelled'), publish(null)] }), OPTS);
        await store.apply(delta({ ...base, edges: [publish('order.created')] }), OPTS);

        const s = getNeo4jSession();
        try {
            const res = await s.run(
                'MATCH ({id: $f})-[r:PUBLISHES_TO]->({id: $t}) RETURN r.routingKey AS k',
                { f: `${PFX}fn-save`, t: `${PFX}orders-topic` },
            );
            const keys = res.records.map(r => r.get('k') as string | null);
            expect(keys).toHaveLength(3);
            expect(new Set(keys)).toEqual(new Set([null, 'order.cancelled', 'order.created']));
        } finally {
            await s.close();
        }
    });

    it('a delta of many nodes across labels lands in a single apply', async () => {
        const nodes = Array.from({ length: 50 }, (_, i) => ({
            label: i % 2 === 0 ? 'Function' : 'Datastore',
            urn: `${PFX}bulk-${i}`,
            props: { name: `bulk-${i}` },
            grounding: astGrounding('t@v1'),
        }));

        const result = await store.apply(delta({ nodes }), OPTS);
        expect(result.nodesUpserted).toBe(50);

        const s = getNeo4jSession();
        try {
            const res = await s.run(
                'MATCH (n) WHERE n.id STARTS WITH $p RETURN count(n) AS c',
                { p: `${PFX}bulk-` },
            );
            expect(Number(res.records[0].get('c'))).toBe(50);
        } finally {
            await s.close();
        }
    });
});
