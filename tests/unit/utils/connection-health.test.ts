import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ConnectionHealthTracker,
    getConnectionHealth,
    resetConnectionHealthForTests,
} from '../../../src/utils/connection-health.js';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    resetConnectionHealthForTests();
});

describe('ConnectionHealthTracker', () => {
    it('counts consecutive failures and stamps the streak start', () => {
        const tracker = new ConnectionHealthTracker('vertex/model-a');
        expect(tracker.streak()).toEqual({ consecutive: 0, startedAt: 0 });

        const t0 = Date.now();
        tracker.recordFailure();
        tracker.recordFailure();
        tracker.recordFailure();

        const streak = tracker.streak();
        expect(streak.consecutive).toBe(3);
        expect(streak.startedAt).toBe(t0);
    });

    it('recordSuccess resets the streak', () => {
        const tracker = new ConnectionHealthTracker('vertex/model-a');
        tracker.recordFailure();
        tracker.recordFailure();
        tracker.recordSuccess();

        expect(tracker.streak()).toEqual({ consecutive: 0, startedAt: 0 });

        // A new failure starts a NEW streak (fresh startedAt).
        vi.advanceTimersByTime(5_000);
        const t1 = Date.now();
        tracker.recordFailure();
        expect(tracker.streak()).toEqual({ consecutive: 1, startedAt: t1 });
    });

    it('tryClaimProbe grants one slot per interval', () => {
        const tracker = new ConnectionHealthTracker('vertex/model-a');

        expect(tracker.tryClaimProbe(30_000)).toBe(true);
        expect(tracker.tryClaimProbe(30_000)).toBe(false);

        vi.advanceTimersByTime(29_000);
        expect(tracker.tryClaimProbe(30_000)).toBe(false);

        vi.advanceTimersByTime(1_500);
        expect(tracker.tryClaimProbe(30_000)).toBe(true);
    });

    it('a success re-arms the probe clock for the next outage', () => {
        const tracker = new ConnectionHealthTracker('vertex/model-a');
        expect(tracker.tryClaimProbe(30_000)).toBe(true);

        // Endpoint recovers, then a fresh outage starts seconds later: the
        // first probe of the NEW outage must not be blocked by the previous
        // outage's probe clock.
        tracker.recordSuccess();
        vi.advanceTimersByTime(1_000);
        tracker.recordFailure();
        expect(tracker.tryClaimProbe(30_000)).toBe(true);
    });
});

describe('connection-health registry', () => {
    it('returns the same tracker for the same domain, separate per domain', () => {
        const a1 = getConnectionHealth('vertex/model-a');
        const a2 = getConnectionHealth('vertex/model-a');
        const b = getConnectionHealth('openai/model-b');

        expect(a1).toBe(a2);
        expect(b).not.toBe(a1);

        a1.recordFailure();
        expect(a2.streak().consecutive).toBe(1);
        expect(b.streak().consecutive).toBe(0);
    });

    it('defaults to the global domain when none is given', () => {
        expect(getConnectionHealth()).toBe(getConnectionHealth('global'));
    });

    it('resetConnectionHealthForTests clears all trackers', () => {
        getConnectionHealth('vertex/model-a').recordFailure();
        resetConnectionHealthForTests();
        expect(getConnectionHealth('vertex/model-a').streak().consecutive).toBe(0);
    });
});
