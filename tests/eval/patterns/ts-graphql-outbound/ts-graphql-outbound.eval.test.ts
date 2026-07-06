/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-graphql-outbound
 *
 * Real-world case: Apollo GraphQL Client (or equivalent) using inline gql`...`
 * documents.
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Extracts OUTBOUND API endpoints with their root field (GRAPHQL QUERY order)
 *   ✓ Extracts document_operation_name when provided (e.g., GetOrderById)
 *   ✓ Does NOT extract document operation names as path nodes
 *   ✓ Resolves aliases (e.g., myOrder: order) to the REAL root field (order),
 *     preventing hallucinated paths like "GRAPHQL QUERY myOrder".
 *
 * Fixture: tests/eval/patterns/ts-graphql-outbound/fixture/
 * Manifest: tests/eval/patterns/ts-graphql-outbound/expected.graph.yaml
 *
 * Modes: replay (default, ~1s) | live | refresh
 * ═══════════════════════════════════════════════════════════════════════════════
 */

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

describe('Pattern Eval — ts-graphql-outbound', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-graphql-outbound | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-graphql-outbound');
    });

    it('OrderClient — should extract OUTBOUND endpoints, documentNames, and resolve aliases', async () => {
        const chunk = chunks.find(c => c.name === 'OrderClient');
        expect(chunk, 'Fixture must contain OrderClient class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        const score = scoreAnalysis(manifest, 'OrderApiClient', result!.analysis);

        expect(score.truePositives).toContain('APIEndpoint:GRAPHQL QUERY order');
        expect(score.truePositives).toContain('APIEndpoint:GRAPHQL MUTATION createOrder');
        
        // Negative checks (must NOT extract aliases or document operation names)
        expect(score.negativeViolations).toHaveLength(0);

        // Check documentName extraction
        const apis = (result!.analysis as any).emergent_api_calls || [];
        const queryEps = apis.filter((i: any) => i.path === 'GRAPHQL QUERY order');
        expect(queryEps.length).toBeGreaterThanOrEqual(1); // fetchOrder and fetchMyOrder both point here

        const mutationEp = apis.find((i: any) => i.path === 'GRAPHQL MUTATION createOrder');
        expect(mutationEp?.document_operation_name).toBe('CreateNewOrder');
    });
});
