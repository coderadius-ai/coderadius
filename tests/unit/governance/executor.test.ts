import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { executeRules, type ExecutorOptions } from '../../../src/policy-runner/executor.js';
import type { PolicyRule } from '../../../src/policy-runner/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
    return {
        id: 'cr-test-rule',
        name: 'Test Rule',
        description: 'A test rule',
        level: 'error',
        scope: 'repository',
        query: 'MATCH (r:Repository) RETURN r.id AS entityId',
        failFast: false,
        tags: ['test'],
        ...overrides,
    };
}

function makeSandboxFn(rows: Record<string, unknown>[]) {
    return vi.fn().mockResolvedValue({ rows, executionMs: 42 });
}

// ─── Partition by Status ──────────────────────────────────────────────────────

describe('PolicyExecutor — status partitioning', () => {
    beforeEach(() => vi.clearAllMocks());

    it('partitions rows into violations (fail) and compliant (pass)', async () => {
        const sandboxFn = makeSandboxFn([
            { entityId: 'cr:repo:a', entityName: 'repo-a', entityType: 'repository', status: 'pass', detail: '' },
            { entityId: 'cr:repo:b', entityName: 'repo-b', entityType: 'repository', status: 'fail', detail: 'Missing CI' },
            { entityId: 'cr:repo:c', entityName: 'repo-c', entityType: 'repository', status: 'pass', detail: '' },
        ]);

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        expect(results).toHaveLength(1);
        const r = results[0];
        expect(r.ok).toBe(true);
        expect(r.evaluations).toHaveLength(3);
        expect(r.violations).toHaveLength(1);
        expect(r.compliant).toHaveLength(2);
        expect(r.violations[0].entityName).toBe('repo-b');
        expect(r.violations[0].status).toBe('fail');
        expect(r.compliant[0].status).toBe('pass');
    });

    it('returns all pass when every entity is compliant', async () => {
        const sandboxFn = makeSandboxFn([
            { entityId: 'cr:repo:a', entityName: 'repo-a', entityType: 'repository', status: 'pass', detail: '' },
            { entityId: 'cr:repo:b', entityName: 'repo-b', entityType: 'repository', status: 'pass', detail: '' },
        ]);

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        expect(results[0].violations).toHaveLength(0);
        expect(results[0].compliant).toHaveLength(2);
    });

    it('returns all fail when every entity violates', async () => {
        const sandboxFn = makeSandboxFn([
            { entityId: 'cr:repo:a', entityName: 'repo-a', entityType: 'repository', status: 'fail', detail: 'Missing X' },
            { entityId: 'cr:repo:b', entityName: 'repo-b', entityType: 'repository', status: 'fail', detail: 'Missing Y' },
        ]);

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        expect(results[0].violations).toHaveLength(2);
        expect(results[0].compliant).toHaveLength(0);
    });

    it('returns empty evaluations when query returns zero rows', async () => {
        const sandboxFn = makeSandboxFn([]);

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        expect(results[0].evaluations).toHaveLength(0);
        expect(results[0].violations).toHaveLength(0);
        expect(results[0].compliant).toHaveLength(0);
        expect(results[0].ok).toBe(true);
    });
});

// ─── Evaluation ID ────────────────────────────────────────────────────────────

describe('PolicyExecutor — evaluation IDs', () => {
    beforeEach(() => vi.clearAllMocks());

    it('generates stable evaluation IDs from ruleId and entityId', async () => {
        const sandboxFn = makeSandboxFn([
            { entityId: 'cr:repo:abc', entityName: 'abc', entityType: 'repository', status: 'pass', detail: '' },
        ]);

        const results = await executeRules([makeRule({ id: 'cr-101' })], { sandboxFn } as ExecutorOptions);

        expect(results[0].evaluations[0].id).toBe('cr:eval:cr-101:cr:repo:abc');
    });

    it('propagates rule metadata to evaluation', async () => {
        const sandboxFn = makeSandboxFn([
            { entityId: 'cr:repo:x', entityName: 'x', entityType: 'repository', status: 'fail', detail: 'Oops' },
        ]);

        const results = await executeRules(
            [makeRule({ id: 'cr-201', name: 'TS strict', level: 'warning', scope: 'repository' })],
            { sandboxFn } as ExecutorOptions,
        );

        const e = results[0].evaluations[0];
        expect(e.ruleId).toBe('cr-201');
        expect(e.ruleName).toBe('TS strict');
        expect(e.level).toBe('warning');
        expect(e.scope).toBe('repository');
    });
});

// ─── Row Validation ───────────────────────────────────────────────────────────

describe('PolicyExecutor — row validation', () => {
    beforeEach(() => vi.clearAllMocks());

    it('skips rows missing required columns with a warning', async () => {
        const sandboxFn = makeSandboxFn([
            { entityId: 'cr:repo:a', entityName: 'a' }, // missing entityType, status, detail
            { entityId: 'cr:repo:b', entityName: 'b', entityType: 'repository', status: 'pass', detail: '' },
        ]);

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        expect(results[0].evaluations).toHaveLength(1);
        expect(results[0].evaluations[0].entityId).toBe('cr:repo:b');
    });

    it('rejects rows with invalid status value', async () => {
        const sandboxFn = makeSandboxFn([
            { entityId: 'cr:repo:a', entityName: 'a', entityType: 'repository', status: 'maybe', detail: 'hmm' },
        ]);

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        expect(results[0].evaluations).toHaveLength(0);
    });
});

