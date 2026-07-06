import { Command } from 'commander';
import { Listr } from 'listr2';

import { logger } from '../../../utils/logger.js';

export function registerAnalyzeVulnCommand(analyzeCmd: Command): void {
    analyzeCmd
        .command('vuln')
        .description('Scan dependencies for known vulnerabilities (CVEs) via OSV.dev')
        .option('-v, --verbose', 'Enable verbose logging')
        .option('--refresh', 'Force re-fetch from OSV even if cache is fresh')
        .option('--offline', 'Skip API calls, use cached data only')
        .option('--json', 'Output results as JSON')
        .action(async (opts: { verbose?: boolean; refresh?: boolean; offline?: boolean; json?: boolean }) => {
            const { closeNeo4j, initSchema } = await import('../../../graph/neo4j.js');

            if (opts.verbose) logger.setDebug(true);

            try {
                const { enrichVulnerabilities } = await import('../../../ingestion/enrichment/index.js');

                const tasks = new Listr([
                    {
                        title: 'Bootstrapping Graph Engine',
                        task: async () => { await initSchema(); },
                    },
                    {
                        title: 'Scanning for Vulnerabilities',
                        task: async (_, task) => {
                            const reporter = {
                                report: (msg: string) => { task.output = msg; },
                                warn: (msg: string) => { task.output = `⚠ ${msg}`; },
                                error: (msg: string) => { task.output = `✖ ${msg}`; },
                            };

                            const result = await enrichVulnerabilities(
                                'VULN_SCAN',
                                reporter,
                                { refresh: opts.refresh, offline: opts.offline },
                            );

                            if (opts.json) {
                                console.log(JSON.stringify(result, null, 2));
                            }

                            task.title = result.vulnsFound > 0
                                ? `Found ${result.vulnsFound} vulnerabilities across ${result.packagesScanned} packages`
                                : `No known vulnerabilities found (${result.packagesScanned} packages scanned)`;
                        },
                    },
                ], {
                    concurrent: false,
                    rendererOptions: { collapseSubtasks: false },
                });

                await tasks.run();
            } catch (err: any) {
                logger.error(`Vulnerability scan failed: ${err.message}`);
                process.exitCode = 1;
            } finally {
                await closeNeo4j();
            }
        });
}
