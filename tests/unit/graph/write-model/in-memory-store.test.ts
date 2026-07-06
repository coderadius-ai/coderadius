import { describe, it, expect } from 'vitest';
import { InMemoryGraphStore } from '../../../../src/graph/write-model/in-memory-store.js';
import { GraphDeltaSchema } from '../../../../src/graph/write-model/delta.js';
import { astGrounding, llmGrounding } from '../../../../src/graph/grounding.js';

// The in-memory GraphStore is the test double for the
// pipeline's unit tests. Its value depends on FIDELITY to the Memgraph
// applier semantics: MERGE-by-key upserts, MATCH-drop for edges with
// missing endpoints, scalar-overwrite + accumulator-union for grounding.

const OPTS = { commitHash: 'commit-1' };

function delta(input: unknown) {
    return GraphDeltaSchema.parse(input);
}

function datastoreNode(urn: string, props: Record<string, string | number | boolean> = {}) {
    return {
        label: 'Datastore',
        urn,
        props,
        grounding: astGrounding('test-extractor@v1'),
    };
}

describe('InMemoryGraphStore — nodes', () => {
    it('upserts a node retrievable by label + urn', async () => {
        const store = new InMemoryGraphStore();
        const result = await store.apply(
            delta({ nodes: [datastoreNode('cr:datastore:acme:orders-db', { name: 'orders-db' })] }),
            OPTS,
        );

        expect(result.nodesUpserted).toBe(1);
        const node = store.getNode('Datastore', 'cr:datastore:acme:orders-db');
        expect(node).toBeDefined();
        expect(node!.props.name).toBe('orders-db');
    });

    it('re-applying merges props: incoming wins, untouched props survive', async () => {
        const store = new InMemoryGraphStore();
        await store.apply(
            delta({ nodes: [datastoreNode('cr:datastore:acme:orders-db', { name: 'orders-db', technology: 'postgres' })] }),
            OPTS,
        );
        await store.apply(
            delta({ nodes: [datastoreNode('cr:datastore:acme:orders-db', { technology: 'mysql' })] }),
            { commitHash: 'commit-2' },
        );

        const node = store.getNode('Datastore', 'cr:datastore:acme:orders-db')!;
        expect(node.props.technology).toBe('mysql');
        expect(node.props.name).toBe('orders-db');
        expect(store.nodeCount).toBe(1);
    });

    it('propsOnce applies on create but never on match (ON CREATE SET semantics)', async () => {
        const store = new InMemoryGraphStore();
        const withOnce = (commit: string) => ({
            ...datastoreNode('cr:datastore:acme:orders-db'),
            propsOnce: { valid_from_commit: commit },
        });

        await store.apply(delta({ nodes: [withOnce('c-111')] }), OPTS);
        await store.apply(delta({ nodes: [withOnce('c-222')] }), OPTS);

        expect(store.getNode('Datastore', 'cr:datastore:acme:orders-db')!.props.valid_from_commit).toBe('c-111');
    });

    it('stamps createdAt on create only (adapter-owned timestamp)', async () => {
        const store = new InMemoryGraphStore();
        await store.apply(delta({ nodes: [datastoreNode('cr:datastore:acme:orders-db')] }), OPTS);
        const created = store.getNode('Datastore', 'cr:datastore:acme:orders-db')!.props.createdAt;
        expect(typeof created).toBe('number');

        await store.apply(delta({ nodes: [datastoreNode('cr:datastore:acme:orders-db')] }), OPTS);
        expect(store.getNode('Datastore', 'cr:datastore:acme:orders-db')!.props.createdAt).toBe(created);
    });

    it('propsIfMissing fills absent keys but never overwrites (first-non-null-wins)', async () => {
        const store = new InMemoryGraphStore();
        const withIfMissing = (kindFamily: string) => ({
            ...datastoreNode('cr:datastore:acme:orders-db'),
            propsIfMissing: { kindFamily },
        });

        await store.apply(delta({ nodes: [withIfMissing('rdbms')] }), OPTS);
        expect(store.getNode('Datastore', 'cr:datastore:acme:orders-db')!.props.kindFamily).toBe('rdbms');

        await store.apply(delta({ nodes: [withIfMissing('document')] }), OPTS);
        expect(store.getNode('Datastore', 'cr:datastore:acme:orders-db')!.props.kindFamily).toBe('rdbms');
    });

    it('props win over propsIfMissing within the same upsert (SET order semantics)', async () => {
        const store = new InMemoryGraphStore();
        await store.apply(
            delta({
                nodes: [{
                    ...datastoreNode('cr:datastore:acme:orders-db', { technology: 'postgres' }),
                    propsIfMissing: { technology: 'mysql' },
                }],
            }),
            OPTS,
        );
        expect(store.getNode('Datastore', 'cr:datastore:acme:orders-db')!.props.technology).toBe('postgres');
    });

    it('same urn under different labels are distinct nodes', async () => {
        const store = new InMemoryGraphStore();
        await store.apply(
            delta({
                nodes: [
                    datastoreNode('cr:thing:acme:x'),
                    { ...datastoreNode('cr:thing:acme:x'), label: 'MessageChannel' },
                ],
            }),
            OPTS,
        );
        expect(store.nodeCount).toBe(2);
    });
});

