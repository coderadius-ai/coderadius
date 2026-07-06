import fs from 'node:fs';
import { extractDependencies } from '../../core/dependencies.js';
import { telemetryCollector, traceCollector } from '../../../telemetry/index.js';
import {
    loadRepoHints,
    buildCustomKnowledgePrompt,
    getExtraSinks,
    getIgnorePackages,
    getExactConfiguredTables,
    getSinkClassifierConfig,
} from '../../../config/repo-hints.js';
import { logger } from '../../../utils/logger.js';
import { getKnownInternalNames } from '../../../graph/mutations/packages.js';
import {
    runTaintAnalysis,
    getHardcodedSinkRegistry,
    NATIVE_IO_MODULES,
    OBSERVABILITY_PACKAGES,
    type FileImportMap,
    type TaintMap,
} from '../../core/import-graph.js';
import { resolveSinks } from '../../core/sink-resolution.js';
import { classifyPackages } from '../../../ai/agents/sink-classifier/index.js';
import type { ClassifierInput, ClassifiedPackage } from '../../../ai/agents/sink-classifier/schema.js';
import { sinkAuditLog, type AuditEntry as SinkAuditEntry } from '../../../ai/agents/sink-classifier/audit.js';
import {
    computeInputHash,
    loadSnapshot,
    saveSnapshot,
} from '../../../ai/agents/sink-classifier/snapshot.js';
import { computeModelFingerprint } from '../../../ai/agents/sink-classifier/cache/index.js';
import { getLanguagePlugin } from '../../core/languages/registry.js';
import { isCompatibleScanMode } from '../../../graph/scan-mode.js';
import type { ScanMode } from '../../../graph/scan-mode.js';
import type {
    DiscoveryResult,
    StaticAnalysisResult,
    ProgressReporter,
    ManifestResult,
    CacheHitResult,
} from './types.js';
import { buildAnalysisTasks } from './static-analyzer-task-builder.js';
import { buildDeepTypeMetadata,
    collectParsedFiles,
    enrichAnalysisResults,
} from './static-analyzer-pass.js';
import { buildBasenameSuffixIndex, hasActiveTaint } from './static-analyzer-context.js';
import { collectZodiosAliasMaps, type ZodiosIndex, type ZodiosTypeIndex } from './zodios-context-builder.js';
import { buildValueResolutionIndex, type ValueResolutionIndexInput } from '../../core/value-resolution/index.js';
import { synthesizeDiCtorScalarFacts } from '../../core/value-resolution/di-ctor-scalar-facts.js';
import { collectConfigValueFacts } from './config-value-collector.js';
import { collectDiBindings } from './di-binding-collector.js';
import { DiBindingResolver } from '../../core/di-binding-resolver.js';
import { ComponentIoIndex } from '../../core/component-io-index.js';
import { DiIoPropagator } from '../../core/di-io-propagator.js';
import { ProgressHeartbeat } from '../../../utils/progress-heartbeat.js';

async function processManifest(fileContext: import('./types.js').FileContext): Promise<ManifestResult> {
    const fileContent = fs.readFileSync(fileContext.absolutePath, 'utf-8');
    const knownInternalNames = await getKnownInternalNames();

    try {
        const manifest = JSON.parse(fileContent);
        const selfName = manifest.name as string | undefined;
        if (selfName) knownInternalNames.add(selfName);
    } catch {
        // Parse errors handled downstream by dependency extractor.
    }

    const deps = extractDependencies(fileContext.absolutePath, fileContent, knownInternalNames);

    return {
        kind: 'manifest',
        fileContext,
        dependencies: deps,
    };
}

