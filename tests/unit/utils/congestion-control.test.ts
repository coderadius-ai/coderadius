import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AIMDSemaphore,
    RateLimitQueueFullError,
    RateLimitWaitTimeoutError,
    resetDefaultAIMDSemaphoreForTests,
} from '../../../src/utils/aimd-semaphore.js';
import {
    EndpointUnreachableError,
    extractRetryAfterMs,
    isConnectionError,
    MaxRetriesExceededError,
    QuotaCircuitOpenError,
    QuotaExhaustedError,
    QuotaFloorStuckError,
    withCongestionControl,
} from '../../../src/utils/congestion-control.js';
import { resetConnectionHealthForTests } from '../../../src/utils/connection-health.js';
import {
    AdaptiveRateLimiter,
    resetDefaultRateLimitersForTests,
} from '../../../src/utils/rate-limiter.js';
import { ShutdownAbortError } from '../../../src/utils/shutdown.js';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetDefaultAIMDSemaphoreForTests();
    resetDefaultRateLimitersForTests();
    resetConnectionHealthForTests();
});

/** Enabled rate limiter with an effectively-unbounded rate (never blocks take). */
function unboundedRateLimiter(): AdaptiveRateLimiter {
    return new AdaptiveRateLimiter({ initialRpm: 1_000_000, minRpm: 1_000_000, maxRpm: 1_000_000 });
}

/**
 * Flush the microtask queue, repeatedly, to surface promise resolutions
 * that pile up between fake-timer ticks. 20 cycles is empirically more
 * than enough for the deepest async chain in this suite (acquire → fn →
 * catch → release → recordRateLimit → schedule sleep).
 *
 * Maintenance note: this is a known testing quirk of `vi.useFakeTimers()`
 * combined with native promises. If Vitest changes how it integrates with
 * the Node microtask queue, these tests may become flaky and the cycle
 * count may need tuning.
 */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * The exact shape observed in production: the Vercel AI SDK flattens Bun's
 * ConnectionRefused into an AI_APICallError whose message carries no
 * syscall code, only prose.
 */
function makeConnectionError(
    msg = 'Cannot connect to API: Was there a typo in the url or port?',
): Error {
    const err = new Error(msg);
    err.name = 'AI_APICallError';
    return err;
}

function makeRateLimitError(retryAfterSeconds?: number): Error {
    const err = new Error('Rate limit exceeded') as Error & {
        statusCode?: number;
        responseHeaders?: Record<string, string>;
    };
    err.statusCode = 429;
    if (retryAfterSeconds !== undefined) {
        err.responseHeaders = { 'retry-after': String(retryAfterSeconds) };
    }
    return err;
}

describe('withCongestionControl — base behavior', () => {
    it('records success and resolves fn (#25)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const spy = vi.spyOn(limiter, 'recordSuccess');

        const result = await withCongestionControl(() => Promise.resolve('ok'), { limiter });

        expect(result).toBe('ok');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(limiter.metrics().inFlight).toBe(0);
    });

    it('on 429: records rate-limit, retries, eventually succeeds (#26)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            cooldownMs: 0,
            decreaseFactor: 0.5,
            minLimit: 2,
        });
        const rateLimitSpy = vi.spyOn(limiter, 'recordRateLimit');
        const successSpy = vi.spyOn(limiter, 'recordSuccess');

        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls < 3) throw makeRateLimitError();
            return 'ok';
        };

        const promise = withCongestionControl(fn, {
            limiter,
            maxAttempts: 5,
            baseDelayMs: 100,
        });
        // Two backoffs: floor 1000 + jitter; advance generously.
        await vi.advanceTimersByTimeAsync(2500);
        await vi.advanceTimersByTimeAsync(2500);
        const result = await promise;

        expect(result).toBe('ok');
        expect(calls).toBe(3);
        expect(rateLimitSpy).toHaveBeenCalledTimes(2);
        expect(successSpy).toHaveBeenCalledTimes(1);
    });

    it('non-429 error propagates without recording rate limit (#27)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const rateLimitSpy = vi.spyOn(limiter, 'recordRateLimit');

        await expect(
            withCongestionControl(() => {
                throw new TypeError('shape mismatch in caller');
            }, { limiter }),
        ).rejects.toThrow('shape mismatch');

        expect(rateLimitSpy).not.toHaveBeenCalled();
        expect(limiter.metrics().inFlight).toBe(0);
    });

    it('limiter:null disables the semaphore and retries 429s in isolation (escape hatch) (#28)', async () => {
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls < 2) throw makeRateLimitError();
            return 'ok';
        };

        const promise = withCongestionControl(fn, {
            limiter: null,
            maxAttempts: 3,
            baseDelayMs: 100,
        });
        await vi.advanceTimersByTimeAsync(2500);
        const result = await promise;

        expect(result).toBe('ok');
        expect(calls).toBe(2);
    });

    it('Retry-After header (5s) is forwarded to recordRateLimit (#29)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            cooldownMs: 1000,
        });
        const rateLimitSpy = vi.spyOn(limiter, 'recordRateLimit');

        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls < 2) throw makeRateLimitError(5);
            return 'ok';
        };

        const promise = withCongestionControl(fn, {
            limiter,
            maxAttempts: 3,
            baseDelayMs: 100,
        });
        // Retry-After is 5s, so the backoff sleep is 5000ms.
        await vi.advanceTimersByTimeAsync(5500);
        await promise;

        expect(rateLimitSpy).toHaveBeenCalledWith(5000);
    });
});

