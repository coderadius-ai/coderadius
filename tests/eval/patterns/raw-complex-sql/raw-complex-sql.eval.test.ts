import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { analyzeFunction} from '../../../../src/ai/agents/unified-analyzer.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import { wireUnifiedAnalyzerReplay } from '../../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../../helpers/llm-replay-cache.js';
import {
    loadFixtureChunks,
    loadFixtureManifest,
    scoreAnalysis,
} from '../../helpers/pattern-eval.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

// Wire replay cache (generic + per-language agents — see with-replay.ts)
await wireUnifiedAnalyzerReplay();

describe('Pattern Eval — raw-complex-sql', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] raw-complex-sql | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('raw-complex-sql');
    });

    it('QueryExecutor — should extract raw tables correctly from CTEs and INSERTs', async () => {
        const chunk = chunks.find(c => c.name === 'query-executor');
        expect(chunk, 'Fixture must contain QueryExecutor class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        const score = scoreAnalysis(manifest, 'QueryExecutor', result!.analysis);

        expect(score.truePositives).toContain('DataContainer:users');
        expect(score.truePositives).toContain('DataContainer:orders_archive');
        expect(score.truePositives).toContain('DataContainer:audit_log');

        const infra = result!.analysis.infrastructure;
        
        const users = infra.find(i => i.name === 'users');
        expect(users?.operation).toBe('READS');
        
        const ordersArchive = infra.find(i => i.name === 'orders_archive');
        expect(ordersArchive?.operation).toBe('READS');
        
        const auditLog = infra.find(i => i.name === 'audit_log');
        expect(auditLog?.operation).toBe('WRITES'); // INSERT is considered WRITES
    });
});
