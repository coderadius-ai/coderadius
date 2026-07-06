/**
 * `cr validate` — validate the repo's declarative files without running
 * anything (terraform-validate style). Today it covers coderadius.yaml:
 * strict schema (typos surface as errors, unlike the lenient runtime loader)
 * plus a semantic dry-run against the repo (sections that match nothing).
 *
 * Offline by design: no graph, no LLM. Exit codes: 0 clean (warnings
 * allowed), 1 schema-invalid — CI/pre-commit friendly.
 */
import type { Command } from 'commander';
import path from 'node:path';
import chalk from 'chalk';
import { validateRepoHints, type HintsValidationReport } from '../../config/hints-validate.js';

function render(report: HintsValidationReport): void {
    console.log('');
    console.log(chalk.bold('  ⬢ coderadius.yaml validation'));
    console.log(chalk.dim(`  ${report.file ?? '(no file found)'}`));
    console.log('');

    if (report.schemaValid && report.issues.length === 0) {
        console.log(chalk.green('  ✓ schema valid, all declared sections match the codebase'));
    }

    for (const issue of report.issues) {
        const tag = issue.severity === 'error' ? chalk.red('✗ error  ') : chalk.yellow('⚠ warning');
        console.log(`  ${tag} ${chalk.dim(`[${issue.section}]`)} ${issue.message}`);
    }

    if (report.semantics.length > 0) {
        console.log('');
        console.log(chalk.bold('  Dry-run'));
        for (const s of report.semantics) {
            const dot = s.status === 'ok' ? chalk.green('●') : chalk.yellow('●');
            console.log(`   ${dot} ${chalk.dim(`[${s.section}]`)} ${s.subject} — ${s.detail}`);
        }
    }
    console.log('');
}

export function registerValidateCommand(program: Command): void {
    program
        .command('validate')
        .description('Validate the coderadius.yaml configuration')
        .option('--repo <path>', 'Repository root to validate (default: current directory)')
        .option('--json', 'Emit the raw report as JSON (for CI)')
        .action((opts: { repo?: string; json?: boolean }) => {
            const repoRoot = path.resolve(opts.repo ?? process.cwd());
            const report = validateRepoHints(repoRoot);

            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
            } else {
                render(report);
            }

            process.exit(report.schemaValid ? 0 : 1);
        });
}
