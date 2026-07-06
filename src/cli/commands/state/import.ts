/**
 * cr state import — Restore the architecture graph from a .cypherl snapshot.
 *
 * Reads a CYPHERL file (produced by `cr state export` or Memgraph Lab)
 * and pipes it into mgconsole via Docker stdin.  By default the existing
 * graph is wiped before importing to ensure a clean state.
 *
 * Use `--no-wipe` for additive imports (e.g. layering a second repo onto
 * an existing graph).
 */
import { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import fs from 'node:fs';



export function registerStateImportCommand(parent: Command): void {
    parent
        .command('import')
        .description('Import architecture graph from .cypherl snapshot')
        .argument('<file>', 'Path to .cypherl file')
        .option('--force', 'Skip confirmation prompt (for scripting/CI)')
        .option('--no-wipe', 'Don\'t clear the graph before import (additive)')
        .action(async (filePath: string, opts: { force?: boolean; wipe: boolean }) => {
            const { getContainerState, loadDatabase } = await import('../../../infra/docker.service.js');
            const { getMemgraphSession, closeNeo4j } = await import('../../../graph/neo4j.js');
            console.log();

            // Gate: file exists
            if (!fs.existsSync(filePath)) {
                p.log.error(`File not found: ${chalk.whiteBright(filePath)}`);
                process.exit(1);
            }

            // Gate: container running
            const state = getContainerState();
            if (state !== 'running') {
                p.log.error(
                    'Memgraph is not running. Start it with ' +
                    chalk.whiteBright('cr up') + '.'
                );
                process.exit(1);
            }

            // Confirmation (unless --force)
            if (!opts.force && opts.wipe) {
                p.intro(chalk.bgYellow.black(' STATE IMPORT '));

                p.log.warn(
                    chalk.yellow.bold('This will WIPE the current graph before importing.\n') +
                    chalk.dim('All existing nodes and relationships will be removed.\n') +
                    chalk.dim('Use ') + chalk.whiteBright('--no-wipe') +
                    chalk.dim(' to import additively instead.')
                );

                const confirmed = await p.confirm({
                    message: chalk.red.bold('Are you sure you want to wipe and import?'),
                    initialValue: false,
                });

                if (p.isCancel(confirmed) || !confirmed) {
                    p.cancel('Import cancelled. No changes were made.');
                    process.exit(0);
                }
            } else if (!opts.force) {
                p.intro(chalk.bgCyan.black(' STATE IMPORT '));
            }

            const spinner = p.spinner();

            // Read file
            const cypherl = fs.readFileSync(filePath, 'utf-8');
            const lineCount = cypherl.split('\n').filter(l => l.trim()).length;

            if (lineCount === 0) {
                p.log.warn('The file is empty — nothing to import.');
                process.exit(0);
            }

            // Wipe existing graph (unless --no-wipe)
            if (opts.wipe) {
                spinner.start('Wiping current graph...');
                const session = getMemgraphSession();
                try {
                    await session.run('MATCH (n) DETACH DELETE n');
                } finally {
                    await session.close();
                    await closeNeo4j();
                }
            }

            // Import via mgconsole stdin
            spinner.message(`Importing ${lineCount} statements via mgconsole...`);
            try {
                loadDatabase(cypherl);
            } catch (err: any) {
                spinner.stop('Import failed');
                p.log.error(`mgconsole error: ${err.message}`);
                process.exit(1);
            }

            spinner.stop(
                chalk.green('Imported') +
                chalk.dim(` — ${lineCount} statements from ${filePath}`)
            );

            await closeNeo4j();
            p.outro(chalk.dim('Graph state restored.'));
        });
}
