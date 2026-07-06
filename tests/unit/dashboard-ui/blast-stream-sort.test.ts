import { describe, expect, it } from 'vitest';
import { sortStream, type StreamRow } from '../../../packages/dashboard-ui/src/components/blast-radius/utils/stream';
import { sortItems } from '../../../packages/dashboard-ui/src/components/blast-radius/utils/sort';
import type { TopologyNode } from '../../../packages/shared-types/index';

function mkRow(opts: {
    urn: string;
    name?: string;
    type?: string;
    rel?: string;
    direction?: 'upstream' | 'downstream';
    tier?: 1 | 2;
    rels?: string[];
}): StreamRow {
    const node: TopologyNode = {
        name: opts.name ?? opts.urn,
        type: opts.type ?? 'Service',
    } as TopologyNode;
    return {
        urn: opts.urn,
        node,
        rel: opts.rel ?? 'CALLS',
        direction: opts.direction ?? 'downstream',
        tier: opts.tier ?? 1,
        rels: opts.rels ?? [opts.rel ?? 'CALLS'],
        totalCount: 1,
    };
}

const fixture: StreamRow[] = [
    mkRow({ urn: 'svc-zeta', name: 'zeta', type: 'Service' }),
    mkRow({ urn: 'svc-alpha', name: 'alpha', type: 'Service', direction: 'upstream' }),
    mkRow({ urn: 'api-orders', name: 'POST /orders', type: 'APIEndpoint', rel: 'IMPLEMENTS' }),
    mkRow({ urn: 'dc-log', name: 'orders_log', type: 'DataContainer', rel: 'READS', tier: 2 }),
    mkRow({ urn: 'ch-invoices', name: 'invoices', type: 'MessageChannel', rel: 'PUBLISHES_TO' }),
];

describe('sortStream', () => {
    it('default → matches sortItems output (T2 first, then TYPE_SORT_ORDER, then name)', () => {
        const got = sortStream(fixture, 'default');
        const expected = sortItems(fixture).map(r => r.urn);
        expect(got.map(r => r.urn)).toEqual(expected);
        // Sanity: T2 row is first
        expect(got[0].tier).toBe(2);
    });

    it('name → alphabetical by node.name across all tiers and types', () => {
        const got = sortStream(fixture, 'name').map(r => r.node.name);
        expect(got).toEqual(['alpha', 'invoices', 'orders_log', 'POST /orders', 'zeta']);
    });

    it('direction → downstream first, then upstream, default sort within', () => {
        const got = sortStream(fixture, 'direction');
        // The single upstream row (alpha) must come AFTER every downstream row.
        const lastDownstreamIdx = [...got].map(r => r.direction).lastIndexOf('downstream');
        const firstUpstreamIdx = got.findIndex(r => r.direction === 'upstream');
        expect(firstUpstreamIdx).toBeGreaterThan(lastDownstreamIdx);
        // The only upstream row in the fixture lands last
        expect(got[got.length - 1].urn).toBe('svc-alpha');
    });

    it('rel → groups by first rel alphabetically, then by name', () => {
        const rows: StreamRow[] = [
            mkRow({ urn: 'a', name: 'a', rel: 'WRITES' }),
            mkRow({ urn: 'b', name: 'b', rel: 'CALLS' }),
            mkRow({ urn: 'c', name: 'c', rel: 'CALLS' }),
            mkRow({ urn: 'd', name: 'd', rel: 'READS' }),
        ];
        const got = sortStream(rows, 'rel').map(r => r.urn);
        // CALLS (b, c alphabetical), READS (d), WRITES (a)
        expect(got).toEqual(['b', 'c', 'd', 'a']);
    });
});
