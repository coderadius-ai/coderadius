// ═══════════════════════════════════════════════════════════════════════════════
// FileBackend — local disk SinkCacheBackend.
//
// Layout:
//   ~/.coderadius/cache/sink-classifier/{tenant}/{ecosystem}/{cacheKey}.json
//
// Atomic writes via temp+rename. Tenant from CODERADIUS_TENANT_ID (default
// 'default'). Concurrent processes can safely share a directory thanks to the
// rename-based commit; readers never see partial JSON.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../../../utils/logger.js';
import { paths } from '../../../../config/paths.js';
import type { SinkCacheBackend, CacheEntry, BackendHealth } from './types.js';
import { signEntry, verifyEntry } from './integrity.js';

const TENANT_ENV = 'CODERADIUS_TENANT_ID';

export interface FileBackendOptions {
    /** Override the cache root. Default: ~/.coderadius/cache/sink-classifier */
    rootDir?: string;
    /** Override the tenant id. Default: env CODERADIUS_TENANT_ID or 'default'. */
    tenantId?: string;
}

export class FileBackend implements SinkCacheBackend {
    readonly id = 'file';
    private rootDir: string;
    private tenantId: string;

    constructor(opts: FileBackendOptions = {}) {
        this.rootDir = opts.rootDir ?? paths.cache.sinkClassifier;
        this.tenantId = opts.tenantId ?? process.env[TENANT_ENV] ?? 'default';
    }

    private filePath(key: string, ecosystem: string): string {
        return path.join(this.rootDir, this.tenantId, ecosystem, `${key}.json`);
    }

    async lookup(key: string): Promise<CacheEntry | null> {
        // We don't know the ecosystem from key alone — try a glob across ecosystems
        // by scanning the tenant dir. Cheap because each ecosystem dir is small.
        const tenantDir = path.join(this.rootDir, this.tenantId);
        if (!existsSync(tenantDir)) return null;

        let dirs: string[];
        try {
            dirs = await fs.readdir(tenantDir);
        } catch {
            return null;
        }

        for (const ecosystem of dirs) {
            const filePath = path.join(tenantDir, ecosystem, `${key}.json`);
            if (!existsSync(filePath)) continue;
            try {
                const raw = await fs.readFile(filePath, 'utf-8');
                const entry = JSON.parse(raw) as CacheEntry;
                if (!verifyEntry(entry)) {
                    logger.warn(`[SinkCache] Integrity check failed for ${key} — rejecting cache hit`);
                    return null;
                }
                return entry;
            } catch (err) {
                logger.warn(`[SinkCache] Failed to read ${filePath}: ${(err as Error).message}`);
                return null;
            }
        }
        return null;
    }

    async save(key: string, entry: CacheEntry): Promise<void> {
        const signed = signEntry(entry);
        const filePath = this.filePath(key, entry.ecosystem);
        const dir = path.dirname(filePath);
        try {
            await fs.mkdir(dir, { recursive: true });
            const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
            await fs.writeFile(tmpPath, JSON.stringify(signed, null, 2), 'utf-8');
            await fs.rename(tmpPath, filePath);
        } catch (err) {
            logger.warn(`[SinkCache] Failed to save ${filePath}: ${(err as Error).message}`);
        }
    }

    async listKeys(prefix?: string): Promise<string[]> {
        const tenantDir = path.join(this.rootDir, this.tenantId);
        if (!existsSync(tenantDir)) return [];
        const result: string[] = [];
        let ecosystems: string[] = [];
        try {
            ecosystems = await fs.readdir(tenantDir);
        } catch {
            return [];
        }
        for (const eco of ecosystems) {
            let files: string[] = [];
            try {
                files = await fs.readdir(path.join(tenantDir, eco));
            } catch {
                continue;
            }
            for (const f of files) {
                if (!f.endsWith('.json')) continue;
                const key = f.slice(0, -'.json'.length);
                if (!prefix || key.startsWith(prefix)) result.push(key);
            }
        }
        return result;
    }

    async delete(key: string): Promise<void> {
        const tenantDir = path.join(this.rootDir, this.tenantId);
        if (!existsSync(tenantDir)) return;
        let ecosystems: string[] = [];
        try {
            ecosystems = await fs.readdir(tenantDir);
        } catch {
            return;
        }
        for (const eco of ecosystems) {
            const fp = path.join(tenantDir, eco, `${key}.json`);
            if (existsSync(fp)) {
                try { await fs.unlink(fp); } catch { /* swallow */ }
            }
        }
    }

    async healthCheck(): Promise<BackendHealth> {
        const start = Date.now();
        try {
            await fs.mkdir(path.join(this.rootDir, this.tenantId), { recursive: true });
            return { ok: true, latencyMs: Date.now() - start };
        } catch (err) {
            return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
        }
    }
}
