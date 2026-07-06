import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import type Parser from 'tree-sitter';
import { parseFile } from '../parser/index.js';
import { getLanguagePlugin } from '../../core/languages/registry.js';
import {
    extractImportsFromAST,
    extractClassPropertyAliases,
    extractDependencyBindings,
} from '../../core/import-graph.js';
import type { ImportContext, LanguagePlugin } from '../../core/languages/types.js';
import { mayContainSchemas } from '../../core/schema-gate.js';
import { logger } from '../../../utils/logger.js';
import type { CriticalInvocationFact, ValueFact } from '../../core/value-resolution/index.js';
import type {
    ChunkStaticData,
    ParseWorkTask,
    ParseWorkerInit,
    WorkerInMessage,
    WorkerOutMessage,
    WorkerParseResult,
} from './parse-protocol.js';

// ─── Parse Worker ────────────────────────────────────────────────────────────
//
// Owns ALL per-file AST work: tree-sitter parse + every per-file and per-chunk
// extractor that needs the (thread-bound) native SyntaxNode. Returns flat data
// only — see parse-protocol.ts. Language behavior stays in the plugins; this
// module is language-agnostic dispatch, exactly like the serial loop it
// replaced.
// ─────────────────────────────────────────────────────────────────────────────

/** Extensions the historical cache-hit branch re-parsed for light context. */
const CACHE_HIT_PARSE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.php', '.py', '.go'];
/** Extensions the historical cache-hit branch backfilled import maps for. */
const CACHE_HIT_IMPORT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.php'];

export interface WorkerContext {
    allFilePaths: Set<string>;
    dependencyMappings: ParseWorkerInit['dependencyMappings'];
    scanMode: ParseWorkerInit['scanMode'];
}

/**
 * Run the full per-file extraction for one task. Pure with respect to the
 * main thread: reads the file from disk, never touches shared state.
 */
export function extractParsedFile(task: ParseWorkTask, ctx: WorkerContext): WorkerParseResult {
    const { absolutePath, relativePath, mode, needsImportMap } = task;
    const ext = path.extname(absolutePath).toLowerCase();

    const result: WorkerParseResult = {
        taskId: task.taskId,
        relativePath,
        language: 'unknown',
        fileContent: '',
        chunks: [],
        frameworkSignals: [],
        fileConstants: [],
        valueFacts: [],
        criticalInvocations: [],
        componentDefinitions: [],
        dependencyRequirements: [],
        importMap: null,
        classAliases: [],
        dependencyBindings: [],
        chunkStaticData: [],
        importStatements: [],
        constructorSources: new Map(),
        mayContainSchemas: false,
        typeDefinitions: null,
        referencedTypes: null,
        payloadHints: null,
        parseDurationMs: 0,
    };

    if (mode === 'cache-hit' && !CACHE_HIT_PARSE_EXTS.includes(ext)) {
        return result;
    }

    const parseStart = performance.now();
    const { chunks, rootNode, language } = parseFile(absolutePath, relativePath);
    result.parseDurationMs = performance.now() - parseStart;
    result.language = language;

    const plugin = rootNode ? getLanguagePlugin(language) : null;
    if (!rootNode) return result;
    result.fileContent = fs.readFileSync(absolutePath, 'utf-8');

    result.frameworkSignals = plugin?.extractFrameworkSignals
        ? plugin.extractFrameworkSignals(rootNode, result.fileContent, relativePath)
        : [];
    result.fileConstants = plugin?.extractFileConstants
        ? plugin.extractFileConstants(rootNode)
        : [];
    result.valueFacts = plugin
        ? safeExtractValueFacts(plugin, rootNode, result.fileContent, relativePath)
        : [];
    result.criticalInvocations = plugin
        ? safeExtractCriticalInvocations(plugin, rootNode, result.fileContent, relativePath)
        : [];
    result.componentDefinitions = plugin?.extractComponentDefinitions
        ? plugin.extractComponentDefinitions(rootNode, result.fileContent, relativePath)
        : [];
    result.dependencyRequirements = plugin?.extractDependencyRequirements
        ? plugin.extractDependencyRequirements(rootNode, result.fileContent, relativePath)
        : [];

    const importMapAllowed = mode === 'fresh' || CACHE_HIT_IMPORT_EXTS.includes(ext);
    if (needsImportMap && importMapAllowed && plugin) {
        const importContext: ImportContext = {
            filePath: relativePath,
            allFilePaths: ctx.allFilePaths,
            dependencyMappings: ctx.dependencyMappings,
        };
        result.importMap = extractImportsFromAST(rootNode, language, relativePath, importContext);
        result.classAliases = extractClassPropertyAliases(rootNode, language);
        result.dependencyBindings = extractDependencyBindings(rootNode, language, relativePath);
    }

    if (ctx.scanMode === 'contracts' && plugin) {
        result.typeDefinitions = plugin.extractTypeDefinitions?.(rootNode) ?? null;
        result.referencedTypes = plugin.extractReferencedTypes?.(rootNode) ?? null;
        result.payloadHints = plugin.extractFunctionPayloadHints?.(rootNode) ?? null;
    }

    if (mode === 'fresh') {
        result.chunks = chunks;
        result.chunkStaticData = chunks.map(chunk => extractChunkStaticData(plugin, rootNode, result.fileContent, relativePath, chunk));
        result.importStatements = plugin ? plugin.extractImportStatements(rootNode) : [];
        result.constructorSources = plugin ? plugin.extractConstructorSources(rootNode) : new Map();
        result.mayContainSchemas = mayContainSchemas(rootNode, absolutePath, language);
    }

    return result;
}

