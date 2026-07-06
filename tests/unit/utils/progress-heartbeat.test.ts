import { describe, expect, it } from 'vitest';

import { ProgressHeartbeat } from '../../../src/utils/progress-heartbeat.js';

describe('ProgressHeartbeat', () => {
    it('reports every N items when the time threshold is not reached', async () => {
        const heartbeat = new ProgressHeartbeat({ everyItems: 3, everyMs: 60_000, yieldEveryMs: 60_000 });
        const reported: number[] = [];

        for (let i = 1; i <= 10; i++) {
            await heartbeat.tick(i, () => reported.push(i));
        }

        expect(reported).toEqual([3, 6, 9]);
    });

    it('never reports at item 0 on the count path', async () => {
        const heartbeat = new ProgressHeartbeat({ everyItems: 3, everyMs: 60_000, yieldEveryMs: 60_000 });
        let reports = 0;

        await heartbeat.tick(0, () => reports++);

        expect(reports).toBe(0);
    });

    it('reports when the wall-time threshold elapses regardless of item count', async () => {
        const heartbeat = new ProgressHeartbeat({ everyItems: 1_000_000, everyMs: 0, yieldEveryMs: 60_000 });
        let reports = 0;

        await heartbeat.tick(1, () => reports++);
        await heartbeat.tick(2, () => reports++);

        expect(reports).toBe(2);
    });

    it('yields one macrotask so starved timers can fire', async () => {
        const heartbeat = new ProgressHeartbeat({ everyItems: 1, everyMs: 60_000, yieldEveryMs: 0 });
        let macrotaskRan = false;
        setImmediate(() => { macrotaskRan = true; });

        await heartbeat.tick(1, () => undefined);

        expect(macrotaskRan).toBe(true);
    });

    it('does not yield before the yield threshold elapses', async () => {
        const heartbeat = new ProgressHeartbeat({ everyItems: 1, everyMs: 60_000, yieldEveryMs: 60_000 });
        let macrotaskRan = false;
        setImmediate(() => { macrotaskRan = true; });

        await heartbeat.tick(1, () => undefined);

        expect(macrotaskRan).toBe(false);
    });
});