export async function analyzeFiles(
    discoveryResult: DiscoveryResult,
    task?: ProgressReporter,
    scanMode: ScanMode = 'semantic',
    symbolTaintedFiles?: Map<string, Set<string>>,
    freshScan: boolean = false,
    taintPropagationLevels?: number,
    symbolRegistry?: import('../../core/symbol-registry.js').SymbolRegistry,
): Promise<{
    analysisResults: StaticAnalysisResult[];
    manifestResults: ManifestResult[];
    cacheHitResults: CacheHitResult[];
}> {
    const isDeepScan = scanMode === 'contracts';
    const analysisResults: StaticAnalysisResult[] = [];
    const manifestResults: ManifestResult[] = [];
    const cacheHitResults: CacheHitResult[] = [];

    const {
        parsedFiles,
        fileImportMaps,
        classAliasMap,
        dependencyBindingMap,
    } = await collectParsedFiles(discoveryResult, scanMode, symbolTaintedFiles, freshScan, task);

    // ── Zodios pre-detection (Phase 1.5) ────────────────────────────────────
    // Build the Zodios alias index BEFORE buildAnalysisTasks so the task
    // builder can rescue functions that consume Zodios clients. Without this,
    // consumers like DiscountCalculator.applyDiscount fail every heuristic
    // gate (no SQL, no taint, no @Decorator) and get dropped — but they DO
    // call `.calculateDiscount()` on an injected Zodios-backed property and
    // the post-LLM resolver needs the analysisTask to exist. Pre-computing
    // here lets Gate 7 in buildAnalysisTasks keep them alive.
    const basenameIndex = buildBasenameSuffixIndex(discoveryResult.allFilePaths);
    const { zodiosIndex, zodiosTypeIndex } = collectZodiosAliasMaps(
        parsedFiles.map(parsed => ({
            relativePath: parsed.fileContext.relativePath,
            fileContent: parsed.fileContent,
        })),
        fileImportMaps,
        discoveryResult.allFilePaths,
        basenameIndex,
    );

    // Phase-level heartbeats. Each of these can take meaningful wall time on
    // large repos (taint BFS, value-resolution index, entity registry walk)
    // and were previously silent between the parsing loop and the LLM phase.
    if (task?.report) {
        task.report(`Resolving sinks & taint (${parsedFiles.length} file(s))...`);
    }

    const repoHints = loadRepoHints(discoveryResult.repo.path);
    const customKnowledgePrompt = buildCustomKnowledgePrompt(repoHints);
    const configuredTableNames = getExactConfiguredTables(repoHints);

    const userAnalyze = getExtraSinks(repoHints);

    let taintMap: TaintMap = new Map();
    if (fileImportMaps.length > 0) {
        const userIgnore = getIgnorePackages(repoHints);

        // Layer 4: LLM sink classifier (opt-in). Always fail-soft.
        const classifierCfg = getSinkClassifierConfig(repoHints);
        let llmClassifications: ClassifiedPackage[] = [];
        let llmDrift: Array<{ name: string; kind: string; detail?: string }> = [];

        if (classifierCfg.mode !== 'disabled') {
            const classifierInputs = collectClassifierInputs(fileImportMaps);
            if (classifierInputs.length > 0) {
                const { provider, model } = telemetryCollector.getActiveModel();
                const fingerprint = computeModelFingerprint(provider || 'unknown', model || 'unknown');
                const inputHash = computeInputHash(classifierInputs, fingerprint);
                const repoPath = discoveryResult.repo.path;

                // Fast-path: same input set + same model fingerprint → reuse snapshot.
                // Skipped on force-refresh so ops can validate fresh classifications.
                let snapshotHit = false;
                if (classifierCfg.mode !== 'force-refresh') {
                    const snapshot = await loadSnapshot(repoPath, inputHash);
                    if (snapshot) {
                        llmClassifications = snapshot.classifications;
                        snapshotHit = true;
                        if (logger.isDebugEnabled()) {
                            logger.debug(
                                `[SinkClassifier] snapshot hit: skipping ${classifierInputs.length} package(s)`,
                            );
                        }
                    }
                }

                if (!snapshotHit) {
                    try {
                        const result = await classifyPackages(classifierInputs, {
                            mode: classifierCfg.mode,
                            confidenceThreshold: classifierCfg.confidence_threshold,
                            maxPackagesPerBatch: classifierCfg.max_packages_per_batch,
                            timeoutMs: classifierCfg.timeout_ms,
                            budget: {
                                maxTokens: classifierCfg.budget.max_llm_tokens_per_run,
                                maxUsd: classifierCfg.budget.max_usd_per_run,
                            },
                            privacy: {
                                denyPatterns: classifierCfg.privacy.deny_patterns,
                                allowPatterns: classifierCfg.privacy.allow_patterns,
                                onDenied: classifierCfg.privacy.on_denied,
                            },
                            hardcodedSinks: getHardcodedSinkRegistry(),
                            hardcodedIgnores: OBSERVABILITY_PACKAGES,
                        });
                        llmClassifications = result.classifications;
                        llmDrift = result.drift;
                        // Save snapshot AFTER successful classification (best-effort).
                        void saveSnapshot(
                            repoPath,
                            inputHash,
                            fingerprint,
                            llmClassifications,
                            classifierInputs.length,
                        ).catch(() => undefined);
                    } catch (err) {
                        logger.warn(`[SinkClassifier] failed (${(err as Error).message}); falling back to hardcoded only`);
                        telemetryCollector.incrementSinkClassifierCounter('FallbackHardcoded');
                    }
                }
            }
        }

        // Resolve all 4 layers deterministically.
        const externalPackages = collectExternalNames(fileImportMaps);
        const resolved = resolveSinks({
            externalPackages,
            hardcodedSinks: new Set([...getHardcodedSinkRegistry(), ...NATIVE_IO_MODULES]),
            hardcodedIgnores: OBSERVABILITY_PACKAGES,
            userAnalyze,
            userIgnore,
            llmClassifications,
            confidenceLowBand: 0.85,
        });

        // Append audit trail (best-effort).
        if (resolved.audit.size > 0) {
            const repoLabel = discoveryResult.repo.path;
            const ts = new Date().toISOString();
            const entries: SinkAuditEntry[] = [...resolved.audit.values()].map(a => ({
                ts,
                repo: repoLabel,
                package: a.package,
                decision: a.decision,
                source: auditSourceForLog(a.source),
                sinkType: a.sinkType,
                confidence: a.confidence,
                reason: a.reason,
            }));
            void sinkAuditLog.append(entries).catch(() => undefined);
        }

        // Telemetry: drift counters (informational, not fatal).
        if (llmDrift.length > 0 && logger.isDebugEnabled()) {
            logger.debug(`[SinkClassifier] drift: ${llmDrift.length} disagreement(s)`);
        }

        // Project resolved sets onto the runTaintAnalysis surface.
        // Hardcoded layer is reapplied inside runTaintAnalysis via buildSinkRegistry,
        // so we only need to pass the EXTRAS (user.analyze + LLM-discovered sinks).
        const hardcodedSinkSet = getHardcodedSinkRegistry();
        const extraSinks = [...resolved.sinks].filter(s => !hardcodedSinkSet.has(s) && !NATIVE_IO_MODULES.has(s));
        const extraIgnores = [...resolved.ignores].filter(i => !OBSERVABILITY_PACKAGES.has(i));

        taintMap = runTaintAnalysis(
            fileImportMaps,
            classAliasMap,
            [...dependencyBindingMap.values()].flat(),
            discoveryResult.repo.path,
            extraSinks.length > 0 ? extraSinks : undefined,
            extraIgnores.length > 0 ? extraIgnores : undefined,
            taintPropagationLevels,
        );

        if (taintMap.size > 0 && task && logger.isDebugEnabled()) {
            task.report(`[Taint] ${taintMap.size} file(s) tainted via import graph contagion: ${Array.from(taintMap.keys()).join(', ')}`);
        }

        for (const [filePath, taintInfo] of taintMap) {
            traceCollector.traceAnalysis('INFO', filePath, 'taint analysis result', {
                tainted: true,
                taintedSymbols: [...taintInfo.taintedSymbols],
                taintedAliases: [...taintInfo.taintedAliases.entries()].map(([key, value]) => `${key}→${value}`),
            });
        }
    }

    if (task?.report) task.report(`Building type metadata index...`);
    const { typeDefIndex, funcTypeRefs, funcPayloadRefs } = buildDeepTypeMetadata(parsedFiles, isDeepScan, task);

    if (task?.report) task.report(`Collecting config value facts...`);
    const configValueFacts = collectConfigValueFacts(
        discoveryResult,
        new Set(parsedFiles.map(parsed => parsed.fileContext.relativePath)),
    );

    // DI-ctor-scalar value facts (e.g. a wrapper's $this->topic resolved from a
    // positional DI literal). Computed in the DI block below (where bindings +
    // component defs are available) and merged into the VRI inputs so the bound
    // component's $this->prop accessors resolve. Per file, empty unless a DI
    // binding injects a recognized positional scalar into a single-bound wrapper.
    let ctorScalarFactInputs: ValueResolutionIndexInput[] = [];

    // ── DI binding registry population ──────────────────────────
    // Runs BEFORE ValueResolutionIndex so the index can consult the
    // populated registry during resolveInvocation('full' mode).
    if (symbolRegistry) {
        if (task?.report) task.report(`Collecting DI bindings...`);
        const di = collectDiBindings(discoveryResult);

        const allComponentDefs = parsedFiles.flatMap(p => p.componentDefinitions);
        const allDependencyReqs = parsedFiles.flatMap(p => p.dependencyRequirements);

        const resolver = new DiBindingResolver();
        const stats = resolver.resolveAll({
            rawBindings: di.bindings,
            componentDefinitions: allComponentDefs,
            dependencyRequirements: allDependencyReqs,
            symbolRegistry,
        });

        // Join captured positional ctor scalars → ordered ctor params → a literal
        // value fact in the bound component's file (one input per file). Merged
        // below so `mergeValueResolutionInputs` folds them into that file's facts.
        const ctorScalarFacts = synthesizeDiCtorScalarFacts(di.bindings, allComponentDefs);
        const byFile = new Map<string, ValueResolutionIndexInput>();
        for (const fact of ctorScalarFacts) {
            const input = byFile.get(fact.filePath)
                ?? { filePath: fact.filePath, valueFacts: [], criticalInvocations: [] };
            input.valueFacts.push(fact);
            byFile.set(fact.filePath, input);
        }
        ctorScalarFactInputs = [...byFile.values()];

        // Histogram for Step-2 sizing. Stage
        // `resolution` is the fixed union semantically closest to "I just
        // populated a DI binding registry that influences resolveInvocation".
        traceCollector.traceResolution('INFO', 'di-histogram', 'di-binding pass summary', {
            counts: {
                rawBindingsParsed: di.bindings.length,
                filesMatched: di.matchedFiles.size,
                componentDefinitions: allComponentDefs.length,
                dependencyRequirements: allDependencyReqs.length,
                explicit: stats.explicit,
                resourceExpanded: stats.resourceExpanded,
                autowiringInterface: stats.autowiringInterface,
                dependencyRequirementCrosscheck: stats.dependencyRequirementCrosscheck,
                aliasChainsResolved: stats.aliasChainsResolved,
                aliasChainsDropped: stats.aliasChainsDropped,
                ambiguousInterfaceSkips: stats.ambiguousInterfaceSkips,
                registrySize: symbolRegistry.size,
            },
        });
    }

    if (task?.report) task.report(`Building value resolution index...`);
    const valueResolutionInputs = mergeValueResolutionInputs([
        ...parsedFiles.map(parsed => ({
            filePath: parsed.fileContext.relativePath,
            valueFacts: parsed.valueFacts,
            criticalInvocations: parsed.criticalInvocations,
        })),
        ...configValueFacts.inputs,
        ...ctorScalarFactInputs,
    ]);
    const valueResolutionImportMaps = mergeFileImportMaps([
        ...fileImportMaps,
        ...configValueFacts.virtualImportMaps,
    ]);
    const valueResolutionIndex = buildValueResolutionIndex(
        valueResolutionInputs,
        valueResolutionImportMaps,
        symbolRegistry, // in-place mutation, no local copy
    );

    // ── DI propagator populates ioTags on registered bindings.
    // Runs AFTER VRI is built (the propagator queries VRI in 'value-only'
    // mode for per-operation literal resolution). Must run BEFORE the
    // task-builder loop so `extractFunction` sees diBinding populated.
    if (symbolRegistry) {
        const allComponentDefs = parsedFiles.flatMap(p => p.componentDefinitions);
        const fileContentMap = new Map<string, string>();
        const fileHashMap = new Map<string, string>();
        for (const p of parsedFiles) {
            const path = p.fileContext.relativePath;
            if (p.fileContent) fileContentMap.set(path, p.fileContent);
            // fix #7: pass file content hashes to the propagator
            // so the binding fingerprint changes when a bound component's
            // body changes — even when the ioTag shape is unchanged.
            if (p.fileContext.fileHash) fileHashMap.set(path, p.fileContext.fileHash);
        }
        const componentIo = new ComponentIoIndex(allComponentDefs, fileContentMap, valueResolutionIndex);
        const propagator = new DiIoPropagator(symbolRegistry, componentIo, { viaFileHashes: fileHashMap });
        const propStats = propagator.propagateAll();
        traceCollector.traceResolution('INFO', 'di-propagator', 'di-propagator pass summary', {
            counts: { ...propStats },
        });
    }

    // Per-path index so the analysis-task builder loop below does an O(1)
    // lookup per file instead of an O(N) `.find()` across all `fileImportMaps`.
    // Without this, the loop is O(parsedFiles * fileImportMaps); on the
    // 8K-file acme-legacy2 repo this single .find() was burning ~30s+ of
    // wall time after the parsing phase reported "done".
    const fileImportMapByPath = new Map<string, FileImportMap>();
    for (const m of fileImportMaps) fileImportMapByPath.set(m.filePath, m);

    const totalParsed = parsedFiles.length;
    let analysedSoFar = 0;
    // Reports progress AND periodically yields one macrotask: this loop is
    // CPU-bound and synchronous, so without the yield the listr2 spinner
    // timer (and SIGINT handling) starves for the whole phase.
    const heartbeat = new ProgressHeartbeat();
    if (task?.report && totalParsed > 0) {
        task.report(`Building analysis tasks: 0/${totalParsed}...`);
    }

    for (const parsed of parsedFiles) {
        const { fileContext } = parsed;

        if (parsed.isCacheHit) {
            if (task && logger.isDebugEnabled()) {
                task.report(`\x1b[90m○\x1b[0m [${fileContext.relativePath}] CACHE HIT (file unchanged)`);
            }
            telemetryCollector.incrementFilesSkipped();
            cacheHitResults.push({
                kind: 'cache-hit',
                fileContext,
                unchangedFunctionCount: parsed.unchangedFunctionCount,
                unchangedFunctions: parsed.unchangedFunctions,
            });
            analysedSoFar++;
            await heartbeat.tick(analysedSoFar, () => task?.report?.(`Building analysis tasks: ${analysedSoFar}/${totalParsed}...`));
            continue;
        }

        telemetryCollector.incrementFilesProcessed();
        if (task && logger.isDebugEnabled()) {
            const taintInfo = taintMap.get(fileContext.relativePath);
            const taintLabel = hasActiveTaint(taintInfo)
                ? `\x1b[33m☣ tainted\x1b[0m (${taintInfo!.taintedSymbols.size} symbols, ${taintInfo!.taintedAliases.size} aliases)`
                : '\x1b[90m○ untainted\x1b[0m';
            task.report(`\x1b[1m[${fileContext.relativePath}]\x1b[0m ${parsed.chunks.length} functions — ${taintLabel}`);
        }

        const taintInfo = taintMap.get(fileContext.relativePath);
        const fileAliases = classAliasMap.get(fileContext.relativePath);
        const fileImportMap = fileImportMapByPath.get(fileContext.relativePath);

        const result = buildAnalysisTasks(
            parsed,
            discoveryResult,
            taintInfo,
            task,
            scanMode,
            fileAliases,
            fileImportMap,
            customKnowledgePrompt,
            typeDefIndex,
            funcTypeRefs,
            funcPayloadRefs,
            symbolTaintedFiles,
            freshScan,
            configuredTableNames.size > 0 ? configuredTableNames : undefined,
            valueResolutionIndex,
            userAnalyze.length > 0 ? userAnalyze : undefined,
            zodiosTypeIndex,
            zodiosIndex,
            discoveryResult.allFilePaths,
            basenameIndex,
        );

        const requiresDeepSchemaExtraction = isDeepScan
            && result.schemaContext !== null
            && parsed.fileContext.relativePath
            && !isCompatibleScanMode(
                discoveryResult.merkleIndex.files.get(parsed.fileContext.relativePath)?.fileScanMode,
                'contracts',
            );

        if (!requiresDeepSchemaExtraction && result.analysisTasks.length === 0 && result.unchangedFunctionCount > 0 && result.skippedFunctionCount === 0) {
            cacheHitResults.push({
                kind: 'cache-hit',
                fileContext,
                unchangedFunctionCount: result.unchangedFunctionCount,
                unchangedFunctions: result.unchangedFunctions,
            });
        } else {
            analysisResults.push(result);
        }

        analysedSoFar++;
        await heartbeat.tick(analysedSoFar, () => task?.report?.(`Building analysis tasks: ${analysedSoFar}/${totalParsed}...`));
    }

    if (task?.report) task.report(`Enriching ${analysisResults.length} analysis result(s)...`);
    enrichAnalysisResults(analysisResults, parsedFiles, fileImportMaps, discoveryResult, task, {
        zodiosIndex,
        zodiosTypeIndex,
        basenameIndex,
    });

    return { analysisResults, manifestResults, cacheHitResults };
}