function extractChunkStaticData(
    plugin: LanguagePlugin | null,
    rootNode: Parser.SyntaxNode,
    fileContent: string,
    relativePath: string,
    chunk: WorkerParseResult['chunks'][number],
): ChunkStaticData {
    const staticInfra = plugin?.extractStaticInfra?.(rootNode, chunk) ?? null;
    const supplements = fileContent
        ? plugin?.extractStaticSupplements?.(rootNode, fileContent, relativePath, chunk) ?? null
        : null;
    const gate4Checker = plugin?.hasInjectedDependencyCallsInRange ?? plugin?.hasServiceCallsInRange;
    const gate4HasCalls = gate4Checker
        ? gate4Checker.call(plugin, rootNode, chunk.startLine, chunk.endLine)
        : undefined;
    const gate2HasCalls = plugin?.hasServiceCallsInRange
        ? plugin.hasServiceCallsInRange(rootNode, chunk.startLine, chunk.endLine)
        : undefined;
    return { staticInfra, supplements, gate4HasCalls, gate2HasCalls };
}

function safeExtractValueFacts(
    plugin: LanguagePlugin,
    rootNode: Parser.SyntaxNode,
    source: string,
    relativePath: string,
): ValueFact[] {
    try {
        return plugin.extractValueFacts?.(rootNode, source, relativePath) ?? [];
    } catch (err) {
        logger.debug(`[ValueResolution] Failed to extract value facts for ${relativePath}: ${(err as Error).message}`);
        return [];
    }
}

function safeExtractCriticalInvocations(
    plugin: LanguagePlugin,
    rootNode: Parser.SyntaxNode,
    source: string,
    relativePath: string,
): CriticalInvocationFact[] {
    try {
        return plugin.extractCriticalInvocations?.(rootNode, source, relativePath) ?? [];
    } catch (err) {
        logger.debug(`[ValueResolution] Failed to extract critical invocations for ${relativePath}: ${(err as Error).message}`);
        return [];
    }
}

// ─── Worker entry ────────────────────────────────────────────────────────────

if (parentPort) {
    const init = workerData as ParseWorkerInit;
    const ctx: WorkerContext = {
        allFilePaths: new Set(init.allFilePaths),
        dependencyMappings: init.dependencyMappings,
        scanMode: init.scanMode,
    };
    const port = parentPort;

    port.on('message', (msg: WorkerInMessage) => {
        if (msg.kind !== 'task') return;
        let out: WorkerOutMessage;
        try {
            out = { kind: 'result', result: extractParsedFile(msg.task, ctx) };
        } catch (err) {
            out = {
                kind: 'task-error',
                taskId: msg.task.taskId,
                relativePath: msg.task.relativePath,
                error: (err as Error).message,
            };
        }
        port.postMessage(out);
    });

    port.postMessage({ kind: 'ready' } satisfies WorkerOutMessage);
}
