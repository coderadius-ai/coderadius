import { describe, expect, it } from 'vitest';
import { buildBlastGraphModel } from '../../../packages/dashboard-ui/src/lib/graph-model';
import { getTieredBlasts } from '../../../packages/dashboard-ui/src/lib/topology';
import type { TopologyMap, TopologyNode, TopologyEdge } from '../../../packages/shared-types/index';

// ─── Fixture vocabulary (anonymised — acme/orders/shipping) ──────────────────
const PUBLISHER = 'cr:service:acme/orders:order-publisher';
const CONSUMER = 'cr:service:acme/shipping:shipment-consumer';
const CHANNEL = 'cr:channel:topic:orders.order.created';
const CHANNEL_B = 'cr:channel:topic:orders.order.created.audit';

function svc(name: string): TopologyNode {
    return { name, type: 'Service' };
}
function channel(name: string): TopologyNode {
    return { name, type: 'MessageChannel', channelKind: 'topic' };
}
function edge(source: string, target: string, rel: string): TopologyEdge {
    return { source, target, rel };
}

/**
 * Pivot = a publisher service. The consumer is a Tier-2 node reached THROUGH
 * the channel (publisher ─PUBLISHES_TO→ channel ←LISTENS_TO─ consumer). This is
 * the exact shape that triggered the duplicate counter-flowing `LISTENS_TO`
 * edge: the topology stores `consumer → channel`, so the multi-via fan-out's
 * `relsReversed` orientation disagreed with the primary loop's pivot-outward
 * orientation, and both legs got drawn.
 */
function singleChannelTopology(): TopologyMap {
    return {
        nodes: {
            [PUBLISHER]: svc('order-publisher'),
            [CONSUMER]: svc('shipment-consumer'),
            [CHANNEL]: channel('orders.order.created'),
        },
        out: {
            [PUBLISHER]: [edge(PUBLISHER, CHANNEL, 'PUBLISHES_TO')],
            [CONSUMER]: [edge(CONSUMER, CHANNEL, 'LISTENS_TO')],
        },
        in: {
            [CHANNEL]: [
                edge(PUBLISHER, CHANNEL, 'PUBLISHES_TO'),
                edge(CONSUMER, CHANNEL, 'LISTENS_TO'),
            ],
        },
    };
}

function buildFrom(topology: TopologyMap, pivot: string) {
    const impact = getTieredBlasts(topology, pivot);
    return buildBlastGraphModel({
        topology,
        selectedUrn: pivot,
        selectedNode: topology.nodes[pivot],
        impact,
        hiddenTypes: new Set<string>(),
        hiddenRels: new Set<string>(),
        showT2: true,
        graphQuery: '',
    });
}

const undirected = (e: { source: string; target: string }, a: string, b: string) =>
    (e.source === a && e.target === b) || (e.source === b && e.target === a);

// The builder returns pre-cluster edges; same-direction duplicates (e.g. a T1
// channel edge + the same leg re-drawn as a T2 via-edge) collapse in
// `clusterGraphNodes` because they share an `id`. The bug was OPPOSITE-direction
// edges, which have distinct ids and survive to render. Asserting on the set of
// distinct ids mirrors exactly what the canvas paints.
const distinctEdges = (edges: { id: string }[]) => {
    const byId = new Map<string, (typeof edges)[number]>();
    for (const e of edges) byId.set(e.id, e);
    return [...byId.values()];
};

