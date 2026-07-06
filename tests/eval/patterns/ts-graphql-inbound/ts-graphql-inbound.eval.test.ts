/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-graphql-inbound
 *
 * Real-world case: NestJS GraphQL resolvers using @Query, @Mutation, and
 * @Subscription decorators.
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Extracts INBOUND API endpoints correctly typed (GRAPHQL QUERY order)
 *   ✓ Detects the @Subscription method correctly
 *   ✓ Detects the message publishing (order.updated) inside the mutation
 *
 * Fixture: tests/eval/patterns/ts-graphql-inbound/fixture/
 * Manifest: tests/eval/patterns/ts-graphql-inbound/expected.graph.yaml
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

describe('Pattern Eval — ts-graphql-inbound', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] ts-graphql-inbound | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('ts-graphql-inbound');
    });

    it('OrderResolver — should extract QUERY, MUTATION, SUBSCRIPTION, and pubsub', async () => {
        const chunk = chunks.find(c => c.name === 'OrderResolver');
        expect(chunk, 'Fixture must contain OrderResolver class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        console.log("LLM Analysis:", JSON.stringify(result!.analysis, null, 2));
        const score = scoreAnalysis(manifest, 'OrderResolver', result!.analysis);

        expect(score.truePositives).toContain('APIEndpoint:GRAPHQL QUERY order');
        expect(score.truePositives).toContain('APIEndpoint:GRAPHQL MUTATION createOrder');
        expect(score.truePositives).toContain('APIEndpoint:GRAPHQL SUBSCRIPTION orderUpdated');
        expect(score.truePositives).toContain('MessageChannel:order.updated');
    });
});
