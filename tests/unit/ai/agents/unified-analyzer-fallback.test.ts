/**
 * Tests for the analyzeFunction fallback-model path.
 *
 * Setup: spy on `agent.generate` for both the primary and fallback singleton
 * agents so tests run without real Vertex calls. The chunk uses
 * `language: undefined` so getAnalyzerStrategy / getFallbackAnalyzerStrategy
 * route to the no-hints fast singletons (the ones we spy on).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    analyzeFunction,
    analyzeFunctionBatch,
    getFastAnalyzerAgent,
    getFastFallbackAnalyzerAgent,
    type BatchFunctionContext,
    type BatchSharedContext,
} from '../../../../src/ai/agents/unified-analyzer.js';
import { EndpointUnreachableError } from '../../../../src/utils/congestion-control.js';
import { resetConnectionHealthForTests } from '../../../../src/utils/connection-health.js';
import { telemetryCollector } from '../../../../src/telemetry/index.js';
import type { CodeChunk } from '../../../../src/graph/types.js';

// The singleton agents are constructed lazily on first use, and construction
// resolves the real provider config (env > settings file > tier defaults).
// Pin a fake Vertex identity so the test is hermetic: it must not depend on
// the host's .env, ~/.coderadius settings, or CI secrets. No network is ever
// touched — every `generate` call below is mocked.
process.env.MODEL_PROVIDER = 'vertex';
process.env.GOOGLE_VERTEX_PROJECT = 'acme-test-project';
process.env.GOOGLE_VERTEX_LOCATION = 'europe-west1';

const validAnalysis = {
    _reasoning: 'Function deletes rows from a known table.',
    has_io: true,
    intent: 'Deletes records from acme_quote_json table.',
    infrastructure: [
        { name: 'acme_quote_json', type: 'Database', operation: 'WRITES' as const },
    ],
    capabilities: ['database-writer'],
    emergent_api_calls: [],
};

const chunk: CodeChunk = {
    name: 'deleteAcmeQuotes',
    filepath: 'src/inventory/acme.php',
    language: undefined as unknown as string,
    sourceCode: `function deleteAcmeQuotes(int $id): void {
        getDb()->preparedQuery('DELETE FROM acme_quote_json WHERE id = ?', [$id]);
    }`,
};

describe('analyzeFunction: fallback-model path', () => {
    let primarySpy: ReturnType<typeof vi.spyOn>;
    let fallbackSpy: ReturnType<typeof vi.spyOn>;
    let savesSpy: ReturnType<typeof vi.spyOn>;
    let errorsSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        primarySpy = vi.spyOn(getFastAnalyzerAgent(), 'generate');
        fallbackSpy = vi.spyOn(getFastFallbackAnalyzerAgent(), 'generate');
        savesSpy = vi.spyOn(telemetryCollector, 'incrementFallbackSaves');
        errorsSpy = vi.spyOn(telemetryCollector, 'incrementErrors');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns primary analysis when primary succeeds (no fallback call)', async () => {
        primarySpy.mockResolvedValue({
            object: validAnalysis,
            finishReason: 'STOP',
            usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
        } as never);

        const result = await analyzeFunction(chunk, 'fast');

        expect(result).not.toBeNull();
        expect(result!.analysis).toMatchObject({
            has_io: true,
            intent: validAnalysis.intent,
        });
        expect(fallbackSpy).not.toHaveBeenCalled();
        expect(savesSpy).not.toHaveBeenCalled();
    });

    it('falls back to secondary model on primary tripwire (timeout)', async () => {
        primarySpy.mockResolvedValue({
            object: undefined,
            finishReason: 'tripwire',
            text: '',
        } as never);
        fallbackSpy.mockResolvedValue({
            object: validAnalysis,
            finishReason: 'STOP',
            usage: { totalTokens: 80, inputTokens: 70, outputTokens: 10 },
        } as never);

        const result = await analyzeFunction(chunk, 'fast');

        expect(result).not.toBeNull();
        expect(result!.analysis.intent).toBe(validAnalysis.intent);
        expect(fallbackSpy).toHaveBeenCalledOnce();
        expect(savesSpy).toHaveBeenCalledOnce();
        expect(errorsSpy).not.toHaveBeenCalled();
    });

    it('falls back even when primary returns empty without tripwire (e.g. STOP with no object)', async () => {
        primarySpy.mockResolvedValue({
            object: undefined,
            finishReason: 'STOP',
            text: '',
        } as never);
        fallbackSpy.mockResolvedValue({
            object: validAnalysis,
            finishReason: 'STOP',
            usage: { totalTokens: 80 },
        } as never);

        const result = await analyzeFunction(chunk, 'fast');

        expect(result).not.toBeNull();
        expect(fallbackSpy).toHaveBeenCalledOnce();
        expect(savesSpy).toHaveBeenCalledOnce();
    });

    it('returns null and counts an error when both primary and fallback fail', async () => {
        primarySpy.mockResolvedValue({
            object: undefined,
            finishReason: 'tripwire',
            text: '',
        } as never);
        fallbackSpy.mockResolvedValue({
            object: undefined,
            finishReason: 'tripwire',
            text: '',
        } as never);

        const result = await analyzeFunction(chunk, 'fast');

        expect(result).toBeNull();
        expect(fallbackSpy).toHaveBeenCalledOnce();
        expect(savesSpy).not.toHaveBeenCalled();
        expect(errorsSpy).toHaveBeenCalledOnce();
    });
});

/**
 * Connection errors are endpoint-global, not per-call: the model fallback
 * exists for model-quality failures (empty/blocked output), never for a
 * socket that could not open. These tests pin that transport failures skip
 * the fallback model and propagate so the caller routes them to the
 * deferred-retry drain.
 */
