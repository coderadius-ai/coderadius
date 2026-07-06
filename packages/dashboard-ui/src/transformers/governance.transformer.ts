/**
 * Governance Transformer: converts a GovernanceReport into display-ready DashboardSections.
 *
 * Isomorphic: no Node.js / Bun APIs.
 *
 * Renders using ONLY existing section types (DonutChart, BarChart, DataTable, Tabs).
 * No new React components needed.
 *
 * 100% data-driven: the transformer knows nothing about specific rule names.
 * Add a new YAML rule → re-run cr policy verify → it auto-appears in every chart.
 */

import type { GovernanceReport, GovernanceRuleCatalogEntry, GovernanceRuleResult } from '@coderadius/shared-types';
import type {
    NavigableSection,
    TableCell,
    TableRow,
    TableSection,
} from '@coderadius/types';
import { toHttpUrl, repoPath, getPulseBadge } from './utils';
import { tierFromCommits } from '@coderadius/shared-types';

const LEVEL_COLORS: Record<string, string> = {
    error: 'red',
    warning: 'yellow',
    note: 'cyan',
};

// ── Semantic Labels ──────────────────────────────────────────────────────────
// Maps raw requirement levels to governance-oriented display names.
// The underlying data schema stays must/should/could; this is display-only.

const LEVEL_LABELS: Record<string, { badge: string; plural: string; filter: string; headerLabel: string }> = {
    error:   { badge: 'ERROR', plural: 'error', filter: 'has-errors', headerLabel: 'Errors' },
    warning: { badge: 'WARNING',     plural: 'warning',     filter: 'has-warnings',     headerLabel: 'Warnings' },
    note:    { badge: 'NOTE',  plural: 'note',  filter: 'note-only',  headerLabel: 'Notes' },
};

// ── Structured Detail Renderer ───────────────────────────────────────────────



const LEVEL_SORT: Record<string, number> = {
    error: 0,
    warning: 1,
    note: 2,
};

/**
 * Flat representation of a single PolicyEvaluation, one row per evaluation
 * with all contextual dimensions joined and ready for CSV export or
 * spreadsheet pivot. Column order here is the export order.
 *
 * `qualified_name` is the first column on purpose: Excel users see
 * `core-service/api` immediately and don't need to glance at the type column to
 * know what they're looking at.
 */
export interface FlatEvaluationRow {
    qualified_name: string;
    repo: string;
    system: string;
    entity_name: string;
    entity_type: string;
    entity_url: string;
    team_owner: string;
    /** Raw commit count over the last 12 months (no-merges) on the repo. Empty string when unknown. */
    commits_12mo: number | '';
    rule_id: string;
    rule_name: string;
    level: string;
    scope: string;
    tags: string;
    status: string;
    detail: string;
    structured_detail: string;
    evaluated_at: string;
}

/** Stable header order for the flat CSV; keeps consumers (toolbar export, tests) in lockstep. */
export const FLAT_EVALUATION_HEADERS: readonly (keyof FlatEvaluationRow)[] = [
    'qualified_name', 'repo', 'system', 'entity_name', 'entity_type',
    'entity_url', 'team_owner', 'commits_12mo',
    'rule_id', 'rule_name', 'level', 'scope', 'tags', 'status', 'detail',
    'structured_detail', 'evaluated_at',
] as const;

const LEVEL_RANK: Record<string, number> = {
    error: 0,
    warning: 1,
    note: 2,
};

