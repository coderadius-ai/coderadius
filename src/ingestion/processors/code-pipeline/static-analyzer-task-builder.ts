import fs from 'node:fs';
import { hasZodiosCallsInChunk } from './zodios-context-builder.js';
import { likelyHasIOWithTaint, type FilterVerdict } from '../../core/heuristic-filter.js';
import { computeFunctionHash } from '../../core/merkle.js';
import { telemetryCollector, traceCollector } from '../../../telemetry/index.js';
import type {
    ClassPropertyAlias,
    FileImportMap,
    FileTaintInfo,
} from '../../core/import-graph.js';
import {
    buildStaticAnalysisFromResolvedInvocations,
    formatResolvedInvocationContext,
    type CriticalInvocationFact,
    type ValueFact,
    type ValueResolutionIndex,
} from '../../core/value-resolution/index.js';
import { getLanguagePlugin } from '../../core/languages/registry.js';
import { logger } from '../../../utils/logger.js';
import { isCompatibleScanMode } from '../../../graph/scan-mode.js';
import type { ScanMode } from '../../../graph/scan-mode.js';
import { getQualifiedRepoName } from '../../../graph/urn.js';
import {
    formatFrameworkSignalContext,
    hasHardEntrypointCapability,
    matchFrameworkSignalsToChunk,
} from '../../core/framework-signal-overlay.js';
import type {
    FileContext,
    DiscoveryResult,
    StaticAnalysisResult,
    AnalysisTask,
    SchemaContext,
    UnchangedFunctionRef,
    ProgressReporter,
} from './types.js';
import type { ChunkStaticData } from './parse-protocol.js';
import { categorizeImportSources } from '../../../ai/agents/unified-analyzer.js';
import {
    buildTaintContextSummary,
    extractSinkImports,
    deriveClassName,
    formatFileConstantsContext,
    formatTypeDefinitions,
    hasActiveTaint,
    isGeneratedFPCallback,
    makeFunctionIdForRepo,
    type FuncTypeRefsMap,
    type FuncPayloadRefsMap,
    type TypeDefinitionIndex,
} from './static-analyzer-context.js';

/**
 * Per-file output of the parse phase. All AST-derived facts are flat data
 * extracted in the parse workers (see parse-protocol.ts) — the native
 * tree-sitter root never crosses the thread boundary, so there is no
 * `rootNode` here; everything downstream consumes precomputed fields.
 */
export interface ParsedFileResult {
    fileContext: FileContext;
    chunks: import('../../../graph/types.js').CodeChunk[];
    language: string;
    frameworkSignals: import('../../core/languages/types.js').FrameworkSignal[];
    fileContent: string;
    fileConstants: Array<{ scope: string; name: string; value: string }>;
    valueFacts: ValueFact[];
    criticalInvocations: CriticalInvocationFact[];
    componentDefinitions: import('../../core/languages/types.js').ComponentDefinition[];
    dependencyRequirements: import('../../core/languages/types.js').DependencyRequirement[];
    /** Per-chunk AST facts, index-aligned with `chunks`. Empty on cache hits. */
    chunkStaticData: ChunkStaticData[];
    /** File-level import statements (verbatim source lines). */
    importStatements: string[];
    /** Class name → verbatim constructor source. */
    constructorSources: Map<string, string>;
    /** AST schema-gate verdict (always false on cache hits). */
    mayContainSchemas: boolean;
    /** Deep-scan type metadata (contracts mode only, null otherwise). */
    typeDefinitions: Map<string, import('../../core/languages/types.js').DataStructureDefinition> | null;
    referencedTypes: Map<string, string[]> | null;
    payloadHints: Map<string, import('../../core/languages/types.js').FunctionPayloadHints> | null;
    isCacheHit: boolean;
    unchangedFunctions: UnchangedFunctionRef[];
    unchangedFunctionCount: number;
}

function buildClassProperties(
    className: string | null,
    aliases: ClassPropertyAlias[],
): string[] | undefined {
    if (!className) return undefined;

    const classProperties = aliases
        .filter(alias => alias.propertyAccess.startsWith('this.') || alias.propertyAccess.startsWith('this->'))
        .map(alias => `${alias.propertyAccess}: ${alias.typeName}`);

    return classProperties.length > 0 ? classProperties : undefined;
}

