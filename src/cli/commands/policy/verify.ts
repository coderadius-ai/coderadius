import { Command } from 'commander';

import type { PolicyOutputMode } from '../../../policy-runner/types.js';


import fs from 'node:fs';
import path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
// `cr policy verify` Command
//
// Runs policy rules from a YAML file or directory against the Memgraph graph.
// Exits with code 1 if any violations match the --fail-on severity level.
// ═══════════════════════════════════════════════════════════════════════════════

interface PolicyVerifyOptions {
    rulesPath?: string;
    output: string;
    failOn?: string;
    timeout: string;
    tag?: string;
    minLevel?: string;
    out?: string;
}

export function registerPolicyVerifyCommand(parentCmd: Command): void {
    parentCmd
        .command('verify')
        .description('Run governance rules against the architecture')
        .option(
            '--rules-path <path>',
            'Path to a YAML policy file or directory of policy files (default: built-in packs)',
        )
        .option(
            '--output <mode>',
            'Output format: json, sarif, table, graph',
            'table',
        )
        .option(
            '--fail-on <level>',
            'Exit with code 1 if there are violations at or above this level (error, warning, note)',
            'error',
        )
        .option(
            '--timeout <ms>',
            'Per-query timeout in milliseconds (DoS guard)',
            '5000',
        )
        .option('--tag <tag>', 'Only run rules with this tag')
        .option(
            '--min-level <level>',
            'Only run rules at or above this level (note, warning, error)',
        )
        .option('--out <file>', 'Write output to a file instead of stdout')
        .action(async (opts: PolicyVerifyOptions) => {
            const { PolicyRunner, renderReport, closeSandbox } = await import('../../../policy-runner/index.js');
            const { CR_ICON } = await import('../../ui/logo.js');
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            const outputMode = opts.output as PolicyOutputMode;
            const validModes: PolicyOutputMode[] = ['json', 'sarif', 'table', 'graph'];
            if (!validModes.includes(outputMode)) {
                console.error(`\nInvalid --output mode: "${opts.output}". Valid: ${validModes.join(', ')}`);
                process.exit(1);
            }

            const timeoutMs = parseInt(opts.timeout, 10);
            if (isNaN(timeoutMs) || timeoutMs <= 0) {
                console.error(`\nInvalid --timeout value: "${opts.timeout}". Must be a positive integer.`);
                process.exit(1);
            }

            const isTableMode = outputMode === 'table';

            if (isTableMode) {
                console.log(`\n${CR_ICON} CodeRadius Policy Runner`);
                console.log(`   Rules: ${opts.rulesPath ? path.resolve(opts.rulesPath) : 'built-in packs'}`);
                console.log(`   Timeout: ${timeoutMs}ms per query\n`);
            }

            const runner = new PolicyRunner({
                rulesPath: opts.rulesPath,
                outputMode,
                queryTimeoutMs: timeoutMs,
                filterTag: opts.tag,
                minLevel: (opts.minLevel as 'note' | 'warning' | 'error') ?? 'note',
                // Live progress only for query errors. Pass/fail counts are
                // rendered once in the final report, so streaming them here
                // would just duplicate the same information.
                onProgress: isTableMode
                    ? (ruleId, _violationCount, ok) => {
                        if (!ok) {
                            process.stderr.write(`  ! ${ruleId}: query error\n`);
                        }
                    }
                    : undefined,
            });

            try {
                const report = await runner.run();
                const rendered = renderReport(report, outputMode);

                // Handle output destination
                if (opts.out) {
                    const outPath = path.resolve(opts.out);
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });
                    fs.writeFileSync(outPath, rendered + '\n', 'utf-8');
                    if (isTableMode) {
                        console.log(`\nReport written to: ${outPath}`);
                    }
                } else if (outputMode !== 'graph') {
                    process.stdout.write(rendered + '\n');
                } else {
                    // graph mode: evaluations written to DB, print a summary
                    const color = report.errorViolations > 0 ? '\x1b[31m' : '\x1b[32m';
                    const green = '\x1b[32m';
                    const reset = '\x1b[0m';
                    console.log(
                        `\n${color}●${reset} ${report.totalEvaluated} entities evaluated, ` +
                        `${green}${report.compliancePct}% compliant${reset} ` +
                        `(${report.totalViolations} violations: ${report.errorViolations} errors, ${report.warningViolations} warnings). ` +
                        `Run 'cr ui' to view the Governance panel.`,
                    );
                }

                // ── Exit code ────────────────────────────────────────────────
                const failOnLevel = opts.failOn;
                let shouldFail = false;
                if (failOnLevel === 'error' && report.errorViolations > 0) shouldFail = true;
                if (failOnLevel === 'warning' && (report.errorViolations + report.warningViolations) > 0) shouldFail = true;
                if (failOnLevel === 'note' && report.totalViolations > 0) shouldFail = true;

                if (shouldFail) process.exit(1);
            } catch (err) {
                if (outputMode === 'json' || outputMode === 'sarif') {
                    process.stderr.write(JSON.stringify({ error: (err as Error).message }) + '\n');
                } else {
                    console.error(`\nPolicy check failed: ${(err as Error).message}`);
                }
                process.exit(1);
            } finally {
                await closeSandbox();
                await closeNeo4j();
            }
        });
}
