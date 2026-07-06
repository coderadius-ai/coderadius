import { describe, expect, it } from 'vitest';
import { createParseExecutor } from '../../../../../src/ingestion/processors/code-pipeline/parse-executor.js';
import { ParsePool } from '../../../../../src/ingestion/processors/code-pipeline/parse-pool.js';
import type { ParseWorkerInit } from '../../../../../src/ingestion/processors/code-pipeline/parse-protocol.js';

describe('createParseExecutor', () => {
    it('uses the worker-thread pool outside a compiled binary (dev/Node)', () => {
        const init: ParseWorkerInit = { allFilePaths: [], dependencyMappings: [], scanMode: 'semantic' };
        const executor = createParseExecutor(init);
        // Under vitest import.meta.url is a real path, not the $bunfs FS, so the
        // factory returns the thread pool (the compiled binary gets ProcessParsePool).
        expect(executor).toBeInstanceOf(ParsePool);
        return executor.destroy();
    });
});
