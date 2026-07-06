import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryResult, FileContext, StaticAnalysisResult } from '../../../../../src/ingestion/processors/code-pipeline/types.js';
import type { ParsedFileResult } from '../../../../../src/ingestion/processors/code-pipeline/static-analyzer-task-builder.js';
import type { ParseWorkTask, WorkerParseResult } from '../../../../../src/ingestion/processors/code-pipeline/parse-protocol.js';

const {
    parsePoolCtorMock,
    parsePoolRunMock,
    parsePoolDestroyMock,
    buildImportGraphMock,
    traceAnalysisMock,
    collectResolvedConstantsForTaskMock,
    formatResolvedConstantsContextMock,
    buildClientBindingContextMock,
    buildGraphQLDocumentContextMock,
    extractGraphQLDocumentsFromSourceMock,
    collectEntityTableRegistryMock,
    buildEntityTableContextMock,
} = vi.hoisted(() => ({
    parsePoolCtorMock: vi.fn(),
    parsePoolRunMock: vi.fn(),
    parsePoolDestroyMock: vi.fn(),
    buildImportGraphMock: vi.fn(),
    traceAnalysisMock: vi.fn(),
    collectResolvedConstantsForTaskMock: vi.fn(),
    formatResolvedConstantsContextMock: vi.fn(),
    buildClientBindingContextMock: vi.fn(),
    buildGraphQLDocumentContextMock: vi.fn(),
    extractGraphQLDocumentsFromSourceMock: vi.fn(),
    collectEntityTableRegistryMock: vi.fn(),
    buildEntityTableContextMock: vi.fn(),
}));

vi.mock('../../../../../src/ingestion/processors/code-pipeline/parse-pool.js', () => ({
    ParsePool: class {
        constructor(options: unknown) {
            parsePoolCtorMock(options);
        }
        run(tasks: ParseWorkTask[], onProgress?: (done: number, total: number) => void) {
            return parsePoolRunMock(tasks, onProgress);
        }
        destroy() {
            return parsePoolDestroyMock();
        }
    },
    resolveParseConcurrency: vi.fn(() => 2),
}));

vi.mock('../../../../../src/ingestion/core/import-graph.js', () => ({
    buildImportGraph: buildImportGraphMock,
}));

vi.mock('../../../../../src/telemetry/index.js', () => ({
    telemetryCollector: {
        addParsingTime: vi.fn(),
        incrementTotalFunctionsParsed: vi.fn(),
    },
    traceCollector: {
        traceAnalysis: traceAnalysisMock,
    },
}));

vi.mock('../../../../../src/utils/logger.js', () => ({
    logger: {
        isDebugEnabled: vi.fn(() => false),
        warn: vi.fn(),
    },
}));

vi.mock('../../../../../src/ingestion/processors/code-pipeline/static-analyzer-context.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/ingestion/processors/code-pipeline/static-analyzer-context.js')>();
    return {
        ...actual,
        collectResolvedConstantsForTask: collectResolvedConstantsForTaskMock,
        formatResolvedConstantsContext: formatResolvedConstantsContextMock,
        buildClientBindingContext: buildClientBindingContextMock,
        buildGraphQLDocumentContext: buildGraphQLDocumentContextMock,
        extractGraphQLDocumentsFromSource: extractGraphQLDocumentsFromSourceMock,
    };
});

vi.mock('../../../../../src/ingestion/processors/code-pipeline/entity-table-registry.js', () => ({
    collectEntityTableRegistry: collectEntityTableRegistryMock,
    buildEntityTableContext: buildEntityTableContextMock,
}));

import { logger } from '../../../../../src/utils/logger.js';
import { telemetryCollector } from '../../../../../src/telemetry/index.js';
import {
    buildDeepTypeMetadata,
    collectParsedFiles,
    enrichAnalysisResults,
} from '../../../../../src/ingestion/processors/code-pipeline/static-analyzer-pass.js';

const loggerMock = vi.mocked(logger);
const telemetryMock = vi.mocked(telemetryCollector);

