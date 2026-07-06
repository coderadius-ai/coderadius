import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AIMDSemaphore,
    RateLimitQueueFullError,
    RateLimitWaitTimeoutError,
    getDefaultAIMDSemaphore,
    resetDefaultAIMDSemaphoreForTests,
    type LimitChangeEvent,
} from '../../../src/utils/aimd-semaphore.js';
import { ShutdownAbortError } from '../../../src/utils/shutdown.js';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetDefaultAIMDSemaphoreForTests();
});

// Helper: drain the microtask queue to surface scheduled promise resolutions
// when interleaving with vi.advanceTimersByTime.
async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('AIMDSemaphore — base AIMD behavior', () => {
    it('starts at initialLimit (#1)', () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        expect(limiter.metrics().currentLimit).toBe(4);
        expect(limiter.metrics().inFlight).toBe(0);
    });

    it('acquire fills slots and the next call queues (#2)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const releases: Array<() => void> = [];
        for (let i = 0; i < 4; i++) {
            releases.push(await limiter.acquire());
        }
        expect(limiter.metrics().inFlight).toBe(4);

        let fifthResolved = false;
        const fifth = limiter.acquire().then(() => {
            fifthResolved = true;
        });
        await flushMicrotasks();
        expect(fifthResolved).toBe(false);
        expect(limiter.metrics().queueLength).toBe(1);

        // Cleanup so the test does not leak the pending promise.
        releases[0]();
        await fifth;
    });

    it('records success streak and increases limit (#3)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            successStreakForIncrease: 5,
            softMaxLimit: 8,
        });
        const events: LimitChangeEvent[] = [];
        limiter.onLimitChange(e => events.push(e));

        for (let i = 0; i < 5; i++) limiter.recordSuccess();

        expect(limiter.metrics().currentLimit).toBe(5);
        expect(events).toHaveLength(1);
        expect(events[0].from).toBe(4);
        expect(events[0].to).toBe(5);
        expect(events[0].reason).toBe('success-streak');
    });

    it('records rate limit and decreases by decreaseFactor (#4)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            decreaseFactor: 0.5,
            cooldownMs: 5000,
            minLimit: 2,
        });
        const events: LimitChangeEvent[] = [];
        limiter.onLimitChange(e => events.push(e));

        limiter.recordRateLimit();

        expect(limiter.metrics().currentLimit).toBe(4);
        expect(limiter.metrics().cooldownActive).toBe(true);
        const decreaseEvents = events.filter(e => e.reason === 'rate-limit-429');
        expect(decreaseEvents).toHaveLength(1);
        expect(decreaseEvents[0].from).toBe(8);
        expect(decreaseEvents[0].to).toBe(4);
    });

    it('does not increase during cooldown (#5)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            successStreakForIncrease: 5,
            cooldownMs: 5000,
        });
        limiter.recordRateLimit(); // 8 → 4, freezeUntil set

        for (let i = 0; i < 100; i++) limiter.recordSuccess();

        expect(limiter.metrics().currentLimit).toBe(4);
    });

    it('after cooldown elapses, recovery then streak increases resume (#6)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            successStreakForIncrease: 3,
            cooldownMs: 5000,
            softMaxLimit: 16,
        });
        limiter.recordRateLimit(); // → 4

        vi.advanceTimersByTime(5001);
        await flushMicrotasks();

        expect(limiter.metrics().cooldownActive).toBe(false);
        limiter.recordSuccess(); // half-open recovery: 4 → 8 in one jump
        expect(limiter.metrics().currentLimit).toBe(8);
        for (let i = 0; i < 3; i++) limiter.recordSuccess(); // streak resumes
        expect(limiter.metrics().currentLimit).toBe(9);
    });

    it('honors Retry-After when longer than cooldown (#7)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            cooldownMs: 5000,
        });
        const startTime = Date.now();
        limiter.recordRateLimit(10_000); // 10s Retry-After

        vi.advanceTimersByTime(6000); // past cooldown but not Retry-After
        expect(limiter.metrics().cooldownActive).toBe(true);

        vi.advanceTimersByTime(5000); // total 11s, past Retry-After
        // After advancing past freezeUntil, cooldownActive should be false on read.
        expect(limiter.metrics().cooldownActive).toBe(false);
        // sanity: at least 10 seconds elapsed
        expect(Date.now() - startTime).toBeGreaterThanOrEqual(10_000);
    });

    it('clamps an honored Retry-After to maxFreezeMs (#7b)', () => {
        // A quota-exhaustion Retry-After (hours) must not freeze the limiter
        // for hours: the retry loop fails fast separately, and the limiter's
        // congestion window stays bounded.
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            cooldownMs: 5_000,
            maxFreezeMs: 10_000,
        });
        limiter.recordRateLimit(3_600_000); // 1h Retry-After

        vi.advanceTimersByTime(9_000);
        expect(limiter.metrics().cooldownActive).toBe(true);

        vi.advanceTimersByTime(1_500); // past the 10s clamp
        expect(limiter.metrics().cooldownActive).toBe(false);
    });

    it('default maxFreezeMs bounds the freeze to 5 minutes (#7c)', () => {
        const limiter = new AIMDSemaphore({ initialLimit: 8, cooldownMs: 5_000 });
        limiter.recordRateLimit(3_600_000);

        vi.advanceTimersByTime(299_000);
        expect(limiter.metrics().cooldownActive).toBe(true);

        vi.advanceTimersByTime(2_000);
        expect(limiter.metrics().cooldownActive).toBe(false);
    });

    it('respects soft/hard caps and minLimit floor (#8)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            softMaxLimit: 6,
            hardMaxLimit: 6,
            minLimit: 2,
            successStreakForIncrease: 1,
            decreaseFactor: 0.5,
            cooldownMs: 1,
        });
        // climb past softMax
        for (let i = 0; i < 100; i++) limiter.recordSuccess();
        expect(limiter.metrics().currentLimit).toBeLessThanOrEqual(6);

        // dive below minLimit
        for (let i = 0; i < 10; i++) {
            limiter.recordRateLimit();
            vi.advanceTimersByTime(2);
        }
        expect(limiter.metrics().currentLimit).toBeGreaterThanOrEqual(2);
    });

    it('after decrease, queued waiters resume only up to new limit (#9)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            decreaseFactor: 0.5,
            cooldownMs: 0,
            minLimit: 2,
        });
        // Saturate 8 slots
        const inFlightReleases: Array<() => void> = [];
        for (let i = 0; i < 8; i++) inFlightReleases.push(await limiter.acquire());

        // Queue 5 waiters
        const acquired: number[] = [];
        for (let i = 0; i < 5; i++) {
            void limiter.acquire().then(rel => {
                acquired.push(i);
                rel();
            });
        }
        await flushMicrotasks();
        expect(limiter.metrics().queueLength).toBe(5);

        // 429 → 8 → 4
        limiter.recordRateLimit();
        // cooldown is 0 so we can release and observe.
        // Release all 8 in flight; only up to currentLimit (4) of the 5 waiters should run.
        for (const rel of inFlightReleases) rel();
        await flushMicrotasks();

        // Currently 4 waiters resumed and immediately released, 1 still in queue or
        // has resumed too if we draindown. With cooldownMs=0 they all eventually fire,
        // but inFlight should never exceed 4 at any moment.
        expect(limiter.metrics().inFlight).toBeLessThanOrEqual(4);
    });

    it('onLimitChange subscription and unsubscribe (#10)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            successStreakForIncrease: 1,
            softMaxLimit: 8,
        });
        const events: LimitChangeEvent[] = [];
        const unsubscribe = limiter.onLimitChange(e => events.push(e));
        limiter.recordSuccess(); // emits +1
        expect(events).toHaveLength(1);
        unsubscribe();
        limiter.recordSuccess();
        expect(events).toHaveLength(1); // no further events
    });

    it('reset restores initial state and keeps no leaked listeners (#11)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            successStreakForIncrease: 1,
            softMaxLimit: 8,
        });
        const events: LimitChangeEvent[] = [];
        limiter.onLimitChange(e => events.push(e));

        for (let i = 0; i < 3; i++) limiter.recordSuccess();
        expect(limiter.metrics().currentLimit).toBe(7);

        limiter.reset();
        expect(limiter.metrics().currentLimit).toBe(4);
        expect(limiter.metrics().inFlight).toBe(0);
        expect(limiter.metrics().queueLength).toBe(0);

        // listener still active after reset
        const before = events.length;
        limiter.recordSuccess();
        expect(events.length).toBe(before + 1);
    });

    it('getDefaultAIMDSemaphore returns the same instance (#12)', () => {
        const a = getDefaultAIMDSemaphore();
        const b = getDefaultAIMDSemaphore();
        expect(a).toBe(b);
    });

    it('legacy LLM_CONCURRENCY env pins as a hard cap (#13)', () => {
        vi.stubEnv('LLM_CONCURRENCY', '2');
        resetDefaultAIMDSemaphoreForTests();
        const limiter = getDefaultAIMDSemaphore();
        // It should not climb past 2 even after many successes.
        for (let i = 0; i < 100; i++) limiter.recordSuccess();
        expect(limiter.metrics().currentLimit).toBeLessThanOrEqual(2);
    });

    it('release() is idempotent (#14)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const release = await limiter.acquire();
        expect(limiter.metrics().inFlight).toBe(1);
        release();
        expect(limiter.metrics().inFlight).toBe(0);
        // Second call is a no-op
        release();
        expect(limiter.metrics().inFlight).toBe(0);
    });
});

