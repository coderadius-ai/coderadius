import type { GovernanceReport } from '@coderadius/shared-types';
import { tierFromCommits } from '@coderadius/shared-types';
import type { GovernanceEntityDrawerData, GovernanceViolationDetail, GovernancePassingRule } from '../GovernanceDrawer';
import { toHttpUrl, repoPath, getPulseBadge, activityFromCommits } from '../../transformers/utils';

// ─── Row Types ──────────────────────────────────────────────────────────────

export interface ComplianceRow {
    entityId: string;
    entityName: string;
    displayName: string;
    entityType: string;
    entityUrl: string | null;
    teamOwner: string | null;
    livenessCommits: number | null;
    activityTier: string;
    activityScore: number;
    activityBadge: { text: string; color: string };
    errors: number;
    warnings: number;
    notes: number;
    total: number;
    rulesEvaluated: number;
    rulesPassed: number;
    complianceScore: number;
    worstLevel: number;
    violations: GovernanceViolationDetail[];
    passingRules: GovernancePassingRule[];
    drawerData: GovernanceEntityDrawerData;
    searchText: string;
}

export interface PolicyViolation {
    entityId: string;
    entityName: string;
    entityType: string;
    entityUrl: string | null;
    teamOwner: string | null;
    detail: string;
}

export interface PolicyCompliant {
    entityId: string;
    entityName: string;
    entityType: string;
    entityUrl: string | null;
    teamOwner: string | null;
}

export interface PolicyRow {
    ruleId: string;
    ruleName: string;
    ruleDescription: string;
    level: 'error' | 'warning' | 'note';
    levelRank: number;
    scope: string;
    tags: string[];
    query: string;
    evaluatedCount: number;
    compliantCount: number;
    violationCount: number;
    ok: boolean;
    hasError: boolean;
    violations: PolicyViolation[];
    compliants: PolicyCompliant[];
    searchText: string;
}

export interface GovernanceModel {
    complianceRows: ComplianceRow[];
    policyRows: PolicyRow[];
    compliancePct: number;
    complianceTone: 'ok' | 'warn' | 'danger';
    passingRules: number;
    totalRules: number;
    rulesTone: 'ok' | 'warn' | 'danger';
    errorViolations: number;
    warningViolations: number;
    noteViolations: number;
    entityCount: number;
    tabCounts: Record<string, number>;
    policyLevelCounts: { error: number; warning: number; note: number };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const LEVEL_SORT: Record<string, number> = { error: 0, warning: 1, note: 2 };

// ─── Entity Aggregation ─────────────────────────────────────────────────────

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
    rulesEvaluated: number;
    rulesPassed: number;
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
                    worstLevel: 3,
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
                const reqIdx = LEVEL_SORT[e.level] ?? 2;
                if (reqIdx < entry.worstLevel) entry.worstLevel = reqIdx;
            }
        }
    }

    return [...map.values()].sort((a, b) => {
        if (a.worstLevel !== b.worstLevel) return a.worstLevel - b.worstLevel;
        if (a.total !== b.total) return b.total - a.total;
        return a.entityName.localeCompare(b.entityName);
    });
}

// ─── Model Builder ──────────────────────────────────────────────────────────

