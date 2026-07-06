/**
 * Congestion control façade — combines `AIMDSemaphore` (sibling module)
 * with per-call 429 retry using exponential backoff + full jitter.
 *
 * The pattern is the inversion of the naive "outer pLimit, inner retry"
 * that suffers from slot dormiente: here the retry loop is OUTER, the
 * semaphore acquire/release is INNER (one cycle per attempt). Slots are
 * NEVER held across a backoff sleep:
 *
 *   for each attempt {
 *     release = await semaphore.acquire()    // INNER: per-attempt permit
 *     try {
 *       return await fn()                    // single HTTP call
 *     } catch (e) {
 *       release()                            // release BEFORE the sleep
 *       if (!isRateLimitError(e)) throw e
 *       semaphore.recordRateLimit(retryAfterMs)
 *       await sleep(backoff)                 // OUTER: retry loop
 *     } finally {
 *       release?.()                          // safe re-call
 *     }
 *   }
 *
 * Coordination during a congestion event happens via the semaphore's
 * `freezeUntil`, not via held permits. See `AIMDSemaphore` G2/G3.
 */

import { logger } from './logger.js';
import {
    AIMDSemaphore,
    getDefaultAIMDSemaphore,
    RateLimitQueueFullError,
    RateLimitWaitTimeoutError,
} from './aimd-semaphore.js';
import {
    ConnectionHealthTracker,
    getConnectionHealth,
} from './connection-health.js';
import {
    AdaptiveRateLimiter,
    getDefaultRateLimiter,
    type RateLimiterStats,
} from './rate-limiter.js';

// ─── Detection (canonical home) ──────────────────────────────────────────────

/**
 * Returns true if the error is a rate-limit / quota exhaustion response
 * (HTTP 429 or Vertex AI RESOURCE_EXHAUSTED).
 */
export function isRateLimitError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;

    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) return true;

    const msg = ((err as Error).message ?? '').toLowerCase();
    return (
        msg.includes('resource exhausted') ||
        msg.includes('rate limit') ||
        msg.includes('quota') ||
        msg.includes('too many requests') ||
        msg.includes('429')
    );
}

const CONNECTION_ERROR_CODES = new Set([
    // Node / undici syscall codes
    'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
    // Bun fetch error codes/names
    'ConnectionRefused', 'ConnectionClosed', 'FailedToOpenSocket',
]);

/**
 * Message fallback for SDK-wrapped errors that drop the syscall code: the
 * Vercel AI SDK flattens Bun's ConnectionRefused into an AI_APICallError
 * reading "Cannot connect to API: Was there a typo in the url or port?".
 */
const CONNECTION_ERROR_MESSAGE =
    /cannot connect|unable to connect|connection refused|connection reset|connection closed|connect timeout|fetch failed|socket hang up|getaddrinfo|network is (down|unreachable)|typo in the url/i;

/** Walk `err` and its `cause` chain (bounded) looking for a transport code. */
function hasConnectionErrorCode(err: object): boolean {
    let node: unknown = err;
    for (let depth = 0; depth < 5 && node && typeof node === 'object'; depth++) {
        const { code, name } = node as { code?: unknown; name?: unknown };
        if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
        if (typeof name === 'string' && CONNECTION_ERROR_CODES.has(name)) return true;
        node = (node as { cause?: unknown }).cause;
    }
    return false;
}

/**
 * Returns true if the error is a connection-level (transport) failure:
 * refused/reset socket, DNS resolution, unreachable host/network, connect
 * timeout. These are endpoint-global — an in-place retry or a per-call model
 * fallback against the same dead endpoint cannot succeed — so callers record
 * them on the domain's `ConnectionHealthTracker` and route the work to the
 * deferred-retry drain.
 *
 * Disjoint from `isRateLimitError` by construction: a 429 is the endpoint
 * working (and saying no), never a transport failure.
 */
