import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ShutdownController,
    ShutdownAbortError,
    getRootShutdownController,
    resetRootShutdownControllerForTests,
} from '../../../src/utils/shutdown.js';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    resetRootShutdownControllerForTests();
    // Ensure no stray handlers leak across tests.
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
});

async function flushMicrotasks(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe('ShutdownController — basic state', () => {
    it('starts not aborted, no signals seen, no hooks (#1)', () => {
        const c = new ShutdownController();
        const s = c.state();
        expect(s.aborted).toBe(false);
        expect(s.signalCount).toBe(0);
        expect(s.hooksRegistered).toBe(0);
        expect(c.signal.aborted).toBe(false);
    });

    it('requestShutdown aborts the signal and runs hooks (#2)', async () => {
        const c = new ShutdownController();
        const callOrder: string[] = [];
        c.register({ name: 'a', fn: () => { callOrder.push('a'); } });
        c.register({ name: 'b', fn: async () => { callOrder.push('b'); } });

        await c.requestShutdown('manual');

        expect(c.signal.aborted).toBe(true);
        expect(callOrder.sort()).toEqual(['a', 'b']);
        expect(c.state().signalCount).toBe(1);
    });

    it('a hook throwing does not block the others (#3)', async () => {
        const c = new ShutdownController();
        const calls: string[] = [];
        c.register({ name: 'crashy', fn: async () => { throw new Error('boom'); } });
        c.register({ name: 'ok', fn: async () => { calls.push('ok'); } });

        await c.requestShutdown('manual');
        expect(calls).toEqual(['ok']);
    });

    it('a hook exceeding its timeout is skipped (#4)', async () => {
        const c = new ShutdownController();
        const callOrder: string[] = [];
        c.register({
            name: 'slow',
            timeoutMs: 50,
            fn: async () => {
                await new Promise(r => setTimeout(r, 10_000));
                callOrder.push('slow-finished'); // should never reach
            },
        });
        c.register({
            name: 'fast',
            fn: async () => { callOrder.push('fast'); },
        });

        const promise = c.requestShutdown('manual');
        await vi.advanceTimersByTimeAsync(2_000);
        await promise;

        expect(callOrder).toEqual(['fast']);
    });
});

describe('ShutdownController — process signal handling', () => {
    it('install registers SIGINT and SIGTERM listeners (#5)', () => {
        const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
        const c = new ShutdownController();
        c.install(1000);
        const after = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
        expect(after).toBe(before + 2);

        // Idempotency: calling install again should not add more listeners.
        c.install(1000);
        const afterTwice = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
        expect(afterTwice).toBe(after);
    });

    it('first SIGINT triggers graceful abort + hook run (#6)', async () => {
        const c = new ShutdownController();
        const calls: string[] = [];
        c.register({ name: 'hook', fn: () => { calls.push('hook'); } });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            calls.push(`exit-${code}`);
            return undefined as never;
        }) as typeof process.exit);

        c.install(1000);
        process.emit('SIGINT' as never);

        await vi.advanceTimersByTimeAsync(2_000);
        await flushMicrotasks();

        expect(c.signal.aborted).toBe(true);
        expect(calls).toEqual(['hook', 'exit-130']);
        exitSpy.mockRestore();
    });

    it('second SIGINT within grace bypasses cleanup (#7)', async () => {
        const c = new ShutdownController();
        const calls: string[] = [];
        c.register({
            name: 'slow',
            fn: async () => {
                await new Promise(r => setTimeout(r, 10_000));
                calls.push('slow-finished');
            },
            timeoutMs: 5_000,
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            calls.push(`exit-${code}`);
            return undefined as never;
        }) as typeof process.exit);

        c.install(1000);
        process.emit('SIGINT' as never);
        // Immediately a second SIGINT — should force exit without waiting for the slow hook.
        process.emit('SIGINT' as never);

        await flushMicrotasks();

        // The forced exit must have happened (at least one exit-130 in calls).
        expect(calls).toContain('exit-130');
        expect(calls).not.toContain('slow-finished');
        expect(c.state().signalCount).toBeGreaterThanOrEqual(2);

        exitSpy.mockRestore();
    });

    it('GREEN-guard: install is idempotent across instances of the singleton (#8)', () => {
        const a = getRootShutdownController();
        a.install(1000);
        const initial = process.listenerCount('SIGINT');
        const b = getRootShutdownController();
        b.install(1000);
        // Same instance → no additional listeners.
        expect(b).toBe(a);
        expect(process.listenerCount('SIGINT')).toBe(initial);
    });
});

describe('ShutdownAbortError', () => {
    it('is thrown with a meaningful reason', () => {
        const err = new ShutdownAbortError('manual');
        expect(err.code).toBe('SHUTDOWN_ABORTED');
        expect(err.reason).toBe('manual');
        expect(err.message).toContain('manual');
    });
});