describe('buildBlastGraphModel — single-via T2 (consumer through a channel)', () => {
    it('draws exactly one LISTENS_TO edge between the channel and the consumer (no counter-flow duplicate)', () => {
        const { edges } = buildFrom(singleChannelTopology(), PUBLISHER);

        const listensBetween = distinctEdges(edges).filter(
            e => e.rel === 'LISTENS_TO' && undirected(e, CHANNEL, CONSUMER),
        );
        // RED before the fix: the multi-via fan-out re-emitted the leg with
        // swapped endpoints (distinct id `consumer->channel`) → length 2,
        // animating in opposite directions.
        expect(listensBetween).toHaveLength(1);
    });

    it('orients the surviving leg pivot-outward (channel → consumer), matching the primary impact loop', () => {
        const { edges } = buildFrom(singleChannelTopology(), PUBLISHER);
        const listens = distinctEdges(edges).filter(e => e.rel === 'LISTENS_TO');
        expect(listens).toHaveLength(1);
        expect(listens[0].source).toBe(CHANNEL);
        expect(listens[0].target).toBe(CONSUMER);
    });

    it('never emits the reversed consumer → channel edge', () => {
        const { edges } = buildFrom(singleChannelTopology(), PUBLISHER);
        expect(edges.some(e => e.source === CONSUMER && e.target === CHANNEL)).toBe(false);
    });

    it('keeps a single PUBLISHES_TO edge (publisher → channel)', () => {
        const { edges } = buildFrom(singleChannelTopology(), PUBLISHER);
        const publishes = distinctEdges(edges).filter(e => e.rel === 'PUBLISHES_TO');
        expect(publishes).toHaveLength(1);
        expect(publishes[0].source).toBe(PUBLISHER);
        expect(publishes[0].target).toBe(CHANNEL);
    });

    it('does not mark the single-via consumer as multi-via (no "+N" coupling to reveal)', () => {
        const { multiViaSigs, t2BridgeCounts } = buildFrom(singleChannelTopology(), PUBLISHER);
        expect(multiViaSigs.size).toBe(0);
        expect(t2BridgeCounts.get(CONSUMER)).toBe(1);
    });
});

describe('buildBlastGraphModel — genuine multi-via is preserved', () => {
    // Same consumer reachable through TWO distinct channels. The fix must NOT
    // suppress the second bridge: it's real additional coupling, surfaced on
    // hover. Only the same-pair counter-flow duplicate is suppressed.
    function twoChannelTopology(): TopologyMap {
        return {
            nodes: {
                [PUBLISHER]: svc('order-publisher'),
                [CONSUMER]: svc('shipment-consumer'),
                [CHANNEL]: channel('orders.order.created'),
                [CHANNEL_B]: channel('orders.order.created.audit'),
            },
            out: {
                [PUBLISHER]: [
                    edge(PUBLISHER, CHANNEL, 'PUBLISHES_TO'),
                    edge(PUBLISHER, CHANNEL_B, 'PUBLISHES_TO'),
                ],
                [CONSUMER]: [
                    edge(CONSUMER, CHANNEL, 'LISTENS_TO'),
                    edge(CONSUMER, CHANNEL_B, 'LISTENS_TO'),
                ],
            },
            in: {
                [CHANNEL]: [
                    edge(PUBLISHER, CHANNEL, 'PUBLISHES_TO'),
                    edge(CONSUMER, CHANNEL, 'LISTENS_TO'),
                ],
                [CHANNEL_B]: [
                    edge(PUBLISHER, CHANNEL_B, 'PUBLISHES_TO'),
                    edge(CONSUMER, CHANNEL_B, 'LISTENS_TO'),
                ],
            },
        };
    }

    it('emits one LISTENS_TO edge per distinct channel, with no same-pair counter-flow', () => {
        const { edges, t2BridgeCounts } = buildFrom(twoChannelTopology(), PUBLISHER);

        const listens = distinctEdges(edges).filter(e => e.rel === 'LISTENS_TO');
        expect(listens).toHaveLength(2);
        expect(listens.filter(e => undirected(e, CHANNEL, CONSUMER))).toHaveLength(1);
        expect(listens.filter(e => undirected(e, CHANNEL_B, CONSUMER))).toHaveLength(1);

        // The consumer is reachable via both channels → "+N" coupling.
        expect(t2BridgeCounts.get(CONSUMER)).toBe(2);
    });

    it('marks the additional bridge as multi-via (hover-revealed), not the primary one', () => {
        const { multiViaSigs } = buildFrom(twoChannelTopology(), PUBLISHER);
        // Exactly one extra bridge beyond the primary via was recorded.
        const allTagged = [...multiViaSigs.values()].flatMap(s => [...s]);
        expect(allTagged).toContain(CONSUMER);
        expect(multiViaSigs.size).toBe(1);
    });
});
