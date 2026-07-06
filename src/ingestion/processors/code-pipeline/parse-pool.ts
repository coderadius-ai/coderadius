import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type {
    ParsePoolOutcome,
    ParseWorkTask,
    ParseWorkerInit,
    WorkerOutMessage,
} from './parse-protocol.js';

// ─── Parse Pool ──────────────────────────────────────────────────────────────
//
// Minimal hand-rolled worker pool over node:worker_threads (no external pool
// library). N persistent workers pull tasks from a shared queue; outcomes are
// reassembled in SUBMISSION ORDER so every downstream cross-file pass stays
// deterministic regardless of completion order.
//
// Failure semantics: a per-task error (or a worker crash while processing a
// file) yields a failure outcome for THAT file only — the pool keeps going,
// the caller marks the file incomplete. Crashed workers are replaced; a
// worker that dies before ever becoming ready twice in a row aborts the run
// (the environment is broken, not the file).
//
// Hang protection: a lost IPC response must never stall the run. Two nets:
//   1. 'messageerror' (structured-clone deserialization failure on receive)
//      fails the in-flight task immediately and frees the worker.
//   2. A watchdog terminates any worker holding a task past taskTimeoutMs
//      (silently dead worker / wedged native call); the exit path then fails
//      the file and spawns a replacement.
// ─────────────────────────────────────────────────────────────────────────────

// Bun (production CLI) loads the TS worker entry natively — the path the
// feasibility spike validated. Node parents (vitest test processes; workers
// inherit the parent runtime) go through the .mjs bootstrap, which bridges
// tsc-style `.js` → `.ts` specifier resolution before importing the worker.
const WORKER_PATH = process.versions.bun
    ? fileURLToPath(new URL('./parse-worker.ts', import.meta.url))
    : fileURLToPath(new URL('./parse-worker-boot.mjs', import.meta.url));

/** Non-erasable TS syntax in the worker graph (enums) needs the transform
 *  flag when the runtime is Node; Bun needs nothing. */
const WORKER_EXEC_ARGV = process.versions.bun ? undefined : ['--experimental-transform-types', '--no-warnings'];

/** PARSE_CONCURRENCY env override; defaults to cores-1 (parse is CPU-bound). */
export function resolveParseConcurrency(): number {
    const fromEnv = parseInt(process.env.PARSE_CONCURRENCY || '', 10);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return Math.max(1, os.cpus().length - 1);
}

interface PoolWorker {
    worker: Worker;
    ready: boolean;
    current: ParseWorkTask | null;
    /** Timestamp of the last task assignment (watchdog reference point). */
    assignedAt: number;
    lastError: string | null;
}

interface RunState {
    queue: ParseWorkTask[];
    outcomes: ParsePoolOutcome[];
    positionByTaskId: Map<number, number>;
    completed: number;
    total: number;
    onProgress?: (completed: number, total: number) => void;
    resolve: (outcomes: ParsePoolOutcome[]) => void;
    reject: (err: Error) => void;
}

export interface ParsePoolOptions {
    size: number;
    init: ParseWorkerInit;
    signal?: AbortSignal;
    /** Worker entry override (tests). */
    workerPath?: string;
    /**
     * Per-task response deadline. A worker holding a task past this is
     * silently dead (lost IPC response, wedged native call): it is
     * terminated, the file fails over to the INCOMPLETE path, and a
     * replacement spawns. Generous default — the 1MB parse cap keeps real
     * files orders of magnitude below it.
     */
    taskTimeoutMs?: number;
}

const DEFAULT_TASK_TIMEOUT_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 5_000;

export class ParsePool {
    private readonly size: number;
    private readonly init: ParseWorkerInit;
    private readonly signal?: AbortSignal;
    private readonly workerPath: string;
    private readonly taskTimeoutMs: number;
    private workers: PoolWorker[] = [];
    private run_: RunState | null = null;
    private destroyed = false;
    private consecutivePreReadyDeaths = 0;
    private watchdog: ReturnType<typeof setInterval> | null = null;
    private readonly onAbort = () => {
        const state = this.run_;
        this.run_ = null;
        void this.destroy();
        state?.reject(new Error('Parse pool aborted'));
    };

    constructor(options: ParsePoolOptions) {
        this.size = Math.max(1, options.size);
        this.init = options.init;
        this.signal = options.signal;
        this.workerPath = options.workerPath ?? WORKER_PATH;
        this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
        this.signal?.addEventListener('abort', this.onAbort, { once: true });
    }

    /**
     * Process `tasks` and resolve with outcomes aligned to the input order.
     * Runs are sequential: a second run() may reuse the same workers, but
     * calling run() while one is in flight is a programming error.
     */
    run(
        tasks: ParseWorkTask[],
        onProgress?: (completed: number, total: number) => void,
    ): Promise<ParsePoolOutcome[]> {
        if (this.run_) throw new Error('ParsePool.run() is not reentrant');
        if (this.destroyed) throw new Error('ParsePool already destroyed');
        if (this.signal?.aborted) return Promise.reject(new Error('Parse pool aborted'));
        if (tasks.length === 0) return Promise.resolve([]);

        const positionByTaskId = new Map<number, number>();
        tasks.forEach((task, index) => {
            if (positionByTaskId.has(task.taskId)) {
                throw new Error(`Duplicate taskId ${task.taskId} in parse pool run`);
            }
            positionByTaskId.set(task.taskId, index);
        });

        return new Promise<ParsePoolOutcome[]>((resolve, reject) => {
            this.run_ = {
                queue: [...tasks],
                outcomes: new Array<ParsePoolOutcome>(tasks.length),
                positionByTaskId,
                completed: 0,
                total: tasks.length,
                onProgress,
                resolve,
                reject,
            };
            this.ensureWorkers(tasks.length);
            for (const pw of this.workers) {
                if (pw.ready && !pw.current) this.assignNext(pw);
            }
        });
    }

