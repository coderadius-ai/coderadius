import type {
    ParsePoolOutcome,
    ParseWorkTask,
    ParseWorkerInit,
    WorkerOutMessage,
} from './parse-protocol.js';

// ─── Process Parse Pool ──────────────────────────────────────────────────────
//
// A hand-rolled worker pool over CHILD PROCESSES (Bun.spawn) rather than
// node:worker_threads. Same contract as ParsePool — N persistent workers pull
// from a shared queue, outcomes reassembled in SUBMISSION ORDER — but each
// worker is its own OS process.
//
// Why processes: in a `bun build --compile` binary, tearing down a worker
// THREAD that holds many tree-sitter NAPI handles crashes the whole process
// (oven-sh/bun#30286). A child PROCESS has its own NAPI env; its exit/kill is
// reclaimed by the OS with no in-parent finalization, so teardown is crash-free
// while parsing stays parallel. The workers re-exec this same binary in worker
// mode (CR_PARSE_WORKER=1 → cli/index.ts → runParseWorkerProcess).
//
// Failure semantics mirror ParsePool: a per-task error or a worker crash fails
// THAT file only and keeps draining; a worker that dies before becoming ready
// twice in a row aborts the run (the environment is broken). A watchdog kills a
// worker that holds a task past the deadline (silently dead / wedged native
// call); the exit path fails the file and spawns a replacement.
//
// Init transport: a process has no `workerData`, so ParseWorkerInit is sent as
// the first IPC message; the worker replies `ready` only after applying it. Bun
// IPC uses structured clone, so the Map-bearing WorkerParseResult crosses as-is.
// ─────────────────────────────────────────────────────────────────────────────

export interface Subprocess {
    send: (message: unknown) => void;
    kill: (signal?: number | string) => void;
    readonly exited: Promise<number>;
}

export interface ProcessSpawnOptions {
    env: Record<string, string | undefined>;
    stdio: ['ignore', 'ignore', 'ignore'];
    serialization: 'advanced';
    ipc: (message: WorkerOutMessage) => void;
    onExit: () => void;
}

/** Spawn backend. Production: Bun.spawn. Tests inject an in-process fake. */
export type ProcessSpawn = (command: string[], options: ProcessSpawnOptions) => Subprocess;

/** Real backend — resolved lazily so the `Bun` global is only required at use
 *  time (it is absent under vitest, which injects its own spawn). */
const bunSpawn: ProcessSpawn = (command, options) =>
    (globalThis as { Bun: { spawn: (c: string[], o: ProcessSpawnOptions) => Subprocess } }).Bun.spawn(command, options);

interface ProcChild {
    proc: Subprocess;
    ready: boolean;
    current: ParseWorkTask | null;
    assignedAt: number;
    lastError: string | null;
    exited: boolean;
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

export interface ProcessParsePoolOptions {
    size: number;
    init: ParseWorkerInit;
    signal?: AbortSignal;
    taskTimeoutMs?: number;
    /** Spawn argv override (tests). Default: re-exec this binary in worker mode. */
    spawnCommand?: string[];
    /** Extra env for the spawned worker (tests). Merged over process.env. */
    spawnEnv?: Record<string, string>;
    /** Spawn backend override (tests). Default: Bun.spawn. */
    spawn?: ProcessSpawn;
}

const DEFAULT_TASK_TIMEOUT_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 5_000;
/** Grace for a worker to exit on `shutdown` before we SIGKILL it. */
const SHUTDOWN_GRACE_MS = 4_000;

export class ProcessParsePool {
    private readonly size: number;
    private readonly init: ParseWorkerInit;
    private readonly signal?: AbortSignal;
    private readonly taskTimeoutMs: number;
    private readonly spawnCommand: string[];
    private readonly spawnEnv: Record<string, string>;
    private readonly spawn: ProcessSpawn;
    private children: ProcChild[] = [];
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

    constructor(options: ProcessParsePoolOptions) {
        this.size = Math.max(1, options.size);
        this.init = options.init;
        this.signal = options.signal;
        this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
        this.spawnCommand = options.spawnCommand ?? [process.execPath];
        this.spawnEnv = { CR_PARSE_WORKER: '1', ...(options.spawnEnv ?? {}) };
        this.spawn = options.spawn ?? bunSpawn;
        this.signal?.addEventListener('abort', this.onAbort, { once: true });
    }