describe('AIMDSemaphore — G2 windowing (death spiral protection)', () => {
    it('burst of 16 simultaneous 429s causes only ONE decrease (#15)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 16,
            decreaseFactor: 0.5,
            cooldownMs: 5000,
            minLimit: 2,
        });
        for (let i = 0; i < 16; i++) limiter.recordRateLimit();

        const m = limiter.metrics();
        expect(m.currentLimit).toBe(8);
        expect(m.decreasesCount).toBe(1);
        expect(m.rateLimitCount).toBe(16);
    });

    it('429s during an active freeze do NOT extend the window (stale evidence) (#16)', () => {
        // acquire() is blocked while frozen, so any 429 recorded mid-freeze
        // comes from a call that started BEFORE the freeze. Extending the
        // window on stale evidence creates a sliding gate that never opens
        // (the convoy starvation observed in production runs).
        const limiter = new AIMDSemaphore({
            initialLimit: 16,
            cooldownMs: 1000,
        });
        limiter.recordRateLimit(5000); // freezeUntil = t0 + 5000
        vi.advanceTimersByTime(1000);
        limiter.recordRateLimit(15_000); // straggler: ignored, no extension
        limiter.recordRateLimit(60_000); // straggler: ignored, no extension

        vi.advanceTimersByTime(3998); // t0 + 4998
        expect(limiter.metrics().cooldownActive).toBe(true);

        vi.advanceTimersByTime(3); // t0 + 5001
        expect(limiter.metrics().cooldownActive).toBe(false);
    });

    it('after cooldown ends, a new 429 produces a new decrease (#17)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 16,
            decreaseFactor: 0.5,
            cooldownMs: 1000,
            minLimit: 2,
        });
        limiter.recordRateLimit(); // 16 → 8
        vi.advanceTimersByTime(1100);
        limiter.recordRateLimit(); // 8 → 4

        const m = limiter.metrics();
        expect(m.decreasesCount).toBe(2);
        expect(m.currentLimit).toBe(4);
    });

    it('during cooldown, recordRateLimit() with no retry-after never shrinks the timer (#18)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 16,
            cooldownMs: 1000,
        });
        limiter.recordRateLimit(10_000);
        vi.advanceTimersByTime(500);
        limiter.recordRateLimit(); // shorter cooldown, ignored

        vi.advanceTimersByTime(8000); // 8500ms total, still inside the 10s freeze
        expect(limiter.metrics().cooldownActive).toBe(true);
    });

    it('emits LimitChangeEvent only for the FIRST 429 in a window (#19)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 16,
            decreaseFactor: 0.5,
            cooldownMs: 5000,
        });
        const events: LimitChangeEvent[] = [];
        limiter.onLimitChange(e => events.push(e));

        for (let i = 0; i < 10; i++) limiter.recordRateLimit();

        const decreases = events.filter(e => e.reason === 'rate-limit-429');
        expect(decreases).toHaveLength(1);
    });
});

