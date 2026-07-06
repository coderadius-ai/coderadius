import { describe, it, expect } from 'vitest';
import {
    dedupeCatalogConsumers,
    reposFromConsumers,
    teamsFromConsumers,
    pickCatalogProvenance,
    type RawCatalogConsumer,
    type RawCatalogProvenance,
} from '../../../../src/graph/queries/catalog-consumers.js';

// Reproduction of the reported Consumers bug. The catalog query collects one raw
// row per (service, harness-dir) occurrence — Memgraph does NOT dedupe map
// literals under collect(DISTINCT). validate-payload lives in one monorepo
// (microservices) across 3 services, with notification-service holding it in two
// harness dirs (.agents symlink + .claude). The pre-fix UI showed 4 identical
// "microservices" rows with teams checkout/payments/checkout/checkout.
const VALIDATE_PAYLOAD_ROWS: RawCatalogConsumer[] = [
    { service: 'notification-service', repo: 'microservices', url: null, team: 'team-checkout' },
    { service: 'notification-service', repo: 'microservices', url: null, team: 'team-checkout' }, // .agents symlink dup
    { service: 'payment-service',      repo: 'microservices', url: null, team: 'team-payments' },
    { service: 'pricing-service',      repo: 'microservices', url: null, team: 'team-checkout' },
];

describe('dedupeCatalogConsumers', () => {
    it('collapses harness-dir copies within a service to ONE consumer per service', () => {
        const consumers = dedupeCatalogConsumers(VALIDATE_PAYLOAD_ROWS);
        expect(consumers.map(c => c.service)).toEqual([
            'notification-service',
            'payment-service',
            'pricing-service',
        ]);
        // Three distinct services, not four file occurrences.
        expect(consumers).toHaveLength(3);
    });

    it('keeps each service paired with its OWN team (no index-zip mislabeling)', () => {
        const byService = Object.fromEntries(
            dedupeCatalogConsumers(VALIDATE_PAYLOAD_ROWS).map(c => [c.service, c.team]),
        );
        expect(byService['notification-service']).toBe('team-checkout');
        expect(byService['payment-service']).toBe('team-payments');
        expect(byService['pricing-service']).toBe('team-checkout');
    });

    it('backfills a missing team from a later row for the same service', () => {
        const consumers = dedupeCatalogConsumers([
            { service: 'orders', repo: 'shop', url: null, team: '' },
            { service: 'orders', repo: 'shop', url: null, team: 'team-orders' },
        ]);
        expect(consumers).toHaveLength(1);
        expect(consumers[0].team).toBe('team-orders');
    });

    it('skips rows with no service', () => {
        const consumers = dedupeCatalogConsumers([
            { service: '', repo: 'orphan', url: null, team: '' },
            { service: 'orders', repo: 'shop', url: null, team: 'team-orders' },
        ]);
        expect(consumers).toHaveLength(1);
        expect(consumers[0].service).toBe('orders');
    });
});

describe('reposFromConsumers', () => {
    it('collapses one monorepo to a single repo entry (first url wins)', () => {
        const consumers = dedupeCatalogConsumers(VALIDATE_PAYLOAD_ROWS);
        expect(reposFromConsumers(consumers)).toEqual([{ name: 'microservices', url: null }]);
    });

    it('preserves a non-null url over a later null for the same repo', () => {
        const repos = reposFromConsumers([
            { service: 'a', repo: 'shop', repoUrl: 'git@x/shop.git', team: 't' },
            { service: 'b', repo: 'shop', repoUrl: null, team: 't' },
        ]);
        expect(repos).toEqual([{ name: 'shop', url: 'git@x/shop.git' }]);
    });
});

describe('teamsFromConsumers', () => {
    it('returns distinct non-empty teams', () => {
        const consumers = dedupeCatalogConsumers(VALIDATE_PAYLOAD_ROWS);
        expect(teamsFromConsumers(consumers).sort()).toEqual(['team-checkout', 'team-payments']);
    });
});

describe('pickCatalogProvenance', () => {
    const NONE: RawCatalogProvenance = { source: null, url: null, type: null, installedAt: null, updatedAt: null };

    it('returns undefined when no copy carries a source', () => {
        expect(pickCatalogProvenance([NONE, NONE])).toBeUndefined();
        expect(pickCatalogProvenance([])).toBeUndefined();
    });

    it('picks the first copy that has a real source (provenance lives on the locked copy)', () => {
        const rows: RawCatalogProvenance[] = [
            NONE,
            { source: 'acme/agent-skills', url: 'https://github.com/acme/agent-skills', type: 'github', installedAt: '2026-05-10T08:00:00Z', updatedAt: '2026-05-20T14:30:00Z' },
        ];
        expect(pickCatalogProvenance(rows)).toEqual({
            source: 'acme/agent-skills',
            url: 'https://github.com/acme/agent-skills',
            type: 'github',
            installedAt: '2026-05-10T08:00:00Z',
            updatedAt: '2026-05-20T14:30:00Z',
        });
    });

    it('normalizes missing optional fields to null', () => {
        const rows: RawCatalogProvenance[] = [{ source: 'local-skill', url: null, type: 'local', installedAt: null, updatedAt: null }];
        expect(pickCatalogProvenance(rows)).toEqual({
            source: 'local-skill', url: null, type: 'local', installedAt: null, updatedAt: null,
        });
    });
});
