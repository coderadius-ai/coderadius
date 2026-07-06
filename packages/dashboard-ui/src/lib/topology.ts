/**
 * getDirectBlasts — 1-hop impact lookup on the topology skeleton.
 *
 * Classification logic:
 *   The graph stores edges as (source)-[REL]->(target) following the
 *   *action* direction. But impact direction depends on the rel type:
 *
 *   DEPENDENCY rels (CALLS, READS, LISTENS_TO, CONSUMES, DEPENDS_ON,
 *   COMMUNICATES_WITH):
 *     out-edge target = upstream provider  (I depend on it)
 *     in-edge source  = downstream consumer (it depends on me)
 *
 *   EMISSION rels (PUBLISHES_TO, WRITES, PRODUCES, SPAWNS):
 *     out-edge target = downstream   (I emit to it; whoever reads it breaks)
 *     in-edge source  = upstream     (it emits to me; I depend on its output)
 *
 * This distinction is critical for blast radius accuracy.
 */

import type { TopologyMap, TopologyEdge, TopologyNode } from '@coderadius/shared-types';
import { EMISSION_DIRECTION_RELS, PASSTHROUGH_TYPES } from '@coderadius/shared-types';

/**
 * Emission-direction relationships: the source *pushes* data toward the
 * target, so the target sits DOWNSTREAM of the source. Single source of
 * truth in shared-types (topology-rels.ts): the same set drives the
 * server-side gravity engine, so panels and score cannot drift.
 */
const EMISSION_RELS = EMISSION_DIRECTION_RELS;

export interface BlastNode {
    urn: string;
    node: TopologyNode;
    rel: string;
    direction: 'upstream' | 'downstream';
    functions?: { name: string; file: string | null }[];
    /** Underlying edge confidence (0..1) — surfaced in the graph view edge stroke. */
    edgeConfidence?: number;
}

export interface DirectBlast {
    /** What this node depends on — breaks me if it fails */
    upstream: BlastNode[];
    /** What breaks if this node changes */
    downstream: BlastNode[];
}

function toBlastNode(
    urn: string, node: TopologyNode, rel: string,
    direction: 'upstream' | 'downstream',
    functions?: { name: string; file: string | null }[],
    edgeConfidence?: number,
): BlastNode {
    return { urn, node, rel, direction, functions, edgeConfidence };
}

/**
 * Returns the direct 1-hop upstream providers and downstream consumers
 * for the given node URN, with correct semantic classification.
 */
export function getDirectBlasts(topology: TopologyMap, urn: string): DirectBlast {
    const outEdges: TopologyEdge[] = topology.out[urn] ?? [];
    const inEdges: TopologyEdge[] = topology.in[urn] ?? [];

    const upstream: BlastNode[] = [];
    const downstream: BlastNode[] = [];

    // Out-edges: I am the source
    for (const edge of outEdges) {
        const targetNode = topology.nodes[edge.target];
        if (!targetNode) continue;

        if (EMISSION_RELS.has(edge.rel)) {
            // I emit/write/publish TO target → target is DOWNSTREAM
            downstream.push(toBlastNode(edge.target, targetNode, edge.rel, 'downstream', edge.functions, edge.confidence));
        } else {
            // I call/read/listen/depend on target → target is UPSTREAM
            upstream.push(toBlastNode(edge.target, targetNode, edge.rel, 'upstream', edge.functions, edge.confidence));
        }
    }

    // In-edges: I am the target
    for (const edge of inEdges) {
        const sourceNode = topology.nodes[edge.source];
        if (!sourceNode) continue;

        if (EMISSION_RELS.has(edge.rel)) {
            // Source emits/writes TO me → source is my UPSTREAM provider
            upstream.push(toBlastNode(edge.source, sourceNode, edge.rel, 'upstream', edge.functions, edge.confidence));
        } else {
            // Source calls/reads/depends on me → source is DOWNSTREAM
            downstream.push(toBlastNode(edge.source, sourceNode, edge.rel, 'downstream', edge.functions, edge.confidence));
        }
    }

    return { upstream, downstream };
}

// ─── 2-Hop Tiered Impact ─────────────────────────────────────────────────────

// Passthrough resource types (nodes where data/signals flow THROUGH, followed
// for Tier 2 transitive impacts) come from the shared vocabulary import above.
// Services/Packages/SystemProcess are endpoints of the flow, never followed.