describe('AIMDSemaphore — half-open recovery and quota streak', () => {
    it('first success after a freeze restores the limit to initialLimit (#48)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            decreaseFactor: 0.5,
            cooldownMs: 1000,
            minLimit: 2,
        });
        limiter.recordRateLimit(); // 8 → 4, freeze 1s
        expect(limiter.metrics().currentLimit).toBe(4);

        vi.advanceTimersByTime(1100);
        limiter.recordSuccess();

        expect(limiter.metrics().currentLimit).toBe(8);
    });

    it('recovery emits a LimitChangeEvent with reason recovery (#49)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            decreaseFactor: 0.5,
            cooldownMs: 1000,
            minLimit: 2,
        });
        const events: LimitChangeEvent[] = [];
        limiter.onLimitChange(e => events.push(e));

        limiter.recordRateLimit(); // 8 → 4
        vi.advanceTimersByTime(1100);
        limiter.recordSuccess();

        expect(events.some(e => e.reason === 'recovery' && e.from === 4 && e.to === 8)).toBe(true);
    });

    it('a success DURING the freeze does not trigger recovery (#50)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 8,
            decreaseFactor: 0.5,
            cooldownMs: 5000,
            minLimit: 2,
        });
        limiter.recordRateLimit(); // 8 → 4
        vi.advanceTimersByTime(100);
        limiter.recordSuccess(); // pre-freeze in-flight call landing late
        expect(limiter.metrics().currentLimit).toBe(4);

        vi.advanceTimersByTime(5000);
        limiter.recordSuccess(); // first post-freeze success recovers
        expect(limiter.metrics().currentLimit).toBe(8);
    });

    it('recovery never lowers a limit already above initialLimit (#51)', () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            softMaxLimit: 16,
            decreaseFactor: 0.5,
            cooldownMs: 1000,
            minLimit: 2,
            successStreakForIncrease: 1,
        });
        limiter.recordSuccess(); // 4 → 5
        limiter.recordSuccess(); // 5 → 6
        expect(limiter.metrics().currentLimit).toBe(6);

        limiter.recordRateLimit(); // 6 → 3
        vi.advanceTimersByTime(1100);
        limiter.recordSuccess(); // recovery → max(3, initialLimit 4) = 4
        expect(limiter.metrics().currentLimit).toBe(4);
    });

    it('quota streak counts consecutive 429s and resets on success (#52)', () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4, cooldownMs: 1000 });
        const t0 = Date.now();

        limiter.recordRateLimit();
        limiter.recordRateLimit();
        expect(limiter.quotaStreak().consecutive).toBe(2);
        expect(limiter.quotaStreak().startedAt).toBe(t0);

        limiter.recordSuccess();
        expect(limiter.quotaStreak().consecutive).toBe(0);
    });

    it('tryClaimQuotaProbe grants once per interval (#53)', () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });

        expect(limiter.tryClaimQuotaProbe(60_000)).toBe(true);
        expect(limiter.tryClaimQuotaProbe(60_000)).toBe(false);

        vi.advanceTimersByTime(60_001);
        expect(limiter.tryClaimQuotaProbe(60_000)).toBe(true);
    });
});