function mergeValueResolutionInputs(inputs: ValueResolutionIndexInput[]): ValueResolutionIndexInput[] {
    const byFile = new Map<string, ValueResolutionIndexInput>();
    for (const input of inputs) {
        const existing = byFile.get(input.filePath);
        if (!existing) {
            byFile.set(input.filePath, {
                filePath: input.filePath,
                valueFacts: dedupeValueFacts(input.valueFacts ?? []),
                criticalInvocations: dedupeCriticalInvocations(input.criticalInvocations ?? []),
            });
            continue;
        }

        existing.valueFacts = dedupeValueFacts([...existing.valueFacts, ...(input.valueFacts ?? [])]);
        existing.criticalInvocations = dedupeCriticalInvocations([
            ...existing.criticalInvocations,
            ...(input.criticalInvocations ?? []),
        ]);
    }
    return [...byFile.values()];
}

function mergeFileImportMaps(importMaps: FileImportMap[]): FileImportMap[] {
    const byFile = new Map<string, FileImportMap>();
    for (const importMap of importMaps) {
        const existing = byFile.get(importMap.filePath);
        if (!existing) {
            byFile.set(importMap.filePath, {
                filePath: importMap.filePath,
                imports: [...importMap.imports],
                exportedSymbols: [...new Set(importMap.exportedSymbols)],
            });
            continue;
        }

        const seenImports = new Set(existing.imports.map(importSignature));
        for (const imp of importMap.imports) {
            const signature = importSignature(imp);
            if (seenImports.has(signature)) continue;
            seenImports.add(signature);
            existing.imports.push(imp);
        }
        existing.exportedSymbols = [...new Set([...existing.exportedSymbols, ...importMap.exportedSymbols])];
    }
    return [...byFile.values()];
}