describe('withCongestionControl — Retry-After cap (quota fail-fast)', () => {
    it('Retry-After above the cap throws QuotaExhaustedError without sleeping (#44)', async () => {
        // A provider-requested wait of 1 hour means the token quota is gone,
        // not that the minute window is congested. Honoring it verbatim froze
        // a real run silently for 25+ minutes: every pending call slept on a
        // multi-hour timer with zero sockets open. Fail fast instead.
        let calls = 0;
        const fn = async () => {
            calls++;
            throw makeRateLimitError(3600);
        };

        const promise = withCongestionControl(fn, { limiter: null, maxAttempts: 5 });
        // No timer advancement: the rejection must be immediate.
        await expect(promise).rejects.toBeInstanceOf(QuotaExhaustedError);
        expect(calls).toBe(1);
    });

    it('QuotaExhaustedError routes like MaxRetriesExceededError (deferred drain pin) (#45)', async () => {
        const fn = async () => { throw makeRateLimitError(3600); };
        const err = await withCongestionControl(fn, { limiter: null }).catch(e => e);

        // The pipeline routes terminal 429 failures by this discriminator
        // (semantic-extractor → outcome 'deferred'). The quota error must
        // take the same path, with an explicit quota message on top.
        expect(err).toBeInstanceOf(MaxRetriesExceededError);
        expect(err.code).toBe('MAX_RETRIES_EXCEEDED');
        expect(err.message).toContain('3600s');
        expect(err.message.toLowerCase()).toContain('quota');
    });

    it('Retry-After below the cap is honored as the actual sleep (#46)', async () => {
        // 2 minutes is a legitimate minute-window hint: longer than
        // capDelayMs (30s) but below maxRetryAfterMs. It must be honored,
        // not clipped and not escalated to QuotaExhaustedError.
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls < 2) throw makeRateLimitError(120);
            return 'ok';
        };

        const promise = withCongestionControl(fn, { limiter: null, maxAttempts: 3 });
        await vi.advanceTimersByTimeAsync(119_000);
        expect(calls).toBe(1); // still sleeping
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(promise).resolves.toBe('ok');
    });

    it('custom maxRetryAfterMs overrides the default cap (#47)', async () => {
        const fn = async () => { throw makeRateLimitError(2); };

        await expect(
            withCongestionControl(fn, { limiter: null, maxRetryAfterMs: 1_000 }),
        ).rejects.toBeInstanceOf(QuotaExhaustedError);
    });
});

