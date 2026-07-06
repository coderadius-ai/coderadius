import { afterEach, describe, expect, it } from 'vitest';
import {
    ProcessParsePool,
    type ProcessSpawn,
    type Subprocess,
} from '../../../../../src/ingestion/processors/code-pipeline/process-parse-pool.js';
import type {
    ParseWorkTask,
    ParseWorkerInit,
    WorkerParseResult,
} from '../../../../../src/ingestion/processors/code-pipeline/parse-protocol.js';

// ProcessParsePool's REAL transport (Bun.spawn IPC + structured-clone + binary
// re-exec) is validated by the compiled smoke test. Here we inject an in-process
// fake transport to exercise the pool's orchestration deterministically — vitest
// sandboxes away the `Bun` global, so real children can't be spawned in-unit.
// Behavior is driven by task.relativePath: crash | fail:<msg> | slow:<ms>:<n> |
// hang | anything-else → success.

const INIT: ParseWorkerInit = { allFilePaths: [], dependencyMappings: [], scanMode: 'semantic' };

function makeTask(taskId: number, relativePath: string): ParseWorkTask {
    return { taskId, absolutePath: `/tmp/${relativePath}`, relativePath, mode: 'fresh', needsImportMap: false };
}

function makeResult(task: ParseWorkTask): WorkerParseResult {
    return {
        taskId: task.taskId,
        relativePath: task.relativePath,
        language: `ok:${task.relativePath}`,
        fileContent: '',
        chunks: [],
        frameworkSignals: [],
        fileConstants: [],
        valueFacts: [],
        criticalInvocations: [],
        componentDefinitions: [],
        dependencyRequirements: [],
        importMap: null,
        classAliases: [],
        dependencyBindings: [],
        chunkStaticData: [],
        importStatements: [],
        constructorSources: new Map([['marker', task.relativePath]]),
        mayContainSchemas: false,
        typeDefinitions: null,
        referencedTypes: null,
        payloadHints: null,
        parseDurationMs: 1,
    };
}

/** A fake spawn whose "children" honour the relativePath command vocabulary. */
const scriptedSpawn: ProcessSpawn = (_command, options) => {
    let alive = true;
    let resolveExit: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const exit = (code: number) => {
        if (!alive) return;
        alive = false;
        queueMicrotask(() => { options.onExit(); resolveExit(code); });
    };
    const proc: Subprocess = {
        exited,
        kill: () => exit(137),
        send: (raw: unknown) => {
            if (!alive) return;
            const msg = raw as { kind: string; task?: ParseWorkTask };
            if (msg.kind === 'init') { queueMicrotask(() => alive && options.ipc({ kind: 'ready' })); return; }
            if (msg.kind === 'shutdown') { exit(0); return; }
            const task = msg.task!;
            const [command, ...rest] = task.relativePath.split(':');
            if (command === 'crash') { exit(7); return; }
            if (command === 'hang') return;
            if (command === 'fail') {
                queueMicrotask(() => alive && options.ipc({
                    kind: 'task-error', taskId: task.taskId, relativePath: task.relativePath,
                    error: rest.join(':') || 'scripted failure',
                }));
                return;
            }
            const respond = () => alive && options.ipc({ kind: 'result', result: makeResult(task) });
            if (command === 'slow') { setTimeout(respond, parseInt(rest[0] ?? '50', 10)); return; }
            queueMicrotask(respond);
        },
    };
    return proc;
};

/** A fake spawn whose children die before ever replying `ready`. */
const bootCrashSpawn: ProcessSpawn = (_command, options) => {
    queueMicrotask(() => options.onExit());
    return { exited: Promise.resolve(3), kill: () => undefined, send: () => undefined };
};

const pools: ProcessParsePool[] = [];

function makePool(options: Partial<ConstructorParameters<typeof ProcessParsePool>[0]> = {}): ProcessParsePool {
    const pool = new ProcessParsePool({ size: 2, init: INIT, spawn: scriptedSpawn, ...options });
    pools.push(pool);
    return pool;
}

afterEach(async () => {
    await Promise.all(pools.splice(0).map(pool => pool.destroy()));
});

describe('ProcessParsePool', () => {
    it('returns outcomes in submission order and round-trips Map results', async () => {
        const pool = makePool();
        const outcomes = await pool.run([
            makeTask(0, 'slow:250:first'),
            makeTask(1, 'b'),
            makeTask(2, 'c'),
            makeTask(3, 'd'),
        ]);

        expect(outcomes).toHaveLength(4);
        expect(outcomes.every(o => o.ok)).toBe(true);
        expect(outcomes.map(o => (o.ok ? o.result.relativePath : 'x'))).toEqual(['slow:250:first', 'b', 'c', 'd']);
        const first = outcomes[0];
        expect(first.ok && first.result.constructorSources.get('marker')).toBe('slow:250:first');
    });

    it('reports per-task failures without aborting the batch', async () => {
        const pool = makePool();
        const outcomes = await pool.run([makeTask(0, 'a'), makeTask(1, 'fail:bad file'), makeTask(2, 'c')]);
        expect(outcomes[0]?.ok).toBe(true);
        expect(outcomes[1]).toMatchObject({ ok: false, relativePath: 'fail:bad file', error: 'bad file' });
        expect(outcomes[2]?.ok).toBe(true);
    });

    it('fails only the in-flight file when a worker crashes, then keeps draining', async () => {
        const pool = makePool({ size: 1 });
        const outcomes = await pool.run([makeTask(0, 'a'), makeTask(1, 'crash'), makeTask(2, 'c'), makeTask(3, 'd')]);
        expect(outcomes[0]?.ok).toBe(true);
        expect(outcomes[1]).toMatchObject({ ok: false, relativePath: 'crash' });
        expect(outcomes[1] && !outcomes[1].ok && outcomes[1].error).toContain('crashed');
        expect(outcomes[2]?.ok).toBe(true);
        expect(outcomes[3]?.ok).toBe(true);
    });

    it('reaps a silently hung worker via the watchdog and keeps draining', async () => {
        const pool = makePool({ size: 1, taskTimeoutMs: 300 });
        const outcomes = await pool.run([makeTask(0, 'a'), makeTask(1, 'hang'), makeTask(2, 'c')]);
        expect(outcomes[0]?.ok).toBe(true);
        expect(outcomes[1]).toMatchObject({ ok: false, relativePath: 'hang' });
        expect(outcomes[1] && !outcomes[1].ok && outcomes[1].error).toContain('no response within');
        expect(outcomes[2]?.ok).toBe(true);
    }, 10_000);

    it('rejects duplicate taskIds in one run', () => {
        const pool = makePool();
        expect(() => pool.run([makeTask(1, 'a'), makeTask(1, 'b')])).toThrow(/Duplicate taskId/);
    });

    it('reports monotonic progress up to the total', async () => {
        const pool = makePool();
        const ticks: Array<[number, number]> = [];
        await pool.run([makeTask(0, 'a'), makeTask(1, 'b'), makeTask(2, 'c')], (done, total) => ticks.push([done, total]));
        expect(ticks.map(t => t[0])).toEqual([1, 2, 3]);
        expect(ticks.every(t => t[1] === 3)).toBe(true);
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
        const pool = makePool({ spawn: bootCrashSpawn, size: 1 });
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
});
