import {
    type ClassPropertyAlias,
    type DependencyBinding,
    type FileImportMap,
    buildImportGraph,
} from '../../core/import-graph.js';
import { telemetryCollector, traceCollector } from '../../../telemetry/index.js';
import { logger } from '../../../utils/logger.js';
import { makeFunctionIdForRepo } from './static-analyzer-context.js';
import { isCompatibleScanMode } from '../../../graph/scan-mode.js';
import type { ScanMode } from '../../../graph/scan-mode.js';
import { buildEntityTableContext, collectEntityTableRegistry } from './entity-table-registry.js';
import type {
    FileContext,
    ProgressReporter,
    StaticAnalysisResult,
} from './types.js';
import type { DiscoveryResult } from './types.js';
import type { ParsedFileResult } from './static-analyzer-task-builder.js';
import type { ClientBinding } from '../../core/languages/types.js';
import type { MerkleFileEntry } from '../../core/merkle.js';
import {
    buildClientBindingContext,
    buildGraphQLDocumentContext,
    collectResolvedConstantsForTask,
    extractGraphQLDocumentsFromSource,
    formatResolvedConstantsContext,
    buildBasenameSuffixIndex,
    type FuncTypeRefsMap,
    type FuncPayloadRefsMap,
    type TypeDefinitionIndex,
} from './static-analyzer-context.js';
import type { AstResolvedPayload } from './types.js';
import {
    collectZodiosAliasMaps,
    resolveZodiosCallsForTask,
} from './zodios-context-builder.js';
import {
    buildGraphQLOperationsIndex,
    findGqlLiteralReferencesInSource,
    formatGqlOperationContext,
} from '../../extractors/graphql-operations-extractor.js';
import { createParseExecutor, type ParseExecutor } from './parse-executor.js';
import type { ParseWorkTask, WorkerParseResult } from './parse-protocol.js';

export interface StaticAnalyzerPassState {
    parsedFiles: ParsedFileResult[];
    fileImportMaps: FileImportMap[];
    classAliasMap: Map<string, ClassPropertyAlias[]>;
    dependencyBindingMap: Map<string, DependencyBinding[]>;
}

interface PlannedParseFile {
    fileContext: FileContext;
    prevFileEntry: MerkleFileEntry | undefined;
    cacheHit: boolean;
    workTask: ParseWorkTask;
}