describe('withCongestionControl — G1 deadlock prevention', () => {
    it('slot is released BEFORE backoff sleep (#30)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 2,
            cooldownMs: 0,
            decreaseFactor: 1, // do not shrink, isolate G1 from G2 effect
            minLimit: 2,
        });

        // Two parallel callers; both fail once with 429, then succeed.
        const callsByCaller = new Map<number, number>();
        function makeFn(caller: number) {
            return async () => {
                const c = (callsByCaller.get(caller) ?? 0) + 1;
                callsByCaller.set(caller, c);
                if (c === 1) throw makeRateLimitError();
                return `ok-${caller}`;
            };
        }

        const p1 = withCongestionControl(makeFn(1), { limiter, maxAttempts: 3, baseDelayMs: 100 });
        const p2 = withCongestionControl(makeFn(2), { limiter, maxAttempts: 3, baseDelayMs: 100 });

        await flushMicrotasks();
        // Both have called fn once and now they're sleeping on backoff.
        expect(callsByCaller.get(1)).toBe(1);
        expect(callsByCaller.get(2)).toBe(1);
        // CRITICAL: during the sleep, slots must be released.
        expect(limiter.metrics().inFlight).toBe(0);

        await vi.advanceTimersByTimeAsync(2500);
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe('ok-1');
        expect(r2).toBe('ok-2');
    });

    it('a third caller can acquire while the first two are in retry sleep (#31)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 2,
            cooldownMs: 0,
            decreaseFactor: 1,
            minLimit: 2,
        });

        const order: string[] = [];
        async function failingThenOk(label: string) {
            return withCongestionControl(async () => {
                order.push(`call-${label}`);
                if (label === 'A' || label === 'B') {
                    if (order.filter(o => o === `call-${label}`).length === 1) {
                        throw makeRateLimitError();
                    }
                }
                return label;
            }, { limiter, maxAttempts: 3, baseDelayMs: 100 });
        }

        const pa = failingThenOk('A');
        const pb = failingThenOk('B');
        await flushMicrotasks();
        // A and B are now sleeping on backoff; slots released.
        expect(limiter.metrics().inFlight).toBe(0);

        // C jumps in immediately.
        const pc = withCongestionControl(async () => 'C', { limiter });
        const c = await pc;
        expect(c).toBe('C');

        await vi.advanceTimersByTimeAsync(2500);
        const [a, b] = await Promise.all([pa, pb]);
        expect(a).toBe('A');
        expect(b).toBe('B');
    });

    it('finally releases the slot on a non-429 exception (#32)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 1 });
        await expect(
            withCongestionControl(async () => {
                throw new Error('boom');
            }, { limiter }),
        ).rejects.toThrow('boom');
        expect(limiter.metrics().inFlight).toBe(0);
    });

    it('RateLimitQueueFullError propagates without recording rate-limit (#33)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 1,
            maxQueueSize: 1,
        });
        const rateLimitSpy = vi.spyOn(limiter, 'recordRateLimit');

        // Saturate slot + queue
        const r = await limiter.acquire();
        const queued = limiter.acquire();

        await expect(
            withCongestionControl(async () => 'never', { limiter }),
        ).rejects.toBeInstanceOf(RateLimitQueueFullError);
        expect(rateLimitSpy).not.toHaveBeenCalled();

        r();
        (await queued)();
    });

    it('RateLimitWaitTimeoutError during retry interrupts the retry loop (#34)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 1,
            maxQueueSize: 5,
            maxWaitMs: 50,
            cooldownMs: 0,
            decreaseFactor: 1,
            minLimit: 1,
        });

        // Hold the only slot from another, never-resolving caller.
        const blocker = limiter.acquire();

        const fnSpy = vi.fn(async () => 'never');

        const p = withCongestionControl(fnSpy, {
            limiter,
            maxAttempts: 5,
            baseDelayMs: 100,
        });

        const expectation = expect(p).rejects.toBeInstanceOf(RateLimitWaitTimeoutError);
        await vi.advanceTimersByTimeAsync(100);
        await expectation;

        // fn was never invoked because we never got a slot.
        expect(fnSpy).not.toHaveBeenCalled();
        (await blocker)();
    });
});