describe('InMemoryGraphStore — grounding semantics', () => {
    it('stamps flattened grounding with lastSeenCommit from ApplyOptions', async () => {
        const store = new InMemoryGraphStore();
        await store.apply(delta({ nodes: [datastoreNode('cr:datastore:acme:orders-db')] }), OPTS);

        const node = store.getNode('Datastore', 'cr:datastore:acme:orders-db')!;
        expect(node.grounding.source).toBe('ast');
        expect(node.grounding.quality).toBe('exact');
        expect(node.grounding.evidence_extractors).toEqual(['test-extractor@v1']);
        expect(node.grounding.lastSeenCommit).toBe('commit-1');
    });

    it('re-apply overwrites grounding scalars but unions accumulator arrays without dupes', async () => {
        const store = new InMemoryGraphStore();
        await store.apply(delta({ nodes: [datastoreNode('cr:datastore:acme:orders-db')] }), OPTS);
        await store.apply(
            delta({
                nodes: [{
                    ...datastoreNode('cr:datastore:acme:orders-db'),
                    grounding: llmGrounding('vertex/gemini', 'hash-1', 'unified-analyzer@v1', 'medium'),
                }],
            }),
            { commitHash: 'commit-2' },
        );
        // Third touch repeats an extractor already present: must not duplicate.
        await store.apply(delta({ nodes: [datastoreNode('cr:datastore:acme:orders-db')] }), { commitHash: 'commit-3' });

        const g = store.getNode('Datastore', 'cr:datastore:acme:orders-db')!.grounding;
        expect(g.source).toBe('ast');
        expect(g.lastSeenCommit).toBe('commit-3');
        expect(g.evidence_extractors).toEqual(['test-extractor@v1', 'unified-analyzer@v1']);
    });
});

