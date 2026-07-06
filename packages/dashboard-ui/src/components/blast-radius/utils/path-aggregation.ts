import type { TopologyNode } from '@coderadius/shared-types';
import type { RelationshipPath } from '../../../lib/topology';
import { sortRels } from '../../Taxonomy';

/**
 * One row in the relationships list = one unique intermediate `via` node
 * (or a single "direct" group for 1-hop paths). Multiple `RelationshipPath`s
 * that traverse the same via with different rel pairs are collapsed into one
 * group: the schema is keyed by `via.urn`, so rel-pair distinctions are noise
 * for the user. Per-direction rel info is preserved in the Functions section.
 */
/** Aggregate traversal direction for a segment (collapsed across paths). */
export type SegmentDirection = 'forward' | 'reversed' | 'mixed';

export interface PathGroup {
    /** Stable selection key: `via.urn` for 2-hop, `__direct__` for 1-hop. */
    key: string;
    /** Intermediate node, absent for direct (1-hop) groups. */
    via?: { urn: string; node: TopologyNode };
    /** All paths that fold into this group (preserved for function union). */
    paths: RelationshipPath[];
    /** Unique source-side rels (rels[0]) across all paths. */
    sourceRels: string[];
    /** Unique target-side rels (rels[last]) across all paths. */
    targetRels: string[];
    /** Aggregate direction of the source-side segment (selectedNode → via). */
    sourceDirection: SegmentDirection;
    /** Aggregate direction of the target-side segment (via → targetNode).
     *  For 1-hop groups this equals `sourceDirection`. */
    targetDirection: SegmentDirection;
    /** Aggregated `bindingReason` for the source-side step (only meaningful
     *  for STORED_IN edges). Populated when every path in the group agrees
     *  on the same non-null reason; null otherwise to avoid surfacing a
     *  mixed signal. */
    sourceBindingReason?: string | null;
    /** Same as `sourceBindingReason` but for the target-side step. */
    targetBindingReason?: string | null;
}

export function aggregateDirection(reversedFlags: boolean[]): SegmentDirection {
    if (reversedFlags.length === 0) return 'forward';
    const allForward  = reversedFlags.every(r => r === false);
    const allReversed = reversedFlags.every(r => r === true);
    if (allForward)  return 'forward';
    if (allReversed) return 'reversed';
    return 'mixed';
}

/** Reduces a list of bindingReason values to a single representative:
 *  the unique non-null value if all entries agree, else null. */
function reduceBindingReason(values: Array<string | null | undefined>): string | null {
    let agreed: string | null = null;
    for (const v of values) {
        if (!v) continue;
        if (agreed === null) agreed = v;
        else if (agreed !== v) return null; // mixed → suppress
    }
    return agreed;
}

export function groupPaths(paths: RelationshipPath[]): PathGroup[] {
    const groups = new Map<string, PathGroup & {
        _sourceReversed: boolean[];
        _targetReversed: boolean[];
        _sourceBindingReasons: Array<string | null | undefined>;
        _targetBindingReasons: Array<string | null | undefined>;
    }>();
    for (const p of paths) {
        const key = p.via?.urn ?? '__direct__';
        let g = groups.get(key);
        if (!g) {
            g = {
                key,
                via: p.via,
                paths: [],
                sourceRels: [],
                targetRels: [],
                sourceDirection: 'forward',
                targetDirection: 'forward',
                _sourceReversed: [],
                _targetReversed: [],
                _sourceBindingReasons: [],
                _targetBindingReasons: [],
            };
            groups.set(key, g);
        }
        g.paths.push(p);
        const first = p.rels[0];
        const last  = p.rels[p.rels.length - 1];
        const firstRev = p.relsReversed[0] ?? false;
        const lastRev  = p.relsReversed[p.relsReversed.length - 1] ?? false;
        if (first && !g.sourceRels.includes(first)) g.sourceRels.push(first);
        if (last  && !g.targetRels.includes(last))  g.targetRels.push(last);
        g._sourceReversed.push(firstRev);
        g._targetReversed.push(lastRev);
        g._sourceBindingReasons.push(p.relsBindingReason?.[0]);
        g._targetBindingReasons.push(p.relsBindingReason?.[p.relsBindingReason.length - 1]);
    }
    // Finalise direction summaries and apply canonical rel ordering so the
    // badges render in the same sequence across rows.
    return Array.from(groups.values())
        .map(g => ({
            ...g,
            sourceRels: sortRels(g.sourceRels),
            targetRels: sortRels(g.targetRels),
            sourceDirection: aggregateDirection(g._sourceReversed),
            targetDirection: aggregateDirection(g._targetReversed),
            sourceBindingReason: reduceBindingReason(g._sourceBindingReasons),
            targetBindingReason: reduceBindingReason(g._targetBindingReasons),
        }))
        // Push the 1-hop "direct" group last: getAllPaths emits direct paths
        // first, but the drawer auto-selects groups[0], and a via group (with
        // its functions/schema) is the more useful default landing than the
        // bare direct edge. Stable sort preserves via-group insertion order.
        .sort((a, b) => (a.key === '__direct__' ? 1 : 0) - (b.key === '__direct__' ? 1 : 0));
}

/**
 * Walk the paths in a group on one side (source or target) and return each
 * unique function paired with the *set of rels* it actually appears under.
 * If a function shows up in both a `WRITES` and a `READS` path, both letters
 * appear next to it in the UI. Rels are sorted via the canonical order.
 */
export function aggregateFunctions(
    paths: RelationshipPath[],
    side: 'source' | 'target',
): Array<{ fn: { name: string; file: string | null; startLine?: number }; rels: string[] }> {
    const map = new Map<string, { fn: { name: string; file: string | null; startLine?: number }; rels: Set<string> }>();
    for (const p of paths) {
        const fns = side === 'source' ? p.sourceFunctions : p.targetFunctions;
        if (!fns) continue;
        const rel = side === 'source' ? p.rels[0] : p.rels[p.rels.length - 1];
        for (const f of fns) {
            const key = `${f.name}::${f.file ?? ''}`;
            let entry = map.get(key);
            if (!entry) {
                entry = { fn: f, rels: new Set<string>() };
                map.set(key, entry);
            }
            if (rel) entry.rels.add(rel);
        }
    }
    return Array.from(map.values()).map(({ fn, rels }) => ({ fn, rels: sortRels([...rels]) }));
}
