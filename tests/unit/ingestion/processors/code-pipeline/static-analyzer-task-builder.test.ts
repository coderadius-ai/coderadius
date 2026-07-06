import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeChunk } from '../../../../../src/graph/types.js';
import type { DiscoveryResult, FileContext } from '../../../../../src/ingestion/processors/code-pipeline/types.js';
import type { FileImportMap, FileTaintInfo } from '../../../../../src/ingestion/core/import-graph.js';
import { makeFunctionIdForRepo } from '../../../../../src/ingestion/processors/code-pipeline/static-analyzer-context.js';

const {
    likelyHasIOWithTaintMock,
    computeFunctionHashMock,
    readFileSyncMock,
    getLanguagePluginMock,
    traceFilterMock,
    matchFrameworkSignalsToChunkMock,
    formatFrameworkSignalContextMock,
} = vi.hoisted(() => ({
    likelyHasIOWithTaintMock: vi.fn(),
    computeFunctionHashMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    getLanguagePluginMock: vi.fn(),
    traceFilterMock: vi.fn(),
    matchFrameworkSignalsToChunkMock: vi.fn(),
    formatFrameworkSignalContextMock: vi.fn((signals: Array<{ ownerName: string }>) => `framework:${signals.map(signal => signal.ownerName).join(',')}`),
}));

vi.mock('../../../../../src/ingestion/core/heuristic-filter.js', () => ({
    likelyHasIOWithTaint: likelyHasIOWithTaintMock,
}));

vi.mock('../../../../../src/ingestion/core/merkle.js', () => ({
    computeFunctionHash: computeFunctionHashMock,
}));

vi.mock('node:fs', () => ({
    default: {
        readFileSync: readFileSyncMock,
    },
}));

vi.mock('../../../../../src/ingestion/core/languages/registry.js', () => ({
    getLanguagePlugin: getLanguagePluginMock,
}));

vi.mock('../../../../../src/telemetry/index.js', () => ({
    telemetryCollector: {
        incrementFunctionsUnchanged: vi.fn(),
        incrementCacheHits: vi.fn(),
        incrementFunctionsSkipped: vi.fn(),
        incrementDroppedAllGates: vi.fn(),
        incrementDroppedUntainted: vi.fn(),
        incrementPassedGate: vi.fn(),
    },
    traceCollector: {
        traceFilter: traceFilterMock,
    },
}));

vi.mock('../../../../../src/utils/logger.js', () => ({
    logger: {
        isDebugEnabled: vi.fn(() => false),
    },
}));

vi.mock('../../../../../src/ingestion/core/framework-signal-overlay.js', () => ({
    matchFrameworkSignalsToChunk: matchFrameworkSignalsToChunkMock,
    formatFrameworkSignalContext: formatFrameworkSignalContextMock,
    hasHardEntrypointCapability: vi.fn(() => false),
}));

import { logger } from '../../../../../src/utils/logger.js';
import { telemetryCollector } from '../../../../../src/telemetry/index.js';
import { buildAnalysisTasks, type ParsedFileResult } from '../../../../../src/ingestion/processors/code-pipeline/static-analyzer-task-builder.js';

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

function makeChunk(name: string, sourceCode = `${name}-source`): CodeChunk {
    return {
        name,
        filepath: 'src/service.ts',
        sourceCode,
        language: 'typescript',
        startLine: 1,
        startColumn: 0,
        endLine: 10,
        endColumn: 0,
    };
}

