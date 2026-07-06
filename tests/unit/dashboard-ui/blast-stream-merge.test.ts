import { describe, expect, it } from 'vitest';
import { mergeStream } from '../../../packages/dashboard-ui/src/components/blast-radius/utils/stream';
import type { TieredBlastNode } from '../../../packages/dashboard-ui/src/lib/topology';
import type { TopologyNode } from '../../../packages/shared-types/index';

function mkNode(opts: Partial<TopologyNode> & { name: string; type?: string }): TopologyNode {
    return {
        name: opts.name,
        type: opts.type ?? 'Service',
        ...opts,
    } as TopologyNode;
}

function mkItem(opts: {
    urn: string;
    name?: string;
    type?: string;
    rel?: string;
    direction?: 'upstream' | 'downstream';
    tier?: 1 | 2;
    via?: TieredBlastNode['via'];
    rels?: string[];
    functions?: { name: string; file: string | null }[];
    node?: Partial<TopologyNode>;
}): TieredBlastNode {
    return {
        urn: opts.urn,
        node: mkNode({ name: opts.name ?? opts.urn, type: opts.type, ...(opts.node ?? {}) }),
        rel: opts.rel ?? 'CALLS',
        direction: opts.direction ?? 'downstream',
        tier: opts.tier ?? 1,
        via: opts.via,
        rels: opts.rels,
        functions: opts.functions,
    };
}

describe('mergeStream', () => {
    it('merges duplicate (urn, direction) inputs into one row with deduped rels', () => {
        const out = mergeStream([
            mkItem({ urn: 'a', rel: 'CALLS' }),
            mkItem({ urn: 'a', rel: 'CALLS' }),
            mkItem({ urn: 'a', rel: 'READS' }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].urn).toBe('a');
        expect(out[0].totalCount).toBe(3);
        expect(out[0].rels.sort()).toEqual(['CALLS', 'READS']);
    });

    it('keeps a node that appears upstream AND downstream as two separate rows', () => {
        const out = mergeStream([
            mkItem({ urn: 'a', direction: 'upstream', rel: 'READS' }),
            mkItem({ urn: 'a', direction: 'downstream', rel: 'CALLS' }),
        ]);
        expect(out).toHaveLength(2);
        const up = out.find(r => r.direction === 'upstream')!;
        const down = out.find(r => r.direction === 'downstream')!;
        expect(up.rels).toEqual(['READS']);
        expect(down.rels).toEqual(['CALLS']);
    });

    it('accumulates totalCount across all merged inputs for the same key', () => {
        const out = mergeStream([
            mkItem({ urn: 'a', rel: 'CALLS' }),
            mkItem({ urn: 'a', rel: 'READS' }),
            mkItem({ urn: 'a', rel: 'WRITES' }),
            mkItem({ urn: 'a', rel: 'CALLS' }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].totalCount).toBe(4);
    });

    it('absorbs item.rels[] entries from T2-enriched inputs (TieredBlastPanel.tsx:38-40)', () => {
        const out = mergeStream([
            mkItem({ urn: 'a', rel: 'CALLS' }),
            mkItem({ urn: 'a', rel: 'CALLS', rels: ['READS', 'WRITES'] }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].rels.sort()).toEqual(['CALLS', 'READS', 'WRITES']);
    });

    it('promotes the merged row to tier 2 if any input is T2 (T2 wins over T1)', () => {
        const via = { urn: 'mid', node: mkNode({ name: 'mid', type: 'DataContainer' }), rel: 'READS' };
        const out = mergeStream([
            mkItem({ urn: 'a', rel: 'CALLS', tier: 1 }),
            mkItem({ urn: 'a', rel: 'READS', tier: 2, via }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].tier).toBe(2);
        expect(out[0].via?.urn).toBe('mid');
    });

    it('passes Package items through into the unified stream', () => {
        const out = mergeStream([
            mkItem({ urn: 'svc', type: 'Service', direction: 'upstream' }),
            mkItem({ urn: 'pkg', type: 'Package', direction: 'upstream', rel: 'DEPENDS_ON' }),
        ]);
        expect(out).toHaveLength(2);
        expect(out.find(r => r.urn === 'pkg')?.node.type).toBe('Package');
    });

    it('dedupes functions by name when merging', () => {
        const out = mergeStream([
            mkItem({ urn: 'a', functions: [{ name: 'foo', file: 'a.ts' }] }),
            mkItem({ urn: 'a', functions: [{ name: 'foo', file: 'a.ts' }, { name: 'bar', file: 'b.ts' }] }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].functions?.map(f => f.name).sort()).toEqual(['bar', 'foo']);
    });
});
