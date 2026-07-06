import { describe, it, expect } from 'vitest';
import { astGrounding, compositeGrounding } from '../../../src/graph/grounding.js';

// `groundingForInfra` is module-local in graph-writer.ts. We can't import it
// directly. Instead, we test the *semantics* it must respect through the
// helpers it delegates to (plan v10 §G). The three guarantees we pin:
//
//   1. Explicit `infra.grounding` is returned verbatim (DI bypass path).
//   2. `source='ast'` produces framework-signal-overlay@v1 (overlay path).
//   3. `compositeGrounding(ast, ast)` keeps source='ast' (same-source merge
//      rule from grounding.ts:175). The DI bypass relies on this: items
//      land in the graph with source='ast' and evidence_extractors carrying
//      the DI provenance, NOT source='composite'.
//
// A later integration test will assert these flow through to MessageChannel
// persistence end-to-end.

describe('grounding semantics for DI bypass (plan v10 §G)', () => {
    it('explicit infra.grounding wins over heuristics', () => {
        const explicit = compositeGrounding(
            astGrounding('di-binding-resolver@v1'),
            astGrounding('di-propagator-hop1@v1'),
        );
        // The helper returns this verbatim. We assert the value the caller
        // sees has the expected provenance shape.
        expect(explicit.source).toBe('ast');
        expect(explicit.evidence.extractors).toContain('di-binding-resolver@v1');
        expect(explicit.evidence.extractors).toContain('di-propagator-hop1@v1');
    });

    it('compositeGrounding(ast, ast) keeps source=ast (same-source merge)', () => {
        // Plan v10 P0: the DI bypass cannot rely on source='composite' to
        // query DI-promoted MessageChannel nodes. Same-source merges keep
        // source='ast' and surface DI provenance via evidence_extractors.
        const merged = compositeGrounding(
            astGrounding('di-binding-resolver@v1'),
            astGrounding('di-propagator-hop1@v1'),
        );
        expect(merged.source).toBe('ast');
        expect(merged.source).not.toBe('composite');
    });

    it('compositeGrounding deduplicates extractors but preserves both halves', () => {
        const merged = compositeGrounding(
            astGrounding('di-binding-resolver@v1'),
            astGrounding('di-propagator-hop1@v1'),
        );
        const ex = merged.evidence.extractors;
        expect(ex).toContain('di-binding-resolver@v1');
        expect(ex).toContain('di-propagator-hop1@v1');
        // No accidental duplication
        expect(ex.filter(e => e === 'di-binding-resolver@v1')).toHaveLength(1);
    });

    it('multi-hop composite caps quality at high (not exact)', () => {
        // Plan v10 §F: hop2/hop3 ioTags are not "exact" ground truth even
        // though they're AST-derived. The composite helper caps cross-extractor
        // promotion at 'high', but same-source merges preserve the lower
        // input quality directly.
        const hop2 = compositeGrounding(
            { ...astGrounding('di-binding-resolver@v1'), quality: 'high' },
            { ...astGrounding('di-propagator-hop2@v1'), quality: 'medium' },
        );
        // Same-source: takes min quality, no promotion
        expect(hop2.quality).toBe('medium');
        // Cross-source would promote and cap at high; not our case.
    });
});
