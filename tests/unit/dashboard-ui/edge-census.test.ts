import { describe, expect, it } from 'vitest';
import { edgeCensus } from '../../../packages/dashboard-ui/src/components/blast-radius/lib/edge-census';
import type { TopologyMap } from '@coderadius/shared-types';

function topo(out: TopologyMap['out'], inn: TopologyMap['in']): TopologyMap {
    return { nodes: {}, out, in: inn };
}

const edge = (source: string, target: string, rel: string) => ({ source, target, rel });

describe('edgeCensus', () => {
    it('returns [] for a node with no edges', () => {
        expect(edgeCensus(topo({}, {}), 'cr:service:a')).toEqual([]);
    });

    it('counts out-edges and in-edges by rel', () => {
        const t = topo(
            { 'cr:svc:a': [edge('cr:svc:a', 'cr:dc:t1', 'READS'), edge('cr:svc:a', 'cr:dc:t2', 'READS')] },
            { 'cr:svc:a': [edge('cr:svc:b', 'cr:svc:a', 'CALLS')] },
        );
        expect(edgeCensus(t, 'cr:svc:a')).toEqual([
            { rel: 'READS', count: 2 },
            { rel: 'CALLS', count: 1 },
        ]);
    });

    it('orders by count descending, then alphabetically for stability', () => {
        const t = topo(
            { 'cr:svc:a': [edge('cr:svc:a', 'cr:dc:t', 'WRITES'), edge('cr:svc:a', 'cr:ch:q', 'PUBLISHES_TO')] },
            {},
        );
        expect(edgeCensus(t, 'cr:svc:a')).toEqual([
            { rel: 'PUBLISHES_TO', count: 1 },
            { rel: 'WRITES', count: 1 },
        ]);
    });

    it('counts a self-loop once, not twice', () => {
        // A self-loop edge appears in BOTH out[urn] and in[urn]; the census
        // must count the edge instance a single time.
        const loop = edge('cr:svc:a', 'cr:svc:a', 'CALLS');
        const t = topo({ 'cr:svc:a': [loop] }, { 'cr:svc:a': [loop] });
        expect(edgeCensus(t, 'cr:svc:a')).toEqual([{ rel: 'CALLS', count: 1 }]);
    });

    it('handles missing adjacency entries (urn absent from both maps)', () => {
        const t = topo({ other: [edge('other', 'x', 'READS')] }, {});
        expect(edgeCensus(t, 'cr:svc:a')).toEqual([]);
    });
});
