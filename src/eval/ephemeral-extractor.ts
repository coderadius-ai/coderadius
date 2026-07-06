// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine — Ephemeral Extractor
//
// Step 3 of the In-Memory Graph Overlay pipeline.
//
// Runs the existing neuro-symbolic extraction pipeline (StaticAnalyzer →
// SemanticExtractor) ONLY on the PR-changed files, in DRY-RUN mode.
//
// Key constraints:
//   1. ZERO writes to Memgraph — the GraphWriter (Stage 4) is never invoked.
//   2. The Merkle cache is IGNORED — we always re-analyze changed files.
//      (This is intentional for CI: the PR may not be on disk yet.)
//   3. The SymbolRegistry is pre-loaded by the caller (from symbol-registry-loader).
//   4. Output is captured in-memory as a Map<filePath, FileTopologySnapshot>.
//
// Instead of going through the full orchestrator (which writes to DB), this
// module uses the pipeline stages directly and builds the FileTopologySnapshot
// by translating the UnifiedAnalysis output into GraphEdgeSnapshot/GraphNodeSnapshot.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { parseSource } from '../ingestion/processors/parser/index.js';
import { likelyHasIOWithTaint } from '../ingestion/core/heuristic-filter.js';
import {
    extractImportsFromAST,
    extractClassPropertyAliases,
    extractDependencyBindings,
    runTaintAnalysis,
} from '../ingestion/core/import-graph.js';
import { extractSemantics } from '../ingestion/processors/code-pipeline/semantic-extractor.js';
import { computeFunctionHash } from '../ingestion/core/merkle.js';
import { buildUrn, buildFunctionSignature } from '../graph/urn.js';
import { getAllPlugins, getLanguagePlugin } from '../ingestion/core/languages/registry.js';
import { loadRepoHints, buildCustomKnowledgePrompt, getExtraSinks, getIgnorePackages, type RepoHints } from '../config/repo-hints.js';
import { loadRepoContext } from '../config/repo-context.js';
import { logger } from '../utils/logger.js';
import { resolveContainerScope, resolveDatastoreBinding } from '../ingestion/processors/db-scope-resolver.js';
import type { SymbolRegistry } from '../ingestion/core/symbol-registry.js';
import type { AnalysisTask, FileContext } from '../ingestion/processors/code-pipeline/types.js';
import type { UnifiedAnalysis } from '../ai/agents/unified-analyzer.js';
import type { GraphEdgeSnapshot, GraphNodeSnapshot, FileTopologySnapshot } from './types.js';
import type { EnrichedRepoContext } from '../config/repo-context.js';
import { GENERIC_INFRA_NAMES } from '../ai/workflows/sanitizer.js';
import { normalizeApiPathLossless } from '../ingestion/processors/api-path-utils.js';
import { pruneDuplicateRouteImplementations } from './endpoint-identity.js';
import { rewireEphemeralEdgesToWeldedTargets } from './ephemeral-weld-resolver.js';

// ─── Infrastructure edge mapping ─────────────────────────────────────────────

const CONSUMER_CAPABILITIES = new Set(['message-consumer', 'queue-consumer', 'event-listener']);

/**
 * Map a UnifiedAnalysis infrastructure entry to the relationship type
 * used in the graph. Mirrors graph-writer.ts logic (read-only translation).
 */
function infraToRelType(
    infraType: string,
    capabilities: string[],
): { relType: string; nodeType: string } | null {
    switch (infraType) {
        case 'Database':
        case 'ObjectStorage':
            return null; // Handled separately as DataContainer edges (unified ontology)
        case 'MessageChannel': {
            const isConsumer = capabilities.some(c => CONSUMER_CAPABILITIES.has(c));
            return {
                relType: isConsumer ? 'LISTENS_TO' : 'PUBLISHES_TO',
                nodeType: 'MessageChannel',
            };
        }
        case 'Cache':
            return { relType: 'CONNECTS_TO', nodeType: 'Datastore' };
        case 'Process':
            return { relType: 'SPAWNS', nodeType: 'SystemProcess' };
        case 'ExternalAPI':
            return null; // Handled via emergent_api_calls
        default:
            return null;
    }
}

