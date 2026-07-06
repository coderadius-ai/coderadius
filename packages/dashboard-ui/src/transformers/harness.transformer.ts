/**
 * Harness Transformer — Converts raw AgentHarnessReport into display-ready DashboardSections.
 *
 * This is the frontend-side equivalent of the old CLI section-builders:
 * overview.ts, catalog.ts, teams.ts, matrix.ts, mcp.ts, alerts.ts
 *
 * Isomorphic — no Node.js / Bun APIs.
 */

import type { AgentHarnessReport, SemanticDuplicate } from '@coderadius/shared-types';
import type {
    DashboardSection,
    NavigableSection,
    BriefingSegment,
    AlertsSection,
    TableCell,
    SkillConstellationSection,
    SkillClusterCardsSection,
    SummaryCardsSection,
} from '@coderadius/types';
import { getMaturityColor, getPulseBadge, toHttpUrl, countWithPopover } from './utils';
import { tierFromCommits } from '@coderadius/shared-types';

// ─── Header Tooltips ────────────────────────────────────────────────────────
// Plain-language descriptions shown on column-header hover. They answer
// "what does this column mean?", not "how is it computed". Keep them
// short, jargon-light, and human.

const HDR_TOOLTIPS = {
    repository: "The repository where agentic configuration was found.",
    tools: "Which AI coding tools the repo is configured for: Claude, Cursor, Copilot, Gemini, and so on. 'generic' means tool-agnostic conventions like AGENTS.md.",
    maturity: "How developed the repo's AI setup is, from L0 (nothing) to L4 (full multi-agent orchestration).",
    rules: "Coding standards and repo-level instructions the AI is asked to follow, including conventions like AGENTS.md, CLAUDE.md, .cursorrules.",
    skills: "Reusable atomic capabilities the AI can invoke. Small, named tasks it knows how to do.",
    workflows: "Multi-step procedures for complex jobs. Unlike skills, they describe a sequence of phases.",
    agents: "Specialised personas or sub-agents defined for the repo, for example a 'code reviewer' or 'release manager' mode the AI can take on. Backed by tool-specific configs (Cline modes, Roo modes, Claude agents, CrewAI, LangGraph).",
    activity: "How alive the repository is, measured by commits and distinct authors over the last 12 months.",
    avgMaturity: "Average AI maturity across the team's repos.",
    coverage: "Share of the team's repos that have at least some AI configuration in place.",
    repos: "Number of repositories owned by this team.",
    team: "The team that owns the repo, inferred from CODEOWNERS or the service catalog.",
} as const;

// ─── Helper ──────────────────────────────────────────────────────────────────

function briefSegments(...parts: (string | { highlight: string })[]): BriefingSegment[] {
    return parts.map(p =>
        typeof p === 'string' ? { text: p } : { text: p.highlight, highlight: true }
    );
}

type RadarMatrixRow = AgentHarnessReport['matrix'][number];
type RadarMatrixRowWithLiveness = RadarMatrixRow & { livenessCommits: number };

function hasKnownLiveness(row: RadarMatrixRow): row is RadarMatrixRowWithLiveness {
    return row.livenessCommits != null;
}

// ─── Overview ────────────────────────────────────────────────────────────────

