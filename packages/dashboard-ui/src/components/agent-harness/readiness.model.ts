import type { GovernanceReport, AgentHarnessReport } from '@coderadius/shared-types';
import { activityFromCommits } from '../../transformers/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ReadinessVerdict = 'autonomous' | 'supervised' | 'off-limits';
export type CheckStatus = 'pass' | 'fail';

export interface ReadinessCheck {
    ruleId: string;
    label: string;
    description: string;
    status: CheckStatus;
    requirement?: never; // force compile error if used
    level: 'error' | 'warning' | 'note';
    infoTooltip: string;
    earned?: number;
    total?: number;
}

export interface ReadinessAction {
    text: string;
    /** A copyable shell command, when a `cr` command remedies the gap. Absent
     *  for manual steps (e.g. adding a CODEOWNERS file) so the UI shows guidance
     *  instead of a button that pretends to do the work. */
    command?: string;
}

export interface RepoReadiness {
    repoName: string;
    repoUrl: string | null;
    // Set only when another repo in the fleet renders under the same display
    // name: the URN namespace ({org} in cr:repository:{org}/{name}) so the two
    // rows are distinguishable. Interim: the real fix is upstream identity
    // dedup (one repo should not produce two Repository URNs).
    repoQualifier?: string;
    teamName: string;
    score: number;
    verdict: ReadinessVerdict;
    verdictLabel: string;
    checks: ReadinessCheck[];
    actions: ReadinessAction[];
    /** Named agent rule files (AGENTS.md, CLAUDE.md, .cursorrules, ...). */
    ruleFiles: string[];
    /** MCP servers wired for this repo (e.g. 'coderadius'); empty = none. */
    mcpServers: string[];
    livenessCommits: number | null;
    activityScore: number;
    activity: {
        agents: string[];
        merged: number;
        reverted: number;
        incidents: number;
        since: string;
    };
}