function buildFlatEvaluations(report: GovernanceReport): FlatEvaluationRow[] {
    const rows: FlatEvaluationRow[] = [];
    for (const rule of report.ruleBreakdown) {
        for (const e of rule.evaluations) {
            const ev = e as any;
            const repoName: string = ev.repoName ?? '';
            const isRepoEntity = (e.entityType ?? '').toLowerCase() === 'repository';
            const qualifiedName = isRepoEntity
                ? e.entityName
                : (repoName ? `${repoName}/${e.entityName}` : e.entityName);
            rows.push({
                qualified_name: qualifiedName,
                repo: repoName,
                system: ev.systemName ?? '',
                entity_name: e.entityName,
                entity_type: e.entityType,
                entity_url: e.entityUrl ?? '',
                team_owner: e.teamOwner ?? '',
                commits_12mo: typeof ev.livenessCommits === 'number' ? ev.livenessCommits : '',
                rule_id: e.ruleId,
                rule_name: e.ruleName,
                level: e.level,
                scope: e.scope ?? '',
                tags: ev.tags ?? '',
                status: e.status,
                detail: e.detail ?? '',
                structured_detail: e.structuredDetail ? JSON.stringify(e.structuredDetail) : '',
                evaluated_at: e.evaluatedAt,
            });
        }
    }
    // Sort: repo (empty last) → requirement (must → should → could) → rule_id → entity_name.
    // This keeps all rows for the same repository contiguous and front-loads
    // the highest-impact rules, so the CSV reads top-down like a triage list.
    rows.sort((a, b) => {
        if (a.repo !== b.repo) {
            if (!a.repo) return 1;
            if (!b.repo) return -1;
            return a.repo.localeCompare(b.repo);
        }
        const sa = LEVEL_RANK[a.level] ?? 99;
        const sb = LEVEL_RANK[b.level] ?? 99;
        if (sa !== sb) return sa - sb;
        if (a.rule_id !== b.rule_id) return a.rule_id.localeCompare(b.rule_id);
        return a.entity_name.localeCompare(b.entity_name);
    });
    return rows;
}

/**
 * Build the per-rule drawer-data map keyed by ruleId. Same shape the Policies
 * tab uses on row click, letting the Compliance drawer open the rule detail
 * on top without re-fetching anything.
 */
function buildRuleDrawerById(report: GovernanceReport): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const rule of report.ruleCatalog) {
        const ruleResult = report.ruleBreakdown.find(b => b.ruleId === rule.id);
        result[rule.id] = {
            kind: 'governance-rule' as const,
            _rowId: rule.id,
            id: rule.id,
            name: rule.name,
            description: rule.description ?? '',
            level: rule.level,
            scope: rule.scope ?? 'any',
            query: rule.query ?? '',
            evaluatedCount: rule.evaluatedCount,
            compliantCount: rule.compliantCount,
            violations: ruleResult?.violations.map(v => ({
                entityId: v.entityId,
                entityName: v.entityName,
                entityType: v.entityType,
                teamOwner: v.teamOwner ?? null,
                detail: v.detail,
            })) ?? [],
            compliants: ruleResult?.evaluations
                .filter(e => e.status === 'pass')
                .map(e => ({
                    entityId: e.entityId,
                    entityName: e.entityName,
                    entityType: e.entityType,
                    teamOwner: e.teamOwner ?? null,
                })) ?? [],
        };
    }
    return result;
}

