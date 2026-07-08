/**
 * `cr analyze infra` — structural-only, zero-LLM infra ingestion.
 *
 * Ingests infrastructure declarations (RabbitMQ definitions.json, Helm/K8s,
 * Docker Compose, Crossplane CRDs, CI configs, agentic tooling) without
 * touching source code or paying the LLM cost of `cr analyze code`.
 *
 * Modelled on the structure-only branch of `code.ts`. Shares the rendering
 * helpers in `./shared.js` for consistency.
 *
 * Out of scope today (future infra plugin batch): Terraform, AWS CDK,
 * Pulumi, generic Crossplane CRDs. Adding any of those requires a new
 * plugin in `src/ingestion/structural/plugins/` — both this command and
 * `cr analyze code` will pick it up via `ingestStructural()`.
 */
import { Command } from 'commander';
import { Listr } from 'listr2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { logger, Logger } from '../../../utils/logger.js';

/**
 * Split inputs into (a) standalone files routed directly to a plugin and
 * (b) directories that flow through the governance scan. A file too deep to
 * be inside an obvious project root (no package.json / composer.json /
 * .git in any ancestor) cannot be resolved by `resolveAllSources`, so we
 * fast-path it instead of letting the scan silently skip it.
 */
function splitFileVsDirInputs(inputs: string[]): { files: string[]; dirs: string[] } {
    const files: string[] = [];
    const dirs: string[] = [];
    for (const input of inputs) {
        const abs = path.resolve(input);
        try {
            const stat = fs.statSync(abs);
            if (stat.isFile()) {
                files.push(abs);
                continue;
            }
            if (stat.isDirectory()) {
                dirs.push(input);
                continue;
            }
        } catch {
            // Path doesn't exist locally; let the governance scan attempt remote.
            dirs.push(input);
        }
    }
    return { files, dirs };
}

