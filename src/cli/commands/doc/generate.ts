import type { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import * as p from '@clack/prompts';
import { logger } from '../../../utils/logger.js';
import { deduceTargetFromCwd } from '../../utils/helpers.js';

const MAX_SERVICES = 10;

export function registerDocGenerateCommand(docCmd: Command): void {
    docCmd.command('generate')
        .description('Generate architecture doc with C4 diagrams and risk analysis (supports up to 10 services)')
        .option(
            '-t, --target <services>',
            'Comma-separated service names (if omitted, opens interactive multi-select)',
        )
        .option(
            '-o, --output <path>',
            'Output file path (defaults to ./ARCHITECTURE.md or ./PLATFORM-ARCHITECTURE.md)',
        )
        .option(
            '--skip-risk',
            'Skip risk analysis (generate C4 diagrams only, faster)',
        )
        .action(async (opts: { target?: string; output?: string; skipRisk?: boolean }) => {
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            const { getAllServices } = await import('../../../graph/mutations/search.js');
            logger.info('CodeRadius Doc Generator\n');

            let targetServices: string[] = [];

            if (opts.target) {
                targetServices = opts.target.split(',').map(s => s.trim()).filter(Boolean);
            } else {
                const services = await getAllServices();
                if (services.length === 0) {
                    logger.error('No services found in the graph. Run "cr sync" first.');
                    process.exit(1);
                }

                const suggestedTarget = deduceTargetFromCwd(process.cwd());
                const hasSuggestion = services.some(s => s.name === suggestedTarget);

                if (services.length <= MAX_SERVICES) {
                    const response = await p.multiselect({
                        message: `Select services to document (max ${MAX_SERVICES}):`,
                        options: services.map(s => ({
                            value: s.name,
                            label: s.name,
                            hint: s.description || undefined,
                        })),
                        required: true,
                    });

                    if (p.isCancel(response)) {
                        logger.info('Operation cancelled.');
                        process.exit(0);
                    }
                    targetServices = response as string[];
                } else {
                    const response = await p.autocomplete({
                        message: 'Select a service (type to filter, run again to add more with --target):',
                        options: services.map(s => ({
                            value: s.name,
                            label: s.name,
                            hint: s.description || '',
                        })),
                        initialValue: hasSuggestion ? suggestedTarget : undefined,
                        maxItems: 10,
                    });

                    if (p.isCancel(response)) {
                        logger.info('Operation cancelled.');
                        process.exit(0);
                    }
                    targetServices = [response as string];
                }
            }

            if (targetServices.length === 0) {
                logger.error('No services specified.');
                process.exit(1);
            }

            if (targetServices.length > MAX_SERVICES) {
                logger.error(`Maximum ${MAX_SERVICES} services allowed. Got ${targetServices.length}.`);
                process.exit(1);
            }

            const isMulti = targetServices.length > 1;
            const defaultOutput = isMulti ? './PLATFORM-ARCHITECTURE.md' : './ARCHITECTURE.md';

            let outputPath = path.resolve(opts.output || defaultOutput);
            if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
                outputPath = path.join(outputPath, isMulti ? 'PLATFORM-ARCHITECTURE.md' : 'ARCHITECTURE.md');
            }

            const parentDir = path.dirname(outputPath);
            if (!fs.existsSync(parentDir)) {
                logger.info('Creating directory...');
                try {
                    fs.mkdirSync(parentDir, { recursive: true });
                } catch (err) {
                    logger.error(`Failed to create directory: ${(err as Error).message}`);
                    process.exit(1);
                }
            }

            try {
                const mode = opts.skipRisk ? 'C4 only' : 'C4 + Risk Analysis';
                const label = isMulti
                    ? `${targetServices.length} services: ${targetServices.join(', ')}`
                    : targetServices[0];
                logger.info(`Building enriched context for ${label} [${mode}]...`);

                let markdown: string;

                if (isMulti) {
                    const { buildMultiServiceDocContext } = await import('../../../graph/application/doc-generator.service.js');
                    const { generateMultiServiceDoc } = await import('../../../ai/agents/doc-generator.js');

                    const multiContext = await buildMultiServiceDocContext(targetServices, {
                        skipRisk: opts.skipRisk,
                    });

                    for (const svc of multiContext.services) {
                        const t = svc.topology;
                        logger.info(`   ${t.serviceName}: ${t.functions.length} functions, ${t.exposedEndpoints.length} endpoints, ${t.outbound.length} outbound, ${t.inbound.length} inbound`);
                    }
                    logger.info(`   Cross-service edges: ${multiContext.crossServiceEdges.length}`);

                    logger.info('\nGenerating Platform Architecture Doc...');
                    markdown = await generateMultiServiceDoc(multiContext);
                } else {
                    const { buildEnrichedDocContext } = await import('../../../graph/application/doc-generator.service.js');
                    const { generateArchitectureDoc } = await import('../../../ai/agents/doc-generator.js');

                    const enrichedContext = await buildEnrichedDocContext(targetServices[0], {
                        skipRisk: opts.skipRisk,
                    });

                    const { topology } = enrichedContext;

                    if (topology.functions.length === 0 && topology.outbound.length === 0 && topology.inbound.length === 0 && topology.exposedEndpoints.length === 0) {
                        logger.warn(`Service "${targetServices[0]}" not found in the graph or has no topology data.`);
                        process.exit(1);
                    }

                    logger.info(`   Functions: ${topology.functions.length}`);
                    logger.info(`   Exposed endpoints: ${topology.exposedEndpoints.length}`);
                    logger.info(`   Outbound dependencies: ${topology.outbound.length}`);
                    logger.info(`   Inbound consumers: ${topology.inbound.length}`);

                    if (enrichedContext.riskMetrics) {
                        const rm = enrichedContext.riskMetrics;
                        logger.info(`   Blast Radius Score: ${rm.blastRadiusScore}`);
                        logger.info(`   Downstream impacts: ${rm.downstreamServicesImpacted}`);
                        logger.info(`   Critical data deps: ${rm.criticalDataDependencies.length}`);
                    }

                    logger.info('\nGenerating Architecture Doc...');
                    markdown = await generateArchitectureDoc(enrichedContext);
                }

                fs.writeFileSync(outputPath, markdown, 'utf-8');

                logger.info(`\nArchitecture Doc generated successfully.`);
                logger.info(`Output: ${outputPath}\n`);
            } catch (err) {
                console.error('\nDoc generation failed:', (err as Error).message);
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });
}