describe('withCongestionControl — backoff math safety (Math.pow clamping)', () => {
    it('absurdly high attempt counts do not produce NaN/Infinity delays (#43)', async () => {
        const onRetrySpy = vi.fn();
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls < 3) throw makeRateLimitError();
            return 'ok';
        };

        const promise = withCongestionControl(fn, {
            limiter: null,
            maxAttempts: 100, // way past the BACKOFF_EXPONENT_CAP
            baseDelayMs: 1_000,
            capDelayMs: 30_000,
            onRetry: onRetrySpy,
        });

        // Advance enough for 2 retries (~2x natural backoff plus margin).
        await vi.advanceTimersByTimeAsync(120_000);
        const result = await promise;

        expect(result).toBe('ok');
        // Each onRetry call must have a finite, positive delayMs.
        for (const call of onRetrySpy.mock.calls) {
            const delayMs = call[2] as number;
            expect(Number.isFinite(delayMs)).toBe(true);
            expect(delayMs).toBeGreaterThan(0);
            expect(delayMs).toBeLessThanOrEqual(30_000);
        }
    });
});

describe('MaxRetriesExceededError — discriminator pin', () => {
    it('carries both `code` field and instanceof identity (cross-module-safe)', () => {
        const err = new MaxRetriesExceededError(10, new Error('429'));
        // The orchestrator/semantic-extractor uses BOTH paths to detect this error,
        // so any rename or accidental code-field drop must trip this test.
        expect(err.code).toBe('MAX_RETRIES_EXCEEDED');
        expect(err).toBeInstanceOf(MaxRetriesExceededError);
        expect(err.name).toBe('MaxRetriesExceededError');
        expect(err.attempts).toBe(10);
    });
});

describe('extractRetryAfterMs', () => {
    it('returns undefined for non-rate-limit errors', () => {
        expect(extractRetryAfterMs(new Error('something'))).toBeUndefined();
        expect(extractRetryAfterMs({})).toBeUndefined();
        expect(extractRetryAfterMs(null)).toBeUndefined();
    });

    it('parses retry-after seconds header (Vercel AI SDK shape)', () => {
        const err = makeRateLimitError(7);
        expect(extractRetryAfterMs(err)).toBe(7000);
    });

    it('parses retry-after-ms header', () => {
        const err = new Error('429') as Error & { responseHeaders?: Record<string, string> };
        err.responseHeaders = { 'retry-after-ms': '2500' };
        expect(extractRetryAfterMs(err)).toBe(2500);
    });

    it('parses retryDelay from Vertex error body', () => {
        const err = new Error('RESOURCE_EXHAUSTED') as Error & { details?: unknown };
        err.details = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '4s' }];
        expect(extractRetryAfterMs(err)).toBe(4000);
    });
});

describe('withCongestionControl — shutdown signal propagation', () => {
    it('throws synchronously when signal is already aborted (#12)', async () => {
        const ctrl = new AbortController();
        ctrl.abort(new ShutdownAbortError('SIGINT'));
        const fnSpy = vi.fn(async () => 'never');

        await expect(
            withCongestionControl(fnSpy, { limiter: null, signal: ctrl.signal }),
        ).rejects.toBeInstanceOf(ShutdownAbortError);

        // fn was never invoked because the signal short-circuited the call.
        expect(fnSpy).not.toHaveBeenCalled();
    });

    it('aborting during the backoff sleep wakes up immediately with ShutdownAbortError (#13)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            cooldownMs: 0,
            decreaseFactor: 1,
            minLimit: 4,
        });
        const ctrl = new AbortController();
        let calls = 0;
        const fn = async () => {
            calls++;
            const err = new Error('Rate limit exceeded') as Error & { statusCode?: number };
            err.statusCode = 429;
            throw err;
        };

        const promise = withCongestionControl(fn, {
            limiter,
            signal: ctrl.signal,
            maxAttempts: 5,
            baseDelayMs: 100,
        });
        const expectation = expect(promise).rejects.toBeInstanceOf(ShutdownAbortError);

        // Allow first attempt to fail and enter the backoff sleep.
        await flushMicrotasks();
        expect(calls).toBe(1);

        // Abort while sleeping. The cancelable sleep must wake up at once,
        // NOT wait for the natural ~1000ms floor.
        ctrl.abort(new ShutdownAbortError('SIGINT'));
        await expectation;

        // No second attempt happened.
        expect(calls).toBe(1);
    });

    it('signal NOT triggered → success path retains normal behavior (#14)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            cooldownMs: 0,
            decreaseFactor: 1,
            minLimit: 4,
        });
        const ctrl = new AbortController();
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls < 2) {
                const err = new Error('Rate limit exceeded') as Error & { statusCode?: number };
                err.statusCode = 429;
                throw err;
            }
            return 'ok';
        };

        const promise = withCongestionControl(fn, {
            limiter,
            signal: ctrl.signal,
            maxAttempts: 3,
            baseDelayMs: 100,
        });
        await vi.advanceTimersByTimeAsync(2500);
        const result = await promise;

        expect(result).toBe('ok');
        expect(calls).toBe(2);
        expect(ctrl.signal.aborted).toBe(false);
    });

    it('GREEN-guard: omitting signal preserves prior semantics (#15)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4, cooldownMs: 0 });
        const result = await withCongestionControl(() => Promise.resolve('ok'), { limiter });
        expect(result).toBe('ok');
    });
});

