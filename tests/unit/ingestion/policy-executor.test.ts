import { describe, test, expect, vi, beforeEach } from 'vitest';
import { executeRules } from '../../../src/policy-runner/executor.js';
import type { PolicyRule } from '../../../src/policy-runner/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Policy Executor Tests
//
// Uses dependency injection (sandboxFn option) instead of vi.mock() to inject
// the mock sandbox. This avoids ESM static import binding issues with vitest
// and Zod v4 — no vi.mock() needed at all.
//
// The ExecutorOptions.sandboxFn option was added specifically for testability.
// In production, sandboxFn is undefined and the real runSandboxQuery is used.
//
// QUERY CONTRACT: every row must include `status: 'pass' | 'fail'`.
// Rows with status='fail' are violations, rows with status='pass' are compliant.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Mock sandbox function ────────────────────────────────────────────────────

const mockSandboxFn = vi.fn<Parameters<typeof import('../../../src/policy-runner/sandbox.js').runSandboxQuery>, ReturnType<typeof import('../../../src/policy-runner/sandbox.js').runSandboxQuery>>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
    return {
        id: 'gp-001-test',
        name: 'Test rule',
        level: 'error',
        scope: 'repository',
        failFast: false,
        tags: [],
        query: 'MATCH (r:Repository) RETURN r.id AS entityId, r.name AS entityName, "repository" AS entityType, "fail" AS status, "detail" AS detail',
        ...overrides,
    };
}

function makeRow(overrides: Record<string, string> = {}) {
    return {
        entityId:   'cr:repository:acme/my-repo',
        entityName: 'my-repo',
        entityType: 'repository',
        status:     'fail',
        detail:     'Missing target: run',
        ...overrides,
    };
}

/** Run with DI-injected mock */
function runWithMock(rules: PolicyRule[], opts: Record<string, unknown> = {}) {
    return executeRules(rules, { sandboxFn: mockSandboxFn as never, ...opts });
}

