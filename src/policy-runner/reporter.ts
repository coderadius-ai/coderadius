import { getMemgraphDriver } from '../graph/neo4j.js';
import { logger } from '../utils/logger.js';
import type {
    PolicyReport,
    PolicyRuleResult,
    PolicyEvaluation,
    PolicyOutputMode,
    PolicyLevel,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Policy Reporter
//
// Converts a PolicyReport into the requested output format:
//
//   json  (default)  Pure JSON with full evaluation data (pass + fail).
//                    Suitable for CI/CD pipelines and programmatic use.
//
//   sarif            SARIF 2.1.0 format for GitHub/GitLab SAST integration.
//                    Pass records included with level: 'none'.
//
//   table            Human-readable ASCII table for terminal output.
//                    Shows pass/fail counts per rule.
//
//   graph            Writes PolicyEvaluation nodes to Memgraph (pass + fail).
//                    Uses full-replace strategy: delete old → write new.
//                    DOES NOT print to stdout; returns a summary string.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Report Builder ──────────────────────────────────────────────────────────

export function buildReport(results: PolicyRuleResult[]): PolicyReport {
    let totalViolations = 0;
    let errorViolations = 0;
    let warningViolations = 0;
    let noteViolations = 0;
    let rulesOk = 0;
    let rulesFailed = 0;

    // Track unique entities across all rules for global compliance
    const allEvaluatedEntityIds = new Set<string>();
    const allViolatingEntityIds = new Set<string>();

    for (const result of results) {
        if (!result.ok) {
            rulesFailed++;
            continue;
        }
        rulesOk++;
        totalViolations += result.violations.length;

        for (const e of result.evaluations) {
            allEvaluatedEntityIds.add(e.entityId);
        }
        for (const v of result.violations) {
            allViolatingEntityIds.add(v.entityId);
            if (v.level === 'error') errorViolations++;
            else if (v.level === 'warning') warningViolations++;
            else noteViolations++;
        }
    }

    const totalEvaluated = allEvaluatedEntityIds.size;
    const totalCompliant = totalEvaluated - allViolatingEntityIds.size;
    const compliancePct = totalEvaluated > 0
        ? Math.round((totalCompliant / totalEvaluated) * 100)
        : 0;

    return {
        generatedAt: new Date().toISOString(),
        rulesRun: results.length,
        rulesOk,
        rulesFailed,
        totalEvaluated,
        totalCompliant,
        compliancePct,
        totalViolations,
        errorViolations,
        warningViolations,
        noteViolations,
        results,
    };
}

// ─── Output Formatters ───────────────────────────────────────────────────────

export function renderReport(report: PolicyReport, mode: PolicyOutputMode): string {
    switch (mode) {
        case 'json': return renderJson(report);
        case 'sarif': return renderSarif(report);
        case 'table': return renderTable(report);
        case 'graph': return '[graph mode: evaluations written to Memgraph, run cr dashboard to view]';
    }
}

// ── JSON ─────────────────────────────────────────────────────────────────────

function renderJson(report: PolicyReport): string {
    return JSON.stringify(report, null, 2);
}

// ── SARIF 2.1.0 ─────────────────────────────────────────────────────────────

function renderSarif(report: PolicyReport): string {
    const rules = report.results.map(r => ({
        id: r.rule.id,
        name: r.rule.name,
        shortDescription: { text: r.rule.description ?? r.rule.name },
        properties: {
            tags: r.rule.tags,
            level: r.rule.level,
        },
    }));

    const results = report.results.flatMap(r =>
        r.evaluations.map(e => ({
            ruleId: e.ruleId,
            level: e.status === 'pass' ? 'none' : e.level,
            message: { text: `[${e.entityType}] ${e.entityName}: ${e.status === 'pass' ? 'compliant' : e.detail}` },
            locations: [
                {
                    logicalLocations: [
                        {
                            name: e.entityName,
                            kind: e.entityType,
                            fullyQualifiedName: e.entityId,
                        },
                    ],
                },
            ],
            properties: {
                status: e.status,
            },
        })),
    );

    const sarif = {
        $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: 'CodeRadius Policy Runner',
                        version: '1.0.0',
                        rules,
                    },
                },
                results,
            },
        ],
    };

    return JSON.stringify(sarif, null, 2);
}

// ── Table (terminal) ─────────────────────────────────────────────────────────

