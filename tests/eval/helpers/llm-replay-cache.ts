/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LLM Replay Cache — Deterministic Evaluation Engine
 *
 * Intercepts LLM agent.generate() responses and caches them to disk.
 * Enables sub-second eval test runs by replaying golden LLM outputs
 * instead of making live API calls.
 *
 * Three modes (controlled by EVAL_LLM_MODE env var):
 *   replay  — Use cached output. Hard-fail on cache miss. (~2s)
 *   live    — Call LLM. Save response to cache. (~200s)
 *   refresh — Call LLM. Overwrite existing cache. (~200s)
 *
 * Cache Key:
 *   sha256(agentId + instructionsHash + userPrompt + schemaVersion)
 *
 * This ensures automatic invalidation when:
 *   - Agent prompt/instructions change (instructionsHash shifts)
 *   - Input code changes (userPrompt shifts)
 *   - Output schema changes (schemaVersion bumped manually)
 *
 * The modelId is deliberately EXCLUDED from the cache key.
 * Same prompt to different models reuses the same cache entry because
 * replay mode tests the PIPELINE, not the model.
 *
 * "Live eval measures the model. Replay eval measures CodeRadius."
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReplayMode = 'replay' | 'live' | 'refresh';

// ─── Mode Resolution ─────────────────────────────────────────────────────────

const raw = process.env.EVAL_LLM_MODE?.trim().toLowerCase();
const VALID_MODES = new Set<ReplayMode>(['replay', 'live', 'refresh']);

export const EVAL_LLM_MODE: ReplayMode =
    raw && VALID_MODES.has(raw as ReplayMode)
        ? (raw as ReplayMode)
        : 'replay';

// ─── Cache Root ──────────────────────────────────────────────────────────────

const CACHE_ROOT = path.resolve(import.meta.dirname, '..', '.llm-cache');

// ─── Cache Entry Schema ──────────────────────────────────────────────────────

interface CacheEntry {
    cacheKey: string;
    agentId: string;
    modelId: string;
    schemaVersion: string;
    timestamp: string;
    /** First 300 chars of the prompt for debugging/grep */
    promptPreview: string;
    /** The full agent.generate() response — includes .object AND .usage */
    response: unknown;
}

// ─── LLMReplayCache ──────────────────────────────────────────────────────────

export class LLMReplayCache {
    private cacheMap = new Map<string, CacheEntry>();
    private hits = 0;
    private misses = 0;
    private static gcRun = false;

    constructor(
        private readonly agentId: string,
        private readonly instructionsHash: string,
        private readonly schemaVersion: string,
    ) {
        this.loadCache();
        
        // Run compaction once per process asynchronously
        if (!LLMReplayCache.gcRun) {
            this.compactCache();
            LLMReplayCache.gcRun = true;
        }
    }

    /**
     * Load the JSONL cache file into memory.
     */
    private loadCache(): void {
        const filePath = this.getCachePath();
        if (!fs.existsSync(filePath)) return;

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const entry: CacheEntry = JSON.parse(line);
                    // Only load entries that match the current schema version
                    if (entry.schemaVersion === this.schemaVersion) {
                        this.cacheMap.set(entry.cacheKey, entry);
                    }
                } catch (e) {
                    // Skip malformed lines
                }
            }
        } catch (err) {
            // Ignore read errors
        }
    }

    /**
     * Compacts the JSONL file:
     * - Removes entries older than 30 days
     * - Removes obsolete schema versions
     * - Deduplicates keys
     * Uses an atomic directory lock to prevent Vitest worker collisions.
     */
    private compactCache(): void {
        setTimeout(() => {
            const filePath = this.getCachePath();
            const lockPath = `${filePath}.lock`;

            try {
                // Atomic lock acquisition
                fs.mkdirSync(lockPath);
            } catch (e) {
                return; // Lock exists, another worker is compacting
            }

            try {
                if (!fs.existsSync(filePath)) return;

                const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
                const now = Date.now();
                const validEntries = new Map<string, CacheEntry>();
                let modified = false;

                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');
                let validLineCount = 0;

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const entry: CacheEntry = JSON.parse(line);
                        const entryTime = new Date(entry.timestamp).getTime();
                        
                        // Keep if less than 30 days old AND schema matches
                        if (now - entryTime <= THIRTY_DAYS_MS && entry.schemaVersion === this.schemaVersion) {
                            validEntries.set(entry.cacheKey, entry);
                            validLineCount++;
                        } else {
                            modified = true;
                        }
                    } catch (e) {
                        modified = true; // Strip malformed lines
                    }
                }

                // If duplicates were merged into the Map, we need a rewrite
                if (validEntries.size !== validLineCount) {
                    modified = true;
                }

                if (modified && validEntries.size > 0) {
                    // Rewrite atomically via temp file
                    const tempPath = `${filePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
                    const output = Array.from(validEntries.values())
                        .map(e => JSON.stringify(e))
                        .join('\n') + '\n';
                        
                    fs.writeFileSync(tempPath, output);
                    fs.renameSync(tempPath, filePath);
                } else if (modified && validEntries.size === 0) {
                    // If everything is expired, just remove the file
                    fs.unlinkSync(filePath);
                }
            } catch (err) {
                // Ignore internal GC errors
            } finally {
                try {
                    fs.rmdirSync(lockPath);
                } catch (e) { }
            }
        }, 0);
    }

    /**
     * Compute a deterministic cache key from the prompt content.
     * Returns a 12-char hex hash for filename-friendliness.
     */
    private computeKey(prompt: string): string {
        return crypto.createHash('sha256')
            .update(this.agentId)
            .update(this.instructionsHash)
            .update(prompt)
            .update(this.schemaVersion)
            .digest('hex')
            .slice(0, 12);
    }

    private getCachePath(): string {
        // Sanitize agentId for filename safety (replace colons with dashes)
        const safeAgentId = this.agentId.replace(/:/g, '-');
        return path.join(CACHE_ROOT, `${safeAgentId}.jsonl`);
    }

    /**
     * Look up a cached response for the given prompt.
     * Returns { hit: true, response } on cache hit, { hit: false } on miss.
     */
    lookup(prompt: string): { hit: boolean; key: string; response?: unknown } {
        const key = this.computeKey(prompt);
        const entry = this.cacheMap.get(key);

        if (entry) {
            this.hits++;
            
            // Touch timestamp on hit to keep active patterns alive
            entry.timestamp = new Date().toISOString();
            
            return { hit: true, key, response: entry.response };
        }

        this.misses++;
        return { hit: false, key };
    }

    /**
     * Persist a response to the cache.
     * Appends a new line to the agent's JSONL file.
     */
    save(prompt: string, key: string, response: unknown, modelId: string): void {
        const filePath = this.getCachePath();
        if (!fs.existsSync(path.dirname(filePath))) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }

        const entry: CacheEntry = {
            cacheKey: key,
            agentId: this.agentId,
            modelId,
            schemaVersion: this.schemaVersion,
            timestamp: new Date().toISOString(),
            promptPreview: prompt.slice(0, 300) + (prompt.length > 300 ? '…' : ''),
            response,
        };

        // Append to file (JSONL format: one minified JSON object per line)
        // Note: Concurrent appends from Vitest workers might occasionally interleave if very large,
        // but compaction will eventually clean up malformed lines.
        fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
        
        // Update in-memory map
        this.cacheMap.set(key, entry);
    }

    /** Cache hit/miss statistics for the current run */
    get stats() {
        return { hits: this.hits, misses: this.misses, total: this.hits + this.misses };
    }
}

