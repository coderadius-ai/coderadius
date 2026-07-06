import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanRepositoryTree, formatTreeAsCsv } from '../../utils/tree-scanner.js';
import { traceCollector } from '../../telemetry/index.js';
import { type SourceStrategy } from '../core/source-resolver.js';
import { ingestCodePipeline } from '../processors/code-pipeline/orchestrator.js';
import { ingestMatchmaking } from '../processors/matchmaking.js';
import { ingestGlobalResolution } from '../processors/global-resolver.js';
import { resolveDynamicInfrastructure } from '../processors/dynamic-infra-resolver.js';
import type { ProgressReporter, IngestionStep } from '../core/progress.js';
import { getGovernanceScanSteps, type GovernanceScanContext } from './governance-scan.workflow.js';
import { runReconcile } from './reconcile.workflow.js';
import type { ResolvedRepo } from '../../graph/types.js';
import { linkFileToSymbol, mergeConfigSymbol } from '../../graph/mutations/config-symbols.js';
import { getQualifiedRepoName } from '../../graph/urn.js';
import { SymbolRegistry, type SymbolCategory } from '../core/symbol-registry.js';
import { getMastra } from '../../ai/mastra/index.js';
import { loadRepoHints, getLastHintsLoadError } from '../../config/repo-hints.js';
import { clearRepoContextCache } from '../../config/repo-context.js';
import {
    clearCustomMessageConsumerDecorators,
    registerCustomMessageConsumerDecorator,
} from '../core/languages/typescript-framework-signals.js';
import {
    clearGraphQLClientDecorators,
    registerGraphQLClientDecorator,
} from '../core/graphql-client-registry.js';
import {
    clearHttpClientDecorators,
    registerHttpClientDecorator,
} from '../core/http-client-registry.js';
import {
    clearMessageBrokerRegistry,
    registerBrokerDeclaration,
    registerMirror,
} from '../core/messaging/broker-registry.js';
import { areUrnsTransparent } from '../../utils/urn-transparency.js';
import { cleanupTransparentArtifacts } from '../../graph/mutations/data-contracts.js';
import { withCongestionControl } from '../../utils/congestion-control.js';
import type { ScanMode } from '../../graph/scan-mode.js';
import {
    buildSymbolRegistryForRepo,
    extractSymbolFile,
    type ManualSymbolInput,
} from '../core/symbol-extraction.js';


/** Count total file→symbol usage edges for reporting. */
function countUsages(registry: SymbolRegistry): number {
    let count = 0;
    for (const files of registry.getUsages().values()) count += files.size;
    return count;
}



/**
 * Shared context for the global code ingestion workflow.
 */
export interface GlobalIngestionContext extends GovernanceScanContext {
    /** Per-repo registries: each key is qualifiedRepoName, value is the isolated registry for that repo. */
    symbolRegistryByRepo?: Map<string, SymbolRegistry>;
    scoutedConfigFilesByRepo?: Map<string, Set<string>>;
    symbolTaintedFilesByRepo?: Map<string, Map<string, Set<string>>>;
}

/**
 * Options for configuring the ingestion run.
 */
export interface IngestionCommandOptions {
    sourcePaths: string[];
    debug?: boolean;
    scanMode?: ScanMode;
    fresh?: boolean;
    sourceStrategy?: SourceStrategy;
    /** Override LLM concurrency (1–20). Falls back to LLM_CONCURRENCY env or default 3. */
    llmConcurrency?: number;
    taintPropagationLevels?: number;
    /**
     * Optional shutdown signal. When the user presses Ctrl+C, this signal
     * aborts in-flight LLM backoff sleeps, AIMD queue waiters, and pipeline
     * checkpoints so the run terminates within the grace window instead of
     * waiting on natural timer expiry.
     */
    signal?: AbortSignal;
}

/**
 * Returns the discrete steps of the Code Ingestion workflow.
 * This can be used by the CLI to create granular Listr tasks.
 */
