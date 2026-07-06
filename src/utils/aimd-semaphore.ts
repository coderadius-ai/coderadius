/**
 * AIMDSemaphore — counting semaphore (Dijkstra 1965) governed by the
 * Additive-Increase / Multiplicative-Decrease policy (Chiu & Jain 1989,
 * the same congestion-control discipline TCP uses for `cwnd`).
 *
 * The semaphore exposes acquire/release primitives; the AIMD policy
 * mutates the active permit count (`currentLimit`) in response to
 * out-of-band signals from the caller: `recordSuccess()` after a
 * successful operation, `recordRateLimit(retryAfterMs?)` after a 429.
 *
 * Centralized: a single process-wide instance coordinates concurrency
 * across all LLM call sites (code pipeline, structural extraction, agents,
 * eval) — see `getDefaultAIMDSemaphore()`.
 *
 * Three architectural invariants enforced (see plan G1/G2/G3):
 *
 *   G1 — slot held only around the single HTTP call, NOT around retry
 *        loops. Implemented by `withCongestionControl` (sibling module),
 *        not here. The semaphore is deliberately agnostic to retry/backoff.
 *
 *   G2 — windowing: a single multiplicative decrease per congestion
 *        window. Multiple 429s arriving while in cooldown only extend
 *        `freezeUntil`; they do not compound the decrease.
 *
 *   G3 — bounded queue: `maxQueueSize` + `maxWaitMs` force upstream
 *        back-pressure instead of unbounded memory growth or timeout
 *        cascades.
 */

export interface AIMDSemaphoreOptions {
    initialLimit?: number;
    softMaxLimit?: number;
    hardMaxLimit?: number;
    minLimit?: number;
    successStreakForIncrease?: number;
    decreaseFactor?: number;
    cooldownMs?: number;
    honorRetryAfter?: boolean;
    /**
     * Ceiling on the freeze window an honored Retry-After can impose,
     * in milliseconds. Quota-exhaustion hints (hours) stay bounded here;
     * the retry loop handles them with a fail-fast instead.
     * @default 300_000 (5 minutes)
     */
    maxFreezeMs?: number;
    maxQueueSize?: number;
    maxWaitMs?: number;
}

export interface AIMDSemaphoreMetrics {
    currentLimit: number;
    inFlight: number;
    successCount: number;
    rateLimitCount: number;
    increasesCount: number;
    decreasesCount: number;
    totalAcquired: number;
    cooldownActive: boolean;
    queueLength: number;
    queueFullErrorsTotal: number;
    waitTimeoutsTotal: number;
}

export type LimitChangeReason =
    | 'success-streak'
    | 'rate-limit-429'
    | 'cooldown-end'
    | 'recovery'
    | 'manual-reset';

/** Fleet-wide consecutive 429 streak, consumed by the quota circuit breaker. */
export interface QuotaStreak {
    /** Consecutive recordRateLimit() calls with no recordSuccess() in between. */
    consecutive: number;
    /** Timestamp of the first 429 of the current streak (0 when no streak). */
    startedAt: number;
}

export interface LimitChangeEvent {
    from: number;
    to: number;
    reason: LimitChangeReason;
    metrics: AIMDSemaphoreMetrics;
    timestamp: number;
}

export class RateLimitQueueFullError extends Error {
    code = 'RATE_LIMIT_QUEUE_FULL' as const;
    constructor(public queueSize: number, public maxQueueSize: number) {
        super(`LLM rate-limit queue full (${queueSize}/${maxQueueSize}); upstream caller must back off`);
        this.name = 'RateLimitQueueFullError';
    }
}

export class RateLimitWaitTimeoutError extends Error {
    code = 'RATE_LIMIT_WAIT_TIMEOUT' as const;
    constructor(public waitedMs: number, public maxWaitMs: number) {
        super(`LLM rate-limit wait timeout (${waitedMs}ms ≥ ${maxWaitMs}ms)`);
        this.name = 'RateLimitWaitTimeoutError';
    }
}

interface QueueEntry {
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    enqueuedAt: number;
    timer?: ReturnType<typeof setTimeout>;
    settled: boolean;
    /** Cleanup of any AbortSignal listener attached on enqueue. */
    detachAbortListener?: () => void;
}

