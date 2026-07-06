import { describe, expect, it } from 'vitest';
import { computeFleetReadiness } from '../../../packages/dashboard-ui/src/components/agent-harness/readiness.model';
import type { GovernanceReport, AgentHarnessReport, GovernanceEvaluation, GovernanceRuleResult } from '@coderadius/shared-types';

function createMockReport(
    rules: { id: string; name: string; level: 'error' | 'warning' | 'note'; status: 'pass' | 'fail' }[]
): { governance: GovernanceReport; radar: AgentHarnessReport } {
    const ruleCatalog = rules.map(r => ({
        id: r.id,
        name: r.name,
        description: `Description for ${r.id}`,
        level: r.level,
        scope: 'repository',
        tags: ['agent-readiness'],
        lastEvaluatedAt: '2026-01-01',
        evaluatedCount: 1,
        compliantCount: r.status === 'pass' ? 1 : 0,
        violationCount: r.status === 'fail' ? 1 : 0,
        ok: true,
        error: null,
        query: '',
    }));

    const ruleBreakdown: GovernanceRuleResult[] = rules.map(r => ({
        ruleId: r.id,
        ruleName: r.name,
        level: r.level,
        scope: 'repository',
        evaluations: [{
            id: `eval:${r.id}:repo1`,
            ruleId: r.id,
            ruleName: r.name,
            level: r.level,
            scope: 'repository',
            status: r.status,
            entityId: 'repo1',
            entityName: 'test-repo',
            entityType: 'Repository',
            entityUrl: 'https://github.com/org/test-repo',
            teamOwner: 'team-a',
            livenessCommits: 10,
            repoName: 'test-repo',
            systemName: null,
            tags: 'agent-readiness',
            detail: r.status === 'pass' ? 'Pass detail' : 'Fail detail',
            evaluatedAt: '2026-01-01',
        }],
        violations: r.status === 'fail' ? [{
            id: `eval:${r.id}:repo1`,
            ruleId: r.id,
            ruleName: r.name,
            level: r.level,
            scope: 'repository',
            status: r.status,
            entityId: 'repo1',
            entityName: 'test-repo',
            entityType: 'Repository',
            entityUrl: 'https://github.com/org/test-repo',
            teamOwner: 'team-a',
            livenessCommits: 10,
            repoName: 'test-repo',
            systemName: null,
            tags: 'agent-readiness',
            detail: 'Fail detail',
            evaluatedAt: '2026-01-01',
        }] : [],
        evaluatedCount: 1,
        compliantCount: r.status === 'pass' ? 1 : 0,
        query: '',
    }));

    const governance: GovernanceReport = {
        generatedAt: '2026-01-01',
        totalEvaluated: 1,
        totalCompliant: rules.every(r => r.status === 'pass') ? 1 : 0,
        compliancePct: rules.every(r => r.status === 'pass') ? 100 : 0,
        totalViolations: rules.filter(r => r.status === 'fail').length,
        errorViolations: rules.filter(r => r.level === 'error' && r.status === 'fail').length,
        warningViolations: rules.filter(r => r.level === 'warning' && r.status === 'fail').length,
        noteViolations: rules.filter(r => r.level === 'note' && r.status === 'fail').length,
        ruleBreakdown,
        rulesViolated: rules.filter(r => r.status === 'fail').length,
        ruleCatalog,
    };

    const radar: AgentHarnessReport = {
        matrix: [{
            repoName: 'test-repo',
            repoUrl: 'https://github.com/org/test-repo',
            teamName: 'team-a',
            tools: [],
            maturityLevel: 1,
            maturityLabel: 'Aware',
            configs: 1,
            skills: 0,
            workflows: 0,
            subagents: 0,
            ruleNames: [],
            skillNames: [],
            workflowNames: [],
            subagentNames: [],
            livenessCommits: 10,
        }],
        mcpCensus: [],
        duplicates: [],
        capabilityCoverage: [],
        catalog: [],
        semanticDuplicates: [],
        techBlindspots: [],
        skillRecommendations: [],
        teamAliasProposals: [],
        skillDuplicates: { clusters: [], projection: [], threshold: 0.9, totalSkills: 0, totalCrossRepoClusters: 0 },
    };

    return { governance, radar };
}

