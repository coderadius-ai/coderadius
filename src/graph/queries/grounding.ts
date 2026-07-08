/**
 * Grounding aggregator queries
 *
 * Read-only Cypher that answers operational questions about the trust tier
 * distribution across the graph. Used by:
 *   - `cr sync code` final report (breakdown per node label)
 *   - `cr doctor` (lists items where `needsReview = true`)
 *   - dashboard toolbar filter chips (qualityAtLeast, sourceIn)
 *
 * Convention: each function reads only the flat grounding properties
 * (`source`, `quality`, `evidence_*`, `needsReview`) populated by
 * `groundingWriteClause()` from `mutations/_run.ts`. Schema mirror in
 * `src/graph/grounding.ts`.
 */
import { run } from '../mutations/_run.js';
import { QUALITY_VALUES, type Quality, type Source } from '../grounding.js';

/**
 * Inferred families that carry decision-relevant grounding. Pure-structural
 * node labels (SourceFile, Function, Class, Repository, Service, Team, ...) are
 * intentionally excluded: they're stamped `ast/exact` uniformly and would
 * drown out the meaningful tiers in any aggregate.
 *
 * Keep in sync with `isStructuralFamily()` on the UI side.
 */
export const INFERRED_NODE_LABELS = [
    'MessageChannel',
    'DataContainer',
    'Datastore',
    'APIInterface',
    'APIEndpoint',
    'DataStructure',
    'Cache',
    'Database',
    'SystemProcess',
] as const;

export type InferredNodeLabel = typeof INFERRED_NODE_LABELS[number];

/**
 * Fix P1.2: extension of INFERRED_NODE_LABELS used ONLY by `listNeedsReview`.
 * Includes `SourceFile` so structural-plugin emits (e.g. Symfony Messenger PHP
 * dynamic-routing G7 case) that stamp `needsReview=true` on a source file are
 * surfaced by `cr doctor`. Quality breakdown queries continue to use
 * the narrow INFERRED_NODE_LABELS to avoid flooding aggregates with uniformly
 * `ast/exact` structural rows.
 *
 * Broker discovery additions: `MessageBroker` (guess-only / vhost-ambiguous
 * brokers carry needsReview and gate cross-service welds) and
 * `BrokerCandidate` (unbound ledger entries ARE the review queue — a
 * broker-ish env value nothing grounded). Without these labels the triage
 * queue would silently hide exactly the facts the ledger exists to surface.
 */
export const NEEDS_REVIEW_LABELS = [
    ...INFERRED_NODE_LABELS,
    'SourceFile',
    'MessageBroker',
    'BrokerCandidate',
] as const;

export type NeedsReviewLabel = typeof NEEDS_REVIEW_LABELS[number];

export interface QualityBreakdown {
    exact: number;
    high: number;
    medium: number;
    low: number;
    speculative: number;
}

export interface LabelBreakdown {
    label: InferredNodeLabel;
    total: number;
    tiers: QualityBreakdown;
    needsReview: number;
}

/**
 * Count active inferred nodes by grounding quality tier, grouped by label.
 *
 * Returns one row per inferred label even when zero nodes exist, so the
 * report shape stable across syncs.
 */
export async function countByQualityTier(): Promise<LabelBreakdown[]> {
    const breakdowns: LabelBreakdown[] = [];
    for (const label of INFERRED_NODE_LABELS) {
        const r = await run(
            `MATCH (n:${label})
             WHERE n.valid_to_commit IS NULL
             RETURN coalesce(n.quality, 'speculative') AS q,
                    coalesce(n.needsReview, false) AS r,
                    count(n) AS c`,
            {},
        );
        const tiers: QualityBreakdown = { exact: 0, high: 0, medium: 0, low: 0, speculative: 0 };
        let needsReview = 0;
        let total = 0;
        for (const rec of r.records) {
            const q = rec.get('q') as Quality;
            const n = Number(rec.get('c'));
            const flagged = rec.get('r') as boolean;
            if (QUALITY_VALUES.includes(q)) {
                tiers[q] += n;
            } else {
                tiers.speculative += n;
            }
            total += n;
            if (flagged) needsReview += n;
        }
        breakdowns.push({ label, total, tiers, needsReview });
    }
    return breakdowns;
}

export interface NeedsReviewItem {
    urn: string;
    label: NeedsReviewLabel;
    name: string;
    source: Source;
    quality: Quality;
    extractors: string[];
    fallbacksApplied: string[];
}

export interface ListNeedsReviewFilter {
    // Fix P3: accept the superset including SourceFile (matches runtime behaviour).
    label?: NeedsReviewLabel;
    qualityAtLeast?: Quality;
    sourceIn?: Source[];
}