// Defaults are tuned for the CodeRadius CLI batch use-case: when the
// orchestrator dispatches thousands of LLM tasks in a single run (file ×
// chunk × function), there's no upstream retry budget — a `RateLimitQueueFullError`
// just lands in `metrics.errors` and the work is lost. Memory pressure is
// already bounded upstream by `FILE_CONCURRENCY` (default 100), so an
// effectively-unbounded queue is the safe default. Server-style fail-fast
// remains opt-in via `LLM_CONCURRENCY_MAX_QUEUE` env or a constructor override.
const DEFAULTS: Required<AIMDSemaphoreOptions> = {
    initialLimit: 4,
    softMaxLimit: 16,
    hardMaxLimit: 32,
    minLimit: 2,
    successStreakForIncrease: 5,
    decreaseFactor: 0.5,
    cooldownMs: 5_000,
    honorRetryAfter: true,
    maxFreezeMs: 300_000,
    maxQueueSize: Number.MAX_SAFE_INTEGER,
    maxWaitMs: 0, // disabled — waiters never time out; abort via signal instead
};

export class AIMDSemaphore {
    private opts: Required<AIMDSemaphoreOptions>;
    private currentLimit: number;
    private inFlight = 0;
    private queue: QueueEntry[] = [];
    private successesSinceLast = 0;
    private freezeUntil = 0;
    private successCount = 0;
    private rateLimitCount = 0;
    private increasesCount = 0;
    private decreasesCount = 0;
    private totalAcquired = 0;
    private queueFullErrorsTotal = 0;
    private waitTimeoutsTotal = 0;
    /** True after a congestion event until the first post-freeze success. */
    private recoveryPending = false;
    private consecutiveRateLimits = 0;
    private rateLimitStreakStartAt = 0;
    private lastQuotaProbeAt = 0;
    private listeners = new Set<(e: LimitChangeEvent) => void>();
    private cooldownEndTimer?: ReturnType<typeof setTimeout>;

    constructor(opts: AIMDSemaphoreOptions = {}) {
        const merged = { ...DEFAULTS, ...opts };
        merged.softMaxLimit = Math.min(merged.softMaxLimit, merged.hardMaxLimit);
        merged.minLimit = Math.max(1, Math.min(merged.minLimit, merged.initialLimit));
        merged.initialLimit = Math.min(
            Math.max(merged.initialLimit, merged.minLimit),
            merged.hardMaxLimit,
        );
        this.opts = merged;
        this.currentLimit = merged.initialLimit;
    }

    metrics(): AIMDSemaphoreMetrics {
        return {
            currentLimit: this.currentLimit,
            inFlight: this.inFlight,
            successCount: this.successCount,
            rateLimitCount: this.rateLimitCount,
            increasesCount: this.increasesCount,
            decreasesCount: this.decreasesCount,
            totalAcquired: this.totalAcquired,
            cooldownActive: Date.now() < this.freezeUntil,
            queueLength: this.queue.length,
            queueFullErrorsTotal: this.queueFullErrorsTotal,
            waitTimeoutsTotal: this.waitTimeoutsTotal,
        };
    }

    onLimitChange(handler: (e: LimitChangeEvent) => void): () => void {
        this.listeners.add(handler);
        return () => {
            this.listeners.delete(handler);
        };
    }

