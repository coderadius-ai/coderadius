import type Parser from 'tree-sitter';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import { getLanguagePlugin, getAllPluginSinkPackages } from './languages/registry.js';
import type { ImportContext, DependencyMapping } from './languages/types.js';
import { resolveAliasedImport, buildBasenameSuffixIndex } from '../processors/code-pipeline/static-analyzer-context.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Import Graph + Taint Propagation
//
// This module is intentionally language-agnostic.
//
// Responsibility:
//   - Accept FileImportMaps produced by language plugins
//   - Build a directed dependency graph between files
//   - Propagate "taint" upward through the import graph via BFS
//   - Load custom sinks from coderadius.yaml
//
// Language-specific extraction (imports, exports, DI aliases) all lives in
// the language plugins under src/ingestion/core/languages/.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ImportSpecifierBinding {
    /** Exported symbol name in the imported file. */
    imported: string;
    /** Local symbol name used in this file. */
    local: string;
    kind: 'named' | 'default' | 'namespace';
}

export interface ImportRef {
    source: string;          // 'axios' | './services/http' | 'Handler/BookingHandler.php'
    specifiers: string[];    // ['ApiGateway'] | ['default'] | ['*']
    isExternal: boolean;     // true = npm/composer package; false = local file (creates graph edge)
    specifierBindings?: ImportSpecifierBinding[];
}

export interface FileImportMap {
    filePath: string;           // relative path within repo
    imports: ImportRef[];
    exportedSymbols: string[];  // class/function names exported from this file
    /**
     * File paths of parent classes / implemented interfaces declared by this
     * file's classes (resolved via the language plugin's namespace mapping).
     * Used by the taint pass to BACK-propagate I/O semantics: when a file
     * does HTTP I/O AND implements an interface, the interface inherits the
     * taint contract — any consumer of the interface is potentially making
     * the same I/O call through dependency injection.
     */
    implementsFiles?: string[];
}

export interface ClassPropertyAlias {
    propertyAccess: string;  // 'this.api' | 'this->client'
    typeName: string;        // 'ApiGateway' | 'HttpClient'
}

export interface DependencyBinding {
    provide: string;
    target: string;
    filePath: string;
    bindingType: 'useClass' | 'useExisting';
}

/**
 * Per-file taint information after BFS propagation.
 * - taintedSymbols: imported symbol names tracing back to a known I/O sink
 * - taintedAliases: DI aliases where `this.xxx` maps to a tainted type
 */
export interface FileTaintInfo {
    taintedSymbols: Set<string>;
    taintedAliases: Map<string, string>;  // 'this.api' → 'ApiGateway'
}

/** Map from relative file path → taint information */
export type TaintMap = Map<string, FileTaintInfo>;

// ─── Known I/O Sink Registry ─────────────────────────────────────────────────