export async function collectParsedFiles(
    discoveryResult: DiscoveryResult,
    scanMode: ScanMode = 'semantic',
    symbolTaintedFiles?: Map<string, Set<string>>,
    freshScan: boolean = false,
    task?: any,
): Promise<StaticAnalyzerPassState> {
    const sourceFiles = discoveryResult.files.filter(file => !file.isManifest);
    const parsedFiles: ParsedFileResult[] = [];
    const fileImportMaps: FileImportMap[] = [];
    const classAliasMap = new Map<string, ClassPropertyAlias[]>();
    const dependencyBindingMap = new Map<string, DependencyBinding[]>();

    const repoLabel = discoveryResult.repo.name;
    const totalFiles = sourceFiles.length;
    if (totalFiles === 0) {
        return { parsedFiles, fileImportMaps, classAliasMap, dependencyBindingMap };
    }
    if (task?.report) {
        task.report(`Parsing ${repoLabel}: 0/${totalFiles} files...`);
    }

    // ── Plan: cache-hit vs fresh, per file (merkle reads stay on main) ──────
    const planned: PlannedParseFile[] = sourceFiles.map((fileContext, taskId) => {
        const { relativePath, fileHash } = fileContext;
        const prevFileEntry = discoveryResult.merkleIndex.files.get(relativePath);
        const isFileTainted = symbolTaintedFiles?.has(relativePath) ?? false;
        const isFileCacheValid = prevFileEntry
            ? isCompatibleScanMode(prevFileEntry.fileScanMode, scanMode)
            : false;
        const cacheHit = !freshScan && !!prevFileEntry && prevFileEntry.fileHash === fileHash
            && isFileCacheValid && !isFileTainted;
        return {
            fileContext,
            prevFileEntry,
            cacheHit,
            workTask: {
                taskId,
                absolutePath: fileContext.absolutePath,
                relativePath,
                mode: cacheHit ? 'cache-hit' as const : 'fresh' as const,
                needsImportMap: cacheHit ? !prevFileEntry!.importMap : true,
            },
        };
    });

    // ── Dispatch: CPU-bound tree-sitter + per-file extractors off-thread ────
    // Results are reassembled in discovery order (pool guarantees submission
    // order), so every cross-file pass below is deterministic regardless of
    // PARSE_CONCURRENCY.
    const executor = createParseExecutor({
        allFilePaths: [...discoveryResult.allFilePaths],
        dependencyMappings: discoveryResult.dependencyMappings ?? [],
        scanMode,
    });

    try {
        let lastReportAt = Date.now();
        const outcomes = await executor.run(planned.map(p => p.workTask), (done, total) => {
            const now = Date.now();
            if (task?.report && (done % 200 === 0 || now - lastReportAt >= 1500 || done === total)) {
                task.report(`Parsing ${repoLabel}: ${done}/${total} files...`);
                lastReportAt = now;
            }
        });

        for (let i = 0; i < planned.length; i++) {
            const { fileContext, prevFileEntry, cacheHit } = planned[i];
            const outcome = outcomes[i];

            if (!outcome.ok) {
                parsedFiles.push(buildIncompleteParsedFile(fileContext, prevFileEntry, outcome.error));
                continue;
            }
            const result = outcome.result;

            if (cacheHit) {
                parsedFiles.push(assembleCacheHit(fileContext, prevFileEntry!, result));
                collectCacheHitImportMaps(
                    fileContext.relativePath, prevFileEntry!, result,
                    fileImportMaps, classAliasMap, dependencyBindingMap,
                );
                continue;
            }

            telemetryCollector.addParsingTime(result.parseDurationMs);
            telemetryCollector.incrementTotalFunctionsParsed(result.chunks.length);
            parsedFiles.push(assembleFresh(fileContext, result));
            traceCollector.traceAnalysis('INFO', fileContext.relativePath, 'file parsed', {
                functionsFound: result.chunks.length,
                language: result.language,
            });

            markTaintedChunks(fileContext, result.chunks, symbolTaintedFiles);
            collectFreshImportMaps(
                fileContext.relativePath, prevFileEntry, result,
                fileImportMaps, classAliasMap, dependencyBindingMap,
            );
        }

        await applyStructuralContagion(
            parsedFiles, fileImportMaps, discoveryResult, executor, symbolTaintedFiles, task,
        );
    } finally {
        await executor.destroy();
    }

    return {
        parsedFiles,
        fileImportMaps,
        classAliasMap,
        dependencyBindingMap,
    };
}

function assembleCacheHit(
    fileContext: FileContext,
    prevFileEntry: MerkleFileEntry,
    result: WorkerParseResult,
): ParsedFileResult {
    const { relativePath } = fileContext;
    const unchangedFunctions = [...prevFileEntry.functions.keys()].map(functionId => ({
        functionId,
        relativePath,
        repoName: fileContext.repo.name,
    }));
    traceCollector.traceAnalysis('CACHE_HIT', relativePath, 'file hash unchanged', {
        fileHash: fileContext.fileHash,
        unchangedFunctions: prevFileEntry.functions.size,
    });
    return {
        fileContext,
        chunks: [],
        language: result.language,
        frameworkSignals: result.frameworkSignals,
        fileContent: result.fileContent,
        fileConstants: result.fileConstants,
        valueFacts: result.valueFacts,
        criticalInvocations: result.criticalInvocations,
        componentDefinitions: result.componentDefinitions,
        dependencyRequirements: result.dependencyRequirements,
        chunkStaticData: [],
        importStatements: [],
        constructorSources: new Map(),
        mayContainSchemas: false,
        typeDefinitions: result.typeDefinitions,
        referencedTypes: result.referencedTypes,
        payloadHints: result.payloadHints,
        isCacheHit: true,
        unchangedFunctions,
        unchangedFunctionCount: prevFileEntry.functions.size,
    };
}

