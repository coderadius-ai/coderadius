import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import { paths } from '../../config/paths.js';
import { makeCacheKey } from './osv-client.js';

export interface OsvCacheItem {
    fetchedAt: string;
    vulns: unknown[];
}

interface CacheStore {
    entries: Record<string, OsvCacheItem>;
}

const DEFAULT_TTL_HOURS = 24;

export interface CachePartition<T> {
    hits: Map<string, OsvCacheItem>;
    misses: T[];
}

export function partitionByCache<T extends { ecosystem: string; name: string; version: string }>(
    queries: T[],
    ttlHours = DEFAULT_TTL_HOURS,
    forceRefresh = false,
): CachePartition<T> {
    const store = forceRefresh ? emptyCacheStore() : loadStore();
    const hits = new Map<string, OsvCacheItem>();
    const misses: T[] = [];

    for (const q of queries) {
        const key = makeCacheKey(q.ecosystem, q.name, q.version);
        const cached = store.entries[key];
        if (cached && isFresh(cached.fetchedAt, ttlHours)) {
            hits.set(key, cached);
        } else {
            misses.push(q);
        }
    }

    return { hits, misses };
}

export function updateCache(results: Map<string, unknown[]>): void {
    const store = loadStore();
    const now = new Date().toISOString();

    for (const [key, vulns] of results) {
        store.entries[key] = { fetchedAt: now, vulns };
    }

    saveStore(store);
}

// ─── Pure helpers (exported for testing) ────────────────────────────────────

export function isFresh(fetchedAt: string, ttlHours: number): boolean {
    const ageMs = Date.now() - new Date(fetchedAt).getTime();
    return ageMs < ttlHours * 3_600_000;
}

// ─── Internals ──────────────────────────────────────────────────────────────

function getCachePath(): string {
    return path.join(paths.cache.osv, 'cache.json');
}

function emptyCacheStore(): CacheStore {
    return { entries: {} };
}

function loadStore(): CacheStore {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) return emptyCacheStore();
    try {
        return JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheStore;
    } catch {
        logger.debug('[vuln-cache] Corrupt cache file, starting fresh');
        return emptyCacheStore();
    }
}

function saveStore(store: CacheStore): void {
    const cachePath = getCachePath();
    const dir = path.dirname(cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(store), 'utf-8');
}
