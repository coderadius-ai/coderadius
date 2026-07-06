import { Command } from 'commander';
import chalk from 'chalk';
import type { CatalogDriftReport } from '../../graph/queries/drift.js';

const DEFAULT_LIMIT = 20;

export function registerDriftCommand(parent: Command): void {
    parent
        .command('drift')
        .description('Compare catalog-declared truth vs code-extracted graph')
        .option('--json', 'Output as JSON')
        .option('--source <catalog>', 'Filter to a specific catalog source (backstage, cortex)')
        .option('--limit <n>', 'Max rows per section (0 = unlimited)', String(DEFAULT_LIMIT))
        .action(async (opts: { json?: boolean; source?: string; limit?: string }) => {
            const { closeNeo4j } = await import('../../graph/neo4j.js');
            const { getCatalogDriftReport } = await import('../../graph/queries/drift.js');
            try {
                const report = await getCatalogDriftReport(opts.source);
                if (opts.json) {
                    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
                } else {
                    renderDriftReport(report, parseInt(opts.limit ?? String(DEFAULT_LIMIT), 10));
                }
            } finally {
                await closeNeo4j();
            }
        });
}

function renderDriftReport(report: CatalogDriftReport, limit: number): void {
    const { summary, meta } = report;
    const cap = limit === 0 ? Infinity : limit;

    console.log();
    console.log(chalk.bold('  CODERADIUS CATALOG DRIFT REPORT'));
    if (meta.sourceFilter) {
        console.log(chalk.dim(`  Source filter: ${meta.sourceFilter}`));
    }
    console.log(chalk.dim(`  ${summary.totalCatalogEntities} catalog entities, ${summary.totalServices} services`));
    console.log();

    const scoreColor = summary.driftScore >= 90 ? chalk.green
        : summary.driftScore >= 70 ? chalk.yellow
        : chalk.red;
    console.log(`  Alignment score: ${scoreColor(summary.driftScore + '%')}  (${summary.entitiesWithGroundedDrift} entities with grounded drift / ${summary.driftDenominator} total)`);
    const covColor = summary.verifiableCoverage >= 75 ? chalk.green
        : summary.verifiableCoverage >= 40 ? chalk.yellow
        : chalk.dim;
    console.log(`  Verifiable coverage: ${covColor(summary.verifiableCoverage + '%')}  (share of declared dependencies groundable in scope)`);
    console.log(chalk.dim(`  Off-score: ${summary.ownerReconciledCount} owners aligned, ${summary.ownerReviewCount} owner review, ${summary.systemCompletenessCount} system completeness`));
    console.log();

    renderSection('Ghost Services', 'in catalog, not in code', report.ghostServices, cap,
        g => `  ${chalk.red(g.name.padEnd(30))} ${(g.catalogSource ?? '').padEnd(12)} ${g.owner ?? ''}`);

    renderSection('Orphan Services', 'in code, not in catalog', report.orphanServices, cap,
        o => `  ${chalk.yellow(o.name.padEnd(30))} ${(o.language ?? '').padEnd(12)} ${o.codeOwner ?? ''}`);

    renderSection('Dependency Drift', 'declared vs observed (grounded)', report.dependencyDrift, cap,
        d => `  ${d.serviceName.padEnd(30)} missing: ${chalk.red(d.groundedMissing.join(',') || '-')}  undeclared: ${chalk.yellow(d.observedUndeclared.join(',') || '-')}`);

    // Off-score sections (neutral, never red): owner name mismatches we cannot
    // ground, declared-but-unbuilt systems, and out-of-scope dependency refs.
    renderNeutralSection('Owner Review', 'catalog vs CODEOWNERS, ungrounded', report.ownerReview, cap,
        d => `  ${d.serviceName.padEnd(30)} catalog: ${chalk.cyan(d.catalogOwner.padEnd(16))} code: ${chalk.magenta(d.codeOwner)}`);

    renderNeutralSection('System Completeness', 'declared system, no membership built', report.systemCompleteness, cap,
        d => `  ${d.serviceName.padEnd(30)} declared: ${chalk.dim(d.declaredSystem)}`);

    renderUnverifiable(report.unverifiable, cap);
}

function renderUnverifiable(items: CatalogDriftReport['unverifiable'], cap: number): void {
    const count = items.length;
    const title = 'Unverifiable';
    const subtitle = 'declared, not groundable in scope';
    // Neutral (dim), never red: out-of-scope refs are not drift.
    console.log(`  ${chalk.dim(title)} ${chalk.dim(`(${subtitle})`)}${' '.repeat(Math.max(0, 50 - title.length - subtitle.length))}${chalk.dim(String(count))}`);
    if (count === 0) {
        console.log();
        return;
    }
    console.log(chalk.dim('  ' + '─'.repeat(70)));
    for (const item of items.slice(0, cap)) {
        console.log(`  ${item.serviceName.padEnd(30)} ${chalk.dim(item.refs.join(', '))}`);
    }
    if (count > cap) {
        console.log(chalk.dim(`  ... and ${count - cap} more`));
    }
    console.log();
}

// Off-score section: dim header, never red. Mirrors renderSection but the count
// carries no alarm — these items do not lower the alignment score.
function renderNeutralSection<T>(title: string, subtitle: string, items: T[], cap: number, format: (item: T) => string): void {
    const count = items.length;
    console.log(`  ${chalk.dim(title)} ${chalk.dim(`(${subtitle})`)}${' '.repeat(Math.max(0, 50 - title.length - subtitle.length))}${chalk.dim(String(count))}`);
    if (count === 0) {
        console.log();
        return;
    }
    console.log(chalk.dim('  ' + '─'.repeat(70)));
    for (const item of items.slice(0, cap)) {
        console.log(format(item));
    }
    if (count > cap) {
        console.log(chalk.dim(`  ... and ${count - cap} more`));
    }
    console.log();
}

function renderSection<T>(title: string, subtitle: string, items: T[], cap: number, format: (item: T) => string): void {
    const count = items.length;
    const color = count === 0 ? chalk.green : chalk.red;
    console.log(`  ${color(title)} ${chalk.dim(`(${subtitle})`)}${' '.repeat(Math.max(0, 50 - title.length - subtitle.length))}${color(String(count))}`);
    if (count === 0) {
        console.log();
        return;
    }
    console.log(chalk.dim('  ' + '─'.repeat(70)));
    const shown = items.slice(0, cap);
    for (const item of shown) {
        console.log(format(item));
    }
    if (count > cap) {
        console.log(chalk.dim(`  ... and ${count - cap} more`));
    }
    console.log();
}