export function transformGovernance(report: GovernanceReport): {
    sections: NavigableSection[];
    navItem: {
        id: string; label: string; icon: string;
        pageTitle: string; pageSubtitle: string;
        headerStats: { label: string; value: string | number; color?: string; tooltip?: string }[];
    };
    headerStats: { label: string; value: string | number; color?: string; tooltip?: string }[];
    /** Flat 1-row-per-evaluation array for the toolbar CSV export. */
    evaluations: FlatEvaluationRow[];
    /** ruleId → GovernanceRuleDrawerData payload (same shape the Policies tab uses). */
    ruleDrawerById: Record<string, unknown>;
} {
    const sections = buildGovernanceSections(report);
    const evaluations = buildFlatEvaluations(report);
    const ruleDrawerById = buildRuleDrawerById(report);

    // ── Precompute metrics ───────────────────────────────────────────────────
    const totalRules = report.ruleCatalog.length;
    const passingRules = report.ruleCatalog.filter(r => r.ok && r.violationCount === 0).length;

    const navItem = {
        id: 'governance',
        label: 'Governance',
        icon: 'Shield',
        pageTitle: 'Governance',
        pageSubtitle: 'Policy compliance and architectural standards enforcement',
        headerStats: [
            {
                label: 'Compliance',
                value: `${report.compliancePct}%`,
                color: report.compliancePct >= 90 ? 'green' : report.compliancePct >= 70 ? 'yellow' : 'red',
                tooltip: `${report.totalCompliant}/${report.totalEvaluated} entities fully compliant`,
            },
            {
                label: 'Rules',
                value: `${passingRules}/${totalRules} passing`,
                color: passingRules === totalRules ? 'green' : passingRules >= totalRules * 0.7 ? 'yellow' : 'red',
            },
            ...(report.errorViolations > 0 ? [{
                label: LEVEL_LABELS.error.headerLabel,
                value: report.errorViolations,
                color: 'red' as const,
            }] : []),
            ...(report.warningViolations > 0 ? [{
                label: LEVEL_LABELS.warning.headerLabel,
                value: report.warningViolations,
                color: 'yellow' as const,
            }] : []),
            ...(report.errorViolations === 0 && report.warningViolations === 0 ? [{
                label: 'Status',
                value: 'All clear',
                color: 'green' as const,
            }] : []),
        ],
    };

    // No separate headerStats; navItem.headerStats is the single source of truth
    const headerStats: { label: string; value: string | number; color?: string; tooltip?: string }[] = [];

    return { sections, navItem, headerStats, evaluations, ruleDrawerById };
}

// ─── Entity Aggregation ──────────────────────────────────────────────────────

interface EntitySummary {
    entityId: string;
    entityName: string;
    entityType: string;
    entityUrl: string | null;
    teamOwner: string | null;
    livenessCommits: number | null;
    errors: number;
    warnings: number;
    notes: number;
    total: number;
    /** Number of rules that evaluated this entity */
    rulesEvaluated: number;
    /** Number of rules this entity passed */
    rulesPassed: number;
    /** Distinct rule IDs that this entity fails */
    failedRuleIds: Set<string>;
    /** Distinct rule names for display */
    failedRuleNames: Set<string>;
    /** Worst level for sorting */
    worstLevel: number;
}

function aggregateByEntity(report: GovernanceReport): EntitySummary[] {
    const map = new Map<string, EntitySummary>();

    for (const rule of report.ruleBreakdown) {
        for (const e of rule.evaluations) {
            let entry = map.get(e.entityId);
            if (!entry) {
                entry = {
                    entityId: e.entityId,
                    entityName: e.entityName,
                    entityType: e.entityType,
                    entityUrl: e.entityUrl ?? null,
                    teamOwner: (e as any).teamOwner ?? null,
                    livenessCommits: typeof (e as any).livenessCommits === 'number' ? (e as any).livenessCommits : null,
                    errors: 0,
                    warnings: 0,
                    notes: 0,
                    total: 0,
                    rulesEvaluated: 0,
                    rulesPassed: 0,
                    failedRuleIds: new Set(),
                    failedRuleNames: new Set(),
                    worstLevel: 3, // compliant (lower than note=2)
                };
                map.set(e.entityId, entry);
            }
            entry.rulesEvaluated++;
            if (e.status === 'pass') {
                entry.rulesPassed++;
            } else {
                entry.total++;
                if (e.level === 'error') entry.errors++;
                else if (e.level === 'warning') entry.warnings++;
                else entry.notes++;
                entry.failedRuleIds.add(e.ruleId);
                entry.failedRuleNames.add(e.ruleName);
                const lvlIdx = LEVEL_SORT[e.level] ?? 2;
                if (lvlIdx < entry.worstLevel) entry.worstLevel = lvlIdx;
            }
        }
    }

    // Sort: worst level first, then by total violations desc, then alphabetical
    return [...map.values()].sort((a, b) => {
        if (a.worstLevel !== b.worstLevel) return a.worstLevel - b.worstLevel;
        if (a.total !== b.total) return b.total - a.total;
        return a.entityName.localeCompare(b.entityName);
    });
}