function assembleFresh(fileContext: FileContext, result: WorkerParseResult): ParsedFileResult {
    return {
        fileContext,
        chunks: result.chunks,
        language: result.language,
        frameworkSignals: result.frameworkSignals,
        fileContent: result.fileContent,
        fileConstants: result.fileConstants,
        valueFacts: result.valueFacts,
        criticalInvocations: result.criticalInvocations,
        componentDefinitions: result.componentDefinitions,
        dependencyRequirements: result.dependencyRequirements,
        chunkStaticData: result.chunkStaticData,
        importStatements: result.importStatements,
        constructorSources: result.constructorSources,
        mayContainSchemas: result.mayContainSchemas,
        typeDefinitions: result.typeDefinitions,
        referencedTypes: result.referencedTypes,
        payloadHints: result.payloadHints,
        isCacheHit: false,
        unchangedFunctions: [],
        unchangedFunctionCount: 0,
    };
}

/**
 * A worker-side failure must not abort the repo NOR tombstone the file's
 * existing functions. The file is surfaced as a cache hit (links preserved
 * from the merkle index) and its hash is poisoned so the next sync retries.
 */
function buildIncompleteParsedFile(
    fileContext: FileContext,
    prevFileEntry: MerkleFileEntry | undefined,
    error: string,
): ParsedFileResult {
    const { relativePath } = fileContext;
    fileContext.fileHash = 'INCOMPLETE_DUE_TO_ERROR';
    logger.warn(`[Parse] ${relativePath} failed in worker (${error}); marked INCOMPLETE for retry on next sync`);
    traceCollector.traceAnalysis('FAIL', relativePath, 'parse failed in worker', { error });
    const unchangedFunctions = prevFileEntry
        ? [...prevFileEntry.functions.keys()].map(functionId => ({
            functionId,
            relativePath,
            repoName: fileContext.repo.name,
        }))
        : [];
    return {
        fileContext,
        chunks: [],
        language: 'unknown',
        frameworkSignals: [],
        fileContent: '',
        fileConstants: [],
        valueFacts: [],
        criticalInvocations: [],
        componentDefinitions: [],
        dependencyRequirements: [],
        chunkStaticData: [],
        importStatements: [],
        constructorSources: new Map(),
        mayContainSchemas: false,
        typeDefinitions: null,
        referencedTypes: null,
        payloadHints: null,
        isCacheHit: true,
        unchangedFunctions,
        unchangedFunctionCount: prevFileEntry?.functions.size ?? 0,
    };
}

function collectCacheHitImportMaps(
    relativePath: string,
    prevFileEntry: MerkleFileEntry,
    result: WorkerParseResult,
    fileImportMaps: FileImportMap[],
    classAliasMap: Map<string, ClassPropertyAlias[]>,
    dependencyBindingMap: Map<string, DependencyBinding[]>,
): void {
    if (prevFileEntry.importMap) {
        fileImportMaps.push(prevFileEntry.importMap);
        if (prevFileEntry.classAliases && prevFileEntry.classAliases.length > 0) {
            classAliasMap.set(relativePath, prevFileEntry.classAliases);
        }
        if (prevFileEntry.dependencyBindings && prevFileEntry.dependencyBindings.length > 0) {
            dependencyBindingMap.set(relativePath, prevFileEntry.dependencyBindings);
        }
        return;
    }
    if (!result.importMap) return;
    fileImportMaps.push(result.importMap);
    prevFileEntry.importMap = result.importMap;
    if (result.classAliases.length > 0) {
        classAliasMap.set(relativePath, result.classAliases);
        prevFileEntry.classAliases = result.classAliases;
    }
    if (result.dependencyBindings.length > 0) {
        dependencyBindingMap.set(relativePath, result.dependencyBindings);
        prevFileEntry.dependencyBindings = result.dependencyBindings;
    }
}

function collectFreshImportMaps(
    relativePath: string,
    merkleEntry: MerkleFileEntry | undefined,
    result: WorkerParseResult,
    fileImportMaps: FileImportMap[],
    classAliasMap: Map<string, ClassPropertyAlias[]>,
    dependencyBindingMap: Map<string, DependencyBinding[]>,
): void {
    if (!result.importMap) return;
    fileImportMaps.push(result.importMap);
    if (merkleEntry) merkleEntry.importMap = result.importMap;

    if (result.classAliases.length > 0) {
        classAliasMap.set(relativePath, result.classAliases);
        if (merkleEntry) merkleEntry.classAliases = result.classAliases;
    }
    if (result.dependencyBindings.length > 0) {
        dependencyBindingMap.set(relativePath, result.dependencyBindings);
        if (merkleEntry) merkleEntry.dependencyBindings = result.dependencyBindings;
    }
}