describe('AIMDSemaphore — G3 bounded queue (memory leak protection)', () => {
    it('throws RateLimitQueueFullError when queue is at maxQueueSize (#20)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 1,
            maxQueueSize: 3,
        });
        // 1 fills the slot
        const r = await limiter.acquire();
        // 3 enter the queue
        const queued = [
            limiter.acquire(),
            limiter.acquire(),
            limiter.acquire(),
        ];
        await flushMicrotasks();
        expect(limiter.metrics().queueLength).toBe(3);

        // The 5th is rejected immediately
        await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitQueueFullError);
        expect(limiter.metrics().queueFullErrorsTotal).toBe(1);

        // Cleanup pending promises so vitest doesn't complain.
        r();
        for (const q of queued) (await q)();
    });

    it('after release, queue has room for new acquire (#21)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 1,
            maxQueueSize: 2,
        });
        const r0 = await limiter.acquire();
        const w1 = limiter.acquire();
        const w2 = limiter.acquire();
        await flushMicrotasks();
        // queue full
        await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitQueueFullError);

        // Releasing r0 promotes w1 → in flight; queue has 1 spot.
        r0();
        await flushMicrotasks();
        expect(limiter.metrics().queueLength).toBe(1);

        // Now we can enqueue one more
        const w3 = limiter.acquire();
        await flushMicrotasks();
        expect(limiter.metrics().queueLength).toBe(2);

        // Cleanup
        (await w1)();
        await flushMicrotasks();
        (await w2)();
        await flushMicrotasks();
        (await w3)();
    });

    it('waiter rejected after maxWaitMs (#22)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 1,
            maxQueueSize: 5,
            maxWaitMs: 1000,
        });
        const r = await limiter.acquire();
        const waiter = limiter.acquire();
        // Suppress unhandledRejection while we await the timer.
        const expectation = expect(waiter).rejects.toBeInstanceOf(RateLimitWaitTimeoutError);

        vi.advanceTimersByTime(1500);
        await expectation;
        expect(limiter.metrics().waitTimeoutsTotal).toBe(1);
        r();
    });

    it('timed-out waiter is removed from queue (no zombie wakeup) (#23)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 1,
            maxQueueSize: 5,
            maxWaitMs: 1000,
        });
        const r = await limiter.acquire();
        const waiter = limiter.acquire();
        const expectation = expect(waiter).rejects.toBeInstanceOf(RateLimitWaitTimeoutError);

        vi.advanceTimersByTime(1500);
        await expectation;
        expect(limiter.metrics().queueLength).toBe(0);

        // Releasing the slot must NOT try to resolve a dead waiter.
        r();
        await flushMicrotasks();
        expect(limiter.metrics().inFlight).toBe(0);
    });

    it('GREEN-guard: normal batch never hits maxQueueSize (#24)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 16,
            maxQueueSize: 200,
        });
        const releases: Array<() => void> = [];
        for (let i = 0; i < 100; i++) {
            const fn = async () => {
                const rel = await limiter.acquire();
                releases.push(rel);
            };
            void fn();
        }
        await flushMicrotasks();
        expect(limiter.metrics().queueFullErrorsTotal).toBe(0);

        // Drain
        for (const rel of releases) rel();
    });
});

