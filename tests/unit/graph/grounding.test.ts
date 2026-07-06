import { describe, it, expect } from 'vitest';
import {
    astGrounding,
    heuristicGrounding,
    llmGrounding,
    compositeGrounding,
    applyFallback,
    weldGrounding,
    infraGrounding,
    mergeEvidence,
    minQuality,
    maxQuality,
    qualityAtLeast,
    flattenGrounding,
    unflattenGrounding,
    SOURCE_VALUES,
    QUALITY_VALUES,
    type GroundingFields,
    type Quality,
} from '../../../src/graph/grounding.js';

describe('provenance enums', () => {
    it('exports the 7 Source values in stable order', () => {
        expect(SOURCE_VALUES).toEqual(['ast', 'heuristic', 'llm', 'composite', 'declared', 'infra', 'runtime']);
    });

    it('exports the 5 Quality values from best to worst', () => {
        expect(QUALITY_VALUES).toEqual(['exact', 'high', 'medium', 'low', 'speculative']);
    });
});

describe('quality utilities', () => {
    it('minQuality returns the lower-ranked tier', () => {
        expect(minQuality('exact', 'low')).toBe('low');
        expect(minQuality('high', 'medium')).toBe('medium');
        expect(minQuality('speculative', 'exact')).toBe('speculative');
        expect(minQuality('medium', 'medium')).toBe('medium');
    });

    it('maxQuality returns the higher-ranked tier', () => {
        expect(maxQuality('exact', 'low')).toBe('exact');
        expect(maxQuality('high', 'medium')).toBe('high');
        expect(maxQuality('speculative', 'exact')).toBe('exact');
    });

    it('qualityAtLeast respects the rank ordering', () => {
        expect(qualityAtLeast('exact', 'high')).toBe(true);
        expect(qualityAtLeast('high', 'high')).toBe(true);
        expect(qualityAtLeast('medium', 'high')).toBe(false);
        expect(qualityAtLeast('speculative', 'low')).toBe(false);
    });
});

describe('astGrounding builder', () => {
    it('produces a pure-AST provenance with no fallbacks', () => {
        const p = astGrounding('php-static-analyzer@v1');
        expect(p.source).toBe('ast');
        expect(p.quality).toBe('exact');
        expect(p.evidence.extractors).toEqual(['php-static-analyzer@v1']);
        expect(p.evidence.fallbacksApplied).toBeUndefined();
        expect(p.evidence.llmCalls).toBeUndefined();
    });

    it('accepts optional fallback markers', () => {
        const p = astGrounding('php-static-analyzer@v1', ['legacy-property-alias']);
        expect(p.evidence.fallbacksApplied).toEqual(['legacy-property-alias']);
    });
});

describe('heuristicGrounding builder', () => {
    it('produces heuristic/medium with the extractor as evidence', () => {
        const p = heuristicGrounding('code-route-extractor@v1');
        expect(p.source).toBe('heuristic');
        expect(p.quality).toBe('medium');
        expect(p.evidence.extractors).toEqual(['code-route-extractor@v1']);
        expect(p.evidence.llmCalls).toBeUndefined();
    });

    it('accepts a quality override for weaker signals', () => {
        const p = heuristicGrounding('code-route-extractor@v1', 'low');
        expect(p.quality).toBe('low');
    });
});