function makeFileContext(overrides: Partial<FileContext> = {}): FileContext {
    return {
        absolutePath: '/tmp/repo/src/service.ts',
        relativePath: 'src/service.ts',
        repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
        routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
        fileHash: 'file-hash',
        ownerService: null,
        isManifest: false,
        ...overrides,
    };
}

function makeDiscoveryResult(fileContext: FileContext): DiscoveryResult {
    return {
        repo: fileContext.repo,
        files: [fileContext],
        merkleIndex: {
            repoHash: 'repo-hash',
            repoScanMode: 'fast',
            files: new Map([[fileContext.relativePath, {
                fileHash: fileContext.fileHash,
                fileScanMode: 'fast',
                functions: new Map([['urn:function:1', { sourceHash: 'hash', hasIO: false }]]),
            }]]),
        },
        repoHash: 'repo-hash',
        skippedCount: 0,
        allFilePaths: new Set(['src/service.ts', 'src/constants.ts', 'src/graphql.ts']),
        dependencyMappings: [],
    };
}

function makeWorkerResult(task: ParseWorkTask, overrides: Partial<WorkerParseResult> = {}): WorkerParseResult {
    return {
        taskId: task.taskId,
        relativePath: task.relativePath,
        language: 'typescript',
        fileContent: 'file-content',
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
        parseDurationMs: 5,
        ...overrides,
    };
}

/** Per-test worker behavior keyed by `${mode}:${relativePath}`. */
const workerBehavior = new Map<string, Partial<WorkerParseResult> | { error: string }>();

function makeChunk(name: string, sourceCode = 'return 1;') {
    return {
        name,
        filepath: 'src/service.ts',
        sourceCode,
        language: 'typescript',
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 10,
    };
}

function makeParsedFile(fileContext: FileContext, overrides: Partial<ParsedFileResult> = {}): ParsedFileResult {
    return {
        fileContext,
        chunks: [],
        language: 'typescript',
        frameworkSignals: [],
        fileContent: 'source',
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
        isCacheHit: false,
        unchangedFunctions: [],
        unchangedFunctionCount: 0,
        ...overrides,
    };
}

