import { Command, Option } from 'commander';
import { Listr } from 'listr2';
import crypto from 'node:crypto';


import { logger, Logger } from '../../../utils/logger.js';




import { type ScanMode, SCAN_MODES } from '../../../graph/scan-mode.js';

export function registerAnalyzeCodeCommand(analyzeCmd: Command): void {
    const codeCmd = analyzeCmd
        .command('code [paths...]')
        .description('Analyze source code, OpenAPI specs, and build the architecture graph')
        .option('-v, --verbose', 'Enable verbose logging')
        .option('--trace [dir]', 'Generate a structured execution trace report (default: ~/.coderadius/traces/)')
        .addOption(
            new Option('--depth <level>', 'Analysis depth: structure | semantic | contracts')
                .choices([...SCAN_MODES])
                .default('semantic'),
        )
        .option('--force', 'Bypass all caches (Merkle, Scout, Extractor) and re-analyze everything from scratch')
        .option('--transparent-urns', 'Populate plaintext display fields for debug; broker URNs stay opaque/stable. Datastore fingerprints remain transparent.')
        .option('--json', 'Output telemetry report as JSON to stdout')
        .option('--paths-file <file>', 'Read source targets from file (one target per line)')
        .option('--source-strategy <strategy>', 'Source resolution strategy: cache | pull | ci')
        .option('--llm-concurrency <n>', 'Override LLM parallelism level (1–20, default: 3)', (v: string) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 1 || n > 20) throw new Error('--llm-concurrency must be an integer between 1 and 20');
            return n;
        })
        .option('--taint-depth <n>', 'Override taint propagation max iterations (1-100, default: 32)', (v: string) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 1 || n > 100) throw new Error('--taint-depth must be an integer between 1 and 100');
            return n;
        });

    codeCmd.action(async (paths: string[], opts: { verbose?: boolean; trace?: string | boolean; depth?: ScanMode; force?: boolean; json?: boolean; pathsFile?: string; sourceStrategy?: string; llmConcurrency?: number; taintDepth?: number; transparentUrns?: boolean }) => {
            if (opts.transparentUrns) {
                const { setUrnsTransparent } = await import('../../../utils/urn-transparency.js');
                setUrnsTransparent(true);
                logger.warn('[analyze] --transparent-urns active: broker IDs stay opaque; debug display fields / datastore fingerprints may expose plaintext host/dbName.');
            }
            const { telemetryCollector, traceCollector } = await import('../../../telemetry/index.js');
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            const { getMastra } = await import('../../../ai/mastra/index.js');
            const { flushEmbeddingCache } = await import('../../../ai/embeddings.js');
            const { getRootShutdownController, ShutdownAbortError } = await import('../../../utils/shutdown.js');
            const {
                printIngestHeader,
                renderIngestCompletion,
                renderGroundingBreakdown,
                resolveIngestListrRenderer,
                resolveIngestSourcePaths,
                shouldEmitTaskOutput,
            } = await import('./shared.js');
            if (opts.verbose) logger.setDebug(true);

            const sourcePaths = resolveIngestSourcePaths(paths, { pathsFile: opts.pathsFile });

            const targetStr = sourcePaths.join(', ');
            const sessionId = crypto.randomUUID();
            const depth = opts.depth ?? 'semantic';

            // ── Structure-only mode (replaces old `cr sync meta`) ────────────
            if (depth === 'structure') {
                const { getGovernanceScanSteps } = await import('../../../ingestion/workflows/governance-scan.workflow.js');
                const { detectSourceStrategy } = await import('../../../ingestion/core/source-resolver.js');
                const { runReconcile } = await import('../../../ingestion/workflows/reconcile.workflow.js');

                printIngestHeader('Structural Analysis', 'topology  ·  agentic context  ·  api specs', targetStr, sessionId);

                const ingestionContext = {
                    sessionId,
                    sourcePaths,
                    repos: [],
                    discoveredServiceRoots: []
                };

                const { getPostIngestionStep } = await import('../../../policy-runner/auto-run.js');

                const steps = [
                    ...getGovernanceScanSteps({
                        sourcePaths,
                        debug: opts.verbose,
                        fresh: opts.force,
                        sourceStrategy: detectSourceStrategy(opts.sourceStrategy as any),
                    }),
                    {
                        title: 'Reconciling Graph State',
                        run: async (ctx: typeof ingestionContext, r: any) => {
                            await runReconcile({ repos: ctx.repos, commitHash: 'SYSTEM' }, r);
                        },
                    },
                    getPostIngestionStep(),
                ];

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

                    if (opts.json) {
                        process.stdout.write(JSON.stringify(telemetryCollector.toJSON(), null, 2) + '\n');
                    } else {
                        logger.funnel(telemetryCollector.generateFunnelReport());
                        logger.log(renderIngestCompletion({
                            title: 'Structural analysis complete',
                            nextSteps: [
                                { command: 'cr analyze code .', description: 'Run full semantic code analysis' },
                                { command: 'cr ui', description: 'Open architecture dashboard' },
                                { command: 'cr mcp configure', description: 'Connect to coding agents' },
                            ],
                        }));
                    }
                } catch (err) {
                    // Only print if Listr didn't already render the error in the persistent task list
                    if (tasks.errors.length === 0) {
                        console.error('\nAnalysis failed:', (err as Error).message);
                        if (opts.verbose && (err as Error).stack) console.error((err as Error).stack);
                    } else if (opts.verbose && (err as Error).stack) {
                        console.error((err as Error).stack);
                    }
                } finally {
                    await closeNeo4j();
                    process.exit(tasks.errors.length > 0 ? 1 : 0);
                }
                return;
            }

            // ── Semantic / Contracts mode (full code pipeline) ───────────────
            const { getGlobalCodeIngestionSteps } = await import('../../../ingestion/workflows/code-ingestion.workflow.js');

            if (opts.trace) {
                const traceDir = typeof opts.trace === 'string' ? opts.trace : undefined;
                traceCollector.enable(sessionId, traceDir);
            }

            const scopeParts = ['code', 'api contracts', 'cross-service'];
            if (depth === 'semantic' || depth === 'contracts') scopeParts.push('llm');
            if (depth === 'contracts') scopeParts.push('data contracts');
            const scopeLabel = scopeParts.join('  ·  ');
            printIngestHeader('Codebase Analysis', scopeLabel, targetStr, sessionId);

            const ingestionContext = {
                sessionId,
                sourcePaths,
                repos: [],
                discoveredServiceRoots: []
            };

            // ── Shutdown wiring (Ctrl+C fast path) ───────────────────────────
            // Register cleanup hooks against the process-wide ShutdownController
            // (installed in cli/index.ts). On 1st SIGINT the controller aborts
            // the signal we propagate into the pipeline, then runs these hooks
            // in parallel within the grace window (default 1s) before exit(130).
            const shutdown = getRootShutdownController();
            const unregisterHooks = [
                shutdown.register({
                    name: 'closeNeo4j',
                    timeoutMs: 800,
                    fn: () => closeNeo4j(),
                }),
                shutdown.register({
                    name: 'flushEmbeddingCache',
                    timeoutMs: 200,
                    fn: () => flushEmbeddingCache(),
                }),
                shutdown.register({
                    name: 'finalizeTrace',
                    timeoutMs: 200,
                    fn: async () => {
                        if (opts.trace) await traceCollector.finalize();
                    },
                }),
            ];

            const { getPostIngestionStep: getFullPostIngestionStep } = await import('../../../policy-runner/auto-run.js');

            const steps = [
                ...getGlobalCodeIngestionSteps({
                    sourcePaths,
                    debug: opts.verbose,
                    scanMode: depth,
                    fresh: opts.force,
                    sourceStrategy: (await import('../../../ingestion/core/source-resolver.js')).detectSourceStrategy(
                        opts.sourceStrategy as any
                    ),
                    llmConcurrency: opts.llmConcurrency,
                    taintPropagationLevels: opts.taintDepth,
                    signal: shutdown.signal,
                }),
                getFullPostIngestionStep(),
            ];

            const isLargeScan = sourcePaths.filter(
                p => p.startsWith('git@') || p.startsWith('https://') || p.startsWith('http://')
            ).length > 10;
            const listrRenderer = resolveIngestListrRenderer({ verbose: opts.verbose, isLargeScan });
            const emitTaskOutput = shouldEmitTaskOutput(listrRenderer, opts.verbose);

            const tasks = new Listr(steps.map(step => ({
                title: step.title,
                task: async (_ctx: any, task: any) => {
                    let totalUnits = 0;
                    let completedUnits = 0;
                    let unitName = 'items';
                    let currentPhase = '';
                    let startTime = Date.now();
                    let totalTokens = { in: 0, out: 0, cached: 0 };
                    // Throttle title updates to at most once every 250ms to reduce terminal flickering
                    let lastDisplayUpdate = 0;

                    const updateDisplay = (force = false) => {
                        const now = Date.now();
                        if (!force && now - lastDisplayUpdate < 250) return;
                        lastDisplayUpdate = now;

                        if (totalUnits > 0) {
                            const pct = Math.round((completedUnits / totalUnits) * 100);

                            let etaStr = '';
                            if (completedUnits > 0 && pct < 100) {
                                const elapsedMs = now - startTime;
                                const msPerUnit = elapsedMs / completedUnits;
                                const remainingUnits = totalUnits - completedUnits;
                                const remainingMs = remainingUnits * msPerUnit;

                                if (remainingMs > 60000) {
                                    etaStr = ` • ETA ${Math.round(remainingMs / 60000)}m`;
                                } else if (remainingMs > 0) {
                                    etaStr = ` • ETA ${Math.round(remainingMs / 1000)}s`;
                                }
                            }

                            let tokensStr = '';
                            if (totalTokens.in > 0 || totalTokens.out > 0) {
                                const formatNumber = (num: number) => {
                                    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
                                    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
                                    return num.toString();
                                };
                                const cachedStr = totalTokens.cached > 0 ? ` (${formatNumber(totalTokens.cached)} cached)` : '';
                                tokensStr = ` • ↑ ${formatNumber(totalTokens.in)}${cachedStr} ↓ ${formatNumber(totalTokens.out)}`;
                            }
                            task.title = `${step.title} [${completedUnits}/${totalUnits} ${unitName} • ${pct}%${etaStr}${tokensStr}]`;
                        } else if (currentPhase) {
                            task.title = `${step.title} [${currentPhase}]`;
                        }
                    };

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

                        setTotal: (total: number, label?: string) => {
                            totalUnits = total;
                            completedUnits = 0;
                            if (label) unitName = label;
                            startTime = Date.now();
                            updateDisplay(true);
                        },
                        increment: (count = 1, tokens: number | { in: number, out: number, cached?: number } = 0) => {
                            completedUnits += count;
                            if (typeof tokens === 'number') {
                                totalTokens.in += tokens;
                            } else if (tokens) {
                                totalTokens.in += tokens.in;
                                totalTokens.out += tokens.out;
                                totalTokens.cached += tokens.cached ?? 0;
                            }
                            if (completedUnits > totalUnits) completedUnits = totalUnits;
                            updateDisplay();
                        },
                        setPhase: (phase: string) => {
                            currentPhase = phase;
                            updateDisplay(true);
                        }
                    }));
                }
            })), {
                concurrent: false,
                exitOnError: true,
                renderer: listrRenderer,
                rendererOptions: { collapseSubtasks: true, clearOutput: false, formatOutput: 'truncate' }
            });

            let traceFinalized = false;

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

                if (opts.json) {
                    // Machine-readable output — write directly to stdout
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

                    telemetryCollector.exportEnrichmentCrashDump();
                    logger.funnel(telemetryCollector.generateFunnelReport());

                    // Grounding distribution: per-label tier counts. Skipped when
                    // the graph contains no inferred nodes (fresh DB / structural-only run).
                    const grounding = await renderGroundingBreakdown();
                    if (grounding.block) {
                        logger.log('');
                        logger.log(grounding.block);
                    }

                    logger.log(renderIngestCompletion({
                        title: 'Analysis complete',
                        nextSteps: [
                            ...(grounding.needsReview > 0
                                ? [{ command: 'cr doctor', description: `${grounding.needsReview} gaps need your input — get coderadius.yaml fixes` }]
                                : []),
                            { command: 'cr ui', description: 'Open architecture dashboard' },
                            { command: 'cr docs generate', description: 'Generate C4 Markdown' },
                            { command: 'cr mcp configure', description: 'Connect to coding agents' },
                        ],
                        trace: traceArtifacts,
                    }));

                }
            } catch (err) {
                if (err instanceof ShutdownAbortError || (err as Error)?.name === 'ShutdownAbortError') {
                    // Graceful interrupt — short, clean message, no stack.
                    console.error('\nAnalysis interrupted.');
                } else if (tasks.errors.length === 0) {
                    // Only print if Listr didn't already render the error in the persistent task list
                    console.error('\nAnalysis failed:', (err as Error).message);
                    if (opts.verbose && (err as Error).stack) console.error((err as Error).stack);
                } else if (opts.verbose && (err as Error).stack) {
                    console.error((err as Error).stack);
                }
            } finally {
                // Unregister cleanup hooks: a normal end runs the existing
                // finally block below, so we don't need the SIGINT-only fallback.
                for (const off of unregisterHooks) off();
                // ── Trace finalization ────────────────────────────────────────
                // Always finalize the trace — a failed run is the most valuable
                // one to inspect. Moved out of try{} so it runs on both success
                // and failure paths, before process.exit().
                if (opts.trace && !traceFinalized) {
                    const mdPath = await traceCollector.finalize();
                    if (mdPath) {
                        logger.log(`\nTrace report: ${mdPath}`);
                        const jsonlPath = traceCollector.getJsonlPath();
                        if (jsonlPath) {
                            logger.log(`Raw JSONL: ${jsonlPath}`);
                        }
                    }
                }

                await closeNeo4j();
                if (process.env.RADIUS_TRACE === 'true') {
                    try {
                        const mastra = getMastra();
                        if (mastra.observability && typeof (mastra.observability as any).shutdown === 'function') {
                            await (mastra.observability as any).shutdown();
                        }
                    } catch (e) {
                        // silently ignore telemetry flush errors on exit
                    }
                }
                process.exit(tasks.errors.length > 0 ? 1 : 0);
            }
        });
}