const LEVEL_COLOR: Record<PolicyLevel, string> = {
    error:   '\x1b[31m',  // red
    warning: '\x1b[33m',  // yellow
    note:    '\x1b[36m',  // cyan
};
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const GREEN = '\x1b[32m';

function renderTable(report: PolicyReport): string {
    const lines: string[] = [];
    const divider = '─'.repeat(80);

    lines.push(`${DIM}Generated: ${report.generatedAt}${RESET}`);
    lines.push(divider);

    for (const result of report.results) {
        if (!result.ok) {
            lines.push(`${LEVEL_COLOR.error}x ${result.rule.id}${RESET} ${result.rule.name}`);
            lines.push(`  ${DIM}Error: ${result.error}${RESET}`);
            lines.push('');
            continue;
        }

        const passCount = result.compliant.length;
        const failCount = result.violations.length;
        const totalCount = result.evaluations.length;
        const icon = failCount === 0 ? 'ok' : 'x';
        const color = failCount === 0 ? GREEN : LEVEL_COLOR[result.rule.level];

        lines.push(
            `${color}${icon} ${result.rule.id}${RESET} ${result.rule.name} ` +
            `${DIM}(${result.executionMs}ms)${RESET} ` +
            `${GREEN}${passCount} pass${RESET} / ${failCount > 0 ? LEVEL_COLOR[result.rule.level] : DIM}${failCount} fail${RESET} ${DIM}of ${totalCount}${RESET}`,
        );

        if (failCount > 0) {
            for (const v of result.violations) {
                lines.push(`  ${LEVEL_COLOR[v.level]}● ${v.entityName}${RESET}  ${DIM}${v.detail}${RESET}`);
            }
        }
        lines.push('');
    }

    lines.push(divider);
    const statusColor = report.errorViolations > 0 ? LEVEL_COLOR.error : GREEN;
    lines.push(
        `${BOLD}Summary:${RESET} ` +
        `${report.rulesRun} rules · ` +
        `${GREEN}${report.compliancePct}% compliant${RESET} · ` +
        `${statusColor}${report.errorViolations} errors${RESET} · ` +
        `${LEVEL_COLOR.warning}${report.warningViolations} warnings${RESET} · +` +
        `${LEVEL_COLOR.note}${report.noteViolations} notes${RESET}`,
    );

    return lines.join('\n');
}

// ── Graph Mode ───────────────────────────────────────────────────────────────

/**
 * Write PolicyEvaluation nodes to Memgraph (pass + fail), linking them to their entities.
 *
 * Node structure:
 *   (:PolicyEvaluation { id, ruleId, ruleName, severity, status, entityId, entityType, detail, evaluatedAt })
 *
 * Relationships:
 *   (Entity)-[:EVALUATED]->(PolicyEvaluation)
 *
 * Strategy: full replace. Delete all existing evaluations for the evaluated
 * rule IDs, then write fresh ones. No stale state accumulation.
 */
