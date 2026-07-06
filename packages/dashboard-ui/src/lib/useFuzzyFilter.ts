/**
 * useFuzzyFilter — Reusable React hook for in-memory fuzzy filtering
 *
 * Wraps the core fuzzyMatch() engine in a memoized hook.
 * Any component that needs a filterable list calls this hook with:
 *   - The items to filter
 *   - The current query string
 *   - A `keys` function that extracts searchable text from each item
 *
 * Returns items sorted by best match score, each enriched with
 * per-key match ranges for highlighting.
 *
 * When query is empty, returns all items unchanged (passthrough mode).
 */

import { useMemo } from 'react';
import { fuzzyMatch } from './fuzzy-match';
import type { FuzzyMatchResult, MatchRange } from './fuzzy-match';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface FuzzyFilterResult<T> {
    /** The original item */
    item: T;
    /** Match result for each key (in the same order as keys()) */
    matches: (FuzzyMatchResult | null)[];
    /** Best score across all keys (used for sorting) */
    bestScore: number;
    /** Convenience: ranges for the first matched key (most common use) */
    primaryRanges: MatchRange[] | undefined;
}

export interface FuzzyFilterOptions<T> {
    /** Extract one or more searchable strings from each item.
     *  First key is treated as "primary" for highlight convenience. */
    keys: (item: T) => string[];
    /** Maximum number of results to return. Default: unlimited. */
    limit?: number;
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Filter and rank items using fuzzy matching.
 *
 * @example
 *   const results = useFuzzyFilter(impacts, query, {
 *     keys: item => [item.node.name, item.urn],
 *   });
 *   // results[0].item — the original item
 *   // results[0].primaryRanges — highlight ranges for item.node.name
 */
export function useFuzzyFilter<T>(
    items: T[],
    query: string,
    options: FuzzyFilterOptions<T>,
): FuzzyFilterResult<T>[] {
    const { keys, limit } = options;

    return useMemo(() => {
        const q = query.trim();

        // Passthrough: no query → return all items unscored
        if (!q) {
            return items.map(item => ({
                item,
                matches: [],
                bestScore: 0,
                primaryRanges: undefined,
            }));
        }

        const scored: FuzzyFilterResult<T>[] = [];

        for (const item of items) {
            const searchKeys = keys(item);
            const matches: (FuzzyMatchResult | null)[] = [];
            let bestScore = 0;
            let anyMatch = false;

            for (const key of searchKeys) {
                const result = fuzzyMatch(q, key);
                matches.push(result);
                if (result) {
                    anyMatch = true;
                    if (result.score > bestScore) {
                        bestScore = result.score;
                    }
                }
            }

            if (anyMatch) {
                // primaryRanges = ranges from the first key that matched
                const firstMatch = matches.find(m => m !== null);
                scored.push({
                    item,
                    matches,
                    bestScore,
                    primaryRanges: firstMatch?.ranges,
                });
            }
        }

        // Sort: highest score first
        scored.sort((a, b) => b.bestScore - a.bestScore);

        return limit ? scored.slice(0, limit) : scored;
    }, [items, query, keys, limit]);
}
