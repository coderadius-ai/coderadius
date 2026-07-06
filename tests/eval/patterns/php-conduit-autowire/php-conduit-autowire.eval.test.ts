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

await wireUnifiedAnalyzerReplay();

describe('Pattern Eval — php-conduit-autowire', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] php-conduit-autowire | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('php-conduit-autowire');
    });

    it('PublishOrderCommand — should detect WRITES via Autowire topic injection', async () => {
        const chunk = chunks.find(c => c.name === 'PublishOrderCommand');
        expect(chunk, 'Fixture must contain PublishOrderCommand').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();
        
        expect(result!.analysis.has_io).toBe(true);
        const score = scoreAnalysis(manifest, 'PublishOrderCommand', result!.analysis);
        expect(score.negativeViolations).toHaveLength(0);
    });

    it('ConsumeOrderCommand — should detect READS via Autowire subscription injection', async () => {
        const chunk = chunks.find(c => c.name === 'ConsumeOrderCommand');
        expect(chunk, 'Fixture must contain ConsumeOrderCommand').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        expect(result, 'LLM should return analysis').not.toBeNull();
        
        expect(result!.analysis.has_io).toBe(true);
        const score = scoreAnalysis(manifest, 'ConsumeOrderCommand', result!.analysis);
        expect(score.negativeViolations).toHaveLength(0);
    });
});
