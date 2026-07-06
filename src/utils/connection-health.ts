/**
 * Per-quota-domain endpoint health tracking for connection-level failures.
 *
 * Connection errors (refused/reset sockets, DNS, dead network) are
 * endpoint-global: when one call cannot open a socket, neither can the next.
 * Each quota domain tracks its fleet-wide consecutive connection failures so
 * the breaker in `congestion-control.ts` can fail fast instead of letting
 * every queued call rediscover the same dead endpoint through its own queue
 * wait and timeout (observed in production: a 3.5h network outage where ~1000
 * calls each burned 23-136 minutes before reaching their fallback).
 *
 * Mirrors the AIMDSemaphore quota-streak / probe-claim API so the two breaker
 * families read identically at the call site.
 */

export interface ConnectionStreak {
    /** Consecutive recordFailure() calls with no recordSuccess() in between. */
    consecutive: number;
    /** Epoch ms of the first failure in the current streak (0 when healthy). */
    startedAt: number;
}

export class ConnectionHealthTracker {
    private consecutive = 0;
    private startedAt = 0;
    private lastProbeAt = 0;

    constructor(public readonly domain: string) {}

    recordFailure(): void {
        if (this.consecutive === 0) this.startedAt = Date.now();
        this.consecutive++;
    }

    /**
     * Any success proves the endpoint is reachable: streak AND probe clock
     * reset, so a fresh outage gets an immediate first probe instead of
     * inheriting the previous outage's probe cadence.
     */
    recordSuccess(): void {
        this.consecutive = 0;
        this.startedAt = 0;
        this.lastProbeAt = 0;
    }

    streak(): ConnectionStreak {
        return { consecutive: this.consecutive, startedAt: this.startedAt };
    }

    /**
     * Claim the half-open probe slot: returns true at most once per
     * `intervalMs`. While the circuit is open, the claimant still executes
     * its call (probing whether the endpoint is back); everyone else fails
     * fast with `EndpointUnreachableError`.
     */
    tryClaimProbe(intervalMs: number): boolean {
        const now = Date.now();
        if (this.lastProbeAt !== 0 && now - this.lastProbeAt < intervalMs) return false;
        this.lastProbeAt = now;
        return true;
    }
}

// ─── Per-domain registry ─────────────────────────────────────────────────────

const registry = new Map<string, ConnectionHealthTracker>();

/**
 * Tracker for a quota domain (`{provider}:{model}`, same key space as the
 * rate-limiter registry). Independent endpoints get independent circuits: a
 * dead local model must not block a healthy cloud fallback, and vice versa.
 */
export function getConnectionHealth(domain = 'global'): ConnectionHealthTracker {
    let tracker = registry.get(domain);
    if (!tracker) {
        tracker = new ConnectionHealthTracker(domain);
        registry.set(domain, tracker);
    }
    return tracker;
}

export function resetConnectionHealthForTests(): void {
    registry.clear();
}