export interface TieredBlastNode extends BlastNode {
    tier: 1 | 2;
    /** For Tier 2 nodes: the intermediate resource they flow through */
    via?: { urn: string; node: TopologyNode; rel: string; functions?: { name: string; file: string | null }[] };
    /**
     * Additional relationship types discovered during T2 enrichment.
     * When a T1 node is also reachable via passthrough resources, those
     * extra rel types are appended here so the card can show composite
     * badges (e.g. [D][R]) without duplicating the node as T2.
     */
    rels?: string[];
}

export interface TieredBlast {
    upstream: TieredBlastNode[];
    downstream: TieredBlastNode[];
}

/**
 * 2-hop tiered impact lookup.
 *
 * Tier 1: Direct 1-hop connections (same as getDirectBlasts).
 * Tier 2: For each Tier-1 passthrough resource (DataContainer, MessageChannel, etc.),
 *         follow through to find the services on the other side.
 *
 * Example:  loyalty-service ─(WRITES)─▶ shipment_log ◀─(READS)─ tracking-service
 *   Tier 1: shipment_log (resource, the table itself)
 *   Tier 2: tracking-service (the service that actually breaks), Via: shipment_log
 *
 * Computed entirely client-side from the in-memory TopologyMap.
 * O(degree²) worst-case, but architectural graphs are sparse — milliseconds in practice.
 *
 * Promotion rule: **T2 wins over T1**.
 * If a node is reachable both directly (e.g. via Backstage `DEPENDS_ON`) AND
 * transitively through a passthrough resource (DataContainer, MessageChannel…),
 * the transitive T2 path is more informative and takes precedence. The T1 entry
 * is replaced by the T2 entry (with `via` populated). This prevents:
 *   - Duplicate cards on the same panel side
 *   - Graph positioning conflicts (T2 edge targeting a node at T1 column)
 *
 * Nodes that are only directly connected remain T1.
 * Nodes that are only transitively connected are T2.
 * Nodes reachable both ways → promoted to T2 (first passthrough found wins as `via`).
 */
export function getTieredBlasts(topology: TopologyMap, urn: string): TieredBlast {
    const direct = getDirectBlasts(topology, urn);
    const seen = new Set<string>([urn]);

    // Stage T1 entries — they are only emitted if NOT promoted to T2
    const t1Downstream = new Map<string, TieredBlastNode>();
    const t1Upstream   = new Map<string, TieredBlastNode>();

    // ── Tier 1: stage all direct connections ─────────────────────────
    for (const item of direct.downstream) {
        seen.add(item.urn);
        t1Downstream.set(item.urn, { ...item, tier: 1 });
    }
    for (const item of direct.upstream) {
        seen.add(item.urn);
        t1Upstream.set(item.urn, { ...item, tier: 1 });
    }

    // URNs promoted from T1 → T2 (first passthrough wins; skip subsequent)
    const promotedDownstream = new Set<string>();
    const promotedUpstream   = new Set<string>();

    const downstream: TieredBlastNode[] = [];
    const upstream: TieredBlastNode[]   = [];

    // ── Tier 2 Downstream: follow passthrough resources ─────────────
    // T2 wins: if the transitive target is already staged as T1, promote it.
    for (const item of direct.downstream) {
        if (!PASSTHROUGH_TYPES.has(item.node.type)) continue;
        const transitive = getDirectBlasts(topology, item.urn);
        for (const t of transitive.downstream) {
            const t2Entry: TieredBlastNode = {
                ...t, tier: 2,
                via: { urn: item.urn, node: item.node, rel: item.rel, functions: item.functions },
            };
            if (t1Downstream.has(t.urn) && !promotedDownstream.has(t.urn)) {
                // Promote: T1 → T2
                promotedDownstream.add(t.urn);
                downstream.push(t2Entry);
            } else if (!seen.has(t.urn)) {
                // New node, pure T2
                seen.add(t.urn);
                downstream.push(t2Entry);
            }
            // else: already promoted via another passthrough — skip
        }
    }

    // ── Tier 2 Upstream: follow passthrough resources ────────────────
    for (const item of direct.upstream) {
        if (!PASSTHROUGH_TYPES.has(item.node.type)) continue;
        const transitive = getDirectBlasts(topology, item.urn);
        for (const t of transitive.upstream) {
            const t2Entry: TieredBlastNode = {
                ...t, tier: 2,
                via: { urn: item.urn, node: item.node, rel: item.rel, functions: item.functions },
            };
            if (t1Upstream.has(t.urn) && !promotedUpstream.has(t.urn)) {
                // Promote: T1 → T2
                promotedUpstream.add(t.urn);
                upstream.push(t2Entry);
            } else if (!seen.has(t.urn)) {
                // New node, pure T2
                seen.add(t.urn);
                upstream.push(t2Entry);
            }
        }
    }

    // ── Emit non-promoted T1 entries ─────────────────────────────────
    for (const [entryUrn, t1] of t1Downstream) {
        if (!promotedDownstream.has(entryUrn)) downstream.push(t1);
    }
    for (const [entryUrn, t1] of t1Upstream) {
        if (!promotedUpstream.has(entryUrn)) upstream.push(t1);
    }

    return { upstream, downstream };
}