// ─── Section Builders ────────────────────────────────────────────────────────

function buildGovernanceSections(report: GovernanceReport): NavigableSection[] {
    const sections: NavigableSection[] = [];
    const navId = 'governance';

    // ── Tabbed views: Compliance + Violations + Policies ─────────────────
    sections.push({
        type: 'tabs',
        tabs: [
            { id: 'compliance', label: 'Compliance', sections: [buildEntityTable(report, aggregateByEntity(report))] },
            { id: 'policies', label: 'Policies', sections: [buildRuleCatalogTable(report.ruleCatalog, report.ruleBreakdown)] },
        ],
        navId,
    });

    return sections;
}

// ── Entity-aggregated table ──────────────────────────────────────────────────

function buildEntityTable(report: GovernanceReport, entities: EntitySummary[]): TableSection {
    const rows: TableRow[] = entities.map(e => {
        const isCompliant = e.total === 0;

        // ── Numeric Cells ───────────────────────────────────────────────────
        const countCell = (count: number, color: string): TableCell => {
            if (count === 0) return { text: '—', color: 'dim', sortValue: 0 };
            return {
                text: `${count}`,
                color: color as any,
                sortValue: count,
            };
        };

        // ── Compliant ratio cell ────────────────────────────────────────
        const compliancePct = e.rulesEvaluated > 0 ? e.rulesPassed / e.rulesEvaluated : 0;
        const ratioColor = isCompliant ? 'green' : compliancePct >= 0.5 ? 'yellow' : 'red';
        const complianceCell: TableCell = {
            text: '',
            segments: [
                { text: `${e.rulesPassed}`, color: ratioColor as any },
                { text: '/', color: 'dim' as any },
                { text: `${e.rulesEvaluated}`, color: 'dim' as any },
            ],
            sortValue: e.rulesEvaluated - e.rulesPassed, // 0 = fully compliant, sorts to top
            filterValues: isCompliant ? ['compliant'] : compliancePct > 0 ? ['partial'] : ['non-compliant'],
        };

        // ── Team cell ────────────────────────────────────────────────────────
        const teamCell: TableCell = e.teamOwner
            ? { text: '', badges: [{ text: e.teamOwner, color: 'dim' }], filterValues: [e.teamOwner] }
            : { text: '—', color: 'dim', sortValue: 1 };

        const cells: TableCell[] = [
            // 1. Entity
            {
                text: e.entityType === 'repository' ? repoPath(e.entityUrl, e.entityName) : e.entityName,
                link: e.entityType === 'repository' && e.entityUrl ? { url: toHttpUrl(e.entityUrl), external: true } : undefined,
                subtitle: e.entityType === 'service' && e.entityUrl ? repoPath(e.entityUrl, '') || undefined : undefined,
                subtitleLink: e.entityType === 'service' && e.entityUrl ? { url: toHttpUrl(e.entityUrl), external: true } : undefined,
                tooltip: e.entityId,
                searchValue: e.entityName,
            },
            // 2. Type
            {
                text: '',
                badges: [{ text: e.entityType, color: e.entityType === 'repository' ? 'blue' : e.entityType === 'service' ? 'cyan' : 'dim' }],
                filterValues: [e.entityType],
            },
            // 3. Activity
            (() => {
                const tier = tierFromCommits(e.livenessCommits);
                const tierRank: Record<string, number> = { elite: 4, high: 3, medium: 2, low: 1, unknown: 0 };
                const hasData = tier !== 'unknown';
                return {
                    text: '',
                    badges: hasData ? [{
                        ...getPulseBadge(e.livenessCommits),
                        pulse: tier === 'elite' || tier === 'high',
                    }] : [],
                    filterValues: hasData ? [getPulseBadge(e.livenessCommits).text] : [],
                    sortValue: tierRank[tier] ?? 0,
                };
            })(),
            // 4. Team
            teamCell,
            // 5. Compliance status
            complianceCell,
            // 6. Violations (Errors)
            countCell(e.errors, 'red'),
            // 7. Drifts (Warnings)
            countCell(e.warnings, 'yellow'),
            // 8. Advisories (Notes)
            countCell(e.notes, 'cyan'),
        ];

        // ── drawerData: full evaluation detail for the sidebar drawer ────────
        const allViolations = report.ruleBreakdown.flatMap(r =>
            r.violations.filter(v => v.entityId === e.entityId),
        );
        const allPassing = report.ruleBreakdown.flatMap(r =>
            r.evaluations.filter(ev => ev.entityId === e.entityId && ev.status === 'pass'),
        );
        const drawerData = {
            kind: 'governance-entity' as const,
            _rowId: e.entityId,
            entityName: e.entityName,
            entityType: e.entityType,
            entityUrl: e.entityUrl ? toHttpUrl(e.entityUrl) : null,
            errors: e.errors,
            warnings: e.warnings,
            notes: e.notes,
            rulesEvaluated: e.rulesEvaluated,
            rulesPassed: e.rulesPassed,
            violations: allViolations.map(v => ({
                level: v.level,
                ruleId: v.ruleId,
                ruleName: v.ruleName,
                detail: v.detail,
                structuredDetail: v.structuredDetail ?? null,
            })),
            passingRules: allPassing.map(p => ({
                ruleId: p.ruleId,
                ruleName: p.ruleName,
            })),
        };

        return { cells, drawerData: drawerData as Record<string, unknown> };
    });

    return {
        type: 'table',
        title: '',
        headers: [
            { label: 'Entity', meta: { width: '28%', maxWidth: '22vw', filter: true } },
            { label: 'Type', meta: { width: '8%', filter: true } },
            { label: 'Activity', meta: { width: '8%', filter: true, tooltip: 'How alive the repository is, measured by commits and distinct authors over the last 12 months.' } },
            { label: 'Team', meta: { width: '12%', filter: true } },
            { label: 'Policies', meta: { width: '10%', filter: true } },
            { label: 'Errors', meta: { width: '8%', filter: true } },
            { label: 'Warnings', meta: { width: '8%', filter: true } },
            { label: 'Notes', meta: { width: '8%', filter: true } },
        ],
        rows,
        tableOptions: { hideExport: true },
    };
}