export function registerAnalyzeInfraCommand(analyzeCmd: Command): void {
    analyzeCmd
        .command('infra [paths...]')
        .description('Ingest infrastructure declarations (broker config, Helm, Docker Compose, CI) — zero LLM')
        .option('-v, --verbose', 'Enable verbose logging')
        .option('--trace [dir]', 'Generate a structured execution trace report (default: ~/.coderadius/traces/)')
        .option('--force', 'Bypass all caches (Merkle, Scout, Extractor) and re-extract from scratch')
        .option('--transparent-urns', 'Populate plaintext display fields for debug; broker URNs stay opaque/stable. Datastore fingerprints remain transparent.')
        .option('--json', 'Output telemetry report as JSON to stdout')
        .option('--paths-file <file>', 'Read source targets from file (one target per line)')
        .option('--source-strategy <strategy>', 'Source resolution strategy: cache | pull | ci')
        .action(async (paths: string[], opts: { verbose?: boolean; trace?: string | boolean; force?: boolean; json?: boolean; pathsFile?: string; sourceStrategy?: string; transparentUrns?: boolean }) => {
            if (opts.transparentUrns) {
                const { setUrnsTransparent } = await import('../../../utils/urn-transparency.js');
                setUrnsTransparent(true);
                logger.warn('[analyze infra] --transparent-urns active: broker IDs stay opaque; debug display fields may expose plaintext host/vhost.');
            }
            const { telemetryCollector, traceCollector } = await import('../../../telemetry/index.js');
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            const {
                printIngestHeader,
                renderIngestCompletion,
                renderGroundingBreakdown,
                resolveIngestListrRenderer,
                resolveIngestSourcePaths,
                shouldEmitTaskOutput,
            } = await import('./shared.js');
            if (opts.verbose) logger.setDebug(true);

            const rawSourcePaths = resolveIngestSourcePaths(paths, { pathsFile: opts.pathsFile });
            const { files: standaloneFiles, dirs: directories } = splitFileVsDirInputs(rawSourcePaths);
            const targetStr = rawSourcePaths.join(', ');
            const sessionId = crypto.randomUUID();

            const { getInfraIngestionSteps } = await import('../../../ingestion/workflows/infra-ingestion.workflow.js');
            const { detectSourceStrategy } = await import('../../../ingestion/core/source-resolver.js');
            const { ingestStandaloneInfraFile } = await import('../../../ingestion/structural/standalone-ingest.js');
            const { runReconcile } = await import('../../../ingestion/workflows/reconcile.workflow.js');

            if (opts.trace) {
                const traceDir = typeof opts.trace === 'string' ? opts.trace : undefined;
                traceCollector.enable(sessionId, traceDir);
            }

            printIngestHeader('Infra Ingestion', 'brokers  ·  helm/k8s  ·  ci  ·  agentic', targetStr, sessionId);

            const ingestionContext = {
                sessionId,
                sourcePaths: directories,
                repos: [],
                discoveredServiceRoots: [],
            };

            // Build the step list: standalone files first (each becomes a
            // single Listr task that routes directly to the matching plugin),
            // then the directory-based governance scan if any dirs remain.
            const standaloneSteps = standaloneFiles.map(absPath => ({
                title: `Ingesting ${path.basename(absPath)}`,
                run: async (_ctx: any, r: any) => {
                    const result = await ingestStandaloneInfraFile(absPath);
                    if (!result.pluginName) {
                        r.warn(`No structural plugin matched ${path.basename(absPath)}`);
                        return;
                    }
                    r.report(`Persisted ${result.entitiesPersisted} entities + ${result.edgesPersisted} edges via ${result.pluginName}`);
                },
            }));

            const reconcileAfterStandalone = standaloneFiles.length > 0 && directories.length === 0
                ? [{
                    title: 'Reconciling Graph State',
                    run: async (_ctx: any, r: any) => {
                        await runReconcile({ commitHash: 'SYSTEM' }, r);
                    },
                }]
                : [];

            const dirSteps = directories.length > 0
                ? getInfraIngestionSteps({
                    sourcePaths: directories,
                    debug: opts.verbose,
                    fresh: opts.force,
                    sourceStrategy: detectSourceStrategy(opts.sourceStrategy as any),
                })
                : [];

            const steps = [...standaloneSteps, ...dirSteps, ...reconcileAfterStandalone];

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
                        error: (msg: string) => task.output = `\x1b[31mx\x1b[0m ${msg}`,
                    }));
                },
            })), {
                concurrent: false,
                exitOnError: true,
                renderer: listrRenderer,
                rendererOptions: { collapseSubtasks: true, clearOutput: false, formatOutput: 'truncate' },
            });

            let traceFinalized = false;

            try {
                if (listrRenderer === 'default') logger.hijackConsole();
                try {
                    await tasks.run();
                } finally {
                    if (listrRenderer === 'default') logger.restoreConsole();
                }

                if (opts.json) {
                    process.stdout.write(JSON.stringify(telemetryCollector.toJSON(), null, 2) + '\n');
                } else {
                    let traceArtifacts;
                    if (opts.trace) {
                        const mdPath = await traceCollector.finalize();
                        traceFinalized = true;
                        if (mdPath) {
                            traceArtifacts = {
                                reportPath: mdPath,
                                rawJsonlPath: traceCollector.getJsonlPath() ?? undefined,
                            };
                        }
                    }

                    logger.funnel(telemetryCollector.generateFunnelReport());

                    const grounding = await renderGroundingBreakdown();
                    if (grounding.block) {
                        logger.log('');
                        logger.log(grounding.block);
                    }

                    logger.log(renderIngestCompletion({
                        title: 'Infra ingestion complete',
                        nextSteps: [
                            ...(grounding.needsReview > 0
                                ? [{ command: 'cr doctor', description: `${grounding.needsReview} gaps need your input — get coderadius.yaml fixes` }]
                                : []),
                            { command: 'cr analyze code .', description: 'Run full semantic code analysis' },
                            { command: 'cr analyze code . --depth=structure', description: 'Re-run structural scan plus deterministic reconciliation' },
                            { command: 'cr ui', description: 'Open architecture dashboard' },
                        ],
                        trace: traceArtifacts,
                    }));
                }
            } catch (err) {
                if (tasks.errors.length === 0) {
                    console.error('\nInfra ingestion failed:', (err as Error).message);
                    if (opts.verbose && (err as Error).stack) console.error((err as Error).stack);
                } else if (opts.verbose && (err as Error).stack) {
                    console.error((err as Error).stack);
                }
            } finally {
                if (opts.trace && !traceFinalized) {
                    const mdPath = await traceCollector.finalize();
                    if (mdPath) {
                        logger.log(`\nTrace report: ${mdPath}`);
                        const jsonlPath = traceCollector.getJsonlPath();
                        if (jsonlPath) logger.log(`Raw JSONL: ${jsonlPath}`);
                    }
                }
                await closeNeo4j();
                process.exit(tasks.errors.length > 0 ? 1 : 0);
            }
        });
}