function collectExternalNames(fileImportMaps: FileImportMap[]): string[] {
    const seen = new Set<string>();
    for (const fm of fileImportMaps) {
        for (const imp of fm.imports) {
            if (imp.isExternal && imp.source) seen.add(imp.source);
        }
    }
    return [...seen];
}

function collectClassifierInputs(fileImportMaps: FileImportMap[]): ClassifierInput[] {
    // Deduplicate by `${ecosystem}|${normalizedName}` so the classifier sees
    // each package once per ecosystem regardless of how many subpaths were
    // imported. Falls back to identity when a plugin doesn't implement
    // normalizePackageName / ecosystem.
    const seen = new Map<string, ClassifierInput>();
    for (const fm of fileImportMaps) {
        for (const imp of fm.imports) {
            if (!imp.isExternal || !imp.source) continue;
            const language = guessLanguageFromPath(fm.filePath);
            const plugin = language ? getLanguagePlugin(language) : undefined;
            const ecosystem = plugin?.ecosystem ?? 'unknown';
            const normalized = plugin?.normalizePackageName?.(imp.source) ?? imp.source;
            const key = `${ecosystem}|${normalized}`;
            if (!seen.has(key)) {
                seen.set(key, { name: normalized, ecosystem });
            }
        }
    }
    return [...seen.values()];
}

