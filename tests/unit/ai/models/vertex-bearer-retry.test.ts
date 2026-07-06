import { describe, it, expect, vi } from 'vitest';
import { fetchWithBearerRetry } from '../../../../src/ai/models/gemini.js';

const res = (status: number) => new Response('{}', { status });

describe('fetchWithBearerRetry', () => {
    it('passes through non-401 responses without retry', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(res(200));
        const invalidate = vi.fn();
        const out = await fetchWithBearerRetry('https://api.test/x', undefined, () => 'tok-a', invalidate, fetchImpl);
        expect(out.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('on 401: invalidates, re-mints, retries ONCE with the fresh token', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(res(401))
            .mockResolvedValueOnce(res(200));
        const tokens = ['tok-stale', 'tok-fresh'];
        const resolveToken = vi.fn(() => tokens.shift() ?? null);
        const invalidate = vi.fn();

        const out = await fetchWithBearerRetry('https://api.test/x', { method: 'POST' }, resolveToken, invalidate, fetchImpl);

        expect(out.status).toBe(200);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const retryHeaders = new Headers((fetchImpl.mock.calls[1]![1] as RequestInit).headers as HeadersInit);
        expect(retryHeaders.get('Authorization')).toBe('Bearer tok-fresh');
    });

    it('a second 401 is returned as-is (no retry loop)', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(res(401));
        const out = await fetchWithBearerRetry('https://api.test/x', undefined, () => 'tok', vi.fn(), fetchImpl);
        expect(out.status).toBe(401);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('when re-mint fails, the original 401 is returned', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(res(401));
        const tokens: Array<string | null> = ['tok-stale', null];
        const out = await fetchWithBearerRetry('https://api.test/x', undefined, () => tokens.shift() ?? null, vi.fn(), fetchImpl);
        expect(out.status).toBe(401);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('strips x-goog-api-key and sets the bearer on every attempt', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(res(200));
        await fetchWithBearerRetry('https://api.test/x', { headers: { 'x-goog-api-key': 'leak' } }, () => 'tok', vi.fn(), fetchImpl);
        const sent = new Headers((fetchImpl.mock.calls[0]![1] as RequestInit).headers as HeadersInit);
        expect(sent.get('x-goog-api-key')).toBeNull();
        expect(sent.get('Authorization')).toBe('Bearer tok');
    });

    it('a timed-out request is retried ONCE on a fresh connection', async () => {
        const timeoutErr = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(timeoutErr)
            .mockResolvedValueOnce(res(200));
        const out = await fetchWithBearerRetry('https://api.test/x', undefined, () => 'tok', vi.fn(), fetchImpl);
        expect(out.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('a second consecutive timeout propagates (real outage)', async () => {
        const timeoutErr = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
        const fetchImpl = vi.fn().mockRejectedValue(timeoutErr);
        await expect(fetchWithBearerRetry('https://api.test/x', undefined, () => 'tok', vi.fn(), fetchImpl))
            .rejects.toThrow(/timed out/);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('non-timeout fetch errors propagate immediately (no retry)', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(fetchWithBearerRetry('https://api.test/x', undefined, () => 'tok', vi.fn(), fetchImpl))
            .rejects.toThrow(/ECONNREFUSED/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('caller-provided AbortSignal is respected (no implicit timeout override)', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(res(200));
        const controller = new AbortController();
        await fetchWithBearerRetry('https://api.test/x', { signal: controller.signal }, () => 'tok', vi.fn(), fetchImpl);
        expect((fetchImpl.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
    });
});