export const KNOWN_IO_SINKS = new Set([
    // ── Node.js Native Built-ins ──
    'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
    'http', 'node:http', 'https', 'node:https', 'http2', 'node:http2',
    'net', 'node:net', 'dgram', 'node:dgram', 'tls', 'node:tls',
    'child_process', 'node:child_process', 'worker_threads', 'node:worker_threads',

    // ── HTTP Clients & GraphQL ──
    'axios', 'node-fetch', 'got', 'superagent', 'undici', 'ky', 'ofetch', 'wretch', 'redaxios',

    // ── Frontend Data Fetching ──
    '@tanstack/react-query', 'swr', 'rtk-query', '@apollo/client', 'graphql-request', 'relay',

    // ── Relational & NoSQL Databases / ORMs ──
    'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'sqlite3', 'better-sqlite3',
    'prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'sequelize', 'knex', 'kysely', 'mikro-orm', 'slonik',
    '@libsql/client', '@supabase/supabase-js',
    'neo4j-driver', 'couchbase', 'cassandra-driver',

    // ── Key-Value / Cache ──
    'redis', 'ioredis', 'memcached', '@upstash/redis', '@vercel/kv',

    // ── Time-Series Databases ──
    // Standard InfluxDB / time-series client packages. A file importing one is a
    // datastore I/O source, so its functions schedule past the taint gate (the
    // write method is then recognized as a timeseries Database sink).
    '@influxdata/influxdb-client', 'influx',

    // ── Vector Databases ──
    '@pinecone-database/pinecone', 'chromadb', 'qdrant-client',
    'weaviate-ts-client', '@elastic/elasticsearch', '@opensearch-project/opensearch',
    '@milvusio/milvus-sdk-node',

    // ── Message Queues & Event Streams ──
    'amqplib', 'amqp-connection-manager', 'kafkajs', 'bullmq', 'bull',
    'sqs-consumer', 'mqtt', 'nats', 'stompjs',
    '@temporalio/client', '@upstash/kafka',

    // ── gRPC / WebSocket / Realtime ──
    '@grpc/grpc-js', 'grpc', 'ws', 'socket.io', 'socket.io-client',
    'pusher', 'pusher-js', 'ably',

    // ── File System / Utilities ──
    'fs-extra', 'glob', 'chokidar', 'fast-glob',

    // ── Cloud SDKs ──
    '@aws-sdk/client-s3', '@aws-sdk/client-dynamodb', '@aws-sdk/client-sqs', '@aws-sdk/client-sns', '@aws-sdk/client-eventbridge',
    '@google-cloud/storage', '@google-cloud/bigquery', '@google-cloud/pubsub', '@google-cloud/spanner',
    '@azure/storage-blob', '@azure/service-bus', '@azure/cosmos',

    // ── SaaS API Clients ──
    'stripe', 'twilio', '@sendgrid/mail', 'postmark', 'algoliasearch',
]);

// ─── Observability Packages (excluded from taint propagation) ────────────────
// These packages carry NO business data between services. Importing them
// should NOT make a file a taint source for Gate 2/3.
export const OBSERVABILITY_PACKAGES = new Set([
    // Datadog
    'dd-trace', 'dd-trace/ci', 'datadog-metrics', 'hot-shots',
    // Prometheus
    'prom-client',
    // New Relic
    'newrelic',
    // OpenTelemetry
    '@opentelemetry/api', '@opentelemetry/sdk-node', '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-metrics', '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-http', '@opentelemetry/instrumentation',
    // Sentry
    '@sentry/node', '@sentry/browser', '@sentry/react',
    // Bugsnag
    '@bugsnag/js', '@bugsnag/node',
    // Feature Flags
    'launchdarkly-node-server-sdk', 'unleash-client',
    // Logging (when standalone)
    'winston', 'pino', 'bunyan', 'loglevel', 'log4js',
]);

export const NATIVE_IO_MODULES = new Set([
    'node:fs', 'node:http', 'node:https', 'node:net', 'node:dgram',
    'node:child_process', 'fs', 'http', 'https', 'net',
]);

// ─── coderadius.yaml Escape Hatch ───────────────────────────────────────────

/**
 * Read custom sinks from a coderadius.yaml file in the repo root.
 *
 * Format:
 * ```yaml
 * custom_sinks:
 *   - import_source: "@acme-corp/custom-http"
 * ```
 */
export function loadCustomSinks(repoPath: string): Set<string> {
    const custom = new Set<string>();
    for (const filename of ['coderadius.yaml', 'coderadius.yml']) {
        const filePath = path.join(repoPath, filename);
        if (!fs.existsSync(filePath)) continue;
        try {
            const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
            for (const line of lines) {
                const match = line.match(/^\s*-\s*import_source:\s*["']?([^"'\s]+)["']?\s*$/);
                if (match) custom.add(match[1]);
            }
            if (custom.size > 0) logger.debug(`[ImportGraph] Loaded ${custom.size} custom sink(s) from ${filename}`);
        } catch (err) {
            logger.warn(`[ImportGraph] Failed to read ${filename}: ${(err as Error).message}`);
        }
    }
    return custom;
}

/**
 * Hardcoded sink layer: the polyglot KNOWN_IO_SINKS PLUS every plugin's
 * ecosystem sink declarations (e.g. zodios for TS, doctrine/orm for PHP).
 * Single source of truth for "packages we know are I/O" — consumers
 * (sink classifier drift detection, resolveSinks layer 3, extra-sink
 * filtering) must use this union, never KNOWN_IO_SINKS alone, so that
 * plugin-declared sinks behave identically to core-declared ones.
 */
