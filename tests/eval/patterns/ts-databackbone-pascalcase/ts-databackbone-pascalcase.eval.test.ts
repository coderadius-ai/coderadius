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
import { sanitizeAnalysis } from '../../../../src/ai/workflows/sanitizer.js';
import { SymbolRegistry } from '../../../../src/ingestion/core/symbol-registry.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

await wireUnifiedAnalyzerReplay();

describe('Pattern Eval — ts-databackbone-pascalcase', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-databackbone-pascalcase | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should extract QuoteRequest as MessageChannel and not drop it via sanitizer', async () => {
        const chunk = chunks.find(c => c.name === 'DataBackbone.service');
        expect(chunk).toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        
        // Mock DI registry resolution
        const registry = new SymbolRegistry();
        registry.register({
            key: 'QUOTE_REQUEST',
            value: 'QuoteRequest',
            category: 'di_service',
            sourceFile: 'DataBackbone.service.ts',
            confidence: 'static',
        });

        // Run it through the sanitizer.
        // The real-world workflow populates `resolvedConstants` from static analysis
        // (PHP/TS const resolution) — we simulate that here so the constant access
        // `DATABACKBONE_CONFIG.QUOTE_REQUEST` is replaced with the literal `QUOTE_REQUEST`
        // before reaching the property-access guard, then resolved via the registry.
        const sanitized = sanitizeAnalysis(result!.analysis as any, {
            symbolRegistry: registry,
            resolvedConstants: [{ key: 'DATABACKBONE_CONFIG.QUOTE_REQUEST', value: 'QUOTE_REQUEST' }],
        });

        const score = scoreAnalysis(manifest, 'DataBackbone.service', sanitized);

        expect(score.truePositives).toContain('MessageChannel:QuoteRequest');
        expect(score.negativeViolations).toHaveLength(0);
    }, 30000);
});