export function isConnectionError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    if (isRateLimitError(err)) return false;
    if (hasConnectionErrorCode(err)) return true;
    return CONNECTION_ERROR_MESSAGE.test((err as Error).message ?? '');
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RateLimitRetryOpts {
    /** Total number of attempts (1 = no retry, 10 = 1 attempt + 9 retries). @default 10 */
    maxAttempts?: number;
    /** Base delay in milliseconds. Doubles on each attempt before jitter. @default 2000 */
    baseDelayMs?: number;
    /** Maximum delay cap in milliseconds (applied before jitter). @default 30_000 */
    capDelayMs?: number;
    /**
     * Hard ceiling on a provider-requested `Retry-After` we are willing to
     * honor, in milliseconds. Hints at or below the cap are honored verbatim
     * (they signal minute-window congestion); hints ABOVE it mean the token
     * quota itself is exhausted, and silently sleeping for hours would freeze
     * the whole pipeline with zero feedback (observed in production: 25+ min
     * of total idle, no sockets, no events). Such calls fail fast with
     * `QuotaExhaustedError` instead. @default 300_000 (5 minutes)
     */
    maxRetryAfterMs?: number;
    /** Optional callback invoked before each retry (useful for telemetry). */
    onRetry?: (attempt: number, maxAttempts: number, delayMs: number, err: Error) => void;
}

export interface QuotaBreakerOpts {
    /** Fleet-wide consecutive 429s (zero successes in between) before the breaker can open. */
    minConsecutive: number;
    /** Minimum elapsed time since the streak began before the breaker can open. */
    minStreakDurationMs: number;
    /** While open, one probe call per interval still executes; a success closes the breaker. */
    probeIntervalMs: number;
}

/**
 * Defaults sized on the production convoy incident: during a quota outage
 * the frozen limiter lets ~2-3 attempts/minute through, so 20 consecutive
 * failures over 8 minutes means the quota has been dead the whole time,
 * not a per-minute window burp. Vertex sends small Retry-After hints even
 * when the quota is exhausted, so the per-call `maxRetryAfterMs` fail-fast
 * never fires on its own.
 */
export const DEFAULT_QUOTA_BREAKER: QuotaBreakerOpts = {
    minConsecutive: 20,
    minStreakDurationMs: 480_000,
    probeIntervalMs: 60_000,
};

export interface ConnectionBreakerOpts {
    /** Fleet-wide consecutive connection failures (per quota domain) before the circuit opens. */
    minConsecutive: number;
    /** While open, one probe call per interval still executes; a success closes the circuit. */
    probeIntervalMs: number;
}

/**
 * Connection failures are unambiguous (the socket never opened), so the
 * threshold sits far below the quota breaker's: 5 in a row means the endpoint
 * or the network is down, not that five independent calls got unlucky. No
 * duration condition — a dead endpoint fails every attempt, so elapsed time
 * adds no signal, and a transient blip self-heals via the immediate first
 * probe (the probe clock re-arms on every success).
 */
export const DEFAULT_CONNECTION_BREAKER: ConnectionBreakerOpts = {
    minConsecutive: 5,
    probeIntervalMs: 30_000,
};

export interface CongestionControlOptions extends RateLimitRetryOpts {
    /**
     * Limiter to coordinate slots across all LLM calls. Defaults to the
     * process singleton (`getDefaultAIMDSemaphore()`). Pass `null` as an escape
     * hatch (e.g. tests) to retry without any limiter.
     */
    limiter?: AIMDSemaphore | null;
    /**
     * Optional shutdown signal. When aborted, in-flight backoff sleeps and
     * queued limiter waiters wake up immediately and reject with the signal's
     * abort reason (typically `ShutdownAbortError`). Without a signal, the
     * call retains its pre-shutdown semantics.
     */
    signal?: AbortSignal;
    /**
     * Run-level quota circuit breaker (requires a limiter, which carries the
     * fleet-wide streak). Defaults to `DEFAULT_QUOTA_BREAKER`; pass `false`
     * to disable.
     */
    quotaBreaker?: QuotaBreakerOpts | false;
    /**
     * Adaptive requests-per-minute limiter, consumed once PER ATTEMPT (retries
     * pay rate budget too → no request amplification). Defaults to the
     * per-domain singleton (`getDefaultRateLimiter(rateDomain)`). Pass `null`
     * to disable. Escape-hatch coupling: when `limiter` is explicitly `null`
     * and `rateLimiter` is unset, the rate limiter is OFF too (so `limiter:
     * null` keeps meaning "no limiting at all", e.g. in tests).
     */
    rateLimiter?: AdaptiveRateLimiter | null;
    /**
     * Quota domain key for the default rate limiter (provider/model/region).
     * Independent quotas get independent limiters. @default 'global'
     */
    rateDomain?: string;
    /**
     * Connection-level circuit breaker, tracked per quota domain (via
     * `rateDomain`). A dead endpoint or dead network must fail fast — not let
     * every queued call rediscover it through its own queue wait + timeout.
     * Defaults to `DEFAULT_CONNECTION_BREAKER`; pass `false` to disable.
     * Coupled to the `limiter: null` escape hatch like the rate limiter:
     * explicitly disabling the concurrency limiter with no explicit breaker
     * opts keeps meaning "no limiting at all".
     */
    connectionBreaker?: ConnectionBreakerOpts | false;
}

