// ─── Blast graph model builder ───────────────────────────────────────────────
// Pure transform: (topology + pivot + tiered impact + filters) → { nodes, edges }.
// Extracted from BlastRadiusGraphView's D3 effect so the node/edge construction
// is unit-testable in isolation (the effect keeps layout + rendering only).
//
// Nodes are returned with x:0,y:0 — the view's column-grid layout assigns real
// positions after the clustering pass.

import type { TopologyMap, TopologyNode } from '@coderadius/shared-types';
import type { TieredBlast, TieredBlastNode } from './topology';
import { getAllPaths } from './topology';
import { fuzzyMatch } from './fuzzy-match';
import type { GraphNode, GraphEdge } from '../components/blast-radius/types';

export function cardDims(tier: 0 | 1 | 2) {
    // Heights sized to fit 16x16 RelBadge chips with ≥10 px breathing
    // top/bottom — comfortably above the card border, no visual clip even
    // under subpixel rounding.
    if (tier === 0) return { w: 260, h: 84, rx: 10 };
    if (tier === 1) return { w: 240, h: 68, rx: 8 };
    return { w: 220, h: 60, rx: 7 };
}

export interface BlastGraphModelInput {
    topology: TopologyMap;
    selectedUrn: string;
    selectedNode: TopologyNode;
    impact: TieredBlast;
    hiddenTypes: Set<string>;
    hiddenRels: Set<string>;
    showT2: boolean;
    graphQuery: string;
}

export interface BlastGraphModel {
    /** Pre-cluster nodes with `rels` populated; x/y are placeholders (0). */
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** "src|tgt|rel" pre-cluster signature → set of T2 URNs whose multi-via
     *  fan-out produced that edge. Consumed by the view to gate hover reveal. */
    multiViaSigs: Map<string, Set<string>>;
    /** T2 URN → number of distinct passthrough bridges (drives the "+N" pill). */
    t2BridgeCounts: Map<string, number>;
}

/**
 * Build the node/edge model for the blast graph from the tiered impact list.
 * Mirrors the D3 effect's former inline logic 1:1, with one correctness fix:
 * the multi-via fan-out no longer re-emits a leg that the primary impact loop
 * already drew (see `hasUndirectedEdge` below).
 */
