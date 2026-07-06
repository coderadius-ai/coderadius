/**
 * @coderadius/shared-types/grounding
 *
 * Canonical grounding ontology shared between the CLI backend and the
 * dashboard frontend. Single source of truth for the categorical enums and
 * structural-family classification so the two halves can never drift.
 *
 * "Grounding" answers: where is this fact anchored? Which extractor produced
 * it, what supports it, how much do we trust it. The ML term fits because
 * every inferred entity in the graph is grounded in (a) a deterministic AST
 * read, (b) an LLM call, (c) a static + LLM composite, or (d) a customer
 * declaration / infra snapshot / runtime trace.
 *
 * Pure values + types only. ZERO runtime dependencies. The backend wraps
 * these into zod schemas in `src/graph/grounding.ts`; the dashboard wraps
 * them into UI-specific palette / label maps in
 * `packages/dashboard-ui/src/types/grounding.ts`.
 *
 * Why this module exists: a shared TypeScript vocabulary makes a backend
 * change to the enum land in the frontend at compile time, removing the
 * manual mirror that previously caused silent drift.
 */

// ─── Source: who produced the fact ───────────────────────────────────────────

export const SOURCE_VALUES = [
    'ast',         // direct AST read; deterministic, no inference
    'heuristic',   // regex/pattern-based heuristic
    'llm',         // produced by an LLM call without static cross-check
    'composite',   // multiple sources concord (e.g. ast + llm, or registry lookup hit)
    'declared',    // customer asserted in coderadius.yaml
    'infra',       // confirmed by real infra snapshot (RabbitMQ admin, K8s, Terraform)
    'runtime',     // confirmed by OTel/runtime trace observation
] as const;
export type Source = typeof SOURCE_VALUES[number];

// ─── Quality: how much to trust it ───────────────────────────────────────────

export const QUALITY_VALUES = ['exact', 'high', 'medium', 'low', 'speculative'] as const;
export type Quality = typeof QUALITY_VALUES[number];

/**
 * Canonical tier ladder for quality. Higher number = stronger trust. Used by
 * `qualityAtLeast()` and by the dashboard's "Verified only" filter chip.
 *
 * Kept in this module so frontend filters and backend Cypher both branch on
 * the same ordering.
 */
export const QUALITY_RANK: Record<Quality, number> = {
    exact: 4,
    high: 3,
    medium: 2,
    low: 1,
    speculative: 0,
};

export function qualityAtLeast(value: Quality, threshold: Quality): boolean {
    return QUALITY_RANK[value] >= QUALITY_RANK[threshold];
}

// ─── Evidence: structured support for the fact ───────────────────────────────

export interface LlmCallEvidence {
    /** Provider/model id, e.g. 'vertex/gemini-2.5-flash-lite'. */
    model: string;
    /** Hash of the prompt body (NOT the response). */
    promptHash: string;
    /** Raw model score if the SDK exposes one. Opaque. */
    score?: number;
    /** ISO8601 timestamp. */
    timestamp: string;
}

export interface Evidence {
    /**
     * Names of the extractors / passes that contributed to the fact, each
     * versioned (e.g. 'symfony-messenger-php@v1'). Prompt or regex changes
     * create a new extractor name so stale entries stay queryable.
     */
    extractors: string[];
    /** LLM calls that produced or confirmed the fact, if any. */
    llmCalls?: LlmCallEvidence[];
    /**
     * Heuristic fallbacks that fired during extraction (e.g.
     * 'env-var-stem-normalize', 'cqrs-suffix-fallback'). The presence of any
     * fallback demotes `quality` by one tier in the backend builders.
     */
    fallbacksApplied?: string[];
    /**
     * Source-node IDs of welded predecessors (cross-kind dedup, suffix dedup,
     * class-name bridge). Empty when this node was created without a merge.
     */
    mergedFrom?: string[];
}

export interface GroundingFields {
    source: Source;
    evidence: Evidence;
    quality: Quality;
    /** True when human review should adjudicate. Operational signal; not derived from quality. */
    needsReview?: boolean;
    /** Commit sha at which the fact was last reconciled against fresh code. */
    lastSeenCommit?: string;
}

// ─── Structural family classification (UI suppression rule) ──────────────────

/**
 * Node labels that are uniformly stamped `ast/exact` because they're direct
 * AST artefacts. The dashboard hides the QualityBadge for these by default
 * so the inspectable "decision-relevant" badges (medium / low / speculative
 * on inferred entities) stand out.
 *
 * Keep negatively in sync with the backend's `INFERRED_NODE_LABELS` array
 * in `src/graph/queries/grounding.ts` (every label is either structural or
 * inferred, no overlap).
 */
const STRUCTURAL_NODE_LABELS = new Set<string>([
    'Repository',
    'Service',
    'SourceFile',
    'Function',
    'Class',
    'Package',
    'Release',
    'ProjectDirectory',
    'StructuralFile',
    'Team',
    'TeamAlias',
    'Library',
    'System',
    'Domain',
    'Link',
    'CIComponent',
]);

const STRUCTURAL_EDGE_TYPES = new Set<string>([
    'CONTAINS',
    'HAS_ENDPOINT',
    'PART_OF',
    'OWNS',
    'OWNS_REPOSITORY',
    'DEFINES',
    'HAS_LINK',
    'INCLUDES_COMPONENT',
]);

/**
 * `true` when the given node label or edge type belongs to the structural
 * family (uniformly ast/exact, badge suppressed by default).
 */
export function isStructuralFamily(labelOrEdgeType: string): boolean {
    return STRUCTURAL_NODE_LABELS.has(labelOrEdgeType)
        || STRUCTURAL_EDGE_TYPES.has(labelOrEdgeType);
}