beforeEach(() => {
    mockSandboxFn.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeRules — happy path', () => {
    test('zero rows → ok=true, no evaluations', async () => {
        mockSandboxFn.mockResolvedValue({ rows: [], executionMs: 5 });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.ok).toBe(true);
        expect(result!.evaluations).toHaveLength(0);
        expect(result!.violations).toHaveLength(0);
        expect(result!.compliant).toHaveLength(0);
        expect(result!.executionMs).toBe(5);
    });

    test('one fail row → one violation with correct fields', async () => {
        mockSandboxFn.mockResolvedValue({ rows: [makeRow()], executionMs: 12 });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.ok).toBe(true);
        expect(result!.violations).toHaveLength(1);

        const v = result!.violations[0]!;
        expect(v.ruleId).toBe('gp-001-test');
        expect(v.level).toBe('error');
        expect(v.status).toBe('fail');
        expect(v.entityId).toBe('cr:repository:acme/my-repo');
        expect(v.entityName).toBe('my-repo');
        expect(v.entityType).toBe('repository');
        expect(v.detail).toBe('Missing target: run');
        expect(v.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('evaluation id is a stable URN', async () => {
        mockSandboxFn.mockResolvedValue({ rows: [makeRow()], executionMs: 1 });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.violations[0]!.id).toBe(
            'cr:eval:gp-001-test:cr:repository:acme/my-repo',
        );
    });

    test('one pass row → one compliant evaluation, zero violations', async () => {
        mockSandboxFn.mockResolvedValue({
            rows: [makeRow({ status: 'pass', detail: '' })],
            executionMs: 3,
        });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.evaluations).toHaveLength(1);
        expect(result!.violations).toHaveLength(0);
        expect(result!.compliant).toHaveLength(1);
        expect(result!.compliant[0]!.status).toBe('pass');
    });

    test('multiple rows → partitioned by status', async () => {
        mockSandboxFn.mockResolvedValue({
            rows: [
                makeRow({ entityId: 'cr:repository:acme/a', entityName: 'a', status: 'fail' }),
                makeRow({ entityId: 'cr:repository:acme/b', entityName: 'b', status: 'pass', detail: '' }),
            ],
            executionMs: 8,
        });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.evaluations).toHaveLength(2);
        expect(result!.violations).toHaveLength(1);
        expect(result!.compliant).toHaveLength(1);
    });

    test('multiple rules are all executed', async () => {
        mockSandboxFn.mockResolvedValue({ rows: [], executionMs: 1 });
        const rules = [makeRule({ id: 'r1' }), makeRule({ id: 'r2' }), makeRule({ id: 'r3' })];
        const results = await runWithMock(rules);
        expect(results).toHaveLength(3);
        expect(mockSandboxFn).toHaveBeenCalledTimes(3);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Invalid row shape — contract violation
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeRules — invalid row contract', () => {
    test('row missing entityId is skipped', async () => {
        mockSandboxFn.mockResolvedValue({
            rows: [{ entityName: 'repo', entityType: 'repository', status: 'fail', detail: 'x' }],
            executionMs: 1,
        });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.ok).toBe(true);
        expect(result!.evaluations).toHaveLength(0);
    });

    test('row missing status is skipped', async () => {
        mockSandboxFn.mockResolvedValue({
            rows: [{ entityId: 'cr:r:x', entityName: 'x', entityType: 'repository', detail: 'oops' }],
            executionMs: 1,
        });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.evaluations).toHaveLength(0);
    });

    test('row missing detail is skipped', async () => {
        mockSandboxFn.mockResolvedValue({
            rows: [{ entityId: 'cr:r:x', entityName: 'x', entityType: 'repository', status: 'fail' }],
            executionMs: 1,
        });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.evaluations).toHaveLength(0);
    });

    test('partially valid rows: valid passes, invalid skipped', async () => {
        mockSandboxFn.mockResolvedValue({
            rows: [
                makeRow({ entityId: 'cr:repository:good', entityName: 'good' }),
                { entityName: 'bad', entityType: 'x' },
            ],
            executionMs: 1,
        });
        const [result] = await runWithMock([makeRule()]);
        expect(result!.violations).toHaveLength(1);
        expect(result!.violations[0]!.entityName).toBe('good');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error isolation — sandbox failure
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeRules — sandbox errors', () => {
    test('timeout error → ok=false, other rules still run', async () => {
        mockSandboxFn
            .mockRejectedValueOnce(new Error('Query timed out after 5000ms'))
            .mockResolvedValueOnce({ rows: [], executionMs: 1 });

        const results = await runWithMock([makeRule({ id: 'r1' }), makeRule({ id: 'r2' })]);
        expect(results[0]!.ok).toBe(false);
        expect(results[0]!.error).toContain('timed out');
        expect(results[0]!.violations).toHaveLength(0);
        expect(results[1]!.ok).toBe(true);
    });

    test('failed rule reports executionMs=0', async () => {
        mockSandboxFn.mockRejectedValue(new Error('Connection refused'));
        const [result] = await runWithMock([makeRule()]);
        expect(result!.executionMs).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// failFast
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeRules — failFast', () => {
    test('failFast=true stops after first violating rule', async () => {
        mockSandboxFn.mockResolvedValue({ rows: [makeRow()], executionMs: 1 });
        const rules = [
            makeRule({ id: 'r1', failFast: true }),
            makeRule({ id: 'r2', failFast: false }),
        ];
        const results = await runWithMock(rules);
        expect(results).toHaveLength(1);
        expect(mockSandboxFn).toHaveBeenCalledTimes(1);
    });

    test('failFast=true does NOT stop when rule has zero violations', async () => {
        mockSandboxFn.mockResolvedValue({ rows: [], executionMs: 1 });
        const results = await runWithMock([
            makeRule({ id: 'r1', failFast: true }),
            makeRule({ id: 'r2' }),
        ]);
        expect(results).toHaveLength(2);
    });

    test('failFast=true does NOT stop when all rows pass', async () => {
        mockSandboxFn.mockResolvedValue({
            rows: [makeRow({ status: 'pass', detail: '' })],
            executionMs: 1,
        });
        const results = await runWithMock([
            makeRule({ id: 'r1', failFast: true }),
            makeRule({ id: 'r2' }),
        ]);
        expect(results).toHaveLength(2);
    });

    test('failFast=true does NOT stop when rule errors', async () => {
        mockSandboxFn.mockRejectedValueOnce(new Error('oops'));
        mockSandboxFn.mockResolvedValueOnce({ rows: [], executionMs: 1 });
        const results = await runWithMock([
            makeRule({ id: 'r1', failFast: true }),
            makeRule({ id: 'r2' }),
        ]);
        expect(results).toHaveLength(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// onRuleComplete callback
// ═══════════════════════════════════════════════════════════════════════════════

describe('executeRules — onRuleComplete callback', () => {
    test('called once per rule with correct result', async () => {
        mockSandboxFn.mockResolvedValue({ rows: [makeRow()], executionMs: 5 });
        const callback = vi.fn();
        await runWithMock([makeRule()], { onRuleComplete: callback });
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0]![0].rule.id).toBe('gp-001-test');
        expect(callback.mock.calls[0]![0].violations).toHaveLength(1);
    });

    test('called for each rule even when some fail', async () => {
        mockSandboxFn
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValueOnce({ rows: [], executionMs: 1 });
        const callback = vi.fn();
        await runWithMock([makeRule({ id: 'r1' }), makeRule({ id: 'r2' })], { onRuleComplete: callback });
        expect(callback).toHaveBeenCalledTimes(2);
    });
});
