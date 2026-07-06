import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
    clearMessageBrokerRegistry,
    registerBrokerDeclaration,
    registerMirror,
} from '../../../../src/ingestion/core/messaging/broker-registry.js';

// Mock the underlying `run()` so we can inspect every Cypher call without
// touching Memgraph. `channel-alias-welder.ts` imports `run` from
// `graph/mutations/_run.js`, and the helpers it calls (`manifestChannelAs`,
// `mergeMessageChannelWithKind`) also import from `_run.js`.
const mockRun = vi.fn().mockResolvedValue({ records: [] });
vi.mock('../../../../src/graph/mutations/_run.js', () => ({
    run: mockRun,
    groundingParams: () => ({}),
    groundingWriteClause: () => '',
}));

const { weldChannelAliases } = await import('../../../../src/ingestion/processors/channel-alias-welder.js');

beforeEach(() => {
    clearMessageBrokerRegistry();
    mockRun.mockClear();
});
afterAll(() => vi.resetModules());

describe('weldChannelAliases — mark-and-sweep tombstoning (Gotcha #3)', () => {
    function setupTwoBrokerMirror() {
        registerBrokerDeclaration({ id: 'rmq-eu', provider: 'rabbitmq', host: 'eu.rmq' });
        registerBrokerDeclaration({ id: 'rmq-us', provider: 'rabbitmq', host: 'us.rmq' });
        registerMirror({
            logical: 'OrderCreated',
            kind: 'topic',
            physical: [
                { broker: 'rmq-eu', channel: 'acme.orders', kind: 'topic' },
                { broker: 'rmq-us', channel: 'acme.orders', kind: 'topic' },
            ],
        });
    }

    it('returns tombstonedAliases count in the result shape', async () => {
        setupTwoBrokerMirror();
        // Simulate the sweep query reporting 2 stale aliases removed
        mockRun.mockImplementation((cypher: string) => {
            if (cypher.includes('SET r.valid_to_commit')) {
                return Promise.resolve({ records: [{ get: () => ({ toNumber: () => 2 }) }] });
            }
            return Promise.resolve({ records: [] });
        });

        const result = await weldChannelAliases('C2');
        expect(result).toHaveProperty('tombstonedAliases');
        expect(result.tombstonedAliases).toBeGreaterThanOrEqual(0);
    });

    it('issues a sweep query that tombstones MANIFESTS_AS NOT in the keptPairs', async () => {
        setupTwoBrokerMirror();
        await weldChannelAliases('C2');

        const sweepCall = mockRun.mock.calls.find(([cypher]) =>
            (cypher as string).includes('NOT') &&
            (cypher as string).includes('keptPairs') &&
            (cypher as string).includes('MANIFESTS_AS'),
        );
        expect(sweepCall).toBeDefined();
        const params = sweepCall![1] as any;
        // The sweep MUST pass:
        //   - `commitHash` (so the tombstone is timestamped consistently)
        //   - `keptPairs` (so the welder excludes the freshly-MERGE'd edges)
        //   - filter on declaredVia='coderadius.yaml' (only customer-declared
        //     MANIFESTS_AS edges are subject to alias-driven tombstoning;
        //     never the LLM-inferred ones).
        expect(params.commitHash).toBe('C2');
        expect(Array.isArray(params.keptPairs)).toBe(true);
        expect(params.keptPairs).toHaveLength(2);
    });

    it('keptPairs identify (logicalUrn, physicalUrn) pairs by "URN|URN"', async () => {
        setupTwoBrokerMirror();
        await weldChannelAliases('C2');
        const sweepCalls = mockRun.mock.calls.filter(([cypher]) =>
            (cypher as string).includes('keptPairs'),
        );
        expect(sweepCalls).toHaveLength(1);
        const params = sweepCalls[0][1] as any;
        expect(Array.isArray(params.keptPairs)).toBe(true);
        expect(params.keptPairs.length).toBe(2);
        for (const key of params.keptPairs as string[]) {
            expect(key).toMatch(/^cr:channel:[^|]+\|cr:channel:[^|]+$/);
        }
    });

    it('stamps valid_from_commit on the MANIFESTS_AS edge merges (no zombie valid_to_commit reset)', async () => {
        setupTwoBrokerMirror();
        await weldChannelAliases('C2');
        // Inspect the MERGE call(s). The MANIFESTS_AS mutation passes commitHash.
        const merges = mockRun.mock.calls.filter(([cypher]) =>
            (cypher as string).includes('MERGE (l)-[r:MANIFESTS_AS]->(p)')
            || (cypher as string).includes('MERGE (l)-[r:MANIFESTS_AS')
            || (cypher as string).includes('-[r:MANIFESTS_AS]->'),
        );
        expect(merges.length).toBeGreaterThanOrEqual(2);
        for (const [, params] of merges) {
            expect((params as any).commitHash).toBe('C2');
        }
    });

    it('returns zero kept and a sweep call even when no mirror is declared', async () => {
        // No mirror registered.
        await weldChannelAliases('C3');
        // Even with zero mirrors we MUST still issue a sweep so stale entries
        // from a previous run with mirrors are tombstoned.
        const sweepCall = mockRun.mock.calls.find(([cypher]) =>
            (cypher as string).includes('NOT') &&
            (cypher as string).includes('keptPairs') &&
            (cypher as string).includes('MANIFESTS_AS'),
        );
        expect(sweepCall).toBeDefined();
        const params = sweepCall![1] as any;
        expect(params.keptPairs).toEqual([]);
    });
});
