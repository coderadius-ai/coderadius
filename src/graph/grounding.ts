/**
 * Grounding / Evidence / Quality model. Single source of truth.
 *
 * Every inferred node/edge in the graph carries:
 *   - `source`: categorical, who/what produced the fact (stable across LLM model changes)
 *   - `evidence`: structured object, inspectable (extractors, llm calls, fallbacks, merges)
 *   - `quality`: categorical confidence tier, assigned by explicit per-pipeline rules
 *
 * "Grounding" is the ML term for anchoring a claim in retrieved evidence:
 * every inferred entity is grounded in (a) a deterministic AST read, (b) an
 * LLM call, (c) an AST + LLM composite, or (d) a customer declaration / infra
 * snapshot / runtime trace.
 *
 * Why these three together and not a single `confidence: float`:
 *   1. Non-commensurability: an AST-derived 0.8 vs an LLM-derived 0.8 are different objects
 *   2. Confidence-of-what: existence, classification, relation are orthogonal questions
 *   3. Spurious compoundability: float math along paths is plausible but wrong
 *   4. LLM model drift: numeric scores aren't comparable across model upgrades
 *   5. Decisions are categorical: UI filters threshold, no float ordering is meaningful
 *
 * Quality is ASSIGNED from explicit rules per pipeline, NOT derived via
 * probability math.
 */

import { z } from 'zod';

// ─── Vocabulary re-export from the shared-types package ──────────────────────
//
// The categorical enums and pure-type interfaces live in
// `packages/shared-types/grounding.ts` so the dashboard frontend and the
// backend agree at the TypeScript compiler level (no manual mirror). The
// backend layers zod schemas + the builder/welder logic on top.

export {
    SOURCE_VALUES,
    QUALITY_VALUES,
    QUALITY_RANK,
    qualityAtLeast,
    isStructuralFamily,
} from '@coderadius/shared-types';
export type {
    Source,
    Quality,
    LlmCallEvidence,
    Evidence,
    GroundingFields,
} from '@coderadius/shared-types';

import {
    SOURCE_VALUES,
    QUALITY_VALUES,
    QUALITY_RANK,
    type Source,
    type Quality,
    type LlmCallEvidence,
    type Evidence,
    type GroundingFields,
} from '@coderadius/shared-types';

// ─── Zod schemas (mirror) ────────────────────────────────────────────────────

export const SourceSchema = z.enum(SOURCE_VALUES);
export const QualitySchema = z.enum(QUALITY_VALUES);

export const LlmCallEvidenceSchema = z.object({
    model: z.string(),
    promptHash: z.string(),
    score: z.number().optional(),
    timestamp: z.string(),
});

export const EvidenceSchema = z.object({
    extractors: z.array(z.string()),
    llmCalls: z.array(LlmCallEvidenceSchema).optional(),
    fallbacksApplied: z.array(z.string()).optional(),
    mergedFrom: z.array(z.string()).optional(),
});

export const GroundingFieldsSchema = z.object({
    source: SourceSchema,
    evidence: EvidenceSchema,
    quality: QualitySchema,
    needsReview: z.boolean().optional(),
    lastSeenCommit: z.string().optional(),
});

/**
 * Flat-fields schema that mirrors the Memgraph node/edge property layout.
 * Mixed into every node Zod schema in `domain.ts` so types reflect what is
 * actually stored. Read paths use `unflattenGrounding()` to reconstruct the
 * structured form for UI/queries.
 */
export const GroundingFlatFieldsSchema = z.object({
    source: SourceSchema.optional(),
    quality: QualitySchema.optional(),
    evidence_extractors: z.array(z.string()).optional(),
    evidence_llmCalls: z.array(z.string()).nullable().optional(),
    evidence_fallbacksApplied: z.array(z.string()).nullable().optional(),
    evidence_mergedFrom: z.array(z.string()).nullable().optional(),
    needsReview: z.boolean().nullable().optional(),
    lastSeenCommit: z.string().nullable().optional(),
});
export type GroundingFlatFields = z.infer<typeof GroundingFlatFieldsSchema>;

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * Build a pure-AST grounding block. Used by static extractors that read facts
 * directly (file existence, function declaration, deterministic config parse).
 */
