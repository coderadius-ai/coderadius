/**
 * cr state export — Dump the architecture graph to a .cypherl snapshot.
 *
 * Uses Memgraph's native `DUMP DATABASE` via mgconsole inside the Docker
 * container.  The output is a text file where every line is a self-contained
 * Cypher statement — fully diffable in Git and re-importable into any
 * Memgraph (or Neo4j) instance.
 */
import { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';



export function registerStateExportCommand(parent: Command): void {
    parent
        .command('export')
        .description('Export architecture graph snapshot to .cypherl')
        .option('--out <path>', 'Output file path', './state.cypherl')
        .action(async (opts: { out: string }) => {
            const { getContainerState, dumpDatabase } = await import('../../../infra/docker.service.js');
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            console.log();
            p.intro(chalk.bgCyan.black(' STATE EXPORT '));

            const spinner = p.spinner();

            // Gate: container must be running
            spinner.start('Checking Memgraph container...');
            const state = getContainerState();
            if (state !== 'running') {
                spinner.stop('Container not running');
                p.log.error(
                    'Memgraph is not running. Start it with ' +
                    chalk.whiteBright('cr up') + '.'
                );
                process.exit(1);
            }

            // Dump via mgconsole
            spinner.message('Dumping database via mgconsole...');
            let cypherl: string;
            try {
                cypherl = dumpDatabase();
            } catch (err: any) {
                spinner.stop('Dump failed');
                p.log.error(`mgconsole error: ${err.message}`);
                process.exit(1);
            }

            // Handle empty graph
            if (!cypherl || cypherl.trim().length === 0) {
                spinner.stop('Graph is empty');
                p.log.warn('The graph contains no data. Nothing to export.');
                p.outro(chalk.dim('Run cr sync first to populate the graph.'));
                return;
            }

            // Resolve output path: if --out points to an existing directory,
            // write the default filename inside it.
            let outPath = opts.out;
            if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) {
                outPath = path.join(outPath, 'state.cypherl');
            }

            // Write to disk
            const lineCount = cypherl.split('\n').filter(l => l.trim()).length;
            fs.writeFileSync(outPath, cypherl + '\n', 'utf-8');
            const sizeKb = (Buffer.byteLength(cypherl, 'utf-8') / 1024).toFixed(1);

            spinner.stop(
                chalk.green('Exported') +
                chalk.dim(` , ${lineCount} statements, ${sizeKb} KB`)
            );

            await closeNeo4j();
            p.outro(chalk.dim(`Saved to ${outPath}`));
        });
}