export async function writePolicyEvaluationsToGraph(report: PolicyReport): Promise<number> {
    const allEvaluations: PolicyEvaluation[] = report.results.flatMap(r => r.evaluations);
    if (allEvaluations.length === 0) return 0;

    // Ensure the PolicyEvaluation constraint exists (idempotent)
    await ensurePolicyEvaluationConstraint();

    const driver = getMemgraphDriver();
    const session = driver.session();
    let written = 0;

    try {
        // ── Full replace per ruleId ──────────────────────────────────────────
        // Delete every existing PolicyEvaluation whose ruleId is in this run
        // before writing the fresh batch. Without this step, a rule that
        // changes scope (e.g. service → repository) would leave orphan
        // evaluations of the old scope in the graph.
        const ruleIdsInRun = Array.from(new Set(report.results.map(r => r.rule.id)));
        if (ruleIdsInRun.length > 0) {
            await session.run(
                `MATCH (pe:PolicyEvaluation)
                 WHERE pe.ruleId IN $ruleIds
                 DETACH DELETE pe`,
                { ruleIds: ruleIdsInRun },
            );
        }

        // ── Group evaluations by entityType ──────────────────────────────────
        // Memgraph B-tree indexes are label-bound. Group by entityType and
        // inject the sanitized type as a Cypher label literal for O(1) lookup.
        const byType = new Map<string, PolicyEvaluation[]>();
        for (const e of allEvaluations) {
            const group = byType.get(e.entityType) ?? [];
            group.push(e);
            byType.set(e.entityType, group);
        }

        const BATCH_SIZE = 50;

        for (const [entityType, typeEvaluations] of byType.entries()) {
            // Sanitize: only allow [A-Za-z0-9] in label position
            const rawLabel = entityType.replace(/[^a-zA-Z0-9]/g, '');
            const safeLabel = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);
            if (!safeLabel) {
                logger.warn(`[PolicyReporter] Skipping ${typeEvaluations.length} evaluation(s) with invalid entityType: "${entityType}"`);
                continue;
            }

            for (let i = 0; i < typeEvaluations.length; i += BATCH_SIZE) {
                const batch = typeEvaluations.slice(i, i + BATCH_SIZE);

                await session.run(
                    // safeLabel is alphanumeric-only (sanitized above), safe to interpolate
                    `UNWIND $evaluations AS e
                     MERGE (pe:PolicyEvaluation { id: e.id })
                     SET pe.ruleId     = e.ruleId,
                         pe.ruleName   = e.ruleName,
                         pe.level      = e.level,
                         pe.scope      = e.scope,
                         pe.status     = e.status,
                         pe.entityId   = e.entityId,
                         pe.entityName = e.entityName,
                         pe.entityType = e.entityType,
                         pe.detail     = e.detail,
                         pe.structuredDetail = e.structuredDetail,
                         pe.tags       = e.tags,
                         pe.evaluatedAt = e.evaluatedAt
                     WITH pe, e
                     MATCH (entity:${safeLabel} { id: e.entityId })
                     MERGE (entity)-[:EVALUATED]->(pe)`,
                    { evaluations: batch },
                );

                written += batch.length;
            }
        }

        logger.debug(`[PolicyReporter] Wrote ${written} PolicyEvaluation node(s) to Memgraph (label-indexed).`);
    } finally {
        await session.close();
    }

    return written;
}

/**
 * Write PolicyRule metadata nodes to Memgraph.
 *
 * Node structure:
 *   (:PolicyRule { id, name, description, level, scope, tags, lastEvaluatedAt,
 *                  evaluatedCount, compliantCount, violationCount })
 *
 * This enables the dashboard to show a full "Rule Catalog" including rules
 * that pass 100% (which would otherwise be invisible from violations alone).
 */
export async function writePolicyRulesToGraph(report: PolicyReport): Promise<number> {
    if (report.results.length === 0) return 0;

    await ensurePolicyRuleConstraint();

    const session = getMemgraphDriver().session();
    try {
        const now = new Date().toISOString();
        const ruleRows = report.results.map(r => ({
            id: r.rule.id,
            name: r.rule.name,
            description: r.rule.description ?? '',
            level: r.rule.level,
            scope: r.rule.scope,
            tags: r.rule.tags ?? [],
            lastEvaluatedAt: now,
            evaluatedCount: r.ok ? r.evaluations.length : -1,
            compliantCount: r.ok ? r.compliant.length : -1,
            violationCount: r.ok ? r.violations.length : -1,
            ok: r.ok,
            error: r.error ?? null,
            query: r.rule.query,
        }));

        await session.run(
            `UNWIND $rules AS r
             MERGE (pr:PolicyRule { id: r.id })
             SET pr.name             = r.name,
                 pr.description      = r.description,
                 pr.level            = r.level,
                 pr.scope            = r.scope,
                 pr.tags             = r.tags,
                 pr.lastEvaluatedAt  = r.lastEvaluatedAt,
                 pr.evaluatedCount   = r.evaluatedCount,
                 pr.compliantCount   = r.compliantCount,
                 pr.violationCount   = r.violationCount,
                 pr.ok               = r.ok,
                 pr.error            = r.error,
                 pr.query            = r.query`,
            { rules: ruleRows },
        );

        logger.debug(`[PolicyReporter] Wrote ${ruleRows.length} PolicyRule node(s) to Memgraph.`);
        return ruleRows.length;
    } finally {
        await session.close();
    }
}


async function ensurePolicyEvaluationConstraint(): Promise<void> {
    const session = getMemgraphDriver().session();
    try {
        await session.run(
            `CREATE CONSTRAINT ON (n:PolicyEvaluation) ASSERT n.id IS UNIQUE;`,
        );
    } catch (err: unknown) {
        if (!(err as Error).message?.includes('already exists')) {
            logger.warn(`[PolicyReporter] PolicyEvaluation constraint warning: ${(err as Error).message}`);
        }
    } finally {
        await session.close();
    }
}

