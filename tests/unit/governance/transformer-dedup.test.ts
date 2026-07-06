import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock neo4j driver to test the dedup logic in getGovernanceReport
vi.mock('../../../src/graph/neo4j.js', () => ({
    getMemgraphDriver: vi.fn(),
}));

import { getMemgraphDriver } from '../../../src/graph/neo4j.js';
const mockGetDriver = getMemgraphDriver as ReturnType<typeof vi.fn>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(fields: Record<string, unknown>) {
    return {
        get: (key: string) => fields[key] ?? null,
    };
}

function makeEvalRecord(overrides: Record<string, unknown> = {}) {
    return makeRecord({
        id: 'cr:eval:cr-103:cr:repo:my-repo',
        ruleId: 'cr-103-mr-pipeline',
        ruleName: 'CI pipeline active on Merge Requests',
        severity: 'error',
        scope: 'repository',
        status: 'fail',
        entityId: 'cr:repo:my-repo',
        entityName: 'my-repo',
        entityType: 'repository',
        entityUrl: null,
        teamOwner: 'platform-team',
        detail: 'No CI pipeline detected',
        evaluatedAt: '2026-01-01T00:00:00Z',
        structuredDetail: null,
        ...overrides,
    });
}

function setupMockSession(records: ReturnType<typeof makeRecord>[]) {
    const mockSession = {
        run: vi.fn().mockResolvedValue({ records }),
        close: vi.fn(),
    };
    mockGetDriver.mockReturnValue({ session: () => mockSession });
    return mockSession;
}

// ─── Deduplication Tests ─────────────────────────────────────────────────────

describe('getGovernanceReport — deduplication', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deduplicates evaluations that share the same pe.id (Cartesian product fix)', async () => {
        // Simulate the Cartesian product bug: Cypher returns 7 identical rows
        // for the same PolicyEvaluation because of OPTIONAL MATCH on team ownership
        // across 7 services stored in the same repo.
        const duplicatedRecord = makeEvalRecord();
        setupMockSession([
            duplicatedRecord, duplicatedRecord, duplicatedRecord,
            duplicatedRecord, duplicatedRecord, duplicatedRecord, duplicatedRecord,
        ]);

        const { getGovernanceReport } = await import('../../../src/graph/queries/governance.js');
        const report = await getGovernanceReport();

        expect(report).not.toBeNull();
        expect(report!.ruleBreakdown).toHaveLength(1);

        const rule = report!.ruleBreakdown[0]!;
        // Should have exactly 1 evaluation, not 7
        expect(rule.evaluations).toHaveLength(1);
        expect(rule.violations).toHaveLength(1);
    });

    it('preserves distinct evaluations with different IDs', async () => {
        setupMockSession([
            makeEvalRecord({ id: 'cr:eval:cr-103:cr:repo:repo-a', entityId: 'cr:repo:repo-a', entityName: 'repo-a' }),
            makeEvalRecord({ id: 'cr:eval:cr-103:cr:repo:repo-b', entityId: 'cr:repo:repo-b', entityName: 'repo-b' }),
            makeEvalRecord({ id: 'cr:eval:cr-301:cr:repo:repo-a', ruleId: 'cr-301', entityId: 'cr:repo:repo-a', entityName: 'repo-a', status: 'pass', detail: '' }),
        ]);

        const { getGovernanceReport } = await import('../../../src/graph/queries/governance.js');
        const report = await getGovernanceReport();

        expect(report).not.toBeNull();
        // 2 rules: cr-103 (2 evals) + cr-301 (1 eval)
        const totalEvals = report!.ruleBreakdown.reduce((sum, r) => sum + r.evaluations.length, 0);
        expect(totalEvals).toBe(3);
    });

    it('deduplicates mixed: keeps 1 of each unique ID even when duplicates are interleaved', async () => {
        const evalA = makeEvalRecord({ id: 'cr:eval:cr-103:cr:repo:a', entityId: 'cr:repo:a', entityName: 'a' });
        const evalB = makeEvalRecord({ id: 'cr:eval:cr-103:cr:repo:b', entityId: 'cr:repo:b', entityName: 'b' });

        // Interleaved duplicates: A, B, A, B, A
        setupMockSession([evalA, evalB, evalA, evalB, evalA]);

        const { getGovernanceReport } = await import('../../../src/graph/queries/governance.js');
        const report = await getGovernanceReport();

        expect(report).not.toBeNull();
        const rule = report!.ruleBreakdown[0]!;
        expect(rule.evaluations).toHaveLength(2); // a + b, not 5
    });
});
