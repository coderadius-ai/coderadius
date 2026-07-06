import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    CacheHitResult,
    DiscoveryResult,
    FileContext,
    ManifestResult,
    StaticAnalysisResult,
} from '../../../../../src/ingestion/processors/code-pipeline/types.js';

const {
    collectParsedFilesMock,
    buildDeepTypeMetadataMock,
    enrichAnalysisResultsMock,
    buildAnalysisTasksMock,
    loadRepoHintsMock,
    buildCustomKnowledgePromptMock,
    runTaintAnalysisMock,
    traceAnalysisMock,
    readFileSyncMock,
    extractDependenciesMock,
    getKnownInternalNamesMock,
    isCompatibleScanModeMock,
} = vi.hoisted(() => ({
    collectParsedFilesMock: vi.fn(),
    buildDeepTypeMetadataMock: vi.fn(),
    enrichAnalysisResultsMock: vi.fn(),
    buildAnalysisTasksMock: vi.fn(),
    loadRepoHintsMock: vi.fn(),
    buildCustomKnowledgePromptMock: vi.fn(),
    runTaintAnalysisMock: vi.fn(),
    traceAnalysisMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    extractDependenciesMock: vi.fn(),
    getKnownInternalNamesMock: vi.fn(),
    isCompatibleScanModeMock: vi.fn(),
}));

vi.mock('../../../../../src/ingestion/processors/code-pipeline/static-analyzer-pass.js', () => ({
    collectParsedFiles: collectParsedFilesMock,
    buildDeepTypeMetadata: buildDeepTypeMetadataMock,
    enrichAnalysisResults: enrichAnalysisResultsMock,
}));

vi.mock('../../../../../src/ingestion/processors/code-pipeline/static-analyzer-task-builder.js', () => ({
    buildAnalysisTasks: buildAnalysisTasksMock,
}));

vi.mock('../../../../../src/config/repo-hints.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/config/repo-hints.js')>();
    return {
        ...actual,
        loadRepoHints: loadRepoHintsMock,
        buildCustomKnowledgePrompt: buildCustomKnowledgePromptMock,
    };
});

vi.mock('../../../../../src/ingestion/core/import-graph.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/ingestion/core/import-graph.js')>();
    return {
        ...actual,
        runTaintAnalysis: runTaintAnalysisMock,
    };
});

vi.mock('../../../../../src/telemetry/index.js', () => ({
    telemetryCollector: {
        incrementFilesSkipped: vi.fn(),
        incrementFilesProcessed: vi.fn(),
        incrementSinkClassifierCounter: vi.fn(),
        getActiveModel: vi.fn(() => ({ provider: '', model: '' })),
        startTimer: vi.fn(() => 0),
        stopTimer: vi.fn(() => 0),
        addLLMTime: vi.fn(),
        addTokensForPhase: vi.fn(),
    },
    traceCollector: {
        traceAnalysis: traceAnalysisMock,
    },
}));

vi.mock('../../../../../src/ai/agents/sink-classifier/index.js', () => ({
    classifyPackages: vi.fn(async () => ({ classifications: [], drift: [], budgetSnapshot: { consumedTokens: 0, consumedUsd: 0, remainingTokens: 0, remainingUsd: 0, tripped: false } })),
}));

vi.mock('../../../../../src/ai/agents/sink-classifier/audit.js', () => ({
    sinkAuditLog: { append: vi.fn(async () => undefined) },
}));

vi.mock('../../../../../src/utils/logger.js', () => ({
    logger: {
        isDebugEnabled: vi.fn(() => false),
    },
}));

vi.mock('node:fs', () => ({
    default: {
        readFileSync: readFileSyncMock,
    },
}));

vi.mock('../../../../../src/ingestion/core/dependencies.js', () => ({
    extractDependencies: extractDependenciesMock,
}));

vi.mock('../../../../../src/graph/mutations/packages.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getKnownInternalNames: getKnownInternalNamesMock,
}));

vi.mock('../../../../../src/graph/scan-mode.js', () => ({
    isCompatibleScanMode: isCompatibleScanModeMock,
}));

import { logger } from '../../../../../src/utils/logger.js';
import { telemetryCollector } from '../../../../../src/telemetry/index.js';
import { analyzeFiles, processManifests } from '../../../../../src/ingestion/processors/code-pipeline/static-analyzer.js';

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

