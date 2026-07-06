import { describe, expect, it } from 'vitest';
import { clusterGraphNodes, nameFamily } from '../../../packages/dashboard-ui/src/lib/graph-clustering';
import type { GraphNode, GraphEdge } from '../../../packages/dashboard-ui/src/components/blast-radius/types';
import type { TopologyNode } from '../../../packages/shared-types/index';

function mkNode(opts: {
    urn: string;
    name: string;
    type?: string;
    col?: number;
    confidence?: number;
    datastore?: Array<{ name: string; host?: string | null }>;
    needsReview?: boolean;
}): GraphNode {
    const node: TopologyNode = {
        name: opts.name,
        type: opts.type ?? 'DataContainer',
        confidence: opts.confidence,
        datastore: opts.datastore ?? null,
        needsReview: opts.needsReview ?? null,
    };
    return {
        id: opts.urn,
        urn: opts.urn,
        node,
        tier: 1,
        direction: 'downstream',
        col: opts.col ?? 1,
        cardW: 200,
        cardH: 28,
        x: 0,
        y: 0,
        confidence: opts.confidence,
    };
}

function mkEdge(source: string, target: string, rel = 'WRITES', confidence?: number): GraphEdge {
    return { id: `${source}->${target}:${rel}`, source, target, rel, confidence };
}

describe('graph-clustering / nameFamily', () => {
    it('buckets URL paths by their first 3 segments', () => {
        expect(nameFamily({ name: '/api/v2/bike/equipments', type: 'APIEndpoint' })).toBe('/api/v2/bike');
        expect(nameFamily({ name: '/api/v2/bike/saves', type: 'APIEndpoint' })).toBe('/api/v2/bike');
    });

    it('buckets snake_case names by the prefix before the first underscore', () => {
        expect(nameFamily({ name: 'quote_auto', type: 'DataContainer' })).toBe('quote');
        expect(nameFamily({ name: 'quote_bike', type: 'DataContainer' })).toBe('quote');
    });

    it('buckets dot.path names by the first segment', () => {
        expect(nameFamily({ name: 'message_bus.transport.acme.inventory', type: 'MessageChannel' }))
            .toBe('message_bus');
    });

    it('falls back to type when no separator is present', () => {
        expect(nameFamily({ name: 'orders', type: 'DataContainer' })).toBe('DataContainer');
    });

    it('strips the leading HTTP-method prefix on REST endpoint names', () => {
        // REST endpoints surface as `${method} ${path}` from the topology query.
        expect(nameFamily({ name: 'GET /api/v2/bike/equipments', type: 'APIEndpoint' })).toBe('/api/v2/bike');
        expect(nameFamily({ name: 'POST /api/v1/orders', type: 'APIEndpoint' })).toBe('/api/v1/orders');
    });
});

