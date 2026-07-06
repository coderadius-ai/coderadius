import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileBackend } from '../../../../src/ai/agents/sink-classifier/cache/file-backend.js';
import { computeCacheKey, computeModelFingerprint, type CacheEntry } from '../../../../src/ai/agents/sink-classifier/cache/types.js';

describe('FileBackend — cache I/O', () => {
    let rootDir: string;
    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sink-cache-test-'));
    });
    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    function makeEntry(name: string, ecosystem = 'npm'): CacheEntry {
        const fingerprint = computeModelFingerprint('test', 'model-v1');
        const cacheKey = computeCacheKey(name, ecosystem, fingerprint);
        return {
            cacheKey,
            name,
            ecosystem,
            schemaVersion: 'v1.0.0-sink-classifier',
            modelFingerprint: fingerprint,
            classification: { name, sinkType: 'Database', confidence: 0.99, evidence: ['test'] },
            seenVersions: [],
            timestamp: '2026-05-02T00:00:00Z',
        };
    }

    it('save then lookup roundtrips', async () => {
        const backend = new FileBackend({ rootDir, tenantId: 'unit' });
        const entry = makeEntry('pg');
        await backend.save(entry.cacheKey, entry);
        const hit = await backend.lookup(entry.cacheKey);
        expect(hit?.name).toBe('pg');
        expect(hit?.classification.sinkType).toBe('Database');
    });

    it('lookup miss returns null', async () => {
        const backend = new FileBackend({ rootDir, tenantId: 'unit' });
        const hit = await backend.lookup('nonexistent');
        expect(hit).toBeNull();
    });

    it('listKeys returns all saved keys for a tenant', async () => {
        const backend = new FileBackend({ rootDir, tenantId: 'unit' });
        const a = makeEntry('axios');
        const b = makeEntry('pg');
        await backend.save(a.cacheKey, a);
        await backend.save(b.cacheKey, b);
        const keys = await backend.listKeys();
        expect(new Set(keys)).toEqual(new Set([a.cacheKey, b.cacheKey]));
    });

    it('delete removes the entry', async () => {
        const backend = new FileBackend({ rootDir, tenantId: 'unit' });
        const e = makeEntry('axios');
        await backend.save(e.cacheKey, e);
        await backend.delete(e.cacheKey);
        const hit = await backend.lookup(e.cacheKey);
        expect(hit).toBeNull();
    });

    it('healthCheck succeeds when filesystem is writable', async () => {
        const backend = new FileBackend({ rootDir, tenantId: 'unit' });
        const h = await backend.healthCheck();
        expect(h.ok).toBe(true);
    });

    it('tenant isolation: data saved under tenantA is not visible under tenantB', async () => {
        const a = new FileBackend({ rootDir, tenantId: 'tenantA' });
        const b = new FileBackend({ rootDir, tenantId: 'tenantB' });
        const e = makeEntry('pg');
        await a.save(e.cacheKey, e);
        expect(await a.lookup(e.cacheKey)).not.toBeNull();
        expect(await b.lookup(e.cacheKey)).toBeNull();
    });

    describe('integrity (HMAC)', () => {
        const HMAC_KEY = 'test-secret-please';
        beforeEach(() => { process.env.SINK_CACHE_HMAC_KEY = HMAC_KEY; });
        afterEach(() => { delete process.env.SINK_CACHE_HMAC_KEY; });

        it('signs entries on save and verifies on lookup', async () => {
            const backend = new FileBackend({ rootDir, tenantId: 'sec' });
            const e = makeEntry('pg');
            await backend.save(e.cacheKey, e);
            const hit = await backend.lookup(e.cacheKey);
            expect(hit?.signature).toBeDefined();
        });

        it('rejects tampered entries (returns null on lookup)', async () => {
            const backend = new FileBackend({ rootDir, tenantId: 'sec' });
            const e = makeEntry('pg');
            await backend.save(e.cacheKey, e);

            // Tamper: change sinkType after the fact
            const filePath = path.join(rootDir, 'sec', 'npm', `${e.cacheKey}.json`);
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            raw.classification.sinkType = 'NotASink';
            fs.writeFileSync(filePath, JSON.stringify(raw));

            const hit = await backend.lookup(e.cacheKey);
            expect(hit).toBeNull();
        });
    });
});

describe('cache key', () => {
    it('does NOT depend on lockedVersion (intentional)', () => {
        const fp = computeModelFingerprint('test', 'model-v1');
        // No version is part of the API; fingerprint determines re-classification
        const k1 = computeCacheKey('axios', 'npm', fp);
        const k2 = computeCacheKey('axios', 'npm', fp);
        expect(k1).toBe(k2);
    });

    it('changes when model fingerprint changes (forces re-classify on model change)', () => {
        const fp1 = computeModelFingerprint('test', 'model-v1');
        const fp2 = computeModelFingerprint('test', 'model-v2');
        expect(computeCacheKey('axios', 'npm', fp1))
            .not.toBe(computeCacheKey('axios', 'npm', fp2));
    });

    it('isolates different ecosystems', () => {
        const fp = computeModelFingerprint('test', 'model-v1');
        expect(computeCacheKey('symfony/messenger', 'composer', fp))
            .not.toBe(computeCacheKey('symfony/messenger', 'npm', fp));
    });
});