describe('withCongestionControl — quota circuit breaker', () => {
    const breaker = { minConsecutive: 3, minStreakDurationMs: 1_000, probeIntervalMs: 5_000 };

    it('opens after minConsecutive failures over minDuration and fails fast (#54)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4, cooldownMs: 10 });
        const fn = vi.fn().mockRejectedValue(makeRateLimitError());
        const opts = { limiter, maxAttempts: 1, quotaBreaker: breaker };

        for (let i = 0; i < 3; i++) {
            const p = withCongestionControl(fn, opts).catch((e: Error) => e);
            await vi.advanceTimersByTimeAsync(600);
            expect(await p).toBeInstanceOf(MaxRetriesExceededError);
        }
        expect(fn).toHaveBeenCalledTimes(3);

        // Breaker is now open; the first caller claims the probe slot and
        // still executes (half-open semantics).
        const probe = withCongestionControl(fn, opts).catch((e: Error) => e);
        await vi.advanceTimersByTimeAsync(20);
        expect(await probe).toBeInstanceOf(MaxRetriesExceededError);
        expect(fn).toHaveBeenCalledTimes(4);

        // Within probeInterval: fail fast WITHOUT invoking fn.
        const fast = withCongestionControl(fn, opts).catch((e: Error) => e);
        await flushMicrotasks();
        const err = await fast;
        expect(err).toBeInstanceOf(QuotaCircuitOpenError);
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('QuotaCircuitOpenError routes like MaxRetriesExceededError (deferred drain pin) (#55)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4, cooldownMs: 10 });
        const fn = vi.fn().mockRejectedValue(makeRateLimitError());
        const opts = { limiter, maxAttempts: 1, quotaBreaker: breaker };

        for (let i = 0; i < 4; i++) {
            const p = withCongestionControl(fn, opts).catch((e: Error) => e);
            await vi.advanceTimersByTimeAsync(600);
            await p;
        }

        const fast = withCongestionControl(fn, opts).catch((e: Error) => e);
        await flushMicrotasks();
        const err = await fast;
        expect(err).toBeInstanceOf(QuotaCircuitOpenError);
        expect(err).toBeInstanceOf(MaxRetriesExceededError);
    });

    it('a successful probe closes the breaker and traffic resumes (#56)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4, cooldownMs: 10 });
        let quotaDead = true;
        const fn = vi.fn().mockImplementation(() =>
            quotaDead ? Promise.reject(makeRateLimitError()) : Promise.resolve('ok'));
        const opts = { limiter, maxAttempts: 1, quotaBreaker: breaker };

        for (let i = 0; i < 3; i++) {
            const p = withCongestionControl(fn, opts).catch((e: Error) => e);
            await vi.advanceTimersByTimeAsync(600);
            await p;
        }

        // Quota returns; the probe succeeds and closes the breaker.
        quotaDead = false;
        const probe = withCongestionControl(fn, opts);
        await vi.advanceTimersByTimeAsync(20);
        expect(await probe).toBe('ok');

        // Next call executes normally (no probe claim required).
        const next = withCongestionControl(fn, opts);
        await vi.advanceTimersByTimeAsync(20);
        expect(await next).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(5);
    });

    it('successes interleaved with 429s keep the breaker closed (#57)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4, cooldownMs: 10 });
        const opts = { limiter, maxAttempts: 1, quotaBreaker: breaker };

        for (let i = 0; i < 5; i++) {
            const fail = withCongestionControl(
                () => Promise.reject(makeRateLimitError()), opts).catch((e: Error) => e);
            await vi.advanceTimersByTimeAsync(600);
            const err = await fail as Error;
            expect(err).toBeInstanceOf(MaxRetriesExceededError);
            expect(err.name).toBe('MaxRetriesExceededError'); // never the breaker

            const ok = withCongestionControl(() => Promise.resolve('ok'), opts);
            await vi.advanceTimersByTimeAsync(20);
            expect(await ok).toBe('ok');
        }
    });

    it('quotaBreaker: false disables the breaker entirely (#58)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4, cooldownMs: 10 });
        const fn = vi.fn().mockRejectedValue(makeRateLimitError());
        const opts = { limiter, maxAttempts: 1, quotaBreaker: false as const };

        for (let i = 0; i < 6; i++) {
            const p = withCongestionControl(fn, opts).catch((e: Error) => e);
            await vi.advanceTimersByTimeAsync(600);
            const err = await p as Error;
            expect(err.name).toBe('MaxRetriesExceededError');
        }
        expect(fn).toHaveBeenCalledTimes(6);
    });
});

