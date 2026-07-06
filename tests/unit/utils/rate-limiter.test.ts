import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    AdaptiveRateLimiter,
    buildRateLimiterOptionsFromEnv,
    getDefaultRateLimiter,
    resetDefaultRateLimitersForTests,
} from '../../../src/utils/rate-limiter.js';

describe('AdaptiveRateLimiter — token bucket', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('disabled limiter is a transparent no-op (take always immediate)', async () => {
        const l = new AdaptiveRateLimiter({ disabled: true, initialRpm: 1, minRpm: 1, maxRpm: 1 });
        for (let i = 0; i < 50; i++) await l.take();
        expect(l.stats().disabled).toBe(true);
    });

    it('grants the first `burst` tokens immediately, then throttles to the rate', async () => {
        // rpm 60 → 1 token/s; burst = ceil(60*5/60) = 5.
        const l = new AdaptiveRateLimiter({ initialRpm: 60, minRpm: 60, maxRpm: 60, burstSeconds: 5 });
        expect(l.stats().burst).toBe(5);

        for (let i = 0; i < 5; i++) await l.take(); // drains the bucket, no wait

        let sixthResolved = false;
        void l.take().then(() => { sixthResolved = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(sixthResolved).toBe(false);
        await vi.advanceTimersByTimeAsync(1000); // one token refills at 60 rpm
        expect(sixthResolved).toBe(true);
    });

    it('refills continuously over time', async () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 60, minRpm: 60, maxRpm: 60, burstSeconds: 5 });
        for (let i = 0; i < 5; i++) await l.take();
        await vi.advanceTimersByTimeAsync(3000); // 3 tokens back
        expect(Math.floor(l.stats().available)).toBe(3);
    });

    it('serves queued waiters in FIFO order', async () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 60, minRpm: 60, maxRpm: 60, burstSeconds: 1 });
        await l.take(); // burst = 1, bucket now empty
        const order: number[] = [];
        void l.take().then(() => order.push(1));
        void l.take().then(() => order.push(2));
        void l.take().then(() => order.push(3));
        await vi.advanceTimersByTimeAsync(3000); // 3 tokens over 3s at 60 rpm
        expect(order).toEqual([1, 2, 3]);
    });

    it('a queued take rejects on abort and detaches its listener', async () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 60, minRpm: 60, maxRpm: 60, burstSeconds: 1 });
        await l.take(); // empty the bucket
        const ac = new AbortController();
        const rejected = l.take(ac.signal);
        ac.abort(new Error('shutdown'));
        await expect(rejected).rejects.toThrow('shutdown');
        expect(l.stats().queued).toBe(0);
    });

    it('PIN B1: burst is never below 1 at a low rpm (no deadlock)', async () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 6, minRpm: 6, maxRpm: 6, burstSeconds: 5 });
        expect(l.stats().burst).toBe(1); // ceil(6*5/60)=ceil(0.5)=1, NOT 0
        await l.take(); // the single token is grantable
        let next = false;
        void l.take().then(() => { next = true; });
        await vi.advanceTimersByTimeAsync(9999);
        expect(next).toBe(false);
        await vi.advanceTimersByTimeAsync(1); // 10s total → 1 token at 6 rpm
        expect(next).toBe(true);
    });
});

