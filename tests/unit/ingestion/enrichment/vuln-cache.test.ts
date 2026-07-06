import { describe, it, expect, vi } from 'vitest';

// partitionByCache reads the REAL user cache (~/.coderadius/cache/osv) via
// config/paths. Point it at a unique empty temp dir so machine state (a real
// scan that cached one of the fixture packages) cannot leak into the test.
vi.mock('../../../../src/config/paths.js', async (importOriginal) => {
    const { paths } = await importOriginal<typeof import('../../../../src/config/paths.js')>();
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpRoot = path.join(os.tmpdir(), `coderadius-vuln-cache-test-${process.pid}`);
    return {
        paths: {
            ...paths,
            cache: { ...paths.cache, osv: path.join(tmpRoot, 'cache', 'osv') },
        },
    };
});

import { partitionByCache, isFresh } from '../../../../src/ingestion/enrichment/vuln-cache.js';

describe('isFresh', () => {
    it('returns true for timestamp within TTL', () => {
        const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
        expect(isFresh(oneHourAgo, 24)).toBe(true);
    });

    it('returns false for timestamp older than TTL', () => {
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
        expect(isFresh(twoDaysAgo, 24)).toBe(false);
    });

    it('returns false for exactly expired TTL', () => {
        const exactly24hAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
        expect(isFresh(exactly24hAgo, 24)).toBe(false);
    });

    it('returns true for just-now timestamp', () => {
        expect(isFresh(new Date().toISOString(), 1)).toBe(true);
    });

    it('handles short TTL (1 hour)', () => {
        const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
        expect(isFresh(twoHoursAgo, 1)).toBe(false);
    });
});

describe('partitionByCache', () => {
    const queries = [
        { ecosystem: 'npm', name: 'lodash', version: '4.17.21' },
        { ecosystem: 'npm', name: 'axios', version: '0.21.1' },
        { ecosystem: 'composer', name: 'guzzlehttp/guzzle', version: '7.5.0' },
    ];

    it('treats all queries as cache misses when forceRefresh is true', () => {
        const { hits, misses } = partitionByCache(queries, 24, true);
        expect(hits.size).toBe(0);
        expect(misses).toHaveLength(3);
    });

    it('preserves query objects in misses', () => {
        const { misses } = partitionByCache(queries, 24, true);
        expect(misses[0]).toEqual({ ecosystem: 'npm', name: 'lodash', version: '4.17.21' });
        expect(misses[2]).toEqual({ ecosystem: 'composer', name: 'guzzlehttp/guzzle', version: '7.5.0' });
    });

    it('treats all as misses on first run (no cache file)', () => {
        const { misses } = partitionByCache(queries);
        expect(misses).toHaveLength(3);
    });
});
