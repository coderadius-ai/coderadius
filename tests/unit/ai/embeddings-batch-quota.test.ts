import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const embedMock = vi.fn();
const embedManyMock = vi.fn();

vi.mock('ai', () => ({
    embed: (...args: unknown[]) => embedMock(...args),
    embedMany: (...args: unknown[]) => embedManyMock(...args),
}));

vi.mock('../../../src/ai/models/gemini.js', () => ({
    getVertexContext: () => ({ embeddingModel: () => ({ modelId: 'fake-embedding' }) }),
}));

import { generateEmbeddingsBatch } from '../../../src/ai/embeddings.js';

describe('generateEmbeddingsBatch — quota-aware fallback', () => {
    beforeEach(() => {
        embedMock.mockReset();
        embedManyMock.mockReset();
        // No settings file, no embedding cache file, no cache writes.
        vi.spyOn(fs, 'existsSync').mockReturnValue(false);
        vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
        vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as never);
        vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('quota-exhausted batch does NOT fall back to per-item calls (no amplification)', async () => {
        embedManyMock.mockRejectedValue(new Error(
            'Failed after 3 attempts. Last error: Quota exceeded for '
            + 'aiplatform.googleapis.com/online_prediction_requests_per_base_model',
        ));

        const res = await generateEmbeddingsBatch(['order line a', 'order line b', 'order line c']);

        expect(res).toEqual([null, null, null]);
        expect(embedMock).not.toHaveBeenCalled();
    });

    it('non-quota batch failure still falls back to per-item calls', async () => {
        embedManyMock.mockRejectedValue(new Error('malformed payload'));
        embedMock.mockResolvedValue({ embedding: [0.6, 0.8], usage: { tokens: 2 } });

        const res = await generateEmbeddingsBatch(['shipment row x', 'shipment row y']);

        expect(embedMock).toHaveBeenCalledTimes(2);
        expect(res[0]).toEqual(expect.any(Array));
        expect(res[1]).toEqual(expect.any(Array));
    });
});
