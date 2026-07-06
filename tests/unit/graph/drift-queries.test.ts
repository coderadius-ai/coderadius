import { describe, it, expect } from 'vitest';
import { normalizeDependencyRef } from '../../../src/ingestion/topology-resolver.js';
import { catalogEntityUrn } from '../../../src/graph/mutations/c4.js';
import {
    classifyDependencyDrift,
    classifyOwnerFacts,
    computeDriftScore,
    computeVerifiableCoverage,
} from '../../../src/graph/queries/drift-classify.js';

describe('normalizeDependencyRef (syntax parse, kept for ingestion)', () => {
    it('strips component:default/ prefix', () => {
        expect(normalizeDependencyRef('component:default/payment-svc')).toBe('payment-svc');
    });

    it('strips api:custom-ns/ prefix', () => {
        expect(normalizeDependencyRef('api:custom-ns/orders-api')).toBe('orders-api');
    });

    it('strips resource: prefix', () => {
        expect(normalizeDependencyRef('resource:default/mysql-primary')).toBe('mysql-primary');
    });

    it('passes through bare names', () => {
        expect(normalizeDependencyRef('simple-service')).toBe('simple-service');
    });

    it('handles kind without namespace', () => {
        expect(normalizeDependencyRef('component:my-svc')).toBe('my-svc');
    });
});

describe('catalogEntityUrn', () => {
    it('produces full URN with kind/namespace/source', () => {
        const urn = catalogEntityUrn('acme/orders', 'backstage', 'Component', 'default', 'orders-api');
        expect(urn).toBe('cr:catalogentity:acme/orders:backstage:component:default:orders-api');
    });

    it('different kind produces different URN', () => {
        const comp = catalogEntityUrn('acme/orders', 'backstage', 'Component', 'default', 'orders-api');
        const api = catalogEntityUrn('acme/orders', 'backstage', 'API', 'default', 'orders-api');
        expect(comp).not.toBe(api);
    });

    it('different namespace produces different URN', () => {
        const def = catalogEntityUrn('acme/orders', 'backstage', 'Component', 'default', 'orders-api');
        const custom = catalogEntityUrn('acme/orders', 'backstage', 'Component', 'custom', 'orders-api');
        expect(def).not.toBe(custom);
    });

    it('different source produces different URN', () => {
        const bs = catalogEntityUrn('acme/orders', 'backstage', 'Component', 'default', 'orders-api');
        const cx = catalogEntityUrn('acme/orders', 'cortex', 'Component', 'default', 'orders-api');
        expect(bs).not.toBe(cx);
    });
});

// Grounded-identity reconciliation: drift is only asserted between a declared ref
// that resolves to a real node and the service's observed edge to that SAME node.
// Anything that can't be grounded is "unverifiable", never fabricated as drift.
describe('classifyDependencyDrift', () => {
    it('declared ref resolves and the edge exists -> aligned', () => {
        const c = classifyDependencyDrift(
            [{ ref: 'orders', urn: 'u1' }],
            [],
            [{ urn: 'u1', name: 'orders' }],
        );
        expect(c.aligned).toEqual(['orders']);
        expect(c.groundedMissing).toEqual([]);
        expect(c.observedUndeclared).toEqual([]);
        expect(c.unverifiable).toEqual([]);
    });

    it('declared ref resolves but no edge -> grounded drift (catalog claims, code missing)', () => {
        const c = classifyDependencyDrift(
            [{ ref: 'orders', urn: 'u1' }],
            [],
            [],
        );
        expect(c.aligned).toEqual([]);
        expect(c.groundedMissing).toEqual(['orders']);
        expect(c.unverifiable).toEqual([]);
    });

    it('fully grounded + extra observed edge -> observed-undeclared drift', () => {
        const c = classifyDependencyDrift(
            [{ ref: 'orders', urn: 'u1' }],
            [],
            [{ urn: 'u1', name: 'orders' }, { urn: 'u2', name: 'extra' }],
        );
        expect(c.aligned).toEqual(['orders']);
        expect(c.observedUndeclared).toEqual(['extra']);
        expect(c.unverifiable).toEqual([]);
    });

    it('declared ref resolves to no node -> unverifiable, never drift', () => {
        const c = classifyDependencyDrift(
            [],
            ['trust-me'],
            [],
        );
        expect(c.unverifiable).toEqual(['trust-me']);
        expect(c.groundedMissing).toEqual([]);
        expect(c.observedUndeclared).toEqual([]);
    });

    it('ambiguity guard: any unresolved declaration -> extra observed edges become unverifiable, not drift', () => {
        const c = classifyDependencyDrift(
            [{ ref: 'orders', urn: 'u1' }],
            ['trust-me'],
            [{ urn: 'u1', name: 'orders' }, { urn: 'u2', name: 'sibling' }],
        );
        expect(c.aligned).toEqual(['orders']);
        expect(c.observedUndeclared).toEqual([]); // sibling is ambiguous, NOT drift
        expect(c.unverifiable.sort()).toEqual(['sibling', 'trust-me']);
    });

    it('dedups observed targets by urn', () => {
        const c = classifyDependencyDrift(
            [],
            [],
            [{ urn: 'u2', name: 'extra' }, { urn: 'u2', name: 'extra' }],
        );
        expect(c.observedUndeclared).toEqual(['extra']);
    });
});

