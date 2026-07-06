import { vi } from 'vitest';

const mockGenerate = vi.fn().mockResolvedValue({
    object: { matches: [] },
    usage: { totalTokens: 0 }
});

vi.mock('@mastra/core/agent', () => {
    return {
        Agent: vi.fn().mockImplementation(() => ({
            generate: mockGenerate
        }))
    };
});

vi.mock('../../../../src/ai/models/provider.js', () => {
    return {
        getModel: vi.fn().mockReturnValue({})
    };
});

vi.mock('../../../../src/utils/logger.js', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }
}));

import { describe, it, expect, beforeEach } from 'vitest';
import { matchFunctionsToEndpoints, type TargetedMatchTask } from '../../../../src/ai/agents/matchmaker.js';

describe('matchFunctionsToEndpoints V2 (Targeted)', () => {
    beforeEach(() => {
        mockGenerate.mockClear();
    });

    it('should make one LLM call per batch', async () => {
        const batch1: TargetedMatchTask[] = Array.from({ length: 5 }, (_, i) => ({
            function: { urn: `cr://function/svc/f${i}`, name: `func${i}`, intent: `Does thing ${i}` },
            candidates: [
                { urn: 'cr://endpoint/GET//api/test', method: 'GET', path: '/api/test', summary: 'Test' },
                { urn: 'cr://endpoint/POST//api/test', method: 'POST', path: '/api/test', summary: 'Create' },
            ]
        }));

        const batch2: TargetedMatchTask[] = Array.from({ length: 3 }, (_, i) => ({
            function: { urn: `cr://function/svc/g${i}`, name: `gunc${i}`, intent: `Other thing ${i}` },
            candidates: [
                { urn: 'cr://endpoint/DELETE//api/test', method: 'DELETE', path: '/api/test', summary: 'Delete' },
            ]
        }));

        await matchFunctionsToEndpoints([batch1, batch2]);

        // 2 batches = 2 LLM calls
        expect(mockGenerate).toHaveBeenCalledTimes(2);

        // Verify prompts contain targeted candidates, not all endpoints
        const prompt1 = mockGenerate.mock.calls[0][0] as string;
        expect(prompt1).toContain('func0');
        expect(prompt1).toContain('GET /api/test');
        expect(prompt1).toContain('POST /api/test');
        expect(prompt1).not.toContain('DELETE /api/test'); // Not in batch1's candidates

        const prompt2 = mockGenerate.mock.calls[1][0] as string;
        expect(prompt2).toContain('gunc0');
        expect(prompt2).toContain('DELETE /api/test');
        expect(prompt2).not.toContain('POST /api/test'); // Not in batch2's candidates
    });

    it('should consolidate matches from all batches', async () => {
        mockGenerate
            .mockResolvedValueOnce({
                object: {
                    matches: [{ functionUrn: 'cr://function/svc/f0', endpointUrn: 'cr://endpoint/GET//api/a' }]
                },
                usage: { totalTokens: 50 }
            })
            .mockResolvedValueOnce({
                object: {
                    matches: [{ functionUrn: 'cr://function/svc/f1', endpointUrn: 'cr://endpoint/POST//api/b' }]
                },
                usage: { totalTokens: 50 }
            });

        const batches: TargetedMatchTask[][] = [
            [{ function: { urn: 'cr://function/svc/f0', name: 'a', intent: null }, candidates: [{ urn: 'cr://endpoint/GET//api/a', method: 'GET', path: '/api/a', summary: null }] }],
            [{ function: { urn: 'cr://function/svc/f1', name: 'b', intent: null }, candidates: [{ urn: 'cr://endpoint/POST//api/b', method: 'POST', path: '/api/b', summary: null }] }],
        ];

        const results = await matchFunctionsToEndpoints(batches);

        expect(results).toHaveLength(2);
        expect(results[0].functionUrn).toBe('cr://function/svc/f0');
        expect(results[1].functionUrn).toBe('cr://function/svc/f1');
    });

    it('should return empty array for empty batches', async () => {
        const results = await matchFunctionsToEndpoints([]);
        expect(results).toEqual([]);
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('should return empty results if LLM call times out', async () => {
        mockGenerate.mockRejectedValue(new Error('Matchmaking batch 1 timed out after 60000ms'));
        
        const batches: TargetedMatchTask[][] = [
            [{ function: { urn: 'cr://f1', name: 'f1', intent: null }, candidates: [] }]
        ];
        
        const results = await matchFunctionsToEndpoints(batches);
        expect(results).toEqual([]);
        // The retry loop (MAX_RETRIES=3) exhausts all attempts on persistent
        // exceptions, so mockGenerate is called 3 times before the batch is skipped.
        expect(mockGenerate).toHaveBeenCalledTimes(3);
    });

    it('should NOT retry when the model resolves with an empty object (Mastra abort/timeout)', async () => {
        // Mastra resolves (no throw) with object:undefined when the call is
        // aborted by the timeout signal, content-filtered, or returns empty.
        // Re-issuing the identical temperature-0 prompt would repeat the result,
        // so the batch is dropped after a SINGLE attempt — not retried 3×.
        mockGenerate.mockResolvedValue({
            object: undefined,
            finishReason: 'tripwire',
            usage: { totalTokens: 0 },
        });

        const batches: TargetedMatchTask[][] = [
            [{ function: { urn: 'cr://f1', name: 'f1', intent: null }, candidates: [] }]
        ];

        const results = await matchFunctionsToEndpoints(batches);
        expect(results).toEqual([]);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });
});