    /** Process `tasks`, resolving with outcomes aligned to the input order. */
    run(
        tasks: ParseWorkTask[],
        onProgress?: (completed: number, total: number) => void,
    ): Promise<ParsePoolOutcome[]> {
        if (this.run_) throw new Error('ProcessParsePool.run() is not reentrant');
        if (this.destroyed) throw new Error('ProcessParsePool already destroyed');
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
            this.ensureChildren(tasks.length);
            for (const child of this.children) {
                if (child.ready && !child.current) this.assignNext(child);
            }
        });
    }

    /** Stop all workers. Safe to call multiple times. */
    async destroy(): Promise<void> {
        this.destroyed = true;
        this.signal?.removeEventListener('abort', this.onAbort);
        if (this.watchdog) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
        const children = this.children;
        this.children = [];
        await Promise.all(children.map(child => this.stopChild(child)));
    }

    /**
     * Ask a worker to exit gracefully (drop the IPC channel cleanly), SIGKILL as
     * a fallback. Either path is crash-free for a separate process — unlike a
     * worker thread, there is no in-parent NAPI teardown.
     */
    private stopChild(child: ProcChild): Promise<void> {
        if (child.exited) return Promise.resolve();
        return new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                try { child.proc.kill(); } catch { /* already gone */ }
            }, SHUTDOWN_GRACE_MS);
            (timer as { unref?: () => void }).unref?.();
            void child.proc.exited.then(() => { clearTimeout(timer); resolve(); });
            try {
                child.proc.send({ kind: 'shutdown' });
            } catch {
                try { child.proc.kill(); } catch { /* already gone */ }
            }
        });
    }

    private ensureChildren(taskCount: number): void {
        const target = Math.min(this.size, taskCount);
        while (this.children.length < target) this.spawnChild();
    }

    private spawnChild(): void {
        const child: ProcChild = {
            proc: undefined as unknown as Subprocess,
            ready: false,
            current: null,
            assignedAt: 0,
            lastError: null,
            exited: false,
        };
        const proc = this.spawn(this.spawnCommand, {
            env: { ...process.env, ...this.spawnEnv },
            // stdin closed; stdout/stderr discarded — the binding loader probes
            // $bunfs before the sibling node_modules and logs a benign miss.
            stdio: ['ignore', 'ignore', 'ignore'],
            serialization: 'advanced',
            ipc: (message: WorkerOutMessage) => this.onMessage(child, message),
            onExit: () => {
                child.exited = true;
                this.onExit(child);
            },
        });
        child.proc = proc;
        this.children.push(child);
        // No workerData across processes: deliver init first; the worker replies
        // `ready` only after applying it (IPC is FIFO, so init precedes tasks).
        try {
            proc.send({ kind: 'init', init: this.init });
        } catch (err) {
            child.lastError = (err as Error).message;
        }
        this.ensureWatchdog();
    }

    private ensureWatchdog(): void {
        if (this.watchdog) return;
        const interval = Math.min(WATCHDOG_INTERVAL_MS, this.taskTimeoutMs);
        this.watchdog = setInterval(() => this.reapStalledChildren(), interval);
        (this.watchdog as { unref?: () => void }).unref?.();
    }

    /** Kill workers holding a task past the deadline; the exit path fails the
     *  file and spawns a replacement. */
    private reapStalledChildren(): void {
        const now = Date.now();
        for (const child of [...this.children]) {
            if (!child.current || now - child.assignedAt < this.taskTimeoutMs) continue;
            child.lastError = `no response within ${this.taskTimeoutMs}ms (task ${child.current.relativePath})`;
            try { child.proc.kill(); } catch { /* already gone */ }
        }
    }

    private onMessage(child: ProcChild, msg: WorkerOutMessage): void {
        if (msg.kind === 'ready') {
            child.ready = true;
            this.consecutivePreReadyDeaths = 0;
            this.assignNext(child);
            return;
        }
        child.current = null;
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
        this.assignNext(child);
    }

    private onExit(child: ProcChild): void {
        const index = this.children.indexOf(child);
        if (index === -1 || this.destroyed) return;
        this.children.splice(index, 1);

        if (!child.ready) {
            this.consecutivePreReadyDeaths++;
            if (this.consecutivePreReadyDeaths >= 2) {
                this.failRun(new Error(`Parse worker failed to start: ${child.lastError ?? 'unknown error'}`));
                return;
            }
        }

        const task = child.current;
        if (task) {
            this.recordOutcome(task.taskId, {
                ok: false,
                taskId: task.taskId,
                relativePath: task.relativePath,
                error: `parse worker crashed: ${child.lastError ?? 'worker exited unexpectedly'}`,
            });
        }
        if (this.run_ && (this.run_.queue.length > 0 || this.children.length === 0)) {
            this.spawnChild();
        }
    }

    private assignNext(child: ProcChild): void {
        const state = this.run_;
        if (!state || child.current || !child.ready) return;
        const task = state.queue.shift();
        if (!task) return;
        child.current = task;
        child.assignedAt = Date.now();
        try {
            child.proc.send({ kind: 'task', task });
        } catch (err) {
            child.current = null;
            this.recordOutcome(task.taskId, {
                ok: false,
                taskId: task.taskId,
                relativePath: task.relativePath,
                error: `parse worker send failed: ${(err as Error).message}`,
            });
        }
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