export class MaxRetriesExceededError extends Error {
    code = 'MAX_RETRIES_EXCEEDED' as const;
    constructor(public attempts: number, public override cause?: Error) {
        super(`LLM call failed after ${attempts} 429 retries`);
        this.name = 'MaxRetriesExceededError';
    }
}

/**
 * The provider asked us to wait longer than `maxRetryAfterMs`: the token
 * quota is exhausted, not the minute window. Subclasses
 * `MaxRetriesExceededError` ON PURPOSE: every call site that routes terminal
 * 429 failures (semantic-extractor `deferred` outcomes, batch drain) keeps
 * working unchanged, while the message tells the operator what actually
 * happened and when to resume.
 */
export class QuotaExhaustedError extends MaxRetriesExceededError {
    constructor(
        public retryAfterMs: number,
        public retryAfterCapMs: number,
        attempt: number,
        cause?: Error,
    ) {
        super(attempt, cause);
        this.name = 'QuotaExhaustedError';
        this.message =
            `Provider requested a Retry-After of ${Math.round(retryAfterMs / 1000)}s `
            + `(cap: ${Math.round(retryAfterCapMs / 1000)}s): token quota likely exhausted. `
            + `Re-run the analysis once the provider quota window resets.`;
    }
}

/**
 * The run-level quota circuit is open: every recent LLM call across the
 * whole process has been rate-limited for minutes. Failing fast here turns
 * a multi-hour silent crawl into a quick, clearly-attributed failure.
 * Subclasses `MaxRetriesExceededError` so terminal-429 routing (deferred
 * drain, INCOMPLETE file marking) keeps working unchanged.
 */
export class QuotaCircuitOpenError extends MaxRetriesExceededError {
    constructor(
        public consecutive: number,
        public streakDurationMs: number,
        cause?: Error,
    ) {
        super(0, cause);
        this.name = 'QuotaCircuitOpenError';
        this.message =
            `Provider quota circuit open: ${consecutive} consecutive rate-limit failures `
            + `over ${Math.round(streakDurationMs / 60_000)}m with zero successes. `
            + `Failing fast (one probe per minute keeps checking); `
            + `re-run the analysis once the provider quota recovers.`;
    }
}

/**
 * Dead-quota signal from the adaptive RATE limiter: the rate has been pinned
 * at its floor with a high 429 ratio for minutes — the quota is exhausted for
 * the window even though SPORADIC successes kept the consecutive-streak
 * breaker from opening (the precise gap that breaker misses). Subclasses
 * `MaxRetriesExceededError` so terminal-429 routing keeps working unchanged.
 */
export class QuotaFloorStuckError extends MaxRetriesExceededError {
    constructor(public stats: RateLimiterStats, cause?: Error) {
        super(0, cause);
        this.name = 'QuotaFloorStuckError';
        this.message =
            `Provider rate pinned at the floor (${stats.rpm} req/min) with sustained 429s. `
            + `The per-minute quota is exhausted; failing fast instead of crawling. `
            + `Re-run the analysis once the provider quota recovers.`;
    }
}