export interface FleetReadiness {
    score: number;
    trend: string | null;
    repos: RepoReadiness[];
    distribution: {
        autonomous: number;
        supervised: number;
        offLimits: number;
    };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const AGENT_READINESS_TAG = 'agent-readiness';

const VERDICT_LABELS: Record<ReadinessVerdict, string> = {
    autonomous: 'Autonomous',
    supervised: 'Supervised',
    'off-limits': 'Off-limits',
};

// Each remediation is either a copyable `cr` command, or a manual step with no
// command (we do not ship buttons that pretend to do the work).
const ACTION_MAP: Record<string, { text: string; command?: string }> = {
    'ar-blast-radius': { text: 'Map the blast radius', command: 'cr analyze code' },
    'ar-skills-coverage': { text: 'Define skills for this repo' },
    'ar-codeowners': { text: 'Add a CODEOWNERS file with active maintainers' },
    'ar-rules-validated': { text: 'Add an agent rules file (AGENTS.md or .cursorrules)' },
    'ar-tests-present': { text: 'Add a test stage to the CI pipeline' },
    'ar-architecture-context': { text: 'Ground agent context in the architecture graph', command: 'cr analyze code && cr mcp configure' },
    'ar-makefile-targets': { text: 'Add setup, test, and run targets to the Makefile' },
    'ar-context-actionable': { text: 'Add build, test, and run commands to the agent context file' },
    'ar-context-minimal': { text: 'Trim the agent context file to tooling-specific essentials' },
};

// ─── Scoring Logic ──────────────────────────────────────────────────────────

function verdictFromScore(score: number): ReadinessVerdict {
    if (score >= 80) return 'autonomous';
    if (score >= 50) return 'supervised';
    return 'off-limits';
}

/** The {org} namespace in cr:repository:{org}/{name}, used to tell apart two
 *  repos that share a display name. Undefined for unqualified or odd URNs. */
function repoNamespace(urn: string): string | undefined {
    const tail = urn.replace(/^cr:repository:/, '');
    const slash = tail.indexOf('/');
    return slash > 0 ? tail.slice(0, slash) : undefined;
}

// ─── Main Transformer ───────────────────────────────────────────────────────

export function hasAgentReadinessData(governance: GovernanceReport | null): boolean {
    if (!governance) return false;
    return governance.ruleCatalog.some(r => r.tags.includes(AGENT_READINESS_TAG));
}

export function computeFleetReadiness(
    governance: GovernanceReport,
    radar: AgentHarnessReport,
): FleetReadiness {
    const agentRules = governance.ruleCatalog.filter(r => r.tags.includes(AGENT_READINESS_TAG));
    const agentRuleIds = new Set(agentRules.map(r => r.id));
    const totalRules = agentRules.length;

    if (totalRules === 0) {
        return { score: 0, trend: null, repos: [], distribution: { autonomous: 0, supervised: 0, offLimits: 0 } };
    }

    const ruleDescriptions = new Map<string, string>();
    for (const rule of agentRules) {
        ruleDescriptions.set(rule.id, rule.description);
    }

    const radarMeta = new Map(radar.matrix.map(r => [r.repoName, r]));

    // Which MCP servers are wired per repo (reverse of the server-keyed census).
    const mcpByRepo = new Map<string, string[]>();
    for (const server of radar.mcpCensus) {
        for (const r of server.repos) {
            const list = mcpByRepo.get(r.name) ?? [];
            list.push(server.serverName);
            mcpByRepo.set(r.name, list);
        }
    }

    const agentBreakdown = governance.ruleBreakdown.filter(r => agentRuleIds.has(r.ruleId));

    const repoMap = new Map<string, {
        entityName: string;
        entityUrl: string | null;
        teamOwner: string | null;
        checks: Map<string, { status: CheckStatus; detail: string; ruleName: string }>;
        livenessCommits: number | null;
    }>();

    for (const ruleResult of agentBreakdown) {
        for (const evaluation of ruleResult.evaluations) {
            const key = evaluation.entityId;
            if (!repoMap.has(key)) {
                repoMap.set(key, {
                    entityName: evaluation.entityName,
                    entityUrl: evaluation.entityUrl ?? null,
                    teamOwner: evaluation.teamOwner ?? null,
                    checks: new Map(),
                    livenessCommits: evaluation.livenessCommits ?? null,
                });
            }
            const repo = repoMap.get(key)!;
            repo.checks.set(ruleResult.ruleId, {
                status: evaluation.status as CheckStatus,
                detail: evaluation.detail,
                ruleName: ruleResult.ruleName,
            });
        }
    }

    const nameCounts = new Map<string, number>();
    for (const data of repoMap.values()) {
        nameCounts.set(data.entityName, (nameCounts.get(data.entityName) ?? 0) + 1);
    }

    const repos: RepoReadiness[] = Array.from(repoMap.entries()).map(([entityId, data]) => {
        const LEVEL_WEIGHTS: Record<'error' | 'warning' | 'note', number> = {
            error: 3,
            warning: 2,
            note: 1,
        };

        const checks: ReadinessCheck[] = agentRules.map(rule => {
            const check = data.checks.get(rule.id);
            return {
                ruleId: rule.id,
                label: check?.ruleName ?? rule.name,
                description: check?.detail ?? 'Not evaluated',
                status: (check?.status ?? 'fail') as CheckStatus,
                level: rule.level,
                infoTooltip: ruleDescriptions.get(rule.id) ?? '',
            };
        });

        const totalWeight = agentRules.reduce((sum, r) => sum + (LEVEL_WEIGHTS[r.level] ?? 2), 0);
        let passedWeight = 0;
        let hasFailedError = false;

        for (const c of checks) {
            const weight = LEVEL_WEIGHTS[c.level] ?? 2;
            if (c.status === 'pass') {
                passedWeight += weight;
            } else if (c.level === 'error') {
                hasFailedError = true;
            }
        }

        const score = totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 100) : 0;
        let verdict = verdictFromScore(score);
        if (hasFailedError && verdict === 'autonomous') {
            verdict = 'supervised';
        }

        // Every failing check yields an action; applying them all = every check
        // passes = 100, so the panel shows a single aggregate promise (no per-item
        // points to distribute).
        const actions: ReadinessAction[] = checks
            .filter(c => c.status === 'fail')
            .map(c => {
                const action = ACTION_MAP[c.ruleId];
                return {
                    text: action?.text ?? `Fix: ${c.label}`,
                    command: action?.command,
                };
            });

        const meta = radarMeta.get(data.entityName);
        const livenessCommits = data.livenessCommits ?? meta?.livenessCommits ?? null;

        return {
            repoName: data.entityName,
            repoUrl: data.entityUrl ?? meta?.repoUrl ?? null,
            repoQualifier: (nameCounts.get(data.entityName) ?? 0) > 1 ? repoNamespace(entityId) : undefined,
            teamName: data.teamOwner ?? meta?.teamName ?? 'unassigned',
            score,
            verdict,
            verdictLabel: VERDICT_LABELS[verdict],
            checks,
            actions,
            ruleFiles: meta?.ruleNames ?? [],
            mcpServers: mcpByRepo.get(data.entityName) ?? [],
            livenessCommits,
            activityScore: activityFromCommits(livenessCommits),
            activity: {
                agents: meta?.tools ?? [],
                merged: livenessCommits ?? 0,
                reverted: 0,
                incidents: 0,
                since: livenessCommits != null ? '12 mo' : 'unknown',
            },
        };
    });

    repos.sort((a, b) => b.score - a.score);

    const distribution = {
        autonomous: repos.filter(r => r.verdict === 'autonomous').length,
        supervised: repos.filter(r => r.verdict === 'supervised').length,
        offLimits: repos.filter(r => r.verdict === 'off-limits').length,
    };

    const fleetScore = repos.length > 0
        ? Math.round(repos.reduce((s, r) => s + r.score, 0) / repos.length)
        : 0;

    return {
        score: fleetScore,
        trend: null,
        repos,
        distribution,
    };
}
