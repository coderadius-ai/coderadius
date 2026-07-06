/**
 * Scripted parse-worker stand-in for parse-pool unit tests.
 * Behavior is driven by the task's relativePath:
 *   - "crash"            → kill the worker process mid-task
 *   - "fail:<msg>"       → post a task-error
 *   - "slow:<ms>:<name>" → respond after a delay (completion-order scrambling)
 *   - "hang"             → never respond (watchdog coverage)
 *   - anything else      → immediate success
 * Results carry `language: 'ok:<relativePath>'` so outcome ordering is observable.
 */
import { parentPort } from 'node:worker_threads';
import type { ParseWorkTask, WorkerInMessage, WorkerOutMessage, WorkerParseResult } from '../../../../../../src/ingestion/processors/code-pipeline/parse-protocol.js';

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

const port = parentPort!;

port.on('message', (msg: WorkerInMessage) => {
    if (msg.kind !== 'task') return;
    const { task } = msg;
    const [command, ...rest] = task.relativePath.split(':');

    if (command === 'crash') {
        process.exit(7);
    }
    if (command === 'hang') {
        // Keep the worker alive but never answer — the pool watchdog must
        // reap it and fail the task over to the INCOMPLETE path.
        return;
    }
    if (command === 'fail') {
        port.postMessage({
            kind: 'task-error',
            taskId: task.taskId,
            relativePath: task.relativePath,
            error: rest.join(':') || 'scripted failure',
        } satisfies WorkerOutMessage);
        return;
    }
    const respond = () => port.postMessage({ kind: 'result', result: makeResult(task) } satisfies WorkerOutMessage);
    if (command === 'slow') {
        setTimeout(respond, parseInt(rest[0] ?? '50', 10));
        return;
    }
    respond();
});

port.postMessage({ kind: 'ready' } satisfies WorkerOutMessage);