    /**
     * Acquire a permit. Optional `signal` lets the caller bail out of the
     * wait early on shutdown: if the signal aborts while the call is still
     * queued, the returned promise rejects with the signal's reason
     * (typically a `ShutdownAbortError`) and the entry is removed from the
     * queue without a zombie wakeup on later `release()`.
     */
    async acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new Error(`acquire aborted: ${String(signal.reason ?? 'aborted')}`);
        }
        if (this.queue.length >= this.opts.maxQueueSize) {
            this.queueFullErrorsTotal++;
            throw new RateLimitQueueFullError(this.queue.length, this.opts.maxQueueSize);
        }
        const now = Date.now();
        if (this.inFlight < this.currentLimit && now >= this.freezeUntil) {
            return this.grantSlot();
        }
        return new Promise<() => void>((resolve, reject) => {
            const entry: QueueEntry = {
                resolve,
                reject,
                enqueuedAt: now,
                settled: false,
            };
            if (this.opts.maxWaitMs > 0 && Number.isFinite(this.opts.maxWaitMs)) {
                entry.timer = setTimeout(() => {
                    if (entry.settled) return;
                    entry.settled = true;
                    entry.detachAbortListener?.();
                    const idx = this.queue.indexOf(entry);
                    if (idx >= 0) this.queue.splice(idx, 1);
                    this.waitTimeoutsTotal++;
                    reject(new RateLimitWaitTimeoutError(this.opts.maxWaitMs, this.opts.maxWaitMs));
                }, this.opts.maxWaitMs);
            }
            if (signal) {
                const onAbort = () => {
                    if (entry.settled) return;
                    entry.settled = true;
                    if (entry.timer) clearTimeout(entry.timer);
                    const idx = this.queue.indexOf(entry);
                    if (idx >= 0) this.queue.splice(idx, 1);
                    const reason = signal.reason instanceof Error
                        ? signal.reason
                        : new Error(`acquire aborted: ${String(signal.reason ?? 'aborted')}`);
                    reject(reason);
                };
                signal.addEventListener('abort', onAbort, { once: true });
                entry.detachAbortListener = () => signal.removeEventListener('abort', onAbort);
            }
            this.queue.push(entry);
        });
    }

    recordSuccess(): void {
        this.successCount++;
        // Any success proves the quota works: the breaker streak resets even
        // when the success lands during a freeze (pre-freeze call finishing).
        this.consecutiveRateLimits = 0;
        if (Date.now() < this.freezeUntil) return;

        // Half-open recovery: the first post-freeze success restores the
        // limit to initialLimit in one jump. The +1-per-streak crawl from
        // minLimit is too slow to exploit a recovered per-minute quota
        // (2 → 7 would need 25 consecutive successes).
        if (this.recoveryPending) {
            this.recoveryPending = false;
            const from = this.currentLimit;
            const to = Math.max(from, Math.min(this.opts.initialLimit, this.opts.hardMaxLimit));
            if (to !== from) {
                this.currentLimit = to;
                this.emit({ from, to, reason: 'recovery' });
                this.drainQueue();
            }
            return;
        }

        this.successesSinceLast++;
        if (
            this.successesSinceLast >= this.opts.successStreakForIncrease &&
            this.currentLimit < this.opts.softMaxLimit
        ) {
            const from = this.currentLimit;
            const to = Math.min(from + 1, this.opts.softMaxLimit, this.opts.hardMaxLimit);
            if (to !== from) {
                this.currentLimit = to;
                this.successesSinceLast = 0;
                this.increasesCount++;
                this.emit({ from, to, reason: 'success-streak' });
                this.drainQueue();
            }
        }
    }

    recordRateLimit(retryAfterMs?: number): void {
        this.rateLimitCount++;
        const now = Date.now();
        if (this.consecutiveRateLimits === 0) this.rateLimitStreakStartAt = now;
        this.consecutiveRateLimits++;

        // G2: same congestion window — count the 429 but do NOT extend the
        // freeze. acquire() is blocked while frozen, so any 429 landing here
        // comes from a call that started BEFORE the window opened: stale
        // evidence. Extending on it creates a sliding gate that never opens
        // (convoy starvation observed in production). Fresh evidence re-closes
        // the gate anyway: the first post-freeze 429 starts a new window.
        if (now < this.freezeUntil) return;

        // Honored Retry-After is clamped to maxFreezeMs: a quota-exhaustion
        // hint (hours) must not freeze the congestion window for hours. The
        // retry loop fails fast on those separately (QuotaExhaustedError in
        // congestion-control); the limiter just stays bounded.
        const requestedFreeze = this.opts.honorRetryAfter && retryAfterMs && retryAfterMs > 0
            ? Math.min(this.opts.maxFreezeMs, Math.max(this.opts.cooldownMs, retryAfterMs))
            : this.opts.cooldownMs;

        // New congestion event — apply AIMD decrease once.
        this.successesSinceLast = 0;
        this.recoveryPending = true;
        const from = this.currentLimit;
        const to = Math.max(this.opts.minLimit, Math.floor(from * this.opts.decreaseFactor));
        if (to !== from) {
            this.currentLimit = to;
            this.decreasesCount++;
            this.emit({ from, to, reason: 'rate-limit-429' });
        }
        this.freezeUntil = now + requestedFreeze;
        this.scheduleCooldownEnd(requestedFreeze);
    }

    /** Current fleet-wide consecutive-429 streak (see `QuotaStreak`). */
    quotaStreak(): QuotaStreak {
        return {
            consecutive: this.consecutiveRateLimits,
            startedAt: this.consecutiveRateLimits > 0 ? this.rateLimitStreakStartAt : 0,
        };
    }

    /**
     * Claim the half-open probe slot: returns true at most once per
     * `intervalMs`. While the quota circuit is open, the caller that wins
     * the claim still executes its LLM call (probing whether the quota is
     * back); everyone else fails fast.
     */
    tryClaimQuotaProbe(intervalMs: number): boolean {
        const now = Date.now();
        if (now - this.lastQuotaProbeAt < intervalMs) return false;
        this.lastQuotaProbeAt = now;
        return true;
    }

    reset(): void {
        if (this.cooldownEndTimer) {
            clearTimeout(this.cooldownEndTimer);
            this.cooldownEndTimer = undefined;
        }
        // Reject any waiting acquires gracefully.
        for (const entry of this.queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.detachAbortListener?.();
            if (!entry.settled) {
                entry.settled = true;
                entry.reject(new Error('AIMDSemaphore reset'));
            }
        }
        this.queue = [];
        this.currentLimit = this.opts.initialLimit;
        this.inFlight = 0;
        this.successesSinceLast = 0;
        this.freezeUntil = 0;
        this.successCount = 0;
        this.rateLimitCount = 0;
        this.increasesCount = 0;
        this.decreasesCount = 0;
        this.totalAcquired = 0;
        this.queueFullErrorsTotal = 0;
        this.waitTimeoutsTotal = 0;
        this.recoveryPending = false;
        this.consecutiveRateLimits = 0;
        this.rateLimitStreakStartAt = 0;
        this.lastQuotaProbeAt = 0;
    }

    private grantSlot(): () => void {
        this.inFlight++;
        this.totalAcquired++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.inFlight--;
            this.drainQueue();
        };
    }

    private drainQueue(): void {
        while (
            this.queue.length > 0 &&
            this.inFlight < this.currentLimit &&
            Date.now() >= this.freezeUntil
        ) {
            const entry = this.queue.shift();
            if (!entry || entry.settled) continue;
            entry.settled = true;
            if (entry.timer) clearTimeout(entry.timer);
            entry.detachAbortListener?.();
            entry.resolve(this.grantSlot());
        }
    }

    private scheduleCooldownEnd(delayMs: number): void {
        if (this.cooldownEndTimer) clearTimeout(this.cooldownEndTimer);
        this.cooldownEndTimer = setTimeout(() => {
            this.cooldownEndTimer = undefined;
            this.emit({
                from: this.currentLimit,
                to: this.currentLimit,
                reason: 'cooldown-end',
            });
            this.drainQueue();
        }, delayMs);
    }

    private emit(partial: { from: number; to: number; reason: LimitChangeReason }): void {
        const event: LimitChangeEvent = {
            ...partial,
            metrics: this.metrics(),
            timestamp: Date.now(),
        };
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // Listener errors must not break the limiter.
            }
        }
    }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let defaultInstance: AIMDSemaphore | undefined;