export function getHardcodedSinkRegistry(): Set<string> {
    return new Set([...KNOWN_IO_SINKS, ...getAllPluginSinkPackages()]);
}

export function buildSinkRegistry(repoPath: string, extraSinks?: string[]): Set<string> {
    const registry = new Set([...getHardcodedSinkRegistry(), ...NATIVE_IO_MODULES]);
    for (const sink of loadCustomSinks(repoPath)) registry.add(sink);
    if (extraSinks) {
        for (const sink of extraSinks) registry.add(sink);
    }
    return registry;
}

// ─── AST Extraction (Plugin-dispatched) ──────────────────────────────────────

/**
 * Extract import/export information from a parsed AST using the
 * appropriate language plugin.
 *
 * @param rootNode  - Tree-sitter AST root for this file
 * @param language  - Language identifier (e.g. 'typescript', 'php')
 * @param filePath  - Relative file path within the repo
 * @param context   - ImportContext with allFilePaths + dependencyMappings
 */
export function extractImportsFromAST(
    rootNode: Parser.SyntaxNode,
    language: string,
    filePath: string,
    context: ImportContext,
): FileImportMap {
    const plugin = getLanguagePlugin(language);
    if (!plugin) return { filePath, imports: [], exportedSymbols: [] };

    return {
        filePath,
        imports: plugin.extractImports(rootNode, context),
        exportedSymbols: plugin.extractExports(rootNode),
        implementsFiles: plugin.extractImplementsFiles?.(rootNode, context) ?? [],
    };
}

/**
 * Extract class property→type aliases for DI detection using the
 * appropriate language plugin.
 */
export function extractClassPropertyAliases(
    rootNode: Parser.SyntaxNode,
    language: string,
): ClassPropertyAlias[] {
    return getLanguagePlugin(language)?.extractClassPropertyAliases(rootNode) ?? [];
}

/**
 * Extract provider token bindings (e.g. NestJS provide/useClass).
 */
export function extractDependencyBindings(
    rootNode: Parser.SyntaxNode,
    language: string,
    filePath: string,
): DependencyBinding[] {
    return getLanguagePlugin(language)?.extractDependencyBindings?.(rootNode, filePath) ?? [];
}

// ─── Import Resolution Index (shared by buildImportGraph + propagateTaints) ──
//
// Built ONCE per analysis so the path-resolution lookups inside the taint
// fixed-point loop run in O(1). The previous version rebuilt the Map on every
// call and walked every fileImportMap entry for the basename fallback; on
// 8K-file repos that turned each `runTaintAnalysis` into a multi-minute hang.

interface ImportResolutionIndex {
    /** filePath and stripExtension(filePath) → filePath. Catches exact and
     *  extension-less import specifiers. */
    sourceToFile: Map<string, string>;
    /** stripExtension(basename) → filePath. O(1) basename fallback for flat
     *  layouts. Last-write-wins is acceptable: the fallback is fuzzy by
     *  design and the deterministic path-resolution candidates run first. */
    basenameToFile: Map<string, string>;
}

function buildImportResolutionIndex(fileImportMaps: FileImportMap[]): ImportResolutionIndex {
    const sourceToFile = new Map<string, string>();
    const basenameToFile = new Map<string, string>();
    for (const fMap of fileImportMaps) {
        sourceToFile.set(fMap.filePath, fMap.filePath);
        sourceToFile.set(stripExtension(fMap.filePath), fMap.filePath);
        basenameToFile.set(stripExtension(path.posix.basename(fMap.filePath)), fMap.filePath);
    }
    return { sourceToFile, basenameToFile };
}

function resolveLocalImport(
    fromFile: string,
    importSource: string,
    index: ImportResolutionIndex,
): string | null {
    const { sourceToFile, basenameToFile } = index;
    // importSource from plugins is already normalised to a relative path
    // when isExternal=false. First try exact match.
    if (sourceToFile.has(importSource)) return sourceToFile.get(importSource)!;

    // Try resolving relative to importing file's directory.
    const dir = path.posix.dirname(fromFile);
    const resolved = path.posix.normalize(path.posix.join(dir, importSource));

    const candidates = [
        resolved,
        `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`,
        `${resolved}.php`, `${resolved}.py`, `${resolved}.go`,
        `${resolved}/index.ts`, `${resolved}/index.js`,
    ];

    for (const candidate of candidates) {
        if (sourceToFile.has(candidate)) return sourceToFile.get(candidate)!;
    }

    // Basename fallback for flat structures, O(1) via the pre-built index.
    const baseName = stripExtension(path.posix.basename(resolved));
    return basenameToFile.get(baseName) ?? null;
}