describe('llmGrounding builder', () => {
    it('attaches model + promptHash + ISO timestamp', () => {
        const p = llmGrounding('vertex/gemini-2.5-flash-lite', 'a1b2c3');
        expect(p.source).toBe('llm');
        expect(p.quality).toBe('medium');
        expect(p.evidence.llmCalls).toHaveLength(1);
        expect(p.evidence.llmCalls![0].model).toBe('vertex/gemini-2.5-flash-lite');
        expect(p.evidence.llmCalls![0].promptHash).toBe('a1b2c3');
        expect(p.evidence.llmCalls![0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('accepts a quality override (e.g. low for marginal LLM emissions)', () => {
        const p = llmGrounding('vertex/gemini-2.5-flash-lite', 'h', 'unified-analyzer@v1', 'low');
        expect(p.quality).toBe('low');
    });
});

describe('compositeGrounding', () => {
    it('merges two same-source provenances; quality is min, source unchanged', () => {
        const a = astGrounding('php-static-analyzer@v1');   // ast/exact
        const b = astGrounding('ts-static-analyzer@v1');    // ast/exact
        const merged = compositeGrounding(a, b);
        expect(merged.source).toBe('ast');
        expect(merged.quality).toBe('exact');
        expect(merged.evidence.extractors.sort()).toEqual(['php-static-analyzer@v1', 'ts-static-analyzer@v1']);
    });

    it('promotes quality one tier when sources differ (cross-source agreement)', () => {
        const a: GroundingFields = {
            source: 'ast', quality: 'medium',
            evidence: { extractors: ['php-handler-inbound@v1'] },
        };
        const b = llmGrounding('vertex/gemini-2.5-flash-lite', 'h', 'unified-analyzer@v1', 'medium');
        const merged = compositeGrounding(a, b);
        expect(merged.source).toBe('composite');
        expect(merged.quality).toBe('high'); // medium promoted to high on cross-source agreement
    });

    it('caps composite quality at high — exact is reserved for single-source ground truth', () => {
        const a = astGrounding('php-static-analyzer@v1'); // ast/exact
        const b = llmGrounding('m', 'h');                  // llm/medium
        const merged = compositeGrounding(a, b);
        expect(merged.source).toBe('composite');
        // min(exact, medium) = medium; cross-source promotes to high; capped at high.
        expect(merged.quality).toBe('high');
    });

    it('preserves needsReview if either input had it', () => {
        const a = astGrounding('x');
        const b: GroundingFields = { ...llmGrounding('m', 'h'), needsReview: true };
        expect(compositeGrounding(a, b).needsReview).toBe(true);
    });
});

describe('applyFallback', () => {
    it('appends fallback marker and demotes quality by one tier', () => {
        const upstream = astGrounding('php-static-analyzer@v1');
        const after = applyFallback(upstream, 'env-var-stem-normalize');
        expect(after.evidence.fallbacksApplied).toEqual(['env-var-stem-normalize']);
        expect(after.quality).toBe('high'); // demoted from exact
    });

    it('demotes from speculative stays at speculative (floor)', () => {
        const upstream: GroundingFields = {
            source: 'llm', quality: 'speculative',
            evidence: { extractors: ['x'] },
        };
        expect(applyFallback(upstream, 'fb').quality).toBe('speculative');
    });

    it('dedupes repeated fallback names', () => {
        const upstream = astGrounding('x');
        const a = applyFallback(upstream, 'fb');
        const b = applyFallback(a, 'fb');
        expect(b.evidence.fallbacksApplied).toEqual(['fb']);
    });
});

describe('weldGrounding', () => {
    it('merges evidence, sets mergedFrom (append-only deduped), quality=min', () => {
        const surv: GroundingFields = {
            source: 'ast', quality: 'high',
            evidence: { extractors: ['php-handler-inbound@v1'] },
        };
        const sub: GroundingFields = {
            source: 'llm', quality: 'medium',
            evidence: { extractors: ['unified-analyzer@v1'], llmCalls: [{ model: 'm', promptHash: 'h', timestamp: '2026-01-01T00:00:00Z' }] },
        };
        const welded = weldGrounding(surv, sub, 'cr:channel:topic:sub-id-123', 'class-name-bridge@v1');
        expect(welded.source).toBe('composite'); // sources differed
        expect(welded.quality).toBe('medium');   // min(high, medium)
        expect(welded.evidence.mergedFrom).toEqual(['cr:channel:topic:sub-id-123']);
        expect(welded.evidence.extractors).toContain('php-handler-inbound@v1');
        expect(welded.evidence.extractors).toContain('unified-analyzer@v1');
        expect(welded.evidence.extractors).toContain('class-name-bridge@v1');
        expect(welded.evidence.llmCalls).toHaveLength(1);
    });

    it('mergedFrom is append-only when re-welded with the same predecessor', () => {
        const surv: GroundingFields = {
            source: 'composite', quality: 'high',
            evidence: { extractors: ['x'], mergedFrom: ['id-1'] },
        };
        const sub = astGrounding('y');
        const welded = weldGrounding(surv, sub, 'id-1', 'welder@v1');
        expect(welded.evidence.mergedFrom).toEqual(['id-1']); // not duplicated
    });
});

describe('mergeEvidence', () => {
    it('deduplicates extractors and concatenates llmCalls', () => {
        const a = { extractors: ['x', 'y'], llmCalls: [{ model: 'm1', promptHash: 'h1', timestamp: 't1' }] };
        const b = { extractors: ['y', 'z'], llmCalls: [{ model: 'm2', promptHash: 'h2', timestamp: 't2' }] };
        const merged = mergeEvidence(a, b);
        expect(merged.extractors).toEqual(['x', 'y', 'z']);
        expect(merged.llmCalls).toHaveLength(2);
    });

    it('omits empty optional fields', () => {
        const merged = mergeEvidence({ extractors: ['x'] }, { extractors: ['y'] });
        expect(merged.llmCalls).toBeUndefined();
        expect(merged.fallbacksApplied).toBeUndefined();
        expect(merged.mergedFrom).toBeUndefined();
    });
});

describe('flatten / unflatten round-trip', () => {
    it('roundtrips a minimal ast/exact provenance', () => {
        const original = astGrounding('php-static-analyzer@v1');
        const flat = flattenGrounding(original);
        const reconstructed = unflattenGrounding(flat as unknown as Record<string, unknown>);
        expect(reconstructed).not.toBeNull();
        expect(reconstructed!.source).toBe('ast');
        expect(reconstructed!.quality).toBe('exact');
        expect(reconstructed!.evidence.extractors).toEqual(['php-static-analyzer@v1']);
    });

    it('roundtrips an LLM call entry through JSON-string array', () => {
        const original = llmGrounding('vertex/gemini-2.5-flash-lite', 'a1b2c3');
        const flat = flattenGrounding(original);
        expect(flat.evidence_llmCalls).toHaveLength(1);
        expect(typeof flat.evidence_llmCalls![0]).toBe('string'); // JSON-encoded
        const reconstructed = unflattenGrounding(flat as unknown as Record<string, unknown>)!;
        expect(reconstructed.evidence.llmCalls).toHaveLength(1);
        expect(reconstructed.evidence.llmCalls![0].model).toBe('vertex/gemini-2.5-flash-lite');
        expect(reconstructed.evidence.llmCalls![0].promptHash).toBe('a1b2c3');
    });

    it('roundtrips a composite welded provenance with mergedFrom', () => {
        const surv: GroundingFields = {
            source: 'composite', quality: 'high',
            evidence: { extractors: ['x', 'y'], mergedFrom: ['id-1', 'id-2'], fallbacksApplied: ['fb-1'] },
            needsReview: true,
            lastSeenCommit: 'abc123',
        };
        const flat = flattenGrounding(surv);
        const back = unflattenGrounding(flat as unknown as Record<string, unknown>)!;
        expect(back.source).toBe('composite');
        expect(back.evidence.mergedFrom).toEqual(['id-1', 'id-2']);
        expect(back.evidence.fallbacksApplied).toEqual(['fb-1']);
        expect(back.needsReview).toBe(true);
        expect(back.lastSeenCommit).toBe('abc123');
    });

    it('returns null when source/quality fields are missing (legacy / pre-provenance node)', () => {
        expect(unflattenGrounding({})).toBeNull();
        expect(unflattenGrounding({ source: 'ast' })).toBeNull();
        expect(unflattenGrounding({ quality: 'exact' })).toBeNull();
    });

    it('skips llmCalls entries that fail JSON parse (defensive)', () => {
        const reconstructed = unflattenGrounding({
            source: 'llm',
            quality: 'medium',
            evidence_extractors: ['x'],
            evidence_llmCalls: ['{"valid":"json","model":"m","promptHash":"h","timestamp":"t"}', 'not-valid-json'],
        })!;
        expect(reconstructed.evidence.llmCalls).toHaveLength(1);
        expect(reconstructed.evidence.llmCalls![0].model).toBe('m');
    });
});

describe('evidence_llmCalls dedup + cap', () => {
    // Risk #2 from the architectural review: Cypher `IN` on JSON-string arrays
    // does strict string equality, so two LlmCallEvidence entries with the
    // same model+promptHash but different timestamps never dedup at the DB
    // layer. The TS-side merge MUST canonicalize before flattening.

    it('mergeEvidence dedupes llmCalls by (model, promptHash), keeping most recent', () => {
        const a: import('../../../src/graph/grounding.js').Evidence = {
            extractors: ['x'],
            llmCalls: [
                { model: 'gemini', promptHash: 'h1', timestamp: '2026-01-01T00:00:00Z' },
                { model: 'gemini', promptHash: 'h2', timestamp: '2026-01-01T00:00:00Z' },
            ],
        };
        const b: import('../../../src/graph/grounding.js').Evidence = {
            extractors: ['y'],
            // Same model+promptHash as the first entry above, newer timestamp.
            llmCalls: [
                { model: 'gemini', promptHash: 'h1', timestamp: '2026-05-01T00:00:00Z' },
            ],
        };
        const merged = mergeEvidence(a, b);
        expect(merged.llmCalls).toHaveLength(2);                            // not 3
        const h1 = merged.llmCalls!.find(c => c.promptHash === 'h1')!;
        expect(h1.timestamp).toBe('2026-05-01T00:00:00Z');                  // most recent kept
    });

    it('mergeEvidence caps llmCalls at 10 entries (drops oldest)', () => {
        const calls = Array.from({ length: 15 }, (_, i) => ({
            model: 'gemini',
            promptHash: `h${i}`,
            timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        }));
        const merged = mergeEvidence({ extractors: ['x'], llmCalls: calls }, { extractors: ['x'] });
        expect(merged.llmCalls).toHaveLength(10);
        // Cap keeps the most recent 10, so the oldest (h0..h4) must be gone.
        expect(merged.llmCalls!.map(c => c.promptHash)).not.toContain('h0');
        expect(merged.llmCalls!.map(c => c.promptHash)).toContain('h14');
    });

    it('flattenGrounding defensively dedupes llmCalls even when caller bypasses mergeEvidence', () => {
        // A caller might construct GroundingFields directly (e.g. from a
        // deserialized cached object) with duplicate llmCalls. The flatten
        // path is the boundary that reaches Memgraph, so it must canonicalize
        // unconditionally.
        const prov: GroundingFields = {
            source: 'llm', quality: 'medium',
            evidence: {
                extractors: ['x'],
                llmCalls: [
                    { model: 'gemini', promptHash: 'h1', timestamp: '2026-01-01T00:00:00Z' },
                    { model: 'gemini', promptHash: 'h1', timestamp: '2026-02-01T00:00:00Z' },
                    { model: 'gemini', promptHash: 'h1', timestamp: '2026-03-01T00:00:00Z' },
                ],
            },
        };
        const flat = flattenGrounding(prov);
        expect(flat.evidence_llmCalls).toHaveLength(1);
        const parsed = JSON.parse(flat.evidence_llmCalls![0]);
        expect(parsed.timestamp).toBe('2026-03-01T00:00:00Z');
    });
});

describe('untagged default does not silently look authoritative', () => {
    // Risk #4 from the architectural review. The defensive default for
    // callers that forget to pass provenance MUST visibly degrade the tier
    // (not write ast/exact) so a re-touch on a high-trust edge surfaces in
    // operator triage. Read the constant indirectly via groundingParams.

    it('groundingParams(undefined, ...) emits heuristic/speculative with needsReview=true', async () => {
        // Dynamic import so vi.mock-style globals don't interfere; this is
        // a pure-function check with no DB dependency.
        const { groundingParams } = await import('../../../src/graph/mutations/_run.js');
        const params = groundingParams(undefined, 'C1');
        expect(params.ground_source).toBe('heuristic');
        expect(params.ground_quality).toBe('speculative');
        expect(params.ground_needsReview).toBe(true);
        expect(params.ground_extractors).toEqual(['untagged@v1']);
    });

    it('groundingParams(real, ...) does NOT clobber the caller-supplied provenance', async () => {
        const { groundingParams } = await import('../../../src/graph/mutations/_run.js');
        const real: GroundingFields = {
            source: 'composite', quality: 'high',
            evidence: { extractors: ['real@v1'] },
        };
        const params = groundingParams(real, 'C1');
        expect(params.ground_source).toBe('composite');
        expect(params.ground_quality).toBe('high');
        expect(params.ground_extractors).toEqual(['real@v1']);
    });
});

describe('quality assignment matrix invariants', () => {
    // The matrix from the plan: each row asserts the rule.
    const cases: Array<[string, () => Quality, Quality]> = [
        ['Pure AST', () => astGrounding('x').quality, 'exact'],
        ['LLM-only default', () => llmGrounding('m', 'h').quality, 'medium'],
        ['Cross-source promotion', () => compositeGrounding(astGrounding('x'), llmGrounding('m', 'h')).quality, 'high'],
        ['Welder min', () => weldGrounding(
            { source: 'ast', quality: 'high', evidence: { extractors: ['x'] } },
            { source: 'ast', quality: 'low', evidence: { extractors: ['y'] } },
            'id', 'w',
        ).quality, 'low'],
        ['Fallback demotion', () => applyFallback(astGrounding('x'), 'fb').quality, 'high'],
    ];

    for (const [label, fn, expected] of cases) {
        it(`matrix row: ${label} -> ${expected}`, () => {
            expect(fn()).toBe(expected);
        });
    }
});

describe('infraGrounding', () => {
    it('produces infra/high grounding with the given extractor', () => {
        const g = infraGrounding('osv-enrichment@v1');
        expect(g.source).toBe('infra');
        expect(g.quality).toBe('high');
        expect(g.evidence.extractors).toEqual(['osv-enrichment@v1']);
    });

    it('composites with ast grounding promote to composite/high', () => {
        const ast = astGrounding('package-manifest@v1');
        const infra = infraGrounding('osv-enrichment@v1');
        const c = compositeGrounding(ast, infra);
        expect(c.source).toBe('composite');
        expect(c.quality).toBe('high');
        expect(c.evidence.extractors).toContain('package-manifest@v1');
        expect(c.evidence.extractors).toContain('osv-enrichment@v1');
    });
});
