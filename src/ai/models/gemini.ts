import { createVertex } from "@ai-sdk/google-vertex";
import { createVertex as createVertexEdge } from "@ai-sdk/google-vertex/edge";
import { execSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { MastraModelConfig } from '@mastra/core/llm';
import { logger } from '../../utils/logger.js';

// ──────────────────────────────────────────────────────────────────────────────
// BUN WORKAROUND: google-auth-library hangs indefinitely under Bun ≥1.2.17
// because Bun's polyfill for Node's http/https modules drops stream-close
// callbacks during the OAuth2 token exchange.
//
// This workaround ONLY activates when ALL of these are true:
//   1. Runtime is Bun (IS_BUN === true)
//   2. No GOOGLE_APPLICATION_CREDENTIALS is configured (neither env var,
//      nor our config's credentialsFile / default ~/.coderadius/gcp-sa.json)
//
// When a service account JSON file IS configured, google-auth-library is
// used as-is — its SA flow (JWT signing + simple POST) may work on Bun.
//
// When no credentials file exists (typical local dev with `gcloud auth`),
// google-auth-library uses the ADC refresh_token flow which hangs on Bun.
// In that case, we acquire a Bearer token via `gcloud CLI` and inject it
// via the edge variant's express mode, bypassing google-auth-library.
//
// Remove this workaround when Bun fixes the underlying networking bug.
// Tracking: https://github.com/oven-sh/bun/issues (google-auth-library hang)
// ──────────────────────────────────────────────────────────────────────────────

const IS_BUN = typeof globalThis.Bun !== 'undefined';

/** Cached gcloud token + expiry */
let _cachedToken: { value: string; expiresAt: number } | null = null;
let loggedAdcWorkaround = false;

/**
 * Acquire a Google OAuth2 access token via `gcloud auth print-access-token`.
 *
 * Short in-process cache (4 min): gcloud keeps its OWN token cache and may
 * hand back a token that is minutes from expiry — a long in-process TTL
 * turned that into mid-ingestion 401 storms (field incident: run died at
 * 42% when a 50-min cache outlived the underlying token). gcloud re-mints
 * on expiry, so frequent re-asks are cheap (~100ms) and always converge.
 */
const TOKEN_CACHE_TTL_MS = 4 * 60 * 1000;

/** @internal Invalidate the cached token (called on 401 to force a re-mint). */
export function invalidateGcloudToken(): void {
    _cachedToken = null;
}

function acquireGcloudToken(): string | null {
    if (_cachedToken && Date.now() < _cachedToken.expiresAt) {
        return _cachedToken.value;
    }
    try {
        const token = execSync('gcloud auth print-access-token', {
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (!token || token.length < 20) return null;
        _cachedToken = { value: token, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS };
        logger.debug('[Vertex] Acquired access token via gcloud CLI (Bun workaround)');
        return token;
    } catch {
        return null;
    }
}

/**
 * @internal Bearer-auth fetch with single 401 retry.
 *
 * On 401 the upstream token is expired regardless of our cache: invalidate,
 * re-mint (gcloud refreshes an expired token), retry ONCE. Extracted for
 * unit-testing; the vertex client wires it with the real fetch + resolver.
 */
export async function fetchWithBearerRetry(
    url: RequestInfo | URL,
    init: RequestInit | undefined,
    resolveToken: () => string | null,
    invalidate: () => void,
    fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
    const send = (token: string) => {
        const headers = new Headers(init?.headers as HeadersInit);
        headers.delete('x-goog-api-key');
        headers.set('Authorization', `Bearer ${token}`);
        // Never hang on a dead socket: cap every request unless the caller
        // already provided its own AbortSignal (field incident: a run sat
        // idle 7h on one stuck request). Generous cap: legitimate slow calls
        // (deep variant, big chunks) must never be clipped — the cap exists
        // for DEAD connections, not slow ones.
        const signal = init?.signal ?? AbortSignal.timeout(240_000);
        return fetchImpl(url, { ...init, headers, signal });
    };
    // Timeouts are transient by nature (half-open sockets) but the upstream
    // retry layer treats non-429 as FATAL — so the wrapper retries the
    // timeout itself, once, on a fresh connection. A second timeout
    // propagates (real outage, let the pipeline decide).
    const sendWithTimeoutRetry = async (token: string) => {
        try {
            return await send(token);
        } catch (e) {
            if ((e as Error).name !== 'TimeoutError') throw e;
            logger.debug('[Vertex] request timed out — retrying once on a fresh connection');
            return send(token);
        }
    };
    const first = await sendWithTimeoutRetry(resolveToken() ?? '');
    if (first.status !== 401) return first;
    invalidate();
    const fresh = resolveToken();
    if (!fresh) return first;
    logger.debug('[Vertex] 401 from upstream — re-minted token and retrying once');
    return sendWithTimeoutRetry(fresh);
}

/**
 * Resolve Bearer token for Bun (no-credentials path).
 * Priority: GOOGLE_VERTEX_TOKEN env → gcloud CLI.
 */
function resolveBunToken(): string | null {
    if (process.env.GOOGLE_VERTEX_TOKEN) {
        logger.debug('[Vertex] Using pre-injected GOOGLE_VERTEX_TOKEN');
        return process.env.GOOGLE_VERTEX_TOKEN;
    }
    return acquireGcloudToken();
}

/** Build the regional Vertex AI base URL */
function buildBaseURL(project: string, location: string): string {
    const baseHost = `${location === 'global' ? '' : location + '-'}aiplatform.googleapis.com`;
    return `https://${baseHost}/v1beta1/projects/${project}/locations/${location}/publishers/google`;
}

export const getVertexContext = (project: string, location: string) => {
    // ── Resolve GOOGLE_APPLICATION_CREDENTIALS path ──────────────────────
    // Note: the config bridge in src/config/index.ts already sets this env
    // var from providers.vertex.credentialsFile or ~/.coderadius/gcp-sa.json
    // BEFORE this function is called.
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        let creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (creds.startsWith('~/')) {
            creds = path.join(os.homedir(), creds.slice(2));
        } else if (!path.isAbsolute(creds)) {
            creds = path.resolve(process.cwd(), creds);
        }
        process.env.GOOGLE_APPLICATION_CREDENTIALS = creds;
        logger.debug(`[Vertex] Resolved GOOGLE_APPLICATION_CREDENTIALS to ${creds}`);
    } else {
        // Auto-detect gcloud default ADC
        const defaultAdcPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
        if (fs.existsSync(defaultAdcPath)) {
            // ADC is an authorized_user file, NOT a service account.
            // On Bun, the refresh_token flow in google-auth-library hangs.
            // We do NOT set GOOGLE_APPLICATION_CREDENTIALS here on Bun — let
            // the workaround below handle it via gcloud token instead.
            if (!IS_BUN) {
                process.env.GOOGLE_APPLICATION_CREDENTIALS = defaultAdcPath;
                logger.debug(`[Vertex] Auto-resolved GOOGLE_APPLICATION_CREDENTIALS to default ADC: ${defaultAdcPath}`);
            } else {
                if (!loggedAdcWorkaround) {
                    logger.debug(`[Vertex] Skipping default ADC on Bun (refresh_token flow hangs)`);
                }
            }
        }
    }

    if (!process.env.GCE_METADATA_TIMEOUT) {
        process.env.GCE_METADATA_TIMEOUT = '1500';
    }

    // ── Bun + no credentials file: apply workaround ──────────────────────
    // Only activates when there's no GOOGLE_APPLICATION_CREDENTIALS set.
    // If a service account file IS configured (via config or env), we let
    // google-auth-library handle it — its SA JWT flow may work on Bun.
    if (IS_BUN && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const token = resolveBunToken();
        if (token) {
            if (!loggedAdcWorkaround) {
                logger.debug('[Vertex] Using edge express mode with Bearer token (Bun workaround)');
                loggedAdcWorkaround = true;
            }
            return createVertexEdge({
                project,
                location,
                baseURL: buildBaseURL(project, location),
                apiKey: '__bun_workaround__', // triggers express mode, bypasses auth wrapper
                fetch: (async (url: RequestInfo | URL, init?: RequestInit) =>
                    fetchWithBearerRetry(url, init, resolveBunToken, invalidateGcloudToken, globalThis.fetch)
                ) as any,
            });
        }
        logger.warn('[Vertex] Running on Bun without credentials. google-auth-library may hang.');
        logger.warn('[Vertex] Set GOOGLE_VERTEX_TOKEN, configure a service account, or ensure `gcloud` is on PATH.');
    }

    // ── Standard path: google-auth-library handles auth ──────────────────
    // Used for: Node.js (always), Bun + service account file
    return createVertex({ project, location });
};

export const getGeminiModel = (modelName: string, project: string, location: string): MastraModelConfig => {
    const vertex = getVertexContext(project, location);
    return vertex(modelName);
};