function markTaintedChunks(
    fileContext: FileContext,
    chunks: ParsedFileResult['chunks'],
    symbolTaintedFiles?: Map<string, Set<string>>,
): void {
    const { relativePath } = fileContext;
    if (!symbolTaintedFiles?.has(relativePath)) return;
    let functionSet = symbolTaintedFiles.get(relativePath);
    if (!functionSet) {
        functionSet = new Set<string>();
        symbolTaintedFiles.set(relativePath, functionSet);
    }
    for (const chunk of chunks) {
        functionSet.add(makeFunctionIdForRepo(fileContext.repo, relativePath, chunk));
    }
}

// ── Structural Contagion (Post-Process) ──────────────────────────────────────
// Now that we have all importMaps for the repository (even for cache hits),
// we build the graph and find downstream consumers of physically modified
// files. Consumers marked `isCacheHit` that mention a modified export are
// un-cached and re-dispatched to the pool for a full fresh extraction.
async function applyStructuralContagion(
    parsedFiles: ParsedFileResult[],
    fileImportMaps: FileImportMap[],
    discoveryResult: DiscoveryResult,
    executor: ParseExecutor,
    symbolTaintedFiles?: Map<string, Set<string>>,
    task?: any,
): Promise<void> {
    const modifiedFiles = new Set<string>();
    for (const p of parsedFiles) {
        if (!p.isCacheHit) modifiedFiles.add(p.fileContext.relativePath);
    }
    if (modifiedFiles.size === 0 || fileImportMaps.length === 0) return;

    const graph = buildImportGraph(fileImportMaps, discoveryResult.allFilePaths);

    // O(N) Map lookups instead of O(N) `.find()` per iteration. On fresh
    // scans every file is `modifiedFiles`, so the original two-level
    // `.find()` was N^3 string-compare territory and the dominant Stage 2
    // cost above ~5K files.
    const importMapByPath = new Map<string, FileImportMap>();
    for (const m of fileImportMaps) importMapByPath.set(m.filePath, m);
    const parsedByPath = new Map<string, ParsedFileResult>();
    for (const p of parsedFiles) parsedByPath.set(p.fileContext.relativePath, p);

    const toUnCache: ParsedFileResult[] = [];
    const seen = new Set<string>();
    for (const modifiedFile of modifiedFiles) {
        const consumers = graph.dependedBy.get(modifiedFile);
        if (!consumers) continue;

        // Determine which symbols the modified file exports.
        // If we can't identify any (barrel `export *`, config files),
        // skip contagion: we have no evidence that downstream outputs
        // changed.
        const modifiedExports = importMapByPath.get(modifiedFile)?.exportedSymbols || [];
        if (modifiedExports.length === 0) continue;

        for (const consumer of consumers) {
            const parsed = parsedByPath.get(consumer);
            if (!parsed || !parsed.isCacheHit || seen.has(consumer)) continue;
            // If the consumer mentions ANY of the modified exports in its
            // ENTIRE file content, we must un-cache the whole file to ensure
            // all internal references are refreshed.
            if (!modifiedExports.some(sym => parsed.fileContent.includes(sym))) continue;

            seen.add(consumer);
            toUnCache.push(parsed);
            if (task && logger.isDebugEnabled()) {
                task.report(`\x1b[33m☣\x1b[0m [${consumer}] UN-CACHED (structural contagion from ${modifiedFile})`);
            }
            traceCollector.traceAnalysis('INFO', consumer, 'structural contagion', {
                source: modifiedFile,
                reason: 'modified exports mentioned in file',
                modifiedExports,
            });
        }
    }
    if (toUnCache.length === 0) return;

    const contagionTasks: ParseWorkTask[] = toUnCache.map((parsed, taskId) => ({
        taskId,
        absolutePath: parsed.fileContext.absolutePath,
        relativePath: parsed.fileContext.relativePath,
        mode: 'fresh',
        // The import graph is already assembled from the cached maps; the
        // file content is unchanged, so the maps are too.
        needsImportMap: false,
    }));
    const outcomes = await executor.run(contagionTasks);

    let contagionCount = 0;
    for (let i = 0; i < toUnCache.length; i++) {
        const parsed = toUnCache[i];
        const outcome = outcomes[i];
        if (!outcome.ok) {
            parsed.fileContext.fileHash = 'INCOMPLETE_DUE_TO_ERROR';
            logger.warn(`[Parse] contagion re-parse of ${parsed.fileContext.relativePath} failed (${outcome.error}); marked INCOMPLETE for retry on next sync`);
            traceCollector.traceAnalysis('FAIL', parsed.fileContext.relativePath, 'contagion re-parse failed', { error: outcome.error });
            continue;
        }
        const result = outcome.result;
        telemetryCollector.addParsingTime(result.parseDurationMs);
        telemetryCollector.incrementTotalFunctionsParsed(result.chunks.length);

        parsed.isCacheHit = false;
        parsed.unchangedFunctions = [];
        parsed.unchangedFunctionCount = 0;
        parsed.chunks = result.chunks;
        parsed.chunkStaticData = result.chunkStaticData;
        parsed.importStatements = result.importStatements;
        parsed.constructorSources = result.constructorSources;
        parsed.mayContainSchemas = result.mayContainSchemas;

        // Add ALL functions to symbolTaintedFiles so downstream tasks know
        // to re-analyze everything.
        if (symbolTaintedFiles) {
            const consumer = parsed.fileContext.relativePath;
            if (!symbolTaintedFiles.has(consumer)) symbolTaintedFiles.set(consumer, new Set());
            for (const chunk of result.chunks) {
                symbolTaintedFiles.get(consumer)!.add(makeFunctionIdForRepo(parsed.fileContext.repo, consumer, chunk));
            }
        }
        contagionCount++;
    }

    if (contagionCount > 0 && task && logger.isDebugEnabled()) {
        task.report(`[Contagion] ${contagionCount} cache-hit file(s) un-cached via import-graph contagion`);
    }
}

