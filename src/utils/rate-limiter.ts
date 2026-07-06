/**
 * AdaptiveRateLimiter — a token bucket whose refill RATE (requests/minute) is
 * itself governed by slow-start → AIMD, the same congestion discipline TCP
 * uses, but applied to the dimension that actually maps to provider quota:
 * requests-per-minute, NOT in-flight concurrency.
 *
 * Why a second limiter next to `AIMDSemaphore`:
 *   - `AIMDSemaphore` caps CONCURRENCY (in-flight count). Under a per-minute
 *     quota, low concurrency with fast calls still exceeds the rate → 429s.
 *   - This limiter caps the REQUEST RATE and auto-discovers the sustainable
 *     value (the quota is not known a priori): slow-start probes upward
 *     (×2 per success window) until the first 429, then switches to
 *     congestion avoidance (×decreaseFactor on 429, +increaseStepRpm on a
 *     success streak). The classic sawtooth converges just under the quota.
 *
 * Invariants mirrored from `AIMDSemaphore`:
 *   - One multiplicative decrease per cooldown window (`freezeUntil`); 429
 *     stragglers landing inside the window are ignored, so a burst of 429s
 *     can't crater the rate in one shot.
 *   - Slots/tokens never held across sleeps: `take()` resolves a single
 *     token; the caller (congestion-control) consumes one PER ATTEMPT, so
 *     retries also pay rate budget (no request amplification).
 *
 * Rolling-window dead-quota breaker: `shouldFailFast()` reports when the rate
 * has been pinned at the floor with a high 429 ratio for long enough — a
 * signal the consecutive-streak breaker misses because sporadic successes
 * reset it.
 *
 * Quota domains: provider/model/region have independent quotas, so callers
 * key separate limiters via `getDefaultRateLimiter(domainKey)`; a Gemini 429
 * must not throttle an OpenAI fallback.
 */

export interface RateLimiterOptions {
    /** Starting rate (req/min); slow-start ramps up from here. */
    initialRpm?: number;
    /** Floor the rate can never drop below. */
    minRpm?: number;
    /** Ceiling (hard cap). When the quota is known, set this to it. */
    maxRpm?: number;
    /** Multiplicative decrease factor applied on a 429. @default 0.5 */
    decreaseFactor?: number;
    /** Additive rate increase (req/min) per success streak in avoidance. @default 12 */
    increaseStepRpm?: number;
    /** Successes required before one increase step. @default 10 */
    successStreak?: number;
    /** One decrease per this cooldown window (ms); stragglers ignored. @default 5000 */
    cooldownMs?: number;
    /** Bucket capacity = max(1, ceil(rpm * burstSeconds / 60)). @default 5 */
    burstSeconds?: number;
    /** Rolling outcome window (ms) for the dead-quota breaker. @default 120_000 */
    windowMs?: number;
    /** Min time pinned at the floor before fail-fast can trip. @default 300_000 */
    failFastFloorMs?: number;
    /** Min 429 ratio over the window for fail-fast. @default 0.8 */
    failFastRatio?: number;
    /** Min outcomes in the window before the ratio is trusted. @default 5 */
    failFastMinSamples?: number;
    /** When true the limiter is a transparent no-op. */
    disabled?: boolean;
}

export interface RateChangeEvent {
    from: number;
    to: number;
    reason: 'slow-start' | 'decrease' | 'increase';
}

export interface RateLimiterStats {
    rpm: number;
    burst: number;
    available: number;
    queued: number;
    phase: 'slow-start' | 'avoidance';
    decreases: number;
    increases: number;
    disabled: boolean;
}

const DEFAULTS: Required<RateLimiterOptions> = {
    initialRpm: 60,
    minRpm: 6,
    maxRpm: 6_000,
    decreaseFactor: 0.5,
    increaseStepRpm: 12,
    successStreak: 10,
    cooldownMs: 5_000,
    burstSeconds: 5,
    windowMs: 120_000,
    failFastFloorMs: 300_000,
    failFastRatio: 0.8,
    failFastMinSamples: 5,
    disabled: false,
};

interface Waiter {
    resolve: () => void;
    reject: (err: Error) => void;
    settled: boolean;
    detachAbortListener?: () => void;
}

export class AdaptiveRateLimiter {
    private readonly opts: Required<RateLimiterOptions>;
    private rpm: number;
    private phase: 'slow-start' | 'avoidance' = 'slow-start';
    private available: number;
    private burst: number;
    private lastRefill = Date.now();
    private queue: Waiter[] = [];
    private drainTimer?: ReturnType<typeof setTimeout>;
    private freezeUntil = 0;
    private successesSinceIncrease = 0;
    private floorSince = 0;
    /** Rolling outcome timestamps (ms), pruned lazily to `windowMs`. */
    private rateLimitEvents: number[] = [];
    private successEvents: number[] = [];
    private decreases = 0;
    private increases = 0;
    private listeners = new Set<(e: RateChangeEvent) => void>();

