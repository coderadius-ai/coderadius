import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═════════════════════════════════════════════════════════════════════════════
// Edge Reconciler — Unit Tests
//
// Tests the expectedEdges computation logic in reconcileEdges().
// The DB layer (_run) is mocked so these tests are fully in-process.
//
// Key regression: Process infrastructure must map to relType 'SPAWNS',
// not 'WRITES'. Before the fix, 'WRITES|cr:systemprocess:php' was added
// to expectedEdges but 'SPAWNS|cr:systemprocess:php' was in the DB →
// the edge was always tombstoned immediately after being written.
// ═════════════════════════════════════════════════════════════════════════════

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the graph run() layer before importing reconcileEdges
vi.mock('../../../../src/graph/mutations/_run', () => ({
    run: vi.fn(),
    groundingParams: () => ({}),
    groundingWriteClause: () => '',
}));

vi.mock('../../../../src/utils/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('../../../../src/telemetry/index', () => ({
    traceCollector: {
        tracePersist: vi.fn(),
    },
}));

import { run } from '../../../../src/graph/mutations/_run.js';
import { reconcileEdges } from '../../../../src/ingestion/processors/code-pipeline/edge-reconciler.js';
import { buildUrn } from '../../../../src/graph/urn.js';
import type { RepoHints } from '../../../../src/config/repo-hints.js';

const mockRun = vi.mocked(run);

