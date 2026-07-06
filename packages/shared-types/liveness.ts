/**
 * Repository liveness — single source of truth for tier derivation.
 *
 * Storage convention: the graph carries only `Repository.livenessCommits`
 * (raw 12-month no-merges commit count). The discrete tier (elite / high /
 * medium / low / unknown) is computed on read by `tierFromCommits()` so the
 * thresholds can move without re-ingesting the graph.
 *
 * `unknown` is the sentinel for "no count available" (shallow clone, missing
 * .git, repo path without remote). It is NOT a tier on the activity scale,
 * just an absence-of-data marker.
 */

export type LivenessTier = 'elite' | 'high' | 'medium' | 'low' | 'unknown';

/** Tier boundaries, exported so consumers (Cypher comments, UI filters) can reference them. */
export const LIVENESS_THRESHOLDS = {
    ELITE_MIN_COMMITS: 30,
    HIGH_MIN_COMMITS: 5,
} as const;

/**
 * Derive the activity tier from the raw 12-month commit count.
 *
 * Pure function, deterministic, O(1). Safe to call per-row in transformers
 * and per-render in components.
 */
export function tierFromCommits(commits: number | null | undefined): LivenessTier {
    if (commits == null) return 'unknown';
    if (commits >= LIVENESS_THRESHOLDS.ELITE_MIN_COMMITS) return 'elite';
    if (commits >= LIVENESS_THRESHOLDS.HIGH_MIN_COMMITS) return 'high';
    if (commits > 0) return 'medium';
    return 'low';
}

/**
 * "Active enough to be worth governance scrutiny": any non-null, non-zero
 * commit count. Used by tech-blindspot and capability-gap Cypher to exclude
 * dormant and unknown-state repositories.
 */
export function isActiveRepo(commits: number | null | undefined): boolean {
    return commits != null && commits > 0;
}
