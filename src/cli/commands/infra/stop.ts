/**
 * radius down — Gracefully stop the Memgraph container.
 *
 * Data is persisted in Docker volumes by default.
 * Use --clean to remove everything (full reset).
 */
import { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';


export function registerStopCommand(program: Command): void {
    program
        .command('down')
        .description('Stop infrastructure services')
        .option('--clean', 'Remove container and volumes (full reset)')
        .action(async (opts: { clean?: boolean }) => {
            const { getContainerState, stopContainer, removeContainer, removeVolumes, isDockerInstalled, isDockerRunning } = await import('../../../infra/docker.service.js');
            console.log();
            p.intro(chalk.bgCyan.black(' CODERADIUS '));

            // Quick sanity checks
            if (!isDockerInstalled() || !isDockerRunning()) {
                p.log.warning('Docker is not available.');
                p.outro(chalk.dim('Nothing to stop.'));
                return;
            }

            const state = getContainerState();

            if (state === 'missing') {
                p.log.info('No Memgraph container found.');
                p.outro(chalk.dim('Nothing to stop.'));
                return;
            }

            const spinner = p.spinner();

            if (state === 'running') {
                spinner.start('Stopping Memgraph');
                try {
                    stopContainer();
                    spinner.stop('Memgraph stopped');
                } catch (err) {
                    spinner.stop('Failed to stop');
                    p.log.error((err as Error).message);
                    process.exit(1);
                }
            } else {
                p.log.info('Memgraph is already stopped.');
            }

            if (opts.clean) {
                const cleanSpinner = p.spinner();
                cleanSpinner.start('Removing container and volumes');
                try {
                    removeContainer();
                    removeVolumes();
                    cleanSpinner.stop('Container and volumes removed');
                } catch (err) {
                    cleanSpinner.stop('Cleanup failed');
                    p.log.warning((err as Error).message);
                }
            } else {
                p.log.info(chalk.dim('Data preserved in Docker volumes. Use --clean for full reset.'));
            }

            p.outro(chalk.green('Done.'));
        });
}