// ─── Multi-Path Discovery ────────────────────────────────────────────────────

/**
 * A single relationship path between two nodes.
 * Can be 1-hop (direct) or 2-hop (through a passthrough resource).
 */
export interface RelationshipPath {
    /** The relationship type(s) along this path. 1 entry = direct, 2 = via. */
    rels: string[];
    /**
     * Per-step traversal direction (parallel to `rels`). `false` = the path
     * step follows the underlying edge direction (source→target). `true` =
     * the step traverses the edge against its direction (the edge actually
     * points from the destination of the step back to its origin). Used to
     * draw direction-aware arrows in the side-drawer preview graph.
     */
    relsReversed: boolean[];
    /**
     * Per-step `bindingReason` (parallel to `rels`), populated only for
     * STORED_IN edges; `null` everywhere else. Surfaces in the drawer as a
     * chip next to the rel-badge so the operator can tell whether the
     * DataContainer→Datastore binding was grounded ('p0-yaml', 'sole-candidate')
     * or inferred ('llm-assignment').
     */
    relsBindingReason?: (string | null)[];
    /** Intermediate passthrough node (only for 2-hop paths). */
    via?: { urn: string; node: TopologyNode };
    /** Functions from the source node (the node we are exploring from) */
    sourceFunctions?: { name: string; file: string | null }[];
    /** Functions from the target node (the impacted node shown in the drawer) */
    targetFunctions?: { name: string; file: string | null }[];
}

/**
 * Discovers ALL distinct relationship paths (up to 2-hop) between two nodes.
 *
 * Used by the BlastDrawer to show every route connecting the blast target
 * to an impacted node — including paths that the deduplication in
 * getTieredBlasts() would normally suppress.
 *
 * Returns an empty array if no paths exist.
 */
