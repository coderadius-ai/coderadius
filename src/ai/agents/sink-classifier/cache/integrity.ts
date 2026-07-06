// ═══════════════════════════════════════════════════════════════════════════════
// Cache integrity — HMAC-SHA256 signing for CacheEntry payloads.
//
// Disabled by default (backward compat). Enable by setting:
//   SINK_CACHE_HMAC_KEY=<secret>
//
// When enabled, every saved entry carries a signature; lookups verify it
// before returning. Tampered entries are rejected and counted as integrity
// failures — the call falls through as a cache miss.
// ═══════════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import type { CacheEntry } from './types.js';

const HMAC_ENV = 'SINK_CACHE_HMAC_KEY';

export function isHmacEnabled(): boolean {
    return Boolean(process.env[HMAC_ENV]);
}

/**
 * Compute HMAC-SHA256 over the canonical payload fields. Excludes `signature`
 * itself so verification is symmetric.
 */
export function computeSignature(entry: Omit<CacheEntry, 'signature'>): string {
    const key = process.env[HMAC_ENV];
    if (!key) throw new Error(`${HMAC_ENV} is not set`);
    const payload = JSON.stringify({
        cacheKey: entry.cacheKey,
        name: entry.name,
        ecosystem: entry.ecosystem,
        schemaVersion: entry.schemaVersion,
        modelFingerprint: entry.modelFingerprint,
        classification: entry.classification,
        seenVersions: [...entry.seenVersions].sort(),
        timestamp: entry.timestamp,
    });
    return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * Sign an entry in place. No-op if HMAC is not configured.
 */
export function signEntry(entry: CacheEntry): CacheEntry {
    if (!isHmacEnabled()) return entry;
    const { signature: _ignored, ...rest } = entry;
    return { ...rest, signature: computeSignature(rest) };
}

/**
 * Verify an entry's signature.
 * Returns true if HMAC is disabled (no-op verification), or if the signature
 * is valid. Returns false on mismatch or if signature is missing while HMAC
 * is enabled.
 */
export function verifyEntry(entry: CacheEntry): boolean {
    if (!isHmacEnabled()) return true;
    if (!entry.signature) return false;
    try {
        const { signature, ...rest } = entry;
        const expected = computeSignature(rest);
        // Constant-time comparison to avoid timing attacks
        const a = Buffer.from(signature, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}
