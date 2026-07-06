import { describe, it, expect } from 'vitest';
import { buildBlastGraphModel } from '../../../packages/dashboard-ui/src/lib/graph-model';
import type { TopologyMap, TopologyNode } from '@coderadius/shared-types';
import type { TieredBlast } from '../../../packages/dashboard-ui/src/lib/topology';

// Regression: a node reachable BOTH as a direct T1 (e.g. an env-var-derived
// service→service DEPENDS_ON, upstream) AND transitively as a T2 via a
// passthrough endpoint (downstream) must be placed at T2 (col ±2), not frozen
// at T1 by addNode's first-wins semantics. getTieredBlasts' contract is
// "T2 wins over T1"; the graph model must honour it so the 2-hop renders.

const svc = (name: string): TopologyNode => ({ name, type: 'Service' });
const endpoint = (name: string): TopologyNode => ({ name, type: 'APIEndpoint' });

describe('buildBlastGraphModel — dual-role T1-upstream + T2-downstream', () => {
    const PIVOT = 'cr:service:acme/checkout:checkout';
    const CONSUMER = 'cr:service:acme/orders:api';
    const EP = 'cr:endpoint:acme/checkout:POST:/api/quote';

    // Pivot EXPOSES an endpoint that CONSUMER calls (→ consumer is T2 downstream,
    // behind the endpoint), while a speculative env-var DEPENDS_ON also links
    // pivot→consumer directly (→ consumer is T1 upstream).
    const impact: TieredBlast = {
        upstream: [
            { urn: CONSUMER, node: svc('api'), rel: 'DEPENDS_ON', direction: 'upstream', tier: 1 },
        ],
        downstream: [
            { urn: EP, node: endpoint('POST /api/quote'), rel: 'IMPLEMENTS_ENDPOINT', direction: 'downstream', tier: 1 },
            {
                urn: CONSUMER, node: svc('api'), rel: 'CALLS', direction: 'downstream', tier: 2,
                via: { urn: EP, node: endpoint('POST /api/quote'), rel: 'IMPLEMENTS_ENDPOINT' },
            },
        ],
    };

    const topology: TopologyMap = {
        nodes: { [PIVOT]: svc('checkout'), [CONSUMER]: svc('api'), [EP]: endpoint('POST /api/quote') },
        out: {}, in: {},
    };

    const model = buildBlastGraphModel({
        topology, selectedUrn: PIVOT, selectedNode: svc('checkout'),
        impact, hiddenTypes: new Set(), hiddenRels: new Set(), showT2: true, graphQuery: '',
    });

    it('places the dual-role consumer at tier 2 (behind the endpoint), not tier 1', () => {
        const consumer = model.nodes.find(n => n.urn === CONSUMER);
        expect(consumer).toBeDefined();
        expect(consumer!.tier).toBe(2);
        expect(Math.abs(consumer!.col)).toBe(2);
    });

    it('keeps the passthrough endpoint at tier 1, between pivot and consumer', () => {
        const ep = model.nodes.find(n => n.urn === EP);
        expect(ep!.tier).toBe(1);
        expect(Math.abs(ep!.col)).toBe(1);
    });

    it('drops the direct pivot↔consumer edge once the 2-hop path exists', () => {
        const isDirect = (e: { source: string; target: string }) =>
            (e.source === PIVOT && e.target === CONSUMER) || (e.source === CONSUMER && e.target === PIVOT);
        expect(model.edges.some(isDirect)).toBe(false);
        // the 2-hop path survives: pivot→endpoint and endpoint→consumer
        expect(model.edges.some(e => e.source === PIVOT && e.target === EP)).toBe(true);
        expect(model.edges.some(e => e.source === EP && e.target === CONSUMER)).toBe(true);
    });
});