describe('AIMDSemaphore — abort signal propagation (Ctrl+C fast-path)', () => {
    it('acquire(signal) throws ShutdownAbortError if signal is already aborted (#9)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 4 });
        const ctrl = new AbortController();
        ctrl.abort(new ShutdownAbortError('test'));
        await expect(limiter.acquire(ctrl.signal)).rejects.toBeInstanceOf(ShutdownAbortError);
        // No slot was actually granted.
        expect(limiter.metrics().inFlight).toBe(0);
    });

    it('queue waiter rejects with ShutdownAbortError when the signal aborts mid-wait (#10)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 1,
            maxQueueSize: 5,
            maxWaitMs: 60_000,
        });
        // Saturate the only slot
        const r = await limiter.acquire();
        const ctrl = new AbortController();
        const waiter = limiter.acquire(ctrl.signal);
        const expectation = expect(waiter).rejects.toBeInstanceOf(ShutdownAbortError);

        await flushMicrotasks();
        expect(limiter.metrics().queueLength).toBe(1);

        ctrl.abort(new ShutdownAbortError('SIGINT'));
        await expectation;

        // Entry removed from queue, no zombie wakeup on later release().
        expect(limiter.metrics().queueLength).toBe(0);
        r();
        await flushMicrotasks();
        expect(limiter.metrics().inFlight).toBe(0);
    });

    it('GREEN-guard: no signal passed → existing semantics unchanged (#11)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 2 });
        const r1 = await limiter.acquire();
        const r2 = await limiter.acquire();
        expect(limiter.metrics().inFlight).toBe(2);
        r1();
        r2();
        expect(limiter.metrics().inFlight).toBe(0);
    });
});

describe('AIMDSemaphore — CLI batch defaults (#12)', () => {
    it('default queue is effectively unbounded for batch ingestion', async () => {
        // Batch CLI runs may have thousands of pending acquires (file × chunk
        // × function). The fail-fast G3 from the original plan was sized for
        // server use-cases; for the CodeRadius CLI it would surface as
        // RateLimitQueueFullError on every run. Default must be unbounded.
        const limiter = new AIMDSemaphore({ initialLimit: 1 });
        const r = await limiter.acquire();

        // Enqueue many waiters; none should fail with QueueFull.
        const waiters: Promise<() => void>[] = [];
        for (let i = 0; i < 5_000; i++) waiters.push(limiter.acquire());

        await flushMicrotasks();
        expect(limiter.metrics().queueLength).toBe(5_000);
        expect(limiter.metrics().queueFullErrorsTotal).toBe(0);

        // Drain
        r();
        await flushMicrotasks();
        for (const w of waiters) (await w)();
    });

    it('default wait timer is disabled (no spurious RateLimitWaitTimeoutError)', async () => {
        const limiter = new AIMDSemaphore({ initialLimit: 1 });
        const r = await limiter.acquire();
        const waiter = limiter.acquire();

        // Even after a long wait, the waiter is still pending — no timeout.
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await flushMicrotasks();
        expect(limiter.metrics().waitTimeoutsTotal).toBe(0);

        r();
        await flushMicrotasks();
        (await waiter)();
    });
});