function guessLanguageFromPath(filePath: string): string | null {
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'typescript';
    if (filePath.endsWith('.php')) return 'php';
    if (filePath.endsWith('.py')) return 'python';
    if (filePath.endsWith('.go')) return 'go';
    return null;
}

function auditSourceForLog(
    source: 'user.ignore' | 'user.analyze' | 'hardcoded.sink' | 'hardcoded.ignore' | 'llm',
): SinkAuditEntry['source'] {
    if (source === 'hardcoded.sink' || source === 'hardcoded.ignore') return 'hardcoded';
    return source;
}

function importSignature(imp: FileImportMap['imports'][number]): string {
    const bindings = (imp.specifierBindings ?? [])
        .map(binding => `${binding.kind}:${binding.imported}:${binding.local}`)
        .sort()
        .join(',');
    return `${imp.source}:${imp.isExternal}:${imp.specifiers.join(',')}:${bindings}`;
}

function dedupeValueFacts(facts: ValueResolutionIndexInput['valueFacts']): ValueResolutionIndexInput['valueFacts'] {
    const seen = new Set<string>();
    const out: ValueResolutionIndexInput['valueFacts'] = [];
    for (const fact of facts) {
        const signature = `${fact.filePath}:${fact.key}:${fact.startLine}:${fact.kind}:${fact.value ?? fact.targetKey ?? fact.envKey ?? fact.fallbackValue ?? ''}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        out.push(fact);
    }
    return out;
}

function dedupeCriticalInvocations(
    invocations: ValueResolutionIndexInput['criticalInvocations'],
): ValueResolutionIndexInput['criticalInvocations'] {
    const seen = new Set<string>();
    const out: ValueResolutionIndexInput['criticalInvocations'] = [];
    for (const invocation of invocations) {
        const signature = `${invocation.filePath}:${invocation.startLine}:${invocation.callee}:${invocation.resourceExpression}:${invocation.resourceRole}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        out.push(invocation);
    }
    return out;
}

export async function processManifests(
    discoveryResult: DiscoveryResult,
    task?: ProgressReporter,
): Promise<ManifestResult[]> {
    const manifestResults: ManifestResult[] = [];

    for (const fileContext of discoveryResult.files) {
        if (!fileContext.isManifest) continue;

        if (task && logger.isDebugEnabled()) {
            task.report(`Extracting dependencies: ${fileContext.relativePath}`);
        }
        const result = await processManifest(fileContext);
        manifestResults.push(result);
    }

    return manifestResults;
}