async function ensurePolicyRuleConstraint(): Promise<void> {
    const session = getMemgraphDriver().session();
    try {
        await session.run(
            `CREATE CONSTRAINT ON (n:PolicyRule) ASSERT n.id IS UNIQUE;`,
        );
    } catch (err: unknown) {
        if (!(err as Error).message?.includes('already exists')) {
            logger.warn(`[PolicyReporter] PolicyRule constraint warning: ${(err as Error).message}`);
        }
    } finally {
        await session.close();
    }
}

/**
 * Phase 1, pre-clean: delete ALL existing PolicyEvaluation nodes for the
 * rule IDs that are about to be re-evaluated.
 *
 * Full-replace strategy: each run produces a fresh snapshot of the compliance
 * state. No stale data, no resolvedAt/isActive flag management.
 */
export async function cleanPreviousEvaluations(ruleIds: string[]): Promise<void> {
    if (ruleIds.length === 0) return;
    const session = getMemgraphDriver().session();
    try {
        await session.run(
            `MATCH (pe:PolicyEvaluation)
             WHERE pe.ruleId IN $ruleIds
             DETACH DELETE pe`,
            { ruleIds },
        );
        logger.debug(`[PolicyReporter] Cleaned previous evaluations for ${ruleIds.length} rule(s).`);
    } finally {
        await session.close();
    }
}

// ─── Prune (explicit graph cleanup) ──────────────────────────────────────────
//
// There is no automatic orphan GC (tags are many-to-one, so they cannot
// identify a pack scope without risking deletion of unrelated packs). Removing
// rules from the graph is therefore an explicit, operator-driven operation
// exposed via `cr policy prune`.

/** A persisted PolicyRule catalog node, with the fields `prune` needs to scope. */
export interface PersistedPolicyRule {
    id: string;
    name: string;
    tags: string[];
}

/** List every PolicyRule catalog node persisted in the graph. */
export async function listPersistedPolicyRules(): Promise<PersistedPolicyRule[]> {
    const session = getMemgraphDriver().session();
    try {
        const res = await session.run(
            `MATCH (pr:PolicyRule) RETURN pr.id AS id, pr.name AS name, pr.tags AS tags`,
        );
        return res.records.map(r => ({
            id: r.get('id') as string,
            name: (r.get('name') as string) ?? (r.get('id') as string),
            tags: (r.get('tags') as string[] | null) ?? [],
        }));
    } finally {
        await session.close();
    }
}

/** Count persisted PolicyEvaluation nodes per ruleId (for prune previews). */
export async function countEvaluationsForRules(ruleIds: string[]): Promise<Record<string, number>> {
    if (ruleIds.length === 0) return {};
    const session = getMemgraphDriver().session();
    try {
        const res = await session.run(
            `MATCH (pe:PolicyEvaluation) WHERE pe.ruleId IN $ruleIds
             RETURN pe.ruleId AS id, count(pe) AS n`,
            { ruleIds },
        );
        const out: Record<string, number> = {};
        for (const r of res.records) out[r.get('id') as string] = Number(r.get('n'));
        return out;
    } finally {
        await session.close();
    }
}

/**
 * Delete the named PolicyRule catalog nodes and all their PolicyEvaluation
 * results. Returns how many of each were removed.
 */
export async function deletePolicyRulesAndEvaluations(
    ruleIds: string[],
): Promise<{ rules: number; evaluations: number }> {
    if (ruleIds.length === 0) return { rules: 0, evaluations: 0 };
    const session = getMemgraphDriver().session();
    try {
        const ruleCount = await session.run(
            `MATCH (pr:PolicyRule) WHERE pr.id IN $ruleIds RETURN count(pr) AS n`,
            { ruleIds },
        );
        const evalCount = await session.run(
            `MATCH (pe:PolicyEvaluation) WHERE pe.ruleId IN $ruleIds RETURN count(pe) AS n`,
            { ruleIds },
        );
        await session.run(
            `MATCH (pr:PolicyRule) WHERE pr.id IN $ruleIds DETACH DELETE pr`,
            { ruleIds },
        );
        await session.run(
            `MATCH (pe:PolicyEvaluation) WHERE pe.ruleId IN $ruleIds DETACH DELETE pe`,
            { ruleIds },
        );
        return {
            rules: Number(ruleCount.records[0]?.get('n') ?? 0),
            evaluations: Number(evalCount.records[0]?.get('n') ?? 0),
        };
    } finally {
        await session.close();
    }
}