export function getAllPaths(
    topology: TopologyMap,
    sourceUrn: string,
    targetUrn: string,
): RelationshipPath[] {
    const paths: RelationshipPath[] = [];
    const seen = new Set<string>(); // dedup key: "rel1|viaUrn|rel2"

    // ── 1-hop: direct edges (source → target or target → source) ─────
    // For 1-hop, `reversed` reflects whether the underlying edge points the
    // same way the path is traversed (source→target):
    //   - outEdges (edge.target === targetUrn) → forward, reversed = false
    //   - inEdges  (edge.source === targetUrn) → traversal is against the
    //                                            edge, reversed = true
    const outEdges: TopologyEdge[] = topology.out[sourceUrn] ?? [];
    for (const edge of outEdges) {
        if (edge.target === targetUrn) {
            const key = `${edge.rel}||`;
            if (!seen.has(key)) {
                seen.add(key);
                paths.push({
                    rels: [edge.rel],
                    relsReversed: [false],
                    relsBindingReason: [edge.bindingReason ?? null],
                    sourceFunctions: edge.functions,
                });
            }
        }
    }

    const inEdges: TopologyEdge[] = topology.in[sourceUrn] ?? [];
    for (const edge of inEdges) {
        if (edge.source === targetUrn) {
            const key = `${edge.rel}||`;
            if (!seen.has(key)) {
                seen.add(key);
                paths.push({
                    rels: [edge.rel],
                    relsReversed: [true],
                    relsBindingReason: [edge.bindingReason ?? null],
                    targetFunctions: edge.functions,
                });
            }
        }
    }

    // ── 2-hop: source → via → target (through passthrough resources) ─
    // Each step's reversal is determined by which adjacency map the edge
    // came from: `out[X]` means "edge starts at X" (forward when traversing
    // X→Y); `in[X]` means "edge ends at X" (reversed when traversing X→Y).
    for (const edge1 of outEdges) {
        const viaNode = topology.nodes[edge1.target];
        if (!viaNode || !PASSTHROUGH_TYPES.has(viaNode.type)) continue;
        if (edge1.target === targetUrn) continue; // already covered as direct

        // Step 1: source → via, edge1 points source→via → forward.
        // Check if via connects to target (via → target or target → via)
        const viaOut: TopologyEdge[] = topology.out[edge1.target] ?? [];
        for (const edge2 of viaOut) {
            if (edge2.target === targetUrn) {
                // Step 2: via → target, edge2 points via→target → forward.
                const key = `${edge1.rel}|${edge1.target}|${edge2.rel}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    paths.push({
                        rels: [edge1.rel, edge2.rel],
                        relsReversed: [false, false],
                        relsBindingReason: [edge1.bindingReason ?? null, edge2.bindingReason ?? null],
                        via: { urn: edge1.target, node: viaNode },
                        sourceFunctions: edge1.functions,
                    });
                }
            }
        }

        const viaIn: TopologyEdge[] = topology.in[edge1.target] ?? [];
        for (const edge2 of viaIn) {
            if (edge2.source === targetUrn) {
                // Step 2: via → target, but edge2 points target→via → reversed.
                const key = `${edge1.rel}|${edge1.target}|${edge2.rel}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    paths.push({
                        rels: [edge1.rel, edge2.rel],
                        relsReversed: [false, true],
                        relsBindingReason: [edge1.bindingReason ?? null, edge2.bindingReason ?? null],
                        via: { urn: edge1.target, node: viaNode },
                        sourceFunctions: edge1.functions,
                        targetFunctions: edge2.functions,
                    });
                }
            }
        }
    }

    // Also check reverse direction: target → via → source
    // Here step 1 traverses source→via against edge1 (which points via→source)
    // → reversed=true.
    for (const edge1 of inEdges) {
        const viaNode = topology.nodes[edge1.source];
        if (!viaNode || !PASSTHROUGH_TYPES.has(viaNode.type)) continue;
        if (edge1.source === targetUrn) continue;

        const viaOut: TopologyEdge[] = topology.out[edge1.source] ?? [];
        for (const edge2 of viaOut) {
            if (edge2.target === targetUrn) {
                // Step 2: via → target, edge2 points via→target → forward.
                const key = `${edge1.rel}|${edge1.source}|${edge2.rel}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    paths.push({
                        rels: [edge1.rel, edge2.rel],
                        relsReversed: [true, false],
                        relsBindingReason: [edge1.bindingReason ?? null, edge2.bindingReason ?? null],
                        via: { urn: edge1.source, node: viaNode },
                    });
                }
            }
        }

        const viaIn: TopologyEdge[] = topology.in[edge1.source] ?? [];
        for (const edge2 of viaIn) {
            if (edge2.source === targetUrn) {
                // Step 2: via → target, edge2 points target→via → reversed.
                const key = `${edge1.rel}|${edge1.source}|${edge2.rel}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    paths.push({
                        rels: [edge1.rel, edge2.rel],
                        relsReversed: [true, true],
                        relsBindingReason: [edge1.bindingReason ?? null, edge2.bindingReason ?? null],
                        via: { urn: edge1.source, node: viaNode },
                        targetFunctions: edge2.functions,
                    });
                }
            }
        }
    }

    return paths;
}

/**
 * Filters topology.nodes to those whose name or URN matches the query.
 * Used for the searchbar autocomplete — returns top 20 results.
 */
export function searchNodes(
    topology: TopologyMap,
    query: string,
    limit = 20,
): Array<{ urn: string; node: TopologyNode }> {
    if (!query.trim()) return [];

    const q = query.toLowerCase();
    const results: Array<{ urn: string; node: TopologyNode }> = [];

    for (const [urn, node] of Object.entries(topology.nodes)) {
        if (
            node.name.toLowerCase().includes(q) ||
            urn.toLowerCase().includes(q)
        ) {
            results.push({ urn, node });
            if (results.length >= limit) break;
        }
    }

    return results;
}