    constructor(opts: RateLimiterOptions = {}) {
        const merged = { ...DEFAULTS, ...opts };
        merged.minRpm = Math.max(1, merged.minRpm);
        merged.maxRpm = Math.max(merged.minRpm, merged.maxRpm);
        merged.initialRpm = Math.min(Math.max(merged.initialRpm, merged.minRpm), merged.maxRpm);
        this.opts = merged;
        this.rpm = merged.initialRpm;
        this.burst = computeBurst(this.rpm, merged.burstSeconds);
        this.available = this.burst;
    }

    onRateChange(listener: (e: RateChangeEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Acquire one rate token; resolves immediately when one is available. */
    take(signal?: AbortSignal): Promise<void> {
        if (this.opts.disabled) return Promise.resolve();
        if (signal?.aborted) return Promise.reject(abortError(signal));

        this.refill();
        if (this.queue.length === 0 && this.available >= 1) {
            this.available -= 1;
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject, settled: false };
            if (signal) {
                const onAbort = () => {
                    if (waiter.settled) return;
                    waiter.settled = true;
                    const idx = this.queue.indexOf(waiter);
                    if (idx >= 0) this.queue.splice(idx, 1);
                    reject(abortError(signal));
                };
                signal.addEventListener('abort', onAbort, { once: true });
                waiter.detachAbortListener = () => signal.removeEventListener('abort', onAbort);
            }
            this.queue.push(waiter);
            this.scheduleDrain();
        });
    }

    /** 429 feedback: end slow-start; one multiplicative decrease per window. */
    recordRateLimit(): void {
        if (this.opts.disabled) return;
        const now = Date.now();
        this.record(this.rateLimitEvents, now);
        this.phase = 'avoidance';
        if (now < this.freezeUntil) return; // straggler inside the cooldown window
        this.freezeUntil = now + this.opts.cooldownMs;
        this.setRpm(Math.max(this.opts.minRpm, Math.floor(this.rpm * this.opts.decreaseFactor)), 'decrease');
    }

    /** Success feedback: slow-start doubles per window; avoidance adds a step. */
    recordSuccess(): void {
        if (this.opts.disabled) return;
        const now = Date.now();
        this.record(this.successEvents, now);
        this.successesSinceIncrease++;
        if (this.successesSinceIncrease < this.opts.successStreak) return;
        this.successesSinceIncrease = 0;

        if (this.phase === 'slow-start') {
            this.setRpm(Math.min(this.opts.maxRpm, this.rpm * 2), 'slow-start');
            return;
        }
        // Congestion avoidance: never increase while still in a decrease cooldown.
        if (now < this.freezeUntil) return;
        this.setRpm(Math.min(this.opts.maxRpm, this.rpm + this.opts.increaseStepRpm), 'increase');
    }

    /**
     * Dead-quota signal: the rate has been pinned at the floor with a high
     * 429 ratio for long enough. Independent of the consecutive-streak
     * breaker (which sporadic successes reset).
     */
    shouldFailFast(): boolean {
        if (this.opts.disabled) return false;
        const now = Date.now();
        this.prune(now);
        if (this.rpm > this.opts.minRpm || this.floorSince === 0) return false;
        if (now - this.floorSince < this.opts.failFastFloorMs) return false;
        const rl = this.rateLimitEvents.length;
        const total = rl + this.successEvents.length;
        if (total < this.opts.failFastMinSamples) return false;
        return rl / total >= this.opts.failFastRatio;
    }

    stats(): RateLimiterStats {
        this.refill();
        return {
            rpm: this.rpm,
            burst: this.burst,
            available: this.available,
            queued: this.queue.length,
            phase: this.phase,
            decreases: this.decreases,
            increases: this.increases,
            disabled: this.opts.disabled,
        };
    }

    // ── internals ────────────────────────────────────────────────────────────

    private setRpm(next: number, reason: RateChangeEvent['reason']): void {
        const from = this.rpm;
        const to = Math.min(this.opts.maxRpm, Math.max(this.opts.minRpm, next));
        if (reason === 'decrease') this.decreases++;
        if (reason === 'increase' || reason === 'slow-start') this.increases++;
        // Track floor entry/exit for the dead-quota breaker.
        if (to <= this.opts.minRpm) {
            if (this.floorSince === 0) this.floorSince = Date.now();
        } else {
            this.floorSince = 0;
        }
        if (to === from) return;
        this.rpm = to;
        this.burst = computeBurst(to, this.opts.burstSeconds);
        if (this.available > this.burst) this.available = this.burst;
        this.emit({ from, to, reason });
        // A higher rate / bigger burst can free queued waiters sooner.
        this.scheduleDrain();
    }

