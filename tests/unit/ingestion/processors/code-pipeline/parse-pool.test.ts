import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParsePool, resolveParseConcurrency } from '../../../../../src/ingestion/processors/code-pipeline/parse-pool.js';
import type { ParseWorkTask, ParseWorkerInit } from '../../../../../src/ingestion/processors/code-pipeline/parse-protocol.js';

const TEST_WORKER = fileURLToPath(new URL('./fixtures/parse-pool-test-worker.ts', import.meta.url));
const BOOT_CRASH_WORKER = fileURLToPath(new URL('./fixtures/parse-pool-boot-crash-worker.ts', import.meta.url));

const INIT: ParseWorkerInit = { allFilePaths: [], dependencyMappings: [], scanMode: 'semantic' };

function makeTask(taskId: number, relativePath: string): ParseWorkTask {
    return { taskId, absolutePath: `/tmp/${relativePath}`, relativePath, mode: 'fresh', needsImportMap: false };
}

const pools: ParsePool[] = [];

function makePool(options: Partial<ConstructorParameters<typeof ParsePool>[0]> = {}): ParsePool {
    const pool = new ParsePool({ size: 2, init: INIT, workerPath: TEST_WORKER, ...options });
    pools.push(pool);
    return pool;
}

afterEach(async () => {
    await Promise.all(pools.splice(0).map(pool => pool.destroy()));
});

describe('resolveParseConcurrency', () => {
    it('honors PARSE_CONCURRENCY and falls back to cores-1', () => {
        const previous = process.env.PARSE_CONCURRENCY;
        try {
            process.env.PARSE_CONCURRENCY = '3';
            expect(resolveParseConcurrency()).toBe(3);
            process.env.PARSE_CONCURRENCY = '0';
            expect(resolveParseConcurrency()).toBe(Math.max(1, os.cpus().length - 1));
            delete process.env.PARSE_CONCURRENCY;
            expect(resolveParseConcurrency()).toBe(Math.max(1, os.cpus().length - 1));
        } finally {
            if (previous === undefined) delete process.env.PARSE_CONCURRENCY;
            else process.env.PARSE_CONCURRENCY = previous;
        }
    });
});