export function buildOverviewSections(report: AgentHarnessReport): DashboardSection[] {
    const sections: DashboardSection[] = [];

    // Maturity Distribution
    const distSource = [0, 0, 0, 0, 0];
    let totalForPct = 0;
    report.matrix.forEach(row => {
        if (row.maturityLevel >= 0 && row.maturityLevel <= 4) {
            distSource[row.maturityLevel] += 1;
            totalForPct += 1;
        }
    });
    if (totalForPct === 0) totalForPct = 1;

    const labels = ["Dark", "Aware", "Configured", "Skilled", "Orchestrated"];
    const tooltips = [
        "No AI configs or infrastructure detected.",
        "Basic tools referenced but unconfigured or disabled.",
        "Valid AI configurations present without custom skills/rules.",
        "Advanced AI agent configuration with custom skills and rules.",
        "Fully autonomous orchestrated AI workflows active.",
    ];

    sections.push({
        type: "histogram",
        title: "Agentic Maturity Distribution",
        subtitle: `Analyzing ${report.matrix.length} identified code repositories`,
        data: distSource.map((count, i) => ({
            label: `L${i} ${labels[i]}`,
            value: count,
            percentage: Math.round((count / totalForPct) * 100),
            colorClass: getMaturityColor(i),
            tooltip: tooltips[i],
        }))
    });

    const activeRepos = report.matrix.filter(r => r.maturityLevel > 0);
    const scatterRepos = report.matrix.filter((r): r is RadarMatrixRowWithLiveness =>
        hasKnownLiveness(r) && tierFromCommits(r.livenessCommits) !== 'unknown',
    );
    const hasLiveness = scatterRepos.length > 0;

    const biggestRiskRepo = scatterRepos.filter(r => r.maturityLevel === 0).sort((a, b) => b.livenessCommits - a.livenessCommits)[0];

    const riskSegments: BriefingSegment[] = biggestRiskRepo
        ? briefSegments(
            '', { highlight: biggestRiskRepo.repoName },
            ` is operating outside context guardrails with ${biggestRiskRepo.livenessCommits} ungoverned commits.`
        )
        : briefSegments('Telemetry indicates zero critical exposure. No highly active unmanaged repositories detected.');

    const toolCounts = new Map<string, number>();
    activeRepos.forEach(r => {
        r.tools.forEach(t => toolCounts.set(t, (toolCounts.get(t) || 0) + 1));
    });
    const sortedTools = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);

    const capabilityCounts = new Map<string, number>();
    report.capabilityCoverage.forEach(tc => {
        tc.coveredCapabilities.forEach(t => capabilityCounts.set(t, (capabilityCounts.get(t) || 0) + 1));
    });
    const sortedCapabilities = Array.from(capabilityCounts.entries()).sort((a, b) => b[1] - a[1]);

    const dominantTool = sortedTools.length > 0 ? sortedTools[0][0] : 'None';

    const trendSegments: BriefingSegment[] = sortedCapabilities.length > 0
        ? briefSegments(
            'Architecture favors ', { highlight: dominantTool },
            ' consolidation, with ', { highlight: sortedCapabilities[0][0] },
            ' as the primary driver across organization.'
        )
        : briefSegments(
            'Architecture favors ', { highlight: dominantTool },
            ' consolidation — capabilities remain unmapped.'
        );

    const insightsTeamMap = new Map<string, { repos: number, rawMaturitySum: number }>();
    for (const row of report.matrix) {
        const t = insightsTeamMap.get(row.teamName) || { repos: 0, rawMaturitySum: 0 };
        t.repos += 1;
        t.rawMaturitySum += row.maturityLevel;
        insightsTeamMap.set(row.teamName, t);
    }
    const sortedTeamsForAction = Array.from(insightsTeamMap.entries()).sort((a, b) => b[1].repos - a[1].repos);
    const nextActionTeam = sortedTeamsForAction.find(t => (t[1].rawMaturitySum / t[1].repos) < 2);

    const nbaSegments: BriefingSegment[] = nextActionTeam
        ? briefSegments(
            'Prioritize governance protocols for ', { highlight: nextActionTeam[0] },
            ` to accelerate their ${nextActionTeam[1].repos} target repositories to compliance.`
        )
        : briefSegments('Sustain current velocity. Focus shifts to deepening cross-team workflow orchestration and multi-agent synergy.');

    sections.unshift({
        type: "executive-briefing",
        title: "",
        briefs: [
            { icon: "🚨", label: "Risk Posture", segments: riskSegments },
            { icon: "💡", label: "Ecosystem Telemetry", segments: trendSegments },
            { icon: "🎯", label: "Strategic Directive", segments: nbaSegments }
        ]
    });

    const gridSections: any[] = [];

    if (sortedTools.length > 0) {
        const totalActive = activeRepos.length;
        const reposWithToolCount = activeRepos.filter(r => r.tools.length > 0).length;
        const coveragePct = totalActive > 0 ? Math.round((reposWithToolCount / totalActive) * 100) : 0;
        const totalToolInstances = sortedTools.reduce((sum, [, count]) => sum + count, 0);

        gridSections.push({
            type: "donut-chart",
            title: "Agent Tooling Sprawl",
            subtitle: "Tool distribution among AI-aware repositories",
            centerText: `${coveragePct}%`,
            centerSubText: "Configured",
            data: sortedTools.map(([tool, count]) => ({
                label: tool,
                value: count,
                percentage: Math.round((count / totalToolInstances) * 100)
            }))
        });
    }

    if (sortedCapabilities.length > 0) {
        const maxCapabilityCount = Math.max(report.capabilityCoverage.length, 1);
        gridSections.push({
            type: "radar-chart",
            title: "Capability Coverage",
            subtitle: `Evaluation dimensions across the top ${sortedCapabilities.length} autonomous capabilities`,
            data: sortedCapabilities.map(([capability, count]) => ({
                label: capability,
                value: count,
                percentage: Math.min(100, Math.round((count / maxCapabilityCount) * 100)),
                colorClass: "color-bg-cyan"
            }))
        });
    }

    if (gridSections.length > 0) {
        sections.push({
            type: "grid",
            columns: 2,
            sections: gridSections
        });
    }

    if (hasLiveness && scatterRepos.length > 0) {
        const maxCommits = Math.max(...scatterRepos.map(r => r.livenessCommits), 2);
        const logMax = Math.log(maxCommits + 1);
        sections.push({
            type: "scatter",
            title: "Agentic Risk Quadrant",
            subtitle: "Repository distribution by liveness and AI context maturity (log-scale commits)",
            xMax: 100,
            yMax: 4,
            data: scatterRepos.map(r => {
                const logX = r.livenessCommits > 0
                    ? (Math.log(r.livenessCommits + 1) / logMax) * 100
                    : 0;
                const bubbleR = r.livenessCommits > 0
                    ? 7 + Math.pow(Math.log(r.livenessCommits + 1) / logMax, 1.5) * 9
                    : 7;

                const weight = r.configs + (r.skills * 2) + (r.workflows * 3) + (r.subagents * 4);
                let seed = 0;
                for (let i = 0; i < r.repoName.length; i++) seed += r.repoName.charCodeAt(i);
                const jitter = (seed % 100) / 100.0;

                let yScore = r.maturityLevel;
                if (r.maturityLevel === 0) {
                    yScore = 0.05 + (jitter * 0.4);
                } else {
                    const weightRatio = Math.min(weight, 20) / 20.0;
                    const variance = (weightRatio * 0.6) + (jitter * 0.2) - 0.4;
                    yScore = r.maturityLevel + variance;
                }

                yScore = Math.max(0, Math.min(4, yScore));

                return {
                    label: r.repoName,
                    x: logX,
                    y: yScore,
                    r: bubbleR,
                    colorClass: getMaturityColor(r.maturityLevel),
                    tooltip: `${r.repoName} (L${r.maturityLevel}, ${r.livenessCommits} commits)`,
                };
            }),
        });
    }

    return sections;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export function buildCatalogSections(report: AgentHarnessReport): DashboardSection[] {
    if (report.catalog.length === 0) return [];

    return [{
        type: "table",
        title: "Capability Catalog",
        headers: [
            { label: "Name", meta: { width: "22%", filter: false } },
            { label: "Type", meta: { width: "120px" } },
            { label: "Description", meta: { width: "35%", filter: false } },
            "Capabilities",
            "Repositories",
            "Teams"
        ],
        rows: report.catalog.map((cap) => {
            let typeColor: any = "dim";
            let typeText = cap.type;
            if (cap.type === "skill") typeColor = "cyan";
            else if (cap.type === "workflow") typeColor = "magenta";
            else if (cap.type === "rule") typeColor = "yellow";
            else if (cap.type === "subagent_rule") { typeColor = "blue"; typeText = "subagent"; }
            else if (cap.type === "subagents_config") { typeColor = "blue"; typeText = "agents-config"; }
            else if (cap.type === "multi_agent_config") { typeColor = "magenta"; typeText = "multi-agent"; }
            else if (cap.type === "tasks_config") { typeColor = "magenta"; typeText = "tasks"; }
            else if (cap.type === "agent_instructions") { typeColor = "dim"; typeText = "instructions"; }

            let linkUrl: string | undefined;
            if (cap.filePath && cap.repos.length > 0 && cap.repos[0].url) {
                const cleanUrl = toHttpUrl(cap.repos[0].url);
                if (cleanUrl.includes("gitlab")) {
                    linkUrl = `${cleanUrl}/-/blob/HEAD/${cap.filePath}`;
                } else if (cleanUrl.includes("bitbucket")) {
                    linkUrl = `${cleanUrl}/src/HEAD/${cap.filePath}`;
                } else {
                    linkUrl = `${cleanUrl}/blob/HEAD/${cap.filePath}`;
                }
            }

            const teamBadges = cap.teams.map((t) => ({
                text: t,
                color: "dim" as const,
            }));

            const capabilityBadges = cap.capabilities.map((c) => ({
                text: c,
                color: "dim" as const,
            }));

            return [
                {
                    text: cap.name,
                    truncate: true,
                    link: linkUrl ? { url: linkUrl, external: true } : undefined,
                },
                { text: "", badges: [{ text: typeText, color: typeColor }] },
                {
                    text: cap.description || "",
                    tooltip: cap.description || undefined,
                    truncate: 2,
                },
                { text: "", badges: capabilityBadges },
                {
                    text: "",
                    items: cap.repos.map((r) => ({
                        text: r.name,
                        url: r.url ? toHttpUrl(r.url) : undefined,
                    })),
                },
                { text: "", badges: teamBadges },
            ];
        }),
    }];
}

