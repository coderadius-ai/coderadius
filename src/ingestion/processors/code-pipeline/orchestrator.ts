import pLimit from 'p-limit';

const commitHash = "SYSTEM";
import {
    generateEmbeddingsBatch,
    flushEmbeddingCache,
} from '../../../ai/embeddings.js';
import { ensureVectorIndexes } from '../../../graph/vector-indexes.js';
import { resolveEmbeddingDimension } from '../../../ai/embedding-model-meta.js';
import { configManager } from '../../../config/index.js';
import { deleteOrphanDataContainers, deleteOrphanDataStructures, deleteOrphanDatabaseEndpoints, deleteOrphanDatastores, deleteOrphanMessageChannels, inferAndLinkChannelSchemas, linkFieldsReferenceTypes, reconcileRenamedEntityTables, weldApiEndpointSchemasByFunction, weldChannelPayloadsByFunction } from '../../../graph/mutations/data-contracts.js';
import { updateRepositoryHash } from '../../../graph/mutations/merkle.js';
import { telemetryCollector, traceCollector } from '../../../telemetry/index.js';
import { logger } from '../../../utils/logger.js';
import {
    AIMDSemaphore,
    getDefaultAIMDSemaphore,
} from '../../../utils/aimd-semaphore.js';
import type { ResolvedRepo } from '../../../graph/types.js';
import { getQualifiedRepoName } from '../../../graph/urn.js';
import type { ScanMode } from '../../../graph/scan-mode.js';
import { loadRepoHints } from '../../../config/repo-hints.js';
import { loadRepoContext } from '../../../config/repo-context.js';
import type { DiscoveredService } from '../../extractors/autodiscovery.js';

// ── Pipeline Stages ──────────────────────────────────────────────────────────
import { discoverAndRoute } from './file-discovery.js';
import { analyzeFiles, processManifests } from './static-analyzer.js';
import { createSemanticBatchPool, extractSemantics } from './semantic-extractor.js';
import { writeToGraph } from './graph-writer.js';
import { diffMerkleIndexes } from '../../core/merkle-diff.js';
import { contractDeletedFiles, contractDeletedFunctions } from './contract.js';
import { reconcileEdges } from './edge-reconciler.js';
import type { MerkleIndex } from '../../core/merkle.js';
import type { SymbolRegistry } from '../../core/symbol-registry.js';

