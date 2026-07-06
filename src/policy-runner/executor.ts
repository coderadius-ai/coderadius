import { runSandboxQuery, type SandboxQueryOptions } from './sandbox.js';
import {
    type PolicyRule,
    type PolicyEvaluation,
    type PolicyRuleResult,
    PolicyQueryRowSchema,
} from './types.js';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Policy Executor
//
// Runs each PolicyRule's Cypher query in the sandbox and converts the result
// rows into PolicyEvaluation objects.
//
// Each row returned by the query is one evaluation (pass or fail).
// The executor partitions evaluations by status:
//   - violations: status = 'fail'
//   - compliant:  status = 'pass'
//
// The executor validates that each row satisfies the PolicyQueryRowSchema
// contract (entityId, entityName, entityType, status, detail). Rows that fail
// validation are skipped with a warning rather than crashing the report.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExecutorOptions extends SandboxQueryOptions {
    /** Called after each rule finishes. Useful for progress display. */
    onRuleComplete?: (result: PolicyRuleResult) => void;
    /**
     * Override the sandbox query function.
     * Used in unit tests to inject a mock without ESM module mocking.
     * Defaults to the real `runSandboxQuery` from sandbox.ts.
     */
    sandboxFn?: typeof runSandboxQuery;
}

/**
 * Execute all loaded policy rules and return their results.
 * Errors in individual rules are isolated — one failing query does not
 * prevent other rules from running.
 */
export async function executeRules(
    rules: PolicyRule[],
    options: ExecutorOptions = {},
): Promise<PolicyRuleResult[]> {
    const results: PolicyRuleResult[] = [];

    for (const rule of rules) {
        const result = await executeRule(rule, options);
        results.push(result);
        options.onRuleComplete?.(result);

        if (result.ok && result.violations.length > 0 && rule.failFast) {
            logger.debug(`[PolicyExecutor] failFast triggered by rule "${rule.id}". Stopping.`);
            break;
        }
    }

    return results;
}

/**
 * Execute a single policy rule.
 */
async function executeRule(
    rule: PolicyRule,
    options: ExecutorOptions,
): Promise<PolicyRuleResult> {
    const queryfn = options.sandboxFn ?? runSandboxQuery;
    let queryResult: Awaited<ReturnType<typeof runSandboxQuery>>;

    try {
        queryResult = await queryfn(rule.query, {}, { timeoutMs: options.timeoutMs });
    } catch (err) {
        const error = (err as Error).message;
        logger.warn(`[PolicyExecutor] Rule "${rule.id}" failed: ${error}`);
        return {
            rule,
            evaluations: [],
            violations: [],
            compliant: [],
            ok: false,
            error,
            executionMs: 0,
        };
    }

    const { rows, executionMs } = queryResult;
    const evaluations: PolicyEvaluation[] = [];
    const evaluatedAt = new Date().toISOString();

    for (const [rowIdx, row] of rows.entries()) {
        const parsed = PolicyQueryRowSchema.safeParse(row);
        if (!parsed.success) {
            // The rule's query is not returning the required columns.
            // This is a rule authoring error — log it clearly.
            const issues = parsed.error.issues
                .map(i => `"${i.path.join('.')}": ${i.message}`)
                .join('; ');
            logger.warn(
                `[PolicyExecutor] Rule "${rule.id}" row ${rowIdx} missing required columns: ${issues}\n` +
                `  Queries must return: entityId, entityName, entityType, status, detail`,
            );
            continue;
        }

        const { entityId, entityName, entityType, status, detail, structuredDetail: normalizedSD } = parsed.data;

        // Zod has already normalized structuredDetail to canonical { checks, found } shape.
        // Serialize to JSON string for graph persistence.
        const structuredDetail = normalizedSD
            ? JSON.stringify(normalizedSD)
            : undefined;

        evaluations.push({
            id: `cr:eval:${rule.id}:${entityId}`,
            ruleId: rule.id,
            ruleName: rule.name,
            level: rule.level,
            scope: rule.scope,
            status,
            entityId,
            entityName,
            entityType,
            detail,
            structuredDetail,
            tags: rule.tags?.join(',') ?? '',
            evaluatedAt,
        });
    }

    // Partition by status
    const violations = evaluations.filter(e => e.status === 'fail');
    const compliant = evaluations.filter(e => e.status === 'pass');

    logger.debug(
        `[PolicyExecutor] Rule "${rule.id}": ${compliant.length} pass, ${violations.length} fail in ${executionMs}ms`,
    );

    return {
        rule,
        evaluations,
        violations,
        compliant,
        ok: true,
        executionMs,
    };
}
