import { describe, test, expect } from 'vitest';
import { computeFleetReadiness, hasAgentReadinessData } from '../../../packages/dashboard-ui/src/components/agent-harness/readiness.model';
import type { GovernanceReport, GovernanceEvaluation, GovernanceRuleResult, GovernanceRuleCatalogEntry, AgentHarnessReport } from '@coderadius/shared-types';

function makeEval(ruleId: string, ruleName: string, entityName: string, status: 'pass' | 'fail'): GovernanceEvaluation {
    return {
        id: `cr:eval:${ruleId}:cr:repository:${entityName}`,
        ruleId,
        ruleName,
        severity: 'warning',
        scope: 'repository',
        status,
        entityId: `cr:repository:${entityName}`,
        entityName,
        entityType: 'Repository',
        entityUrl: `https://github.com/acme/${entityName}`,
        teamOwner: 'platform-team',
        livenessCommits: 120,
        repoName: entityName,
        systemName: null,
        tags: 'agent-readiness',
        detail: status === 'pass' ? 'All good' : 'Check failed',
        evaluatedAt: '2026-05-25T00:00:00Z',
    };
}

function makeRuleResult(ruleId: string, ruleName: string, evals: GovernanceEvaluation[]): GovernanceRuleResult {
    return {
        ruleId,
        ruleName,
        severity: 'warning',
        scope: 'repository',
        evaluations: evals,
        violations: evals.filter(e => e.status === 'fail'),
        evaluatedCount: evals.length,
        compliantCount: evals.filter(e => e.status === 'pass').length,
    };
}

function makeCatalogEntry(ruleId: string, name: string): GovernanceRuleCatalogEntry {
    return {
        id: ruleId,
        name,
        description: `Check: ${name}`,
        severity: 'warning',
        scope: 'repository',
        tags: ['agent-readiness'],
        lastEvaluatedAt: '2026-05-25T00:00:00Z',
        evaluatedCount: 2,
        compliantCount: 1,
        violationCount: 1,
        ok: true,
        error: null,
        query: 'MATCH (r:Repository) RETURN ...',
    };
}

const RULES = [
    { id: 'ar-blast-radius', name: 'Blast radius mapped' },
    { id: 'ar-skills-coverage', name: 'Skills coverage' },
    { id: 'ar-codeowners', name: 'CODEOWNERS clean' },
    { id: 'ar-rules-validated', name: 'Rules file validated' },
    { id: 'ar-tests-present', name: 'Tests present' },
];

const EMPTY_RADAR: AgentHarnessReport = {
    matrix: [],
    mcpCensus: [],
    duplicates: [],
    capabilityCoverage: [],
    catalog: [],
    semanticDuplicates: [],
    techBlindspots: [],
    skillRecommendations: [],
    teamAliasProposals: [],
    skillDuplicates: { clusters: [], projection: [], threshold: 0.85, totalSkills: 0, totalCrossRepoClusters: 0 },
};

function buildReport(repoScenarios: Record<string, Record<string, 'pass' | 'fail'>>): GovernanceReport {
    const ruleBreakdown: GovernanceRuleResult[] = RULES.map(rule => {
        const evals = Object.entries(repoScenarios).map(([repo, checks]) =>
            makeEval(rule.id, rule.name, repo, checks[rule.id] ?? 'fail'),
        );
        return makeRuleResult(rule.id, rule.name, evals);
    });

    const allEvals = ruleBreakdown.flatMap(r => r.evaluations);
    const totalEvaluated = new Set(allEvals.map(e => e.entityId)).size;
    const passing = Object.entries(repoScenarios).filter(([, checks]) =>
        Object.values(checks).every(s => s === 'pass'),
    ).length;

    return {
        generatedAt: '2026-05-25T00:00:00Z',
        totalEvaluated,
        totalCompliant: passing,
        compliancePct: totalEvaluated > 0 ? Math.round((passing / totalEvaluated) * 100) : 0,
        totalViolations: allEvals.filter(e => e.status === 'fail').length,
        errorViolations: 0,
        warningViolations: allEvals.filter(e => e.status === 'fail').length,
        infoViolations: 0,
        ruleBreakdown,
        rulesViolated: ruleBreakdown.filter(r => r.violations.length > 0).length,
        ruleCatalog: RULES.map(r => makeCatalogEntry(r.id, r.name)),
    };
}

describe('hasAgentReadinessData', () => {
    test('returns false for null governance', () => {
        expect(hasAgentReadinessData(null)).toBe(false);
    });

    test('returns false when no agent-readiness tagged rules', () => {
        const report = buildReport({});
        report.ruleCatalog = report.ruleCatalog.map(r => ({ ...r, tags: ['other-tag'] }));
        expect(hasAgentReadinessData(report)).toBe(false);
    });

    test('returns true when agent-readiness tagged rules exist', () => {
        const report = buildReport({ 'orders-core': Object.fromEntries(RULES.map(r => [r.id, 'pass' as const])) });
        expect(hasAgentReadinessData(report)).toBe(true);
    });
});

