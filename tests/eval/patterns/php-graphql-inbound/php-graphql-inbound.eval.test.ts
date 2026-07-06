/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-graphql-inbound
 *
 * Real-world case: PHP Lighthouse resolvers using #[Query] and #[Mutation]
 * attributes.
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Extracts INBOUND API endpoints correctly typed
 *   ✓ Detects PDO database access alongside the endpoint
 *
 * Fixture: tests/eval/patterns/php-graphql-inbound/fixture/
 * Manifest: tests/eval/patterns/php-graphql-inbound/expected.graph.yaml
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

describe('Pattern Eval — php-graphql-inbound', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] php-graphql-inbound | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('php-graphql-inbound');
    });

    it('LighthouseResolver — should extract QUERY, MUTATION, and DB access', async () => {
        const chunk = chunks.find(c => c.name === 'LighthouseResolver');
        expect(chunk, 'Fixture must contain LighthouseResolver class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        const score = scoreAnalysis(manifest, 'NotificationResolver', result!.analysis);

        expect(score.truePositives).toContain('APIEndpoint:GRAPHQL QUERY notifications');
        expect(score.truePositives).toContain('APIEndpoint:GRAPHQL MUTATION markAsRead');
        expect(score.truePositives).toContain('DataContainer:notifications');
    });
});
