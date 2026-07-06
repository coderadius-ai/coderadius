import { describe, expect, it } from 'vitest';
import {
    filterStream,
    matchesQuery,
    matchesDirection,
    matchesKind,
    countByKindInScope,
    countByDirectionInScope,
    T2_KEY,
    type StreamRow,
} from '../../../packages/dashboard-ui/src/components/blast-radius/utils/stream';
import type { TopologyNode } from '../../../packages/shared-types/index';

function mkRow(opts: {
    urn: string;
    name?: string;
    type?: string;
    rel?: string;
    direction?: 'upstream' | 'downstream';
    tier?: 1 | 2;
    rels?: string[];
    teamOwner?: string | null;
    repositoryName?: string | null;
}): StreamRow {
    const node: TopologyNode = {
        name: opts.name ?? opts.urn,
        type: opts.type ?? 'Service',
        teamOwner: opts.teamOwner ?? undefined,
        repository: opts.repositoryName ? { name: opts.repositoryName, url: null } : undefined,
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
    mkRow({ urn: 'cr:service:acme:orders', name: 'orders', type: 'Service', direction: 'downstream', teamOwner: 'fulfilment' }),
    mkRow({ urn: 'cr:service:acme:billing', name: 'billing', type: 'Service', direction: 'upstream', teamOwner: 'finance' }),
    mkRow({ urn: 'cr:apiendpoint:acme:checkout', name: 'POST /api/checkout', type: 'APIEndpoint', direction: 'downstream', rel: 'IMPLEMENTS' }),
    mkRow({ urn: 'cr:datacontainer:acme:orders_log', name: 'orders_log', type: 'DataContainer', direction: 'upstream', rel: 'READS', tier: 2 }),
    mkRow({ urn: 'cr:package:acme:pg-client', name: 'pg-client', type: 'Package', direction: 'upstream', rel: 'DEPENDS_ON' }),
    mkRow({ urn: 'cr:messagechannel:acme:invoices', name: 'invoices', type: 'MessageChannel', direction: 'downstream', rel: 'PUBLISHES_TO' }),
];

describe('matchesDirection', () => {
    it('all → every row', () => {
        for (const r of fixture) expect(matchesDirection(r, 'all')).toBe(true);
    });
    it("'in' keeps only upstream rows", () => {
        const kept = fixture.filter(r => matchesDirection(r, 'in'));
        expect(kept.map(r => r.urn).sort()).toEqual([
            'cr:datacontainer:acme:orders_log',
            'cr:package:acme:pg-client',
            'cr:service:acme:billing',
        ]);
    });
    it("'out' keeps only downstream rows", () => {
        const kept = fixture.filter(r => matchesDirection(r, 'out'));
        expect(kept.map(r => r.urn).sort()).toEqual([
            'cr:apiendpoint:acme:checkout',
            'cr:messagechannel:acme:invoices',
            'cr:service:acme:orders',
        ]);
    });
});

describe('matchesQuery', () => {
    it('matches node.name case-insensitively', () => {
        const r = mkRow({ urn: 'svc', name: 'Orders' });
        expect(matchesQuery(r, 'ord')).toBe(true);
        expect(matchesQuery(r, 'ORD')).toBe(true);
    });
    it('matches urn substring when name does not', () => {
        const r = mkRow({ urn: 'cr:service:acme:hidden-svc', name: 'visible' });
        expect(matchesQuery(r, 'hidden')).toBe(true);
        expect(matchesQuery(r, 'nope')).toBe(false);
    });
    it('matches API path inside the APIEndpoint name', () => {
        const r = mkRow({ urn: 'api', name: 'POST /api/checkout', type: 'APIEndpoint' });
        expect(matchesQuery(r, 'checkout')).toBe(true);
        expect(matchesQuery(r, '/api/')).toBe(true);
    });
    it('matches teamOwner', () => {
        const r = mkRow({ urn: 'svc', name: 'svc', teamOwner: 'fulfilment' });
        expect(matchesQuery(r, 'fulfil')).toBe(true);
    });
    it('matches repository.name', () => {
        const r = mkRow({ urn: 'svc', name: 'svc', repositoryName: 'acme-monorepo' });
        expect(matchesQuery(r, 'monorepo')).toBe(true);
    });
    it('empty query → matches every row', () => {
        for (const r of fixture) expect(matchesQuery(r, '')).toBe(true);
    });
});

describe('matchesKind', () => {
    it('empty active set → matches every row', () => {
        for (const r of fixture) expect(matchesKind(r, new Set())).toBe(true);
    });
    it('Service-only set keeps Service rows', () => {
        const kept = fixture.filter(r => matchesKind(r, new Set(['Service'])));
        expect(kept.map(r => r.urn).sort()).toEqual([
            'cr:service:acme:billing',
            'cr:service:acme:orders',
        ]);
    });
    it('T2 key keeps tier=2 rows (TieredBlastPanel.tsx:57 parity)', () => {
        const kept = fixture.filter(r => matchesKind(r, new Set([T2_KEY])));
        expect(kept).toHaveLength(1);
        expect(kept[0].urn).toBe('cr:datacontainer:acme:orders_log');
    });
    it('union semantics across multiple kinds', () => {
        const kept = fixture.filter(r => matchesKind(r, new Set(['Service', 'APIEndpoint'])));
        expect(kept.map(r => r.node.type).sort()).toEqual(['APIEndpoint', 'Service', 'Service']);
    });
});

describe('filterStream', () => {
    it('combines query + direction + kind filters', () => {
        const kept = filterStream(fixture, {
            query: 'ord',
            direction: 'all',
            activeKinds: new Set(['Service', 'DataContainer']),
        });
        // 'ord' matches 'orders' (Service down) and 'orders_log' (DataContainer up)
        expect(kept.map(r => r.urn).sort()).toEqual([
            'cr:datacontainer:acme:orders_log',
            'cr:service:acme:orders',
        ]);
    });
    it('returns [] when filters exclude all rows', () => {
        const kept = filterStream(fixture, {
            query: 'no-such-string-anywhere',
            direction: 'all',
            activeKinds: new Set(),
        });
        expect(kept).toEqual([]);
    });
});

describe('countByKindInScope', () => {
    it('groups Package rows under the Package kind chip', () => {
        const { byKind } = countByKindInScope(fixture, '', 'all');
        expect(byKind.get('Package')).toBe(1);
    });
    it('respects active query + direction (excludes own dimension)', () => {
        // direction='in' → upstream only: billing (Service), orders_log (DC), pg-client (Package)
        const { byKind, t2 } = countByKindInScope(fixture, '', 'in');
        expect(byKind.get('Service')).toBe(1);
        expect(byKind.get('DataContainer')).toBe(1);
        expect(byKind.get('Package')).toBe(1);
        expect(byKind.get('APIEndpoint')).toBeUndefined();
        expect(t2).toBe(1);
    });
    it('respects query within the scope', () => {
        const { byKind } = countByKindInScope(fixture, 'ord', 'all');
        // matches orders + orders_log only
        expect(byKind.get('Service')).toBe(1);
        expect(byKind.get('DataContainer')).toBe(1);
        expect(byKind.size).toBe(2);
    });
});

describe('countByDirectionInScope', () => {
    it('respects active query + activeKinds (excludes own dimension)', () => {
        // activeKinds={Service} → only the 2 Service rows: orders (down), billing (up)
        const counts = countByDirectionInScope(fixture, '', new Set(['Service']));
        expect(counts.all).toBe(2);
        expect(counts.in).toBe(1);
        expect(counts.out).toBe(1);
    });
    it('returns all=in=out=0 when query excludes every row', () => {
        const counts = countByDirectionInScope(fixture, 'zzz-not-present', new Set());
        expect(counts).toEqual({ all: 0, in: 0, out: 0 });
    });
});