// ─── Translation: UnifiedAnalysis → FileTopologySnapshot ─────────────────────

/**
 * Translate a single function's LLM-extracted analysis into edges and nodes
 * for the CI topology snapshot.
 *
 * This is the read-only equivalent of `persistFunction` in graph-writer.ts:
 * instead of writing to Memgraph, it accumulates the output in memory.
 */
function translateAnalysisToTopology(
    functionId: string,
    functionName: string,
    filePath: string,
    analysis: UnifiedAnalysis,
    qualifiedRepoName: string,
    repoHints: RepoHints,
    repoCtx: EnrichedRepoContext,
): { edges: GraphEdgeSnapshot[]; nodes: GraphNodeSnapshot[] } {
    const edges: GraphEdgeSnapshot[] = [];
    const nodes: GraphNodeSnapshot[] = [];
    const capabilities = analysis.capabilities ?? [];

    if (!analysis.has_io) return { edges, nodes };

    // ── Infrastructure nodes (MessageChannel, Datastore, SystemProcess) ────
    for (const infra of analysis.infrastructure ?? []) {
        if (GENERIC_INFRA_NAMES.has(infra.name.toLowerCase())) continue;

        if (infra.type === 'Database' || infra.type === 'ObjectStorage') {
            // Dynamic/opaque names → fall through to generic Datastore path (parity with graph-writer.ts)
            const isDynamic = infra.name === '<DYNAMIC>' || /unknown|placeholder/i.test(infra.name);
            if (isDynamic && infra.type === 'ObjectStorage') {
                // ObjectStorage with unresolvable name → CONNECTS_TO Datastore (same as graph-writer.ts)
                const bindings = resolveDatastoreBinding(
                    null, 'ObjectStorage', repoHints, null,
                    repoCtx.identities,
                );
                for (const binding of bindings) {
                    const dsUrn = buildUrn('datastore', binding.shared ? 'shared' : qualifiedRepoName, binding.datastoreId);
                    nodes.push({ id: dsUrn, type: 'Datastore', name: binding.datastoreId, sourceFile: filePath });
                    edges.push({
                        sourceId: functionId, sourceName: functionName,
                        targetId: dsUrn, targetName: binding.datastoreId,
                        relType: 'CONNECTS_TO', sourceFile: filePath, targetType: 'Datastore',
                    });
                }
                continue;
            }

            // DataContainer edges — scoped URN via resolveContainerScope (Phase 1a/1c)
            const { scope: containerScope, scopeSource } = resolveContainerScope(
                infra.name, qualifiedRepoName, repoHints,
            );
            const containerUrn = buildUrn('datacontainer', containerScope, infra.name);
            const op = infra.operation as string;
            const relType = op === 'WRITES' ? 'WRITES' : (op === 'MAPS_TO' ? 'MAPS_TO' : 'READS');
            nodes.push({
                id: containerUrn,
                type: 'DataContainer',
                name: infra.name,
                sourceFile: filePath,
                scope: containerScope,
                scopeSource,
                sourceRepo: qualifiedRepoName,
            });
            edges.push({
                sourceId: functionId,
                sourceName: functionName,
                targetId: containerUrn,
                targetName: infra.name,
                relType,
                sourceFile: filePath,
                targetType: 'DataContainer',
            });

            // ObjectStorage: also try to bind to a Datastore (STORED_IN parity)
            if (infra.type === 'ObjectStorage') {
                const osBindings = resolveDatastoreBinding(
                    infra.name, 'ObjectStorage', repoHints, null,
                    repoCtx.identities,
                );
                for (const osBinding of osBindings) {
                    const dsUrn = buildUrn('datastore', osBinding.shared ? 'shared' : qualifiedRepoName, osBinding.datastoreId);
                    nodes.push({ id: dsUrn, type: 'Datastore', name: osBinding.datastoreId, sourceFile: filePath });
                    edges.push({
                        sourceId: functionId, sourceName: functionName,
                        targetId: dsUrn, targetName: osBinding.datastoreId,
                        relType: 'CONNECTS_TO', sourceFile: filePath, targetType: 'Datastore',
                    });
                }
            }
            continue;
        }

        // Cache / ObjectStorage / MessageChannel / SystemProcess
        const mapping = infraToRelType(infra.type, capabilities);
        if (!mapping) continue;

        // For Cache/ObjectStorage that map to Datastore nodes:
        // Without datastores[] in coderadius.yaml → no Datastore node (POC policy).
        // The selectDatastoreHint algorithm lives in graph-writer.ts; in the eval path
        // we mirror the same policy: no datastores config = skip Datastore nodes.
        if (mapping.nodeType === 'Datastore') {
            // Use resolveDatastoreBinding for Cache/ObjectStorage parity with writer.
            // P1+ tiers are gated to Database-only, so this only matches P0 (YAML
            // datastores[]) for Cache/ObjectStorage — correct behavior.
            const bindings = resolveDatastoreBinding(
                null, infra.type, repoHints, null,
                repoCtx.identities,
            );
            if (bindings.length === 0) continue; // No YAML config → skip (parity with writer)
            const binding = bindings[0];

            const dsUrn = buildUrn('datastore', binding.shared ? 'shared' : qualifiedRepoName, binding.datastoreId);
            nodes.push({
                id: dsUrn,
                type: 'Datastore',
                name: binding.datastoreId,
                sourceFile: filePath,
            });
            edges.push({
                sourceId: functionId,
                sourceName: functionName,
                targetId: dsUrn,
                targetName: binding.datastoreId,
                relType: 'CONNECTS_TO',
                sourceFile: filePath,
                targetType: 'Datastore',
            });
            continue;
        }

        const nodeUrn = buildUrn(mapping.nodeType.toLowerCase(), infra.name);
        nodes.push({
            id: nodeUrn,
            type: mapping.nodeType,
            name: infra.name,
            sourceFile: filePath,
        });
        edges.push({
            sourceId: functionId,
            sourceName: functionName,
            targetId: nodeUrn,
            targetName: infra.name,
            relType: mapping.relType,
            sourceFile: filePath,
            targetType: mapping.nodeType,
        });
    }

    // ── API endpoints (outbound calls + inbound exposed routes) ───────────
    for (const call of analysis.emergent_api_calls ?? []) {
        const normalizedPath = normalizeApiPathLossless(call.path);
        if (!normalizedPath) continue;

        const safeMethod = (call.method ?? 'POST').toUpperCase();
        const isInbound = call.direction === 'INBOUND';
        const endpointUrn = isInbound
            ? buildUrn('endpoint', 'code', safeMethod, normalizedPath)
            : buildUrn('endpoint', 'emergent', safeMethod, normalizedPath);

        // Display name keeps "METHOD /path" so dashboard's getHttpMethodMeta()
        // (packages/dashboard-ui/.../BlastExplorer.tsx) can split on space and
        // render the HTTP method badge. Topological identity is decoupled from
        // the display name via endpointIdentityKey.
        const displayName = `${safeMethod} ${normalizedPath}`;

        nodes.push({
            id: endpointUrn,
            type: 'APIEndpoint',
            name: displayName,
            sourceFile: filePath,
        });
        edges.push({
            sourceId: functionId,
            sourceName: functionName,
            targetId: endpointUrn,
            targetName: displayName,
            relType: isInbound ? 'IMPLEMENTS_ENDPOINT' : 'CALLS',
            sourceFile: filePath,
            targetType: 'APIEndpoint',
        });
    }

    // ── ORM entity schemas → DataStructure + DataField + HAS_FIELD ────────
    // Mirrors the writer's `entity_schemas` block. Without this translation,
    // the differ would never see column-level changes; it would compare the
    // DB-side HAS_FIELD chain against an empty ephemeral side and report
    // every column as removed.
    const entitySchemas = (analysis as any).entity_schemas as Array<{
        name: string;
        fields: Array<{ name: string; type: string; required?: boolean }>;
    }> | undefined;
    if (entitySchemas && entitySchemas.length > 0) {
        for (const schema of entitySchemas) {
            const tableName = schema.name.toLowerCase();
            const dsUrn = buildUrn('schema', 'database_table', tableName);
            nodes.push({
                id: dsUrn,
                type: 'DataStructure',
                name: schema.name,
                sourceFile: filePath,
            });
            edges.push({
                sourceId: functionId,
                sourceName: functionName,
                targetId: dsUrn,
                targetName: schema.name,
                relType: 'PRODUCES',
                sourceFile: filePath,
                targetType: 'DataStructure',
            });
            // DataContainer <-> DataStructure HAS_SCHEMA edge mirrors the
            // post-ingest `linkDataContainerSchemas` welder so the diff has
            // a stable join key. The DC URN matches the one emitted in the
            // infrastructure loop above (same table name, same scope).
            const containerScopeInfo = resolveContainerScope(schema.name, qualifiedRepoName, repoHints);
            const dcUrn = buildUrn('datacontainer', containerScopeInfo.scope, schema.name);
            edges.push({
                sourceId: dcUrn,
                sourceName: schema.name,
                targetId: dsUrn,
                targetName: schema.name,
                relType: 'HAS_SCHEMA',
                sourceFile: filePath,
                targetType: 'DataStructure',
            });
            for (const field of schema.fields) {
                const fieldUrn = buildUrn('schema', 'database_table', tableName, 'field', field.name);
                nodes.push({
                    id: fieldUrn,
                    type: 'DataField',
                    name: field.name,
                    sourceFile: filePath,
                });
                edges.push({
                    sourceId: dsUrn,
                    sourceName: schema.name,
                    targetId: fieldUrn,
                    targetName: field.name,
                    relType: 'HAS_FIELD',
                    sourceFile: filePath,
                    targetType: 'DataField',
                });
            }
        }
    }

    return { edges, nodes };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface EphemeralExtractorOptions {
    /** Absolute path to the repository root on disk. */
    repoRoot: string;
    /** Name of the repository (qualified: org/name). */
    repoName: string;
    /** Repo-relative paths of files to analyze. */
    changedFiles: string[];
    /** Optional per-file source overrides, used for read-only git baseline extraction. */
    fileContents?: Map<string, string>;
    /** Pre-loaded SymbolRegistry (from symbol-registry-loader). */
    symbolRegistry: SymbolRegistry;
    /** Enable verbose logging. */
    verbose?: boolean;
}

export interface EphemeralExtractionResult {
    /** Map of filePath → extracted topology (the "future" state). */
    snapshots: Map<string, FileTopologySnapshot>;
    /** Files that were skipped (unsupported language, not found, etc.). */
    skippedFiles: string[];
    /** LLM token usage across all files. */
    tokensUsed: { in: number; out: number; cached: number };
}

/**
 * Run the neuro-symbolic extraction pipeline on PR-changed files WITHOUT
 * writing anything to the database.
 *
 * This is the "ephemeral" mode: it mimics the full ingestion pipeline
 * (StaticAnalyzer → SemanticExtractor) but captures the output in RAM
 * as FileTopologySnapshots instead of persisting to Memgraph.
 */
export async function extractEphemeralTopology(
    opts: EphemeralExtractorOptions
): Promise<EphemeralExtractionResult> {
    const { repoRoot, repoName, changedFiles, fileContents, symbolRegistry, verbose } = opts;
    const snapshots = new Map<string, FileTopologySnapshot>();
    const skippedFiles: string[] = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalTokensCached = 0;

    // Initialize empty snapshots for all requested files
    for (const relPath of changedFiles) {
        snapshots.set(relPath, { filePath: relPath, nodes: [], edges: [] });
    }

    // ── Load repo context (YAML hints + auto-discovered P1/P2/P3 signals) ───
    const repoCtx = loadRepoContext(repoRoot);
    const repoHints = repoCtx.hints;
    const customKnowledge = buildCustomKnowledgePrompt(repoHints);

    // ── Load dependency mappings for import resolution ─────────────────────
    const dependencyMappings = getAllPlugins().flatMap(p =>
        p.loadDependencyMappings?.(repoRoot) ?? []
    );

    // ── Pass 1: Parse all changed files and collect import maps ───────────
    const parsedFiles: Array<{
        relPath: string;
        absolutePath: string;
        source: string;
        chunks: any[];
        rootNode: any;
        language: string;
    }> = [];
    const fileImportMaps: any[] = [];
    const classAliasMap = new Map<string, any[]>();
    const dependencyBindingMap = new Map<string, any[]>();
    const allFilePaths = new Set<string>();

    // Collect all repo file paths for import resolution context
    // (lightweight — we just need paths, not content)
    const allRelPaths = new Set<string>();
    for (const relPath of changedFiles) {
        allRelPaths.add(relPath);
    }

    for (const relPath of changedFiles) {
        const absolutePath = path.join(repoRoot, relPath);
        const overrideSource = fileContents?.get(relPath);

        if (overrideSource === undefined && !fs.existsSync(absolutePath)) {
            logger.debug(`[EphemeralExtractor] File not found on disk: ${relPath}`);
            skippedFiles.push(relPath);
            continue;
        }

        const source = overrideSource ?? fs.readFileSync(absolutePath, 'utf-8');
        const { chunks, rootNode, language } = parseSource(absolutePath, source, relPath);

        if (!language || language === 'unknown') {
            logger.debug(`[EphemeralExtractor] Unsupported language for: ${relPath}`);
            skippedFiles.push(relPath);
            continue;
        }

        parsedFiles.push({ relPath, absolutePath, source, chunks, rootNode, language });

        // Extract import maps for taint analysis
        const plugin = getLanguagePlugin(language);
        if (rootNode && plugin) {
            const importCtx = {
                filePath: relPath,
                allFilePaths: allRelPaths,
                dependencyMappings,
            };
            const importMap = extractImportsFromAST(rootNode, language, relPath, importCtx);
            fileImportMaps.push(importMap);

            const aliases = extractClassPropertyAliases(rootNode, language);
            if (aliases.length > 0) {
                classAliasMap.set(relPath, aliases);
            }

            const bindings = extractDependencyBindings(rootNode, language, relPath);
            if (bindings.length > 0) {
                dependencyBindingMap.set(relPath, bindings);
            }
        }
    }

    // ── Taint Analysis ────────────────────────────────────────────────────
    const taintMap = fileImportMaps.length > 0
        ? (() => {
            const extraSinks = getExtraSinks(repoHints);
            const ignoreList = getIgnorePackages(repoHints);
            return runTaintAnalysis(fileImportMaps, classAliasMap, [...dependencyBindingMap.values()].flat(), repoRoot,
                extraSinks.length > 0 ? extraSinks : undefined,
                ignoreList.length > 0 ? ignoreList : undefined);
        })()
        : new Map();

    // ── Pass 2: Build analysis tasks for each file ────────────────────────
    const llmLimit = pLimit(parseInt(process.env.LLM_CONCURRENCY ?? '3', 10));
    const extractionPromises: Promise<void>[] = [];

    for (const parsed of parsedFiles) {
        const { relPath, absolutePath, source, chunks, rootNode, language } = parsed;
        const analysisTasks: AnalysisTask[] = [];
        const taintInfo = taintMap.get(relPath);
        const fileImportMap = fileImportMaps.find((f: any) => f.filePath === relPath);
        const plugin = getLanguagePlugin(language);
        const fileContent = source;

        // Build a minimal FileContext (no DB queries needed)
        const routing = {
            type: 'repository' as const,
            name: repoName,
            urn: buildUrn('repository', repoName),
        };
        const fileContext: FileContext = {
            absolutePath,
            relativePath: relPath,
            repo: { name: repoName, path: repoRoot, origin: 'local' },
            routing,
            fileHash: 'ci-dry-run',
            ownerService: null,
            isManifest: false,
        };

        // Apply heuristic filter — same gate as regular ingestion
        for (const chunk of chunks) {
            chunk.filepath = relPath;

            const functionId = buildUrn(
                'function', repoName, language,
                buildFunctionSignature(chunk.name, relPath, language, {
                    startLine: chunk.startLine,
                    startColumn: chunk.startColumn,
                    endLine: chunk.endLine,
                    endColumn: chunk.endColumn,
                })
            );
            const functionHash = computeFunctionHash(chunk.sourceCode);
            const staticResult = plugin?.extractStaticInfra?.(rootNode!, chunk) ?? null;
            const supplements = rootNode
                ? plugin?.extractStaticSupplements?.(rootNode, fileContent, relPath, chunk) ?? null
                : null;

            if (staticResult) {
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
                });
                continue;
            }

            const verdict = likelyHasIOWithTaint(chunk, taintInfo);
            if (!verdict.passed) continue;

            // Build taint context summary (same helper as static-analyzer)
            let taintContextSummary: string | undefined;
            if (taintInfo && (taintInfo.taintedSymbols.size > 0 || taintInfo.taintedAliases.size > 0)) {
                const parts: string[] = [];
                if (taintInfo.taintedSymbols.size > 0) {
                    parts.push(`Tainted symbols: ${[...taintInfo.taintedSymbols].join(', ')}`);
                }
                if (taintInfo.taintedAliases.size > 0) {
                    const aliases = [...taintInfo.taintedAliases.entries()]
                        .map(([prop, type]) => `${prop} → ${type}`)
                        .join(', ');
                    parts.push(`DI aliases: ${aliases}`);
                }
                taintContextSummary = `\n--- Taint Context ---\n${parts.join('\n')}\n--- End Taint Context ---`;
            }

            analysisTasks.push({
                kind: 'analysis',
                functionId,
                functionHash,
                chunk,
                fileContext,
                imports: fileImportMap?.imports.map((i: any) => `${i.local} from '${i.source}'`),
                taintContextSummary,
                customKnowledge: customKnowledge || undefined,
            });
        }

        if (analysisTasks.length === 0) {
            logger.debug(`[EphemeralExtractor] No I/O functions found in: ${relPath}`);
            continue;
        }

        logger.debug(`[EphemeralExtractor] ${relPath}: ${analysisTasks.length} function(s) queued for LLM`);

        // ── Run semantic extraction (LLM) ─────────────────────────────────
        const promise = llmLimit(async () => {
            const semanticResult = await extractSemantics(
                analysisTasks,
                [], // No schema extraction in CI mode
                undefined,
                'semantic',
                undefined,
                symbolRegistry,
            );

            // Accumulate tokens
            for (const ef of semanticResult.extractedFunctions) {
                totalTokensIn += ef.usage?.promptTokens ?? ef.usage?.inputTokens ?? 0;
                totalTokensOut += ef.usage?.completionTokens ?? ef.usage?.outputTokens ?? 0;
                totalTokensCached += ef.usage?.cachedInputTokens ?? ef.usage?.cachedTokens ?? 0;
            }

            // ── Translate extracted functions to topology snapshot ─────────
            const snapshot = snapshots.get(relPath)!;
            const seenNodeIds = new Set<string>();

            for (const ef of semanticResult.extractedFunctions) {
                const { edges, nodes } = translateAnalysisToTopology(
                    ef.functionId,
                    ef.chunk.name,
                    relPath,
                    ef.analysis,
                    repoName,
                    repoHints,
                    repoCtx,
                );

                snapshot.edges.push(...edges);
                for (const node of nodes) {
                    if (!seenNodeIds.has(node.id)) {
                        snapshot.nodes.push(node);
                        seenNodeIds.add(node.id);
                    }
                }
            }

            if (verbose) {
                logger.debug(
                    `[EphemeralExtractor] ${relPath}: ` +
                    `${semanticResult.extractedFunctions.length} extracted, ` +
                    `${semanticResult.rejectedCount} rejected → ` +
                    `${snapshot.edges.length} edges, ${snapshot.nodes.length} nodes`
                );
            }
        });

        extractionPromises.push(promise);
    }

    await Promise.all(extractionPromises);

    // Symmetric pruning with the DB-side snapshot (fetchFileTopologySnapshots).
    // Without this, an LLM-detected controller marked INBOUND in the same file
    // as a synthetic ::__route_handler chunk would survive only on the
    // ephemeral side, producing a phantom delta on every PR.
    for (const snapshot of snapshots.values()) {
        pruneDuplicateRouteImplementations(snapshot);
    }

    // Replay the writer-side DataContainer welder. Without this, ephemeral
    // edges emitted with the naive single-repo URN stay misaligned with the
    // welded URN in the DB snapshot, producing a phantom rename pair that the
    // differ surfaces as the misleading "Table mapping changed: X -> X".
    await rewireEphemeralEdgesToWeldedTargets(snapshots);

    return {
        snapshots,
        skippedFiles,
        tokensUsed: { in: totalTokensIn, out: totalTokensOut, cached: totalTokensCached },
    };
}
