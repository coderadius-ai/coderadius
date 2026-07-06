import { Command } from 'commander';
import { Listr } from 'listr2';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';


import { logger, Logger } from '../../../utils/logger.js';



export function registerAnalyzeTracesCommand(analyzeCmd: Command): void {
    analyzeCmd
        .command('traces')
        .description('Analyze runtime telemetry to map real cross-service dependencies')
        .requiredOption('-f, --file <path>', 'Path to Datadog/Jaeger JSON traces file')
        .option('-v, --verbose', 'Enable verbose logging')
        .action(async (opts: { file: string; verbose?: boolean }) => {
            const { getGlobalTraceIngestionSteps } = await import('../../../ingestion/workflows/trace-ingestion.workflow.js');
            const { telemetryCollector } = await import('../../../telemetry/index.js');
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            const {
                printIngestHeader,
                resolveIngestListrRenderer,
                shouldEmitTaskOutput,
            } = await import('./shared.js');
            if (opts.verbose) logger.setDebug(true);

            const sessionId = crypto.randomUUID();
            const tracesPath = path.resolve(opts.file);

            if (!fs.existsSync(tracesPath)) {
                console.error('\nTraces file not found:', tracesPath);
                process.exit(1);
            }

            printIngestHeader('Telemetry Analysis Session', 'runtime traces  ·  dependencies', tracesPath);

            const ingestionContext = {
                sessionId,
                tracesPath,
                spansProcessed: 0
            };

            const steps = getGlobalTraceIngestionSteps({ tracesPath, debug: opts.verbose });

            const listrRenderer = resolveIngestListrRenderer({ verbose: opts.verbose });
            const emitTaskOutput = shouldEmitTaskOutput(listrRenderer, opts.verbose);

            const tasks = new Listr(steps.map(step => ({
                title: step.title,
                task: async (_ctx: any, task: any) => {
                    const setTaskOutput = (msg: string) => {
                        if (opts.verbose) {
                            const time = Logger.formatTimestamp();
                            task.output = `\x1b[90m[${time}] ·\x1b[0m ${msg}`;
                        } else {
                            task.output = msg;
                        }
                    };

                    await logger.withDiagnosticSink(({ level, message }) => {
                        if (level === 'warn') {
                            task.output = `\x1b[33m!\x1b[0m ${message}`;
                        } else if (level === 'error') {
                            task.output = `\x1b[31mx\x1b[0m ${message}`;
                        } else {
                            setTaskOutput(message);
                        }
                    }, () => step.run(ingestionContext, {
                        report: (msg: string) => {
                            if (!emitTaskOutput) return;
                            setTaskOutput(msg);
                        },
                        updateTitle: (title: string) => task.title = title,
                        warn: (msg: string) => task.output = `\x1b[33m!\x1b[0m ${msg}`,
                        error: (msg: string) => task.output = `\x1b[31mx\x1b[0m ${msg}`
                    }));
                }
            })), {
                concurrent: false,
                exitOnError: true,
                renderer: listrRenderer,
                rendererOptions: { collapseSubtasks: true, clearOutput: false, formatOutput: 'truncate' }
            });

            try {
                // Initialize Mastra early to propagate the silent logger to all cached agents
                // This prevents rogue LLM SDK errors from corrupting the Listr UI natively.
                const { getMastra } = await import('../../../ai/mastra/index.js');
                getMastra();

                if (listrRenderer === 'default') {
                    logger.hijackConsole();
                }
                try {
                    await tasks.run();
                } finally {
                    if (listrRenderer === 'default') {
                        logger.restoreConsole();
                    }
                }
                logger.funnel(telemetryCollector.generateFunnelReport());
                logger.info('Telemetry analysis complete.');
            } catch (err) {
                // Only print if Listr didn't already render the error in the persistent task list
                if (tasks.errors.length === 0) {
                    console.error('\nAnalysis failed:', (err as Error).message);
                }
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });
}