export function buildDeepTypeMetadata(
    parsedFiles: ParsedFileResult[],
    isDeepScan: boolean,
    task?: ProgressReporter,
): {
    typeDefIndex?: TypeDefinitionIndex;
    funcTypeRefs?: FuncTypeRefsMap;
    funcPayloadRefs?: FuncPayloadRefsMap;
} {
    if (!isDeepScan) return {};

    const typeDefIndex: TypeDefinitionIndex = new Map();
    const funcTypeRefs: FuncTypeRefsMap = new Map();

    // Pass 1: populate typeDefIndex from every parsed file so the second
    // pass can cross-reference any basename. funcPayloadRefs needs a
    // complete index to materialize fields for refs pointing at types
    // defined in OTHER files within the same repo. The per-file maps were
    // extracted in the parse workers; this pass is a pure cross-file merge
    // in discovery order (first definition wins).
    for (const parsed of parsedFiles) {
        if (parsed.typeDefinitions) {
            for (const [name, definition] of parsed.typeDefinitions) {
                if (!typeDefIndex.has(name)) {
                    typeDefIndex.set(name, definition);
                }
            }
        }
        if (parsed.referencedTypes && parsed.referencedTypes.size > 0) {
            funcTypeRefs.set(parsed.fileContext.relativePath, parsed.referencedTypes);
        }
    }

    // Pass 2 (Phase 1): per file, resolve each payload hint's basename
    // against the global typeDefIndex to attach concrete `fields`.
    const funcPayloadRefs: FuncPayloadRefsMap = new Map();
    for (const parsed of parsedFiles) {
        const perFile = parsed.payloadHints;
        if (!perFile || perFile.size === 0) continue;

        const resolvedForFile = new Map<string, AstResolvedPayload[]>();
        for (const [chunkName, hints] of perFile) {
            const resolved: AstResolvedPayload[] = [];
            for (const ref of hints.consumed) {
                const def = typeDefIndex.get(ref.basename);
                if (!def || def.properties.length === 0) continue;
                resolved.push({
                    direction: 'consumed',
                    fqcn: ref.fqcn,
                    basename: ref.basename,
                    origin: ref.origin,
                    fields: def.properties.map(p => ({ name: p.name, type: p.type })),
                    source: 'ast',
                });
            }
            for (const ref of hints.produced) {
                const def = typeDefIndex.get(ref.basename);
                if (!def || def.properties.length === 0) continue;
                resolved.push({
                    direction: 'produced',
                    fqcn: ref.fqcn,
                    basename: ref.basename,
                    origin: ref.origin,
                    fields: def.properties.map(p => ({ name: p.name, type: p.type })),
                    source: 'ast',
                });
            }
            if (resolved.length > 0) resolvedForFile.set(chunkName, resolved);
        }
        if (resolvedForFile.size > 0) {
            funcPayloadRefs.set(parsed.fileContext.relativePath, resolvedForFile);
        }
    }

    if (task && logger.isDebugEnabled() && typeDefIndex.size > 0) {
        task.report(`[Deep] TypeDefinitionIndex: ${typeDefIndex.size} type(s) indexed across ${funcTypeRefs.size} file(s); funcPayloadRefs over ${funcPayloadRefs.size} file(s)`);
    }

    return { typeDefIndex, funcTypeRefs, funcPayloadRefs };
}