describe('computeFleetReadiness', () => {
    test('all pass = 100 score, autonomous verdict', () => {
        const allPass = Object.fromEntries(RULES.map(r => [r.id, 'pass' as const]));
        const report = buildReport({ 'orders-core': allPass });
        const fleet = computeFleetReadiness(report, EMPTY_RADAR);

        expect(fleet.repos).toHaveLength(1);
        expect(fleet.repos[0].score).toBe(100);
        expect(fleet.repos[0].verdict).toBe('autonomous');
        expect(fleet.repos[0].checks).toHaveLength(5);
        expect(fleet.repos[0].actions).toHaveLength(0);
        expect(fleet.distribution.autonomous).toBe(1);
    });

    test('all fail = 0 score, off-limits verdict', () => {
        const allFail = Object.fromEntries(RULES.map(r => [r.id, 'fail' as const]));
        const report = buildReport({ 'orders-core': allFail });
        const fleet = computeFleetReadiness(report, EMPTY_RADAR);

        expect(fleet.repos[0].score).toBe(0);
        expect(fleet.repos[0].verdict).toBe('off-limits');
        expect(fleet.repos[0].actions.length).toBeGreaterThan(0);
        expect(fleet.distribution.offLimits).toBe(1);
    });

    test('surfaces named rule files and wired MCP servers from the radar payload', () => {
        const allPass = Object.fromEntries(RULES.map(r => [r.id, 'pass' as const]));
        const report = buildReport({ 'orders-core': allPass });
        const radar: AgentHarnessReport = {
            ...EMPTY_RADAR,
            matrix: [{
                repoName: 'orders-core', repoUrl: null, teamName: 'platform-team', teamSources: [],
                tools: ['claude'], maturityLevel: 3, maturityLabel: 'Skilled',
                configs: 1, skills: 0, workflows: 0, subagents: 0,
                ruleNames: ['AGENTS.md', 'CLAUDE.md'], skillNames: [], workflowNames: [], subagentNames: [],
                livenessCommits: 120,
            }],
            mcpCensus: [{ serverName: 'coderadius', repos: [{ name: 'orders-core', url: null }], teams: ['platform-team'] }],
        };
        const repo = computeFleetReadiness(report, radar).repos[0];
        expect(repo.ruleFiles).toEqual(['AGENTS.md', 'CLAUDE.md']);
        expect(repo.mcpServers).toEqual(['coderadius']);
    });

    test('rule files and MCP default to empty when the radar has no matching entry', () => {
        const allPass = Object.fromEntries(RULES.map(r => [r.id, 'pass' as const]));
        const report = buildReport({ 'orders-core': allPass });
        const repo = computeFleetReadiness(report, EMPTY_RADAR).repos[0];
        expect(repo.ruleFiles).toEqual([]);
        expect(repo.mcpServers).toEqual([]);
    });

    test('3/5 pass = 60 score, supervised verdict', () => {
        const mixed: Record<string, 'pass' | 'fail'> = {
            'ar-blast-radius': 'pass',
            'ar-skills-coverage': 'pass',
            'ar-codeowners': 'pass',
            'ar-rules-validated': 'fail',
            'ar-tests-present': 'fail',
        };
        const report = buildReport({ 'orders-core': mixed });
        const fleet = computeFleetReadiness(report, EMPTY_RADAR);

        expect(fleet.repos[0].score).toBe(60);
        expect(fleet.repos[0].verdict).toBe('supervised');
        expect(fleet.repos[0].actions).toHaveLength(2);
        expect(fleet.distribution.supervised).toBe(1);
    });

    test('fleet score is average of repo scores', () => {
        const allPass = Object.fromEntries(RULES.map(r => [r.id, 'pass' as const]));
        const allFail = Object.fromEntries(RULES.map(r => [r.id, 'fail' as const]));
        const report = buildReport({ 'repo-a': allPass, 'repo-b': allFail });
        const fleet = computeFleetReadiness(report, EMPTY_RADAR);

        expect(fleet.score).toBe(50);
        expect(fleet.repos).toHaveLength(2);
    });

    test('denominator is fixed to ruleCatalog length, not evaluation count', () => {
        const partial: Record<string, 'pass' | 'fail'> = {
            'ar-blast-radius': 'pass',
            'ar-skills-coverage': 'pass',
            'ar-codeowners': 'pass',
            'ar-rules-validated': 'pass',
            'ar-tests-present': 'pass',
        };
        const report = buildReport({ 'orders-core': partial });
        // Remove one rule's evaluations to simulate timeout
        report.ruleBreakdown = report.ruleBreakdown.filter(r => r.ruleId !== 'ar-tests-present');
        const fleet = computeFleetReadiness(report, EMPTY_RADAR);

        // 4 pass out of 5 total rules = 80%, not 100%
        expect(fleet.repos[0].score).toBe(80);
        expect(fleet.repos[0].verdict).toBe('autonomous');
    });

    test('radar decorator enriches activity metadata', () => {
        const allPass = Object.fromEntries(RULES.map(r => [r.id, 'pass' as const]));
        const report = buildReport({ 'orders-core': allPass });
        const radar: AgentHarnessReport = {
            ...EMPTY_RADAR,
            matrix: [{
                repoName: 'orders-core',
                repoUrl: null,
                teamName: 'platform-orders',
                tools: ['cursor', 'claude'],
                maturityLevel: 3,
                maturityLabel: 'Skilled',
                configs: 2,
                skills: 5,
                workflows: 1,
                subagents: 0,
                ruleNames: [],
                skillNames: [],
                workflowNames: [],
                subagentNames: [],
                livenessCommits: 250,
            }],
        };

        const fleet = computeFleetReadiness(report, radar);
        expect(fleet.repos[0].activity.agents).toEqual(['cursor', 'claude']);
    });

    test('command actions expose a copyable cr command; manual steps have none', () => {
        const allFail = Object.fromEntries(RULES.map(r => [r.id, 'fail' as const]));
        const report = buildReport({ 'orders-core': allFail });
        const fleet = computeFleetReadiness(report, EMPTY_RADAR);
        const actions = fleet.repos[0].actions;

        // Blast radius is fixed by running analysis → a real, copyable command.
        const blast = actions.find(a => a.text === 'Map the blast radius');
        expect(blast?.command).toBe('cr analyze code');

        // CODEOWNERS is a manual repo edit → no command, so no fake "Generate" button.
        const codeowners = actions.find(a => a.text === 'Add a CODEOWNERS file with active maintainers');
        expect(codeowners).toBeDefined();
        expect(codeowners?.command).toBeUndefined();
    });

    test('a failing ar-architecture-context surfaces the grounding remediation', () => {
        const rule = { id: 'ar-architecture-context', name: 'Architectural context grounded' };
        const evals = [makeEval(rule.id, rule.name, 'orders-core', 'fail')];
        const report: GovernanceReport = {
            generatedAt: '2026-05-25T00:00:00Z',
            totalEvaluated: 1,
            totalCompliant: 0,
            compliancePct: 0,
            totalViolations: 1,
            errorViolations: 0,
            warningViolations: 1,
            infoViolations: 0,
            ruleBreakdown: [makeRuleResult(rule.id, rule.name, evals)],
            rulesViolated: 1,
            ruleCatalog: [makeCatalogEntry(rule.id, rule.name)],
        };

        const fleet = computeFleetReadiness(report, EMPTY_RADAR);
        const action = fleet.repos[0].actions.find(a => a.text === 'Ground agent context in the architecture graph');
        expect(action).toBeDefined();
        // Grounding is the live coderadius MCP, not a static doc. The remediation
        // is a copyable command: analysis first (a fail can mean "no analysis
        // yet"), then configure the MCP.
        expect(action?.command).toBe('cr analyze code && cr mcp configure');
    });

    test('two repos sharing a display name each get a URN-namespace qualifier', () => {
        // One repo wrongly produces two Repository URNs (upstream identity bug).
        // Until that is fixed, the fleet table must keep the rows distinguishable.
        const rule = { id: 'ar-tests-present', name: 'Tests present' };
        const a = { ...makeEval(rule.id, rule.name, 'orders', 'pass'), entityId: 'cr:repository:acme/orders' };
        const b = { ...makeEval(rule.id, rule.name, 'orders', 'fail'), entityId: 'cr:repository:vendor/orders' };
        const report: GovernanceReport = {
            generatedAt: '2026-05-25T00:00:00Z',
            totalEvaluated: 2,
            totalCompliant: 1,
            compliancePct: 50,
            totalViolations: 1,
            errorViolations: 0,
            warningViolations: 1,
            infoViolations: 0,
            ruleBreakdown: [makeRuleResult(rule.id, rule.name, [a, b])],
            rulesViolated: 1,
            ruleCatalog: [makeCatalogEntry(rule.id, rule.name)],
        };

        const fleet = computeFleetReadiness(report, EMPTY_RADAR);
        expect(fleet.repos).toHaveLength(2);
        expect(fleet.repos.map(r => r.repoQualifier).sort()).toEqual(['acme', 'vendor']);
    });

    test('a repo with a unique display name carries no qualifier', () => {
        const allPass = Object.fromEntries(RULES.map(r => [r.id, 'pass' as const]));
        const report = buildReport({ 'orders-core': allPass });
        const fleet = computeFleetReadiness(report, EMPTY_RADAR);
        expect(fleet.repos[0].repoQualifier).toBeUndefined();
    });
});
