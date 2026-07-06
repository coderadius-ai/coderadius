/**
 * Pure data utilities for the v3 single-stream list view.
 *
 * `mergeStream` deduplicates a flat list of TieredBlastNode by (urn, direction),
 * collapsing multiple edges into one row with a deduped `rels[]` array — the
 * same dedup pattern used by `panel/TieredBlastPanel.tsx:28-52` but keyed on
 * the (urn, direction) pair so a node that appears both upstream and downstream
 * yields two rows (one per direction), which is the correct semantic for a
 * unified single-stream view.
 *
 * Filter / sort / count helpers are kept here so the list view stays a thin
 * shell composing reusable presentational primitives.
 *
 * No JSX imports: keeps this module testable in plain .test.ts files without
 * pulling Taxonomy.tsx into the test graph.
 */

import type { TieredBlastNode } from '../../../lib/topology';
import { TYPE_SORT_ORDER, sortItems } from './sort';

export interface StreamRow extends TieredBlastNode {
    rels: string[];
    totalCount: number;
}

export type Direction = 'all' | 'in' | 'out';
export type SortKey = 'default' | 'name' | 'direction' | 'rel';

export interface StreamFilters {
    query: string;
    direction: Direction;
    activeKinds: Set<string>;
}

export const T2_KEY = 'T2';

function makeKey(urn: string, direction: 'upstream' | 'downstream'): string {
    return `${urn}::${direction}`;
}

/**
 * Group `TieredBlastNode[]` by (urn, direction). Each surviving row keeps a
 * deduped `rels[]` (sorted alphabetically for stable display), accumulates
 * `functions[]` (deduped by name), and promotes to `tier=2` if any of the
 * collapsed inputs is T2 (preserving the first `via` seen).
 */
export function mergeStream(items: TieredBlastNode[]): StreamRow[] {
    const map = new Map<string, StreamRow>();
    for (const item of items) {
        const key = makeKey(item.urn, item.direction);
        const existing = map.get(key);
        if (existing) {
            existing.totalCount++;
            const incoming = item.rels ? [item.rel, ...item.rels] : [item.rel];
            for (const r of incoming) {
                if (!existing.rels.includes(r)) existing.rels.push(r);
            }
            if (item.tier === 2) {
                existing.tier = 2;
                if (!existing.via && item.via) existing.via = item.via;
            }
            if (item.functions && item.functions.length > 0) {
                const ex = existing.functions ?? [];
                const merged = [...ex];
                for (const fn of item.functions) {
                    if (!merged.some(f => f.name === fn.name)) merged.push(fn);
                }
                existing.functions = merged;
            }
        } else {
            const rels = item.rels
                ? Array.from(new Set([item.rel, ...item.rels]))
                : [item.rel];
            map.set(key, { ...item, rels, totalCount: 1 });
        }
    }
    for (const row of map.values()) {
        row.rels = [...row.rels].sort();
    }
    return Array.from(map.values());
}

export function matchesQuery(row: StreamRow, query: string): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    const { node, urn } = row;
    if (node.name.toLowerCase().includes(q)) return true;
    if (urn.toLowerCase().includes(q)) return true;
    if (node.teamOwner && node.teamOwner.toLowerCase().includes(q)) return true;
    if (node.repository?.name && node.repository.name.toLowerCase().includes(q)) return true;
    return false;
}

export function matchesDirection(row: StreamRow, direction: Direction): boolean {
    if (direction === 'all') return true;
    if (direction === 'in') return row.direction === 'upstream';
    if (direction === 'out') return row.direction === 'downstream';
    return true;
}

/**
 * Kind filter with the same semantics as `panel/TieredBlastPanel.tsx:57`:
 * empty set → no filter; the synthetic `T2` key matches any row with
 * `tier === 2`; otherwise union semantics across selected node types.
 */
export function matchesKind(row: StreamRow, activeKinds: Set<string>): boolean {
    if (activeKinds.size === 0) return true;
    if (activeKinds.has(T2_KEY) && row.tier === 2) return true;
    return activeKinds.has(row.node.type);
}

export function filterStream(rows: StreamRow[], filters: StreamFilters): StreamRow[] {
    return rows.filter(row =>
        matchesQuery(row, filters.query)
        && matchesDirection(row, filters.direction)
        && matchesKind(row, filters.activeKinds),
    );
}

/**
 * Sort variants for the toolbar `<select>`.
 *
 * - `default`: delegates to the shared `sortItems` (T2 first, then by
 *   `TYPE_SORT_ORDER`, then alphabetical). Used as the initial order so the
 *   list reads the same as the legacy panel view on first paint.
 * - `name`: pure alphabetical across all tiers/directions.
 * - `direction`: downstream first, then upstream, with the default sort
 *   applied within each group.
 * - `rel`: groups by the first rel of each row (alphabetical), then by name.
 */
export function sortStream(rows: StreamRow[], sort: SortKey): StreamRow[] {
    if (sort === 'default') {
        return sortItems(rows) as StreamRow[];
    }
    const copy = [...rows];
    if (sort === 'name') {
        copy.sort((a, b) => a.node.name.localeCompare(b.node.name));
        return copy;
    }
    if (sort === 'direction') {
        copy.sort((a, b) => {
            if (a.direction !== b.direction) {
                return a.direction === 'downstream' ? -1 : 1;
            }
            const orderA = TYPE_SORT_ORDER[a.node.type] ?? 99;
            const orderB = TYPE_SORT_ORDER[b.node.type] ?? 99;
            if (orderA !== orderB) return orderA - orderB;
            return a.node.name.localeCompare(b.node.name);
        });
        return copy;
    }
    if (sort === 'rel') {
        copy.sort((a, b) => {
            const ra = a.rels[0] ?? '';
            const rb = b.rels[0] ?? '';
            if (ra !== rb) return ra.localeCompare(rb);
            return a.node.name.localeCompare(b.node.name);
        });
        return copy;
    }
    return copy;
}

/**
 * Counts per node-kind (plus a synthetic `T2` count) for the kind-chip
 * toolbar. Respects active `query + direction` but excludes the kind
 * dimension itself, so chip counts answer "how many rows would survive if
 * I clicked this chip" rather than "how many rows match the current
 * filter" (which would always be zero for chips that aren't already in
 * `activeKinds`). This is the Linear/Vercel convention.
 */
export function countByKindInScope(
    rows: StreamRow[],
    query: string,
    direction: Direction,
): { byKind: Map<string, number>; t2: number } {
    const byKind = new Map<string, number>();
    let t2 = 0;
    for (const row of rows) {
        if (!matchesQuery(row, query)) continue;
        if (!matchesDirection(row, direction)) continue;
        byKind.set(row.node.type, (byKind.get(row.node.type) ?? 0) + 1);
        if (row.tier === 2) t2++;
    }
    return { byKind, t2 };
}

/**
 * Counts per direction for the All / In / Out pills. Respects active
 * `query + activeKinds` but excludes the direction dimension itself.
 */
export function countByDirectionInScope(
    rows: StreamRow[],
    query: string,
    activeKinds: Set<string>,
): { all: number; in: number; out: number } {
    let all = 0; let inn = 0; let out = 0;
    for (const row of rows) {
        if (!matchesQuery(row, query)) continue;
        if (!matchesKind(row, activeKinds)) continue;
        all++;
        if (row.direction === 'upstream') inn++;
        else if (row.direction === 'downstream') out++;
    }
    return { all, in: inn, out };
}
