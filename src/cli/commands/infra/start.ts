/**
 * cr up — Spin up the Memgraph graph database.
 *
 * Runs aggressive preflight checks, then starts (or creates) the container.
 * Uses @clack/prompts for a polished developer experience.
 */
import { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';




export function registerStartCommand(program: Command): void {
    program
        .command('up')
        .description('Start infrastructure services')
        .action(async () => {
            const { runPreflight, createAndStartContainer, startExistingContainer, waitForBolt } = await import('../../../infra/docker.service.js');
            const { initSchema } = await import('../../../graph/neo4j.js');
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            console.log();
            p.intro(chalk.bgCyan.black(' CODERADIUS '));

            const preflight = p.spinner();
            preflight.start('Checking environment');

            let checks;
            try {
                checks = await runPreflight();
            } catch (err) {
                preflight.stop('Environment check failed');
                p.log.error((err as Error).message);
                process.exit(1);
            }

            // Gate 1: Docker installed
            if (!checks.dockerInstalled) {
                preflight.stop('Docker not found');
                p.log.error('Docker is not installed.');
                p.log.info(`Install it from ${chalk.underline('https://docker.com/get-started')}`);
                process.exit(1);
            }

            // Gate 2: Docker daemon running
            if (!checks.dockerRunning) {
                preflight.stop('Docker daemon not running');
                p.log.error('Docker is installed but the daemon is not running.');
                p.log.info('Start Docker Desktop and try again.');
                process.exit(1);
            }

            // Gate 3: Init done
            if (!checks.initDone) {
                preflight.stop('Workspace not initialized');
                p.log.warning('Run `cr init` first to configure your environment.');
                process.exit(1);
            }

            // Gate 4: Already running
            if (checks.containerState === 'running') {
                preflight.stop('Graph database already running');
                p.log.success('Memgraph is already running on bolt://localhost:7687');
                p.outro(chalk.dim('Nothing to do.'));
                return;
            }

            // Gate 5: Port conflict (only if we don't own the container)
            if (!checks.portAvailable && checks.containerState === 'missing') {
                preflight.stop('Port 7687 is in use');
                p.log.error('Port 7687 is already in use by another process.');
                p.log.info('Free the port or stop the conflicting service, then try again.');
                process.exit(1);
            }

            preflight.stop('Environment verified');

            // ─── Start Container ─────────────────────────────────────────
            const startSpinner = p.spinner();

            try {
                if (checks.containerState === 'stopped') {
                    startSpinner.start('Restarting existing container');
                    startExistingContainer();
                } else {
                    startSpinner.start('Creating Memgraph container');
                    createAndStartContainer();
                }

                startSpinner.message('Waiting for database to be ready');
                await waitForBolt();

                // Bolt port opens before the query engine is fully ready.
                // A short settle avoids "Connection was closed by server" on first queries.
                startSpinner.message('Finalizing startup');
                await new Promise(r => setTimeout(r, 2000));

                startSpinner.stop('Graph database ready');
            } catch (err) {
                startSpinner.stop('Failed to start');
                p.log.error((err as Error).message);
                process.exit(1);
            }

            // ─── Schema Init (with retry — Memgraph may need a moment) ─────
            const schemaSpinner = p.spinner();
            schemaSpinner.start('Initializing schema');

            const MAX_SCHEMA_RETRIES = 3;
            let schemaOk = false;
            for (let attempt = 1; attempt <= MAX_SCHEMA_RETRIES; attempt++) {
                try {
                    await closeNeo4j();   // reset driver so it reconnects cleanly
                    await initSchema({ silent: true });
                    schemaOk = true;
                    break;
                } catch {
                    if (attempt < MAX_SCHEMA_RETRIES) {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            }
            await closeNeo4j();

            if (schemaOk) {
                schemaSpinner.stop('Schema initialized');
            } else {
                schemaSpinner.stop('Schema will initialize on first use');
            }

            // ─── Done ────────────────────────────────────────────────────
            const uri = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';
            const user = process.env.MEMGRAPH_USER || 'coderadius';
            const pass = process.env.MEMGRAPH_PASSWORD || 'coderadius';

            p.note(
                `Bolt  : ${uri}\nUser  : ${user}\nPass  : ${pass}`,
                'Connection Info'
            );

            p.outro(chalk.green('Ready.'));
        });
}
