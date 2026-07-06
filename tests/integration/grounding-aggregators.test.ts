import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeMessageChannelWithKind } from '../../src/graph/mutations/data-contracts.js';
import { astGrounding, llmGrounding, type GroundingFields } from '../../src/graph/grounding.js';
import {
    countByQualityTier,
    listNeedsReview,
    findDisputed,
} from '../../src/graph/queries/grounding.js';

// Phase 3 C3 checkpoint: aggregator queries return the correct shape and
// counts for a small seeded graph. These functions feed the CLI sync report
// breakdown and the dashboard toolbar filter chips, so a regression here would
// silently corrupt the operator-facing summary.

describe('provenance aggregator queries', () => {
    const PFX = 'cr://test/provenance-aggregators/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (c:MessageChannel) WHERE c.name STARTS WITH $p DETACH DELETE c', { p: PFX });
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('countByQualityTier returns one row per inferred label, exact tier dominates for ast provenance', async () => {
        // Seed: 3 ast/exact MessageChannels, 1 llm/medium, 1 llm/low.
        const ast: GroundingFields = astGrounding('test-seeder@v1');
        const llmMed: GroundingFields = llmGrounding('vertex/gemini', 'h1', 'unified-analyzer@v1', 'medium');
        const llmLow: GroundingFields = llmGrounding('vertex/gemini', 'h2', 'unified-analyzer@v1', 'low');

        await mergeMessageChannelWithKind(`${PFX}t1`, 'topic', 'rabbitmq', 'C1', { grounding: ast });
        await mergeMessageChannelWithKind(`${PFX}t2`, 'topic', 'rabbitmq', 'C1', { grounding: ast });
        await mergeMessageChannelWithKind(`${PFX}t3`, 'topic', 'rabbitmq', 'C1', { grounding: ast });
        await mergeMessageChannelWithKind(`${PFX}t4`, 'topic', 'rabbitmq', 'C1', { grounding: llmMed });
        await mergeMessageChannelWithKind(`${PFX}t5`, 'topic', 'rabbitmq', 'C1', { grounding: llmLow });

        const breakdowns = await countByQualityTier();
        const channelRow = breakdowns.find(b => b.label === 'MessageChannel');
        expect(channelRow).toBeDefined();
        // The wipe only filters by PFX, so the table includes OTHER tests' channels
        // too. Assert that OUR contributions appear in the totals (>= seeded counts).
        expect(channelRow!.tiers.exact).toBeGreaterThanOrEqual(3);
        expect(channelRow!.tiers.medium).toBeGreaterThanOrEqual(1);
        expect(channelRow!.tiers.low).toBeGreaterThanOrEqual(1);
    });

    it('listNeedsReview returns nodes flagged needsReview=true with their evidence', async () => {
        const flagged: GroundingFields = {
            ...llmGrounding('vertex/gemini', 'h', 'unified-analyzer@v1', 'low'),
            needsReview: true,
            evidence: { extractors: ['unified-analyzer@v1'], fallbacksApplied: ['cqrs-suffix-fallback'] },
        };
        const clean: GroundingFields = astGrounding('test-seeder@v1');
        await mergeMessageChannelWithKind(`${PFX}needs-review-1`, 'topic', 'rabbitmq', 'C', { grounding: flagged });
        await mergeMessageChannelWithKind(`${PFX}clean-1`, 'topic', 'rabbitmq', 'C', { grounding: clean });

        const items = await listNeedsReview('MessageChannel');
        const mine = items.filter(i => i.name === `${PFX}needs-review-1` || i.name === `${PFX}clean-1`);
        expect(mine).toHaveLength(1);
        expect(mine[0].name).toBe(`${PFX}needs-review-1`);
        expect(mine[0].source).toBe('llm');
        expect(mine[0].extractors).toContain('unified-analyzer@v1');
        expect(mine[0].fallbacksApplied).toContain('cqrs-suffix-fallback');
    });

    it('listNeedsReview narrows by qualityAtLeast (drops weaker tiers)', async () => {
        const medium: GroundingFields = {
            source: 'llm', quality: 'medium', needsReview: true,
            evidence: { extractors: ['unified-analyzer@v1'] },
        };
        const low: GroundingFields = {
            source: 'llm', quality: 'low', needsReview: true,
            evidence: { extractors: ['unified-analyzer@v1'] },
        };
        await mergeMessageChannelWithKind(`${PFX}filter-medium`, 'topic', 'rabbitmq', 'C', { grounding: medium });
        await mergeMessageChannelWithKind(`${PFX}filter-low`, 'topic', 'rabbitmq', 'C', { grounding: low });

        const all = await listNeedsReview({ label: 'MessageChannel' });
        const mine = all.filter(i => i.name.startsWith(`${PFX}filter-`));
        expect(mine.map(i => i.name).sort()).toEqual([`${PFX}filter-low`, `${PFX}filter-medium`].sort());

        const filtered = await listNeedsReview({ label: 'MessageChannel', qualityAtLeast: 'medium' });
        const filteredMine = filtered.filter(i => i.name.startsWith(`${PFX}filter-`));
        // qualityAtLeast='medium' keeps {exact, high, medium}, drops {low, speculative}.
        expect(filteredMine.map(i => i.name)).toEqual([`${PFX}filter-medium`]);
    });

    it('listNeedsReview narrows by sourceIn (keeps only listed sources)', async () => {
        const llmProv: GroundingFields = {
            source: 'llm', quality: 'medium', needsReview: true,
            evidence: { extractors: ['unified-analyzer@v1'] },
        };
        const heuristicProv: GroundingFields = {
            source: 'heuristic', quality: 'low', needsReview: true,
            evidence: { extractors: ['cqrs-suffix@v1'] },
        };
        await mergeMessageChannelWithKind(`${PFX}source-llm`, 'topic', 'rabbitmq', 'C', { grounding: llmProv });
        await mergeMessageChannelWithKind(`${PFX}source-heuristic`, 'topic', 'rabbitmq', 'C', { grounding: heuristicProv });

        const filtered = await listNeedsReview({ label: 'MessageChannel', sourceIn: ['llm'] });
        const mine = filtered.filter(i => i.name.startsWith(`${PFX}source-`));
        expect(mine.map(i => i.name)).toEqual([`${PFX}source-llm`]);
    });

    it('findDisputed surfaces llm-sourced nodes that also carry a deterministic extractor signal', async () => {
        // Disputed: source='llm' but extractors include both LLM and static.
        const disputed: GroundingFields = {
            source: 'llm',
            quality: 'medium',
            evidence: { extractors: ['unified-analyzer@v1', 'symfony-messenger-php@v1'] },
        };
        // Not disputed: source='llm' but only one LLM extractor.
        const llmOnly: GroundingFields = llmGrounding('vertex/gemini', 'h', 'unified-analyzer@v1', 'medium');
        await mergeMessageChannelWithKind(`${PFX}disputed-1`, 'topic', 'rabbitmq', 'C', { grounding: disputed });
        await mergeMessageChannelWithKind(`${PFX}llm-only-1`, 'topic', 'rabbitmq', 'C', { grounding: llmOnly });

        const items = await findDisputed();
        const mine = items.filter(i => i.name === `${PFX}disputed-1` || i.name === `${PFX}llm-only-1`);
        expect(mine.map(i => i.name)).toContain(`${PFX}disputed-1`);
        expect(mine.map(i => i.name)).not.toContain(`${PFX}llm-only-1`);
    });
});
