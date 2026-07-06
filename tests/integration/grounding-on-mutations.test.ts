import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeMessageChannelWithKind } from '../../src/graph/mutations/data-contracts.js';
import { astGrounding, llmGrounding, weldGrounding, unflattenGrounding, type GroundingFields } from '../../src/graph/grounding.js';

// Phase 1 C1: integration test that every mutation writes the 8 flat grounding
// columns AND that the accumulator-dedup invariant holds across re-runs.
//
// Scope (initial): mergeMessageChannelWithKind as the template. Subsequent
// mutations (mergeDataContainer, mergeAPIInterface, etc.) follow the same
// pattern; this test confirms the helper works end-to-end.

describe('grounding round-trip on MessageChannel mutations', () => {
    const PFX = 'cr://test/grounding-roundtrip/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally { await s.close(); }
    }

    async function readChannel(name: string): Promise<Record<string, unknown> | null> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (c:MessageChannel {name: $name}) RETURN
                    c.source AS source,
                    c.quality AS quality,
                    c.evidence_extractors AS evidence_extractors,
                    c.evidence_llmCalls AS evidence_llmCalls,
                    c.evidence_fallbacksApplied AS evidence_fallbacksApplied,
                    c.evidence_mergedFrom AS evidence_mergedFrom,
                    c.needsReview AS needsReview,
                    c.lastSeenCommit AS lastSeenCommit`,
                { name },
            );
            if (r.records.length === 0) return null;
            const rec = r.records[0];
            return {
                source: rec.get('source'),
                quality: rec.get('quality'),
                evidence_extractors: rec.get('evidence_extractors'),
                evidence_llmCalls: rec.get('evidence_llmCalls'),
                evidence_fallbacksApplied: rec.get('evidence_fallbacksApplied'),
                evidence_mergedFrom: rec.get('evidence_mergedFrom'),
                needsReview: rec.get('needsReview'),
                lastSeenCommit: rec.get('lastSeenCommit'),
            };
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    // Note: mergeMessageChannelWithKind builds its own URN; we use a test name
    // that won't collide with other suites' PFX (the channel is global, not
    // PFX-scoped). Wipe-by-name at the end.
    async function wipeByName(name: string) {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (c:MessageChannel {name: $name}) DETACH DELETE c', { name });
        } finally { await s.close(); }
    }

    it('writes the 8 flat grounding fields on ON CREATE', async () => {
        const name = 'acme.test.grounding.create';
        await wipeByName(name);
        const prov = astGrounding('symfony-messenger-php@v1');
        await mergeMessageChannelWithKind(name, 'topic', 'rabbitmq', 'COMMIT_A', { grounding: prov });

        const node = await readChannel(name);
        expect(node).not.toBeNull();
        expect(node!.source).toBe('ast');
        expect(node!.quality).toBe('exact');
        expect(node!.evidence_extractors).toEqual(['symfony-messenger-php@v1']);
        expect(node!.evidence_llmCalls).toBeNull();
        expect(node!.evidence_fallbacksApplied).toBeNull();
        expect(node!.evidence_mergedFrom).toBeNull();
        expect(node!.lastSeenCommit).toBe('COMMIT_A');

        await wipeByName(name);
    });

    it('reconstructs GroundingFields from flat columns via unflattenGrounding', async () => {
        const name = 'acme.test.grounding.unflatten';
        await wipeByName(name);
        const llmProv = llmGrounding('vertex/gemini-2.5-flash-lite', 'abc123');
        await mergeMessageChannelWithKind(name, 'topic', null as unknown as string, 'COMMIT', { grounding: llmProv });

        const flat = await readChannel(name);
        const reconstructed = unflattenGrounding(flat as unknown as Record<string, unknown>)!;
        expect(reconstructed.source).toBe('llm');
        expect(reconstructed.quality).toBe('medium');
        expect(reconstructed.evidence.extractors).toEqual(['unified-analyzer@v1']);
        expect(reconstructed.evidence.llmCalls).toHaveLength(1);
        expect(reconstructed.evidence.llmCalls![0].model).toBe('vertex/gemini-2.5-flash-lite');

        await wipeByName(name);
    });

    it('dedupes evidence_extractors on ON MATCH re-run (Cypher UNWIND/DISTINCT)', async () => {
        const name = 'acme.test.grounding.dedup-extractors';
        await wipeByName(name);
        const prov = astGrounding('symfony-messenger-php@v1');

        // First write
        await mergeMessageChannelWithKind(name, 'topic', undefined, 'COMMIT_A', { grounding: prov });
        let node = await readChannel(name);
        expect(node!.evidence_extractors).toEqual(['symfony-messenger-php@v1']);

        // Second write with the SAME extractor name — array `+` would duplicate
        // without UNWIND/DISTINCT dedup
        await mergeMessageChannelWithKind(name, 'topic', undefined, 'COMMIT_B', { grounding: prov });
        node = await readChannel(name);
        expect(node!.evidence_extractors).toEqual(['symfony-messenger-php@v1']); // NOT [x, x]

        // Third write with a different extractor — should accumulate
        const prov2 = astGrounding('rabbitmq-amqp-extractor@v1');
        await mergeMessageChannelWithKind(name, 'topic', undefined, 'COMMIT_C', { grounding: prov2 });
        node = await readChannel(name);
        expect((node!.evidence_extractors as string[]).sort()).toEqual(
            ['rabbitmq-amqp-extractor@v1', 'symfony-messenger-php@v1'],
        );

        await wipeByName(name);
    });

    it('dedupes evidence_mergedFrom across re-welded writes', async () => {
        const name = 'acme.test.grounding.dedup-mergedfrom';
        await wipeByName(name);

        // Simulate a welder result: surviving node carries mergedFrom: [subId]
        const survivor: GroundingFields = {
            source: 'composite',
            quality: 'high',
            evidence: {
                extractors: ['cross-kind-weld@v1'],
                mergedFrom: ['cr://test/sub-id-A'],
            },
        };

        await mergeMessageChannelWithKind(name, 'topic', undefined, 'C1', { grounding: survivor });
        let node = await readChannel(name);
        expect(node!.evidence_mergedFrom).toEqual(['cr://test/sub-id-A']);

        // Re-write with the SAME mergedFrom — must NOT duplicate
        await mergeMessageChannelWithKind(name, 'topic', undefined, 'C2', { grounding: survivor });
        node = await readChannel(name);
        expect(node!.evidence_mergedFrom).toEqual(['cr://test/sub-id-A']);

        // Append a new mergedFrom entry
        const survivor2: GroundingFields = {
            ...survivor,
            evidence: { ...survivor.evidence, mergedFrom: ['cr://test/sub-id-B'] },
        };
        await mergeMessageChannelWithKind(name, 'topic', undefined, 'C3', { grounding: survivor2 });
        node = await readChannel(name);
        expect((node!.evidence_mergedFrom as string[]).sort()).toEqual(
            ['cr://test/sub-id-A', 'cr://test/sub-id-B'],
        );

        await wipeByName(name);
    });

    it('overwrites source/quality scalars on ON MATCH (composite re-evaluation)', async () => {
        const name = 'acme.test.grounding.scalar-overwrite';
        await wipeByName(name);

        // First: ast/exact (provider extraction). Grounding is passed via the
        // opts bag so the mutation exercises the real grounding write path
        // instead of the defensive UNTAGGED default.
        await mergeMessageChannelWithKind(name, 'topic', undefined, 'C1', { grounding: astGrounding('provider@v1') });
        let node = await readChannel(name);
        expect(node!.source).toBe('ast');
        expect(node!.quality).toBe('exact');

        // Second write: composite welder result (different source, lower quality).
        // The mutation overwrites scalars — the caller is responsible for invoking
        // compositeGrounding() / weldGrounding() to compute the right combined
        // values before writing.
        const welded = weldGrounding(
            astGrounding('provider@v1'),
            llmGrounding('m', 'h', 'unified-analyzer@v1', 'medium'),
            'cr://test/sub',
            'cross-kind-weld@v1',
        );
        await mergeMessageChannelWithKind(name, 'topic', undefined, 'C2', { grounding: welded });
        node = await readChannel(name);
        expect(node!.source).toBe('composite');
        expect(node!.quality).toBe('medium'); // min(exact, medium)

        await wipeByName(name);
    });
});
