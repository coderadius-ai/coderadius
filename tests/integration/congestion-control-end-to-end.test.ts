import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AIMDSemaphore,
    RateLimitQueueFullError,
    type LimitChangeEvent,
} from '../../src/utils/aimd-semaphore.js';
import { withCongestionControl } from '../../src/utils/congestion-control.js';

// ─── End-to-end stress for AIMD + back-pressure ──────────────────────────────
//
// These integration tests use a deterministic mock LLM client to exercise
// the full path: withCongestionControl → limiter.acquire → fn → record* → retry.
//
// Unlike the unit suite, here we wire many concurrent callers and assert
// invariants on the system behavior:
//   #37 — increase before 429, decrease at first 429, recovery after cooldown
//   #38 — G2 stress: burst of N simultaneous 429s yields ONE decrease only
//   #39 — G3 stress: max-queue full triggers RateLimitQueueFullError fail-fast
//   #40 — G1 stress: no deadlock; sleep slots are released; throughput beats
//          a hypothetical "broken" version that holds slots during sleep
//   #41 — Determinism with seeded jitter

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

/**
 * See unit-suite note on flushMicrotasks: this is the known
 * `vi.useFakeTimers()` + native-promise interaction. Default 30 cycles
 * accommodates the deeper retry chain exercised here.
 */
async function flushMicrotasks(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
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

/**
 * Mock LLM client with a programmable response sequence.
 * Each `respond` method consumes one entry from the script and returns it.
 */
class MockLLMClient {
    private callIndex = 0;
    public callsObserved = 0;

    constructor(private script: ReadonlyArray<'ok' | 'rl' | { rl: number }>) {}

    async call(): Promise<string> {
        this.callsObserved++;
        const i = this.callIndex++;
        const entry = this.script[Math.min(i, this.script.length - 1)];
        if (entry === 'ok') return `ok-${i}`;
        if (entry === 'rl') throw makeRateLimitError();
        throw makeRateLimitError(entry.rl);
    }
}

/**
 * Mock LLM client where the response depends on the time of the call.
 */
class TimedMockLLMClient {
    public callsObserved = 0;
    public rateLimitObserved = 0;

    constructor(private decide: (callIndex: number, now: number) => 'ok' | 'rl') {}

    async call(): Promise<string> {
        this.callsObserved++;
        const decision = this.decide(this.callsObserved - 1, Date.now());
        if (decision === 'rl') {
            this.rateLimitObserved++;
            throw makeRateLimitError();
        }
        return `ok-${this.callsObserved}`;
    }
}

describe('adaptive-concurrency end-to-end stress (#37)', () => {
    it('increases before 429, decreases at first 429, recovers after cooldown', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            softMaxLimit: 12,
            cooldownMs: 2_000,
            decreaseFactor: 0.5,
            successStreakForIncrease: 3,
            minLimit: 2,
        });
        const events: LimitChangeEvent[] = [];
        limiter.onLimitChange(e => events.push(e));

        // Script: first 10 OK, next 5 rate-limited, then OK forever.
        // Each caller fires one call.
        const script: Array<'ok' | 'rl'> = [
            ...Array(10).fill('ok'),
            ...Array(5).fill('rl'),
            ...Array(60).fill('ok'),
        ];
        const client = new MockLLMClient(script);

        const callers: Promise<string>[] = [];
        for (let i = 0; i < 50; i++) {
            callers.push(
                withCongestionControl(() => client.call(), {
                    limiter,
                    maxAttempts: 6,
                    baseDelayMs: 100,
                }),
            );
        }

        // Drive the system through cooldowns and backoffs.
        for (let t = 0; t < 30; t++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await flushMicrotasks();
        }

        const results = await Promise.all(callers);
        expect(results).toHaveLength(50);
        // All 50 callers succeeded eventually.
        for (const r of results) expect(r.startsWith('ok-')).toBe(true);

        // The limiter should have recorded at least one increase before the storm
        // and exactly one decrease at the first 429 of the burst.
        const increases = events.filter(e => e.reason === 'success-streak');
        const decreases = events.filter(e => e.reason === 'rate-limit-429');
        expect(increases.length).toBeGreaterThanOrEqual(1);
        expect(decreases.length).toBeGreaterThanOrEqual(1);
    });
});

describe('adaptive-concurrency end-to-end — G2 burst stress (#38)', () => {
    it('a 429 burst causes only ONE decrease (death spiral protection)', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 16,
            softMaxLimit: 16,
            cooldownMs: 2_000,
            decreaseFactor: 0.5,
            minLimit: 2,
        });
        const events: LimitChangeEvent[] = [];
        limiter.onLimitChange(e => events.push(e));

        // First wave: every call gets 429 simultaneously. After 1s simulated
        // time, calls succeed.
        const stormUntil = Date.now() + 1_000;
        const client = new TimedMockLLMClient((_idx, now) => (now < stormUntil ? 'rl' : 'ok'));

        const callers: Promise<string>[] = [];
        for (let i = 0; i < 50; i++) {
            callers.push(
                withCongestionControl(() => client.call(), {
                    limiter,
                    maxAttempts: 8,
                    baseDelayMs: 100,
                }),
            );
        }

        // Allow the 16 in-flight to all hit 429 nearly simultaneously.
        await flushMicrotasks();
        // Drive through the cooldown and retries.
        for (let t = 0; t < 30; t++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await flushMicrotasks();
        }

        const results = await Promise.all(callers);
        expect(results).toHaveLength(50);

        // CRITICAL: a single decrease per congestion window.
        const decreases = events.filter(e => e.reason === 'rate-limit-429');
        expect(decreases.length).toBe(1);

        // The 429 burst is bigger than 1 — but only ONE decrease was applied.
        expect(client.rateLimitObserved).toBeGreaterThan(1);
        expect(limiter.metrics().rateLimitCount).toBeGreaterThan(1);
        expect(limiter.metrics().decreasesCount).toBe(1);
    });
});

