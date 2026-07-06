// ═══════════════════════════════════════════════════════════════════════════════
// SinkCacheBackend — pluggable storage interface
//
// Implementations: file (local disk), http (shared remote), layered (composes).
// The cache is cross-repo and tenant-scoped: classifying `axios` once on any
// machine should benefit every repo and every developer of the same tenant.
// ═══════════════════════════════════════════════════════════════════════════════

import type { ClassifiedPackage } from '../schema.js';
import { SINK_CLASSIFIER_SCHEMA_VERSION } from '../schema.js';

export interface CacheEntry {
    cacheKey: string;
    name: string;
    ecosystem: string;
    schemaVersion: string;
    /** SHA1 digest of the LLM model identity (provider+model). */
    modelFingerprint: string;
    classification: ClassifiedPackage;
    /** Major versions for which we've recorded the package. Informational only. */
    seenVersions: string[];
    /** ISO 8601 timestamp of the last write. */
    timestamp: string;
    /** Optional HMAC-SHA256 signature when SINK_CACHE_HMAC_KEY is set. */
    signature?: string;
}

export interface BackendHealth {
    ok: boolean;
    latencyMs: number;
    error?: string;
}

export interface SinkCacheBackend {
    readonly id: string;
    lookup(key: string): Promise<CacheEntry | null>;
    save(key: string, entry: CacheEntry): Promise<void>;
    listKeys(prefix?: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    healthCheck(): Promise<BackendHealth>;
}

/**
 * Compute the cache key for a package.
 *
 * Inputs intentionally exclude `lockedVersion` — the nature of `axios` does
 * NOT change across patch/minor bumps. Major bumps trigger re-classification
 * via the seenVersions tracker (see classifier logic), not via the cache key.
 */
export function computeCacheKey(
    name: string,
    ecosystem: string,
    modelFingerprint: string,
): string {
    // Inline import to keep this module sync-only and easy to consume.
    const crypto = require('node:crypto');
    return crypto
        .createHash('sha256')
        .update(`${name}|${ecosystem}|${modelFingerprint}|${SINK_CLASSIFIER_SCHEMA_VERSION}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * Compute a stable model fingerprint from provider+model identity.
 *
 * A change in fingerprint forces re-classification — guards against silent
 * drift when the underlying model is upgraded.
 */
export function computeModelFingerprint(provider: string, model: string): string {
    const crypto = require('node:crypto');
    return crypto.createHash('sha1').update(`${provider}|${model}`).digest('hex').slice(0, 12);
}
