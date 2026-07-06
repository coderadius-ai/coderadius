import { extractParsedFile, type WorkerContext } from './parse-worker.js';
import type { WorkerOutMessage, WorkerProcessInMessage } from './parse-protocol.js';

// ─── Parse Worker (child-process transport) ──────────────────────────────────
//
// The standalone `bun build --compile` binary cannot run the parse pool over
// node:worker_threads: tearing a worker thread down after it has accumulated
// many tree-sitter NAPI handles crashes the whole process (oven-sh/bun#30286).
// A separate PROCESS has its own NAPI env, so its exit (or kill) is reclaimed by
// the OS with no in-parent finalization — crash-free, and still parallel.
//
// The pool re-execs the same binary with CR_PARSE_WORKER=1; cli/index.ts routes
// that to runParseWorkerProcess(). Identical per-file extraction to the thread
// worker (extractParsedFile), so output is byte-identical. Bun IPC uses
// structured clone, so the Map-bearing WorkerParseResult crosses as-is — no
// serialization layer needed.
// ─────────────────────────────────────────────────────────────────────────────

type IpcSend = (message: WorkerOutMessage) => void;

/**
 * Run the current process as a parse worker: receive an init, then a stream of
 * tasks, over the parent IPC channel; reply with results. Returns immediately —
 * the registered 'message' listener keeps the process alive until `shutdown`.
 */
export function runParseWorkerProcess(): void {
    const send = (process as NodeJS.Process & { send?: IpcSend }).send?.bind(process);
    if (!send) {
        // No IPC channel — nothing to serve. Exit rather than hang.
        process.exit(0);
    }
    const emit = send as IpcSend;

    let ctx: WorkerContext | null = null;

    process.on('message', (msg: WorkerProcessInMessage) => {
        if (msg.kind === 'init') {
            ctx = {
                allFilePaths: new Set(msg.init.allFilePaths),
                dependencyMappings: msg.init.dependencyMappings,
                scanMode: msg.init.scanMode,
            };
            emit({ kind: 'ready' });
            return;
        }
        if (msg.kind === 'shutdown') {
            process.exit(0);
        }
        // kind === 'task'
        if (!ctx) {
            emit({ kind: 'task-error', taskId: msg.task.taskId, relativePath: msg.task.relativePath, error: 'parse worker received task before init' });
            return;
        }
        try {
            emit({ kind: 'result', result: extractParsedFile(msg.task, ctx) });
        } catch (err) {
            emit({ kind: 'task-error', taskId: msg.task.taskId, relativePath: msg.task.relativePath, error: (err as Error).message });
        }
    });
}