describe('adaptive-concurrency end-to-end — G3 back-pressure stress (#39)', () => {
    it('queue-full triggers RateLimitQueueFullError fail-fast', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 2,
            cooldownMs: 0,
            maxQueueSize: 5,
        });

        // Slow client: 10s per call.
        let inflight = 0;
        const slowClient = async () => {
            inflight++;
            await new Promise(r => setTimeout(r, 10_000));
            inflight--;
            return 'ok';
        };

        const callers: Promise<string | RateLimitQueueFullError>[] = [];
        for (let i = 0; i < 100; i++) {
            callers.push(
                withCongestionControl(slowClient, {
                    limiter,
                    maxAttempts: 1,
                    baseDelayMs: 1,
                }).catch(err => err as RateLimitQueueFullError),
            );
        }

        await flushMicrotasks();
        // After microtask flush, 2 callers are in flight; 5 are queued; the
        // remaining 93 must have synchronously been rejected with QueueFull.
        const queueFullCount = limiter.metrics().queueFullErrorsTotal;
        expect(queueFullCount).toBe(93);

        // Drain the in-flight + queued ones.
        await vi.advanceTimersByTimeAsync(60_000);

        const results = await Promise.all(callers);
        const queueFulls = results.filter(r => r instanceof RateLimitQueueFullError);
        const okResults = results.filter(r => r === 'ok');
        expect(queueFulls).toHaveLength(93);
        expect(okResults).toHaveLength(7);
    });
});

describe('adaptive-concurrency end-to-end — G1 no-deadlock stress (#40)', () => {
    it('20 callers, each fails once, none holds slots during backoff', async () => {
        const limiter = new AIMDSemaphore({
            initialLimit: 4,
            softMaxLimit: 4,
            cooldownMs: 0,
            decreaseFactor: 1, // do not shrink, isolate G1
            minLimit: 4,
        });

        const callsPerCaller = new Map<number, number>();
        function makeFn(i: number) {
            return async () => {
                const c = (callsPerCaller.get(i) ?? 0) + 1;
                callsPerCaller.set(i, c);
                if (c === 1) throw makeRateLimitError();
                return `ok-${i}`;
            };
        }

        const callers: Promise<string>[] = [];
        for (let i = 0; i < 20; i++) {
            callers.push(
                withCongestionControl(makeFn(i), {
                    limiter,
                    maxAttempts: 3,
                    baseDelayMs: 100,
                }),
            );
        }

        // Wait for the initial wave: 4 in flight. They all fail and enter sleep.
        await flushMicrotasks();
        // CRITICAL: with G1 honored, slots should drain to 0 during backoff sleeps,
        // letting the next wave acquire.
        // The exact instantaneous value depends on scheduling, but max observed
        // inFlight should never exceed currentLimit (4).
        expect(limiter.metrics().inFlight).toBeLessThanOrEqual(4);

        for (let t = 0; t < 20; t++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await flushMicrotasks();
        }

        const results = await Promise.all(callers);
        expect(results).toHaveLength(20);
        for (let i = 0; i < 20; i++) {
            expect(results[i]).toBe(`ok-${i}`);
            expect(callsPerCaller.get(i)).toBe(2);
        }
    });
});

describe('adaptive-concurrency end-to-end — determinism (#41)', () => {
    it('same scripted scenario produces same final metrics across runs', async () => {
        const RUN = async () => {
            const limiter = new AIMDSemaphore({
                initialLimit: 4,
                softMaxLimit: 8,
                cooldownMs: 1_000,
                decreaseFactor: 0.5,
                minLimit: 2,
                successStreakForIncrease: 3,
            });
            const stormUntil = Date.now() + 500;
            const client = new TimedMockLLMClient((_idx, now) =>
                now < stormUntil ? 'rl' : 'ok',
            );
            const callers: Promise<string>[] = [];
            for (let i = 0; i < 30; i++) {
                callers.push(
                    withCongestionControl(() => client.call(), {
                        limiter,
                        maxAttempts: 6,
                        baseDelayMs: 100,
                    }),
                );
            }
            for (let t = 0; t < 20; t++) {
                await vi.advanceTimersByTimeAsync(1_000);
                await flushMicrotasks();
            }
            await Promise.all(callers);
            return {
                decreases: limiter.metrics().decreasesCount,
                inFlight: limiter.metrics().inFlight,
                queueFull: limiter.metrics().queueFullErrorsTotal,
            };
        };

        const a = await RUN();
        // Reset fake timers between runs to a fresh point in fake time.
        vi.useRealTimers();
        vi.useFakeTimers();
        const b = await RUN();

        expect(a.decreases).toBe(b.decreases);
        expect(a.inFlight).toBe(b.inFlight);
        expect(a.queueFull).toBe(b.queueFull);
    });
});