describe('withCongestionControl — adaptive RATE limiter integration', () => {
    it('consumes one rate token PER ATTEMPT and feeds 429/success back (amplification pin)', async () => {
        // Low cooldown so the concurrency limiter's post-429 freeze clears
        // within the advanced window (the freeze gates acquire(), not take()).
        const limiter = new AIMDSemaphore({ initialLimit: 4, cooldownMs: 100 });
        const rate = unboundedRateLimiter();
        const takeSpy = vi.spyOn(rate, 'take');
        const rlSpy = vi.spyOn(rate, 'recordRateLimit');
        const okSpy = vi.spyOn(rate, 'recordSuccess');

        let calls = 0;
        const fn = async () => { if (++calls < 2) throw makeRateLimitError(); return 'ok'; };

        const p = withCongestionControl(fn, { limiter, rateLimiter: rate, maxAttempts: 3, baseDelayMs: 100 });
        await vi.advanceTimersByTimeAsync(3000); // backoff (~1s) + concurrency freeze (100ms)
        expect(await p).toBe('ok');

        expect(takeSpy).toHaveBeenCalledTimes(2);  // one per attempt (retry pays budget)
        expect(rlSpy).toHaveBeenCalledTimes(1);    // the 429
        expect(okSpy).toHaveBeenCalledTimes(1);    // the eventual success
    });

    it('takes the rate token BEFORE acquiring the concurrency slot', async () => {
        const order: string[] = [];
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        vi.spyOn(limiter, 'acquire').mockImplementation(async () => { order.push('acquire'); return () => {}; });
        const rate = unboundedRateLimiter();
        vi.spyOn(rate, 'take').mockImplementation(async () => { order.push('take'); });

        await withCongestionControl(() => Promise.resolve('ok'), { limiter, rateLimiter: rate });
        expect(order).toEqual(['take', 'acquire']);
    });

    it('PIN H1: limiter:null couples the rate limiter OFF (no rate gate) even when env enables it', async () => {
        // Enable an aggressive default singleton (1 req/min) that WOULD block
        // the second attempt for 60s if the coupling were broken.
        vi.stubEnv('LLM_RATE_RPM', '1');
        resetDefaultRateLimitersForTests();

        let calls = 0;
        const fn = async () => { if (++calls < 2) throw makeRateLimitError(); return 'ok'; };
        const p = withCongestionControl(fn, { limiter: null, maxAttempts: 3, baseDelayMs: 100 });
        await vi.advanceTimersByTimeAsync(2500); // ONLY the backoff, NOT 60s of rate wait
        expect(await p).toBe('ok'); // resolves → no rate gate was applied
        expect(calls).toBe(2);
    });

    it('explicit rateLimiter:null disables rate limiting', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const result = await withCongestionControl(() => Promise.resolve('ok'), { limiter, rateLimiter: null });
        expect(result).toBe('ok');
    });

    it('shouldFailFast() ⇒ QuotaFloorStuckError before any call (dead-quota fast fail)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const rate = unboundedRateLimiter();
        vi.spyOn(rate, 'shouldFailFast').mockReturnValue(true);
        const fn = vi.fn().mockResolvedValue('ok');

        await expect(
            withCongestionControl(fn, { limiter, rateLimiter: rate, maxAttempts: 3 }),
        ).rejects.toBeInstanceOf(QuotaFloorStuckError);
        expect(fn).not.toHaveBeenCalled();
    });

    it('default rate limiter is disabled under vitest (no throttling of the existing suite)', async () => {
        // No rateLimiter passed, limiter present → resolves to the default
        // singleton, which buildRateLimiterOptionsFromEnv disables under VITEST.
        let calls = 0;
        const fn = async () => { calls++; return 'ok'; };
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        for (let i = 0; i < 20; i++) await withCongestionControl(fn, { limiter });
        expect(calls).toBe(20); // no rate wait stalled any of them
    });
});