export function astGrounding(extractor: string, fallbacksApplied?: string[]): GroundingFields {
    return {
        source: 'ast',
        quality: 'exact',
        evidence: {
            extractors: [extractor],
            ...(fallbacksApplied && fallbacksApplied.length > 0 ? { fallbacksApplied } : {}),
        },
    };
}

/**
 * Build a heuristic grounding block. Used by deterministic extractors whose
 * CONCLUSION is a convention-based guess rather than an AST-read fact (e.g.
 * legacy PHP filesystem routing: the file is real, but "this file is served
 * at this URL with these methods" is inferred from signals). Default quality
 * is 'medium'; callers can demote to 'low' for weaker signals.
 */
export function heuristicGrounding(extractor: string, quality: Quality = 'medium'): GroundingFields {
    return {
        source: 'heuristic',
        quality,
        evidence: {
            extractors: [extractor],
        },
    };
}

/**
 * Build an LLM-only grounding block. Used when the LLM produced a fact with no
 * static cross-check. Default quality is 'medium'; callers can override down to
 * 'low' or 'speculative' when sanitizer guards barely passed.
 */
export function llmGrounding(
    model: string,
    promptHash: string,
    extractor = 'unified-analyzer@v1',
    quality: Quality = 'medium',
): GroundingFields {
    return {
        source: 'llm',
        quality,
        evidence: {
            extractors: [extractor],
            llmCalls: [{
                model,
                promptHash,
                timestamp: new Date().toISOString(),
            }],
        },
    };
}

/**
 * Build a composite grounding block by merging two upstream groundings.
 * Use when two sources concord (AST extractor + LLM agreement, registry lookup
 * + dispatch site, etc.).
 *
 * Quality rule for composite: MIN of input qualities, then PROMOTE one tier if
 * the sources are different (cross-checking is stronger evidence than either
 * alone). Composite source is always 'composite' when the two inputs disagree;
 * if both inputs share a source, the source stays the same (no degradation).
 */
export function compositeGrounding(
    a: GroundingFields,
    b: GroundingFields,
    extraExtractor?: string,
): GroundingFields {
    const merged = mergeEvidence(a.evidence, b.evidence);
    if (extraExtractor) merged.extractors = uniqueAppend(merged.extractors, extraExtractor);

    const baseQuality = minQuality(a.quality, b.quality);
    const sameSource = a.source === b.source;
    // Cross-source agreement promotes one tier, capped at 'high' (exact is reserved for
    // single-source ground truth: pure AST, declared, infra, runtime, not cross-confirmation).
    // Same-source merges preserve the original quality without artificial cap.
    const finalQuality: Quality = sameSource
        ? baseQuality
        : capQuality(promoteQuality(baseQuality), 'high');

    return {
        source: sameSource ? a.source : 'composite',
        quality: finalQuality,
        evidence: merged,
        needsReview: a.needsReview || b.needsReview,
        lastSeenCommit: a.lastSeenCommit ?? b.lastSeenCommit,
    };
}

/**
 * Sanitizer-style transform: takes an upstream grounding, appends a fallback
 * marker, and demotes quality by one tier (the transform is a guess, even if
 * a defensible one).
 */
export function applyFallback(
    upstream: GroundingFields,
    fallbackName: string,
    extraExtractor?: string,
): GroundingFields {
    const evidence: Evidence = {
        ...upstream.evidence,
        fallbacksApplied: uniqueAppend(upstream.evidence.fallbacksApplied ?? [], fallbackName),
    };
    if (extraExtractor) evidence.extractors = uniqueAppend(evidence.extractors, extraExtractor);
    return {
        ...upstream,
        evidence,
        quality: demoteQuality(upstream.quality),
    };
}

/**
 * Build a grounding block for data sourced from an external authoritative
 * registry or infrastructure query (e.g., OSV.dev vulnerability database,
 * container registry metadata). Quality is 'high' (curated, not speculative)
 * rather than 'exact' (reserved for deterministic AST reads).
 */
export function infraGrounding(extractor: string): GroundingFields {
    return {
        source: 'infra',
        quality: 'high',
        evidence: {
            extractors: [extractor],
        },
    };
}