describe('ParsePool', () => {
    it('returns outcomes in submission order regardless of completion order', async () => {
        const pool = makePool();
        const tasks = [
            makeTask(0, 'slow:250:first'),
            makeTask(1, 'b'),
            makeTask(2, 'c'),
            makeTask(3, 'd'),
        ];

        const outcomes = await pool.run(tasks);

        expect(outcomes).toHaveLength(4);
        expect(outcomes.every(o => o.ok)).toBe(true);
        // The slow task finishes LAST but stays at index 0.
        expect(outcomes.map(o => (o.ok ? o.result.relativePath : 'x'))).toEqual([
            'slow:250:first', 'b', 'c', 'd',
        ]);
        // Maps survive the structured-clone IPC round-trip.
        const first = outcomes[0];
        expect(first.ok && first.result.constructorSources.get('marker')).toBe('slow:250:first');
    });

    it('reports per-task failures without aborting the batch', async () => {
        const pool = makePool();
        const outcomes = await pool.run([
            makeTask(0, 'a'),
            makeTask(1, 'fail:bad file'),
            makeTask(2, 'c'),
        ]);

        expect(outcomes[0]?.ok).toBe(true);
        expect(outcomes[1]).toMatchObject({ ok: false, relativePath: 'fail:bad file', error: 'bad file' });
        expect(outcomes[2]?.ok).toBe(true);
    });

    it('fails only the in-flight file when a worker crashes, then keeps draining', async () => {
        const pool = makePool({ size: 1 });
        const outcomes = await pool.run([
            makeTask(0, 'a'),
            makeTask(1, 'crash'),
            makeTask(2, 'c'),
            makeTask(3, 'd'),
        ]);

        expect(outcomes[0]?.ok).toBe(true);
        expect(outcomes[1]).toMatchObject({ ok: false, relativePath: 'crash' });
        expect(outcomes[1] && !outcomes[1].ok && outcomes[1].error).toContain('crashed');
        // The replacement worker finishes the queue.
        expect(outcomes[2]?.ok).toBe(true);
        expect(outcomes[3]?.ok).toBe(true);
    });

    it('reaps a silently hung worker via the watchdog and keeps draining', async () => {
        // Worker never answers the 'hang' task: without the watchdog the run
        // would stall forever (regression observed on a real repo run where
        // an in-flight IPC response was lost).
        const pool = makePool({ size: 1, taskTimeoutMs: 500 });
        const outcomes = await pool.run([
            makeTask(0, 'a'),
            makeTask(1, 'hang'),
            makeTask(2, 'c'),
        ]);

        expect(outcomes[0]?.ok).toBe(true);
        expect(outcomes[1]).toMatchObject({ ok: false, relativePath: 'hang' });
        expect(outcomes[1] && !outcomes[1].ok && outcomes[1].error).toContain('no response within');
        // Replacement worker drains the rest of the queue.
        expect(outcomes[2]?.ok).toBe(true);
    }, 30_000);

    it('rejects duplicate taskIds in one run', () => {
        const pool = makePool();
        expect(() => pool.run([makeTask(1, 'a'), makeTask(1, 'b')])).toThrow(/Duplicate taskId/);
    });

    it('reports monotonic progress up to the total', async () => {
        const pool = makePool();
        const ticks: Array<[number, number]> = [];

        await pool.run(
            [makeTask(0, 'a'), makeTask(1, 'b'), makeTask(2, 'c')],
            (done, total) => ticks.push([done, total]),
        );

        expect(ticks).toEqual([[1, 3], [2, 3], [3, 3]]);
    });

    it('supports sequential runs on the same workers (contagion re-dispatch)', async () => {
        const pool = makePool();

        const first = await pool.run([makeTask(0, 'a'), makeTask(1, 'b')]);
        const second = await pool.run([makeTask(0, 'z')]);

        expect(first.every(o => o.ok)).toBe(true);
        expect(second).toHaveLength(1);
        expect(second[0]?.ok && second[0].result.relativePath).toBe('z');
    });

    it('resolves empty runs immediately', async () => {
        const pool = makePool();
        await expect(pool.run([])).resolves.toEqual([]);
    });

    it('fails fast when workers die before becoming ready', async () => {
        const pool = makePool({ workerPath: BOOT_CRASH_WORKER, size: 1 });
        await expect(pool.run([makeTask(0, 'a')])).rejects.toThrow(/failed to start/);
    });

    it('rejects the run when aborted', async () => {
        const controller = new AbortController();
        const pool = makePool({ signal: controller.signal });
        const promise = pool.run([makeTask(0, 'slow:5000:never'), makeTask(1, 'slow:5000:never2')]);
        const guarded = promise.catch((err: Error) => err);
        controller.abort();
        const settled = await guarded;
        expect(settled).toBeInstanceOf(Error);
        expect((settled as Error).message).toMatch(/aborted/);
    });

    it('drives the real parse-worker end-to-end over IPC', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-parse-pool-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'alpha.ts'), 'export class Alpha { run(): number { return 1; } }\n');
            fs.writeFileSync(path.join(tmpDir, 'beta.ts'), 'export class Beta { run(): number { return 2; } }\n');

            const pool = makePool({
                workerPath: undefined,
                size: 2,
                init: { allFilePaths: ['alpha.ts', 'beta.ts'], dependencyMappings: [], scanMode: 'semantic' },
            });
            const outcomes = await pool.run([
                { taskId: 0, absolutePath: path.join(tmpDir, 'alpha.ts'), relativePath: 'alpha.ts', mode: 'fresh', needsImportMap: true },
                { taskId: 1, absolutePath: path.join(tmpDir, 'beta.ts'), relativePath: 'beta.ts', mode: 'fresh', needsImportMap: true },
            ]);

            expect(outcomes).toHaveLength(2);
            expect(outcomes[0]?.ok && outcomes[0].result.language).toBe('typescript');
            expect(outcomes[0]?.ok && outcomes[0].result.chunks.map(c => c.name).join(',')).toContain('run');
            expect(outcomes[1]?.ok && outcomes[1].result.relativePath).toBe('beta.ts');
            expect(outcomes[1]?.ok && outcomes[1].result.importMap).not.toBeNull();
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }, 30_000);
});
