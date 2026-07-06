import { ParsePool, resolveParseConcurrency } from './parse-pool.js';
import { ProcessParsePool } from './process-parse-pool.js';
import type { ParsePoolOutcome, ParseWorkTask, ParseWorkerInit } from './parse-protocol.js';

// ─── Parse Executor ────────────────────────────────────────────────────────────
//
// The static analyzer dispatches per-file tree-sitter work through a ParseExecutor.
// Two implementations, chosen per runtime — both parse in parallel:
//
//   • Worker-thread pool (dev `bun run`, Node/vitest): node:worker_threads.
//     The fast path; structured-clone IPC, no process spawn overhead.
//
//   • Child-process pool (the `bun build --compile` standalone binary): each
//     worker is its own OS process. tree-sitter is a NAPI addon, and Bun crashes
//     with a fatal NAPI error when a worker THREAD holding many tree-sitter
//     handles is torn down at scale (oven-sh/bun#30286) — exactly what the pool
//     does after a large repo finishes. A child PROCESS has its own NAPI env, so
//     its exit/kill is reclaimed by the OS with no in-parent finalization:
//     crash-free, and still parallel. See process-parse-pool.ts.
//
// Both pools satisfy ParseExecutor structurally (run/destroy), so the analyzer
// is transport-agnostic. When Bun fixes #30286, drop the branch and always use
// the thread pool.
// ─────────────────────────────────────────────────────────────────────────────

/** Surface the static analyzer needs from a parse backend. Both pools satisfy it. */
export interface ParseExecutor {
    run(tasks: ParseWorkTask[], onProgress?: (done: number, total: number) => void): Promise<ParsePoolOutcome[]>;
    destroy(): Promise<void>;
}

/** True inside a `bun build --compile` standalone binary (embedded `$bunfs` FS). */
const IS_BUN_COMPILED = import.meta.url.includes('$bunfs');

/** Pick the parse backend for the current runtime (see file header). */
export function createParseExecutor(init: ParseWorkerInit, signal?: AbortSignal): ParseExecutor {
    if (IS_BUN_COMPILED) {
        return new ProcessParsePool({ size: resolveParseConcurrency(), init, signal });
    }
    return new ParsePool({ size: resolveParseConcurrency(), init, signal });
}
