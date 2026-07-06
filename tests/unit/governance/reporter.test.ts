import { describe, it, expect } from 'vitest';

import { buildReport } from '../../../src/policy-runner/reporter.js';
import type { PolicyRuleResult, PolicyEvaluation, PolicyRule } from '../../../src/policy-runner/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
    return {
        id: 'cr-test',
        name: 'Test Rule',
        level: 'error',
        scope: 'repository',
        query: 'MATCH ...',
        failFast: false,
        tags: [],
        ...overrides,
    };
}

function makeEvaluation(overrides: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
    return {
        id: 'cr:eval:test:entity',
        ruleId: 'cr-test',
        ruleName: 'Test Rule',
        level: 'error',
        scope: 'repository',
        status: 'pass',
        entityId: 'cr:repo:test',
        entityName: 'test-repo',
        entityType: 'repository',
        detail: '',
        evaluatedAt: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

function makeResult(overrides: Partial<PolicyRuleResult> & { evaluations?: PolicyEvaluation[] } = {}): PolicyRuleResult {
    const evaluations = overrides.evaluations ?? [];
    return {
        rule: overrides.rule ?? makeRule(),
        evaluations,
        violations: evaluations.filter(e => e.status === 'fail'),
        compliant: evaluations.filter(e => e.status === 'pass'),
        ok: overrides.ok ?? true,
        error: overrides.error,
        executionMs: overrides.executionMs ?? 42,
    };
}

// ─── buildReport — Compliance Metrics ─────────────────────────────────────────

describe('buildReport — compliance metrics', () => {
    it('computes 100% compliance when all evaluations pass', () => {
        const result = makeResult({
            evaluations: [
                makeEvaluation({ entityId: 'cr:repo:a', status: 'pass' }),
                makeEvaluation({ entityId: 'cr:repo:b', status: 'pass' }),
            ],
        });

        const report = buildReport([result]);

        expect(report.totalEvaluated).toBe(2);
        expect(report.totalCompliant).toBe(2);
        expect(report.compliancePct).toBe(100);
        expect(report.totalViolations).toBe(0);
    });

    it('computes 0% compliance when all evaluations fail', () => {
        const result = makeResult({
            evaluations: [
                makeEvaluation({ entityId: 'cr:repo:a', status: 'fail', detail: 'X' }),
                makeEvaluation({ entityId: 'cr:repo:b', status: 'fail', detail: 'Y' }),
            ],
        });

        const report = buildReport([result]);

        expect(report.totalEvaluated).toBe(2);
        expect(report.totalCompliant).toBe(0);
        expect(report.compliancePct).toBe(0);
        expect(report.totalViolations).toBe(2);
    });

    it('computes partial compliance correctly', () => {
        const result = makeResult({
            evaluations: [
                makeEvaluation({ entityId: 'cr:repo:a', status: 'pass' }),
                makeEvaluation({ entityId: 'cr:repo:b', status: 'fail', detail: 'X' }),
                makeEvaluation({ entityId: 'cr:repo:c', status: 'pass' }),
            ],
        });

        const report = buildReport([result]);

        expect(report.totalEvaluated).toBe(3);
        expect(report.totalCompliant).toBe(2);
        expect(report.compliancePct).toBe(67); // Math.round(2/3 * 100)
    });

    it('deduplicates entities across multiple rules for global compliance', () => {
        const rule1 = makeResult({
            rule: makeRule({ id: 'cr-101' }),
            evaluations: [
                makeEvaluation({ ruleId: 'cr-101', entityId: 'cr:repo:a', status: 'pass' }),
                makeEvaluation({ ruleId: 'cr-101', entityId: 'cr:repo:b', status: 'fail', detail: 'X' }),
            ],
        });
        const rule2 = makeResult({
            rule: makeRule({ id: 'cr-201' }),
            evaluations: [
                makeEvaluation({ ruleId: 'cr-201', entityId: 'cr:repo:a', status: 'pass' }),
                makeEvaluation({ ruleId: 'cr-201', entityId: 'cr:repo:b', status: 'pass' }),
            ],
        });

        const report = buildReport([rule1, rule2]);

        // 2 unique entities: a passes both rules, b fails rule1
        expect(report.totalEvaluated).toBe(2);
        expect(report.totalCompliant).toBe(1); // only 'a' is fully compliant
        expect(report.compliancePct).toBe(50);
    });

    it('handles empty results', () => {
        const report = buildReport([]);

        expect(report.rulesRun).toBe(0);
        expect(report.totalEvaluated).toBe(0);
        expect(report.totalCompliant).toBe(0);
        expect(report.compliancePct).toBe(0);
        expect(report.totalViolations).toBe(0);
    });
});

// ─── buildReport — Severity Breakdown ────────────────────────────────────────

describe('buildReport — severity breakdown', () => {
    it('counts violations by severity', () => {
        const results = [
            makeResult({
                rule: makeRule({ id: 'cr-err', level: 'error' }),
                evaluations: [
                    makeEvaluation({ level: 'error', status: 'fail', detail: 'E1' }),
                    makeEvaluation({ level: 'error', status: 'fail', detail: 'E2', entityId: 'cr:repo:b' }),
                ],
            }),
            makeResult({
                rule: makeRule({ id: 'cr-warn', level: 'warning' }),
                evaluations: [
                    makeEvaluation({ level: 'warning', status: 'fail', detail: 'W1', entityId: 'cr:repo:c' }),
                ],
            }),
            makeResult({
                rule: makeRule({ id: 'cr-info', level: 'note' }),
                evaluations: [
                    makeEvaluation({ level: 'note', status: 'pass', entityId: 'cr:repo:d' }),
                ],
            }),
        ];

        const report = buildReport(results);

        expect(report.errorViolations).toBe(2);
        expect(report.warningViolations).toBe(1);
        expect(report.noteViolations).toBe(0);
        expect(report.totalViolations).toBe(3);
    });
});

// ─── buildReport — Rule Counters ─────────────────────────────────────────────

describe('buildReport — rule counters', () => {
    it('counts rulesOk and rulesFailed', () => {
        const results = [
            makeResult({ ok: true }),
            makeResult({ ok: false, error: 'timeout' }),
            makeResult({ ok: true }),
        ];

        const report = buildReport(results);

        expect(report.rulesRun).toBe(3);
        expect(report.rulesOk).toBe(2);
        expect(report.rulesFailed).toBe(1);
    });

    it('does not count failed rules toward violations', () => {
        const results = [
            makeResult({
                ok: false,
                error: 'boom',
                evaluations: [], // no evaluations because query failed
            }),
        ];

        const report = buildReport(results);

        expect(report.totalViolations).toBe(0);
        expect(report.totalEvaluated).toBe(0);
    });
});