export function getGlobalCodeIngestionSteps(opts: IngestionCommandOptions): IngestionStep<GlobalIngestionContext>[] {
    const scanMode = opts.scanMode ?? 'semantic';
    const govSteps = getGovernanceScanSteps({
        sourcePaths: opts.sourcePaths,
        debug: opts.debug,
        fresh: opts.fresh,
        sourceStrategy: opts.sourceStrategy,
    }) as IngestionStep<GlobalIngestionContext>[];

    const generateScopeFiltersStep: IngestionStep<GlobalIngestionContext> = {
        title: 'Generating Scope Filters',
            run: async (ctx, r) => {
                let generated = 0;
                for (const repo of ctx.repos) {
                    if (repo.origin === 'remote') {
                        const crignorePath = path.join(repo.path, '.crignore');
                        if (!fs.existsSync(crignorePath)) {
                            r.report(`Generating AI .crignore for ${repo.name}...`);
                            try {
                                const fileTree = scanRepositoryTree(repo.path);
                                let contextTree = fileTree;
                                if (contextTree.length > 5000) {
                                    contextTree = contextTree.filter(f => f.path.split(/[/\\]/).length <= 3);
                                    if (contextTree.length > 5000) {
                                        contextTree = contextTree.slice(0, 5000);
                                    }
                                }
                                const csvString = formatTreeAsCsv(contextTree);
                                r.report(`Requesting filtering rules for ${fileTree.length} files (capped to ${contextTree.length})...`);

                                const agent = getMastra().getAgent('crignoreAgent');
                                const response = await withCongestionControl(() =>
                                    agent.generate(csvString, {
                                        modelSettings: {
                                            maxRetries: 0,
                                            temperature: 0,
                                        }
                                    })
                                );

                                let crignoreContent = response.text || '';
                                if (crignoreContent.startsWith('```')) {
                                    const lines = crignoreContent.split('\\n');
                                    if (lines.length > 1 && lines[0].startsWith('```') && lines[lines.length - 1].startsWith('```')) {
                                        lines.shift();
                                        lines.pop();
                                        crignoreContent = lines.join('\\n');
                                    }
                                }

                                fs.writeFileSync(crignorePath, crignoreContent.trim() + '\\n', 'utf-8');

                                // Sync back to persistent cache for future sessions
                                if (repo.cachePath) {
                                    fs.copyFileSync(crignorePath, path.join(repo.cachePath, '.crignore'));
                                }

                                generated++;
                                r.report(`Generated .crignore for ${repo.name} (${crignoreContent.trim().split('\\n').length} rules)`);
                            } catch (err) {
                                r.warn(`Failed to generate .crignore for ${repo.name}: ${(err as Error).message}`);
                            }
                        } else {
                            r.report(`Using existing .crignore for ${repo.name}`);
                        }
                    }
                }

                if (generated === 0) {
                    r.report('No new topological filters required.');
                }
            }
    };

    const topologyIndex = govSteps.findIndex(s => s.title === 'Mapping Service Topology');
    if (topologyIndex !== -1) {
        govSteps.splice(topologyIndex, 0, generateScopeFiltersStep);
    } else {
        govSteps.push(generateScopeFiltersStep);
    }

    const codeOnlySteps: IngestionStep<GlobalIngestionContext>[] = [
        {
            title: 'Populating Symbol Registry',
            run: async (ctx, r) => {
                // Per-repo registries: each repository's symbols are isolated.
                // The orchestrator uses the correct per-repo registry during LLM analysis,
                // preventing cross-repo symbol contamination.
                // NOTE: For monorepos (1 element in ctx.repos), the single repoRegistry
                // contains all services — no global accumulator needed.
                const registryByRepo = new Map<string, SymbolRegistry>();
                let totalSymbols = 0;
                const scoutedFilesByRepo = new Map<string, Set<string>>();
                const taintedFilesByRepo = new Map<string, Map<string, Set<string>>>();
                if (opts.fresh) {
                    r.report('--force mode: bypassing all Symbol Registry caches');
                    clearRepoContextCache(); // flush memoized YAML reads + auto-discovery so everything is re-scanned
                }

                for (const repo of ctx.repos) {
                    const qName = getQualifiedRepoName(repo);

                    // ── Load manual overrides from coderadius.yaml ──────────
                    const hints = loadRepoHints(repo.path);
                    const hintsError = getLastHintsLoadError(repo.path);
                    if (hintsError) {
                        // The loader degrades to defaults silently by contract;
                        // the human running analyze must see it.
                        r.warn(`coderadius.yaml ignored (${hintsError}) — run 'cr validate --repo ${repo.path}'`);
                    }
                    const manualSymbols = Array.isArray((hints as any).symbols)
                        ? ((hints as any).symbols as ManualSymbolInput[])
                        : [];

                    // ── Register custom decorators from coderadius.yaml ─────
                    // Clear previous repo's decorators for multi-repo isolation
                    clearCustomMessageConsumerDecorators();
                    clearGraphQLClientDecorators();
                    clearHttpClientDecorators();
                    clearMessageBrokerRegistry();
                    for (const dec of hints.decorators ?? []) {
                        if (dec.kind === 'message-consumer') {
                            registerCustomMessageConsumerDecorator(dec.name, dec.args, dec.kind);
                        } else if (dec.kind === 'graphql-client') {
                            registerGraphQLClientDecorator(dec.name, dec.args);
                        } else if (dec.kind === 'http-client') {
                            registerHttpClientDecorator(
                                dec.name,
                                (dec as any).pathArgIndex ?? 0,
                                (dec as any).httpMethod ?? 'POST',
                            );
                        }
                    }
                    // Customer-declared brokers + cross-broker mirror aliases.
                    // Used by structural plugins (DSN disambiguation) and by the
                    // channel-alias welder (MANIFESTS_AS edges for Shovel / MirrorMaker).
                    for (const broker of hints.messageBrokers ?? []) {
                        registerBrokerDeclaration(broker);
                    }
                    for (const mirror of hints.message_channels?.mirrors ?? []) {
                        registerMirror(mirror);
                    }

                    const buildResult = await buildSymbolRegistryForRepo({
                        repo,
                        progress: r,
                        fresh: opts.fresh,
                        commitHash: repo.commit || 'SYSTEM',
                        manualSymbols,
                        persistCacheState: true,
                        llmConcurrency: opts.llmConcurrency,
                    });

                    registryByRepo.set(qName, buildResult.registry);
                    scoutedFilesByRepo.set(qName, buildResult.scoutedFiles);
                    const fileMap = new Map<string, Set<string>>();
                    for (const file of buildResult.taintedFiles) {
                        fileMap.set(file, new Set<string>());
                    }
                    taintedFilesByRepo.set(qName, fileMap);
                    totalSymbols += buildResult.registry.size;

                    const d = buildResult.diagnostics;
                    r.report(
                        `Symbol registry ${qName}: ${d.totalTargets} target(s), `
                        + `${d.cacheHits} hit(s), ${d.changed} changed, ${d.added} new, `
                        + `${d.deleted} deleted, ${d.llmCalls} LLM call(s), ${d.taintedFiles} tainted`
                        + (buildResult.status === 'partial' ? ' [partial]' : '')
                    );
                    traceCollector.traceResolution('INFO', `symbol-registry:${qName}`, 'symbol extraction summary', d as any);
                }

                ctx.symbolRegistryByRepo = registryByRepo;
                ctx.scoutedConfigFilesByRepo = scoutedFilesByRepo;
                ctx.symbolTaintedFilesByRepo = taintedFilesByRepo;

                if (totalSymbols > 0) {
                    r.report(`Symbol registry populated: ${totalSymbols} binding(s) across ${registryByRepo.size} repo(s)`);
                } else {
                    r.report('No infrastructure symbols found');
                }
            }
        },
        {
            title: 'Analyzing Codebase',
            run: async (ctx, r) => {
                const result = await ingestCodePipeline(ctx.repos, r, ctx.discoveredServiceRoots, scanMode, ctx.symbolRegistryByRepo, ctx.scoutedConfigFilesByRepo, ctx.symbolTaintedFilesByRepo, opts.fresh, opts.llmConcurrency, opts.taintPropagationLevels, opts.signal);
                r.report(`Analysis complete: ${result.functionsIngested} functions indexed`);

                // ── Post-Ingestion: Persist ConfigSymbol nodes + usages ──────
                // Use per-repo registries: each repo’s symbols are scoped to its namespace.
                const registryByRepo = ctx.symbolRegistryByRepo ?? new Map<string, SymbolRegistry>();

                for (const repo of ctx.repos) {
                    const qName = getQualifiedRepoName(repo);
                    const repoReg = registryByRepo.get(qName);
                    if (!repoReg || repoReg.size === 0) continue;

                    const commitHash = repo.commit || 'SYSTEM';
                    // Persist symbol nodes scoped to this repo.
                    // Plan v10 §A (P0 fix): forward physicalName /
                    // boundComponent / bindingFingerprint / viaFiles /
                    // ioTagsJson so the next run's loadConfigSymbols
                    // reconstructs class-only bindings exactly (otherwise
                    // the sanitizer guard in SymbolRegistry.resolve never
                    // fires and FQCNs leak as channel names).
                    for (const binding of repoReg.getAll()) {
                        const ioTagsJson = binding.ioTags && binding.ioTags.length > 0
                            ? JSON.stringify(binding.ioTags)
                            : undefined;
                        await mergeConfigSymbol(binding.key, binding.value, binding.category, qName, commitHash, {
                            rawValue: binding.rawValue ?? binding.value,
                            resolvedValue: binding.resolvedValue ?? binding.value,
                            sourceFile: binding.sourceFile,
                            sourceHash: binding.sourceHash,
                            technology: binding.technology,
                            confidence: binding.confidence,
                            extractorVersion: binding.extractorVersion,
                            lastResolvedAt: Date.now(),
                            physicalName: binding.physicalName,
                            boundComponent: binding.boundComponent,
                            ioTagsJson,
                            bindingFingerprint: binding.bindingFingerprint,
                            viaFiles: binding.viaFiles,
                        });
                    }
                    // Persist DEPENDS_ON_SYMBOL edges from read-tracking
                    const usages = repoReg.getUsages();
                    for (const [key, files] of usages) {
                        for (const filePath of files) {
                            await linkFileToSymbol(filePath, key, qName, commitHash);
                        }
                    }
                }
                const totalSymbolsPersisted = [...registryByRepo.values()].reduce((sum, reg) => sum + reg.size, 0);
                const totalUsages = [...registryByRepo.values()].reduce((sum, reg) => sum + countUsages(reg), 0);
                if (totalSymbolsPersisted > 0) {
                    r.report(`Persisted ${totalSymbolsPersisted} config symbol(s) with ${totalUsages} dependency edge(s)`);
                }

                // ── Trace: dump final ConfigSymbol map for debug ──────────
                for (const [qName, reg] of registryByRepo) {
                    if (reg.size === 0) continue;
                    const symbolMap: Record<string, string> = {};
                    for (const b of reg.getAll()) symbolMap[b.key] = b.value;
                    traceCollector.traceResolution('INFO', `symbol-registry:${qName}`, 'final symbol map', { bindingCount: reg.size, symbols: symbolMap });
                }


            }
        },
        {
            title: 'Resolving Infrastructure',
            run: async (ctx, r) => {
                const result = await resolveDynamicInfrastructure(r);
                if (result.stubsProcessed > 0) {
                    const parts: string[] = [];
                    if (result.stubsResolved > 0) parts.push(`${result.stubsResolved} resolved`);
                    if (result.stubsNormalized > 0) parts.push(`${result.stubsNormalized} normalized`);
                    if (result.stubsUnresolved > 0) parts.push(`${result.stubsUnresolved} unresolved`);
                    r.report(`Dynamic infra: ${result.stubsProcessed} stubs → ${parts.join(', ')}`);
                } else {
                    r.report('No dynamic infrastructure nodes to resolve');
                }
            }
        },
        {
            // LLM-needy synthesis: matchmaking + datastore assignment + global
            // emergent resolution. Deterministic welders (channel-aliases,
            // class-name bridge, openapi/datacontainer dedup, autopromote,
            // cross-kind dedup, technology welder, env-var deps, prune STORED_IN,
            // bindUnresolvedDependencies, linkDataContainerSchemas) moved into
            // runReconcile() which fires as the terminal workflow step below.
            title: 'Synthesizing Architecture Graph',
            run: async (ctx, r) => {
                // 1. Match API Endpoints
                r.report('Matching API Endpoints...');
                const matchResult = await ingestMatchmaking(r);
                if (matchResult.linksCreated > 0) {
                    r.report(`Matched ${matchResult.linksCreated} function→endpoint links across ${matchResult.servicesMatched} services`);
                }

                // 2. Assign DataContainers to Datastores (LLM)
                r.report('Assigning DataContainers to Datastores...');
                const { loadRepoContext } = await import('../../config/repo-context.js');
                const { assignDatastoresForScope } = await import('../processors/datastore-assignment.js');
                const { familyForTechnology } = await import('../processors/db-scope-resolver.js');
                let totalScopesProcessed = 0;
                let totalEdgesWritten = 0;
                let totalLlmCalls = 0;
                for (const repo of ctx.repos) {
                    const scope = getQualifiedRepoName(repo);
                    const repoCtx = loadRepoContext(repo.path);
                    if (repoCtx.identities.length < 2) continue;
                    const dsResult = await assignDatastoresForScope(
                        scope, repoCtx.identities, familyForTechnology, 'SYSTEM',
                    );
                    totalScopesProcessed += dsResult.scopesProcessed;
                    totalEdgesWritten += dsResult.edgesWritten;
                    totalLlmCalls += dsResult.llmCalls;
                }
                if (totalEdgesWritten > 0) {
                    r.report(`Assigned ${totalEdgesWritten} DataContainer(s) across ${totalScopesProcessed} scope(s); ${totalLlmCalls} LLM call(s)`);
                }

                // 3. Resolve Cross-Service Calls (LLM emergent fallback).
                //    Runs before reconcile so the deterministic welders downstream
                //    see the freshly resolved endpoints.
                r.report('Resolving Cross-Service Calls...');
                const callsResult = await ingestGlobalResolution(r, scanMode);
                const resolved = callsResult.resolvedExact + callsResult.resolvedTemplate + callsResult.resolvedLLM + callsResult.resolvedSelf + callsResult.resolvedScoped;
                if (resolved > 0) {
                    const parts: string[] = [];
                    if (callsResult.resolvedScoped > 0) parts.push(`${callsResult.resolvedScoped} scoped`);
                    if (callsResult.resolvedSelf > 0) parts.push(`${callsResult.resolvedSelf} self`);
                    if (callsResult.resolvedExact > 0) parts.push(`${callsResult.resolvedExact} exact`);
                    if (callsResult.resolvedTemplate > 0) parts.push(`${callsResult.resolvedTemplate} template`);
                    if (callsResult.resolvedLLM > 0) parts.push(`${callsResult.resolvedLLM} LLM`);
                    r.report(`Resolved ${resolved}/${callsResult.emergentTotal} emergent endpoints (${parts.join(', ')})`);
                } else if (callsResult.emergentTotal > 0) {
                    r.report(`No emergent endpoints resolved (${callsResult.unresolved} remain as orphans)`);
                }
            }
        },
        {
            // Terminal step: deterministic graph reconciliation. Shared with
            // `cr analyze infra` and structure-only scans. Order-independent: every
            // ingest entry point converges here.
            title: 'Reconciling Graph State',
            run: async (ctx, r) => {
                await runReconcile({ repos: ctx.repos, commitHash: 'SYSTEM' }, r);
            }
        }
    ];

    // ── IMPORTANT: OpenAPI extraction (from governance scan) runs BEFORE code analysis ──────────────────
    // Route extractors (Slim, Express, etc.) inside the code pipeline
    // need canonical APIEndpoint nodes to already exist so they can wire
    // IMPLEMENTS_ENDPOINT directly to them, avoiding duplicate code: nodes.
    return [...govSteps, ...codeOnlySteps];
}

/**
 * Executes the entire end-to-end Code Ingestion workflow (Headless mode).
 */
export async function runGlobalCodeIngestion(
    opts: IngestionCommandOptions,
    reporter?: ProgressReporter
): Promise<void> {
    const sessionId = crypto.randomUUID();
    const r = reporter ?? { report: () => { }, warn: () => { }, error: () => { } };

    const ctx: GlobalIngestionContext = {
        sessionId,
        sourcePaths: opts.sourcePaths,
        repos: [],
        discoveredServiceRoots: []
    };

    // Fix 10 + P2.5: cleanup stale displayHost/displayVhost from previous
    // transparent runs when current effective transparent mode is OFF.
    // Privacy-correct on reused graphs; idempotent.
    // Skipped in test runtime: vitest fixtures manage their own graph state
    // and don't want the workflow side-effect. Tests call
    // `cleanupTransparentArtifacts()` directly when needed.
    if (!areUrnsTransparent() && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
        await cleanupTransparentArtifacts();
    }

    const steps = getGlobalCodeIngestionSteps(opts);
    for (const step of steps) {
        r.report(`[Step] ${step.title}`);
        await step.run(ctx, r);
    }
}