    private refill(): void {
        const now = Date.now();
        const elapsedSec = (now - this.lastRefill) / 1000;
        if (elapsedSec <= 0) return;
        this.lastRefill = now;
        this.available = Math.min(this.burst, this.available + elapsedSec * (this.rpm / 60));
    }

    /** Drain as many FIFO waiters as there are tokens; reschedule otherwise. */
    private drain(): void {
        this.drainTimer = undefined;
        this.refill();
        while (this.queue.length > 0 && this.available >= 1) {
            const waiter = this.queue.shift()!;
            if (waiter.settled) continue;
            waiter.settled = true;
            waiter.detachAbortListener?.();
            this.available -= 1;
            waiter.resolve();
        }
        if (this.queue.length > 0) this.scheduleDrain();
    }

    private scheduleDrain(): void {
        if (this.drainTimer || this.queue.length === 0) return;
        const deficit = Math.max(0, 1 - this.available);
        const waitMs = deficit <= 0 ? 0 : Math.ceil((deficit * 60_000) / this.rpm);
        this.drainTimer = setTimeout(() => this.drain(), waitMs);
    }

    private record(bucket: number[], now: number): void {
        bucket.push(now);
        this.prune(now);
    }

    private prune(now: number): void {
        const cutoff = now - this.opts.windowMs;
        while (this.rateLimitEvents.length > 0 && this.rateLimitEvents[0] < cutoff) this.rateLimitEvents.shift();
        while (this.successEvents.length > 0 && this.successEvents[0] < cutoff) this.successEvents.shift();
    }

    private emit(e: RateChangeEvent): void {
        for (const listener of this.listeners) {
            try { listener(e); } catch { /* listener errors must not break the limiter */ }
        }
    }
}

function computeBurst(rpm: number, burstSeconds: number): number {
    // max(1, …) is load-bearing: at a low rpm (e.g. 6) the raw value rounds
    // below 1, which would make a >=1 token never fit → permanent deadlock.
    return Math.max(1, Math.ceil((rpm * burstSeconds) / 60));
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(`rate-limiter take aborted: ${String(signal.reason ?? 'aborted')}`);
}

// ─── Registry (per quota domain) ─────────────────────────────────────────────

const registry = new Map<string, AdaptiveRateLimiter>();

/**
 * Process-wide limiter for a quota domain (default `'global'`). Callers that
 * know the provider/model/region pass a stable key so independent quotas get
 * independent limiters.
 */
export function getDefaultRateLimiter(domainKey = 'global'): AdaptiveRateLimiter {
    let limiter = registry.get(domainKey);
    if (!limiter) {
        limiter = new AdaptiveRateLimiter(buildRateLimiterOptionsFromEnv());
        registry.set(domainKey, limiter);
    }
    return limiter;
}

export function resetDefaultRateLimitersForTests(): void {
    registry.clear();
}

/**
 * Env → options. `LLM_RATE_RPM` is the headline knob: a hard ceiling (slow
 * -start still ramps up to it, never past), or `0` to disable. Unset means
 * adaptive discovery with defaults. Disabled by default under vitest (unless
 * any `LLM_RATE_*` is explicitly set) so the existing suite is unaffected by
 * the global singleton.
 */
export function buildRateLimiterOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimiterOptions {
    const opts: RateLimiterOptions = {};
    let anyExplicit = false;

    const rpm = parseRpm(env.LLM_RATE_RPM);
    if (rpm !== undefined) {
        anyExplicit = true;
        if (rpm === 0) opts.disabled = true;
        else opts.maxRpm = rpm; // hard cap; initialRpm clamped to it in the ctor
    }

    const numeric: Array<[keyof RateLimiterOptions, string | undefined]> = [
        ['initialRpm', env.LLM_RATE_INITIAL],
        ['minRpm', env.LLM_RATE_MIN],
        ['maxRpm', env.LLM_RATE_MAX],
        ['increaseStepRpm', env.LLM_RATE_INCREASE_RPM],
        ['successStreak', env.LLM_RATE_SUCCESS_STREAK],
        ['cooldownMs', env.LLM_RATE_COOLDOWN_MS],
        ['burstSeconds', env.LLM_RATE_BURST_SECONDS],
    ];
    for (const [key, raw] of numeric) {
        const n = parsePositiveInt(raw);
        if (n !== undefined) { (opts as Record<string, number>)[key] = n; anyExplicit = true; }
    }

    const decrease = parseFraction(env.LLM_RATE_DECREASE_FACTOR);
    if (decrease !== undefined) { opts.decreaseFactor = decrease; anyExplicit = true; }

    if (env.VITEST && !anyExplicit) opts.disabled = true;
    return opts;
}

/** Distinguishes `0` (explicit disable) from unset — unlike `parsePositiveInt`. */
function parseRpm(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
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
