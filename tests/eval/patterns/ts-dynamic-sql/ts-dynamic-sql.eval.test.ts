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

describe('Pattern Eval — ts-dynamic-sql', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-dynamic-sql | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-dynamic-sql');
    });

    it('DynamicRepository — should extract dynamic tables correctly', async () => {
        const chunk = chunks.find(c => c.name === 'DynamicRepository');
        expect(chunk, 'Fixture must contain DynamicRepository class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        const score = scoreAnalysis(manifest, 'DynamicRepository', result!.analysis);

        expect(score.truePositives).toContain('DataContainer:tenant_data_{tenantId}');
        expect(score.truePositives).toContain('DataContainer:regional_sales_{region}');
        
        const infra = result!.analysis.infrastructure;
        
        const tenantData = infra.find(i => i.name.startsWith('tenant_data_'));
        expect(tenantData?.operation).toBe('READS');
        
        const regionalSales = infra.find(i => i.name.startsWith('regional_sales_'));
        expect(regionalSales?.operation).toBe('WRITES');
    });
});