// ── Rule Catalog table ───────────────────────────────────────────────────────

function buildRuleCatalogTable(catalog: GovernanceRuleCatalogEntry[], breakdown: GovernanceRuleResult[]): TableSection {
    // Sort: failing first (by violation count desc), then passing alphabetically
    const sorted = [...catalog].sort((a, b) => {
        const aFailing = a.violationCount > 0 ? 0 : 1;
        const bFailing = b.violationCount > 0 ? 0 : 1;
        if (aFailing !== bFailing) return aFailing - bFailing;
        if (a.violationCount !== b.violationCount) return b.violationCount - a.violationCount;
        return a.id.localeCompare(b.id);
    });

    const rows = sorted.map(rule => {
        const isPass = rule.ok && rule.violationCount === 0;
        const isFailed = !rule.ok; // query error

        // ── Status cell: inline compliance ratio ──────────────────────────
        let statusCell: TableCell;
        if (isFailed) {
            statusCell = {
                text: '',
                segments: [{ text: 'ERROR', color: 'red' }],
                sortValue: -1,
                filterValues: ['error'],
            };
        } else if (isPass) {
            const evalCount = rule.evaluatedCount >= 0 ? rule.evaluatedCount : 0;
            statusCell = {
                text: '',
                segments: [
                    { text: '✓', color: 'green' },
                    { text: `${evalCount}/${evalCount}`, color: 'green' },
                    { text: 'compliant', color: 'dim' },
                ],
                sortValue: 0,
                filterValues: ['pass'],
            };
        } else {
            // Failing: show compliant/evaluated ratio
            const evalCount = rule.evaluatedCount >= 0 ? rule.evaluatedCount : 0;
            const compCount = rule.compliantCount >= 0 ? rule.compliantCount : 0;
            const count = rule.violationCount;
            const lvlLabel = LEVEL_LABELS[rule.level];
            const noun = lvlLabel?.plural ?? 'error';
            const nounPlural = count !== 1 ? `${noun}s` : noun;
            statusCell = {
                text: '',
                segments: [
                    { text: '●', color: 'red' },
                    { text: `${compCount}/${evalCount}`, color: 'yellow' },
                    { text: `(${count} ${nounPlural})`, color: 'dim' },
                ],
                sortValue: count,
                filterValues: ['fail'],
                searchValue: `${count} ${nounPlural}`,
            };
        }

        const tagChips = (rule.tags ?? []).map(t => ({ text: t }));

        // Column order: ID · Name · Status · Impact · Tags
        const cells: TableCell[] = [
            // 0: ID (first, monospace, no-wrap)
            {
                text: rule.id,
                searchValue: rule.id,
                filterValues: [rule.id],
            },
            // 1: Name (tooltip = full description)
            { text: rule.name, tooltip: rule.description || undefined },
            // 2: Status (redesigned: compliance ratio)
            statusCell,
            // 3: Impact (requirement category badge)
            {
                text: '',
                badges: [{ text: LEVEL_LABELS[rule.level]?.badge.toLowerCase() ?? rule.level, color: (LEVEL_COLORS[rule.level] ?? 'dim') as 'red' | 'yellow' | 'cyan' }],
                filterValues: [LEVEL_LABELS[rule.level]?.badge.toLowerCase() ?? rule.level],
                // Numeric sort: error (0) → warning (1) → note (2). Ascending puts the
                // most impactful rules first, matching the badge's semantic weight.
                sortValue: LEVEL_SORT[rule.level] ?? 99,
            },
            // 4: Tags
            {
                text: '',
                items: tagChips.length > 0 ? tagChips : undefined,
                searchValue: (rule.tags ?? []).join(' '),
                // Alphabetic sort on the joined tag list. Empty-tagged rules sort last
                // when ascending so the tagged ones group together at the top.
                sortValue: (rule.tags ?? []).length > 0 ? (rule.tags ?? []).join(',') : '~',
            },
        ];

        const ruleResult = breakdown.find(b => b.ruleId === rule.id);
        const drawerData = {
            kind: 'governance-rule' as const,
            _rowId: rule.id,
            id: rule.id,
            name: rule.name,
            description: rule.description,
            level: rule.level,
            scope: rule.scope,
            query: rule.query,
            evaluatedCount: rule.evaluatedCount,
            compliantCount: rule.compliantCount,
            violations: ruleResult?.violations.map(v => ({
                entityId: v.entityId,
                entityName: v.entityName,
                entityType: v.entityType,
                teamOwner: v.teamOwner ?? null,
                detail: v.detail,
            })) ?? [],
            compliants: ruleResult?.evaluations
                .filter(e => e.status === 'pass')
                .map(e => ({
                    entityId: e.entityId,
                    entityName: e.entityName,
                    entityType: e.entityType,
                    teamOwner: e.teamOwner ?? null,
                })) ?? [],
        };

        return { cells, drawerData: drawerData as Record<string, unknown> };
    });

    return {
        type: 'table',
        title: '',
        headers: [
            // ID first, monospace, wider, never wraps
            { label: 'ID', meta: { width: '18%', filter: false, nowrap: true } },
            { label: 'Name', meta: { width: '30%', filter: true } },
            { label: 'Status', meta: { width: '22%', filter: true } },
            { label: 'Impact', meta: { width: '12%', filter: true } },
            { label: 'Tags', meta: { width: '18%', filter: true } },
        ],
        rows,
        tableOptions: { hideExport: true },
    };
}