function makeParsed(chunks: CodeChunk[], overrides: Partial<ParsedFileResult> = {}): ParsedFileResult {
    return {
        fileContext: makeFileContext(),
        chunks,
        language: 'typescript',
        frameworkSignals: [],
        fileContent: 'class MyService {}',
        fileConstants: [],
        valueFacts: [],
        criticalInvocations: [],
        componentDefinitions: [],
        dependencyRequirements: [],
        chunkStaticData: chunks.map(() => ({
            staticInfra: null,
            supplements: null,
            gate4HasCalls: undefined,
            gate2HasCalls: undefined,
        })),
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

function makeDiscoveryResult(fileContext: FileContext, entries: Array<{ chunk: CodeChunk; sourceHash: string; hasIO: boolean }> = [], extraDeletedIds: string[] = []): DiscoveryResult {
    const functions = new Map<string, { sourceHash: string; hasIO: boolean }>();
    for (const entry of entries) {
        functions.set(makeFunctionIdForRepo(fileContext.repo, fileContext.relativePath, entry.chunk), {
            sourceHash: entry.sourceHash,
            hasIO: entry.hasIO,
        });
    }
    for (const functionId of extraDeletedIds) {
        functions.set(functionId, { sourceHash: 'old-hash', hasIO: false });
    }

    return {
        repo: fileContext.repo,
        files: [fileContext],
        merkleIndex: {
            repoHash: 'repo-hash',
            repoScanMode: 'semantic',
            files: new Map([[fileContext.relativePath, {
                fileHash: fileContext.fileHash,
                fileScanMode: 'semantic',
                functions,
            }]]),
        },
        repoHash: 'repo-hash',
        skippedCount: 0,
        allFilePaths: new Set([fileContext.relativePath, 'src/constants.ts', 'src/graphql.ts']),
        dependencyMappings: [],
    };
}

describe('buildAnalysisTasks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        computeFunctionHashMock.mockImplementation((sourceCode: string) => `hash:${sourceCode}`);
        getLanguagePluginMock.mockReturnValue({});
        likelyHasIOWithTaintMock.mockReturnValue({ passed: true, gate: 4, reason: 'tainted-symbol' });
        matchFrameworkSignalsToChunkMock.mockReturnValue([]);
        loggerMock.isDebugEnabled.mockReturnValue(false);
    });

    it('skips unchanged functions when merkle cache remains valid', () => {
        const fileContext = makeFileContext();
        const chunk = makeChunk('MyService.handle', 'same-source');
        const discovery = makeDiscoveryResult(fileContext, [{ chunk, sourceHash: 'hash:same-source', hasIO: false }]);

        const result = buildAnalysisTasks(
            makeParsed([chunk], { fileContext }),
            discovery,
            undefined,
            undefined,
            'semantic',
        );

        expect(result.analysisTasks).toEqual([]);
        expect(result.unchangedFunctionCount).toBe(1);
        expect(result.unchangedFunctions[0]?.functionId).toBe(
            makeFunctionIdForRepo(fileContext.repo, fileContext.relativePath, chunk),
        );
        expect(telemetryMock.incrementFunctionsUnchanged).toHaveBeenCalledTimes(1);
        expect(telemetryMock.incrementCacheHits).toHaveBeenCalledTimes(1);
    });

    it('bypasses deep-cache reuse for prior shallow IO functions and emits static results', () => {
        const fileContext = makeFileContext();
        const chunk = makeChunk('MyService.staticHandle', 'same-source');
        const discovery = makeDiscoveryResult(fileContext, [{ chunk, sourceHash: 'hash:same-source', hasIO: true }]);
        const prevEntry = discovery.merkleIndex.files.get(fileContext.relativePath)!;
        prevEntry.fileScanMode = 'semantic';

        const result = buildAnalysisTasks(
            makeParsed([chunk], {
                fileContext,
                chunkStaticData: [{
                    staticInfra: {
                        has_io: true,
                        infrastructure: [{ kind: 'datastore', name: 'orders' }],
                    } as any,
                    supplements: {
                        resourceDeclarations: [{ kind: 'datastore', logicalId: 'orders', technology: 'postgres', declarationSource: 'provider-factory' }],
                        clientBindings: [{ token: 'CLIENT', clientKind: 'http', protocol: 'http' }],
                    },
                    gate4HasCalls: undefined,
                    gate2HasCalls: undefined,
                }],
            }),
            discovery,
            undefined,
            undefined,
            'contracts',
        );

        expect(result.unchangedFunctionCount).toBe(0);
        expect(result.analysisTasks).toHaveLength(1);
        expect(result.analysisTasks[0]).toMatchObject({
            isResolvedStatically: true,
            staticAnalysis: expect.objectContaining({ has_io: true }),
            resourceDeclarations: expect.any(Array),
            clientBindings: expect.any(Array),
        });
    });

    it('handles generated callbacks, dropped functions, passed functions, schema context, and deleted ids', () => {
        loggerMock.isDebugEnabled.mockReturnValue(true);
        readFileSyncMock.mockReturnValue('schema-content');
        matchFrameworkSignalsToChunkMock.mockReturnValue([
            { ownerName: 'MyService.handle', framework: 'nestjs', kind: 'http-route', scope: 'method', startLine: 1, endLine: 1, confidence: 1 },
        ]);

        const fileContext = makeFileContext();
        const generated = makeChunk('Result.map_callback', 'generated-source');
        const dropped = makeChunk('MyService.dropMe', 'drop-source');
        const supplemental = makeChunk('MyService.supplemental', 'return EVENT_NAME;');
        const passed = makeChunk('MyService.handle', 'return EVENT_NAME + TypedDto;');
        const deletedId = 'urn:function:repo:src/service.ts:Old.deleted';
        const discovery = makeDiscoveryResult(fileContext, [], [deletedId]);

        likelyHasIOWithTaintMock.mockImplementation((chunk: CodeChunk) => {
            if (chunk.name === 'MyService.dropMe') {
                return { passed: false, gate: 0, reason: 'none' };
            }
            if (chunk.name === 'MyService.supplemental') {
                return { passed: false, gate: 0, reason: 'none' };
            }
            return { passed: true, gate: 5, reason: 'di-alias' };
        });

        const emptyChunkStatic = { staticInfra: null, supplements: null, gate4HasCalls: undefined, gate2HasCalls: undefined };
        const parsed = makeParsed([generated, dropped, supplemental, passed], {
            fileContext,
            mayContainSchemas: true,
            chunkStaticData: [
                emptyChunkStatic,
                emptyChunkStatic,
                {
                    ...emptyChunkStatic,
                    supplements: {
                        resourceDeclarations: [{ kind: 'datastore', logicalId: 'users', technology: 'postgres', declarationSource: 'provider-factory' }],
                        clientBindings: [{ token: 'CLIENT', clientKind: 'apollo', protocol: 'graphql', baseUrlHint: 'https://api.test' }],
                    },
                },
                emptyChunkStatic,
            ],
            frameworkSignals: [
                { ownerName: 'MyService.handle', framework: 'nestjs', kind: 'http-route', scope: 'method', startLine: 1, endLine: 1, confidence: 1 },
            ] as any,
            fileConstants: [
                { scope: 'MyService', name: 'EVENT_NAME', value: '"events.topic"' },
            ],
        });

        const taintInfo: FileTaintInfo = {
            taintedSymbols: new Set(['db']),
            taintedAliases: new Map([['this.client', 'ApiClient']]),
        };
        const fileImportMap: FileImportMap = {
            filePath: fileContext.relativePath,
            exportedSymbols: [],
            imports: [{ source: 'axios', specifiers: ['axios'], isExternal: true }],
        };
        const task = { report: vi.fn() };

        const result = buildAnalysisTasks(
            parsed,
            discovery,
            taintInfo,
            task,
            'contracts',
            [{ propertyAccess: 'this.client', typeName: 'ApiClient' }],
            fileImportMap,
            'custom-knowledge',
            new Map([
                ['TypedDto', { kind: 'interface', name: 'TypedDto', properties: [{ name: 'id', type: 'string' }] }],
            ]) as any,
            new Map([
                [fileContext.relativePath, new Map([['MyService.handle', ['TypedDto']]])],
            ]),
        );

        expect(result.skippedFunctionCount).toBe(2);
        expect(result.analysisTasks).toHaveLength(2);
        expect(result.analysisTasks[0]).toMatchObject({
            filterGate: 6,
            filterReason: 'supplemental:deterministic-hints',
            resourceDeclarations: expect.any(Array),
            clientBindings: expect.any(Array),
        });
        expect(result.analysisTasks[1]).toMatchObject({
            filterGate: 5,
            filterReason: 'di-alias',
            imports: undefined,
            constructorSource: undefined,
            classProperties: ['this.client: ApiClient'],
            taintContextSummary: expect.stringContaining('axios'),
            customKnowledge: 'custom-knowledge',
            resolvedTypeDefinitions: expect.stringContaining('TypedDto'),
            classConstantsContext: expect.stringContaining('EVENT_NAME'),
            matchedFrameworkSignals: expect.any(Array),
            frameworkSignalContext: 'framework:MyService.handle',
        });
        expect(result.deletedFunctions).toEqual([deletedId]);
        expect(result.schemaContext).toEqual({
            filePath: fileContext.absolutePath,
            relativePath: fileContext.relativePath,
            qualifiedRepoName: 'local/repo',
            fileContent: 'schema-content',
            frameworkSignalContext: 'framework:MyService.handle',
        });
        expect(task.report).toHaveBeenCalled();
        expect(telemetryMock.incrementFunctionsSkipped).toHaveBeenCalledTimes(2);
        expect(telemetryMock.incrementDroppedAllGates).toHaveBeenCalledTimes(1);
        expect(telemetryMock.incrementPassedGate).toHaveBeenCalledWith(5);
    });

    it('drops Gate-4 matches when the precomputed AST check found no service calls', () => {
        const chunk = makeChunk('MyService.pureMapper', 'return mapInput(db);');
        likelyHasIOWithTaintMock.mockReturnValue({ passed: true, gate: 4, reason: 'tainted:db' });

        const result = buildAnalysisTasks(
            makeParsed([chunk], {
                chunkStaticData: [{ staticInfra: null, supplements: null, gate4HasCalls: false, gate2HasCalls: undefined }],
            }),
            makeDiscoveryResult(makeFileContext()),
            { taintedSymbols: new Set(['db']), taintedAliases: new Map() },
        );

        expect(result.analysisTasks).toEqual([]);
        expect(result.skippedFunctionCount).toBe(1);
        expect(traceFilterMock).toHaveBeenCalledWith(
            'DROP',
            expect.any(String),
            'gate4-ast-override:no-service-call (symbol: tainted:db)',
            expect.objectContaining({ gate: 4.5 }),
        );
    });

    it('drops Gate-2 matches when the precomputed AST check found no service calls', () => {
        const chunk = makeChunk('UserRepository.formatRow', 'return row.toString();');
        likelyHasIOWithTaintMock.mockReturnValue({ passed: true, gate: 2, reason: 'repository-convention' });

        const result = buildAnalysisTasks(
            makeParsed([chunk], {
                chunkStaticData: [{ staticInfra: null, supplements: null, gate4HasCalls: undefined, gate2HasCalls: false }],
            }),
            makeDiscoveryResult(makeFileContext()),
            { taintedSymbols: new Set(), taintedAliases: new Map() },
        );

        expect(result.analysisTasks).toEqual([]);
        expect(result.skippedFunctionCount).toBe(1);
        expect(traceFilterMock).toHaveBeenCalledWith(
            'DROP',
            expect.any(String),
            'gate2-ast-override:no-service-call (convention: repository-convention)',
            expect.objectContaining({ gate: 2.5 }),
        );
    });

    it('counts untainted dropped functions separately', () => {
        const chunk = makeChunk('MyService.dropMe', 'drop-source');
        likelyHasIOWithTaintMock.mockReturnValue({ passed: false, gate: 0, reason: 'none' });

        const result = buildAnalysisTasks(
            makeParsed([chunk]),
            makeDiscoveryResult(makeFileContext()),
            { taintedSymbols: new Set(), taintedAliases: new Map() },
        );

        expect(result.analysisTasks).toEqual([]);
        expect(result.skippedFunctionCount).toBe(1);
        expect(telemetryMock.incrementDroppedUntainted).toHaveBeenCalledTimes(1);
    });

    it('forces re-analysis when fresh scan is requested', () => {
        const chunk = makeChunk('MyService.handle', 'fresh-source');

        const result = buildAnalysisTasks(
            makeParsed([chunk]),
            makeDiscoveryResult(makeFileContext()),
            undefined,
            undefined,
            'semantic',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined, // funcPayloadRefs
            undefined,
            true,
        );

        expect(result.analysisTasks).toHaveLength(1);
        expect(traceFilterMock).toHaveBeenCalledWith(
            'INFO',
            expect.any(String),
            '--force mode: force re-analysis',
            { filePath: 'src/service.ts' },
        );
    });

    it('forces re-analysis when file is tainted by config symbols', () => {
        const fileContext = makeFileContext();
        const chunk = makeChunk('MyService.handle', 'same-source');
        const discovery = makeDiscoveryResult(fileContext, [{ chunk, sourceHash: 'hash:same-source', hasIO: false }]);

        const result = buildAnalysisTasks(
            makeParsed([chunk], { fileContext }),
            discovery,
            undefined,
            undefined,
            'semantic',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined, // funcPayloadRefs
            new Map([[fileContext.relativePath, new Set([makeFunctionIdForRepo(fileContext.repo, fileContext.relativePath, chunk)])]]),
            false,
        );

        expect(result.analysisTasks).toHaveLength(1);
        expect(result.unchangedFunctionCount).toBe(0);
        expect(traceFilterMock).toHaveBeenCalledWith(
            'INFO',
            expect.any(String),
            'config symbol changed, force re-analysis',
            { filePath: fileContext.relativePath },
        );
    });

    it('handles top-level functions without class metadata or supplements', () => {
        const chunk = makeChunk('handleTopLevel', 'return 1;');

        const result = buildAnalysisTasks(
            makeParsed([chunk], {
                fileContent: '',
            }),
            makeDiscoveryResult(makeFileContext()),
        );

        expect(result.analysisTasks[0]).toMatchObject({
            constructorSource: undefined,
            classProperties: undefined,
            resourceDeclarations: undefined,
            clientBindings: undefined,
        });
    });

    it('keeps unchanged deep non-IO function cached and omits schema framework context when no signals exist', () => {
        readFileSyncMock.mockReturnValue('schema-content');

        const fileContext = makeFileContext();
        const chunk = makeChunk('handleTopLevel', 'same-source');
        const discovery = makeDiscoveryResult(fileContext, [{ chunk, sourceHash: 'hash:same-source', hasIO: false }]);
        discovery.merkleIndex.files.get(fileContext.relativePath)!.fileScanMode = 'semantic';

        const result = buildAnalysisTasks(
            makeParsed([chunk], {
                fileContext,
                mayContainSchemas: true,
                frameworkSignals: [],
            }),
            discovery,
            undefined,
            undefined,
            'contracts',
        );

        expect(result.analysisTasks).toEqual([]);
        expect(result.unchangedFunctionCount).toBe(1);
        expect(result.schemaContext).toEqual({
            filePath: fileContext.absolutePath,
            relativePath: fileContext.relativePath,
            qualifiedRepoName: 'local/repo',
            fileContent: 'schema-content',
            frameworkSignalContext: undefined,
        });
    });
});
