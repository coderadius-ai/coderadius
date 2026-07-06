/**
 * Throttled progress reporting + event-loop yielding for long synchronous loops.
 *
 * Long CPU-bound loops starve the event loop: timer-driven UI (the listr2
 * spinner advances via a 100ms setInterval) freezes on a single frame even
 * though the throttled `task.output` repaints still happen synchronously
 * (listr2 emits SHOULD_REFRESH_RENDER in the same call stack). `tick()`
 * throttles the report callback by item count and wall time, and
 * periodically yields one macrotask so starved timers (spinner animation,
 * signal handlers) get a chance to fire.
 */
export interface ProgressHeartbeatOptions {
    /** Fire the report callback every N items (count path). */
    everyItems?: number;
    /** Fire the report callback when this much wall time elapsed since the last report. */
    everyMs?: number;
    /** Yield one macrotask to the event loop at most this often. */
    yieldEveryMs?: number;
}

export class ProgressHeartbeat {
    private readonly everyItems: number;
    private readonly everyMs: number;
    private readonly yieldEveryMs: number;
    private lastReportAt = Date.now();
    private lastYieldAt = Date.now();

    constructor(options: ProgressHeartbeatOptions = {}) {
        this.everyItems = options.everyItems ?? 200;
        this.everyMs = options.everyMs ?? 1500;
        this.yieldEveryMs = options.yieldEveryMs ?? 100;
    }

    /** Call once per loop iteration; `itemIndex` is the 1-based progress counter. */
    async tick(itemIndex: number, report: () => void): Promise<void> {
        const now = Date.now();
        const reportDueByCount = itemIndex > 0 && itemIndex % this.everyItems === 0;
        if (reportDueByCount || now - this.lastReportAt >= this.everyMs) {
            report();
            this.lastReportAt = now;
        }
        if (now - this.lastYieldAt >= this.yieldEveryMs) {
            await new Promise<void>(resolve => setImmediate(resolve));
            this.lastYieldAt = Date.now();
        }
    }
}