describe('AdaptiveRateLimiter — slow-start → AIMD controller', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('slow-start doubles the rate every success window until the first 429', () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 60, maxRpm: 6000, successStreak: 2 });
        expect(l.stats().rpm).toBe(60);
        l.recordSuccess(); l.recordSuccess(); // window → ×2
        expect(l.stats().rpm).toBe(120);
        l.recordSuccess(); l.recordSuccess();
        expect(l.stats().rpm).toBe(240);
        expect(l.stats().phase).toBe('slow-start');
    });

    it('the first 429 switches to avoidance and decreases multiplicatively', () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 1000, minRpm: 6, maxRpm: 6000, decreaseFactor: 0.5 });
        l.recordRateLimit();
        expect(l.stats().phase).toBe('avoidance');
        expect(l.stats().rpm).toBe(500);
    });

    it('PIN G2: only one decrease per cooldown window (stragglers ignored)', async () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 1000, minRpm: 6, maxRpm: 6000, cooldownMs: 5000 });
        l.recordRateLimit(); // 1000 → 500, freeze 5s
        l.recordRateLimit(); // straggler inside window → ignored
        l.recordRateLimit();
        expect(l.stats().rpm).toBe(500);
        await vi.advanceTimersByTimeAsync(5000);
        l.recordRateLimit(); // window elapsed → 500 → 250
        expect(l.stats().rpm).toBe(250);
    });

    it('avoidance increases additively on a success streak (not while frozen)', async () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 1000, minRpm: 6, maxRpm: 6000, decreaseFactor: 0.5, increaseStepRpm: 12, successStreak: 2, cooldownMs: 5000 });
        l.recordRateLimit(); // → 500, avoidance, frozen 5s
        l.recordSuccess(); l.recordSuccess(); // frozen → no increase
        expect(l.stats().rpm).toBe(500);
        await vi.advanceTimersByTimeAsync(5000);
        l.recordSuccess(); l.recordSuccess(); // → +12
        expect(l.stats().rpm).toBe(512);
    });

    it('respects the floor and the ceiling', () => {
        const floored = new AdaptiveRateLimiter({ initialRpm: 10, minRpm: 8, maxRpm: 6000, decreaseFactor: 0.5 });
        floored.recordRateLimit(); // floor(10*0.5)=5 → clamped to minRpm 8
        expect(floored.stats().rpm).toBe(8);

        const capped = new AdaptiveRateLimiter({ initialRpm: 100, minRpm: 6, maxRpm: 150, successStreak: 1 });
        capped.recordSuccess(); // slow-start ×2 = 200 → clamped to 150
        expect(capped.stats().rpm).toBe(150);
    });

    it('emits onRateChange events with reasons', () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 100, minRpm: 6, maxRpm: 6000, successStreak: 1 });
        const events: string[] = [];
        l.onRateChange(e => events.push(e.reason));
        l.recordSuccess();       // slow-start
        l.recordRateLimit();     // decrease
        expect(events).toEqual(['slow-start', 'decrease']);
    });
});

describe('AdaptiveRateLimiter — rolling-window dead-quota breaker (H3)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function pinToFloor(l: AdaptiveRateLimiter) {
        // Drive enough gated decreases (one per cooldown window) to reach the floor.
        for (let i = 0; i < 12; i++) {
            l.recordRateLimit();
            vi.advanceTimersByTime(5000);
        }
    }

    it('trips when pinned at the floor with a high 429 ratio for long enough', () => {
        const l = new AdaptiveRateLimiter({
            initialRpm: 1000, minRpm: 6, maxRpm: 6000, cooldownMs: 5000,
            windowMs: 120_000, failFastFloorMs: 30_000, failFastRatio: 0.8, failFastMinSamples: 5,
        });
        pinToFloor(l);
        expect(l.stats().rpm).toBe(6);
        // Sporadic successes keep ratio below 1 but above 0.8 → still trips
        // (the consecutive-streak breaker would NOT, this is the H3 win).
        l.recordSuccess();
        vi.advanceTimersByTime(35_000);
        l.recordRateLimit(); vi.advanceTimersByTime(5000);
        l.recordRateLimit();
        expect(l.shouldFailFast()).toBe(true);
    });

    it('does not trip when the rate is above the floor', () => {
        const l = new AdaptiveRateLimiter({ initialRpm: 1000, minRpm: 6, maxRpm: 6000, failFastFloorMs: 1000 });
        l.recordRateLimit(); // 500, well above floor
        vi.advanceTimersByTime(2000);
        expect(l.shouldFailFast()).toBe(false);
    });

    it('does not trip when successes dominate the window (low 429 ratio)', () => {
        const l = new AdaptiveRateLimiter({
            initialRpm: 1000, minRpm: 6, maxRpm: 6000, cooldownMs: 5000,
            failFastFloorMs: 10_000, failFastRatio: 0.8, failFastMinSamples: 5,
        });
        pinToFloor(l);
        vi.advanceTimersByTime(15_000);
        for (let i = 0; i < 50; i++) l.recordSuccess(); // ratio collapses
        expect(l.shouldFailFast()).toBe(false);
    });

    it('disabled limiter never trips', () => {
        const l = new AdaptiveRateLimiter({ disabled: true });
        l.recordRateLimit();
        expect(l.shouldFailFast()).toBe(false);
    });
});