// ─── Structured Detail ───────────────────────────────────────────────────────

describe('PolicyExecutor — structuredDetail', () => {
    beforeEach(() => vi.clearAllMocks());

    it('normalizes structuredDetail with checks and found arrays', async () => {
        const sandboxFn = makeSandboxFn([
            {
                entityId: 'cr:repo:a', entityName: 'a', entityType: 'repository',
                status: 'fail', detail: 'Missing targets',
                structuredDetail: {
                    checks: [
                        { label: 'setup', status: 'pass' },
                        { label: 'test', status: 'fail' },
                    ],
                    found: ['setup', 'build'],
                },
            },
        ]);

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        const e = results[0].evaluations[0];
        expect(e.structuredDetail).toBeDefined();
        const sd = JSON.parse(e.structuredDetail!);
        expect(sd.checks).toHaveLength(2);
        expect(sd.found).toEqual(['setup', 'build']);
    });

    it('degrades gracefully when structuredDetail is malformed', async () => {
        const sandboxFn = makeSandboxFn([
            {
                entityId: 'cr:repo:a', entityName: 'a', entityType: 'repository',
                status: 'fail', detail: 'Bad detail',
                structuredDetail: 'not-valid-json-object',
            },
        ]);

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        // Row is still valid — structuredDetail is dropped
        expect(results[0].evaluations).toHaveLength(1);
        expect(results[0].evaluations[0].structuredDetail).toBeUndefined();
    });
});

// ─── Error Handling ──────────────────────────────────────────────────────────

describe('PolicyExecutor — error handling', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns ok=false when query throws', async () => {
        const sandboxFn = vi.fn().mockRejectedValue(new Error('Cypher syntax error'));

        const results = await executeRules([makeRule()], { sandboxFn } as ExecutorOptions);

        expect(results[0].ok).toBe(false);
        expect(results[0].error).toContain('Cypher syntax error');
        expect(results[0].evaluations).toHaveLength(0);
    });

    it('continues executing remaining rules after one fails', async () => {
        const sandboxFn = vi.fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValueOnce({
                rows: [{ entityId: 'cr:repo:x', entityName: 'x', entityType: 'repository', status: 'pass', detail: '' }],
                executionMs: 10,
            });

        const results = await executeRules(
            [makeRule({ id: 'bad-rule' }), makeRule({ id: 'good-rule' })],
            { sandboxFn } as ExecutorOptions,
        );

        expect(results).toHaveLength(2);
        expect(results[0].ok).toBe(false);
        expect(results[1].ok).toBe(true);
        expect(results[1].evaluations).toHaveLength(1);
    });
});

// ─── failFast ─────────────────────────────────────────────────────────────────

describe('PolicyExecutor — failFast', () => {
    beforeEach(() => vi.clearAllMocks());

    it('stops after first rule with violations when failFast=true', async () => {
        const sandboxFn = vi.fn()
            .mockResolvedValueOnce({
                rows: [{ entityId: 'cr:repo:a', entityName: 'a', entityType: 'repository', status: 'fail', detail: 'X' }],
                executionMs: 10,
            })
            .mockResolvedValueOnce({
                rows: [{ entityId: 'cr:repo:b', entityName: 'b', entityType: 'repository', status: 'pass', detail: '' }],
                executionMs: 10,
            });

        const results = await executeRules(
            [makeRule({ id: 'first', failFast: true }), makeRule({ id: 'second' })],
            { sandboxFn } as ExecutorOptions,
        );

        // Second rule should NOT have been executed
        expect(results).toHaveLength(1);
        expect(sandboxFn).toHaveBeenCalledTimes(1);
    });

    it('does NOT stop when failFast rule has only passing evaluations', async () => {
        const sandboxFn = vi.fn()
            .mockResolvedValueOnce({
                rows: [{ entityId: 'cr:repo:a', entityName: 'a', entityType: 'repository', status: 'pass', detail: '' }],
                executionMs: 10,
            })
            .mockResolvedValueOnce({
                rows: [{ entityId: 'cr:repo:b', entityName: 'b', entityType: 'repository', status: 'pass', detail: '' }],
                executionMs: 10,
            });

        const results = await executeRules(
            [makeRule({ id: 'first', failFast: true }), makeRule({ id: 'second' })],
            { sandboxFn } as ExecutorOptions,
        );

        expect(results).toHaveLength(2);
        expect(sandboxFn).toHaveBeenCalledTimes(2);
    });
});

// ─── onRuleComplete callback ──────────────────────────────────────────────────

describe('PolicyExecutor — onRuleComplete callback', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls onRuleComplete after each rule', async () => {
        const sandboxFn = makeSandboxFn([
            { entityId: 'cr:repo:a', entityName: 'a', entityType: 'repository', status: 'pass', detail: '' },
        ]);

        const onRuleComplete = vi.fn();
        await executeRules([makeRule(), makeRule({ id: 'cr-second' })], { sandboxFn, onRuleComplete } as ExecutorOptions);

        expect(onRuleComplete).toHaveBeenCalledTimes(2);
    });
});