export function enrichAnalysisResults(
    analysisResults: StaticAnalysisResult[],
    parsedFiles: ParsedFileResult[],
    fileImportMaps: FileImportMap[],
    discoveryResult: DiscoveryResult,
    task?: ProgressReporter,
    /**
     * Pre-computed Zodios indices from the analyzeFiles phase. When provided,
     * skip the redundant `collectZodiosAliasMaps` call here — the same indices
     * were used by `buildAnalysisTasks` Gate 7 to rescue Zodios consumers.
     */
    prebuiltZodios?: {
        zodiosIndex: ReturnType<typeof collectZodiosAliasMaps>['zodiosIndex'];
        zodiosTypeIndex: ReturnType<typeof collectZodiosAliasMaps>['zodiosTypeIndex'];
        basenameIndex: ReturnType<typeof buildBasenameSuffixIndex>;
    },
): void {
    const constantsByFile = new Map(
        parsedFiles
            .filter(parsed => parsed.fileConstants.length > 0)
            .map(parsed => [parsed.fileContext.relativePath, parsed.fileConstants] as const),
    );
    const docsByFile = new Map(
        parsedFiles
            .filter(parsed => parsed.fileContent.length > 0)
            .map(parsed => [parsed.fileContext.relativePath, extractGraphQLDocumentsFromSource(parsed.fileContent, parsed.fileContext.relativePath)] as const)
            .filter(([, docs]) => docs.length > 0),
    );

    // ── GraphQL Operation Files (consumer-side .gql/.graphql, synthetic index) ──
    // Walks the repo for standalone operation documents. Index is keyed by
    // path/basename so call sites that load .gql via file_get_contents() get
    // exactly one operation entry injected — never the full file body.
    const gqlOperationsIndex = buildGraphQLOperationsIndex(discoveryResult.repo.path);
    const clientBindingRegistry = new Map<string, ClientBinding>();
    for (const result of analysisResults) {
        for (const analysisTask of result.analysisTasks) {
            for (const binding of analysisTask.clientBindings ?? []) {
                clientBindingRegistry.set(binding.token, binding);
            }
        }
    }

    // ── Zodios Index: built once, queried per task ────────────────────────
    // Reuse the pre-computed indices from analyzeFiles when available, so the
    // task-builder Gate 7 and this enrichment pass agree on the same Zodios
    // mapping (and we avoid scanning every file twice).
    const basenameIndex = prebuiltZodios?.basenameIndex ?? buildBasenameSuffixIndex(discoveryResult.allFilePaths);
    let zodiosIndex = prebuiltZodios?.zodiosIndex;
    let zodiosTypeIndex = prebuiltZodios?.zodiosTypeIndex;
    if (!zodiosIndex || !zodiosTypeIndex) {
        const indices = collectZodiosAliasMaps(
            parsedFiles.map(parsed => ({
                relativePath: parsed.fileContext.relativePath,
                fileContent: parsed.fileContent,
            })),
            fileImportMaps,
            discoveryResult.allFilePaths,
            basenameIndex,
        );
        zodiosIndex = indices.zodiosIndex;
        zodiosTypeIndex = indices.zodiosTypeIndex;
    }

    // Per-path index of import maps so the two enrichment loops below can do
    // O(1) lookups instead of `.find()` over `fileImportMaps`. With 8K+ files
    // and ~8K analysisResults the original walks were O(N^2) = 64M string
    // compares each, dominating Stage 2 wall time on large repos.
    const importMapByPath = new Map<string, FileImportMap>();
    for (const m of fileImportMaps) importMapByPath.set(m.filePath, m);

    for (const result of analysisResults) {
        const importMap = importMapByPath.get(result.fileContext.relativePath);

        for (const analysisTask of result.analysisTasks) {
            const resolvedConstants = collectResolvedConstantsForTask(
                analysisTask,
                importMap,
                discoveryResult.allFilePaths,
                constantsByFile,
                basenameIndex,
            );
            if (resolvedConstants.length > 0) {
                analysisTask.resolvedConstants = resolvedConstants;
                analysisTask.classConstantsContext = formatResolvedConstantsContext(resolvedConstants)
                    ?? analysisTask.classConstantsContext;
            }

            analysisTask.clientBindingContext = buildClientBindingContext(analysisTask, clientBindingRegistry);
            const tsDocContext = buildGraphQLDocumentContext(
                analysisTask,
                importMap,
                discoveryResult.allFilePaths,
                docsByFile,
            );
            // Call-site-scoped resolution against the synthetic .gql index.
            // We scan only the chunk's own source (not the whole file) so each
            // task gets at most a handful of entries — the index itself is
            // never injected into the prompt.
            const gqlFileEntries = (gqlOperationsIndex.byBasename.size + gqlOperationsIndex.byRelativePath.size) > 0
                ? findGqlLiteralReferencesInSource(analysisTask.chunk.sourceCode, gqlOperationsIndex)
                : [];
            const fileDocContext = formatGqlOperationContext(gqlFileEntries);
            analysisTask.graphQLDocumentContext = [tsDocContext, fileDocContext]
                .filter((s): s is string => Boolean(s))
                .join('\n') || undefined;

            // ── Zodios API Calls: resolved deterministically (post-LLM injection) ────
            if (zodiosIndex.size > 0) {
                const resolved = resolveZodiosCallsForTask(
                    analysisTask,
                    importMap,
                    discoveryResult.allFilePaths,
                    zodiosIndex,
                    zodiosTypeIndex,
                    basenameIndex,
                );
                if (resolved.length > 0) {
                    analysisTask.zodiosResolvedCalls = resolved;
                }
            }
        }
    }

    const entityRegistry = collectEntityTableRegistry(analysisResults);

    if (entityRegistry.length > 0) {
        if (task && logger.isDebugEnabled()) {
            task.report(
                `[EntityRegistry] ${entityRegistry.length} entity→table mapping(s): ${entityRegistry.map(entry => `${entry.shortName}→${entry.tableName}`).join(', ')}`,
            );
        }

        for (const result of analysisResults) {
            const importMap = importMapByPath.get(result.fileContext.relativePath);

            for (const analysisTask of result.analysisTasks) {
                if (analysisTask.isResolvedStatically) continue;

                const chunkName = analysisTask.chunk.name;
                const dotIdx = chunkName.lastIndexOf('.');
                const qualifiedClass = dotIdx > 0 ? chunkName.substring(0, dotIdx) : chunkName;
                const lastBackslash = qualifiedClass.lastIndexOf('\\');
                const fileNamespace = lastBackslash > 0 ? qualifiedClass.substring(0, lastBackslash) : undefined;

                const entityContext = buildEntityTableContext(
                    analysisTask,
                    entityRegistry,
                    importMap,
                    fileNamespace,
                );

                if (entityContext) {
                    analysisTask.entityTableContext = entityContext;
                }
            }
        }
    }
}