/**
 * Build a grounding block for a fact the customer DECLARED in coderadius.yaml
 * (tenant identity, decorators, hints). Default quality is 'exact': a
 * declaration is ground truth for that fact, in the same single-source family
 * as 'ast' / 'infra' / 'runtime', not an inference to be doubted.
 */
export function declaredGrounding(extractor: string, quality: Quality = 'exact'): GroundingFields {
    return {
        source: 'declared',
        quality,
        evidence: {
            extractors: [extractor],
        },
    };
}

/**
 * Welder: merges N predecessor groundings into the surviving node's
 * grounding. Records mergedFrom IDs (append-only, deduped); quality is
 * min(quality) of inputs; source is 'composite' when sources differ.
 */
export function weldGrounding(
    survivor: GroundingFields,
    subordinate: GroundingFields,
    subordinateNodeId: string,
    welderExtractor: string,
): GroundingFields {
    const evidence = mergeEvidence(survivor.evidence, subordinate.evidence);
    evidence.extractors = uniqueAppend(evidence.extractors, welderExtractor);
    evidence.mergedFrom = uniqueAppend(evidence.mergedFrom ?? [], subordinateNodeId);

    return {
        source: survivor.source === subordinate.source ? survivor.source : 'composite',
        quality: minQuality(survivor.quality, subordinate.quality),
        evidence,
        needsReview: survivor.needsReview || subordinate.needsReview,
        lastSeenCommit: survivor.lastSeenCommit ?? subordinate.lastSeenCommit,
    };
}

// ─── Evidence merging ────────────────────────────────────────────────────────

/**
 * Cap on retained LLM-call evidence entries per node. Each entry is roughly
 * 200 bytes once flattened (JSON-stringified) so 10 entries keeps node bloat
 * under 2 KB even on heavily re-welded nodes.
 */
const MAX_LLM_CALLS_RETAINED = 10;

/**
 * Dedup llmCalls by (model, promptHash). Keep the MOST RECENT entry per pair
 * (compared by `timestamp` ISO string lexicographic order, which is also
 * chronological for ISO8601). Cap the survivor list at `MAX_LLM_CALLS_RETAINED`.
 *
 * Why this matters: Cypher's `IN` operator on flattened JSON-string arrays
 * does strict string equality. Two LlmCallEvidence objects with the same
 * model and promptHash but different timestamps serialize to DIFFERENT JSON
 * strings, so Cypher's reduce-based dedup never matches them and the array
 * would balloon across re-syncs. We dedup in TypeScript before flattening.
 */
function dedupeLlmCalls(calls: LlmCallEvidence[]): LlmCallEvidence[] {
    const byKey = new Map<string, LlmCallEvidence>();
    for (const c of calls) {
        const key = `${c.model}::${c.promptHash}`;
        const existing = byKey.get(key);
        if (!existing || (c.timestamp ?? '') >= (existing.timestamp ?? '')) {
            byKey.set(key, c);
        }
    }
    const out = Array.from(byKey.values());
    // Most recent last; trim oldest if we exceed the cap.
    out.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    return out.length > MAX_LLM_CALLS_RETAINED
        ? out.slice(out.length - MAX_LLM_CALLS_RETAINED)
        : out;
}

export function mergeEvidence(a: Evidence, b: Evidence): Evidence {
    const mergedCalls = (a.llmCalls || b.llmCalls)
        ? dedupeLlmCalls([...(a.llmCalls ?? []), ...(b.llmCalls ?? [])])
        : undefined;
    return {
        extractors: uniqueConcat(a.extractors, b.extractors),
        ...(mergedCalls && mergedCalls.length > 0 ? { llmCalls: mergedCalls } : {}),
        ...(a.fallbacksApplied || b.fallbacksApplied
            ? { fallbacksApplied: uniqueConcat(a.fallbacksApplied ?? [], b.fallbacksApplied ?? []) }
            : {}),
        ...(a.mergedFrom || b.mergedFrom
            ? { mergedFrom: uniqueConcat(a.mergedFrom ?? [], b.mergedFrom ?? []) }
            : {}),
    };
}

// ─── Quality utilities ───────────────────────────────────────────────────────
// `qualityAtLeast` is re-exported from `@coderadius/shared-types` at the top
// of this file so backend filters and the dashboard share the same predicate.