import type {
    SchemaContext,
    PipelineMetrics,
    ProgressReporter,
    AnalysisTask,
    StaticAnalysisResult,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Pipeline Orchestrator
//
// Wires the 4 pipeline stages together with per-file write-through:
//
//   Stage 1: File Discovery & Routing  → FileContext[]
//   Per file (parallel, p-limited):
//     Stage 2: Static Analysis         → AnalysisTask[]
//     Stage 3: Semantic Extraction     → ExtractedFunctionData[]
//     Stage 4: Graph Persistence       → write to Neo4j immediately
//
// Key design:
//   - Each file completes the FULL cycle (analyze → extract → embed → persist)
//     within its p-limit slot before moving to the next file
//   - CRASH RESILIENT: If interrupted, already-processed files have their
//     nodes in Neo4j. The Merkle cache (stored in Neo4j) will skip them
//     on re-run, preventing redundant LLM calls
//   - The repo hash is only updated after ALL files are successfully written
//
// ═══════════════════════════════════════════════════════════════════════════════

// LLM concurrency is now managed by AIMDSemaphore (see ingestCodePipeline body).
// The legacy LLM_CONCURRENCY env var is honored as a hard cap by getDefaultAIMDSemaphore().
const MEMGRAPH_WRITE_CONCURRENCY = parseInt(process.env.MEMGRAPH_CONCURRENCY || '10', 10); // Concurrency limit for Memgraph writes to prevent connection pool exhaustion

/**
 * The main pipeline entry point.
 *
 * Runs a per-file write-through pipeline:
 *   Stage 1 (discovery) → per file: Stage 2 (analyze) → Stage 3 (LLM) → embed → Stage 4 (Neo4j)
 *
 * CRASH RESILIENT: Each file's graph nodes are persisted immediately.
 * If interrupted, already-written files are skipped on re-run via
 * the Merkle cache (stored in Neo4j SourceFile/Function node hashes).
 */
export async function ingestCodePipeline(
    repos: ResolvedRepo[],
    task?: ProgressReporter,
    serviceRoots?: DiscoveredService[],
    scanMode: ScanMode = 'semantic',
    /** Per-repo symbol registries. The orchestrator picks the correct one for each file. */
    symbolRegistryByRepo?: Map<string, SymbolRegistry>,
    scoutedConfigFilesByRepo?: Map<string, Set<string>>,
    symbolTaintedFilesByRepo?: Map<string, Map<string, Set<string>>>,
    freshScan?: boolean,
    /** Override LLM concurrency. Priority: this value → LLM_CONCURRENCY env → default 3. */
    llmConcurrency?: number,
    taintPropagationLevels?: number,
    /**
     * Optional shutdown signal. When the user presses Ctrl+C, this signal
     * aborts and pending LLM backoff sleeps / queued limiter waiters wake
     * up immediately. Without it, the pipeline retains its prior semantics.
     */
    signal?: AbortSignal,
): Promise<PipelineMetrics> {
    const metrics: PipelineMetrics = {
        filesProcessed: 0,
        filesSkipped: 0,
        functionsIngested: 0,
        functionsSkipped: 0,
        functionsUnchanged: 0,
        errors: [],
    };

    // ── Adaptive LLM concurrency ─────────────────────────────────────────────
    // The AIMDSemaphore is the central back-pressure controller for all
    // pipeline LLM calls. It is threaded down to the agent boundary, where
    // `withCongestionControl` acquires a permit PER ATTEMPT (so retry sleeps
    // never hold a slot, honoring G1) and notifies the limiter on 429s so it
    // halves concurrency (G2). When the caller pins `llmConcurrency` from the
    // CLI we instantiate a local semaphore with soft=hard=N (no AIMD growth);
    // otherwise we share the process singleton so concurrent ingestion paths
    // coordinate on a single rate-limit budget.
    let llmLimiter: AIMDSemaphore;
    if (llmConcurrency !== undefined) {
        llmLimiter = new AIMDSemaphore({
            initialLimit: llmConcurrency,
            softMaxLimit: llmConcurrency,
            hardMaxLimit: llmConcurrency,
        });
    } else {
        llmLimiter = getDefaultAIMDSemaphore();
    }
    const limitChangeUnsub = llmLimiter.onLimitChange(e => {
        traceCollector.traceLLM(
            'CONCURRENCY',
            'limiter',
            `limit ${e.from}→${e.to} (${e.reason})`,
            {
                from: e.from,
                to: e.to,
                reason: e.reason,
                currentLimit: e.metrics.currentLimit,
                inFlight: e.metrics.inFlight,
            },
        );
    });

    const FILE_CONCURRENCY = parseInt(process.env.FILE_CONCURRENCY || '500', 10); // Increased default safely; can still be overridden via env
    const fileLimit = pLimit(FILE_CONCURRENCY);
    const writeMutex = pLimit(MEMGRAPH_WRITE_CONCURRENCY); // Initialize write mutex
    const effectiveServiceRoots = serviceRoots ?? [];

    const embCfg = configManager.getAiConfig('ingest');
    const embDim = resolveEmbeddingDimension(
        embCfg.embeddingProvider || embCfg.provider,
        embCfg.embeddingModel,
        configManager.getEmbeddingDimensionOverride(),
    );
    await ensureVectorIndexes(embDim);

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 1: Planning (Discovery + Static Analysis)
    // ═════════════════════════════════════════════════════════════════════

    if (task?.setPhase) task.setPhase('Discovering files and computing incremental hashes...');
    if (signal?.aborted) throw asAbortError(signal);
    const discoveryResults = await discoverAndRoute(repos, effectiveServiceRoots, task, scanMode, scoutedConfigFilesByRepo, symbolTaintedFilesByRepo, freshScan ?? false, taintPropagationLevels);

    let totalFunctionsToExtract = 0;
    let totalSchemasToExtract = 0;

    interface PlannedRepo {
        discoveryResult: import('./types.js').DiscoveryResult;
        manifestResults: import('./types.js').ManifestResult[];
        analysisResults: import('./types.js').StaticAnalysisResult[];
        cacheHitResults: import('./types.js').CacheHitResult[];
        repoHasErrors: boolean;
    }
    const plannedRepos: PlannedRepo[] = [];

    if (task?.setPhase) task.setPhase('Parsing source code and tracing I/O paths...');

    for (const discoveryResult of discoveryResults) {
        if (signal?.aborted) throw asAbortError(signal);
        const { repo } = discoveryResult;

        // Repo entirely unchanged — fast path
        if (discoveryResult.files.length === 0 && discoveryResult.skippedCount > 0) {
            metrics.filesSkipped += discoveryResult.skippedCount;
            telemetryCollector.incrementFileCacheHits(discoveryResult.skippedCount);
            if (task && logger.isDebugEnabled()) {
                task.report(`Repo "${repo.name}" unchanged. Skipping.`);
            }
            plannedRepos.push({
                discoveryResult,
                manifestResults: [],
                analysisResults: [],
                cacheHitResults: [],
                repoHasErrors: false,
            });
            continue;
        }

        metrics.filesSkipped += discoveryResult.skippedCount;

        // Process manifests
        const manifestResults = await processManifests(discoveryResult, task);
        metrics.filesProcessed += manifestResults.length;

        // Run analyzeFiles (Stage 2)
        // Plan v10 §C: thread the per-repo SymbolRegistry into analyzeFiles
        // so ValueResolutionIndex can consult it for DI binding lookups.
        // The registry is mutated in-place when the DI propagator runs (Step 2);
        // for Step 0 it is read-only.
        const qualifiedName = getQualifiedRepoName(repo);
        const symbolRegistry = symbolRegistryByRepo?.get(qualifiedName);
        const { analysisResults, cacheHitResults } = await analyzeFiles(
            discoveryResult,
            task,
            scanMode,
            symbolTaintedFilesByRepo?.get(qualifiedName),
            freshScan ?? false,
            taintPropagationLevels,
            symbolRegistry,
        );

        for (const cache of cacheHitResults) {
            metrics.filesSkipped++;
            metrics.functionsUnchanged += cache.unchangedFunctionCount;
            telemetryCollector.incrementFileCacheHits();
        }

        for (const res of analysisResults) {
            metrics.functionsSkipped += res.skippedFunctionCount;
            metrics.functionsUnchanged += res.unchangedFunctionCount;
            metrics.filesProcessed++;
            totalFunctionsToExtract += res.analysisTasks.length;
            if (res.schemaContext) totalSchemasToExtract++;
        }

        plannedRepos.push({
            discoveryResult,
            manifestResults,
            analysisResults,
            cacheHitResults,
            repoHasErrors: false,
        });
    }

    // Set the overall progress target for Phase 2
    if (task?.setTotal) {
        task.setTotal(totalFunctionsToExtract + totalSchemasToExtract, 'functions');
    }

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 1.5: Contract (Diff & Soft-Delete)
    // ═════════════════════════════════════════════════════════════════════

    if (task?.setPhase) task.setPhase('Computing global graph diffs and soft-deleting stale nodes...');

    for (const plan of plannedRepos) {
        const { discoveryResult, analysisResults, cacheHitResults } = plan;

        // Guard: if this repo had zero analyzed files AND zero cache hits, it means the
        // repo was entirely unchanged (skipped at discovery level). Building a newIndex
        // from empty lists would make every old file look "deleted" — a mass tombstone.
        // Skip the diff entirely; nothing changed so nothing needs to be retired.
        if (analysisResults.length === 0 && cacheHitResults.length === 0) {
            continue;
        }

        // Build the new Merkle Index state for this repository
        const newIndex: MerkleIndex = {
            repoHash: discoveryResult.repoHash,
            repoScanMode: scanMode,
            files: new Map()
        };

        // Cache hits are identical file entries
        for (const cache of cacheHitResults) {
            const oldEntry = discoveryResult.merkleIndex.files.get(cache.fileContext.relativePath);
            if (oldEntry) {
                newIndex.files.set(cache.fileContext.relativePath, oldEntry);
            }
        }

        // Analyzed files are the new file entries
        for (const res of analysisResults) {
            const functions = new Map<string, { sourceHash: string; hasIO: boolean }>();

            for (const t of res.analysisTasks) {
                functions.set(t.functionId, { sourceHash: t.functionHash, hasIO: false });
            }
            if (res.unchangedFunctions) {
                for (const uf of res.unchangedFunctions) {
                    const oldSourceHash = discoveryResult.merkleIndex.files.get(res.fileContext.relativePath)?.functions.get(uf.functionId)?.sourceHash || '';
                    functions.set(uf.functionId, { sourceHash: oldSourceHash, hasIO: false });
                }
            }
            newIndex.files.set(res.fileContext.relativePath, {
                fileHash: res.fileContext.fileHash,
                fileScanMode: scanMode,
                functions
            });
        }

        // Run the global diff engine
        const diff = diffMerkleIndexes(discoveryResult.merkleIndex, newIndex);

        // Execute Soft-Deletes
        if (diff.deletedFiles.length > 0) {
            await contractDeletedFiles(diff.deletedFiles, getQualifiedRepoName(discoveryResult.repo), commitHash);
        }
        if (diff.deletedFunctions.length > 0) {
            await contractDeletedFunctions(diff.deletedFunctions, commitHash);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 2: Execution (LLM Extraction + Graph Persistence)
    // ═════════════════════════════════════════════════════════════════════

    if (task?.setPhase) task.setPhase('Extracting semantics (LLM)...');

    for (const plan of plannedRepos) {
        const { discoveryResult, manifestResults, analysisResults, cacheHitResults } = plan;
        const { repo, repoHash } = discoveryResult;

        if (analysisResults.length === 0 && cacheHitResults.length === 0 && manifestResults.length === 0) {
            continue;
        }

        const writePromises: Promise<void>[] = [];

        // ── Deferred-retry queue ──────────────────────────────────────────────
        // Tasks whose LLM call exhausted the 10-attempt 429 budget land here
        // instead of being dropped. After the main extraction completes (limiter
        // idle), we run a single drain pass. The tuple keeps the owning
        // analysisResult so terminal failures can mark the right file INCOMPLETE.
        const deferredForRepo: Array<{ analysisResult: StaticAnalysisResult; task: AnalysisTask }> = [];

        // ── Cross-file singleton pool ─────────────────────────────────────────
        // Files run concurrently (fileLimit) but call extractSemantics per file,
        // so cross-file singleton functions never meet inside one call and each
        // would pay the full fixed prompt prefix alone. This per-repo pool lets
        // them share mixed batches across files. Per-repo on purpose: the
        // executors close over the repo's symbol registry and env-var dict.
        const repoBatchPool = createSemanticBatchPool(
            scanMode,
            symbolRegistryByRepo?.get(getQualifiedRepoName(repo)),
            loadRepoContext(repo.path).envVarDict,
            llmLimiter,
        );

        // Eagerly persist manifests and cache hits to Neo4j
        if (manifestResults.length > 0 || cacheHitResults.length > 0) {
            writePromises.push(writeMutex(async () => {
                try {
                    await writeToGraph([], [], [], manifestResults, [], cacheHitResults, task, scanMode);
                } catch (err) {
                    logger.error(`[Pipeline] Cache/Manifest graph write failed: ${(err as Error).message}`);
                }
            }));
        }


        // Process each file requiring LLM extraction via the shared concurrency limit
        const extractPromises = analysisResults.map(analysisResult => fileLimit(async (): Promise<void> => {
            if (signal?.aborted) throw asAbortError(signal);
            const fileContext = analysisResult.fileContext;

            try {
                if (task && logger.isDebugEnabled()) {
                    task.report(`Extracting semantics (LLM) for ${fileContext.relativePath} (${analysisResult.analysisTasks.length} functions)...`);
                }

                // ── Stage 3: Semantic Extraction (Chunked) ────────────
                const CHUNK_SIZE = 10;
                const totalChunks = Math.max(1, Math.ceil(analysisResult.analysisTasks.length / CHUNK_SIZE));
                let schemaExtracted = false;

                for (let c = 0; c < totalChunks; c++) {
                    const i = c * CHUNK_SIZE;
                    const chunkTasks = analysisResult.analysisTasks.slice(i, i + CHUNK_SIZE);
                    const schemaContexts = (!schemaExtracted && analysisResult.schemaContext) ? [analysisResult.schemaContext] : [];



                    if (chunkTasks.length === 0 && schemaContexts.length === 0) {
                        continue;
                    }

                    const semanticResult = await extractSemantics(
                        chunkTasks,
                        schemaContexts,
                        task,
                        scanMode,
                        llmLimiter,
                        // Use the registry scoped to THIS repo only, no cross-repo contamination
                        symbolRegistryByRepo?.get(getQualifiedRepoName(repo)),
                        // envVarDict for resolving {TEMPLATE} patterns in the sanitizer
                        loadRepoContext(repo.path).envVarDict,
                        signal,
                        repoBatchPool,
                    );

                    if (schemaContexts.length > 0) {
                        schemaExtracted = true;
                        if (task?.increment) task.increment(1, 0);
                    }

                    if (semanticResult.failedCount > 0 || semanticResult.schemaFailed) {
                        analysisResult.fileContext.fileHash = 'INCOMPLETE_DUE_TO_ERROR';
                        plan.repoHasErrors = true;
                        if (task && logger.isDebugEnabled()) {
                            task.report(`Marked ${fileContext.relativePath} as INCOMPLETE due to extraction errors.`);
                        }
                    }

                    // Deferred tasks are NOT failures yet; collect them for the
                    // post-batch drain pass. We deliberately do NOT mark the file
                    // INCOMPLETE here — only terminal-failed drain tasks will.
                    if (semanticResult.deferredTasks.length > 0) {
                        for (const t of semanticResult.deferredTasks) {
                            deferredForRepo.push({ analysisResult, task: t });
                        }
                    }

                    metrics.functionsSkipped += semanticResult.rejectedCount;

                    // ── Embeddings (per-chunk batch) ──────────────────────
                    const embeddingTexts = semanticResult.extractedFunctions.map(ef => {
                        const intentText = ef.analysis.intent || '';
                        return intentText || `${ef.chunk.name}: ${ef.chunk.sourceCode.substring(0, 200)} `;
                    });

                    let embeddings: (number[] | null)[] = [];
                    if (embeddingTexts.length > 0) {
                        embeddings = await generateEmbeddingsBatch(embeddingTexts);
                    }

                    // ── Stage 4: Write-through to Neo4j (Sequential) ────
                    const isLastChunk = c === totalChunks - 1;
                    const currentHash = analysisResult.fileContext.fileHash;
                    const draftHash = (isLastChunk || currentHash.startsWith('INCOMPLETE_'))
                        ? currentHash
                        : `INCOMPLETE_${currentHash}`;

                    const writeResultDraft = {
                        ...analysisResult,
                        fileContext: {
                            ...analysisResult.fileContext,
                            fileHash: draftHash,
                        },
                        unchangedFunctions: c === 0 ? analysisResult.unchangedFunctions : []
                    };

                    const writePromise = writeMutex(async () => {
                        try {
                            const persistResult = await writeToGraph(
                                semanticResult.extractedFunctions,
                                embeddings,
                                semanticResult.extractedSchemas,
                                [],
                                [writeResultDraft],
                                [],
                                task,
                                scanMode,
                            );
                            metrics.functionsIngested += persistResult.functionsIngested;

                            // ── Stage 5: Edge Reconciliation ─────────────────────
                            const repoHints = loadRepoHints(repo.path);
                            const repoCtx = loadRepoContext(repo.path);
                            for (const ef of semanticResult.extractedFunctions) {
                                const chunkEnvVars = (ef.chunk?.envVars ?? []) as string[];
                                await reconcileEdges(
                                    ef.functionId,
                                    ef.analysis,
                                    getQualifiedRepoName(repo),
                                    commitHash,
                                    repoHints,
                                    ef.resourceDeclarations ?? [],
                                    repoCtx.envVarDict,
                                    repoCtx.identities,
                                    chunkEnvVars,
                                );
                            }
                        } catch (err) {
                            const errMessage = (err as Error).message;
                            const msg = `[Pipeline] Error writing to graph for ${fileContext.absolutePath}: ${errMessage}`;
                            logger.error(msg);
                            metrics.errors.push(msg);
                            plan.repoHasErrors = true;
                            telemetryCollector.incrementErrors(msg);
                        }
                    });
                    writePromises.push(writePromise);
                }

            } catch (err) {
                const errMessage = (err as Error).message;
                const lowerMsg = errMessage.toLowerCase();

                if (lowerMsg.includes('credentials') || lowerMsg.includes('api key') || lowerMsg.includes('authentication') || lowerMsg.includes('unauthorized')) {
                    throw err;
                }

                const msg = `[Pipeline] Error processing ${fileContext.absolutePath}: ${errMessage} `;
                logger.error(msg);
                metrics.errors.push(msg);
                plan.repoHasErrors = true;
                telemetryCollector.incrementErrors(msg);
            }
        }));

        // Wait for all LLM extractions to finish for this repo
        await Promise.all(extractPromises);

        // Wait for all background graph writes to finish
        await Promise.all(writePromises);

        // ── Deferred-retry drain (single pass, same limiter) ───────────────
        // After the main batch, the AIMDSemaphore is effectively idle so the
        // few outlier functions that exhausted their 10-attempt 429 budget
        // succeed without contention. Terminal failures (still 429-exhausted)
        // are emitted as `[Deferred]` errors and mark their owning file
        // INCOMPLETE so the next sync re-attempts them naturally.
        if (deferredForRepo.length > 0) {
            if (task?.setPhase) {
                task.setPhase(`Retrying ${deferredForRepo.length} deferred function(s)...`);
            }

            const flatTasks: AnalysisTask[] = deferredForRepo.map(d => d.task);
            const taskToAnalysisResult = new Map<string, StaticAnalysisResult>();
            for (const { analysisResult, task: t } of deferredForRepo) {
                taskToAnalysisResult.set(t.functionId, analysisResult);
            }

            const drainResult = await extractSemantics(
                flatTasks,
                [],
                task,
                scanMode,
                llmLimiter,
                symbolRegistryByRepo?.get(getQualifiedRepoName(repo)),
                loadRepoContext(repo.path).envVarDict,
                signal,
            );

            // 1) Persist recovered functions (grouped by owning file)
            if (drainResult.extractedFunctions.length > 0) {
                const analysisResultsByPath = new Map<string, StaticAnalysisResult>();
                for (const ef of drainResult.extractedFunctions) {
                    const ar = taskToAnalysisResult.get(ef.functionId);
                    if (!ar) continue;
                    analysisResultsByPath.set(ar.fileContext.relativePath, ar);
                }

                const embeddingTexts = drainResult.extractedFunctions.map(ef => {
                    const intentText = ef.analysis.intent || '';
                    return intentText || `${ef.chunk.name}: ${ef.chunk.sourceCode.substring(0, 200)} `;
                });
                const embeddings = embeddingTexts.length > 0
                    ? await generateEmbeddingsBatch(embeddingTexts)
                    : [];

                const writeResultDrafts = Array.from(analysisResultsByPath.values()).map(ar => ({
                    ...ar,
                    unchangedFunctions: [],
                }));

                await writeMutex(async () => {
                    try {
                        const persistResult = await writeToGraph(
                            drainResult.extractedFunctions,
                            embeddings,
                            [],
                            [],
                            writeResultDrafts,
                            [],
                            task,
                            scanMode,
                        );
                        metrics.functionsIngested += persistResult.functionsIngested;

                        const repoHints = loadRepoHints(repo.path);
                        const repoCtx = loadRepoContext(repo.path);
                        for (const ef of drainResult.extractedFunctions) {
                            const chunkEnvVars = (ef.chunk as { envVars?: string[] })?.envVars ?? [];
                            await reconcileEdges(
                                ef.functionId,
                                ef.analysis,
                                getQualifiedRepoName(repo),
                                commitHash,
                                repoHints,
                                ef.resourceDeclarations ?? [],
                                repoCtx.envVarDict,
                                repoCtx.identities,
                                chunkEnvVars,
                            );
                        }
                        telemetryCollector.incrementDeferredRecovered(drainResult.extractedFunctions.length);
                    } catch (err) {
                        const errMessage = (err as Error).message;
                        const msg = `[Deferred] Error writing recovered functions for ${repo.name}: ${errMessage}`;
                        logger.error(msg);
                        metrics.errors.push(msg);
                        plan.repoHasErrors = true;
                        telemetryCollector.incrementErrors(msg);
                    }
                });
            }

            // 2) Terminal-failed deferred tasks → real errors + INCOMPLETE files
            for (const stillDeferred of drainResult.deferredTasks) {
                const owner = taskToAnalysisResult.get(stillDeferred.functionId);
                const msg = `[Deferred] LLM call failed after 10 429 retries (drain pass also exhausted): ${stillDeferred.chunk.name}`;
                logger.error(msg);
                metrics.errors.push(msg);
                telemetryCollector.incrementErrors(msg);
                telemetryCollector.incrementDeferredFinalFailed();
                if (owner) {
                    owner.fileContext.fileHash = 'INCOMPLETE_DUE_TO_ERROR';
                    plan.repoHasErrors = true;
                }
            }

            // 3) Non-429 errors during drain were emitted by extractSemantics's
            //    own catch (telemetryCollector.incrementErrors). Mark plan accordingly.
            if (drainResult.failedCount > 0) {
                plan.repoHasErrors = true;
            }
        }

        // ── Post-write: Reconcile renamed entity tables ─────────────────
        // When an ORM entity's @Table(name=...) changes, the __class_metadata
        // function gets a new MAPS_TO edge, but cached functions' READS/WRITES
        // to the OLD DataContainer survive. Detect the rename (tombstoned +
        // live MAPS_TO from the same function) and retire all stale edges so
        // the old DataContainer becomes orphan-eligible.
        const entityReconciled = await reconcileRenamedEntityTables(commitHash);
        if (entityReconciled > 0) {
            logger.info(`[Orchestrator] Entity table rename: tombstoned ${entityReconciled} stale edge(s)`);
        }

        // ── Post-write: Orphan cleanup (once per repo, not per-chunk) ──────
        // deleteOrphanDatastores/Endpoints perform global label scans with
        // OPTIONAL MATCH fan-outs. Running them per-chunk causes O(N²)
        // degradation as the graph grows. Running once per-repo is sufficient:
        // orphans only arise from edge reconciliation (stale CONNECTS_TO/STORED_IN),
        // and all reconciliation for this repo is complete at this point.
        await deleteOrphanDatastores();
        await deleteOrphanDatabaseEndpoints();
        await deleteOrphanMessageChannels(commitHash);
        await deleteOrphanDataContainers();
        const dsCleanup = await deleteOrphanDataStructures();
        if (dsCleanup.deletedStructures > 0 || dsCleanup.deletedFields > 0) {
            logger.info(`[Orchestrator] Orphan GC: deleted ${dsCleanup.deletedStructures} DataStructure(s) and ${dsCleanup.deletedFields} cascaded DataField(s)`);
        }
        telemetryCollector.incrementDsOrphansCleaned(dsCleanup.deletedStructures, dsCleanup.deletedFields);

        // ── Post-write: Infer schema links for MessageChannels ─────────
        // After all chunks are written, link orphan MessageChannel nodes to
        // their DataStructure by normalizing the channel name to a .avsc filename
        // and looking up the existing SourceFile → DEFINES_SCHEMA chain.
        const schemaLinked = await inferAndLinkChannelSchemas(commitHash);
        if (schemaLinked > 0) {
            logger.info(`[Orchestrator] Inferred ${schemaLinked} HAS_SCHEMA link(s) for MessageChannels`);
        }

        // ── Post-write: Function-mediated channel↔payload welder (Scope A) ─
        // Complements the Avro-file-path welder above for LLM-emergent payload
        // codebases (no .avsc ground truth). Correlates via:
        //   (f)-[:PRODUCES]-(ds)  + (f)-[:PUBLISHES_TO]->(ch)  → HAS_SCHEMA + CARRIED_BY
        //   (f)-[:CONSUMES]->(ds) + (f)-[:LISTENS_TO]->(ch)    → HAS_SCHEMA + CARRIED_BY
        const fnBridge = await weldChannelPayloadsByFunction(commitHash);
        if (fnBridge.hasSchemaLinked > 0 || fnBridge.carriedByLinked > 0) {
            logger.info(`[Orchestrator] Function-bridge welder: ${fnBridge.hasSchemaLinked} HAS_SCHEMA + ${fnBridge.carriedByLinked} CARRIED_BY (channel↔payload via shared Function)`);
        }
        telemetryCollector.incrementChannelPayloadWeld(fnBridge.hasSchemaLinked, fnBridge.carriedByLinked);

        // ── Post-write: Function-mediated endpoint↔schema welder (Scope B) ─
        // Complements OpenAPI/AsyncAPI-driven welders for codebases where
        // request/response schemas live only in the LLM analyzer output
        // (no .openapi.yml ground truth). Bilateral correlation:
        //   client : (f)-[:CALLS]->(ep) + PRODUCES/CONSUMES → HAS_REQUEST/RESPONSE_SCHEMA
        //   server : (f)-[:IMPLEMENTS_ENDPOINT]->(ep) + CONSUMES/PRODUCES → ditto
        const apiBridge = await weldApiEndpointSchemasByFunction(commitHash);
        if (apiBridge.hasRequestSchemaLinked > 0 || apiBridge.hasResponseSchemaLinked > 0) {
            logger.info(`[Orchestrator] Function-bridge welder (API): ${apiBridge.hasRequestSchemaLinked} HAS_REQUEST_SCHEMA + ${apiBridge.hasResponseSchemaLinked} HAS_RESPONSE_SCHEMA (endpoint↔schema via shared Function)`);
        }
        telemetryCollector.incrementApiEndpointSchemaWeld(apiBridge.hasRequestSchemaLinked, apiBridge.hasResponseSchemaLinked);

        // ── Post-write: REFERENCES_TYPE welder (Phase 3, Fix #2) ───────────
        const fieldRefs = await linkFieldsReferenceTypes(commitHash);
        if (fieldRefs.linked > 0 || fieldRefs.swept > 0) {
            logger.info(`[Orchestrator] REFERENCES_TYPE welder: ${fieldRefs.linked} edges linked, ${fieldRefs.swept} stale edges tombstoned`);
        }
        telemetryCollector.incrementFieldReferencesType(fieldRefs.linked, fieldRefs.swept);

        // Commit point for repo Merkle hash
        if (!plan.repoHasErrors) {
            await updateRepositoryHash(
                getQualifiedRepoName(repo),
                repoHash,
                scanMode,
                commitHash,
            );
        } else {
            if (task && logger.isDebugEnabled()) {
                task.report(`Skipped caching repository "${repo.name}" due to extraction errors.`);
            }
        }
    }

    // Flush embedding cache to disk once at the very end
    flushEmbeddingCache();

    // Stop emitting CONCURRENCY trace events after the pipeline finishes.
    limitChangeUnsub();

    return metrics;
}

/**
 * Reify an aborted `AbortSignal` into a throwable Error. Prefers the
 * caller-supplied `signal.reason` (typically `ShutdownAbortError`) so the
 * propagated error retains its semantic identity.
 */
function asAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(`pipeline aborted: ${String(signal.reason ?? 'aborted')}`);
}