describe('buildRateLimiterOptionsFromEnv', () => {
    it('PIN B2: LLM_RATE_RPM=0 disables (parsePositiveInt would have dropped it)', () => {
        const opts = buildRateLimiterOptionsFromEnv({ LLM_RATE_RPM: '0' } as NodeJS.ProcessEnv);
        expect(opts.disabled).toBe(true);
    });

    it('LLM_RATE_RPM=N sets a hard ceiling, not the initial', () => {
        const opts = buildRateLimiterOptionsFromEnv({ LLM_RATE_RPM: '200' } as NodeJS.ProcessEnv);
        expect(opts.maxRpm).toBe(200);
        expect(opts.disabled).toBeUndefined();
    });

    it('LLM_RATE_RPM as ceiling clamps initialRpm in the ctor (never starts above N)', () => {
        const l = new AdaptiveRateLimiter({ maxRpm: 30 }); // default initial 60 > 30
        expect(l.stats().rpm).toBe(30);
    });

    it('unset env → adaptive defaults (not disabled), but disabled under vitest', () => {
        expect(buildRateLimiterOptionsFromEnv({} as NodeJS.ProcessEnv).disabled).toBeUndefined();
        expect(buildRateLimiterOptionsFromEnv({ VITEST: '1' } as NodeJS.ProcessEnv).disabled).toBe(true);
    });

    it('an explicit LLM_RATE_* re-enables even under vitest', () => {
        const opts = buildRateLimiterOptionsFromEnv({ VITEST: '1', LLM_RATE_RPM: '300' } as NodeJS.ProcessEnv);
        expect(opts.disabled).toBeUndefined();
        expect(opts.maxRpm).toBe(300);
    });

    it('parses the numeric knobs and the decrease fraction', () => {
        const opts = buildRateLimiterOptionsFromEnv({
            LLM_RATE_INITIAL: '120', LLM_RATE_MIN: '10', LLM_RATE_MAX: '900',
            LLM_RATE_INCREASE_RPM: '24', LLM_RATE_SUCCESS_STREAK: '5',
            LLM_RATE_COOLDOWN_MS: '3000', LLM_RATE_BURST_SECONDS: '8',
            LLM_RATE_DECREASE_FACTOR: '0.25',
        } as NodeJS.ProcessEnv);
        expect(opts).toMatchObject({
            initialRpm: 120, minRpm: 10, maxRpm: 900,
            increaseStepRpm: 24, successStreak: 5,
            cooldownMs: 3000, burstSeconds: 8, decreaseFactor: 0.25,
        });
    });
});

describe('getDefaultRateLimiter — per-domain registry', () => {
    beforeEach(() => { resetDefaultRateLimitersForTests(); vi.useFakeTimers(); });
    afterEach(() => { resetDefaultRateLimitersForTests(); vi.useRealTimers(); });

    it('returns the same instance for the same domain, distinct across domains', () => {
        const a1 = getDefaultRateLimiter('vertex:gemini');
        const a2 = getDefaultRateLimiter('vertex:gemini');
        const b = getDefaultRateLimiter('openai:gpt');
        expect(a1).toBe(a2);
        expect(a1).not.toBe(b);
    });

    it('a 429 on one domain does not affect another', () => {
        const a = getDefaultRateLimiter('vertex:gemini');
        const b = getDefaultRateLimiter('openai:gpt');
        // Force both into a known adaptive state via explicit instances would be
        // cleaner, but here we assert isolation: decreasing A leaves B's rpm.
        const bRpm = b.stats().rpm;
        a.recordRateLimit();
        expect(b.stats().rpm).toBe(bRpm);
    });
});
