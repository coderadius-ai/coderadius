import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/graph/neo4j.js', () => ({
    getMemgraphSession: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { getMemgraphSession } from '../../../src/graph/neo4j.js';
import {
    resolveWeldedDataContainerUrns,
    rewireEphemeralEdgesToWeldedTargets,
} from '../../../src/eval/ephemeral-weld-resolver.js';
import type { FileTopologySnapshot } from '../../../src/eval/types.js';

const mockSession = { run: vi.fn(), close: vi.fn() };
const mockGetSession = getMemgraphSession as ReturnType<typeof vi.fn>;

function makeRecord(data: Record<string, unknown>) {
    return { get: (key: string) => data[key] ?? null };
}

const LOSER_URN = 'cr:datacontainer:local/orders:orders';
const WINNER_URN = 'cr:datacontainer:acme/orders-core:orders';

function makeOrmSnapshot(): FileTopologySnapshot {
    return {
        filePath: 'src/Entity/Order.php',
        edges: [{
            sourceId: 'cr:function:local/orders:php:Acme\\Entity\\Order::__class_metadata',
            sourceName: 'Acme\\Entity\\Order::__class_metadata',
            targetId: LOSER_URN,
            targetName: 'orders',
            relType: 'MAPS_TO',
            sourceFile: 'src/Entity/Order.php',
            targetType: 'DataContainer',
        }],
        nodes: [{
            id: LOSER_URN,
            type: 'DataContainer',
            name: 'orders',
            sourceFile: 'src/Entity/Order.php',
        }],
    };
}

// ─── resolveWeldedDataContainerUrns ───────────────────────────────────────────

describe('resolveWeldedDataContainerUrns', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSession.mockReturnValue(mockSession);
        mockSession.close.mockResolvedValue(undefined);
    });

    it('returns empty map for empty input without hitting the DB', async () => {
        const result = await resolveWeldedDataContainerUrns([]);
        expect(result.size).toBe(0);
        expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('maps loser URN to winner URN/name from welder records', async () => {
        mockSession.run.mockResolvedValue({
            records: [makeRecord({
                loserUrn: LOSER_URN,
                winnerUrn: WINNER_URN,
                winnerName: 'orders',
            })],
        });

        const result = await resolveWeldedDataContainerUrns([LOSER_URN]);

        expect(result.size).toBe(1);
        expect(result.get(LOSER_URN)).toEqual({ urn: WINNER_URN, name: 'orders' });
    });

    it('always closes the session even when the query throws', async () => {
        mockSession.run.mockRejectedValue(new Error('connection refused'));
        await expect(resolveWeldedDataContainerUrns([LOSER_URN])).rejects.toThrow('connection refused');
        expect(mockSession.close).toHaveBeenCalledTimes(1);
    });
});

// ─── rewireEphemeralEdgesToWeldedTargets ──────────────────────────────────────

describe('rewireEphemeralEdgesToWeldedTargets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSession.mockReturnValue(mockSession);
        mockSession.close.mockResolvedValue(undefined);
    });

    it('skips the lookup when no DataContainer edges are present', async () => {
        const snapshots = new Map<string, FileTopologySnapshot>([
            ['src/A.ts', { filePath: 'src/A.ts', edges: [], nodes: [] }],
        ]);
        await rewireEphemeralEdgesToWeldedTargets(snapshots);
        expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('rewires loser-scope edge and node to the welder winner', async () => {
        mockSession.run.mockResolvedValue({
            records: [makeRecord({ loserUrn: LOSER_URN, winnerUrn: WINNER_URN, winnerName: 'orders' })],
        });
        const snapshots = new Map([['src/Entity/Order.php', makeOrmSnapshot()]]);

        await rewireEphemeralEdgesToWeldedTargets(snapshots);

        const snap = snapshots.get('src/Entity/Order.php')!;
        expect(snap.edges[0].targetId).toBe(WINNER_URN);
        expect(snap.edges[0].targetName).toBe('orders');
        expect(snap.nodes[0].id).toBe(WINNER_URN);
        expect(snap.nodes[0].name).toBe('orders');
    });

    it('leaves edges untouched when the URN is not welded', async () => {
        mockSession.run.mockResolvedValue({ records: [] });
        const snapshots = new Map([['src/Entity/Order.php', makeOrmSnapshot()]]);

        await rewireEphemeralEdgesToWeldedTargets(snapshots);

        const snap = snapshots.get('src/Entity/Order.php')!;
        expect(snap.edges[0].targetId).toBe(LOSER_URN);
        expect(snap.nodes[0].id).toBe(LOSER_URN);
    });

    it('swallows session errors so blast does not crash on DB hiccups', async () => {
        mockSession.run.mockRejectedValue(new Error('connection refused'));
        const snapshots = new Map([['src/Entity/Order.php', makeOrmSnapshot()]]);

        await expect(rewireEphemeralEdgesToWeldedTargets(snapshots)).resolves.toBeUndefined();

        const snap = snapshots.get('src/Entity/Order.php')!;
        expect(snap.edges[0].targetId).toBe(LOSER_URN);
    });

    it('ignores non-DataContainer edges (different welder governs other types)', async () => {
        // Even if a query returns a winner for some URN, only DataContainer
        // edges should ever be rewired. Edges to MessageChannel/APIEndpoint
        // belong to other welders not exercised by this resolver.
        mockSession.run.mockResolvedValue({
            records: [makeRecord({ loserUrn: 'cr:channel:topic:notifications', winnerUrn: 'cr:channel:topic:notifications@abc', winnerName: 'notifications' })],
        });
        const snapshots = new Map<string, FileTopologySnapshot>([['src/A.ts', {
            filePath: 'src/A.ts',
            edges: [{
                sourceId: 'cr:function:A',
                sourceName: 'A',
                targetId: 'cr:channel:topic:notifications',
                targetName: 'notifications',
                relType: 'PUBLISHES_TO',
                sourceFile: 'src/A.ts',
                targetType: 'MessageChannel',
            }],
            nodes: [],
        }]]);

        await rewireEphemeralEdgesToWeldedTargets(snapshots);

        // Lookup was skipped because no DataContainer edges are present.
        expect(mockSession.run).not.toHaveBeenCalled();
        expect(snapshots.get('src/A.ts')!.edges[0].targetId).toBe('cr:channel:topic:notifications');
    });
});