describe('graph-clustering / clusterGraphNodes', () => {
    const PIVOT_URN = 'cr:service:acme/api';
    const pivot: GraphNode = {
        id: PIVOT_URN,
        urn: PIVOT_URN,
        node: { name: 'api', type: 'Service' },
        tier: 0,
        direction: 'center',
        col: 0,
        cardW: 220,
        cardH: 54,
        x: 0,
        y: 0,
    };

    it('passes nodes through unchanged when disabled', () => {
        const nodes = [pivot, mkNode({ urn: 'a', name: 'quote_auto' })];
        const edges = [mkEdge(PIVOT_URN, 'a')];
        const r = clusterGraphNodes(nodes, edges, { enabled: false, minSize: 4 });
        expect(r.nodes).toHaveLength(2);
        expect(r.edges).toHaveLength(1);
        expect(r.collapsedUrns.size).toBe(0);
    });

    it('collapses 4+ siblings sharing nodeType + neighbors + edge kinds + family', () => {
        const siblings = ['auto', 'moto', 'autocarri', 'dati'].map(s =>
            mkNode({ urn: `cr:dc:quote_${s}`, name: `quote_${s}` }),
        );
        const edges = siblings.map(s => mkEdge(PIVOT_URN, s.urn));
        const r = clusterGraphNodes([pivot, ...siblings], edges, { enabled: true, minSize: 4 });

        expect(r.nodes.filter(n => 'kind' in n && n.kind === 'cluster')).toHaveLength(1);
        const cluster = r.nodes.find(n => 'kind' in n && n.kind === 'cluster')! as any;
        expect(cluster.label).toBe('Quote Data Containers');
        expect(cluster.examples).toEqual(['quote_auto', 'quote_autocarri', 'quote_dati']);
        expect(cluster.members).toHaveLength(4);
        expect(r.collapsedUrns.size).toBe(4);

        // Edge collapse: 4 parallel WRITES → 1 surviving edge from pivot to cluster.
        const survivingEdges = r.edges.filter(e => e.source === PIVOT_URN);
        expect(survivingEdges).toHaveLength(1);
        expect(survivingEdges[0].target).toBe(cluster.id);
    });

    it('does NOT cluster when fewer than minSize members share the signature', () => {
        const siblings = ['auto', 'moto', 'autocarri'].map(s =>
            mkNode({ urn: `cr:dc:quote_${s}`, name: `quote_${s}` }),
        );
        const edges = siblings.map(s => mkEdge(PIVOT_URN, s.urn));
        const r = clusterGraphNodes([pivot, ...siblings], edges, { enabled: true, minSize: 4 });

        expect(r.nodes.filter(n => 'kind' in n && n.kind === 'cluster')).toHaveLength(0);
        expect(r.collapsedUrns.size).toBe(0);
    });

    it('does NOT cluster siblings whose edge kinds differ', () => {
        // 4 siblings, 2 are READ-only and 2 are WRITE-only → two buckets of 2,
        // neither hits minSize.
        const reads = ['a', 'b'].map(s => mkNode({ urn: `cr:dc:r_${s}`, name: `pref_${s}` }));
        const writes = ['c', 'd'].map(s => mkNode({ urn: `cr:dc:w_${s}`, name: `pref_${s}` }));
        const edges = [
            ...reads.map(s => mkEdge(PIVOT_URN, s.urn, 'READS')),
            ...writes.map(s => mkEdge(PIVOT_URN, s.urn, 'WRITES')),
        ];
        const r = clusterGraphNodes([pivot, ...reads, ...writes], edges, { enabled: true, minSize: 4 });
        expect(r.nodes.filter(n => 'kind' in n && n.kind === 'cluster')).toHaveLength(0);
    });

    it('never clusters the pivot (tier 0)', () => {
        const r = clusterGraphNodes([pivot], [], { enabled: true, minSize: 1 });
        expect(r.nodes).toHaveLength(1);
        expect(r.collapsedUrns.has(PIVOT_URN)).toBe(false);
    });

    it('expanded clusters render their members back', () => {
        const siblings = ['auto', 'moto', 'autocarri', 'dati'].map(s =>
            mkNode({ urn: `cr:dc:quote_${s}`, name: `quote_${s}` }),
        );
        const edges = siblings.map(s => mkEdge(PIVOT_URN, s.urn));
        // First pass: discover signature
        const r1 = clusterGraphNodes([pivot, ...siblings], edges, { enabled: true, minSize: 4 });
        const clusterId = (r1.nodes.find(n => 'kind' in n && n.kind === 'cluster')! as any).id as string;
        const sigKey = clusterId.replace(/^cluster:/, '');
        // Second pass: expand
        const r2 = clusterGraphNodes([pivot, ...siblings], edges, {
            enabled: true,
            minSize: 4,
            expandedSignatures: new Set([sigKey]),
        });
        expect(r2.nodes.filter(n => 'kind' in n && n.kind === 'cluster')).toHaveLength(0);
        expect(r2.nodes.filter(n => !('kind' in n))).toHaveLength(5); // pivot + 4 members
    });

    it('cluster confidence = min(members.confidence) — most conservative', () => {
        const siblings = ['a', 'b', 'c', 'd'].map((s, i) =>
            mkNode({ urn: `u${s}`, name: `pref_${s}`, confidence: 0.9 - i * 0.15 }),
        );
        const edges = siblings.map(s => mkEdge(PIVOT_URN, s.urn));
        const r = clusterGraphNodes([pivot, ...siblings], edges, { enabled: true, minSize: 4 });
        const cluster = r.nodes.find(n => 'kind' in n && n.kind === 'cluster')! as any;
        // Lowest of 0.9, 0.75, 0.6, 0.45 = 0.45.
        expect(cluster.confidence).toBeCloseTo(0.45, 5);
    });

    it('collapsed-edge confidence = max(constituent.confidence) — best signal', () => {
        const siblings = ['a', 'b', 'c', 'd'].map(s => mkNode({ urn: s, name: `pref_${s}` }));
        const edges = siblings.map((s, i) => mkEdge(PIVOT_URN, s.urn, 'WRITES', 0.3 + i * 0.2));
        const r = clusterGraphNodes([pivot, ...siblings], edges, { enabled: true, minSize: 4 });
        const survivingEdge = r.edges.find(e => e.source === PIVOT_URN)!;
        expect(survivingEdge.confidence).toBeCloseTo(0.9, 5); // max(0.3, 0.5, 0.7, 0.9)
    });

    it('cluster label drops the family chunk when nameFamily falls back to the type', () => {
        // Names with no separator → nameFamily = node.type. We don't want
        // "22 APIEndpoint API Endpoints" — strip the redundant chunk.
        const siblings = ['findA', 'findB', 'findC', 'findD'].map(s =>
            mkNode({ urn: `cr:api:${s}`, name: s, type: 'APIEndpoint' }),
        );
        const edges = siblings.map(s => mkEdge(PIVOT_URN, s.urn));
        const r = clusterGraphNodes([pivot, ...siblings], edges, { enabled: true, minSize: 4 });
        const cluster = r.nodes.find(n => 'kind' in n && n.kind === 'cluster')! as any;
        expect(cluster.label).toBe('API Endpoints');
    });

    it('cluster label uses the path-family last segment for REST endpoints', () => {
        const siblings = ['equipments', 'saves', 'lookups', 'reviews'].map(s =>
            mkNode({ urn: `cr:api:${s}`, name: `GET /api/v2/bike/${s}`, type: 'APIEndpoint' }),
        );
        const edges = siblings.map(s => mkEdge(PIVOT_URN, s.urn));
        const r = clusterGraphNodes([pivot, ...siblings], edges, { enabled: true, minSize: 4 });
        const cluster = r.nodes.find(n => 'kind' in n && n.kind === 'cluster')! as any;
        expect(cluster.label).toBe('Bike API Endpoints');
    });

    it('memberToClusterId maps every member URN to the supernode id', () => {
        const siblings = ['auto', 'moto', 'autocarri', 'dati'].map(s =>
            mkNode({ urn: `cr:dc:quote_${s}`, name: `quote_${s}` }),
        );
        const edges = siblings.map(s => mkEdge(PIVOT_URN, s.urn));
        const r = clusterGraphNodes([pivot, ...siblings], edges, { enabled: true, minSize: 4 });
        const clusterId = (r.nodes.find(n => 'kind' in n && n.kind === 'cluster')! as any).id as string;
        for (const s of siblings) {
            expect(r.memberToClusterId.get(s.urn)).toBe(clusterId);
        }
    });

    // ── Ambiguous multi-datastore bind: a DataContainer STORED_IN two datastores
    //    surfaces in BOTH stores' clusters (the conservative-bind UI contract). ──
    describe('multi-datastore (ambiguous bind) membership', () => {
        const ds = (...names: string[]) => names.map(name => ({ name, host: null }));
        const clusters = (r: ReturnType<typeof clusterGraphNodes>) =>
            r.nodes.filter(n => 'kind' in n && n.kind === 'cluster') as any[];

        it('places a 2-store container in its primary cluster AND a co-candidate island card', () => {
            // integration-hub: { quote (primary), bench (primary) } → collapses (db-min 2).
            // archive:         { quote (secondary) }                 → collapses at 1 (all-secondary).
            const quote = mkNode({ urn: 'cr:dc:quote', name: 'quote_{var}', datastore: ds('integration-hub', 'archive'), needsReview: true });
            const bench = mkNode({ urn: 'cr:dc:bench', name: 'benchmark_date', datastore: ds('integration-hub') });
            const edges = [mkEdge(PIVOT_URN, quote.urn), mkEdge(PIVOT_URN, bench.urn)];
            const r = clusterGraphNodes([pivot, quote, bench], edges, { enabled: true, minSize: 4 });

            const cs = clusters(r);
            expect(cs).toHaveLength(2);
            const byStore = new Map(cs.map(c => [c.datastoreName, c]));
            expect([...byStore.keys()].sort()).toEqual(['archive', 'integration-hub']);

            // quote is a member of BOTH stores' clusters; archive is the singleton island.
            expect(byStore.get('integration-hub').members.map((m: any) => m.urn).sort()).toEqual(['cr:dc:bench', 'cr:dc:quote']);
            expect(byStore.get('archive').members.map((m: any) => m.urn)).toEqual(['cr:dc:quote']);
        });

        it('never emits the shared container as a duplicate top-level node', () => {
            const quote = mkNode({ urn: 'cr:dc:quote', name: 'quote_{var}', datastore: ds('integration-hub', 'archive'), needsReview: true });
            const bench = mkNode({ urn: 'cr:dc:bench', name: 'benchmark_date', datastore: ds('integration-hub') });
            const edges = [mkEdge(PIVOT_URN, quote.urn), mkEdge(PIVOT_URN, bench.urn)];
            const r = clusterGraphNodes([pivot, quote, bench], edges, { enabled: true, minSize: 4 });

            // quote is collapsed, so it must not also appear as a loose GraphNode.
            const looseQuote = r.nodes.filter(n => !('kind' in n) && (n as GraphNode).urn === 'cr:dc:quote');
            expect(looseQuote).toHaveLength(0);
            expect(r.collapsedUrns.has('cr:dc:quote')).toBe(true);
        });

        it('routes the shared container edges to its PRIMARY cluster only', () => {
            const quote = mkNode({ urn: 'cr:dc:quote', name: 'quote_{var}', datastore: ds('integration-hub', 'archive'), needsReview: true });
            const bench = mkNode({ urn: 'cr:dc:bench', name: 'benchmark_date', datastore: ds('integration-hub') });
            const edges = [mkEdge(PIVOT_URN, quote.urn), mkEdge(PIVOT_URN, bench.urn)];
            const r = clusterGraphNodes([pivot, quote, bench], edges, { enabled: true, minSize: 4 });

            const ihCluster = clusters(r).find(c => c.datastoreName === 'integration-hub')!;
            const archiveCluster = clusters(r).find(c => c.datastoreName === 'archive')!;
            expect(r.memberToClusterId.get('cr:dc:quote')).toBe(ihCluster.id);
            // The archive island card carries no redirected edge (its member's edge stays on the primary).
            expect(r.edges.some(e => e.target === archiveCluster.id)).toBe(false);
            expect(r.edges.some(e => e.source === PIVOT_URN && e.target === ihCluster.id)).toBe(true);
        });

        it('shows the container in both clusters when BOTH stores are shared (no island)', () => {
            // store-a: { q (primary), a1 } ; store-b: { q (secondary), b1 } → both collapse at 2.
            const q = mkNode({ urn: 'cr:dc:q', name: 'q_tbl', datastore: ds('store-a', 'store-b'), needsReview: true });
            const a1 = mkNode({ urn: 'cr:dc:a1', name: 'a_one', datastore: ds('store-a') });
            const b1 = mkNode({ urn: 'cr:dc:b1', name: 'b_one', datastore: ds('store-b') });
            const edges = [mkEdge(PIVOT_URN, q.urn), mkEdge(PIVOT_URN, a1.urn), mkEdge(PIVOT_URN, b1.urn)];
            const r = clusterGraphNodes([pivot, q, a1, b1], edges, { enabled: true, minSize: 4 });

            const cs = clusters(r);
            expect(cs).toHaveLength(2);
            for (const store of ['store-a', 'store-b']) {
                const c = cs.find(x => x.datastoreName === store)!;
                expect(c.members.map((m: any) => m.urn)).toContain('cr:dc:q');
            }
            // primary (store-a) owns the edge routing.
            const storeA = cs.find(c => c.datastoreName === 'store-a')!;
            expect(r.memberToClusterId.get('cr:dc:q')).toBe(storeA.id);
        });

        it('does NOT turn an ordinary single-table datastore into a 1-member card', () => {
            // A lone table whose ONLY store is its primary must stay standalone — the
            // size-1 collapse is reserved for co-candidate (secondary) placements.
            const lone = mkNode({ urn: 'cr:dc:lone', name: 'lonely', datastore: ds('solo-db') });
            const edges = [mkEdge(PIVOT_URN, lone.urn)];
            const r = clusterGraphNodes([pivot, lone], edges, { enabled: true, minSize: 4 });
            expect(clusters(r)).toHaveLength(0);
            expect(r.collapsedUrns.has('cr:dc:lone')).toBe(false);
        });
    });
});
