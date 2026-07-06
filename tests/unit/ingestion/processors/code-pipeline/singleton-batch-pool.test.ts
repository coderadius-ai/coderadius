/**
 * Unit Tests — SingletonBatchPool
 *
 * Micro-batching across concurrent extractSemantics calls: the orchestrator
 * processes files in parallel but invokes extractSemantics per file, so
 * cross-FILE singletons never meet inside one call. The pool collects them
 * across calls and flushes on size or on a short timer.
 *
 * The pool is fully generic (executors injected) — these tests use fakes.
 */

import { describe, it, expect, vi } from 'vitest';
import { SingletonBatchPool } from '../../../../../src/ingestion/processors/code-pipeline/singleton-batch-pool.js';

interface FakeTask { id: string; key: string }

function makePool(opts?: {
    maxBatch?: number;
    flushDelayMs?: number;
    executeBatch?: (tasks: FakeTask[]) => Promise<string[]>;
    executeSingle?: (task: FakeTask) => Promise<string>;
}) {
    const executeBatch = opts?.executeBatch
        ?? vi.fn(async (tasks: FakeTask[]) => tasks.map(t => `batched:${t.id}`));
    const executeSingle = opts?.executeSingle
        ?? vi.fn(async (task: FakeTask) => `single:${task.id}`);
    const pool = new SingletonBatchPool<FakeTask, string>(
        task => task.key,
        executeBatch,
        executeSingle,
        opts?.maxBatch ?? 3,
        opts?.flushDelayMs ?? 10,
    );
    return { pool, executeBatch, executeSingle };
}

const task = (id: string, key = 'php'): FakeTask => ({ id, key });

describe('SingletonBatchPool', () => {
    it('flushes immediately when a group reaches maxBatch, outcomes index-aligned', async () => {
        const { pool, executeBatch, executeSingle } = makePool({ maxBatch: 3 });

        const outcomes = await Promise.all([
            pool.submit(task('a')),
            pool.submit(task('b')),
            pool.submit(task('c')),
        ]);

        expect(executeBatch).toHaveBeenCalledTimes(1);
        expect(executeSingle).not.toHaveBeenCalled();
        expect(outcomes).toEqual(['batched:a', 'batched:b', 'batched:c']);
    });

    it('flushes a below-max group after flushDelayMs', async () => {
        const { pool, executeBatch } = makePool({ maxBatch: 6, flushDelayMs: 10 });

        const outcomes = await Promise.all([pool.submit(task('a')), pool.submit(task('b'))]);

        expect(executeBatch).toHaveBeenCalledTimes(1);
        expect(outcomes).toEqual(['batched:a', 'batched:b']);
    });

    it('routes a lone member through executeSingle (no 1-member LLM batch)', async () => {
        const { pool, executeBatch, executeSingle } = makePool({ flushDelayMs: 10 });

        const outcome = await pool.submit(task('lonely'));

        expect(executeSingle).toHaveBeenCalledTimes(1);
        expect(executeBatch).not.toHaveBeenCalled();
        expect(outcome).toBe('single:lonely');
    });

    it('never mixes groups with different keys', async () => {
        const calls: FakeTask[][] = [];
        const { pool } = makePool({
            maxBatch: 6,
            flushDelayMs: 10,
            executeBatch: async tasks => { calls.push(tasks); return tasks.map(t => t.id); },
        });

        await Promise.all([
            pool.submit(task('a', 'php')),
            pool.submit(task('b', 'php')),
            pool.submit(task('c', 'typescript')),
            pool.submit(task('d', 'typescript')),
        ]);

        expect(calls).toHaveLength(2);
        for (const batch of calls) {
            expect(new Set(batch.map(t => t.key)).size).toBe(1);
        }
    });

    it('rejects every member when the batch executor throws', async () => {
        const { pool } = makePool({
            maxBatch: 2,
            executeBatch: async () => { throw new Error('429 exhausted'); },
        });

        const results = await Promise.allSettled([pool.submit(task('a')), pool.submit(task('b'))]);

        expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
    });

    it('starts a fresh group after a flush (no reuse of flushed state)', async () => {
        const { pool, executeBatch } = makePool({ maxBatch: 2, flushDelayMs: 10 });

        await Promise.all([pool.submit(task('a')), pool.submit(task('b'))]);
        await Promise.all([pool.submit(task('c')), pool.submit(task('d'))]);

        expect(executeBatch).toHaveBeenCalledTimes(2);
    });
});
