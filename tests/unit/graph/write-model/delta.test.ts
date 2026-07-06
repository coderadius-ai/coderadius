import { describe, it, expect } from 'vitest';
import {
    GraphDeltaSchema,
    NodeUpsertSchema,
    EdgeUpsertSchema,
    emptyDelta,
    mergeDeltas,
    type GraphDelta,
} from '../../../../src/graph/write-model/delta.js';
import { astGrounding } from '../../../../src/graph/grounding.js';

// The GraphDelta write-model is the typed contract between
// pure interpreters and the GraphStore applier. The schema is the single
// gate where untyped LLM-payload leakage (today's 24 `as any` casts in
// graph-writer) gets rejected, so the negative cases here ARE the feature.

const ground = astGrounding('test-interpreter@v1');

function validNode(over: Record<string, unknown> = {}) {
    return {
        label: 'Datastore',
        urn: 'cr:datastore:acme:orders-db',
        props: { name: 'orders-db', technology: 'postgres' },
        grounding: ground,
        ...over,
    };
}

function validEdge(over: Record<string, unknown> = {}) {
    return {
        type: 'CONNECTS_TO',
        from: { label: 'Function', urn: 'cr:function:acme:orders/save' },
        to: { label: 'Datastore', urn: 'cr:datastore:acme:orders-db' },
        props: {},
        grounding: ground,
        ...over,
    };
}

describe('NodeUpsertSchema', () => {
    it('accepts a valid node upsert', () => {
        const parsed = NodeUpsertSchema.parse(validNode());
        expect(parsed.label).toBe('Datastore');
        expect(parsed.urn).toBe('cr:datastore:acme:orders-db');
    });

    it('defaults props to an empty object', () => {
        const { props: _omitted, ...withoutProps } = validNode();
        const parsed = NodeUpsertSchema.parse(withoutProps);
        expect(parsed.props).toEqual({});
    });

    it('accepts scalar arrays as prop values', () => {
        const parsed = NodeUpsertSchema.parse(
            validNode({ props: { capabilities: ['read', 'write'], port: 5432, active: true } }),
        );
        expect(parsed.props.capabilities).toEqual(['read', 'write']);
    });

    it('rejects labels outside the domain ontology', () => {
        expect(() => NodeUpsertSchema.parse(validNode({ label: 'CustomerTable' }))).toThrow();
    });

    it('rejects an empty urn', () => {
        expect(() => NodeUpsertSchema.parse(validNode({ urn: '' }))).toThrow();
    });

    it('rejects nested objects as prop values (Memgraph stores flat scalars only)', () => {
        expect(() =>
            NodeUpsertSchema.parse(validNode({ props: { schema: { fields: ['id'] } } })),
        ).toThrow();
    });

    it('rejects props colliding with grounding storage keys', () => {
        for (const key of ['source', 'quality', 'needsReview', 'lastSeenCommit', 'evidence_extractors']) {
            expect(() => NodeUpsertSchema.parse(validNode({ props: { [key]: 'x' } }))).toThrow();
        }
    });

    it('rejects props colliding with the merge-key property of the label', () => {
        expect(() => NodeUpsertSchema.parse(validNode({ props: { id: 'sneaky-id' } }))).toThrow();
        expect(() =>
            NodeUpsertSchema.parse(
                validNode({ label: 'TraceSpan', props: { spanId: 'sneaky' } }),
            ),
        ).toThrow();
    });

    it('rejects a node without grounding', () => {
        const { grounding: _omitted, ...withoutGrounding } = validNode();
        expect(() => NodeUpsertSchema.parse(withoutGrounding)).toThrow();
    });

    it('accepts propsOnce for ON CREATE-only properties', () => {
        const parsed = NodeUpsertSchema.parse(validNode({ propsOnce: { valid_from_commit: 'c1' } }));
        expect(parsed.propsOnce).toEqual({ valid_from_commit: 'c1' });
    });

    it('rejects createdAt in any prop bucket (stamped by the applier on create)', () => {
        expect(() => NodeUpsertSchema.parse(validNode({ props: { createdAt: 1 } }))).toThrow();
        expect(() => NodeUpsertSchema.parse(validNode({ propsOnce: { createdAt: 1 } }))).toThrow();
    });

    it('accepts propsIfMissing for first-non-null-wins properties', () => {
        const parsed = NodeUpsertSchema.parse(
            validNode({ propsIfMissing: { kindFamily: 'rdbms', technology: 'postgres' } }),
        );
        expect(parsed.propsIfMissing).toEqual({ kindFamily: 'rdbms', technology: 'postgres' });
    });

    it('rejects propsIfMissing keys that are reserved or not identifier-shaped (Cypher interpolation guard)', () => {
        expect(() => NodeUpsertSchema.parse(validNode({ propsIfMissing: { quality: 'x' } }))).toThrow();
        expect(() => NodeUpsertSchema.parse(validNode({ propsIfMissing: { 'bad-key': 'x' } }))).toThrow();
        expect(() => NodeUpsertSchema.parse(validNode({ propsIfMissing: { 'a b': 'x' } }))).toThrow();
    });
});