export function buildGovernanceModel(report: GovernanceReport): GovernanceModel {
    const entities = aggregateByEntity(report);

    const complianceRows: ComplianceRow[] = entities.map(e => {
        const activityTier = tierFromCommits(e.livenessCommits);
        const activityScore = activityFromCommits(e.livenessCommits);
        const activityBadge = getPulseBadge(e.livenessCommits);
        const displayName = e.entityType === 'repository'
            ? repoPath(e.entityUrl, e.entityName)
            : e.entityName;

        const allViolations = report.ruleBreakdown.flatMap(r =>
            r.violations.filter(v => v.entityId === e.entityId),
        );
        const allPassing = report.ruleBreakdown.flatMap(r =>
            r.evaluations.filter(ev => ev.entityId === e.entityId && ev.status === 'pass'),
        );

        const drawerData: GovernanceEntityDrawerData = {
            kind: 'governance-entity',
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

        const complianceScore = e.rulesEvaluated > 0
            ? Math.round((e.rulesPassed / e.rulesEvaluated) * 100)
            : 0;

        return {
            entityId: e.entityId,
            entityName: e.entityName,
            displayName,
            entityType: e.entityType,
            entityUrl: e.entityUrl,
            teamOwner: e.teamOwner,
            livenessCommits: e.livenessCommits,
            activityTier,
            activityScore,
            activityBadge,
            errors: e.errors,
            warnings: e.warnings,
            notes: e.notes,
            total: e.total,
            rulesEvaluated: e.rulesEvaluated,
            rulesPassed: e.rulesPassed,
            complianceScore,
            worstLevel: e.worstLevel,
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
            drawerData,
            searchText: [e.entityName, e.entityType, e.teamOwner ?? ''].join(' ').toLowerCase(),
        };
    });

    const sortedCatalog = [...report.ruleCatalog].sort((a, b) => {
        const aFailing = a.violationCount > 0 ? 0 : 1;
        const bFailing = b.violationCount > 0 ? 0 : 1;
        if (aFailing !== bFailing) return aFailing - bFailing;
        if (a.violationCount !== b.violationCount) return b.violationCount - a.violationCount;
        return a.id.localeCompare(b.id);
    });

    const policyRows: PolicyRow[] = sortedCatalog.map(rule => {
        const ruleResult = report.ruleBreakdown.find(b => b.ruleId === rule.id);

        const violations: PolicyViolation[] = ruleResult?.violations.map(v => ({
            entityId: v.entityId,
            entityName: v.entityName,
            entityType: v.entityType,
            entityUrl: v.entityUrl ?? null,
            teamOwner: v.teamOwner ?? null,
            detail: v.detail,
        })) ?? [];

        const compliants: PolicyCompliant[] = ruleResult?.evaluations
            .filter(e => e.status === 'pass')
            .map(e => ({
                entityId: e.entityId,
                entityName: e.entityName,
                entityType: e.entityType,
                entityUrl: e.entityUrl ?? null,
                teamOwner: e.teamOwner ?? null,
            })) ?? [];

        return {
            ruleId: rule.id,
            ruleName: rule.name,
            ruleDescription: rule.description ?? '',
            level: rule.level,
            levelRank: LEVEL_SORT[rule.level] ?? 99,
            scope: rule.scope ?? '',
            tags: rule.tags ?? [],
            query: rule.query ?? '',
            evaluatedCount: rule.evaluatedCount,
            compliantCount: rule.compliantCount,
            violationCount: rule.violationCount,
            ok: rule.ok,
            hasError: !rule.ok && rule.violationCount === 0,
            violations,
            compliants,
            searchText: [rule.id, rule.name, rule.description ?? '', ...(rule.tags ?? [])].join(' ').toLowerCase(),
        };
    });

    const totalRules = report.ruleCatalog.length;
    const passingRules = report.ruleCatalog.filter(r => r.ok && r.violationCount === 0).length;
    const compliancePct = report.compliancePct;

    return {
        complianceRows,
        policyRows,
        compliancePct,
        complianceTone: compliancePct >= 90 ? 'ok' : compliancePct >= 70 ? 'warn' : 'danger',
        passingRules,
        totalRules,
        rulesTone: passingRules === totalRules ? 'ok' : passingRules >= totalRules * 0.7 ? 'warn' : 'danger',
        errorViolations: report.errorViolations,
        warningViolations: report.warningViolations,
        noteViolations: report.noteViolations,
        entityCount: entities.length,
        tabCounts: {
            compliance: entities.length,
            policies: totalRules,
        },
        policyLevelCounts: {
            error: policyRows.filter(r => r.level === 'error').length,
            warning: policyRows.filter(r => r.level === 'warning').length,
            note: policyRows.filter(r => r.level === 'note').length,
        },
    };
}