const defaultRepoHints: RepoHints = {
    databases: [],
    decorators: [],
    hints: [],
    message_channels: { aliases: [] },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock analysis object with just infrastructure */
function makeAnalysis(infrastructure: Array<{
    name: string;
    type: string;
    operation: string;
    isDiKey?: boolean;
    channelKind?: string;
}>) {
    return {
        has_io: true,
        intent: 'test',
        infrastructure: infrastructure as any,
        capabilities: [],
        emergent_api_calls: [],
    };
}

/** Build a mock DB record set that simulates existing graph edges */
function mockExistingEdges(edges: Array<{ relType: string; targetId: string }>) {
    mockRun.mockResolvedValueOnce({
        records: edges.map(e => ({
            get: (key: string) => key === 'relType' ? e.relType : e.targetId,
        })),
    } as any);
    // Second call is the soft-delete UNWIND (only called if staleEdges > 0)
    mockRun.mockResolvedValue({ records: [] } as any);
}

/** Capture the staleEdges parameter passed to the soft-delete run() call */
function capturedStaleEdges(): Array<{ relType: string; targetId: string }> {
    // The second call to run() is the UNWIND soft-delete with $staleEdges
    const calls = mockRun.mock.calls;
    if (calls.length < 2) return [];
    const params = calls[1][1] as any;
    return params?.staleEdges ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// Process Infrastructure → SPAWNS
// ═════════════════════════════════════════════════════════════════════════════

describe('reconcileEdges — Process infrastructure maps to SPAWNS', () => {
    it('should NOT soft-delete a SPAWNS edge when Process infra is present (regression guard)', async () => {
        const processUrn = buildUrn('systemprocess', 'php');

        // Simulate DB: SPAWNS edge exists from a previous ingestion
        mockExistingEdges([{ relType: 'SPAWNS', targetId: processUrn }]);

        await reconcileEdges(
            'cr:function:test:php:MyClass.myMethod',
            makeAnalysis([{ name: 'php', type: 'Process', operation: 'WRITES' }]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        // Only ONE run() call (the SELECT). No second call means no soft-delete.
        expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('should soft-delete a SPAWNS edge when Process infra is no longer present', async () => {
        const processUrn = buildUrn('systemprocess', 'php');

        // DB has SPAWNS edge but analysis has NO infra
        mockExistingEdges([{ relType: 'SPAWNS', targetId: processUrn }]);

        await reconcileEdges(
            'cr:function:test:php:MyClass.myMethod',
            makeAnalysis([]),  // no infrastructure at all
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        // Two run() calls: SELECT + soft-delete UNWIND
        expect(mockRun).toHaveBeenCalledTimes(2);
        const stale = capturedStaleEdges();
        expect(stale).toHaveLength(1);
        expect(stale[0].relType).toBe('SPAWNS');
        expect(stale[0].targetId).toBe(processUrn);
    });

    it('should add SPAWNS (not WRITES) to expectedEdges for Process with operation=WRITES', async () => {
        const processUrn = buildUrn('systemprocess', 'php');

        // DB is clean (no existing SPAWNS edge)
        mockExistingEdges([]);

        await reconcileEdges(
            'cr:function:test:php:MyClass.myMethod',
            makeAnalysis([{ name: 'php', type: 'Process', operation: 'WRITES' }]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        // Only SELECT call — nothing to delete
        expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple Process nodes without false positives', async () => {
        const phpUrn = buildUrn('systemprocess', 'php');
        const psUrn  = buildUrn('systemprocess', 'ps');

        // Both SPAWNS edges exist in DB
        mockExistingEdges([
            { relType: 'SPAWNS', targetId: phpUrn },
            { relType: 'SPAWNS', targetId: psUrn },
        ]);

        await reconcileEdges(
            'cr:function:test:php:MyClass.myMethod',
            makeAnalysis([
                { name: 'php', type: 'Process', operation: 'WRITES' },
                { name: 'ps',  type: 'Process', operation: 'READS' },
            ]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        // No stale edges → only SELECT
        expect(mockRun).toHaveBeenCalledTimes(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// MessageChannel → PUBLISHES_TO / LISTENS_TO
// ═════════════════════════════════════════════════════════════════════════════

describe('reconcileEdges — MessageChannel relType mapping', () => {
    it('should map MessageChannel WRITES → PUBLISHES_TO in expectedEdges', async () => {
        const channelUrn = buildUrn('channel', 'topic', 'order.created');

        // DB has PUBLISHES_TO edge
        mockExistingEdges([{ relType: 'PUBLISHES_TO', targetId: channelUrn }]);

        await reconcileEdges(
            'cr:function:test:ts:OrderService.create',
            makeAnalysis([{ name: 'order.created', type: 'MessageChannel', operation: 'WRITES' }]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        expect(mockRun).toHaveBeenCalledTimes(1); // no soft-delete
    });

    it('should map MessageChannel READS → LISTENS_TO in expectedEdges', async () => {
        const channelUrn = buildUrn('channel', 'topic', 'order.created');

        // DB has LISTENS_TO edge
        mockExistingEdges([{ relType: 'LISTENS_TO', targetId: channelUrn }]);

        await reconcileEdges(
            'cr:function:test:ts:OrderConsumer.handle',
            makeAnalysis([{ name: 'order.created', type: 'MessageChannel', operation: 'READS' }]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        expect(mockRun).toHaveBeenCalledTimes(1); // no soft-delete
    });

    it('should soft-delete a stale PUBLISHES_TO edge when broker is removed', async () => {
        const channelUrn = buildUrn('channel', 'order.created');

        mockExistingEdges([{ relType: 'PUBLISHES_TO', targetId: channelUrn }]);

        await reconcileEdges(
            'cr:function:test:ts:OrderService.create',
            makeAnalysis([]), // broker removed
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        expect(mockRun).toHaveBeenCalledTimes(2);
        const stale = capturedStaleEdges();
        expect(stale[0].relType).toBe('PUBLISHES_TO');
    });

    it('should use kinded URNs for MessageChannel topics when channelKind is present', async () => {
        const channelUrn = buildUrn('channel', 'topic', 'order.created');

        mockExistingEdges([{ relType: 'PUBLISHES_TO', targetId: channelUrn }]);

        await reconcileEdges(
            'cr:function:test:ts:OrderService.create',
            makeAnalysis([{ name: 'order.created', type: 'MessageChannel', operation: 'WRITES', channelKind: 'topic' }]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );

        expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('should resolve message channel aliases before comparing expected edges', async () => {
        const physicalTopicUrn = buildUrn('channel', 'topic', 'Platform-SampleUser');
        const repoHints: RepoHints = {
            ...defaultRepoHints,
            message_channels: {
                aliases: [{
                    from: 'data_backbone.topics.sample_user',
                    name: 'Platform-SampleUser',
                    channelKind: 'topic',
                    technology: 'pubsub',
                }],
            },
        };

        mockExistingEdges([{ relType: 'PUBLISHES_TO', targetId: physicalTopicUrn }]);

        await reconcileEdges(
            'cr:function:test:php:PublishSampleUser',
            makeAnalysis([{ name: 'data_backbone.topics.sample_user', type: 'MessageChannel', operation: 'WRITES' }]),
            'org/repo',
            'abc123',
            repoHints,
        );

        expect(mockRun).toHaveBeenCalledTimes(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Database → READS / WRITES passthrough
// ═════════════════════════════════════════════════════════════════════════════

describe('reconcileEdges — Database relType passthrough', () => {
    it('should NOT soft-delete a READS edge when Database READS infra is present', async () => {
        const tableUrn = buildUrn('datacontainer', 'org/repo', 'users');

        mockExistingEdges([{ relType: 'READS', targetId: tableUrn }]);

        await reconcileEdges(
            'cr:function:test:ts:UserRepo.find',
            makeAnalysis([{ name: 'users', type: 'Database', operation: 'READS' }]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        expect(mockRun).toHaveBeenCalledTimes(1); // no soft-delete
    });

    it('should NOT soft-delete a WRITES edge when Database WRITES infra is present', async () => {
        const tableUrn = buildUrn('datacontainer', 'org/repo', 'orders');

        mockExistingEdges([{ relType: 'WRITES', targetId: tableUrn }]);

        await reconcileEdges(
            'cr:function:test:ts:OrderRepo.save',
            makeAnalysis([{ name: 'orders', type: 'Database', operation: 'WRITES' }]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        expect(mockRun).toHaveBeenCalledTimes(1); // no soft-delete
    });

    it('should preserve CONNECTS_TO edges created by deterministic resource declarations', async () => {
        const datastoreUrn = buildUrn('datastore', 'org/repo', 'motor');

        mockExistingEdges([{ relType: 'CONNECTS_TO', targetId: datastoreUrn }]);

        await reconcileEdges(
            'cr:function:test:ts:DatabaseModule.useFactory',
            makeAnalysis([]),
            'org/repo',
            'abc123',
            defaultRepoHints,
            [{
                kind: 'datastore',
                logicalId: 'motor',
                technology: 'mysql',
                declarationSource: 'nestjs-for-root',
            }],
        );

        expect(mockRun).toHaveBeenCalledTimes(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// IMPLEMENTS_ENDPOINT canonical protection
// ═════════════════════════════════════════════════════════════════════════════

describe('reconcileEdges — canonical IMPLEMENTS_ENDPOINT is protected', () => {
    it('should NOT soft-delete a canonical IMPLEMENTS_ENDPOINT (matchmaking-wired)', async () => {
        // Canonical (non-emergent) endpoint — wired by matchmaking, not LLM
        const canonicalEndpointUrn = buildUrn('endpoint', 'cr', 'api', 'GET', '/users/{id}');

        mockExistingEdges([{ relType: 'IMPLEMENTS_ENDPOINT', targetId: canonicalEndpointUrn }]);

        // Analysis has no emergent_api_calls → LLM didn't reproduce this edge
        await reconcileEdges(
            'cr:function:test:ts:UserController.get',
            makeAnalysis([]),
            'org/repo',
            'abc123',
            defaultRepoHints,
        );
        // No soft-delete — canonical endpoints are protected
        expect(mockRun).toHaveBeenCalledTimes(1);
    });
});