describe('EdgeUpsertSchema', () => {
    it('accepts a valid edge upsert', () => {
        const parsed = EdgeUpsertSchema.parse(validEdge());
        expect(parsed.type).toBe('CONNECTS_TO');
    });

    it('rejects relationship types that are not SCREAMING_SNAKE (Cypher injection guard)', () => {
        for (const bad of ['connects_to', 'CONNECTS TO', 'CONNECTS-TO', 'a]->(x) DETACH DELETE']) {
            expect(() => EdgeUpsertSchema.parse(validEdge({ type: bad }))).toThrow();
        }
    });

    it('rejects endpoints with labels outside the ontology', () => {
        expect(() =>
            EdgeUpsertSchema.parse(validEdge({ from: { label: 'Mystery', urn: 'cr:x:y' } })),
        ).toThrow();
    });

    it('rejects edge props colliding with grounding storage keys', () => {
        expect(() => EdgeUpsertSchema.parse(validEdge({ props: { quality: 'fake' } }))).toThrow();
    });

    it('accepts propsOnce for ON CREATE-only edge properties', () => {
        const parsed = EdgeUpsertSchema.parse(validEdge({ propsOnce: { valid_from_commit: 'c1' } }));
        expect(parsed.propsOnce).toEqual({ valid_from_commit: 'c1' });
    });

    it('rejects reserved keys in edge propsOnce', () => {
        expect(() => EdgeUpsertSchema.parse(validEdge({ propsOnce: { source: 'fake' } }))).toThrow();
    });

    it('accepts keyProps that participate in the edge MERGE identity (null allowed)', () => {
        const parsed = EdgeUpsertSchema.parse(validEdge({ keyProps: { routingKey: 'order.created' } }));
        expect(parsed.keyProps).toEqual({ routingKey: 'order.created' });
        expect(EdgeUpsertSchema.parse(validEdge({ keyProps: { routingKey: null } })).keyProps).toEqual({ routingKey: null });
    });

    it('rejects keyProps keys that are reserved or not identifier-shaped (Cypher interpolation guard)', () => {
        expect(() => EdgeUpsertSchema.parse(validEdge({ keyProps: { quality: 'x' } }))).toThrow();
        expect(() => EdgeUpsertSchema.parse(validEdge({ keyProps: { 'bad-key': 'x' } }))).toThrow();
    });
});

describe('GraphDeltaSchema', () => {
    it('accepts a delta with nodes and edges', () => {
        const parsed = GraphDeltaSchema.parse({ nodes: [validNode()], edges: [validEdge()] });
        expect(parsed.nodes).toHaveLength(1);
        expect(parsed.edges).toHaveLength(1);
    });

    it('defaults missing collections to empty arrays', () => {
        const parsed = GraphDeltaSchema.parse({});
        expect(parsed.nodes).toEqual([]);
        expect(parsed.edges).toEqual([]);
    });
});

describe('emptyDelta / mergeDeltas', () => {
    it('emptyDelta returns a delta with no facts', () => {
        expect(emptyDelta()).toEqual({ nodes: [], edges: [] });
    });

    it('mergeDeltas concatenates preserving order and leaves inputs untouched', () => {
        const a: GraphDelta = GraphDeltaSchema.parse({ nodes: [validNode()] });
        const b: GraphDelta = GraphDeltaSchema.parse({
            nodes: [validNode({ urn: 'cr:datastore:acme:billing-db' })],
            edges: [validEdge()],
        });

        const merged = mergeDeltas(a, b);
        expect(merged.nodes.map(n => n.urn)).toEqual([
            'cr:datastore:acme:orders-db',
            'cr:datastore:acme:billing-db',
        ]);
        expect(merged.edges).toHaveLength(1);
        expect(a.nodes).toHaveLength(1);
        expect(a.edges).toHaveLength(0);
    });

    it('mergeDeltas of nothing is the empty delta', () => {
        expect(mergeDeltas()).toEqual(emptyDelta());
    });
});
