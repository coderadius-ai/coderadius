import { loadPolicies, type LoadPoliciesOptions } from './loader.js';
import { executeRules, type ExecutorOptions } from './executor.js';
import {
    buildReport,
    renderReport,
    writePolicyEvaluationsToGraph,
    writePolicyRulesToGraph,
    cleanPreviousEvaluations,
} from './reporter.js';
import { verifySandboxConnection, closeSandbox } from './sandbox.js';
import type { PolicyReport, PolicyOutputMode } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// PolicyRunner — Orchestrator
//
// Coordinates the full policy check lifecycle:
//   1. Verify Memgraph connectivity
//   2. Load + validate YAML rules
//   3. Execute queries via sandbox
//   4. Build report
//   5. Render to chosen output mode
//
// Graph mode lifecycle (full-replace of the evaluated rules only):
//   Phase 1: Clean — delete old PolicyEvaluation nodes for the evaluated rules
//   Phase 2: Write — persist new evaluations (pass + fail) + rule catalog
// No orphan GC: rules removed from a pack are reaped by an explicit operation,
// never as an implicit per-run side effect (tags cannot identify a pack scope).
// ═══════════════════════════════════════════════════════════════════════════════

export interface PolicyRunnerOptions {
    /**
     * Path to a single YAML file or a directory containing YAML rules. When
     * omitted, runs the built-in packs.
     */
    rulesPath?: string;
    /** Output format. Default: 'json'. */
    outputMode?: PolicyOutputMode;
    /** Only run rules with this level or higher. */
    minLevel?: 'note' | 'warning' | 'error';
    /** Only run rules with this tag. */
    filterTag?: string;
    /** Per-query timeout in milliseconds. Default: 5000ms. */
    queryTimeoutMs?: number;
    /** Progress callback — called after each rule completes. */
    onProgress?: (ruleId: string, violationCount: number, ok: boolean) => void;
}

export class PolicyRunner {
    private readonly opts: Required<Omit<PolicyRunnerOptions, 'filterTag' | 'onProgress' | 'rulesPath'>> &
        Pick<PolicyRunnerOptions, 'filterTag' | 'onProgress' | 'rulesPath'>;

    constructor(opts: PolicyRunnerOptions) {
        this.opts = {
            rulesPath: opts.rulesPath,
            outputMode: opts.outputMode ?? 'json',
            minLevel: opts.minLevel ?? 'note',
            filterTag: opts.filterTag,
            queryTimeoutMs: opts.queryTimeoutMs ?? 5_000,
            onProgress: opts.onProgress,
        };
    }

    /**
     * Run all matching policy rules and return the report.
     * Also renders the report to the configured output mode.
     *
     * @returns The PolicyReport (for programmatic use).
     *          The rendered string is available via renderReport(report, mode).
     */
    async run(): Promise<PolicyReport> {
        // 1. Verify Memgraph connectivity
        await verifySandboxConnection();

        // 2. Load + validate rules
        const loaderOpts: LoadPoliciesOptions = {
            rulesPath: this.opts.rulesPath,
            filterTag: this.opts.filterTag,
            minLevel: this.opts.minLevel,
        };
        const rules = await loadPolicies(loaderOpts);

        if (rules.length === 0) {
            const emptyReport = buildReport([]);
            return emptyReport;
        }

        // 3. Execute rules
        const executorOpts: ExecutorOptions = {
            timeoutMs: this.opts.queryTimeoutMs,
            onRuleComplete: this.opts.onProgress
                ? (result) => this.opts.onProgress?.(
                    result.rule.id,
                    result.violations.length,
                    result.ok,
                )
                : undefined,
        };

        const results = await executeRules(rules, executorOpts);

        // 4. Build report
        const report = buildReport(results);

        // 5. Handle graph output (full-replace lifecycle)
        if (this.opts.outputMode === 'graph') {
            const ruleIds = rules.map(r => r.id);
            // Full-replace the evaluations of the rules in THIS run, then persist
            // the rule catalog. No orphan GC: there is no reliable per-run signal
            // to reap rules removed from a pack without risking deletion of
            // unrelated packs (tags are many-to-one, so they cannot identify a
            // pack). Reaping rules removed from a pack is an explicit operation.
            await cleanPreviousEvaluations(ruleIds);
            await writePolicyEvaluationsToGraph(report);
            await writePolicyRulesToGraph(report);
        }

        return report;
    }
}

// Re-export key types for consumers that only import from index
export { buildReport, renderReport } from './reporter.js';
export { loadPolicies } from './loader.js';
export { closeSandbox } from './sandbox.js';
export type { PolicyReport, PolicyRule, PolicyEvaluation, PolicyRuleResult, PolicyOutputMode } from './types.js';