function makeDiscoveryResult(files: FileContext[]): DiscoveryResult {
    return {
        repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
        files,
        merkleIndex: {
            repoHash: 'repo-hash',
            repoScanMode: 'semantic',
            files: new Map(files.map(file => [file.relativePath, {
                fileHash: file.fileHash,
                fileScanMode: 'semantic',
                functions: new Map(),
            }])),
        },
        repoHash: 'repo-hash',
        skippedCount: 0,
        allFilePaths: new Set(files.map(file => file.relativePath)),
        dependencyMappings: [],
    };
}

function makeParsed(fileContext: FileContext, overrides: Record<string, unknown> = {}) {
    return {
        fileContext,
        chunks: [],
        rootNode: null,
        language: 'typescript',
        frameworkSignals: [],
        fileContent: '',
        fileConstants: [],
        isCacheHit: false,
        unchangedFunctions: [],
        unchangedFunctionCount: 0,
        ...overrides,
    };
}

describe('static-analyzer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loggerMock.isDebugEnabled.mockReturnValue(false);
        loadRepoHintsMock.mockReturnValue({ databases: [], decorators: [], hints: [] });
        buildCustomKnowledgePromptMock.mockReturnValue('custom-knowledge');
        collectParsedFilesMock.mockReturnValue({
            parsedFiles: [],
            fileImportMaps: [],
            classAliasMap: new Map(),
            dependencyBindingMap: new Map(),
        });
        buildDeepTypeMetadataMock.mockReturnValue({});
        runTaintAnalysisMock.mockReturnValue(new Map());
        isCompatibleScanModeMock.mockReturnValue(true);
    });

    it('converts parse-pass cache hits into cacheHitResults and traces taint', async () => {
        loggerMock.isDebugEnabled.mockReturnValue(true);
        const fileContext = makeFileContext();
        const parsed = makeParsed(fileContext, {
            isCacheHit: true,
            unchangedFunctionCount: 2,
            unchangedFunctions: [{ functionId: 'fn-1', relativePath: fileContext.relativePath, repoName: 'repo' }],
        });
        collectParsedFilesMock.mockReturnValue({
            parsedFiles: [parsed],
            fileImportMaps: [{ filePath: fileContext.relativePath, imports: [], exportedSymbols: [] }],
            classAliasMap: new Map(),
            dependencyBindingMap: new Map(),
        });
        runTaintAnalysisMock.mockReturnValue(new Map([
            [fileContext.relativePath, {
                taintedSymbols: new Set(['db']),
                taintedAliases: new Map([['this.client', 'ApiClient']]),
            }],
        ]));
        const task = { report: vi.fn() };

        const result = await analyzeFiles(makeDiscoveryResult([fileContext]), task);

        expect(result.analysisResults).toEqual([]);
        expect(result.cacheHitResults).toEqual<CacheHitResult[]>([{
            kind: 'cache-hit',
            fileContext,
            unchangedFunctionCount: 2,
            unchangedFunctions: [{ functionId: 'fn-1', relativePath: fileContext.relativePath, repoName: 'repo' }],
        }]);
        expect(task.report).toHaveBeenCalledWith('[Taint] 1 file(s) tainted via import graph contagion: src/service.ts');
        expect(telemetryMock.incrementFilesSkipped).toHaveBeenCalledTimes(1);
        expect(traceAnalysisMock).toHaveBeenCalledWith(
            'INFO',
            fileContext.relativePath,
            'taint analysis result',
            expect.objectContaining({ tainted: true }),
        );
        expect(enrichAnalysisResultsMock).toHaveBeenCalledWith([], [parsed], expect.any(Array), expect.any(Object), task, expect.any(Object));
    });

    it('folds unchanged non-schema results back into cache hits', async () => {
        loggerMock.isDebugEnabled.mockReturnValue(true);
        const fileContext = makeFileContext();
        const parsed = makeParsed(fileContext, {
            chunks: [{}, {}],
            isCacheHit: false,
        });
        collectParsedFilesMock.mockReturnValue({
            parsedFiles: [parsed],
            fileImportMaps: [],
            classAliasMap: new Map(),
            dependencyBindingMap: new Map(),
        });
        buildAnalysisTasksMock.mockReturnValue({
            fileContext,
            analysisTasks: [],
            skippedFunctionCount: 0,
            unchangedFunctionCount: 1,
            unchangedFunctions: [{ functionId: 'fn-1', relativePath: fileContext.relativePath, repoName: 'repo' }],
            deletedFunctions: [],
            schemaContext: null,
            rootNode: null,
            language: 'typescript',
        } satisfies StaticAnalysisResult);
        const task = { report: vi.fn() };

        const result = await analyzeFiles(makeDiscoveryResult([fileContext]), task);

        expect(result.analysisResults).toEqual([]);
        expect(result.cacheHitResults).toHaveLength(1);
        expect(telemetryMock.incrementFilesProcessed).toHaveBeenCalledTimes(1);
        expect(buildAnalysisTasksMock).toHaveBeenCalledWith(
            parsed,
            expect.any(Object),
            undefined,
            task,
            'semantic',
            undefined,
            undefined,
            'custom-knowledge',
            undefined,
            undefined,
            undefined, // funcPayloadRefs
            undefined,
            false,
            undefined,
            expect.any(Object), // valueResolutionIndex
            undefined, // extraSinkPackages
            expect.any(Object), // zodiosTypeIndex
            expect.any(Object), // zodiosIndex
            expect.any(Object), // allFilePaths
            expect.any(Object), // basenameIndex
        );
        expect(task.report).toHaveBeenCalledWith('\u001b[1m[src/service.ts]\u001b[0m 2 functions — \u001b[90m○ untainted\u001b[0m');
    });

    it('retains deep schema work in analysis results when previous scan mode was not deep', async () => {
        const fileContext = makeFileContext();
        const parsed = makeParsed(fileContext, {
            isCacheHit: false,
            chunks: [{}],
        });
        collectParsedFilesMock.mockReturnValue({
            parsedFiles: [parsed],
            fileImportMaps: [{ filePath: fileContext.relativePath, imports: [], exportedSymbols: [] }],
            classAliasMap: new Map([[fileContext.relativePath, [{ propertyAccess: 'this.client', typeName: 'ApiClient' }]]]),
            dependencyBindingMap: new Map([[fileContext.relativePath, [{ provide: 'CLIENT', target: 'ApiClient', filePath: fileContext.relativePath, bindingType: 'useClass' }]]]),
        });
        buildDeepTypeMetadataMock.mockReturnValue({
            typeDefIndex: new Map([['UserDto', { kind: 'interface', name: 'UserDto', properties: [] }]]),
            funcTypeRefs: new Map([[fileContext.relativePath, new Map([['MyService.handle', ['UserDto']]])]]),
        });
        buildAnalysisTasksMock.mockReturnValue({
            fileContext,
            analysisTasks: [],
            skippedFunctionCount: 0,
            unchangedFunctionCount: 1,
            unchangedFunctions: [{ functionId: 'fn-1', relativePath: fileContext.relativePath, repoName: 'repo' }],
            deletedFunctions: [],
            schemaContext: {
                filePath: fileContext.absolutePath,
                relativePath: fileContext.relativePath,
                fileContent: 'schema',
            },
            rootNode: null,
            language: 'typescript',
        } satisfies StaticAnalysisResult);
        isCompatibleScanModeMock.mockReturnValue(false);

        const result = await analyzeFiles(makeDiscoveryResult([fileContext]), undefined, 'contracts');

        expect(result.cacheHitResults).toEqual([]);
        expect(result.analysisResults).toHaveLength(1);
        expect(enrichAnalysisResultsMock).toHaveBeenCalledWith(result.analysisResults, [parsed], expect.any(Array), expect.any(Object), undefined, expect.any(Object));
    });

    it('reports tainted non-cache files with symbol and alias counts', async () => {
        loggerMock.isDebugEnabled.mockReturnValue(true);
        const fileContext = makeFileContext();
        const parsed = makeParsed(fileContext, {
            isCacheHit: false,
            chunks: [{}, {}, {}],
        });
        collectParsedFilesMock.mockReturnValue({
            parsedFiles: [parsed],
            fileImportMaps: [{ filePath: fileContext.relativePath, imports: [], exportedSymbols: [] }],
            classAliasMap: new Map(),
            dependencyBindingMap: new Map(),
        });
        runTaintAnalysisMock.mockReturnValue(new Map([
            [fileContext.relativePath, {
                taintedSymbols: new Set(['db', 'queue']),
                taintedAliases: new Map([['this.client', 'ApiClient']]),
            }],
        ]));
        buildAnalysisTasksMock.mockReturnValue({
            fileContext,
            analysisTasks: [{
                kind: 'analysis',
                functionId: 'fn-1',
                functionHash: 'hash-1',
                chunk: {
                    name: 'MyService.handle',
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
            rootNode: null,
            language: 'typescript',
        } satisfies StaticAnalysisResult);
        const task = { report: vi.fn() };

        await analyzeFiles(makeDiscoveryResult([fileContext]), task);

        expect(task.report).toHaveBeenCalledWith('\u001b[1m[src/service.ts]\u001b[0m 3 functions — \u001b[33m☣ tainted\u001b[0m (2 symbols, 1 aliases)');
    });

    it('passes repo hint filters into taint analysis and treats empty taint info as untainted', async () => {
        loggerMock.isDebugEnabled.mockReturnValue(true);
        loadRepoHintsMock.mockReturnValue({ packages: { analyze: ['@internal/http'], ignore: ['winston'] }, databases: [], decorators: [], hints: [] });
        const fileContext = makeFileContext();
        const parsed = makeParsed(fileContext, {
            isCacheHit: false,
            chunks: [{}],
        });
        collectParsedFilesMock.mockReturnValue({
            parsedFiles: [parsed],
            fileImportMaps: [{ filePath: fileContext.relativePath, imports: [], exportedSymbols: [] }],
            classAliasMap: new Map(),
            dependencyBindingMap: new Map(),
        });
        runTaintAnalysisMock.mockReturnValue(new Map([
            [fileContext.relativePath, {
                taintedSymbols: new Set(),
                taintedAliases: new Map(),
            }],
        ]));
        buildAnalysisTasksMock.mockReturnValue({
            fileContext,
            analysisTasks: [{
                kind: 'analysis',
                functionId: 'fn-1',
                functionHash: 'hash-1',
                chunk: {
                    name: 'MyService.handle',
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
            rootNode: null,
            language: 'typescript',
        } satisfies StaticAnalysisResult);
        const task = { report: vi.fn() };

        await analyzeFiles(makeDiscoveryResult([fileContext]), task);

        // Sink resolution now filters out hardcoded entries: 'winston' is already
        // in OBSERVABILITY_PACKAGES, so it's not passed as an extra ignore.
        // '@internal/http' is preserved since it isn't hardcoded.
        expect(runTaintAnalysisMock).toHaveBeenCalledWith(
            expect.any(Array),
            expect.any(Map),
            expect.any(Array),
            '/tmp/repo',
            ['@internal/http'],
            undefined,
            undefined,
        );
        expect(task.report).toHaveBeenCalledWith('\u001b[1m[src/service.ts]\u001b[0m 1 functions — \u001b[90m○ untainted\u001b[0m');
    });

    it('processes manifest files, adds self name to internal names, and ignores invalid json', async () => {
        loggerMock.isDebugEnabled.mockReturnValue(true);
        const manifestA = makeFileContext({
            absolutePath: '/tmp/repo/package.json',
            relativePath: 'package.json',
            isManifest: true,
        });
        const manifestB = makeFileContext({
            absolutePath: '/tmp/repo/packages/lib/package.json',
            relativePath: 'packages/lib/package.json',
            isManifest: true,
        });
        const sourceFile = makeFileContext();
        readFileSyncMock
            .mockReturnValueOnce('{"name":"@repo/service"}')
            .mockReturnValueOnce('{broken json');
        getKnownInternalNamesMock
            .mockResolvedValueOnce(new Set(['existing']))
            .mockResolvedValueOnce(new Set(['existing']));
        extractDependenciesMock
            .mockImplementationOnce((_absolutePath: string, _content: string, knownInternalNames: Set<string>) => {
                expect(knownInternalNames.has('@repo/service')).toBe(true);
                return [{ ecosystem: 'npm', name: '@repo/service', requiredVersion: '1.0.0', isDev: false, isInternal: true }];
            })
            .mockImplementationOnce((_absolutePath: string, _content: string, knownInternalNames: Set<string>) => {
                expect(knownInternalNames.has('@repo/service')).toBe(false);
                return [{ ecosystem: 'npm', name: 'lodash', requiredVersion: '^1.0.0', isDev: false, isInternal: false }];
            });
        const task = { report: vi.fn() };

        const result = await processManifests(makeDiscoveryResult([manifestA, manifestB, sourceFile]), task);

        expect(result).toEqual<ManifestResult[]>([
            {
                kind: 'manifest',
                fileContext: manifestA,
                dependencies: [{ ecosystem: 'npm', name: '@repo/service', requiredVersion: '1.0.0', isDev: false, isInternal: true }],
            },
            {
                kind: 'manifest',
                fileContext: manifestB,
                dependencies: [{ ecosystem: 'npm', name: 'lodash', requiredVersion: '^1.0.0', isDev: false, isInternal: false }],
            },
        ]);
        expect(task.report).toHaveBeenNthCalledWith(1, 'Extracting dependencies: package.json');
        expect(task.report).toHaveBeenNthCalledWith(2, 'Extracting dependencies: packages/lib/package.json');
    });
});