/**
 * List every inferred node flagged with `needsReview = true`. Used by
 * `cr doctor` and the dashboard "Needs review" filter chip.
 *
 * Filters narrow the set:
 *   - `label`: restrict to a single inferred node label.
 *   - `qualityAtLeast`: include only nodes whose quality is at least the
 *     given tier (so qualityAtLeast='high' keeps exact + high, drops
 *     medium / low / speculative).
 *   - `sourceIn`: include only nodes whose grounding source is in the set.
 */
export async function listNeedsReview(filter: NeedsReviewLabel | ListNeedsReviewFilter = {}): Promise<NeedsReviewItem[]> {
    // Back-compat: legacy callers pass a bare label string.
    const f: ListNeedsReviewFilter = typeof filter === 'string'
        ? { label: filter }
        : filter;
    const labels = f.label ? [f.label] : NEEDS_REVIEW_LABELS;
    const allowedQualities = f.qualityAtLeast
        ? QUALITY_VALUES.slice(0, QUALITY_VALUES.indexOf(f.qualityAtLeast) + 1)
        : null;
    const items: NeedsReviewItem[] = [];
    for (const lbl of labels) {
        const params: Record<string, unknown> = {};
        const extraConditions: string[] = [];
        if (allowedQualities) {
            // Fix P2.1: coalesce on filter side too (must match the RETURN
            // defaults). SourceFile / structural emits often skip quality, so
            // raw `n.quality IN ...` drops them silently.
            extraConditions.push("coalesce(n.quality, 'speculative') IN $allowedQualities");
            params.allowedQualities = allowedQualities;
        }
        if (f.sourceIn && f.sourceIn.length > 0) {
            extraConditions.push("coalesce(n.source, 'heuristic') IN $allowedSources");
            params.allowedSources = f.sourceIn;
        }
        const extraClause = extraConditions.length > 0
            ? ' AND ' + extraConditions.join(' AND ')
            : '';
        const r = await run(
            // Fix P1: SourceFile emits carry `path` not `name`; coalesce so the
            // CLI renderer always gets a non-null display string (avoids
            // `null.padEnd()` crash). `source`/`quality` defaulted because
            // structural emits often skip them.
            `MATCH (n:${lbl})
             WHERE n.valid_to_commit IS NULL
               AND n.needsReview = true${extraClause}
             RETURN n.id AS urn,
                    coalesce(n.name, n.path, n.id) AS name,
                    coalesce(n.source, 'heuristic') AS source,
                    coalesce(n.quality, 'speculative') AS quality,
                    coalesce(n.evidence_extractors, []) AS extractors,
                    coalesce(n.evidence_fallbacksApplied, []) AS fallbacks
             ORDER BY coalesce(n.name, n.path, n.id)`,
            params,
        );
        for (const rec of r.records) {
            items.push({
                urn: rec.get('urn') as string,
                label: lbl,
                name: rec.get('name') as string,
                source: rec.get('source') as Source,
                quality: rec.get('quality') as Quality,
                extractors: (rec.get('extractors') as string[]) ?? [],
                fallbacksApplied: (rec.get('fallbacks') as string[]) ?? [],
            });
        }
    }
    return items;
}

/**
 * Find inferred nodes where the LLM and a deterministic extractor disagree.
 *
 * A "disputed" node is one whose `evidence_extractors` array contains BOTH:
 *   - an extractor tagged `llm` / `unified-analyzer`, AND
 *   - a deterministic extractor (anything else: connection-extractor,
 *     symfony-messenger-php, etc.)
 *
 * but the `source` ended up as `llm` (i.e. the static signal was missing or
 * weaker than the LLM signal). Surfacing these helps tune the resolver: if
 * the static signal SHOULD have won but didn't, the resolver is the gap.
 *
 * Excludes `composite` nodes since those already record the agreement.
 */
export interface DisputedItem {
    urn: string;
    label: InferredNodeLabel;
    name: string;
    extractors: string[];
}

export async function findDisputed(): Promise<DisputedItem[]> {
    const items: DisputedItem[] = [];
    for (const lbl of INFERRED_NODE_LABELS) {
        const r = await run(
            `MATCH (n:${lbl})
             WHERE n.valid_to_commit IS NULL
               AND n.source = 'llm'
               AND n.evidence_extractors IS NOT NULL
               AND size(n.evidence_extractors) > 1
               AND any(x IN n.evidence_extractors WHERE x STARTS WITH 'unified-analyzer' OR x CONTAINS '@llm')
               AND any(x IN n.evidence_extractors WHERE NOT (x STARTS WITH 'unified-analyzer' OR x CONTAINS '@llm'))
             RETURN n.id AS urn, n.name AS name, n.evidence_extractors AS extractors`,
            {},
        );
        for (const rec of r.records) {
            items.push({
                urn: rec.get('urn') as string,
                label: lbl,
                name: rec.get('name') as string,
                extractors: (rec.get('extractors') as string[]) ?? [],
            });
        }
    }
    return items;
}
