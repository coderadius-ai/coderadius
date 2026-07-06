import type { TopologyNode } from '@coderadius/shared-types';

/**
 * One positioned node in the graph view's static-grid layout.
 * Built per-render in BlastRadiusGraphView from the tiered impact list.
 */
export interface GraphNode {
    id: string;
    urn: string;
    node: TopologyNode;
    tier: 0 | 1 | 2;
    direction: 'center' | 'upstream' | 'downstream';
    /** Column index in the tier grid: -2 .. +2. Center is 0. */
    col: number;
    cardW: number;
    cardH: number;
    x: number;
    y: number;
    /** Confidence (0..1) of the underlying TopologyNode — drives border treatment. */
    confidence?: number;
    /** Edge-kind set for edges directly touching this node (e.g. `['READS','WRITES']`).
     *  Populated post-edge-build by BlastRadiusGraphView so cluster member
     *  rows in the popover can show their per-member rels — same chip the
     *  sidebar list uses, no central state needed. */
    rels?: string[];
}

/**
 * Directed edge between two GraphNodes. `sourceNode` / `targetNode` are
 * resolved pointers post-validation so D3 doesn't have to dictionary-look-up.
 */
export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    rel: string;
    sourceNode?: GraphNode;
    targetNode?: GraphNode;
    /** Confidence (0..1) of the underlying edge — drives stroke opacity / dashing. */
    confidence?: number;
}

/**
 * Supernode produced by the clustering engine. Wraps `members` nodes whose
 * structural signature is identical (same column, type, edge kinds, neighbor
 * URN set, name family). Renders as a stacked-deck card in the graph view.
 *
 * `confidence` aggregation: `min(member.confidence)` — most conservative,
 * so a single low-confidence member drags the supernode into "dashed".
 */
export interface NodeCluster {
    kind: 'cluster';
    /** Stable id derived from the cluster signature (used for DOM ids and React keys). */
    id: string;
    /** Used to position the cluster card in the column grid (mirrors GraphNode). */
    tier: 0 | 1 | 2;
    direction: 'upstream' | 'downstream';
    col: number;
    cardW: number;
    cardH: number;
    x: number;
    y: number;
    /** All member nodes, sorted by name. */
    members: GraphNode[];
    /** Human-friendly title, e.g. "4 Quote Data Containers". */
    label: string;
    /** Top 3 example member names (for the meta strip). */
    examples: string[];
    /** Sorted union of rels across all member edges. */
    rels: string[];
    /** Aggregated nodeType (same for every member). */
    nodeType: string;
    /** min(member.confidence) — see file-level docs. */
    confidence?: number;
    /** Shared technology, set only when ALL members declare the same value
     *  (e.g. every member is `postgres`). Surfaced in the cluster card meta
     *  strip — particularly useful for DataContainer clusters bucketed by
     *  logical database, where the type alone isn't informative. */
    technology?: string;
    /** Shared logical database name (typically `members[*].node.datastore.name`).
     *  Populated when the cluster groups DataContainers/Datastores via the
     *  `db:` nameFamily fallback OR when all members share the same datastore. */
    datastoreName?: string;
}

/** A node OR a supernode. Discriminated by the optional `kind` field. */
export type GraphNodeOrCluster = GraphNode | NodeCluster;

export function isCluster(n: GraphNodeOrCluster): n is NodeCluster {
    return (n as NodeCluster).kind === 'cluster';
}