describe('Agentic Readiness - Weighted Level and Gating', () => {
    it('calculates 100/100 score and autonomous verdict when all checks pass', () => {
        const { governance, radar } = createMockReport([
            { id: 'rule1', name: 'Rule 1', level: 'error', status: 'pass' },
            { id: 'rule2', name: 'Rule 2', level: 'warning', status: 'pass' },
            { id: 'rule3', name: 'Rule 3', level: 'note', status: 'pass' },
        ]);

        const fleet = computeFleetReadiness(governance, radar);
        expect(fleet.repos).toHaveLength(1);
        const repo = fleet.repos[0];

        expect(repo.score).toBe(100);
        expect(repo.verdict).toBe('autonomous');
        expect(repo.checks[0].level).toBe('error');
    });

    it('calculates weighted score correctly when note fails but error and warning pass', () => {
        // error = 3 (pass), warning = 2 (pass), note = 1 (fail)
        // passed weight = 5, total weight = 6 -> score = 5/6 = 83%
        const { governance, radar } = createMockReport([
            { id: 'rule1', name: 'Rule 1', level: 'error', status: 'pass' },
            { id: 'rule2', name: 'Rule 2', level: 'warning', status: 'pass' },
            { id: 'rule3', name: 'Rule 3', level: 'note', status: 'fail' },
        ]);

        const fleet = computeFleetReadiness(governance, radar);
        const repo = fleet.repos[0];

        expect(repo.score).toBe(83);
        // No error rule failed, so verdict should remain autonomous (since 83 >= 80)
        expect(repo.verdict).toBe('autonomous');
        // The one failing (note) rule surfaces exactly one remediation action.
        expect(repo.actions).toHaveLength(1);
        expect(repo.actions[0].text).toContain('Rule 3');
    });

    it('enforces verdict gating: caps verdict at supervised when an error rule fails, despite score >= 80', () => {
        // error = 3 (fail)
        // warning = 2 (pass) x 7 rules
        // note = 1 (pass)
        // passed weight = 2 * 7 + 1 = 15
        // total weight = 3 + 14 + 1 = 18
        // score = 15/18 = 83%
        const { governance, radar } = createMockReport([
            { id: 'rule-error', name: 'Critical Rule', level: 'error', status: 'fail' },
            { id: 'rule-w1', name: 'Warning Rule 1', level: 'warning', status: 'pass' },
            { id: 'rule-w2', name: 'Warning Rule 2', level: 'warning', status: 'pass' },
            { id: 'rule-w3', name: 'Warning Rule 3', level: 'warning', status: 'pass' },
            { id: 'rule-w4', name: 'Warning Rule 4', level: 'warning', status: 'pass' },
            { id: 'rule-w5', name: 'Warning Rule 5', level: 'warning', status: 'pass' },
            { id: 'rule-w6', name: 'Warning Rule 6', level: 'warning', status: 'pass' },
            { id: 'rule-w7', name: 'Warning Rule 7', level: 'warning', status: 'pass' },
            { id: 'rule-i1', name: 'Note Rule 1', level: 'note', status: 'pass' },
        ]);

        const fleet = computeFleetReadiness(governance, radar);
        const repo = fleet.repos[0];

        expect(repo.score).toBe(83);
        // Verdict should be capped at supervised because the critical error rule failed
        expect(repo.verdict).toBe('supervised');
        // The one failing (error) rule surfaces exactly one remediation action.
        expect(repo.actions).toHaveLength(1);
        expect(repo.actions[0].text).toContain('Critical Rule');
    });
});
