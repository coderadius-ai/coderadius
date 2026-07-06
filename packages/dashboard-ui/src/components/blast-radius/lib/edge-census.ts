import type { TopologyMap } from '@coderadius/shared-types';

export interface EdgeCensusEntry {
    rel: string;
    count: number;
}

/**
 * Graph-wide edge census for one node: every edge touching `urn`, grouped by
 * relationship type. Powers the "All edges" Overview row, which answers
 * "how shared is this node?" beyond the paths the drawer happens to display.
 *
 * Counting semantics: each edge instance counts once. A self-loop
 * (source === target === urn) appears in BOTH adjacency lists, so in-edges
 * whose source is `urn` itself are skipped (already counted as out-edges).
 *
 * Order: count descending, then alphabetical, so the strongest signal leads
 * and the output is deterministic.
 */
export function edgeCensus(topology: TopologyMap, urn: string): EdgeCensusEntry[] {
    const counts = new Map<string, number>();
    const bump = (rel: string) => counts.set(rel, (counts.get(rel) ?? 0) + 1);

    for (const edge of topology.out[urn] ?? []) bump(edge.rel);
    for (const edge of topology.in[urn] ?? []) {
        if (edge.source === urn) continue; // self-loop, counted via out[]
        bump(edge.rel);
    }

    return Array.from(counts, ([rel, count]) => ({ rel, count }))
        .sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
}
