/**
 * Governance Query — Reads PolicyEvaluation nodes from the graph.
 *
 * This is the READ side of the evaluation model:
 *   - `cr policy verify --output graph` (WRITER) creates PolicyEvaluation nodes (pass + fail)
 *   - `cr ui` (READER) calls this function to fetch them
 *
 * Returns null if no evaluations exist (governance tab won't appear in dashboard).
 */

import { getMemgraphDriver } from '../neo4j.js';

/** Safe integer extraction from Neo4j Integer objects */
function toNumber(val: any): number {
    if (val == null) return 0;
    if (typeof val === 'number') return val;
    if (typeof val?.toNumber === 'function') return val.toNumber();
    return Number(val) || 0;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GovernanceEvaluation {
    id: string;
    ruleId: string;
    ruleName: string;
    level: 'error' | 'warning' | 'note';
    scope: string;
    status: 'pass' | 'fail';
    entityId: string;
    entityName: string;
    entityType: string;
    entityUrl: string | null;
    /** Team that owns this entity (from OWNS relationship). Null if unowned. */
    teamOwner: string | null;
    /** Raw commit count over the last 12 months (no-merges) on the repository.
     *  The discrete tier is derived on read via `tierFromCommits()` in
     *  `@coderadius/shared-types/liveness`. */
    livenessCommits: number | null;
    /** Repository name that holds this entity. For entities of type Repository this equals entityName. */
    repoName: string | null;
    /** Backstage System that contains this entity (directly for Services, transitively for Repositories). */
    systemName: string | null;
    /** CSV string of the rule's tags, denormalised from PolicyRule.tags for CSV export and direct filtering. */
    tags: string;
    detail: string;
    /** Parsed structured detail — rich checklist data. Null for legacy evaluations. */
    structuredDetail?: { checks: { label: string; status: string }[]; found: string[] } | null;
    evaluatedAt: string;
}

export interface GovernanceRuleResult {
    ruleId: string;
    ruleName: string;
    level: 'error' | 'warning' | 'note';
    scope: string;
    /** All evaluations for this rule (pass + fail). */
    evaluations: GovernanceEvaluation[];
    /** Failing evaluations only. */
    violations: GovernanceEvaluation[];
    /** Number of unique entities evaluated by this rule. */
    evaluatedCount: number;
    /** Number of unique entities that passed this rule. */
    compliantCount: number;
    /** The original Cypher query of the rule. */
    query: string;
}

export interface GovernanceRuleCatalogEntry {
    id: string;
    name: string;
    description: string;
    level: 'error' | 'warning' | 'note';
    scope: string;
    tags: string[];
    lastEvaluatedAt: string;
    evaluatedCount: number;
    compliantCount: number;
    violationCount: number;
    ok: boolean;
    error: string | null;
    query: string;
}

export interface GovernanceReport {
    generatedAt: string;
    /** Total unique entities evaluated across all rules. */
    totalEvaluated: number;
    /** Total unique entities that passed ALL evaluated rules. */
    totalCompliant: number;
    /** Compliance percentage. */
    compliancePct: number;
    totalViolations: number;
    errorViolations: number;
    warningViolations: number;
    noteViolations: number;
    ruleBreakdown: GovernanceRuleResult[];
    rulesViolated: number;
    ruleCatalog: GovernanceRuleCatalogEntry[];
}

// ─── Query ───────────────────────────────────────────────────────────────────

/**
 * Read all PolicyEvaluation nodes from the graph (pass + fail).
 * Returns null if no evaluations exist — the governance tab won't appear.
 *
 * Performance: single indexed read, typically <10ms on a 50k-node graph.
 */
export async function getGovernanceReport(): Promise<GovernanceReport | null> {
    const session = getMemgraphDriver().session();
    try {
        const result = await session.run(`
            MATCH (pe:PolicyEvaluation)
            OPTIONAL MATCH (entity)-[:EVALUATED]->(pe)
            // Repository context: an entity reaches its Repository via either
            //   (Repo)-[:CONTAINS]->(entity)   for SourceFile/Function/Class
            //   (entity)-[:STORED_IN]->(Repo)  for Service/Library
            // Coalesce both so service-level evaluations carry their repo name
            // and liveness signal in the CSV.
            OPTIONAL MATCH (repo:Repository)-[:CONTAINS]->(entity)
            OPTIONAL MATCH (entity)-[:STORED_IN]->(repoVia:Repository)
            // Team ownership: collect all team names, take the first.
            // Uses collect(DISTINCT ...) to prevent Cartesian products when
            // a repo has multiple services each owned by different teams.
            OPTIONAL MATCH (t:Team)-[:OWNS]->(entity)
            OPTIONAL MATCH (t2:Team)-[:OWNS]->(:Service)-[:STORED_IN]->(entity)
            // Backstage System: direct (Service) or transitive via stored Service (Repository).
            OPTIONAL MATCH (sys:System)-[:CONTAINS]->(entity)
            OPTIONAL MATCH (sys2:System)-[:CONTAINS]->(:Service)-[:STORED_IN]->(entity)
            WITH pe, entity, repo, repoVia,
                 collect(DISTINCT t.name) + collect(DISTINCT t2.name) AS teamNames,
                 collect(DISTINCT sys.name) + collect(DISTINCT sys2.name) AS systemNames
            WITH pe, entity, repo, repoVia,
                 [n IN teamNames WHERE n IS NOT NULL] AS filteredTeams,
                 [n IN systemNames WHERE n IS NOT NULL] AS filteredSystems
            RETURN pe.id AS id, pe.ruleId AS ruleId, pe.ruleName AS ruleName,
                   pe.level AS level, pe.scope AS scope,
                   pe.status AS status,
                   pe.entityId AS entityId, pe.entityName AS entityName,
                   pe.entityType AS entityType, pe.detail AS detail,
                   pe.evaluatedAt AS evaluatedAt,
                   pe.structuredDetail AS structuredDetail,
                   pe.tags AS tags,
                   coalesce(entity.url, repo.url, repoVia.url) AS entityUrl,
                   coalesce(entity.livenessCommits, repo.livenessCommits, repoVia.livenessCommits) AS livenessCommits,
                   CASE WHEN size(filteredTeams) > 0 THEN filteredTeams[0] ELSE null END AS teamOwner,
                   coalesce(repo.name, repoVia.name, CASE WHEN 'Repository' IN labels(entity) THEN entity.name ELSE null END) AS repoName,
                   CASE WHEN size(filteredSystems) > 0 THEN filteredSystems[0] ELSE null END AS systemName
            ORDER BY pe.status DESC, pe.level, pe.ruleId, pe.entityName
        `);

        const rawEvaluations: GovernanceEvaluation[] = result.records.map(r => {
            // Defensive parse — old/corrupt data must not crash the dashboard
            let structuredDetail = null;
            const rawSD = r.get('structuredDetail');
            if (rawSD) {
                try { structuredDetail = JSON.parse(rawSD); }
                catch { /* swallow — corrupt data from old runs */ }
            }

            return {
                id: r.get('id'),
                ruleId: r.get('ruleId'),
                ruleName: r.get('ruleName'),
                level: r.get('level'),
                scope: r.get('scope') ?? 'any',
                status: r.get('status') ?? 'fail',
                entityId: r.get('entityId'),
                entityName: r.get('entityName'),
                entityType: r.get('entityType'),
                entityUrl: r.get('entityUrl') ?? null,
                livenessCommits: r.get('livenessCommits') != null ? toNumber(r.get('livenessCommits')) : null,
                teamOwner: r.get('teamOwner') ?? null,
                repoName: r.get('repoName') ?? null,
                systemName: r.get('systemName') ?? null,
                tags: r.get('tags') ?? '',
                detail: r.get('detail'),
                structuredDetail,
                evaluatedAt: r.get('evaluatedAt'),
            };
        });

        // Dedup safety net: OPTIONAL MATCH joins (e.g. team ownership)
        // can cause Cartesian products. Deduplicate by evaluation ID.
        const seen = new Set<string>();
        const evaluations: GovernanceEvaluation[] = [];
        for (const e of rawEvaluations) {
            if (!seen.has(e.id)) {
                seen.add(e.id);
                evaluations.push(e);
            }
        }

        // Group by ruleId
        const byRule = new Map<string, GovernanceEvaluation[]>();
        for (const e of evaluations) {
            const group = byRule.get(e.ruleId) ?? [];
            group.push(e);
            byRule.set(e.ruleId, group);
        }

        const ruleBreakdown: GovernanceRuleResult[] = [...byRule.entries()].map(
            ([ruleId, evals]) => {
                const violations = evals.filter(e => e.status === 'fail');
                return {
                    ruleId,
                    ruleName: evals[0]!.ruleName,
                    level: evals[0]!.level,
                    scope: evals[0]!.scope,
                    evaluations: evals,
                    violations,
                    evaluatedCount: new Set(evals.map(e => e.entityId)).size,
                    compliantCount: new Set(evals.filter(e => e.status === 'pass').map(e => e.entityId)).size,
                    query: '', // Will be matched with catalog below if needed
                };
            },
        );

        const violations = evaluations.filter(e => e.status === 'fail');
        let errorV = 0;
        let warningV = 0;
        let noteV = 0;
        for (const v of violations) {
            if (v.level === 'error') errorV++;
            else if (v.level === 'warning') warningV++;
            else noteV++;
        }

        // Global compliance: entity is compliant only if it passes ALL rules that evaluated it
        const allEvaluatedEntityIds = new Set(evaluations.map(e => e.entityId));
        const failingEntityIds = new Set(violations.map(e => e.entityId));
        const totalEvaluated = allEvaluatedEntityIds.size;
        const totalCompliant = totalEvaluated - failingEntityIds.size;
        const compliancePct = totalEvaluated > 0 ? Math.round((totalCompliant / totalEvaluated) * 100) : 0;

        // ── Also fetch PolicyRule catalog ─────────────────────────────────
        const catalogResult = await session.run(`
            MATCH (pr:PolicyRule)
            RETURN pr.id AS id, pr.name AS name, pr.description AS description,
                   pr.level AS level, pr.scope AS scope,
                   pr.tags AS tags, pr.lastEvaluatedAt AS lastEvaluatedAt,
                   pr.evaluatedCount AS evaluatedCount,
                   pr.compliantCount AS compliantCount,
                   pr.violationCount AS violationCount, pr.ok AS ok,
                   pr.error AS error, pr.query AS query
            ORDER BY pr.level, pr.id
        `);

        const ruleCatalog: GovernanceRuleCatalogEntry[] = catalogResult.records.map(r => ({
            id: r.get('id'),
            name: r.get('name'),
            description: r.get('description') ?? '',
            level: r.get('level'),
            scope: r.get('scope') ?? 'any',
            tags: r.get('tags') ?? [],
            lastEvaluatedAt: r.get('lastEvaluatedAt') ?? '',
            evaluatedCount: toNumber(r.get('evaluatedCount')),
            compliantCount: toNumber(r.get('compliantCount')),
            violationCount: toNumber(r.get('violationCount')),
            ok: r.get('ok') ?? true,
            error: r.get('error') ?? null,
            query: r.get('query') ?? '',
        }));

        // If no evaluations AND no rules, nothing to show
        if (evaluations.length === 0 && ruleCatalog.length === 0) return null;

        return {
            generatedAt: new Date().toISOString(),
            totalEvaluated,
            totalCompliant,
            compliancePct,
            totalViolations: violations.length,
            errorViolations: errorV,
            warningViolations: warningV,
            noteViolations: noteV,
            ruleBreakdown: ruleBreakdown.map(r => {
                const catalogMatch = ruleCatalog.find(c => c.id === r.ruleId);
                return { ...r, query: catalogMatch?.query ?? '' };
            }),
            rulesViolated: ruleBreakdown.filter(r => r.violations.length > 0).length,
            ruleCatalog,
        };
    } finally {
        await session.close();
    }
}