/**
 * The connection circuit for a quota domain is open: every recent call could
 * not even open a socket to the endpoint. Failing fast turns a multi-hour
 * silent crawl (each queued call burning its own queue wait + timeout against
 * a dead endpoint) into a quick, clearly-attributed failure. Subclasses
 * `MaxRetriesExceededError` so terminal-failure routing (deferred drain,
 * INCOMPLETE file marking) keeps working unchanged.
 */
export class EndpointUnreachableError extends MaxRetriesExceededError {
    constructor(
        public domain: string,
        public consecutive: number,
        public streakDurationMs: number,
        cause?: Error,
    ) {
        super(0, cause);
        this.name = 'EndpointUnreachableError';
        // Wording constraint: must not contain isRateLimitError's keywords
        // ("quota", "rate limit", "429", ...) or the retry loop would
        // misclassify this error as throttling and back off instead of
        // failing fast.
        this.message =
            `Endpoint unreachable for '${domain}': ${consecutive} consecutive connection failures `
            + `over ${Math.round(streakDurationMs / 1000)}s — the provider endpoint or the local network `
            + `is down, not provider throttling. Failing fast (one probe per interval keeps checking); `
            + `check connectivity (VPN, Wi-Fi, proxy) and re-run if functions were left incomplete.`;
    }
}

/**
 * Run an LLM call with adaptive concurrency + 429 retry.
 *
 * Errors propagate as-is:
 *   - RateLimitQueueFullError / RateLimitWaitTimeoutError → fail-fast,
 *     no retry, signaling upstream to back off (G3).
 *   - Non-429 errors → re-thrown immediately, no retry.
 *   - 429 errors → retried with backoff + jitter; limiter is notified for
 *     AIMD coordination.
 */
export async function withCongestionControl<T>(
    fn: () => Promise<T>,
    opts: CongestionControlOptions = {},
): Promise<T> {
    const limiter = opts.limiter === undefined ? getDefaultAIMDSemaphore() : opts.limiter;
    // Rate limiter resolution: explicit wins; else default singleton UNLESS
    // the concurrency limiter was explicitly disabled (`limiter: null`), in
    // which case "no limiting at all" must still hold.
    const rateLimiter = opts.rateLimiter !== undefined
        ? opts.rateLimiter
        : (opts.limiter === null ? null : getDefaultRateLimiter(opts.rateDomain));
    const maxAttempts = opts.maxAttempts ?? 10;
    const baseDelayMs = opts.baseDelayMs ?? 2_000;
    const capDelayMs = opts.capDelayMs ?? 30_000;
    const maxRetryAfterMs = opts.maxRetryAfterMs ?? 300_000;
    const signal = opts.signal;
    const breaker = opts.quotaBreaker === undefined ? DEFAULT_QUOTA_BREAKER : opts.quotaBreaker;
    // Same escape-hatch coupling as the rate limiter: `limiter: null` with no
    // explicit breaker opts keeps meaning "no limiting at all".
    const connBreaker = opts.connectionBreaker === undefined
        ? (opts.limiter === null ? false : DEFAULT_CONNECTION_BREAKER)
        : opts.connectionBreaker;
    const connHealth = connBreaker ? getConnectionHealth(opts.rateDomain) : null;

    let lastErr: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) throw asAbortError(signal);
        if (limiter && breaker) assertQuotaCircuit(limiter, breaker, lastErr);
        // Dead-endpoint fail-fast: when the domain's connection circuit is
        // open, fail BEFORE paying the rate-token and slot queue waits.
        if (connHealth && connBreaker) assertConnectionCircuit(connHealth, connBreaker, lastErr);
        // Dead-quota fail-fast on the RATE dimension: catches the case the
        // consecutive-streak breaker misses (sporadic successes reset it).
        if (rateLimiter?.shouldFailFast()) {
            throw new QuotaFloorStuckError(rateLimiter.stats(), lastErr);
        }

        // Rate token PER ATTEMPT, BEFORE acquiring a concurrency slot: the
        // rate wait must never hold a slot. Retries pay rate budget too, so a
        // 429 storm cannot amplify request volume against an exceeded quota.
        if (rateLimiter) await rateLimiter.take(signal);

        let release: (() => void) | undefined;
        try {
            // Acquire a slot per attempt. RateLimitQueueFull / WaitTimeout
            // and shutdown aborts propagate as-is — each signals the caller
            // must back off.
            release = limiter ? await limiter.acquire(signal) : undefined;
        } catch (err) {
            if (
                err instanceof RateLimitQueueFullError ||
                err instanceof RateLimitWaitTimeoutError
            ) {
                throw err;
            }
            throw err;
        }

        try {
            const result = await fn();
            limiter?.recordSuccess();
            rateLimiter?.recordSuccess();
            connHealth?.recordSuccess();
            return result;
        } catch (err) {
            // G1: release the slot SYNCHRONOUSLY before any sleep.
            release?.();
            release = undefined;

            const error = err as Error;
            // Transport failure: endpoint-global, not per-call. Record it on
            // the domain's circuit and rethrow — an in-place retry against an
            // endpoint that refuses the socket cannot succeed, and the rate
            // limiter must not be punished for a quota it never touched.
            if (isConnectionError(err)) {
                connHealth?.recordFailure();
                throw err;
            }
            if (!isRateLimitError(err)) {
                throw err;
            }

            lastErr = error;
            const retryAfterMs = extractRetryAfterMs(err);
            limiter?.recordRateLimit(retryAfterMs);
            rateLimiter?.recordRateLimit();

            // Quota fail-fast: a Retry-After beyond the cap means the token
            // quota is gone. Sleeping on it would freeze the pipeline silently
            // (the limiter clamps its own freeze; the sleep here would not).
            if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) {
                throw new QuotaExhaustedError(retryAfterMs, maxRetryAfterMs, attempt, error);
            }

            if (attempt >= maxAttempts) break;
            if (signal?.aborted) throw asAbortError(signal);

            const delayMs = computeBackoffDelayMs(attempt, baseDelayMs, capDelayMs, retryAfterMs);

            // Fire-and-forget: telemetry must never gate the retry hot path
            // and must not interact with fake timers in tests.
            void recordRateLimitRetryTelemetry();

            if (opts.onRetry) {
                opts.onRetry(attempt, maxAttempts, delayMs, error);
            } else {
                logger.warn(
                    `[RateLimit] 429 on attempt ${attempt}/${maxAttempts} — retrying in ${delayMs}ms...`,
                );
            }

            await cancelableSleep(delayMs, signal);
        } finally {
            // Idempotent release; harmless if already released above.
            release?.();
        }
    }

    throw new MaxRetriesExceededError(maxAttempts, lastErr);
}