// ─── Import Graph Construction ────────────────────────────────────────────────

/**
 * Build a directed dependency graph from file import maps.
 *
 * Returns:
 *   - dependsOn:   file A depends on file B (A imports from B)
 *   - dependedBy:  file B is depended on by file A (reverse edges for BFS)
 *   - symbolToFile: exported symbol name → file that exports it
 */
export function buildImportGraph(fileImportMaps: FileImportMap[], allFilePaths?: Set<string>): {
    dependsOn: Map<string, Set<string>>;
    dependedBy: Map<string, Set<string>>;
    symbolToFile: Map<string, string>;
} {
    const dependsOn = new Map<string, Set<string>>();
    const dependedBy = new Map<string, Set<string>>();

    // exported symbol name → file path
    const symbolToFile = new Map<string, string>();
    for (const fMap of fileImportMaps) {
        for (const sym of fMap.exportedSymbols) {
            symbolToFile.set(sym, fMap.filePath);
        }
    }

    // file path → file path (for local import resolution)
    const resolutionIndex = buildImportResolutionIndex(fileImportMaps);

    // Helper to register an edge in both directions
    const addEdge = (from: string, to: string) => {
        if (!dependsOn.has(from)) dependsOn.set(from, new Set());
        dependsOn.get(from)!.add(to);
        if (!dependedBy.has(to)) dependedBy.set(to, new Set());
        dependedBy.get(to)!.add(from);
    };

    // Pass 1: relative imports (./foo, ../bar), uses isExternal guard
    for (const fileMap of fileImportMaps) {
        for (const imp of fileMap.imports) {
            if (imp.isExternal) continue;

            const resolved = resolveLocalImport(fileMap.filePath, imp.source, resolutionIndex);
            if (!resolved) continue;
            addEdge(fileMap.filePath, resolved);
        }
    }

    // Pass 2: aliased imports (@apps/..., @libs/...) — resolved via suffix matching
    // Only runs when allFilePaths is provided (monorepo contagion mode).
    if (allFilePaths) {
        const basenameIndex = buildBasenameSuffixIndex(allFilePaths);
        for (const fileMap of fileImportMaps) {
            for (const imp of fileMap.imports) {
                if (!imp.isExternal) continue; // already handled above
                const resolved = resolveAliasedImport(imp.source, allFilePaths, basenameIndex);
                if (!resolved) continue;
                addEdge(fileMap.filePath, resolved);
            }
        }
    }

    return { dependsOn, dependedBy, symbolToFile };
}

// ─── Taint Propagation (BFS) ─────────────────────────────────────────────────

/**
 * Propagate taint from known I/O sinks upward through the import graph.
 *
 * Algorithm:
 *   1. SEED:      Files importing directly from a known sink → tainted (Patient Zero)
 *   2. PROPAGATE: BFS upward through `dependedBy` edges, up to maxDepth levels
 *   3. Track which symbols are tainted in each file
 */
