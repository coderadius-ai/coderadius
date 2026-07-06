/**
 * ShutdownController — process-wide graceful-shutdown coordinator.
 *
 * Wraps an `AbortController` whose `signal` is propagated through the
 * pipeline so long-running operations (LLM backoff sleeps, AIMD queue
 * waiters, file batches) can fail-fast on Ctrl+C instead of waiting for
 * naturally-scheduled timers to expire.
 *
 * Behavior on `install(graceMs)`:
 *
 *   - 1st SIGINT/SIGTERM →
 *       controller.abort('SIGINT') →
 *       runHooks(graceMs) (parallel, each bounded by hook.timeoutMs ?? graceMs) →
 *       process.exit(130).
 *       Stderr message: "Shutting down… (Ctrl+C again to force)".
 *   - 2nd SIGINT/SIGTERM (any time after the first) →
 *       process.exit(130) immediately, bypassing remaining cleanup.
 *       Stderr message: "Force exit.".
 *   - install() is idempotent: calling it twice does NOT register extra
 *     listeners on `process`.
 *
 * Hooks are registered via `register({ name, fn, timeoutMs? })`. Each hook
 * runs concurrently with the others; an exception in one does not block
 * the rest. A hook that exceeds its `timeoutMs` (or graceMs if unset) is
 * abandoned (not awaited).
 */

import { logger } from './logger.js';

export interface CleanupHook {
    /** Short identifier used in logs. */
    name: string;
    /**
     * Called on shutdown with the abort signal. May be async.
     * Throwing or hanging does not block other hooks.
     */
    fn: (signal: AbortSignal) => Promise<void> | void;
    /**
     * Per-hook timeout. If the hook does not settle in this many ms it is
     * skipped. Defaults to the controller's `graceMs`.
     */
    timeoutMs?: number;
}

export class ShutdownAbortError extends Error {
    code = 'SHUTDOWN_ABORTED' as const;
    constructor(public reason: string = 'aborted') {
        super(`shutdown aborted: ${reason}`);
        this.name = 'ShutdownAbortError';
    }
}

interface ShutdownState {
    aborted: boolean;
    signalCount: number;
    hooksRegistered: number;
}

export class ShutdownController {
    private controller = new AbortController();
    private hooks: CleanupHook[] = [];
    private signalCount = 0;
    private installed = false;
    private graceMs = 1000;
    private signalListener?: () => void;

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    state(): ShutdownState {
        return {
            aborted: this.controller.signal.aborted,
            signalCount: this.signalCount,
            hooksRegistered: this.hooks.length,
        };
    }

    /**
     * Register a cleanup hook. Returns an unregister function.
     */
    register(hook: CleanupHook): () => void {
        this.hooks.push(hook);
        return () => {
            const idx = this.hooks.indexOf(hook);
            if (idx >= 0) this.hooks.splice(idx, 1);
        };
    }

    /**
     * Install SIGINT/SIGTERM handlers on `process`. Idempotent.
     */
    install(graceMs = 1000): void {
        if (this.installed) return;
        this.installed = true;
        this.graceMs = graceMs;
        const handler = () => this.handleSignal();
        this.signalListener = handler;
        process.on('SIGINT', handler);
        process.on('SIGTERM', handler);
    }

    /**
     * Trigger graceful shutdown manually (tests, programmatic).
     * Aborts the signal and runs cleanup hooks; does NOT call process.exit.
     */
    async requestShutdown(reason: string): Promise<void> {
        if (!this.controller.signal.aborted) {
            this.controller.abort(new ShutdownAbortError(reason));
        }
        this.signalCount++;
        await this.runHooks(this.graceMs);
    }

    private handleSignal(): void {
        this.signalCount++;
        if (this.signalCount === 1) {
            // First signal: graceful abort + cleanup, then exit.
            try {
                process.stderr.write('\nShutting down… (Ctrl+C again to force)\n');
            } catch {
                // stderr unavailable in some test envs
            }
            this.controller.abort(new ShutdownAbortError('SIGINT'));
            this.runHooks(this.graceMs).finally(() => {
                process.exit(130);
            });
        } else {
            // Second signal during grace window: force exit.
            try {
                process.stderr.write('Force exit.\n');
            } catch {
                // ignore
            }
            process.exit(130);
        }
    }

    private async runHooks(graceMs: number): Promise<void> {
        if (this.hooks.length === 0) return;
        const results = this.hooks.map(hook => this.runOneHook(hook, graceMs));
        await Promise.all(results);
    }

    private async runOneHook(hook: CleanupHook, graceMs: number): Promise<void> {
        const timeoutMs = hook.timeoutMs ?? graceMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<void>(resolve => {
            timer = setTimeout(() => {
                logger.warn?.(`[Shutdown] hook "${hook.name}" timed out after ${timeoutMs}ms; skipping`);
                resolve();
            }, timeoutMs);
        });
        const hookPromise = (async () => {
            try {
                await hook.fn(this.controller.signal);
            } catch (err) {
                logger.warn?.(`[Shutdown] hook "${hook.name}" threw: ${(err as Error).message}`);
            }
        })();
        try {
            await Promise.race([hookPromise, timeoutPromise]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let defaultInstance: ShutdownController | undefined;

export function getRootShutdownController(): ShutdownController {
    if (!defaultInstance) {
        defaultInstance = new ShutdownController();
    }
    return defaultInstance;
}

export function resetRootShutdownControllerForTests(): void {
    defaultInstance = undefined;
}