describe('isConnectionError', () => {
    it('matches the production AI SDK / Bun message shape (no syscall code)', () => {
        expect(isConnectionError(makeConnectionError())).toBe(true);
        expect(isConnectionError(new Error('Unable to connect. Is the computer able to access the url?'))).toBe(true);
        expect(isConnectionError(new TypeError('fetch failed'))).toBe(true);
        expect(isConnectionError(new Error('getaddrinfo ENOTFOUND aiplatform.googleapis.com'))).toBe(true);
    });

    it('matches syscall codes on the error or anywhere in its cause chain', () => {
        const withCode = new Error('request to host failed') as Error & { code?: string };
        withCode.code = 'ECONNREFUSED';
        expect(isConnectionError(withCode)).toBe(true);

        // undici wraps the syscall error as `cause` (TypeError: fetch failed).
        const wrapped = new TypeError('fetch did not complete');
        (wrapped as Error & { cause?: unknown }).cause = { code: 'ECONNRESET' };
        expect(isConnectionError(wrapped)).toBe(true);
    });

    it('never matches rate-limit errors (disjoint circuit families)', () => {
        expect(isConnectionError(makeRateLimitError())).toBe(false);
        expect(isConnectionError(makeRateLimitError(30))).toBe(false);
    });

    it('does not match generic errors, auth errors, or non-objects', () => {
        expect(isConnectionError(new Error('boom'))).toBe(false);
        expect(isConnectionError(new Error('invalid api key'))).toBe(false);
        expect(isConnectionError(new Error('schema validation failed'))).toBe(false);
        expect(isConnectionError(null)).toBe(false);
        expect(isConnectionError(undefined)).toBe(false);
        expect(isConnectionError('ECONNREFUSED')).toBe(false);
    });
});