export function buildBlastGraphModel(input: BlastGraphModelInput): BlastGraphModel {
    const { topology, selectedUrn, selectedNode, impact, hiddenTypes, hiddenRels, showT2, graphQuery } = input;

    const nodesMap = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const d0 = cardDims(0);
    nodesMap.set(selectedUrn, { id: selectedUrn, urn: selectedUrn, node: selectedNode, tier: 0, direction: 'center', col: 0, cardW: d0.w, cardH: d0.h, x: 0, y: 0 });

    const addNode = (urn: string, node: TopologyNode, tier: 1 | 2, dir: 'upstream' | 'downstream') => {
        const existing = nodesMap.get(urn);
        if (!existing) {
            const d = cardDims(tier);
            const col = dir === 'upstream' ? -tier : tier;
            nodesMap.set(urn, { id: urn, urn, node, tier, direction: dir, col, cardW: d.w, cardH: d.h, x: 0, y: 0 });
            return;
        }
        // T2 wins over T1 (getTieredBlasts' contract). A node reachable both
        // directly (T1 — e.g. a speculative env-var service→service DEPENDS_ON)
        // and transitively via a passthrough (T2 — through an APIEndpoint) must
        // sit at the more-informative T2 column. Without this promotion,
        // addNode's first-wins freeze pins the node at T1, so the via→node 2-hop
        // edge terminates in the wrong column and the 2-hop collapses visually.
        // Promote only (never demote): a later T1 call on a T2 node is ignored.
        if (tier > existing.tier) {
            const d = cardDims(tier);
            existing.tier = tier;
            existing.direction = dir;
            existing.col = dir === 'upstream' ? -tier : tier;
            existing.cardW = d.w;
            existing.cardH = d.h;
        }
    };
    const addEdge = (s: string, t: string, rel: string) => edges.push({ id: `${s}->${t}`, source: s, target: t, rel });

    // Does an edge with the SAME undirected {pair, rel} already exist? The
    // primary impact loops orient edges by blast flow (pivot-outward), while
    // the multi-via fan-out orients by the underlying topology edge direction
    // (`relsReversed`). For a reverse-flow rel like LISTENS_TO/READS/CALLS the
    // two conventions disagree, so the same logical leg would be pushed twice
    // with swapped endpoints — two parallel edges the directional dedup can't
    // collapse. Gating the fan-out on this predicate keeps a single edge per
    // (pair, rel) while still letting genuinely-additional vias through (they
    // target a different via→node pair). Mutual edges (A→B and B→A of the same
    // rel) are both primary, so they never reach this gate.
    const hasUndirectedEdge = (a: string, b: string, rel: string) =>
        edges.some(e => e.rel === rel && ((e.source === a && e.target === b) || (e.source === b && e.target === a)));

    const isHidden = (n: TopologyNode) => hiddenTypes.has(n.type);
    const isHiddenRel = (rel: string) => hiddenRels.has(rel);

    // Sidebar fuzzy filter — when a query is active, drop any leaf node
    // whose name AND urn both miss. The via (T1 intermediate of a T2
    // path) is kept unconditionally so the surviving T2 edges still have
    // their hop. The pivot is always kept (it's the user's anchor).
    const matchesQuery = (item: TieredBlastNode): boolean => {
        if (!graphQuery) return true;
        return fuzzyMatch(graphQuery, item.node.name) !== null
            || fuzzyMatch(graphQuery, item.urn) !== null;
    };

    // ── Dual-role placement heuristic ──
    // A passthrough that the pivot BOTH reads and writes (e.g. a table
    // that's both an input and an output for the pivot) appears in
    // `impact.upstream` AND `impact.downstream`. Placing it on either
    // side creates spaghetti: the OTHER side's T2 connections have to
    // cross the canvas to reach it.
    //
    // Heuristic: place the node where it has MORE T2 traffic. We count
    // the number of T2 entries that traverse this URN as their `via`
    // intermediate, on each side. Direct presence counts as 1 per side
    // (so a node with no T2 weight on either side defaults to whichever
    // side it appears on first; a tie prefers downstream — the more
    // common "blast" narrative is "I write data → consumers break").
    const upstreamUrns = new Set(impact.upstream.map(i => i.urn));
    const downstreamUrns = new Set(impact.downstream.map(i => i.urn));
    const effectiveDir = new Map<string, 'upstream' | 'downstream'>();
    for (const urn of new Set([...upstreamUrns, ...downstreamUrns])) {
        const isUp = upstreamUrns.has(urn);
        const isDown = downstreamUrns.has(urn);
        if (isUp && !isDown) { effectiveDir.set(urn, 'upstream'); continue; }
        if (isDown && !isUp) { effectiveDir.set(urn, 'downstream'); continue; }
        // Dual-role: weigh by T2 traffic flowing through this node.
        let leftWeight = 1;   // direct upstream membership
        let rightWeight = 1;  // direct downstream membership
        for (const t of impact.upstream) if (t.tier === 2 && t.via?.urn === urn) leftWeight++;
        for (const t of impact.downstream) if (t.tier === 2 && t.via?.urn === urn) rightWeight++;
        effectiveDir.set(urn, rightWeight >= leftWeight ? 'downstream' : 'upstream');
    }
    const dirFor = (urn: string, fallback: 'upstream' | 'downstream') =>
        effectiveDir.get(urn) ?? fallback;

    // ── Loop order is now incidental: dirFor() decides the column for
    //    every node regardless of which loop calls addNode first. We
    //    process upstream first only as a stable iteration order. ──
    impact.upstream.forEach(item => {
        if (isHidden(item.node)) return;
        if (item.tier === 2 && !showT2) return;
        if (!matchesQuery(item)) return;
        if (item.tier === 1) {
            if (isHiddenRel(item.rel)) return;
            addNode(item.urn, item.node, 1, dirFor(item.urn, 'upstream')); addEdge(item.urn, selectedUrn, item.rel);
        }
        else if (item.tier === 2 && item.via) {
            if (isHidden(item.via.node)) return;
            // Drop the entire path if either leg is filtered out: without
            // both rels visible the T2 cannot be reached from the pivot.
            if (isHiddenRel(item.via.rel) || isHiddenRel(item.rel)) return;
            addNode(item.via.urn, item.via.node, 1, dirFor(item.via.urn, 'upstream')); addEdge(item.via.urn, selectedUrn, item.via.rel);
            // If terminal node already in map as T1 (e.g. via DEPENDS_ON), still
            // wire the via→terminal edge so the DataContainer path is visible.
            addNode(item.urn, item.node, 2, dirFor(item.urn, 'upstream')); addEdge(item.urn, item.via.urn, item.rel);
        }
    });
    impact.downstream.forEach(item => {
        if (isHidden(item.node)) return;
        if (item.tier === 2 && !showT2) return;
        if (!matchesQuery(item)) return;
        if (item.tier === 1) {
            if (isHiddenRel(item.rel)) return;
            addNode(item.urn, item.node, 1, dirFor(item.urn, 'downstream')); addEdge(selectedUrn, item.urn, item.rel);
        }
        else if (item.tier === 2 && item.via) {
            if (isHidden(item.via.node)) return;
            if (isHiddenRel(item.via.rel) || isHiddenRel(item.rel)) return;
            addNode(item.via.urn, item.via.node, 1, dirFor(item.via.urn, 'downstream')); addEdge(selectedUrn, item.via.urn, item.via.rel);
            // If terminal node already in map as T1 (e.g. via DEPENDS_ON), still
            // wire the via→terminal edge so the DataContainer path is visible.
            addNode(item.urn, item.node, 2, dirFor(item.urn, 'downstream')); addEdge(item.via.urn, item.urn, item.rel);
        }
    });

    // ── Multi-via fan-out: regular edges, hidden by default ──
    // For each T2 node, walk getAllPaths (same source as the drawer) and
    // push every 2-hop bridge as a regular edge. Tag pre-cluster signature
    // → set of T2 URNs in `multiViaSigs` so we can identify these edges
    // post-clustering and gate them behind hover.
    // Per-T2 bridge counts feed the "+N" pill on the card.
    const multiViaSigs = new Map<string, Set<string>>(); // "src|tgt|rel" pre-cluster → T2 URNs
    const t2BridgeCounts = new Map<string, number>();
    const seenT2 = new Set<string>();
    for (const item of [...impact.upstream, ...impact.downstream]) {
        if (item.tier !== 2) continue;
        if (seenT2.has(item.urn)) continue;
        seenT2.add(item.urn);
        if (isHidden(item.node)) continue;
        if (!showT2) continue;
        if (!matchesQuery(item)) continue;
        const paths = getAllPaths(topology, selectedUrn, item.urn);
        const distinctVias = new Set<string>();
        for (const path of paths) {
            if (!path.via) continue;
            const viaUrn = path.via.urn;
            const viaNode = path.via.node;
            if (isHidden(viaNode)) continue;
            // Both legs of the bridge must be visible; otherwise the path
            // can't be drawn coherently.
            if (isHiddenRel(path.rels[0]) || isHiddenRel(path.rels[1])) continue;
            distinctVias.add(viaUrn);
            addNode(viaUrn, viaNode, 1, dirFor(viaUrn, path.relsReversed[0] ? 'upstream' : 'downstream'));
            // pivot ↔ via edge: orient by whether the underlying topology
            // edge points pivot→via (forward) or via→pivot (reversed).
            const pSrc = path.relsReversed[0] ? viaUrn : selectedUrn;
            const pTgt = path.relsReversed[0] ? selectedUrn : viaUrn;
            if (!hasUndirectedEdge(pSrc, pTgt, path.rels[0])) addEdge(pSrc, pTgt, path.rels[0]);
            // via ↔ target edge: same logic on the second leg.
            const tSrc = path.relsReversed[1] ? item.urn : viaUrn;
            const tTgt = path.relsReversed[1] ? viaUrn : item.urn;
            // Skip if the primary impact loop already drew this leg (in either
            // orientation): re-emitting it here only differs by direction and
            // paints a phantom counter-flowing parallel edge.
            if (!hasUndirectedEdge(tSrc, tTgt, path.rels[1])) {
                addEdge(tSrc, tTgt, path.rels[1]);
                const sig = `${tSrc}|${tTgt}|${path.rels[1]}`;
                const set = multiViaSigs.get(sig) ?? new Set<string>();
                set.add(item.urn);
                multiViaSigs.set(sig, set);
            }
        }
        t2BridgeCounts.set(item.urn, distinctVias.size);
    }

    // Suppress the direct pivot↔node edge for any node that resolved to T2.
    // Once a node is reachable through a passthrough (the 2-hop path is drawn),
    // a direct service→service edge to it — typically a speculative env-var
    // DEPENDS_ON — is redundant and confusing: it paints a straight pivot→node
    // line that skips the via column. The node stays wired via its via→node
    // edge, and the drawer still lists the direct path (getAllPaths). A node is
    // only at tier 2 when its T2 path actually rendered (showT2 + unfiltered),
    // so this never orphans a node.
    const t2Urns = new Set(Array.from(nodesMap.values()).filter(n => n.tier === 2).map(n => n.urn));
    if (t2Urns.size > 0) {
        for (let i = edges.length - 1; i >= 0; i--) {
            const e = edges[i];
            const other = e.source === selectedUrn ? e.target
                : e.target === selectedUrn ? e.source
                : null;
            if (other !== null && t2Urns.has(other)) edges.splice(i, 1);
        }
    }

    // Orphan cleanup: when rel filtering drops every edge touching a
    // node, the node would otherwise float in the graph disconnected
    // from the pivot. Drop any non-pivot node that has no remaining
    // edges. The pivot is always retained (it is the user's anchor).
    if (hiddenRels.size > 0) {
        const referenced = new Set<string>();
        referenced.add(selectedUrn);
        for (const e of edges) {
            referenced.add(e.source);
            referenced.add(e.target);
        }
        for (const urn of Array.from(nodesMap.keys())) {
            if (!referenced.has(urn)) nodesMap.delete(urn);
        }
    }

    const rawNodes = Array.from(nodesMap.values());

    // Per-node rels: union of edge kinds for every edge touching this URN.
    // Computed BEFORE clustering so cluster members carry their individual
    // rels through to the popover (the cluster's `rels` is the union; the
    // members keep their own).
    const relsByUrn = new Map<string, Set<string>>();
    for (const e of edges) {
        if (!relsByUrn.has(e.source)) relsByUrn.set(e.source, new Set());
        if (!relsByUrn.has(e.target)) relsByUrn.set(e.target, new Set());
        relsByUrn.get(e.source)!.add(e.rel);
        relsByUrn.get(e.target)!.add(e.rel);
    }
    for (const n of rawNodes) {
        const set = relsByUrn.get(n.urn);
        n.rels = set ? Array.from(set).sort() : [];
    }

    return { nodes: rawNodes, edges, multiViaSigs, t2BridgeCounts };
}