describe('analyzeFunction: connection-error routing (no per-call model fallback)', () => {
    let primarySpy: ReturnType<typeof vi.spyOn>;
    let fallbackSpy: ReturnType<typeof vi.spyOn>;

    const connectionError = () => {
        const err = new Error('Cannot connect to API: Was there a typo in the url or port?');
        err.name = 'AI_APICallError';
        return err;
    };

    beforeEach(() => {
        primarySpy = vi.spyOn(getFastAnalyzerAgent(), 'generate');
        fallbackSpy = vi.spyOn(getFastFallbackAnalyzerAgent(), 'generate');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetConnectionHealthForTests();
    });

    it('a primary connection error propagates without calling the fallback model', async () => {
        primarySpy.mockRejectedValue(connectionError() as never);

        await expect(analyzeFunction(chunk, 'fast')).rejects.toThrow(/cannot connect/i);
        expect(fallbackSpy).not.toHaveBeenCalled();
    });

    it('an open-circuit EndpointUnreachableError propagates without calling the fallback model', async () => {
        primarySpy.mockRejectedValue(new EndpointUnreachableError('vertex/acme-model', 5, 12_000) as never);

        await expect(analyzeFunction(chunk, 'fast')).rejects.toBeInstanceOf(EndpointUnreachableError);
        expect(fallbackSpy).not.toHaveBeenCalled();
    });

    it('a non-connection primary error still routes to the fallback model (status quo pin)', async () => {
        primarySpy.mockRejectedValue(new Error('schema validation exploded') as never);
        fallbackSpy.mockResolvedValue({
            object: validAnalysis,
            finishReason: 'STOP',
            usage: { totalTokens: 80 },
        } as never);

        const result = await analyzeFunction(chunk, 'fast');

        expect(result).not.toBeNull();
        expect(fallbackSpy).toHaveBeenCalledOnce();
    });
});

describe('analyzeFunctionBatch: connection-error routing (no per-member fan-out)', () => {
    let primarySpy: ReturnType<typeof vi.spyOn>;

    const shared: BatchSharedContext = {
        filepath: 'src/inventory/sync.php',
        language: undefined as unknown as string,
        context: { imports: [] },
    } as BatchSharedContext;

    const members: BatchFunctionContext[] = [
        { chunk: { ...chunk, name: 'reserveStock' } },
        { chunk: { ...chunk, name: 'releaseStock' } },
    ];

    beforeEach(() => {
        primarySpy = vi.spyOn(getFastAnalyzerAgent(), 'generate');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetConnectionHealthForTests();
    });

    it('rejects on a connection error (deferred drain) instead of fanning out to single calls', async () => {
        const err = new Error('Cannot connect to API: Was there a typo in the url or port?');
        err.name = 'AI_APICallError';
        primarySpy.mockRejectedValue(err as never);

        // A null return would multiply one dead-endpoint discovery into N
        // single-call queue waits + timeouts. The batch must reject as a unit.
        await expect(analyzeFunctionBatch(shared, members)).rejects.toThrow(/cannot connect/i);
        expect(primarySpy).toHaveBeenCalledOnce();
    });

    it('still resolves null (single-call fallback) on a generic batch failure (status quo pin)', async () => {
        primarySpy.mockRejectedValue(new Error('schema validation exploded') as never);

        await expect(analyzeFunctionBatch(shared, members)).resolves.toBeNull();
    });
});