describe('InMemoryGraphStore — edges', () => {
    const fn = { label: 'Function', urn: 'cr:function:acme:orders/save' };
    const ds = { label: 'Datastore', urn: 'cr:datastore:acme:orders-db' };

    function connectsEdge() {
        return {
            type: 'CONNECTS_TO',
            from: fn,
            to: ds,
            props: { protocol: 'bolt' },
            grounding: astGrounding('test-extractor@v1'),
        };
    }

    it('creates an edge when both endpoints exist', async () => {
        const store = new InMemoryGraphStore();
        const result = await store.apply(
            delta({
                nodes: [
                    { ...datastoreNode(fn.urn), label: 'Function' },
                    datastoreNode(ds.urn),
                ],
                edges: [connectsEdge()],
            }),
            OPTS,
        );

        expect(result.edgesUpserted).toBe(1);
        expect(result.skippedEdges).toEqual([]);
        const edge = store.getEdge('CONNECTS_TO', fn, ds);
        expect(edge).toBeDefined();
        expect(edge!.props.protocol).toBe('bolt');
        expect(edge!.grounding.source).toBe('ast');
    });

    it('skips (and reports) edges whose endpoint is missing — MATCH semantics, not MERGE', async () => {
        const store = new InMemoryGraphStore();
        const result = await store.apply(
            delta({
                nodes: [{ ...datastoreNode(fn.urn), label: 'Function' }],
                edges: [connectsEdge()],
            }),
            OPTS,
        );

        expect(result.edgesUpserted).toBe(0);
        expect(result.skippedEdges).toEqual([
            { type: 'CONNECTS_TO', fromUrn: fn.urn, toUrn: ds.urn, reason: 'missing-endpoint' },
        ]);
        expect(store.getEdge('CONNECTS_TO', fn, ds)).toBeUndefined();
        expect(store.edgeCount).toBe(0);
    });

    it('edges resolve against nodes created in the same apply (nodes phase runs first)', async () => {
        const store = new InMemoryGraphStore();
        await store.apply(
            delta({ nodes: [{ ...datastoreNode(fn.urn), label: 'Function' }] }),
            OPTS,
        );
        const result = await store.apply(
            delta({ nodes: [datastoreNode(ds.urn)], edges: [connectsEdge()] }),
            OPTS,
        );
        expect(result.edgesUpserted).toBe(1);
    });

    it('edge propsOnce applies on create only', async () => {
        const store = new InMemoryGraphStore();
        const d = (commit: string) =>
            delta({
                nodes: [{ ...datastoreNode(fn.urn), label: 'Function' }, datastoreNode(ds.urn)],
                edges: [{ ...connectsEdge(), propsOnce: { valid_from_commit: commit } }],
            });
        await store.apply(d('c-1'), OPTS);
        await store.apply(d('c-2'), OPTS);
        expect(store.getEdge('CONNECTS_TO', fn, ds)!.props.valid_from_commit).toBe('c-1');
    });

    it('re-applying the same edge is idempotent (MERGE semantics)', async () => {
        const store = new InMemoryGraphStore();
        const d = delta({
            nodes: [{ ...datastoreNode(fn.urn), label: 'Function' }, datastoreNode(ds.urn)],
            edges: [connectsEdge()],
        });
        await store.apply(d, OPTS);
        await store.apply(d, OPTS);
        expect(store.edgeCount).toBe(1);
    });

    it('keyProps participate in edge identity: distinct routing keys produce distinct edges', async () => {
        const store = new InMemoryGraphStore();
        const publish = (routingKey: string | null) => ({
            type: 'PUBLISHES_TO',
            from: fn,
            to: ds,
            keyProps: { routingKey },
            props: {},
            grounding: astGrounding('test-extractor@v1'),
        });
        await store.apply(
            delta({
                nodes: [{ ...datastoreNode(fn.urn), label: 'Function' }, datastoreNode(ds.urn)],
                edges: [publish('order.created'), publish('order.cancelled'), publish(null)],
            }),
            OPTS,
        );
        expect(store.edgeCount).toBe(3);

        // Re-apply with one of the same keys: idempotent on that identity.
        await store.apply(
            delta({
                nodes: [{ ...datastoreNode(fn.urn), label: 'Function' }],
                edges: [publish('order.created')],
            }),
            OPTS,
        );
        expect(store.edgeCount).toBe(3);
        expect(store.getEdge('PUBLISHES_TO', fn, ds, { routingKey: 'order.created' })).toBeDefined();
        expect(store.getEdge('PUBLISHES_TO', fn, ds, { routingKey: null })).toBeDefined();
    });
});

describe('InMemoryGraphStore — validation gate', () => {
    it('rejects a structurally invalid delta before mutating anything', async () => {
        const store = new InMemoryGraphStore();
        const invalid = {
            nodes: [{ label: 'NotALabel', urn: 'cr:x', props: {}, grounding: astGrounding('t@v1') }],
        };
        await expect(store.apply(invalid as never, OPTS)).rejects.toThrow();
        expect(store.nodeCount).toBe(0);
    });
});