describe('withCongestionControl — connection-error circuit breaker', () => {
    const breaker = { minConsecutive: 3, probeIntervalMs: 5_000 };

    it('a connection error is rethrown immediately: no retry, no rate-limit recording', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const rateLimitSpy = vi.spyOn(limiter, 'recordRateLimit');
        const fn = vi.fn().mockRejectedValue(makeConnectionError());

        await expect(
            withCongestionControl(fn, { limiter, maxAttempts: 5, connectionBreaker: breaker, rateDomain: 'conn:a' }),
        ).rejects.toThrow(/cannot connect/i);

        expect(fn).toHaveBeenCalledTimes(1); // no in-place retry
        expect(rateLimitSpy).not.toHaveBeenCalled();
        expect(limiter.metrics().inFlight).toBe(0);
    });

    it('opens after minConsecutive failures, grants one probe, then fails fast (#RC1)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const fn = vi.fn().mockRejectedValue(makeConnectionError());
        const opts = { limiter, connectionBreaker: breaker, rateDomain: 'conn:b' };

        for (let i = 0; i < 3; i++) {
            await expect(withCongestionControl(fn, opts)).rejects.toThrow(/cannot connect/i);
        }
        expect(fn).toHaveBeenCalledTimes(3);

        // Circuit is open; the first caller claims the probe slot and still
        // executes (half-open semantics).
        await expect(withCongestionControl(fn, opts)).rejects.toThrow(/cannot connect/i);
        expect(fn).toHaveBeenCalledTimes(4);

        // Within probeInterval: fail fast WITHOUT invoking fn.
        await expect(withCongestionControl(fn, opts)).rejects.toBeInstanceOf(EndpointUnreachableError);
        expect(fn).toHaveBeenCalledTimes(4);

        // After the interval, the next probe goes through.
        vi.advanceTimersByTime(5_500);
        await expect(withCongestionControl(fn, opts)).rejects.toThrow(/cannot connect/i);
        expect(fn).toHaveBeenCalledTimes(5);
    });

    it('EndpointUnreachableError routes like MaxRetriesExceededError (deferred drain pin)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const fn = vi.fn().mockRejectedValue(makeConnectionError());
        const opts = { limiter, connectionBreaker: breaker, rateDomain: 'conn:c' };

        for (let i = 0; i < 4; i++) {
            await withCongestionControl(fn, opts).catch(() => undefined);
        }
        const err = await withCongestionControl(fn, opts).catch((e: Error) => e) as Error & { code?: string };

        expect(err).toBeInstanceOf(EndpointUnreachableError);
        expect(err).toBeInstanceOf(MaxRetriesExceededError);
        expect(err.code).toBe('MAX_RETRIES_EXCEEDED');
        expect(err.name).toBe('EndpointUnreachableError');
        expect(err.message).toContain('conn:c');
        expect(err.message.toLowerCase()).toContain('connection');
    });

    it('a successful probe closes the circuit and traffic resumes', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        let endpointDead = true;
        const fn = vi.fn().mockImplementation(() =>
            endpointDead ? Promise.reject(makeConnectionError()) : Promise.resolve('ok'));
        const opts = { limiter, connectionBreaker: breaker, rateDomain: 'conn:d' };

        for (let i = 0; i < 3; i++) {
            await withCongestionControl(fn, opts).catch(() => undefined);
        }

        // Network returns; the probe succeeds and closes the circuit.
        endpointDead = false;
        expect(await withCongestionControl(fn, opts)).toBe('ok');

        // Next call executes normally (no probe claim required).
        expect(await withCongestionControl(fn, opts)).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(5);
    });

    it('a success resets the fleet streak (interleaved blips never open the circuit)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const opts = { limiter, connectionBreaker: breaker, rateDomain: 'conn:e' };
        const fail = vi.fn().mockRejectedValue(makeConnectionError());

        for (let round = 0; round < 3; round++) {
            await withCongestionControl(fail, opts).catch(() => undefined);
            await withCongestionControl(fail, opts).catch(() => undefined);
            expect(await withCongestionControl(() => Promise.resolve('ok'), opts)).toBe('ok');
        }
        // 6 connection failures total, but never 3 consecutive: fn always ran.
        expect(fail).toHaveBeenCalledTimes(6);
    });

    it('per-domain isolation: an open circuit on one rateDomain does not affect another', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const fail = vi.fn().mockRejectedValue(makeConnectionError());

        for (let i = 0; i < 4; i++) {
            await withCongestionControl(fail, { limiter, connectionBreaker: breaker, rateDomain: 'dead:m' })
                .catch(() => undefined);
        }
        // dead:m is now open (probe consumed by the 4th call).
        await expect(
            withCongestionControl(fail, { limiter, connectionBreaker: breaker, rateDomain: 'dead:m' }),
        ).rejects.toBeInstanceOf(EndpointUnreachableError);

        // The healthy domain is untouched.
        const ok = vi.fn().mockResolvedValue('ok');
        expect(
            await withCongestionControl(ok, { limiter, connectionBreaker: breaker, rateDomain: 'live:m' }),
        ).toBe('ok');
        expect(ok).toHaveBeenCalledTimes(1);
    });

    it('connectionBreaker: false disables the circuit entirely', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const fn = vi.fn().mockRejectedValue(makeConnectionError());
        const opts = { limiter, connectionBreaker: false as const, rateDomain: 'conn:f' };

        for (let i = 0; i < 8; i++) {
            await expect(withCongestionControl(fn, opts)).rejects.toThrow(/cannot connect/i);
        }
        expect(fn).toHaveBeenCalledTimes(8); // never failed fast
    });

    it('limiter: null without explicit breaker opts disables the circuit (escape hatch pin)', async () => {
        const fn = vi.fn().mockRejectedValue(makeConnectionError());

        for (let i = 0; i < 8; i++) {
            await expect(withCongestionControl(fn, { limiter: null })).rejects.toThrow(/cannot connect/i);
        }
        expect(fn).toHaveBeenCalledTimes(8); // "no limiting at all" still holds
    });
});