// ─── Teams ───────────────────────────────────────────────────────────────────

export function buildTeamSections(report: AgentHarnessReport): DashboardSection[] {
    const teamMap = new Map<string, {
        repos: number, rules: number, skills: number, workflows: number, subagents: number,
        rawMaturitySum: number, livenessActive: number, reposWithContext: number,
        ruleNames: Set<string>, skillNames: Set<string>, workflowNames: Set<string>, subagentNames: Set<string>
    }>();

    for (const row of report.matrix) {
        const t = teamMap.get(row.teamName) || {
            repos: 0, rules: 0, skills: 0, workflows: 0, subagents: 0,
            rawMaturitySum: 0, livenessActive: 0, reposWithContext: 0,
            ruleNames: new Set(), skillNames: new Set(), workflowNames: new Set(), subagentNames: new Set()
        };
        t.repos += 1;
        t.rules += row.configs;
        t.skills += row.skills;
        t.workflows += row.workflows;
        t.subagents += row.subagents;
        t.rawMaturitySum += row.maturityLevel;
        if (row.maturityLevel >= 1) t.reposWithContext += 1;
        const rowTier = tierFromCommits(row.livenessCommits);
        if (rowTier !== 'low' && rowTier !== 'unknown') {
            t.livenessActive += 1;
        }
        row.ruleNames?.forEach(n => t.ruleNames.add(n));
        row.skillNames?.forEach(n => t.skillNames.add(n));
        row.workflowNames?.forEach(n => t.workflowNames.add(n));
        row.subagentNames?.forEach(n => t.subagentNames.add(n));
        teamMap.set(row.teamName, t);
    }

    const teamRows = Array.from(teamMap.entries()).sort((a, b) => b[1].repos - a[1].repos).map(([team, data]) => {
        const avgMat = data.rawMaturitySum / data.repos;
        const pulsePct = Math.round((data.livenessActive / data.repos) * 100);
        const coveragePct = Math.round((data.reposWithContext / data.repos) * 100);
        return [
            { text: team },
            { text: String(data.repos) },
            {
                text: "",
                sortValue: avgMat,
                badges: [{ text: `L${avgMat.toFixed(1)}`, color: getMaturityColor(Math.round(avgMat)).replace("color-", "") as any }]
            },
            {
                text: "",
                sortValue: coveragePct,
                badges: [{ text: `${coveragePct}%`, color: (coveragePct > 50 ? "green" : (coveragePct > 0 ? "yellow" : "dim")) as any }]
            },
            countWithPopover(data.rules, data.ruleNames, `${team} / Rules`),
            countWithPopover(data.skills, data.skillNames, `${team} / Skills`),
            countWithPopover(data.workflows, data.workflowNames, `${team} / Workflows`),
            countWithPopover(data.subagents, data.subagentNames, `${team} / Agents`),
            {
                text: "",
                sortValue: pulsePct,
                badges: [{ text: `${pulsePct}%`, color: (pulsePct > 50 ? "green" : (pulsePct > 0 ? "yellow" : "dim")) as any }]
            }
        ];
    });

    if (teamRows.length === 0) return [];

    return [{
        type: "table",
        title: "Team Overview",
        headers: [
            { label: "Team", meta: { tooltip: HDR_TOOLTIPS.team } },
            { label: "Repos", meta: { filter: false, tooltip: HDR_TOOLTIPS.repos } },
            { label: "Avg Maturity", meta: { filter: false, tooltip: HDR_TOOLTIPS.avgMaturity } },
            { label: "Coverage", meta: { filter: false, tooltip: HDR_TOOLTIPS.coverage } },
            { label: "Rules", meta: { filter: false, tooltip: HDR_TOOLTIPS.rules } },
            { label: "Skills", meta: { filter: false, tooltip: HDR_TOOLTIPS.skills } },
            { label: "Wflows", meta: { filter: false, tooltip: HDR_TOOLTIPS.workflows } },
            { label: "Agents", meta: { filter: false, tooltip: HDR_TOOLTIPS.agents } },
            { label: "Activity", meta: { width: "140px", filter: false, tooltip: HDR_TOOLTIPS.activity } }
        ],
        rows: teamRows
    }];
}