export function minQuality(a: Quality, b: Quality): Quality {
    return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

export function maxQuality(a: Quality, b: Quality): Quality {
    return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

function demoteQuality(q: Quality): Quality {
    const r = QUALITY_RANK[q];
    if (r <= 0) return 'speculative';
    const next = QUALITY_VALUES.find(v => QUALITY_RANK[v] === r - 1);
    return next ?? 'speculative';
}

function promoteQuality(q: Quality): Quality {
    const r = QUALITY_RANK[q];
    if (r >= 4) return 'exact';
    const next = QUALITY_VALUES.find(v => QUALITY_RANK[v] === r + 1);
    return next ?? 'exact';
}

function capQuality(q: Quality, ceiling: Quality): Quality {
    return minQuality(q, ceiling);
}

// ─── Memgraph flattening (nested objects not supported) ──────────────────────

export interface FlattenedGrounding {
    source: Source;
    quality: Quality;
    evidence_extractors: string[];
    evidence_llmCalls: string[] | null;       // each entry is JSON.stringify(LlmCallEvidence)
    evidence_fallbacksApplied: string[] | null;
    evidence_mergedFrom: string[] | null;
    needsReview: boolean | null;
    lastSeenCommit: string | null;
}

export function flattenGrounding(p: GroundingFields): FlattenedGrounding {
    // Defensive dedup at the flatten boundary: even if a caller bypasses
    // mergeEvidence and constructs a GroundingFields object directly with
    // duplicate llmCalls, the JSON-string projection that lands in Memgraph
    // stays canonical (one entry per model+promptHash, capped).
    const canonicalLlmCalls = p.evidence.llmCalls && p.evidence.llmCalls.length > 0
        ? dedupeLlmCalls(p.evidence.llmCalls)
        : null;
    return {
        source: p.source,
        quality: p.quality,
        evidence_extractors: p.evidence.extractors,
        evidence_llmCalls: canonicalLlmCalls && canonicalLlmCalls.length > 0
            ? canonicalLlmCalls.map(c => JSON.stringify(c))
            : null,
        evidence_fallbacksApplied: p.evidence.fallbacksApplied && p.evidence.fallbacksApplied.length > 0
            ? p.evidence.fallbacksApplied
            : null,
        evidence_mergedFrom: p.evidence.mergedFrom && p.evidence.mergedFrom.length > 0
            ? p.evidence.mergedFrom
            : null,
        needsReview: p.needsReview ?? null,
        lastSeenCommit: p.lastSeenCommit ?? null,
    };
}

/**
 * Reconstruct a GroundingFields object from a flat Memgraph record (read path).
 * Returns null when the source field is absent (legacy data or pre-grounding graph).
 */
export function unflattenGrounding(record: Record<string, unknown>): GroundingFields | null {
    const source = record.source as Source | null | undefined;
    const quality = record.quality as Quality | null | undefined;
    if (!source || !quality) return null;

    const extractors = (record.evidence_extractors as string[] | null) ?? [];
    const rawLlmCalls = (record.evidence_llmCalls as string[] | null) ?? null;
    const llmCalls = rawLlmCalls
        ? rawLlmCalls.map(s => {
            try { return JSON.parse(s) as LlmCallEvidence; } catch { return null; }
        }).filter((x): x is LlmCallEvidence => x !== null)
        : undefined;

    const evidence: Evidence = {
        extractors,
        ...(llmCalls && llmCalls.length > 0 ? { llmCalls } : {}),
        ...(record.evidence_fallbacksApplied ? { fallbacksApplied: record.evidence_fallbacksApplied as string[] } : {}),
        ...(record.evidence_mergedFrom ? { mergedFrom: record.evidence_mergedFrom as string[] } : {}),
    };

    return {
        source,
        quality,
        evidence,
        ...(record.needsReview !== null && record.needsReview !== undefined
            ? { needsReview: record.needsReview as boolean }
            : {}),
        ...(record.lastSeenCommit ? { lastSeenCommit: record.lastSeenCommit as string } : {}),
    };
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function uniqueAppend(arr: string[], v: string): string[] {
    return arr.includes(v) ? arr : [...arr, v];
}

function uniqueConcat(a: string[], b: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of [...a, ...b]) {
        if (!seen.has(v)) {
            seen.add(v);
            out.push(v);
        }
    }
    return out;
}