/**
 * Throws `QuotaCircuitOpenError` when the fleet-wide 429 streak says the
 * provider quota is dead (count AND duration thresholds both met), unless
 * this caller wins the half-open probe slot: the probe still executes, and
 * its success closes the circuit via `recordSuccess` resetting the streak.
 */
function assertQuotaCircuit(
    limiter: AIMDSemaphore,
    breaker: QuotaBreakerOpts,
    lastErr: Error | undefined,
): void {
    const streak = limiter.quotaStreak();
    if (streak.consecutive < breaker.minConsecutive) return;
    const streakDurationMs = Date.now() - streak.startedAt;
    if (streakDurationMs < breaker.minStreakDurationMs) return;
    if (limiter.tryClaimQuotaProbe(breaker.probeIntervalMs)) return;
    throw new QuotaCircuitOpenError(streak.consecutive, streakDurationMs, lastErr);
}

/**
 * Throws `EndpointUnreachableError` when the domain's consecutive
 * connection-failure streak says the endpoint is dead, unless this caller
 * wins the half-open probe slot: the probe still executes, and its success
 * closes the circuit via `recordSuccess` resetting the streak.
 */
function assertConnectionCircuit(
    health: ConnectionHealthTracker,
    breaker: ConnectionBreakerOpts,
    lastErr: Error | undefined,
): void {
    const streak = health.streak();
    if (streak.consecutive < breaker.minConsecutive) return;
    if (health.tryClaimProbe(breaker.probeIntervalMs)) return;
    throw new EndpointUnreachableError(
        health.domain,
        streak.consecutive,
        Date.now() - streak.startedAt,
        lastErr,
    );
}