// ─── Matrix ──────────────────────────────────────────────────────────────────

export function buildMatrixSections(report: AgentHarnessReport): DashboardSection[] {
    return [{
        type: "table",
        title: "Maturity Matrix",
        headers: [
            { label: "Repository", meta: { tooltip: HDR_TOOLTIPS.repository } },
            { label: "Tools", meta: { tooltip: HDR_TOOLTIPS.tools } },
            { label: "Maturity", meta: { filter: false, tooltip: HDR_TOOLTIPS.maturity } },
            { label: "Rules", meta: { filter: false, tooltip: HDR_TOOLTIPS.rules } },
            { label: "Skills", meta: { filter: false, tooltip: HDR_TOOLTIPS.skills } },
            { label: "Wflows", meta: { filter: false, tooltip: HDR_TOOLTIPS.workflows } },
            { label: "Agents", meta: { filter: false, tooltip: HDR_TOOLTIPS.agents } },
            { label: "Activity", meta: { width: "160px", filter: false, tooltip: HDR_TOOLTIPS.activity } },
        ],
        rows: report.matrix.map((row) => {
            const pulseBadge = getPulseBadge(row.livenessCommits);
            const tier = tierFromCommits(row.livenessCommits);

            return [
                {
                    text: row.repoName,
                    sortValue: row.repoName,
                    link: row.repoUrl ? { url: toHttpUrl(row.repoUrl), external: true } : undefined,
                },
                { text: row.tools.length > 0 ? row.tools.join(", ") : "—" },
                {
                    text: "",
                    sortValue: row.maturityLevel,
                    badges: [
                        {
                            text: `L${row.maturityLevel} ${row.maturityLabel}`,
                            color: getMaturityColor(row.maturityLevel).replace("color-", "") as any,
                        },
                    ],
                },
                countWithPopover(row.configs, row.ruleNames, `${row.repoName} / Rules`),
                countWithPopover(row.skills, row.skillNames, `${row.repoName} / Skills`),
                countWithPopover(row.workflows, row.workflowNames, `${row.repoName} / Workflows`),
                countWithPopover(row.subagents, row.subagentNames, `${row.repoName} / Agents`),
                {
                    text: "",
                    sortValue: tier !== 'unknown' ? (row.livenessCommits ?? 0) : -1,
                    badges: [{
                        ...pulseBadge,
                        pulse: tier === 'elite' || tier === 'high',
                        tooltip: tier !== 'unknown'
                            ? `${row.livenessCommits} commits in 12mo`
                            : 'Liveness unknown'
                    }],
                },
            ];
        })
    }];
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

export function buildMcpSections(report: AgentHarnessReport): DashboardSection[] {
    if (report.mcpCensus.length === 0) return [];

    return [{
        type: "table",
        title: "MCP Servers",
        headers: ["Server", "Repos", "Teams"],
        rows: report.mcpCensus.map((srv) => [
            { text: srv.serverName },
            {
                text: String(srv.repos.length),
                items: srv.repos.map((r) => ({
                    text: r.name,
                    url: r.url ? toHttpUrl(r.url) : undefined,
                })),
            },
            {
                text: "",
                badges: srv.teams.map((t) => ({
                    text: t,
                    color: "dim" as any,
                })),
            },
        ])
    }];
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export function buildAlertsSections(report: AgentHarnessReport): DashboardSection[] {
    const sections: DashboardSection[] = [];

    const governanceAlerts: AlertsSection = {
        type: "alerts",
        title: "",
        alerts: [],
    };

    const navRepoUrlMap = new Map<string, string>();
    report.matrix.forEach(r => {
        if (r.repoUrl) navRepoUrlMap.set(r.repoName, toHttpUrl(r.repoUrl));
    });

    const mapRepoNameToItem = (name: string) => {
        // Handle names that might include the team e.g. "repo (team)"
        const baseName = name.split(' (')[0];
        const url = navRepoUrlMap.get(baseName);
        return url ? { text: name, url, external: true } : { text: name };
    };

    // Tech Blindspot Alerts
    for (const bs of report.techBlindspots) {
        const severity = bs.coveragePct < 20 ? 'error' : 'warning';
        const limited = bs.uncoveredRepoNames.slice(0, 10);
        const extra = bs.uncoveredRepoNames.length > 10 ? ` (+${bs.uncoveredRepoNames.length - 10} more)` : '';
        governanceAlerts.alerts.push({
            type: severity,
            title: `Technology Blindspot: ${bs.technology}`,
            category: "Tech Blindspot",
            message: `Used by ${bs.totalRepos} repositories — AI context coverage: ${bs.coveragePct}%. ${bs.uncoveredRepoNames.length} repos have zero AI guidance for ${bs.technology} development.`,
            items: (extra ? [...limited.slice(0, -1), limited[limited.length - 1] + extra] : limited).map(mapRepoNameToItem),
        });
    }

    // Skill Recommendations
    for (const rec of report.skillRecommendations) {
        const targetList = rec.targetRepos.slice(0, 5);
        const extra = rec.targetRepos.length > 5 ? ` (+${rec.targetRepos.length - 5} more)` : '';
        governanceAlerts.alerts.push({
            type: 'info',
            title: `Skill Recommendation: ${rec.skillName}`,
            category: "Recommendations",
            message: `The ${rec.skillType} "${rec.skillName}" by ${rec.sourceTeam} (${rec.sourceRepo}) shares ${rec.sharedPackageCount} dependencies with ${rec.targetTeam}. Consider importing this ${rec.skillType} to standardize practices.`,
            items: targetList.map((r, i) => i === targetList.length - 1 ? mapRepoNameToItem(r + extra) : mapRepoNameToItem(r)),
        });
    }

    // Team Alias Proposals (read-only — approve via CLI)
    if (report.teamAliasProposals) {
        for (const p of report.teamAliasProposals.filter(a => a.status === 'pending')) {
            governanceAlerts.alerts.push({
                type: 'info',
                title: `Team Identity Resolution: '${p.phantomName}' → '${p.canonicalTeam}'`,
                category: 'Team Aliases',
                message: `AI detected '${p.phantomName}' as a potential alias of '${p.canonicalTeam}' `
                    + `(${Math.round(p.confidence * 100)}% confidence, ${p.affectedRepos} repos affected). `
                    + `Run: radius team-alias approve ${p.phantomName}`,
            });
        }
    }

    // Duplicate configs
    const activeDuplicates = report.duplicates.map(cluster => {
        const activeInstances = cluster.instances.filter(i => {
            const repoMat = report.matrix.find(r => r.repoName === i.repo && r.teamName === i.team);
            if (!repoMat) return false;
            const tier = tierFromCommits(repoMat.livenessCommits);
            return tier !== 'low' && tier !== 'unknown';
        });
        return { ...cluster, instances: activeInstances };
    }).filter(cluster => {
        const uniqueRepos = new Set(cluster.instances.map(i => i.repo));
        return cluster.instances.length > 1 && uniqueRepos.size > 1;
    });

    for (const cluster of activeDuplicates) {
        const uniqueTeams = new Set(cluster.instances.map(i => i.team));
        const scope = uniqueTeams.size > 1 ? 'cross-team' : 'intra-team';
        const repos = Array.from(
            new Set(cluster.instances.map((i) => `${i.repo} (${i.team})`)),
        );
        governanceAlerts.alerts.push({
            type: scope === 'cross-team' ? "error" : "warning",
            title: scope === 'cross-team'
                ? `Standardization Gap: ${uniqueTeams.size} teams maintain independent copies of ${cluster.configType}`
                : `Consolidation Opportunity: ${cluster.configType} appears in ${repos.length} repositories`,
            category: "Consolidation",
            message: scope === 'cross-team'
                ? `${cluster.description}. Extract into an organization-wide shared rule and remove local copies.`
                : `${cluster.description}. Consider promoting this to a team-level shared configuration.`,
            items: repos.map(mapRepoNameToItem),
        });
    }

    // Sort: errors first, then warnings, then info
    const typePriority = (t: string) => t === 'error' ? 0 : t === 'warning' ? 1 : 2;
    governanceAlerts.alerts.sort((a, b) => typePriority(a.type) - typePriority(b.type));

    if (governanceAlerts.alerts.length > 0) {
        sections.push(governanceAlerts);
    }

    // Semantic Clusters
    if (report.semanticDuplicates.length > 0) {
        const crossTeamDupes = report.semanticDuplicates.filter(
            (d: SemanticDuplicate) => d.scope === 'cross-service'
        );

        const semanticAlerts: AlertsSection = {
            type: "alerts",
            title: "",
            alerts: [],
        };

        const highConfidence = crossTeamDupes.filter(
            (d: SemanticDuplicate) => d.similarity >= 0.92
        );
        if (highConfidence.length > 0) {
            semanticAlerts.alerts.push({
                type: "error",
                title: `${highConfidence.length} High-Confidence Cross-Team Duplicate(s) Detected`,
                category: "Semantic Overlap",
                message: "These configs are semantically near-identical across different teams. Consolidate into a shared golden-path rule.",
                items: highConfidence.map((d: SemanticDuplicate) => mapRepoNameToItem(
                    `${d.serviceA}/${d.configA} ↔ ${d.serviceB}/${d.configB} (${(d.similarity * 100).toFixed(1)}% similar)`
                )),
            });
        }

        const moderate = crossTeamDupes.filter(
            (d: SemanticDuplicate) => d.similarity >= 0.85 && d.similarity < 0.92
        );
        if (moderate.length > 0) {
            semanticAlerts.alerts.push({
                type: "warning",
                title: `${moderate.length} Potential Cross-Team Rule Redundancy`,
                category: "Semantic Overlap",
                message: "These configs share significant semantic overlap. Review for consolidation opportunities.",
                items: moderate.map((d: SemanticDuplicate) => mapRepoNameToItem(
                    `${d.serviceA}/${d.configA} ↔ ${d.serviceB}/${d.configB} (${(d.similarity * 100).toFixed(1)}%)`
                )),
            });
        }

        const semanticTable: DashboardSection = {
            type: "table" as const,
            title: `Semantic Clusters — ${report.semanticDuplicates.length} pair(s) detected`,
            headers: ["Similarity", "Service A", "Config A", "Service B", "Config B", "Scope", "Type"],
            rows: report.semanticDuplicates.map((d: SemanticDuplicate) => {
                const pct = (d.similarity * 100).toFixed(1);
                const confBadge = d.similarity >= 0.92 ? 'red' : d.similarity >= 0.85 ? 'yellow' : 'dim';
                const confText = d.similarity >= 0.92 ? '🔴 ' : d.similarity >= 0.85 ? '🟡 ' : '⚪ ';
                return [
                    { text: "", sortValue: d.similarity, badges: [{ text: `${confText}${pct}%`, color: confBadge as any }] },
                    { text: d.serviceA },
                    { text: d.configA, tooltip: d.filePathA, truncate: true, sortValue: d.configA },
                    { text: d.serviceB },
                    { text: d.configB, tooltip: d.filePathB, truncate: true, sortValue: d.configB },
                    { text: "", badges: [{ text: d.scope === 'cross-service' ? 'cross-service' : 'same-service', color: d.scope === 'cross-service' ? 'yellow' : 'dim' }] },
                    { text: "", badges: [{ text: d.configTypeA, color: 'cyan' }] },
                ] as TableCell[];
            }),
        };

        if (semanticAlerts.alerts.length > 0) {
            sections.push(semanticAlerts);
            sections.push(semanticTable);
        } else {
            sections.push(semanticTable);
        }
    }

    return sections;
}

// ─── Skill Duplicates (cross-repo) ─────────────────────────────────────────

export function buildSkillDuplicatesSections(report: AgentHarnessReport): DashboardSection[] {
    const view = report.skillDuplicates;
    // Hide the tab when the feature has no input at all (no skills ingested).
    if (!view || view.totalSkills === 0) return [];

    const skillsInvolved = view.clusters.reduce((s, c) => s + c.size, 0);
    const servicesInvolved = new Set<string>();
    for (const c of view.clusters) for (const s of c.services) servicesInvolved.add(s);

    const stats: SummaryCardsSection = {
        type: 'summary-cards',
        cards: [
            { label: 'Clusters',           value: view.totalCrossRepoClusters, color: 'teal' },
            { label: 'Skills involved',    value: skillsInvolved },
            { label: 'Skills indexed',     value: view.totalSkills },
            { label: 'Threshold',          value: view.threshold.toFixed(2) },
        ],
    };

    // Empty-state: skills exist but no cross-repo cluster above threshold.
    if (view.clusters.length === 0) {
        const emptyState: AlertsSection = {
            type: 'alerts',
            title: '',
            alerts: [{
                type: 'info',
                title: 'No cross-repo skill duplicates above current threshold',
                category: 'Skill Duplicates',
                message: `Found ${view.totalSkills} skill(s) but none cross repository boundaries at cosine similarity ≥ ${view.threshold.toFixed(2)}. This view will populate as duplicate skills emerge across teams.`,
            }],
        };
        return [stats, emptyState];
    }

    // Index members across clusters so we can attach name + service to each
    // projection point without sending the full member list a second time.
    const memberById = new Map<string, { name: string; service: string }>();
    for (const c of view.clusters) {
        for (const m of c.members) memberById.set(m.configId, { name: m.name, service: m.service });
    }

    const constellation: SkillConstellationSection = {
        type: 'skill-constellation',
        threshold: view.threshold,
        points: view.projection.map(p => {
            const meta = memberById.get(p.configId);
            return {
                configId: p.configId,
                name: meta?.name ?? p.configId,
                service: meta?.service ?? '',
                x: p.x,
                y: p.y,
                clusterId: p.clusterId,
            };
        }),
        clusterMeta: view.clusters.map(c => ({
            id: c.id,
            label: c.label,
            size: c.size,
            similarityAvg: c.similarity.avg,
        })),
    };

    const cards: SkillClusterCardsSection = {
        type: 'skill-cluster-cards',
        clusters: view.clusters.map(c => ({
            id: c.id,
            label: c.label,
            size: c.size,
            similarity: c.similarity,
            services: c.services,
            topics: c.topics,
            technologies: c.technologies,
            members: c.members.map(m => ({
                configId: m.configId,
                name: m.name,
                description: m.description,
                semanticIntent: m.semanticIntent,
                filePath: m.filePath,
                service: m.service,
                topics: m.topics,
                technologies: m.technologies,
            })),
        })),
    };

    return [stats, constellation, cards];
}

// ─── Full Radar Transformer ─────────────────────────────────────────────────

/**
 * Transforms a raw AgentHarnessReport into a tabs section with all sub-views.
 * Returns the NavigableSection plus headerStats and navigation metadata.
 */
export function transformRadar(report: AgentHarnessReport): {
    sections: NavigableSection[];
    navItem: {
        id: string; label: string; icon: string;
        pageTitle: string; pageSubtitle: string;
        headerStats: { label: string; value: string | number; color?: string }[];
    };
    headerStats: { label: string; value: string | number; color?: string }[];
} {
    const radarTabs = {
        type: 'tabs' as const,
        tabs: [
            { id: 'overview', label: 'Overview', sections: buildOverviewSections(report) as any[] },
            { id: 'catalog', label: 'Capability Catalog', sections: buildCatalogSections(report) as any[] },
            { id: 'teams', label: 'Team Overview', sections: buildTeamSections(report) as any[] },
            { id: 'matrix', label: 'Maturity Matrix', sections: buildMatrixSections(report) as any[] },
            { id: 'mcp', label: 'MCP Servers', sections: buildMcpSections(report) as any[] },
            { id: 'skill-duplicates', label: 'Skill Duplicates', sections: buildSkillDuplicatesSections(report) as any[] },
            { id: 'alerts', label: 'Governance Alerts', sections: buildAlertsSections(report) as any[] },
        ].filter(tab => tab.sections.length > 0)
    };

    const sections: NavigableSection[] = [{
        ...radarTabs,
        navId: 'agent-harness'
    }];

    const navItem = {
        id: 'agent-harness', label: 'Agent Harness', icon: 'Sparkles',
        pageTitle: 'Agent Harness',
        pageSubtitle: 'Organizational AI tooling observability, tool sprawl, and semantic blindspots.',
        headerStats: [
            { label: 'Repositories', value: report.matrix.length, color: 'blue' },
            { label: 'Total Catalog', value: report.catalog.length, color: 'teal' },
            { 
                label: 'Governance Alerts', 
                value: report.techBlindspots.length + report.skillRecommendations.length + report.duplicates.length + report.semanticDuplicates.length, 
                color: 'red' 
            },
        ]
    };

    const headerStats = [
        { label: 'Repositories', value: report.matrix.length, color: 'blue' },
    ];

    return { sections, navItem, headerStats };
}