// Owner drift is grounded-or-unverifiable: a catalog-vs-code owner NAME mismatch
// is aligned only when the two team identities are reconciled (same Team or an
// approved TeamAlias). Otherwise it is unverifiable (off-score), never fabricated
// as drift -- we can't deterministically tell "same team, two names" from
// "genuinely different teams".
describe('classifyOwnerFacts (owner reconciliation)', () => {
    const fact = (over: Partial<Parameters<typeof classifyOwnerFacts>[0][number]> = {}) => ({
        serviceName: 's', serviceUrn: 'cr:service:t:s',
        catalogOwner: 'Platform', codeOwner: 'platform-team', reconciled: false, ...over,
    });

    it('reconciled mismatch is aligned, never drift', () => {
        const r = classifyOwnerFacts([fact({ reconciled: true })]);
        expect(r.reconciled).toHaveLength(1);
        expect(r.unverifiable).toHaveLength(0);
    });

    it('unreconciled name mismatch is unverifiable (off-score), never drift', () => {
        const r = classifyOwnerFacts([fact({ reconciled: false })]);
        expect(r.unverifiable).toHaveLength(1);
        expect(r.unverifiable[0].catalogOwner).toBe('Platform');
        expect(r.unverifiable[0].codeOwner).toBe('platform-team');
        expect(r.reconciled).toHaveLength(0);
    });

    it('partitions a mixed batch', () => {
        const r = classifyOwnerFacts([
            fact({ serviceName: 'a', reconciled: true }),
            fact({ serviceName: 'b', reconciled: false }),
            fact({ serviceName: 'c', reconciled: false }),
        ]);
        expect(r.reconciled.map(f => f.serviceName)).toEqual(['a']);
        expect(r.unverifiable.map(f => f.serviceName)).toEqual(['b', 'c']);
    });
});

describe('computeDriftScore (unverifiable is off-score)', () => {
    it('returns 100 when no grounded drift', () => {
        expect(computeDriftScore(10, 0, 0)).toBe(100);
    });

    it('returns 0 when everything has grounded drift', () => {
        expect(computeDriftScore(8, 2, 10)).toBe(0);
    });

    it('counts a multi-drift entity once', () => {
        expect(computeDriftScore(10, 0, 3)).toBe(70);
    });

    it('includes orphans in the denominator', () => {
        expect(computeDriftScore(8, 2, 2)).toBe(80);
    });

    it('returns 100 for an empty graph', () => {
        expect(computeDriftScore(0, 0, 0)).toBe(100);
    });
});

describe('computeVerifiableCoverage (share of declared facts we could ground)', () => {
    it('returns 100 when there are no declared facts', () => {
        expect(computeVerifiableCoverage(0, 0)).toBe(100);
    });

    it('returns 100 when every declared fact resolved', () => {
        expect(computeVerifiableCoverage(10, 0)).toBe(100);
    });

    it('returns 0 when nothing resolved', () => {
        expect(computeVerifiableCoverage(0, 10)).toBe(0);
    });

    it('reports the verified fraction', () => {
        expect(computeVerifiableCoverage(3, 1)).toBe(75);
        expect(computeVerifiableCoverage(1, 3)).toBe(25);
    });
});