/**
 * Reify an aborted `AbortSignal` into a throwable Error. Prefers the
 * caller-supplied `signal.reason` if it is an Error (typically a
 * `ShutdownAbortError`); otherwise wraps the reason in a generic Error.
 */
function asAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(`aborted: ${String(signal.reason ?? 'aborted')}`);
}

// ─── Backoff ─────────────────────────────────────────────────────────────────

/**
 * Floor + full-jitter backoff. Honors Retry-After if present and
 * longer than the natural backoff.
 *
 * The exponent is clamped at 30 (2^30 ≈ 1.07e9 ms ≈ 12 days) before
 * `Math.pow` to avoid floating-point weirdness on absurdly high
 * `maxAttempts`. `Math.min(capDelayMs, …)` already caps the result, but
 * clamping the input keeps the math well-defined even if `capDelayMs` is
 * `Number.MAX_SAFE_INTEGER` or similar.
 */
const BACKOFF_EXPONENT_CAP = 30;

function computeBackoffDelayMs(
    attempt: number,
    baseDelayMs: number,
    capDelayMs: number,
    retryAfterMs: number | undefined,
): number {
    const FLOOR_MS = 1_000;
    const safeAttempt = Math.min(Math.max(attempt, 1), BACKOFF_EXPONENT_CAP);
    const window = Math.min(capDelayMs, baseDelayMs * Math.pow(2, safeAttempt - 1));
    const jitterSpace = Math.max(0, window - FLOOR_MS);
    const natural = FLOOR_MS + Math.floor(Math.random() * jitterSpace);
    if (retryAfterMs && retryAfterMs > natural) return retryAfterMs;
    return natural;
}

/**
 * Sleep that wakes up immediately if `signal` aborts. The returned promise
 * rejects with `signal.reason` (or a generic Error) instead of resolving
 * naturally after `ms`.
 */
function cancelableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(asAbortError(signal));
            return;
        }
        const timer = setTimeout(() => {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = signal
            ? () => {
                clearTimeout(timer);
                reject(asAbortError(signal));
            }
            : undefined;
        if (signal && onAbort) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

async function recordRateLimitRetryTelemetry(): Promise<void> {
    try {
        const { telemetryCollector } = await import('../telemetry/index.js');
        telemetryCollector.incrementRateLimitRetries();
    } catch {
        // Telemetry must never affect retry behavior.
    }
}

// ─── Retry-After extraction ──────────────────────────────────────────────────

/**
 * Extract a Retry-After hint from an error in milliseconds, if available.
 * Supports the most common shapes:
 *
 *   - Vercel AI SDK: `err.responseHeaders['retry-after']` (seconds) or
 *     `err.responseHeaders['retry-after-ms']`.
 *   - Vertex / Google APIs: `err.details[*].retryDelay = "4s"`.
 *
 * Returns undefined if no usable hint is found.
 */
export function extractRetryAfterMs(err: unknown): number | undefined {
    if (!err || typeof err !== 'object') return undefined;

    const headers = (err as { responseHeaders?: Record<string, string> }).responseHeaders;
    if (headers) {
        const ms = headers['retry-after-ms'] ?? headers['Retry-After-Ms'];
        if (ms) {
            const parsed = parseInt(String(ms), 10);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        const sec = headers['retry-after'] ?? headers['Retry-After'];
        if (sec) {
            const parsed = parseInt(String(sec), 10);
            if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
        }
    }

    // Vertex AI / google.rpc.RetryInfo
    const details = (err as { details?: unknown[] }).details;
    if (Array.isArray(details)) {
        for (const d of details) {
            if (d && typeof d === 'object') {
                const retryDelay = (d as { retryDelay?: string }).retryDelay;
                if (retryDelay) {
                    const parsed = parseDurationToMs(retryDelay);
                    if (parsed !== undefined) return parsed;
                }
            }
        }
    }

    return undefined;
}

function parseDurationToMs(duration: string): number | undefined {
    // Accepts "4s", "1500ms", "2.5s"
    const match = duration.match(/^(\d+(?:\.\d+)?)(s|ms)$/);
    if (!match) return undefined;
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return match[2] === 's' ? Math.round(value * 1000) : Math.round(value);
}
