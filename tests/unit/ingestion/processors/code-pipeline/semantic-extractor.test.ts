import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisTask } from '../../../../../src/ingestion/processors/code-pipeline/types.js';
import type { FrameworkSignal } from '../../../../../src/ingestion/core/languages/types.js';

const { analyzeFunctionMock, extractDataSchemaMock } = vi.hoisted(() => ({
    analyzeFunctionMock: vi.fn(),
    extractDataSchemaMock: vi.fn(),
}));

vi.mock('../../../../../src/ai/agents/unified-analyzer.js', async () => {
    const actual = await vi.importActual('../../../../../src/ai/agents/unified-analyzer.js');
    return {
        ...actual,
        analyzeFunction: analyzeFunctionMock,
    };
});

vi.mock('../../../../../src/ai/agents/schema-extractor.js', () => ({
    extractDataSchema: extractDataSchemaMock,
}));

vi.mock('../../../../../src/telemetry/index.js', () => ({
    telemetryCollector: {
        incrementLLMInvocations: vi.fn(),
        incrementLLMRejections: vi.fn(),
        incrementFunctionsSkipped: vi.fn(),
        incrementErrors: vi.fn(),
    },
    traceCollector: {
        traceLLM: vi.fn(),
        traceSanitizer: vi.fn(),
    },
}));

vi.mock('../../../../../src/utils/logger.js', () => ({
    logger: {
        isDebugEnabled: () => false,
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
    },
}));

const rejectedAnalysis = {
    has_io: false,
    intent: '',
    infrastructure: [],
    capabilities: [],
    produced_payloads: [],
    consumed_payloads: [],
    emergent_api_calls: [],
};

function makeTask(opts: {
    name: string;
    filepath: string;
    sourceCode?: string;
    filterGate?: number;
    filterReason?: string;
    matchedFrameworkSignals?: FrameworkSignal[];
}) {
    const task = {
        kind: 'analysis',
        functionId: `urn:function:repo:${opts.filepath}:${opts.name}`,
        functionHash: `${opts.name}-hash`,
        chunk: {
            name: opts.name,
            filepath: opts.filepath,
            sourceCode: opts.sourceCode ?? 'return 2 + 2;',
            language: 'typescript',
            startLine: 1,
            startColumn: 1,
            endLine: 10,
            endColumn: 1,
        },
        fileContext: {
            absolutePath: `/tmp/${opts.filepath}`,
            relativePath: opts.filepath,
            repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
            routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
            fileHash: 'file-hash',
            ownerService: null,
            isManifest: false,
        },
        filterGate: opts.filterGate,
        filterReason: opts.filterReason,
        matchedFrameworkSignals: opts.matchedFrameworkSignals,
    };

    return task as AnalysisTask;
}

describe('extractSemantics() — entrypoint preservation', () => {
    beforeEach(() => {
        analyzeFunctionMock.mockReset();
        extractDataSchemaMock.mockReset();
        analyzeFunctionMock.mockResolvedValue({ analysis: rejectedAnalysis, usage: {} });
        extractDataSchemaMock.mockResolvedValue([]);
    });

    it('preserves Gate 1 UseCase entrypoints even when the LLM returns has_io=false', async () => {
        const { extractSemantics } = await import('../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js');
        const task = makeTask({
            name: 'UpdateQuoteUseCase.handle',
            filepath: 'src/application/UpdateQuoteUseCase.ts',
            filterGate: 1,
            filterReason: 'usecase:entry-point',
            sourceCode: 'return this.quoteRepository.findById(id);',
        });

        const result = await extractSemantics([task], []);

        expect(result.rejectedCount).toBe(0);
        expect(result.extractedFunctions).toHaveLength(1);
        expect(result.extractedFunctions[0]!.analysis.has_io).toBe(true);
        expect(result.extractedFunctions[0]!.analysis.infrastructure).toEqual([]);
        expect(result.extractedFunctions[0]!.analysis.intent).toMatch(/usecase entry point/i);
    });

    it('does not preserve private helpers when the LLM returns has_io=false', async () => {
        const { extractSemantics } = await import('../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js');
        const task = makeTask({
            name: 'UpdateQuoteUseCase.buildPayload',
            filepath: 'src/application/UpdateQuoteUseCase.ts',
            sourceCode: 'return { id, kind: "quote" };',
        });

        const result = await extractSemantics([task], []);

        expect(result.extractedFunctions).toHaveLength(0);
        expect(result.rejectedCount).toBe(1);
    });

    it('keeps pure route handlers as leaf nodes via framework overlay, not Gate 4 override', async () => {
        const { extractSemantics } = await import('../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js');
        const signals: FrameworkSignal[] = [
            {
                framework: 'nestjs',
                kind: 'http-controller',
                scope: 'class',
                ownerName: 'CalculatorController',
                startLine: 1,
                endLine: 1,
                confidence: 1,
                metadata: { path: '/math' },
            },
            {
                framework: 'nestjs',
                kind: 'http-route',
                scope: 'method',
                ownerName: 'CalculatorController.handle',
                resolvedName: 'handle',
                startLine: 2,
                endLine: 2,
                confidence: 1,
                metadata: { path: '/calculate', httpMethod: 'GET', capability: 'http-handler' },
            },
        ];
        const task = makeTask({
            name: 'CalculatorController.handle',
            filepath: 'src/controllers/CalculatorController.ts',
            sourceCode: 'return 2 + 2;',
            matchedFrameworkSignals: signals,
        });

        const result = await extractSemantics([task], []);

        expect(result.rejectedCount).toBe(0);
        expect(result.extractedFunctions).toHaveLength(1);
        expect(result.extractedFunctions[0]!.analysis.emergent_api_calls).toContainEqual(
            expect.objectContaining({
                method: 'GET',
                path: '/math/calculate',
                direction: 'INBOUND',
            }),
        );
    });
});