export function propagateTaints(
    fileImportMaps: FileImportMap[],
    classPropertyAliases: Map<string, ClassPropertyAlias[]>,
    dependencyBindings: DependencyBinding[],
    graph: ReturnType<typeof buildImportGraph>,
    sinkRegistry: Set<string>,
    maxDepth: number = 32,
    extraIgnorePackages?: string[],
): TaintMap {
    const taintMap: TaintMap = new Map();
    const fileMapByPath = new Map(fileImportMaps.map(fileMap => [fileMap.filePath, fileMap]));
    // Pre-build the import resolution index ONCE up front. The fixed-point
    // loop below resolves imports for every consumer/import pair across
    // potentially 32 iterations; rebuilding the index per call would multiply
    // the cost by `fileImportMaps.length` per resolve and make taint analysis
    // O(N^3 * iterations) on large monorepos.
    const importResolutionIndex = buildImportResolutionIndex(fileImportMaps);
    const globallyTaintedSymbols = new Set<string>();

    // Step 1: Seed — find Patient Zero files
    for (const fileMap of fileImportMaps) {
        for (const imp of fileMap.imports) {
            // Skip observability packages — they carry no business data
            if (isObservabilityImport(imp.source, extraIgnorePackages)) continue;

            if (isSinkImport(imp.source, sinkRegistry)) {
                const fileTaint = getOrCreateTaintInfo(taintMap, fileMap.filePath);
                for (const sym of fileMap.exportedSymbols) {
                    addTaintedSymbol(fileTaint, sym, globallyTaintedSymbols);
                }
                for (const spec of imp.specifiers) {
                    if (spec !== '*' && spec !== 'default') {
                        addTaintedSymbol(fileTaint, spec, globallyTaintedSymbols);
                    }
                }
            }
        }
    }

    // Step 1b: Back-propagation through class hierarchy.
    // If a Patient Zero declares `class X implements Y` (or extends Y), Y
    // inherits the I/O taint contract: any consumer that depends on Y is
    // potentially calling X through DI. PHP's interface contract always
    // delegates to a concrete implementor, so the interface "carries" the
    // taint by reference. Without this, taint stops at the implementor and
    // never reaches code that consumes the interface (the common DI pattern).
    for (const fileMap of fileImportMaps) {
        const sourceTaint = taintMap.get(fileMap.filePath);
        if (!sourceTaint || sourceTaint.taintedSymbols.size === 0) continue;
        if (!fileMap.implementsFiles || fileMap.implementsFiles.length === 0) continue;
        for (const parentFilePath of fileMap.implementsFiles) {
            const parentMap = fileMapByPath.get(parentFilePath);
            if (!parentMap) continue;
            const parentTaint = getOrCreateTaintInfo(taintMap, parentFilePath);
            for (const sym of parentMap.exportedSymbols) {
                addTaintedSymbol(parentTaint, sym, globallyTaintedSymbols);
            }
        }
    }

    // Step 2: Fixed-point propagation across imports + DI bindings
    let changed = true;
    let iteration = 0;
    const maxIterations = Math.max(1, maxDepth);

    while (changed && iteration < maxIterations) {
        changed = false;
        iteration++;

        for (const [sourceFilePath, consumers] of graph.dependedBy.entries()) {
            const sourceTaint = taintMap.get(sourceFilePath);
            if (!sourceTaint || sourceTaint.taintedSymbols.size === 0) continue;

            for (const consumerPath of consumers) {
                const consumerMap = fileMapByPath.get(consumerPath);
                if (!consumerMap) continue;

                for (const imp of consumerMap.imports) {
                    if (imp.isExternal) continue;

                    const resolvedSource = resolveLocalImport(consumerMap.filePath, imp.source, importResolutionIndex);
                    if (resolvedSource !== sourceFilePath) continue;

                    const consumerTaint = getOrCreateTaintInfo(taintMap, consumerPath);
                    let hitOnThisImport = false;
                    for (const spec of imp.specifiers) {
                        if (spec === '*' || spec === 'default') {
                            for (const sym of sourceTaint.taintedSymbols) {
                                changed = addTaintedSymbol(consumerTaint, sym, globallyTaintedSymbols) || changed;
                                hitOnThisImport = true;
                            }
                        } else if (sourceTaint.taintedSymbols.has(spec)) {
                            changed = addTaintedSymbol(consumerTaint, spec, globallyTaintedSymbols) || changed;
                            hitOnThisImport = true;
                        }
                    }
                    // Full contagion: when the consumer wraps a tainted dependency,
                    // its OWN exported symbols inherit the taint by interface
                    // contract. Without this, the propagation stops after one hop
                    // (AcmePartnerService.php would contain `AcmePartnerClient` as tainted
                    // but a consumer of AcmePartnerService.php would not see anything
                    // tainted to match against). The seeding pass uses the same
                    // logic for Patient Zero; this mirrors it for transitive hops.
                    if (hitOnThisImport) {
                        for (const sym of consumerMap.exportedSymbols) {
                            changed = addTaintedSymbol(consumerTaint, sym, globallyTaintedSymbols) || changed;
                        }
                    }
                }
            }
        }

        for (const binding of dependencyBindings) {
            if (!globallyTaintedSymbols.has(binding.target)) continue;

            const bindingTaint = getOrCreateTaintInfo(taintMap, binding.filePath);
            changed = addTaintedSymbol(bindingTaint, binding.provide, globallyTaintedSymbols) || changed;
        }

        for (const [filePath, aliases] of classPropertyAliases.entries()) {
            for (const alias of aliases) {
                if (!globallyTaintedSymbols.has(alias.typeName)) continue;

                const aliasTaint = getOrCreateTaintInfo(taintMap, filePath);
                changed = addTaintedSymbol(aliasTaint, alias.typeName, globallyTaintedSymbols) || changed;
                changed = addTaintedAlias(aliasTaint, alias.propertyAccess, alias.typeName) || changed;
            }
        }
    }

    return taintMap;
}