describe('static-analyzer-pass', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        workerBehavior.clear();
        loggerMock.isDebugEnabled.mockReturnValue(false);
        parsePoolRunMock.mockImplementation((tasks: ParseWorkTask[], onProgress?: (done: number, total: number) => void) => {
            const outcomes = tasks.map((task, index) => {
                const behavior = workerBehavior.get(`${task.mode}:${task.relativePath}`);
                onProgress?.(index + 1, tasks.length);
                if (behavior && 'error' in behavior) {
                    return { ok: false as const, taskId: task.taskId, relativePath: task.relativePath, error: behavior.error };
                }
                return { ok: true as const, result: makeWorkerResult(task, behavior) };
            });
            return Promise.resolve(outcomes);
        });
        parsePoolDestroyMock.mockResolvedValue(undefined);
        buildImportGraphMock.mockReturnValue({ dependedBy: new Map() });
        formatResolvedConstantsContextMock.mockReturnValue('resolved-context');
        buildClientBindingContextMock.mockReturnValue('client-context');
        buildGraphQLDocumentContextMock.mockReturnValue('graphql-context');
        extractGraphQLDocumentsFromSourceMock.mockReturnValue([{
            symbolName: 'GetUsers',
            operationType: 'QUERY',
            operationName: 'GetUsers',
            rootField: 'users',
            sourceFile: 'src/graphql.ts',
        }]);
        collectEntityTableRegistryMock.mockReturnValue([{ shortName: 'User', tableName: 'users' }]);
        buildEntityTableContextMock.mockReturnValue('entity-context');
    });

    it('reuses cached metadata when unchanged file already has import data', async () => {
        const fileContext = makeFileContext();
        const discovery = makeDiscoveryResult(fileContext);
        const prevEntry = discovery.merkleIndex.files.get(fileContext.relativePath)!;
        prevEntry.importMap = { filePath: fileContext.relativePath, imports: [], exportedSymbols: [] };
        prevEntry.classAliases = [{ propertyAccess: 'this.client', typeName: 'ApiClient' }];
        prevEntry.dependencyBindings = [{ provide: 'CLIENT', target: 'ApiClient', filePath: 'src/service.ts', bindingType: 'useClass' }];

        const state = await collectParsedFiles(discovery, 'fast');

        expect(state.parsedFiles).toHaveLength(1);
        expect(state.parsedFiles[0]).toMatchObject({
            isCacheHit: true,
            unchangedFunctionCount: 1,
            fileContent: 'file-content',
        });
        expect(state.fileImportMaps).toEqual([prevEntry.importMap]);
        expect(state.classAliasMap.get(fileContext.relativePath)).toEqual(prevEntry.classAliases);
        expect(state.dependencyBindingMap.get(fileContext.relativePath)).toEqual(prevEntry.dependencyBindings);
        // The worker is told NOT to re-extract import metadata the merkle index already has.
        const submitted = parsePoolRunMock.mock.calls[0][0] as ParseWorkTask[];
        expect(submitted[0]).toMatchObject({ mode: 'cache-hit', needsImportMap: false });
        expect(traceAnalysisMock).toHaveBeenCalledWith(
            'CACHE_HIT',
            fileContext.relativePath,
            'file hash unchanged',
            expect.any(Object),
        );
        expect(parsePoolDestroyMock).toHaveBeenCalledTimes(1);
    });

    it('rebuilds missing cached metadata on first incremental run', async () => {
        const fileContext = makeFileContext();
        const discovery = makeDiscoveryResult(fileContext);
        workerBehavior.set(`cache-hit:${fileContext.relativePath}`, {
            importMap: { filePath: fileContext.relativePath, imports: [], exportedSymbols: [] },
            classAliases: [{ propertyAccess: 'this.client', typeName: 'ApiClient' }],
            dependencyBindings: [{ provide: 'CLIENT', target: 'ApiClient', filePath: 'src/service.ts', bindingType: 'useClass' }],
        });

        const state = await collectParsedFiles(discovery, 'fast');

        expect(state.parsedFiles[0]?.isCacheHit).toBe(true);
        const submitted = parsePoolRunMock.mock.calls[0][0] as ParseWorkTask[];
        expect(submitted[0]).toMatchObject({ mode: 'cache-hit', needsImportMap: true });
        expect(state.fileImportMaps).toHaveLength(1);
        expect(discovery.merkleIndex.files.get(fileContext.relativePath)?.importMap).toBeDefined();
        expect(discovery.merkleIndex.files.get(fileContext.relativePath)?.classAliases).toBeDefined();
        expect(discovery.merkleIndex.files.get(fileContext.relativePath)?.dependencyBindings).toBeDefined();
    });

    it('un-caches downstream cache-hit consumers when upstream file is modified (structural contagion)', async () => {
        const fileA = makeFileContext({ absolutePath: '/tmp/repo/src/a.ts', relativePath: 'src/a.ts', fileHash: 'new-hash-a' });
        const fileB = makeFileContext({ absolutePath: '/tmp/repo/src/b.ts', relativePath: 'src/b.ts', fileHash: 'old-hash-b' });

        const discovery = makeDiscoveryResult(fileA);
        discovery.files.push(fileB);

        // A is modified (hash changed), B is unchanged (hash matches)
        discovery.merkleIndex.files.set(fileA.relativePath, { fileHash: 'old-hash-a', fileScanMode: 'fast', functions: new Map() });
        discovery.merkleIndex.files.set(fileB.relativePath, { fileHash: 'old-hash-b', fileScanMode: 'fast', functions: new Map() });

        workerBehavior.set('fresh:src/a.ts', {
            importMap: { filePath: 'src/a.ts', imports: [], exportedSymbols: ['ModifiedSymbol'] },
        });
        workerBehavior.set('cache-hit:src/b.ts', {
            fileContent: 'file content that uses ModifiedSymbol',
            importMap: { filePath: 'src/b.ts', imports: [], exportedSymbols: [] },
        });
        workerBehavior.set('fresh:src/b.ts', {
            chunks: [makeChunk('dummy', 'uses ModifiedSymbol')],
            chunkStaticData: [{ staticInfra: null, supplements: null, gate4HasCalls: undefined, gate2HasCalls: undefined }],
        });

        // Mock import graph: B imports A
        buildImportGraphMock.mockReturnValue({
            dependedBy: new Map([['src/a.ts', ['src/b.ts']]]),
        });

        const symbolTaintedFiles = new Map<string, Set<string>>();
        const state = await collectParsedFiles(discovery, 'fast', symbolTaintedFiles);

        const parsedA = state.parsedFiles.find(p => p.fileContext.relativePath === 'src/a.ts');
        expect(parsedA?.isCacheHit).toBe(false);

        const parsedB = state.parsedFiles.find(p => p.fileContext.relativePath === 'src/b.ts');
        // B was initially a cache hit, but is un-cached by the contagion re-dispatch
        expect(parsedB?.isCacheHit).toBe(false);
        expect(parsedB?.chunks).toEqual([makeChunk('dummy', 'uses ModifiedSymbol')]);
        expect(parsedB?.chunkStaticData).toHaveLength(1);

        // Second pool run carries the contagion re-parse in fresh mode
        expect(parsePoolRunMock).toHaveBeenCalledTimes(2);
        const contagionTasks = parsePoolRunMock.mock.calls[1][0] as ParseWorkTask[];
        expect(contagionTasks).toHaveLength(1);
        expect(contagionTasks[0]).toMatchObject({ relativePath: 'src/b.ts', mode: 'fresh', needsImportMap: false });

        // Ensure B is added to symbolTaintedFiles
        expect(symbolTaintedFiles.has('src/b.ts')).toBe(true);
        expect(symbolTaintedFiles.get('src/b.ts')!.size).toBe(1);
        expect(traceAnalysisMock).toHaveBeenCalledWith(
            'INFO',
            'src/b.ts',
            'structural contagion',
            expect.objectContaining({ source: 'src/a.ts' }),
        );
    });

    it('does NOT un-cache consumers when modified file has no exported symbols (barrel file guard)', async () => {
        const fileA = makeFileContext({ absolutePath: '/tmp/repo/src/barrel.ts', relativePath: 'src/barrel.ts', fileHash: 'new-hash-a' });
        const fileB = makeFileContext({ absolutePath: '/tmp/repo/src/consumer.ts', relativePath: 'src/consumer.ts', fileHash: 'old-hash-b' });

        const discovery = makeDiscoveryResult(fileA);
        discovery.files.push(fileB);

        discovery.merkleIndex.files.set(fileA.relativePath, { fileHash: 'old-hash-a', fileScanMode: 'fast', functions: new Map() });
        discovery.merkleIndex.files.set(fileB.relativePath, { fileHash: 'old-hash-b', fileScanMode: 'fast', functions: new Map() });

        // barrel.ts has no named exports (export * from './...')
        workerBehavior.set('fresh:src/barrel.ts', {
            importMap: { filePath: 'src/barrel.ts', imports: [], exportedSymbols: [] },
        });
        workerBehavior.set('cache-hit:src/consumer.ts', {
            fileContent: 'whatever content',
            importMap: { filePath: 'src/consumer.ts', imports: [], exportedSymbols: [] },
        });

        buildImportGraphMock.mockReturnValue({
            dependedBy: new Map([['src/barrel.ts', ['src/consumer.ts']]]),
        });

        const state = await collectParsedFiles(discovery, 'fast');

        const parsedB = state.parsedFiles.find(p => p.fileContext.relativePath === 'src/consumer.ts');
        // consumer.ts MUST remain cached — empty exports = no contagion evidence
        expect(parsedB?.isCacheHit).toBe(true);
        expect(parsePoolRunMock).toHaveBeenCalledTimes(1);
    });

    it('keeps cache-hit file metadata empty for unparseable files', async () => {
        const fileContext = makeFileContext();
        const discovery = makeDiscoveryResult(fileContext);
        workerBehavior.set(`cache-hit:${fileContext.relativePath}`, {
            language: 'unknown',
            fileContent: '',
        });

        const state = await collectParsedFiles(discovery, 'fast');

        expect(state.parsedFiles[0]).toMatchObject({
            isCacheHit: true,
            fileContent: '',
            frameworkSignals: [],
            fileConstants: [],
        });
        expect(state.fileImportMaps).toEqual([]);
        expect(state.classAliasMap.size).toBe(0);
        expect(state.dependencyBindingMap.size).toBe(0);
    });

    it('parses changed files and persists fresh import metadata to merkle entry', async () => {
        const fileContext = makeFileContext({ fileHash: 'new-hash' });
        const discovery = makeDiscoveryResult(fileContext);
        discovery.merkleIndex.files.get(fileContext.relativePath)!.fileHash = 'old-hash';
        workerBehavior.set(`fresh:${fileContext.relativePath}`, {
            chunks: [makeChunk('MyService.handle')],
            chunkStaticData: [{ staticInfra: null, supplements: null, gate4HasCalls: true, gate2HasCalls: true }],
            importStatements: ['import x from "./y";'],
            constructorSources: new Map([['MyService', 'constructor() {}']]),
            mayContainSchemas: true,
            importMap: { filePath: fileContext.relativePath, imports: [], exportedSymbols: [] },
            classAliases: [{ propertyAccess: 'this.client', typeName: 'ApiClient' }],
            dependencyBindings: [{ provide: 'CLIENT', target: 'ApiClient', filePath: 'src/service.ts', bindingType: 'useClass' }],
        });

        const state = await collectParsedFiles(discovery, 'fast');

        expect(state.parsedFiles[0]).toMatchObject({
            isCacheHit: false,
            mayContainSchemas: true,
            importStatements: ['import x from "./y";'],
        });
        expect(state.parsedFiles[0]?.chunkStaticData).toHaveLength(1);
        expect(telemetryMock.addParsingTime).toHaveBeenCalledWith(5);
        expect(telemetryMock.incrementTotalFunctionsParsed).toHaveBeenCalledWith(1);
        expect(discovery.merkleIndex.files.get(fileContext.relativePath)?.importMap).toBeDefined();
        expect(state.classAliasMap.get(fileContext.relativePath)).toBeDefined();
        expect(traceAnalysisMock).toHaveBeenCalledWith(
            'INFO',
            fileContext.relativePath,
            'file parsed',
            { functionsFound: 1, language: 'typescript' },
        );
    });

    it('parses file safely when merkle entry is missing', async () => {
        const fileContext = makeFileContext();
        const discovery = makeDiscoveryResult(fileContext);
        discovery.merkleIndex.files.delete(fileContext.relativePath);
        workerBehavior.set(`fresh:${fileContext.relativePath}`, {
            importMap: { filePath: fileContext.relativePath, imports: [], exportedSymbols: [] },
        });

        const state = await collectParsedFiles(discovery, 'fast');

        expect(state.parsedFiles[0]?.isCacheHit).toBe(false);
        expect(state.fileImportMaps).toHaveLength(1);
    });

    it('marks worker-failed files INCOMPLETE without tombstoning their functions', async () => {
        const fileContext = makeFileContext({ fileHash: 'new-hash' });
        const discovery = makeDiscoveryResult(fileContext);
        discovery.merkleIndex.files.get(fileContext.relativePath)!.fileHash = 'old-hash';
        workerBehavior.set(`fresh:${fileContext.relativePath}`, { error: 'native parser crashed' });

        const state = await collectParsedFiles(discovery, 'fast');

        // Surfaced as a cache hit (no analysis tasks, no deleted functions)
        // with the merkle-known functions preserved as unchanged links.
        expect(state.parsedFiles[0]).toMatchObject({
            isCacheHit: true,
            unchangedFunctionCount: 1,
        });
        expect(state.parsedFiles[0]?.unchangedFunctions[0]?.functionId).toBe('urn:function:1');
        // Hash poisoned so the next sync retries the file.
        expect(fileContext.fileHash).toBe('INCOMPLETE_DUE_TO_ERROR');
        expect(traceAnalysisMock).toHaveBeenCalledWith(
            'FAIL',
            fileContext.relativePath,
            'parse failed in worker',
            { error: 'native parser crashed' },
        );
        expect(loggerMock.warn).toHaveBeenCalled();
    });

    it('forces fresh mode for symbol-tainted files and registers their chunk ids', async () => {
        const fileContext = makeFileContext();
        const discovery = makeDiscoveryResult(fileContext);
        workerBehavior.set(`fresh:${fileContext.relativePath}`, {
            chunks: [makeChunk('MyService.handle')],
            chunkStaticData: [{ staticInfra: null, supplements: null, gate4HasCalls: undefined, gate2HasCalls: undefined }],
        });
        const symbolTaintedFiles = new Map<string, Set<string>>([[fileContext.relativePath, new Set()]]);

        const state = await collectParsedFiles(discovery, 'fast', symbolTaintedFiles);

        // Hash matches the merkle entry, but the taint forces a fresh parse.
        const submitted = parsePoolRunMock.mock.calls[0][0] as ParseWorkTask[];
        expect(submitted[0]).toMatchObject({ mode: 'fresh' });
        expect(state.parsedFiles[0]?.isCacheHit).toBe(false);
        expect(symbolTaintedFiles.get(fileContext.relativePath)!.size).toBe(1);
    });

    it('passes repo context to the pool workers', async () => {
        const fileContext = makeFileContext();
        const discovery = makeDiscoveryResult(fileContext);
        discovery.dependencyMappings = [{ namespacePrefix: 'Acme\\', directory: 'src/' } as any];

        await collectParsedFiles(discovery, 'contracts');

        expect(parsePoolCtorMock).toHaveBeenCalledWith(expect.objectContaining({
            size: 2,
            init: expect.objectContaining({
                scanMode: 'contracts',
                allFilePaths: expect.arrayContaining(['src/service.ts']),
                dependencyMappings: discovery.dependencyMappings,
            }),
        }));
    });

    it('builds deep type metadata only in deep mode', () => {
        loggerMock.isDebugEnabled.mockReturnValue(true);
        const fileContext = makeFileContext();
        const parsedFiles = [
            makeParsedFile(fileContext, {
                typeDefinitions: new Map([
                    ['UserDto', { kind: 'interface', name: 'UserDto', properties: [{ name: 'id', type: 'string' }] }],
                ]) as ParsedFileResult['typeDefinitions'],
                referencedTypes: new Map([['MyService.handle', ['UserDto']]]),
            }),
            makeParsedFile(makeFileContext({ relativePath: 'src/other.ts', absolutePath: '/tmp/repo/src/other.ts' }), {
                typeDefinitions: new Map([
                    ['UserDto', { kind: 'interface', name: 'UserDto', properties: [{ name: 'shadow', type: 'number' }] }],
                ]) as ParsedFileResult['typeDefinitions'],
                referencedTypes: new Map(),
            }),
        ];

        expect(buildDeepTypeMetadata(parsedFiles, false)).toEqual({});

        const task = { report: vi.fn() };
        const result = buildDeepTypeMetadata(parsedFiles, true, task);

        // First definition wins (discovery order), empty ref maps are skipped.
        expect(result.typeDefIndex?.get('UserDto')).toMatchObject({ properties: [{ name: 'id', type: 'string' }] });
        expect(result.funcTypeRefs?.get(fileContext.relativePath)?.get('MyService.handle')).toEqual(['UserDto']);
        expect(result.funcTypeRefs?.has('src/other.ts')).toBe(false);
        expect(task.report).toHaveBeenCalledWith('[Deep] TypeDefinitionIndex: 1 type(s) indexed across 1 file(s); funcPayloadRefs over 0 file(s)');
    });

    it('resolves payload hints against the cross-file type index', () => {
        const fileContext = makeFileContext();
        const producer = makeParsedFile(makeFileContext({ relativePath: 'src/dto.ts', absolutePath: '/tmp/repo/src/dto.ts' }), {
            typeDefinitions: new Map([
                ['OrderDto', { kind: 'class', name: 'OrderDto', properties: [{ name: 'total', type: 'number' }] }],
            ]) as ParsedFileResult['typeDefinitions'],
        });
        const consumer = makeParsedFile(fileContext, {
            payloadHints: new Map([
                ['MyService.handle', {
                    consumed: [{ fqcn: 'OrderDto', basename: 'OrderDto', origin: 'parameter' as const }],
                    produced: [],
                }],
            ]),
        });

        const result = buildDeepTypeMetadata([producer, consumer], true);

        const resolved = result.funcPayloadRefs?.get(fileContext.relativePath)?.get('MyService.handle');
        expect(resolved).toEqual([{
            direction: 'consumed',
            fqcn: 'OrderDto',
            basename: 'OrderDto',
            origin: 'parameter',
            fields: [{ name: 'total', type: 'number' }],
            source: 'ast',
        }]);
    });

    it('skips deep type indexing for files without extracted type metadata', () => {
        const result = buildDeepTypeMetadata([makeParsedFile(makeFileContext())], true);

        expect(result.typeDefIndex).toEqual(new Map());
        expect(result.funcTypeRefs).toEqual(new Map());
    });

    it('enriches analysis tasks with deterministic contexts and entity tables', () => {
        loggerMock.isDebugEnabled.mockReturnValue(true);
        collectResolvedConstantsForTaskMock
            .mockReturnValueOnce([{ key: 'ImportedTopic', value: '"events.topic"', source: 'imported', sourceFile: 'src/constants.ts' }])
            .mockReturnValueOnce([]);

        const fileContext = makeFileContext();
        const analysisResults: StaticAnalysisResult[] = [{
            fileContext,
            analysisTasks: [
                {
                    kind: 'analysis',
                    functionId: 'fn-1',
                    functionHash: 'hash-1',
                    chunk: {
                        name: 'Acme\\UserRepository.findById',
                        filepath: 'src/service.ts',
                        sourceCode: 'return ImportedTopic + GetUsers;',
                        language: 'typescript',
                        startLine: 1,
                        startColumn: 0,
                        endLine: 1,
                        endColumn: 10,
                    },
                    fileContext,
                    clientBindings: [{ token: 'CLIENT', clientKind: 'apollo', protocol: 'graphql' }],
                },
                {
                    kind: 'analysis',
                    functionId: 'fn-2',
                    functionHash: 'hash-2',
                    chunk: {
                        name: 'Acme\\UserRepository.staticFind',
                        filepath: 'src/service.ts',
                        sourceCode: 'return 1;',
                        language: 'typescript',
                        startLine: 2,
                        startColumn: 0,
                        endLine: 2,
                        endColumn: 10,
                    },
                    fileContext,
                    isResolvedStatically: true,
                },
            ],
            skippedFunctionCount: 0,
            unchangedFunctionCount: 0,
            unchangedFunctions: [],
            deletedFunctions: [],
            schemaContext: null,
            language: 'typescript',
        }];
        const parsedFiles = [
            makeParsedFile(fileContext, {
                fileContent: 'graphql-source',
                fileConstants: [{ scope: '', name: 'ImportedTopic', value: '"events.topic"' }],
            }),
        ];
        const fileImportMaps = [{
            filePath: fileContext.relativePath,
            imports: [{ source: './graphql', specifiers: ['GetUsers'], isExternal: false }],
            exportedSymbols: [],
        }];
        const discovery = makeDiscoveryResult(fileContext);
        const task = { report: vi.fn() };

        enrichAnalysisResults(analysisResults, parsedFiles, fileImportMaps as any, discovery, task);

        expect(analysisResults[0]?.analysisTasks[0]).toMatchObject({
            resolvedConstants: [{ key: 'ImportedTopic', value: '"events.topic"', source: 'imported', sourceFile: 'src/constants.ts' }],
            classConstantsContext: 'resolved-context',
            clientBindingContext: 'client-context',
            graphQLDocumentContext: 'graphql-context',
            entityTableContext: 'entity-context',
        });
        expect(analysisResults[0]?.analysisTasks[1]?.entityTableContext).toBeUndefined();
        expect(task.report).toHaveBeenCalledWith('[EntityRegistry] 1 entity→table mapping(s): User→users');
    });

    it('preserves existing constant context when formatter returns undefined', () => {
        collectResolvedConstantsForTaskMock.mockReturnValue([{ key: 'ImportedTopic', value: '"events.topic"', source: 'imported', sourceFile: 'src/constants.ts' }]);
        formatResolvedConstantsContextMock.mockReturnValue(undefined);
        collectEntityTableRegistryMock.mockReturnValue([]);

        const fileContext = makeFileContext();
        const analysisResults: StaticAnalysisResult[] = [{
            fileContext,
            analysisTasks: [{
                kind: 'analysis',
                functionId: 'fn-1',
                functionHash: 'hash-1',
                chunk: {
                    name: 'MyService.handle',
                    filepath: fileContext.relativePath,
                    sourceCode: 'return ImportedTopic;',
                    language: 'typescript',
                    startLine: 1,
                    startColumn: 0,
                    endLine: 1,
                    endColumn: 10,
                },
                fileContext,
                classConstantsContext: 'keep-me',
            }],
            skippedFunctionCount: 0,
            unchangedFunctionCount: 0,
            unchangedFunctions: [],
            deletedFunctions: [],
            schemaContext: null,
            language: 'typescript',
        }];

        enrichAnalysisResults(
            analysisResults,
            [makeParsedFile(fileContext, { fileContent: '', fileConstants: [] })],
            [{ filePath: fileContext.relativePath, imports: [], exportedSymbols: [] }] as any,
            makeDiscoveryResult(fileContext),
        );

        expect(analysisResults[0]?.analysisTasks[0]?.classConstantsContext).toBe('keep-me');
    });

    it('keeps entity context unset when builder returns nothing for top-level function', () => {
        collectResolvedConstantsForTaskMock.mockReturnValue([]);
        collectEntityTableRegistryMock.mockReturnValue([{ shortName: 'User', tableName: 'users' }]);
        buildEntityTableContextMock.mockReturnValue(undefined);

        const fileContext = makeFileContext();
        const analysisResults: StaticAnalysisResult[] = [{
            fileContext,
            analysisTasks: [{
                kind: 'analysis',
                functionId: 'fn-1',
                functionHash: 'hash-1',
                chunk: {
                    name: 'topLevelHandler',
                    filepath: fileContext.relativePath,
                    sourceCode: 'return 1;',
                    language: 'typescript',
                    startLine: 1,
                    startColumn: 0,
                    endLine: 1,
                    endColumn: 10,
                },
                fileContext,
            }],
            skippedFunctionCount: 0,
            unchangedFunctionCount: 0,
            unchangedFunctions: [],
            deletedFunctions: [],
            schemaContext: null,
            language: 'typescript',
        }];

        enrichAnalysisResults(
            analysisResults,
            [makeParsedFile(fileContext)],
            [{ filePath: fileContext.relativePath, imports: [], exportedSymbols: [] }] as any,
            makeDiscoveryResult(fileContext),
        );

        expect(analysisResults[0]?.analysisTasks[0]?.entityTableContext).toBeUndefined();
    });
});