export function getDefaultAIMDSemaphore(): AIMDSemaphore {
    if (!defaultInstance) {
        defaultInstance = new AIMDSemaphore(buildDefaultOptionsFromEnv());
    }
    return defaultInstance;
}

export function resetDefaultAIMDSemaphoreForTests(): void {
    defaultInstance = undefined;
}

function buildDefaultOptionsFromEnv(): AIMDSemaphoreOptions {
    const env = process.env;
    const opts: AIMDSemaphoreOptions = {};

    const initial = parsePositiveInt(env.LLM_CONCURRENCY_INITIAL);
    if (initial !== undefined) opts.initialLimit = initial;

    const softMax = parsePositiveInt(env.LLM_CONCURRENCY_MAX);
    if (softMax !== undefined) opts.softMaxLimit = softMax;

    const hardMax = parsePositiveInt(env.LLM_CONCURRENCY_HARD_MAX);
    if (hardMax !== undefined) opts.hardMaxLimit = hardMax;

    const minLimit = parsePositiveInt(env.LLM_CONCURRENCY_MIN);
    if (minLimit !== undefined) opts.minLimit = minLimit;

    const streak = parsePositiveInt(env.LLM_CONCURRENCY_SUCCESS_STREAK);
    if (streak !== undefined) opts.successStreakForIncrease = streak;

    const decrease = parseFraction(env.LLM_CONCURRENCY_DECREASE_FACTOR);
    if (decrease !== undefined) opts.decreaseFactor = decrease;

    const cooldown = parsePositiveInt(env.LLM_CONCURRENCY_COOLDOWN_MS);
    if (cooldown !== undefined) opts.cooldownMs = cooldown;

    const queue = parsePositiveInt(env.LLM_CONCURRENCY_MAX_QUEUE);
    if (queue !== undefined) opts.maxQueueSize = queue;

    const wait = parsePositiveInt(env.LLM_CONCURRENCY_MAX_WAIT_MS);
    if (wait !== undefined) opts.maxWaitMs = wait;

    // Legacy hard-cap: LLM_CONCURRENCY=N pins both soft/hard caps to N (no AIMD growth).
    const legacy = parsePositiveInt(env.LLM_CONCURRENCY);
    if (legacy !== undefined) {
        opts.softMaxLimit = legacy;
        opts.hardMaxLimit = legacy;
        if (opts.initialLimit === undefined || opts.initialLimit > legacy) {
            opts.initialLimit = legacy;
        }
    }

    return opts;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseFraction(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
}