    /** Terminate all workers. Safe to call multiple times. */
    async destroy(): Promise<void> {
        this.destroyed = true;
        this.signal?.removeEventListener('abort', this.onAbort);
        if (this.watchdog) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
        const workers = this.workers;
        this.workers = [];
        await Promise.all(workers.map(pw => pw.worker.terminate().catch(() => undefined)));
    }

    private ensureWorkers(taskCount: number): void {
        const target = Math.min(this.size, taskCount);
        while (this.workers.length < target) this.spawnWorker();
    }

    private spawnWorker(): void {
        const worker = new Worker(this.workerPath, {
            workerData: this.init,
            ...(WORKER_EXEC_ARGV ? { execArgv: WORKER_EXEC_ARGV } : {}),
        });
        const pw: PoolWorker = { worker, ready: false, current: null, assignedAt: 0, lastError: null };
        this.workers.push(pw);

        worker.on('message', (msg: WorkerOutMessage) => this.onMessage(pw, msg));
        worker.on('error', (err: Error) => {
            pw.lastError = err.message;
        });
        // The in-flight response failed to deserialize on this side: without
        // this handler the task would never complete and the run would hang.
        worker.on('messageerror', (err: Error) => this.onLostResponse(pw, `worker response lost: ${err.message}`));
        worker.on('exit', () => this.onExit(pw));
        this.ensureWatchdog();
    }

    private ensureWatchdog(): void {
        if (this.watchdog) return;
        const interval = Math.min(WATCHDOG_INTERVAL_MS, this.taskTimeoutMs);
        this.watchdog = setInterval(() => this.reapStalledWorkers(), interval);
        // Never keep the host process alive just for the watchdog.
        (this.watchdog as { unref?: () => void }).unref?.();
    }

    /** Terminate workers that have held a task past the deadline; the exit
     *  path fails the file and spawns a replacement. */
    private reapStalledWorkers(): void {
        const now = Date.now();
        for (const pw of [...this.workers]) {
            if (!pw.current || now - pw.assignedAt < this.taskTimeoutMs) continue;
            pw.lastError = `no response within ${this.taskTimeoutMs}ms (task ${pw.current.relativePath})`;
            void pw.worker.terminate().catch(() => undefined);
        }
    }

    private onLostResponse(pw: PoolWorker, error: string): void {
        const task = pw.current;
        if (!task) return;
        pw.current = null;
        this.recordOutcome(task.taskId, {
            ok: false,
            taskId: task.taskId,
            relativePath: task.relativePath,
            error,
        });
        this.assignNext(pw);
    }

    private onMessage(pw: PoolWorker, msg: WorkerOutMessage): void {
        if (msg.kind === 'ready') {
            pw.ready = true;
            this.consecutivePreReadyDeaths = 0;
            this.assignNext(pw);
            return;
        }
        pw.current = null;
        if (msg.kind === 'result') {
            this.recordOutcome(msg.result.taskId, { ok: true, result: msg.result });
        } else {
            this.recordOutcome(msg.taskId, {
                ok: false,
                taskId: msg.taskId,
                relativePath: msg.relativePath,
                error: msg.error,
            });
        }
        this.assignNext(pw);
    }

    private onExit(pw: PoolWorker): void {
        const index = this.workers.indexOf(pw);
        if (index === -1 || this.destroyed) return;
        this.workers.splice(index, 1);

        if (!pw.ready) {
            this.consecutivePreReadyDeaths++;
            if (this.consecutivePreReadyDeaths >= 2) {
                this.failRun(new Error(`Parse worker failed to start: ${pw.lastError ?? 'unknown error'}`));
                return;
            }
        }

        const task = pw.current;
        if (task) {
            this.recordOutcome(task.taskId, {
                ok: false,
                taskId: task.taskId,
                relativePath: task.relativePath,
                error: `parse worker crashed: ${pw.lastError ?? 'worker exited unexpectedly'}`,
            });
        }
        if (this.run_ && (this.run_.queue.length > 0 || this.workers.length === 0)) {
            this.spawnWorker();
        }
    }

    private assignNext(pw: PoolWorker): void {
        const state = this.run_;
        if (!state || pw.current || !pw.ready) return;
        const task = state.queue.shift();
        if (!task) return;
        pw.current = task;
        pw.assignedAt = Date.now();
        pw.worker.postMessage({ kind: 'task', task });
    }

    private recordOutcome(taskId: number, outcome: ParsePoolOutcome): void {
        const state = this.run_;
        if (!state) return;
        const position = state.positionByTaskId.get(taskId);
        if (position === undefined || state.outcomes[position] !== undefined) return;
        state.outcomes[position] = outcome;
        state.completed++;
        state.onProgress?.(state.completed, state.total);
        if (state.completed === state.total) {
            this.run_ = null;
            state.resolve(state.outcomes);
        }
    }

    private failRun(err: Error): void {
        const state = this.run_;
        this.run_ = null;
        state?.reject(err);
    }
}