/**
 * Run the complete taint analysis pipeline.
 * Main entry point called from the static analyzer.
 */
export function runTaintAnalysis(
    fileImportMaps: FileImportMap[],
    classPropertyAliases: Map<string, ClassPropertyAlias[]>,
    dependencyBindings: DependencyBinding[],
    repoPath: string,
    extraSinks?: string[],
    extraIgnorePackages?: string[],
    taintPropagationLevels?: number,
): TaintMap {
    const sinkRegistry = buildSinkRegistry(repoPath, extraSinks);
    const graph = buildImportGraph(fileImportMaps);
    return propagateTaints(
        fileImportMaps,
        classPropertyAliases,
        dependencyBindings,
        graph,
        sinkRegistry,
        taintPropagationLevels ?? 32,
        extraIgnorePackages,
    );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function stripExtension(filePath: string): string {
    return filePath.replace(/\.(ts|tsx|js|jsx|php|py|go)$/i, '');
}

function isSinkImport(source: string, sinkRegistry: Set<string>): boolean {
    if (sinkRegistry.has(source)) return true;
    for (const sink of sinkRegistry) {
        // PHP namespace separator `\` is the language convention for
        // unresolved (vendor) imports. Treat `/` and `\` as equivalent
        // hierarchy separators so that a registered prefix like
        // `Psr\Http\Client` matches a resolved import path
        // `Psr\Http\Client\ClientInterface`.
        if (source === sink) return true;
        if (source.startsWith(sink + '/')) return true;
        if (source.startsWith(sink + '\\')) return true;
    }
    return false;
}

/**
 * Check if an import source belongs to an observability/telemetry package.
 * These are explicitly excluded from taint propagation to keep the
 * architecture graph free of metrics/APM noise.
 */
function isObservabilityImport(source: string, extraIgnorePackages?: string[]): boolean {
    if (OBSERVABILITY_PACKAGES.has(source)) return true;
    for (const pkg of OBSERVABILITY_PACKAGES) {
        if (source.startsWith(pkg + '/')) return true;
    }
    if (extraIgnorePackages) {
        for (const pkg of extraIgnorePackages) {
            if (source === pkg || source.startsWith(pkg + '/')) return true;
        }
    }
    return false;
}

function getOrCreateTaintInfo(taintMap: TaintMap, filePath: string): FileTaintInfo {
    let info = taintMap.get(filePath);
    if (!info) {
        info = { taintedSymbols: new Set(), taintedAliases: new Map() };
        taintMap.set(filePath, info);
    }
    return info;
}

function addTaintedSymbol(info: FileTaintInfo, symbol: string, globalSymbols?: Set<string>): boolean {
    const before = info.taintedSymbols.size;
    info.taintedSymbols.add(symbol);
    globalSymbols?.add(symbol);
    return info.taintedSymbols.size !== before;
}

function addTaintedAlias(info: FileTaintInfo, propertyAccess: string, typeName: string): boolean {
    const existing = info.taintedAliases.get(propertyAccess);
    if (existing === typeName) return false;
    info.taintedAliases.set(propertyAccess, typeName);
    return true;
}
