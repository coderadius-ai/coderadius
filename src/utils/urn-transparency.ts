/**
 * URN Transparency Mode (Phase 2 — base64url encoding)
 *
 * Default behaviour of CodeRadius is to hash physical-resource identifiers
 * into sha truncations. This produces stable, dedup-friendly URNs.
 *
 * The `--transparent-urns` CLI flag (or `CR_TRANSPARENT_URNS=1` env var) flips
 * the mode for resources that still opt into transparent fingerprints
 * (datastores / physical endpoints). MessageBroker identity is intentionally
 * excluded: broker URNs stay opaque/stable, while broker displayHost/displayVhost
 * fields carry plaintext debug labels.
 *
 * Decode contract: try-decode is NEVER silent. `parseTransparentIdentity()` is
 * only safe on a string that ACTUALLY came from `buildTransparentIdentity()`.
 * Callers must verify the input shape (presence of `~` separator, or explicit
 * context flag) before calling. See `parseBrokerUrn()` in `src/graph/urn.ts`.
 *
 * The mode is a process-global because the fingerprint helpers are called from
 * too many call sites to pass a context arg through. Setting it once at CLI
 * startup is the cheapest plumbing.
 */

import { Buffer } from 'node:buffer';

let _transparent: boolean | null = null;

function readEnvDefault(): boolean {
    const env = process.env.CR_TRANSPARENT_URNS;
    return env === '1' || env === 'true';
}

export function areUrnsTransparent(): boolean {
    if (_transparent === null) {
        _transparent = readEnvDefault();
    }
    return _transparent;
}

export function setUrnsTransparent(enabled: boolean): void {
    _transparent = enabled;
    process.env.CR_TRANSPARENT_URNS = enabled ? '1' : '0';
}

/** Test helper: reset state so each test starts from the env-driven default. */
export function resetUrnTransparencyForTesting(): void {
    _transparent = null;
    delete process.env.CR_TRANSPARENT_URNS;
}

// ─── Base64url encode/decode helpers ─────────────────────────────────────────
// Node 16+ has 'base64url' encoding natively. Bun 1.x is compatible. Fallback
// included inline (not just comment) so a runtime change does not silently
// break round-trip.

function toBase64Url(s: string): string {
    try {
        return Buffer.from(s, 'utf-8').toString('base64url');
    } catch {
        return Buffer.from(s, 'utf-8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
}

function fromBase64Url(s: string): string {
    try {
        return Buffer.from(s, 'base64url').toString('utf-8');
    } catch {
        // Padding restore is mandatory: some runtimes fail without '='.
        const standard = s.replace(/-/g, '+').replace(/_/g, '/');
        const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
        return Buffer.from(padded, 'base64').toString('utf-8');
    }
}

/**
 * Build a transparent identity string from positional parts. Each part is
 * base64url-encoded; parts are joined by `~` (separator NOT in base64url
 * charset, so split is unambiguous).
 *
 * **Empty positional parts preservati**: `[host, 5672, '']` → 3 encoded parts,
 * trailing empty preserved as empty base64url ('').
 *
 * Only `null` / `undefined` are filtered (= part absent). Empty string is
 * encoded as itself (= part present but empty).
 */
export function buildTransparentIdentity(parts: ReadonlyArray<string | number | null | undefined>): string {
    return parts
        .filter(p => p !== null && p !== undefined)
        .map(p => toBase64Url(String(p)))
        .join('~');
}

/**
 * Inverse of `buildTransparentIdentity()`. Split on `~`, decode each part.
 *
 * Caller MUST verify the input was produced by `buildTransparentIdentity()`
 * (check for `~` presence or carry context flag). Calling this on an opaque
 * sha-256 hex will "succeed" silently because hex is valid base64url charset,
 * but produce garbage bytes. See `parseBrokerUrn()` for the canonical guard.
 */
export function parseTransparentIdentity(encoded: string): string[] {
    return encoded.split('~').map(p => fromBase64Url(p));
}