export function buildAnalysisTasks(
    parsed: ParsedFileResult,
    discoveryResult: DiscoveryResult,
    taintInfo?: FileTaintInfo,
    task?: ProgressReporter,
    scanMode: ScanMode = 'semantic',
    classPropertyAliases?: ClassPropertyAlias[],
    fileImportMap?: FileImportMap,
    customKnowledge?: string,
    typeDefIndex?: TypeDefinitionIndex,
    funcTypeRefs?: FuncTypeRefsMap,
    funcPayloadRefs?: FuncPayloadRefsMap,
    symbolTaintedFiles?: Map<string, Set<string>>,
    freshScan: boolean = false,
    configuredTableNames?: Set<string>,
    valueResolutionIndex?: ValueResolutionIndex,
    /** User-configured sink packages from packages.analyze (plain names). Forwarded to taint context for LLM visibility. */
    extraSinkPackages?: string[],
    zodiosTypeIndex?: import('./zodios-context-builder.js').ZodiosTypeIndex,
    zodiosIndex?: import('./zodios-context-builder.js').ZodiosIndex,
    allFilePaths?: Set<string>,
    basenameIndex?: import('./static-analyzer-context.js').BasenameSuffixIndex,
): StaticAnalysisResult {
    const isDeepScan = scanMode === 'contracts';
    const { fileContext, chunks, frameworkSignals, fileConstants } = parsed;
    const { relativePath } = fileContext;
    const prevFileEntry = discoveryResult.merkleIndex.files.get(relativePath);

    const importStatements = parsed.importStatements;
    const constructorSources = parsed.constructorSources;
    const aliases = classPropertyAliases ?? [];

    // Hoist per-file once: names of AST-grounded service interfaces (kind:'interface'
    // AND interfaceRole:'service'). Shared by reference across every AnalysisTask
    // for this file, then forwarded to the sanitizer's knownServiceInterfaces
    // option. Service interfaces are dropped from produced/consumed_payloads;
    // data interfaces (only property declarations) are preserved.
    let knownServiceInterfaces: Set<string> | undefined;
    if (typeDefIndex) {
        const set = new Set<string>();
        for (const [name, def] of typeDefIndex) {
            if (def.kind === 'interface' && def.interfaceRole === 'service') {
                set.add(name);
            }
        }
        if (set.size > 0) knownServiceInterfaces = set;
    }

    const analysisTasks: AnalysisTask[] = [];
    const unchangedFunctions: UnchangedFunctionRef[] = [];
    let skippedFunctionCount = 0;
    let unchangedFunctionCount = 0;

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const chunkStatic: ChunkStaticData | undefined = parsed.chunkStaticData[chunkIdx];
        chunk.filepath = relativePath;
        const functionId = makeFunctionIdForRepo(fileContext.repo, relativePath, chunk);
        const functionHash = computeFunctionHash(chunk.sourceCode);

        const prevFunc = prevFileEntry?.functions.get(functionId);

        let isFuncCacheValid = true;
        if (prevFunc) {
            if (isDeepScan) {
                const wasDeepScanned = isCompatibleScanMode(prevFileEntry?.fileScanMode, 'contracts');
                isFuncCacheValid = wasDeepScanned || !prevFunc.hasIO;
            } else {
                isFuncCacheValid = true;
            }
        }

        const taintedFunctionIds = symbolTaintedFiles?.get(relativePath);
        const isFuncTainted = taintedFunctionIds ? taintedFunctionIds.has(functionId) : false;
        
        if (freshScan) {
            traceCollector.traceFilter('INFO', functionId, '--force mode: force re-analysis', { filePath: relativePath });
        } else if (isFuncTainted) {
            traceCollector.traceFilter('INFO', functionId, 'config symbol changed, force re-analysis', { filePath: relativePath });
        }

        if (!freshScan && prevFunc && prevFunc.sourceHash === functionHash && isFuncCacheValid && !isFuncTainted) {
            unchangedFunctionCount++;
            unchangedFunctions.push({
                functionId,
                relativePath,
                repoName: fileContext.repo.name,
            });
            telemetryCollector.incrementFunctionsUnchanged();
            telemetryCollector.incrementCacheHits();
            traceCollector.traceFilter('CACHE_HIT', functionId, 'function hash unchanged', { filePath: relativePath, functionHash });
            continue;
        }

        const staticResult = chunkStatic?.staticInfra ?? null;
        const supplements = chunkStatic?.supplements ?? null;
        const resolvedInvocations = valueResolutionIndex?.resolveInvocationsForChunk(relativePath, chunk) ?? [];
        const resolvedInvocationContext = formatResolvedInvocationContext(resolvedInvocations);
        // Plan v10 §H: pass chunk.sourceCode so name-safety validation in
        // the DI bypass path can use the consumer source (reserved hook;
        // current validators use ioTag.evidenceSource.sourceSlice). The
        // language plugin supplies the framework DI-handle grammar.
        const resolvedInvocationStatic = buildStaticAnalysisFromResolvedInvocations(
            resolvedInvocations,
            chunk.sourceCode,
            getLanguagePlugin(parsed.language) ?? undefined,
        );

        if (staticResult) {
            traceCollector.traceFilter('STATIC', functionId, 'resolved statically from AST', {
                filePath: relativePath,
                functionName: chunk.name,
                infraCount: staticResult.infrastructure?.length ?? 0,
                tableName: staticResult.infrastructure?.[0]?.name,
            });

            analysisTasks.push({
                kind: 'analysis',
                functionId,
                functionHash,
                chunk,
                fileContext,
                staticAnalysis: staticResult as any,
                isResolvedStatically: true,
                resourceDeclarations: supplements?.resourceDeclarations,
                clientBindings: supplements?.clientBindings,
                resolvedInvocationContext,
            });
            continue;
        }

        if (resolvedInvocationStatic) {
            traceCollector.traceFilter('STATIC', functionId, 'resolved statically from value resolution', {
                filePath: relativePath,
                functionName: chunk.name,
                infraCount: resolvedInvocationStatic.infrastructure.length,
                infrastructure: resolvedInvocationStatic.infrastructure,
            });

            analysisTasks.push({
                kind: 'analysis',
                functionId,
                functionHash,
                chunk,
                fileContext,
                staticAnalysis: resolvedInvocationStatic as any,
                isResolvedStatically: true,
                resourceDeclarations: supplements?.resourceDeclarations,
                clientBindings: supplements?.clientBindings,
                resolvedInvocationContext,
            });
            continue;
        }

        if (isGeneratedFPCallback(chunk.name)) {
            traceCollector.traceFilter('DROP', functionId, 'auto-generated FP callback', {
                filePath: relativePath,
                functionName: chunk.name,
            });
            skippedFunctionCount++;
            telemetryCollector.incrementFunctionsSkipped();
            continue;
        }

        const verdict: FilterVerdict = likelyHasIOWithTaint(chunk, taintInfo);

        // ── Gate 4 AST Service-Call Verification ──────────────────────────
        // When Gate 4 (tainted symbol) matched, verify via AST that the
        // function actually contains a service/member call expression.
        // Gate 4 matches if the source text contains a tainted symbol name,
        // but pure functions (validators, mappers) in tainted files contain
        // the symbol only in type annotations or parameter lists — they
        // never invoke it. The AST check is deterministic and precomputed
        // per chunk in the parse worker (gate4HasCalls).
        //
        // Only Gate 4 is subject to this override:
        //   Gate 1/2/3 are architectural signals, not symbol matches
        //   Gate 5 (DI alias) already implies this.xxx usage
        let gate4AstOverride = false;
        if (verdict.passed && verdict.gate === 4 && chunkStatic?.gate4HasCalls === false) {
            gate4AstOverride = true;
            traceCollector.traceFilter('DROP', functionId,
                `gate4-ast-override:no-service-call (symbol: ${verdict.reason})`,
                { filePath: relativePath, functionName: chunk.name, gate: 4.5 },
            );
        }

        // ── Gate 2 AST Override: Service Call Check ─────────────────────
        // Gate 2 passes any method on a Repository/DAO/Store/Writer class
        // that matches the verb whitelist. Pure helper methods (formatters,
        // validators, param mappers) with zero this.xxx() calls are safe
        // to drop — they never invoke an injected dependency.
        // Uses the same generic check as Gate 4 (hasServiceCallsInRange,
        // precomputed as gate2HasCalls), NOT a sink-specific regex —
        // Repository classes can wrap any I/O (TypeORM, HTTP, brokers,
        // caches), not just persistence.
        let gate2AstOverride = false;
        if (verdict.passed && verdict.gate === 2 && chunkStatic?.gate2HasCalls === false) {
            gate2AstOverride = true;
            traceCollector.traceFilter('DROP', functionId,
                `gate2-ast-override:no-service-call (convention: ${verdict.reason})`,
                { filePath: relativePath, functionName: chunk.name, gate: 2.5 },
            );
        }

        // ── Gate 6: Framework / Supplemental Rescue ──────────────────────
        // Thin controller methods (e.g. `return this.service.doWork()`)
        // can fail Gates 1-5. But if AST-detected framework decorators
        // (@Post, @Get, @MessagePattern, @Cron, ...) mark this chunk as an
        // entrypoint, we MUST analyze it — the overlay will inject the
        // correct INBOUND endpoint during post-LLM merge. Same for
        // supplemental static-analyzer signals (resolved critical
        // invocations, client bindings, resource declarations).
        const matchedFrameworkSignals = frameworkSignals.length > 0
            ? matchFrameworkSignalsToChunk(chunk.name, frameworkSignals)
            : [];
        const hasEntrypointSignal = hasHardEntrypointCapability(matchedFrameworkSignals);

        // ── Gate 7: Zodios consumer rescue ────────────────────────────────
        // A Zodios client is wrapped behind a typed interface (e.g.
        // `IPricingApiRepository = typeof endpoints`). Consumer methods call
        // `.aliasName(...)` on the injected property — heuristic gates miss
        // this because there's no SQL / decorator / direct HTTP literal.
        //
        // Two-step check:
        //   Step 1: Does this file import any Zodios consumer type?
        //   Step 2: Does this specific chunk call an endpoint method on the
        //           Zodios client? (receiver-based, not method-name based)
        //
        // Step 2 eliminates ~86% waste from functions that share a file with
        // Zodios imports but never invoke the client (helpers, accessors,
        // factory/setup code). Only generated endpoint aliases (from makeApi)
        // are in the alias map; factory/config methods are excluded by design.
        let hasZodiosConsumerImport = false;
        if (zodiosTypeIndex && zodiosTypeIndex.size > 0 && fileImportMap) {
            outer: for (const imp of fileImportMap.imports) {
                if (imp.isExternal) continue;
                for (const spec of imp.specifiers) {
                    if (zodiosTypeIndex.has(spec)) {
                        hasZodiosConsumerImport = true;
                        break outer;
                    }
                }
            }
        }

        if (hasZodiosConsumerImport && zodiosIndex && fileImportMap && allFilePaths) {
            const chunkClassName = deriveClassName(chunk.name);
            const ctorSrc = chunkClassName ? (constructorSources.get(chunkClassName) ?? '') : '';
            const hasCalls = hasZodiosCallsInChunk(
                chunk.sourceCode, ctorSrc, fileImportMap,
                allFilePaths, zodiosIndex, zodiosTypeIndex!, basenameIndex,
            );
            if (!hasCalls) {
                traceCollector.traceFilter('DROP', functionId,
                    'gate7-receiver-check:no-zodios-call-in-chunk',
                    { filePath: relativePath, functionName: chunk.name, gate: 7.5 },
                );
                hasZodiosConsumerImport = false;
            }
        }

        if ((!verdict.passed || gate4AstOverride || gate2AstOverride) && !supplements?.resourceDeclarations?.length && !supplements?.clientBindings?.length && !resolvedInvocationContext && !hasEntrypointSignal && !hasZodiosConsumerImport) {
            if (logger.isDebugEnabled() && task) {
                const taintStatus = hasActiveTaint(taintInfo) ? 'tainted' : 'untainted';
                task.report(`  \x1b[31m✗\x1b[0m ${chunk.name} → DISCARD (${taintStatus}, no gate passed)`);
            }
            const taintStatus = hasActiveTaint(taintInfo) ? 'tainted' : 'untainted';
            traceCollector.traceFilter('DROP', functionId, 'all gates failed', { filePath: relativePath, functionName: chunk.name, taintStatus });
            skippedFunctionCount++;
            telemetryCollector.incrementFunctionsSkipped();
            if (hasActiveTaint(taintInfo)) {
                telemetryCollector.incrementDroppedAllGates();
            } else {
                telemetryCollector.incrementDroppedUntainted();
            }
            continue;
        }

        // Gate 6/7 are catch-all rescues for static-analyzer-derived signals:
        // - Gate 6: framework decorator entrypoints + supplemental signals
        //   (resolved critical invocations, client bindings, resource declarations).
        // - Gate 7: Zodios-typed consumer import (post-LLM resolver attaches
        //   emergent_api_calls to the rescued task).
        // All arrive from the AST + plugin static path, not from the heuristic
        // filter — they share the same "static rescue" semantics.
        const isGate7 = !verdict.passed && hasZodiosConsumerImport && !hasEntrypointSignal && !resolvedInvocationContext && !supplements?.clientBindings?.length && !supplements?.resourceDeclarations?.length;
        let filterGate: 1 | 2 | 3 | 4 | 5 | 6 | 7 = verdict.passed ? verdict.gate! : (isGate7 ? 7 : 6);
        let filterReason = verdict.passed
            ? verdict.reason
            : (isGate7
                ? 'gate7:zodios-consumer-import'
                : (hasEntrypointSignal
                    ? 'gate6:framework-entrypoint'
                    : (resolvedInvocationContext ? 'supplemental:resolved-critical-invocation' : 'supplemental:deterministic-hints')));
        const gateNames: Record<number, string> = {
            1: 'UseCase Entrypoint',
            2: 'Architectural Convention',
            3: 'Synthetic Chunk',
            4: 'Tainted Symbol',
            5: 'DI Alias',
            6: 'Framework / Supplemental',
            7: 'Zodios Consumer',
        };
        const gateName = gateNames[filterGate] || 'unknown';
        telemetryCollector.incrementPassedGate(filterGate);
        if (logger.isDebugEnabled() && task) {
            task.report(`  \x1b[32m✓\x1b[0m ${chunk.name} → QUEUE (Gate ${filterGate}: ${gateName} — ${filterReason})`);
        }
        traceCollector.traceFilter('PASS', functionId, filterReason, { filePath: relativePath, functionName: chunk.name, gate: filterGate, gateName });

        const className = deriveClassName(chunk.name);
        const constructorSource = className ? constructorSources.get(className) : undefined;
        const classProperties = buildClassProperties(className, aliases);

        const taintContextSummary = buildTaintContextSummary(taintInfo, fileImportMap, extraSinkPackages);
        // Stage 5: derive structured sink categories from the import graph (not
        // by parsing the summary string) to scope the analyzer prompt + schema.
        const sinkCats = categorizeImportSources(extractSinkImports(fileImportMap));
        const chunkClassName = deriveClassName(chunk.name);
        const classConstantsContext = formatFileConstantsContext(fileConstants, chunkClassName, chunk.sourceCode);
        const frameworkSignalContext = matchedFrameworkSignals.length > 0
            ? formatFrameworkSignalContext(matchedFrameworkSignals)
            : undefined;

        analysisTasks.push({
            kind: 'analysis',
            functionId,
            functionHash,
            chunk,
            fileContext,
            filterGate,
            filterReason,
            sinkCategories: sinkCats ? [...sinkCats] : undefined,
            imports: importStatements.length > 0 ? importStatements : undefined,
            constructorSource,
            classProperties,
            taintContextSummary,
            customKnowledge,
            resolvedTypeDefinitions: isDeepScan && typeDefIndex && funcTypeRefs
                ? formatTypeDefinitions(chunk.name, typeDefIndex, funcTypeRefs, relativePath)
                : undefined,
            classConstantsContext,
            resolvedInvocationContext,
            resourceDeclarations: supplements?.resourceDeclarations,
            clientBindings: supplements?.clientBindings,
            matchedFrameworkSignals: matchedFrameworkSignals.length > 0 ? matchedFrameworkSignals : undefined,
            frameworkSignalContext,
            configuredTableNames,
            knownServiceInterfaces,
            astResolvedPayloads: funcPayloadRefs?.get(relativePath)?.get(chunk.name),
        });
    }

    const newFunctionIds = new Set(analysisTasks.map(entry => entry.functionId).concat(unchangedFunctions.map(entry => entry.functionId)));
    const deletedFunctions: string[] = [];
    if (prevFileEntry) {
        for (const [oldFunctionId] of prevFileEntry.functions) {
            if (!newFunctionIds.has(oldFunctionId)) {
                deletedFunctions.push(oldFunctionId);
            }
        }
    }

    let schemaContext: SchemaContext | null = null;
    if (parsed.mayContainSchemas) {
        const schemaFileContent = fs.readFileSync(fileContext.absolutePath, 'utf-8');
        schemaContext = {
            filePath: fileContext.absolutePath,
            relativePath,
            qualifiedRepoName: getQualifiedRepoName(fileContext.repo),
            fileContent: schemaFileContent,
            frameworkSignalContext: frameworkSignals.length > 0 ? formatFrameworkSignalContext(frameworkSignals) : undefined,
        };
    }

    return {
        fileContext,
        analysisTasks,
        skippedFunctionCount,
        unchangedFunctionCount,
        unchangedFunctions,
        deletedFunctions,
        schemaContext,
        language: parsed.language,
    };
}
