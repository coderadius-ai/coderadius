import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisTask } from '../../../../../src/ingestion/processors/code-pipeline/types.js';
import { EndpointUnreachableError, MaxRetriesExceededError } from '../../../../../src/utils/congestion-control.js';

const { analyzeFunctionMock, analyzeMixedFunctionBatchMock, extractDataSchemaMock } = vi.hoisted(() => ({
    analyzeFunctionMock: vi.fn(),
    // R2 merges same-language singletons into a mixed batch; returning null
    // routes every member through the single-call path, which is exactly the
    // per-task deferred semantics this suite pins.
    analyzeMixedFunctionBatchMock: vi.fn(async () => null),
    extractDataSchemaMock: vi.fn(),
}));

vi.mock('../../../../../src/ai/agents/unified-analyzer.js', async () => {
    const actual = await vi.importActual('../../../../../src/ai/agents/unified-analyzer.js');
    return {
        ...actual,
        analyzeFunction: analyzeFunctionMock,
        analyzeMixedFunctionBatch: analyzeMixedFunctionBatchMock,
    };
});

vi.mock('../../../../../src/ai/agents/schema-extractor.js', () => ({
    extractDataSchema: extractDataSchemaMock,
}));

const incrementErrorsMock = vi.fn();
vi.mock('../../../../../src/telemetry/index.js', () => ({
    telemetryCollector: {
        incrementLLMInvocations: vi.fn(),
        incrementLLMRejections: vi.fn(),
        incrementLLMFailures: vi.fn(),
        incrementFunctionsSkipped: vi.fn(),
        incrementErrors: incrementErrorsMock,
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

function makeTask(name: string): AnalysisTask {
    return {
        kind: 'analysis',
        functionId: `urn:function:repo:src/${name}.ts:${name}`,
        functionHash: `${name}-hash`,
        chunk: {
            name,
            filepath: `src/${name}.ts`,
            sourceCode: 'return 2 + 2;',
            language: 'typescript',
            startLine: 1,
            startColumn: 1,
            endLine: 10,
            endColumn: 1,
        },
        fileContext: {
            absolutePath: `/tmp/src/${name}.ts`,
            relativePath: `src/${name}.ts`,
            repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
            routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
            fileHash: 'file-hash',
            ownerService: null,
            isManifest: false,
        },
        filterGate: 4,
        filterReason: 'taint',
    } as AnalysisTask;
}

describe('extractSemantics() — deferred-retry routing for MaxRetriesExceededError', () => {
    beforeEach(() => {
        analyzeFunctionMock.mockReset();
        extractDataSchemaMock.mockReset();
        incrementErrorsMock.mockReset();
    });

    it('routes a MaxRetriesExceededError task to deferredTasks without incrementing errors or failedCount', async () => {
        const { extractSemantics } = await import(
            '../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js'
        );

        const tasks = [makeTask('alpha'), makeTask('beta'), makeTask('gamma')];

        analyzeFunctionMock.mockImplementation(async (chunk: any) => {
            if (chunk.name === 'beta') {
                throw new MaxRetriesExceededError(10, new Error('429 Too Many Requests'));
            }
            return {
                analysis: {
                    has_io: false,
                    intent: '',
                    infrastructure: [],
                    capabilities: [],
                    produced_payloads: [],
                    consumed_payloads: [],
                    emergent_api_calls: [],
                },
                usage: {},
            };
        });

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(result.deferredTasks).toHaveLength(1);
        expect(result.deferredTasks[0]?.chunk.name).toBe('beta');
        expect(result.failedCount).toBe(0);
        expect(result.rejectedCount).toBe(2);
        expect(incrementErrorsMock).not.toHaveBeenCalled();
    });

    it('treats non-429 errors as failures (status quo: failedCount++, error emitted)', async () => {
        const { extractSemantics } = await import(
            '../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js'
        );

        const tasks = [makeTask('alpha')];

        analyzeFunctionMock.mockRejectedValue(new Error('schema validation failed'));

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(result.deferredTasks).toHaveLength(0);
        expect(result.failedCount).toBe(1);
        expect(incrementErrorsMock).toHaveBeenCalledTimes(1);
    });

    it('detects MaxRetriesExceededError by code field even if instanceof check fails (cross-module identity safety)', async () => {
        const { extractSemantics } = await import(
            '../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js'
        );

        const tasks = [makeTask('alpha')];

        analyzeFunctionMock.mockImplementation(async () => {
            const err: Error & { code?: string } = new Error('LLM call failed after 10 429 retries');
            err.name = 'MaxRetriesExceededError';
            err.code = 'MAX_RETRIES_EXCEEDED';
            throw err;
        });

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(result.deferredTasks).toHaveLength(1);
        expect(result.failedCount).toBe(0);
        expect(incrementErrorsMock).not.toHaveBeenCalled();
    });

    it('routes a connection error (dead endpoint / network outage) to deferredTasks, not failures', async () => {
        const { extractSemantics } = await import(
            '../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js'
        );

        const tasks = [makeTask('alpha')];

        analyzeFunctionMock.mockImplementation(async () => {
            const err = new Error('Cannot connect to API: Was there a typo in the url or port?');
            err.name = 'AI_APICallError';
            throw err;
        });

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        // A network outage is transient: the deferred drain retries at end of
        // run, when connectivity may be back. Marking it 'failed' would burn
        // the function permanently for a transport blip.
        expect(result.deferredTasks).toHaveLength(1);
        expect(result.failedCount).toBe(0);
        expect(incrementErrorsMock).not.toHaveBeenCalled();
    });

    it('routes an open-circuit EndpointUnreachableError to deferredTasks', async () => {
        const { extractSemantics } = await import(
            '../../../../../src/ingestion/processors/code-pipeline/semantic-extractor.js'
        );

        const tasks = [makeTask('alpha')];

        analyzeFunctionMock.mockRejectedValue(
            new EndpointUnreachableError('vertex/acme-model', 7, 45_000),
        );

        const result = await extractSemantics(tasks, [], undefined, 'semantic');

        expect(result.deferredTasks).toHaveLength(1);
        expect(result.failedCount).toBe(0);
        expect(incrementErrorsMock).not.toHaveBeenCalled();
    });
});
