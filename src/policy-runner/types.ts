import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════════
// Policy Runner — Type System
//
// Defines the full type surface for the Policy-as-Code engine:
//   - PolicyRule:       a rule loaded from a YAML file
//   - PolicyEvaluation: a single evaluation result (pass or fail) for an entity
//   - PolicyReport:     the aggregated result of running all rules
//
// CONTRACT: every Cypher query in a PolicyRule MUST return these columns:
//   entityId   (string) — the cr: URN of the evaluated node
//   entityName (string) — human-readable name for display
//   entityType (string) — node label (repository, service, team, ...)
//   status     (string) — 'pass' or 'fail'
//   detail     (string) — specific detail for this entity (required for fail,
//                          may be empty for pass)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Rule Definition ─────────────────────────────────────────────────────────

export const PolicyLevelSchema = z.enum(['error', 'warning', 'note']);
export type PolicyLevel = z.infer<typeof PolicyLevelSchema>;

export const PolicyScopeSchema = z.enum(['repository', 'service', 'team', 'package', 'any']);
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

export const PolicyRuleSchema = z.object({
    /** Unique rule identifier — e.g. "gp-001". Used in evaluation URNs. */
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Rule id must be kebab-case'),
    /** Human-readable rule name. */
    name: z.string().min(1),
    /** Description of what this rule enforces and why. */
    description: z.string().optional(),
    /** Impact of violations: error blocks CI, warning is strongly recommended, note is optional. */
    level: PolicyLevelSchema,
    /** Primary node type this rule targets — used for grouping reports. */
    scope: PolicyScopeSchema,
    /**
     * Read-only Cypher query to run against Memgraph.
     *
     * MUST return columns: entityId, entityName, entityType, status, detail.
     * MUST NOT contain WRITE clauses (CREATE, MERGE, SET, DELETE).
     * Each row = one evaluated entity. status = 'pass' | 'fail'.
     */
    query: z.string().min(10),
    /** Stop evaluating remaining rules after the first violation from this rule. */
    failFast: z.boolean().optional().default(false),
    /** Optional tags for filtering/grouping rule sets. */
    tags: z.array(z.string()).optional().default([]),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

// ─── Evaluation Status ───────────────────────────────────────────────────────

export const PolicyStatusSchema = z.enum(['pass', 'fail']);
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface PolicyEvaluation {
    /** Stable URN: cr:eval:{ruleId}:{entityId} */
    id: string;
    ruleId: string;
    ruleName: string;
    level: PolicyLevel;
    scope: PolicyScope;
    /** Evaluation result: 'pass' = compliant, 'fail' = violation. */
    status: PolicyStatus;
    /** URN of the evaluated node in the graph. */
    entityId: string;
    /** Human-readable name of the evaluated entity. */
    entityName: string;
    /** Label of the evaluated node (Repository, Service, Team, …). */
    entityType: string;
    /** Specific detail for this entity. Required for fail, may be empty for pass. */
    detail: string;
    /** JSON-serialized GovernanceStructuredDetail. Set by executor from native Cypher maps. */
    structuredDetail?: string;
    /**
     * CSV string of the rule's tags (denormalised from PolicyRule.tags for
     * direct graph filtering and CSV export). Empty string when the rule
     * declares no tags.
     */
    tags: string;
    /** ISO timestamp of when this evaluation was produced. */
    evaluatedAt: string;
}

// ─── Rule Result ─────────────────────────────────────────────────────────────

export interface PolicyRuleResult {
    rule: PolicyRule;
    /** All evaluations (pass + fail) produced by this rule. */
    evaluations: PolicyEvaluation[];
    /** Subset: only failing evaluations. Derived from evaluations. */
    violations: PolicyEvaluation[];
    /** Subset: only passing evaluations. Derived from evaluations. */
    compliant: PolicyEvaluation[];
    /** True if the query executed successfully, false if it timed out or errored. */
    ok: boolean;
    /** Error message if the query failed. */
    error?: string;
    /** Query execution time in milliseconds. */
    executionMs: number;
}

// ─── Report ──────────────────────────────────────────────────────────────────

export type PolicyOutputMode = 'json' | 'sarif' | 'table' | 'graph';

export interface PolicyReport {
    generatedAt: string;
    rulesRun: number;
    rulesOk: number;
    rulesFailed: number;
    /** Total entities evaluated across all rules (pass + fail). */
    totalEvaluated: number;
    /** Total entities that passed all evaluated rules. */
    totalCompliant: number;
    /** Compliance percentage (totalCompliant / totalEvaluated * 100). */
    compliancePct: number;
    totalViolations: number;
    errorViolations: number;
    warningViolations: number;
    noteViolations: number;
    results: PolicyRuleResult[];
}

// ─── Structured Detail Schema ────────────────────────────────────────────────

const CheckItemSchema = z.object({
    label: z.string(),
    status: z.enum(['pass', 'fail', 'warn']),
});

/**
 * Validates and normalizes structuredDetail from Cypher.
 * - { checks, found } passes through (found: null → [])
 * - Bare array gets wrapped into { checks, found: [] }
 * - .catch(undefined): malformed data degrades gracefully without killing the row
 */
const StructuredDetailSchema = z.union([
    z.object({
        checks: z.array(CheckItemSchema),
        found: z.array(z.string()).nullish().transform(val => val ?? []),
    }),
    z.array(CheckItemSchema).transform(checks => ({ checks, found: [] as string[] })),
]);

// ─── Query Row Contract ───────────────────────────────────────────────────────

/**
 * Shape that every policy Cypher query MUST return.
 * Validated at runtime by the executor to catch misconfigured rules early.
 *
 * `status` is the evaluation result: 'pass' or 'fail'.
 * `detail` is required for fail rows and may be empty for pass rows.
 * `structuredDetail` is optional — rules that return it get rich checklist
 * rendering in the dashboard. If validation fails for structuredDetail,
 * .catch(undefined) silently drops it while preserving the core fields.
 */
export const PolicyQueryRowSchema = z.object({
    entityId: z.string(),
    entityName: z.string(),
    entityType: z.string(),
    status: PolicyStatusSchema,
    detail: z.string(),
    structuredDetail: StructuredDetailSchema.catch(undefined as any).optional(),
});
export type PolicyQueryRow = z.infer<typeof PolicyQueryRowSchema>;
