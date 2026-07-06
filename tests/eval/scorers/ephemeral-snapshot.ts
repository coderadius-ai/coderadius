// ═══════════════════════════════════════════════════════════════════════════════
// EphemeralSnapshot — in-memory analog of graph-snapshot.ts
//
// Turns the ephemeral extractor's per-file FileTopologySnapshots into the
// (label → names) GraphSnapshot and edge list the eval-scorer consumes — so a
// fixture can be scored for precision/recall WITHOUT a live Memgraph.
//
// This is the keystone that makes the eval-scorer a DB-free fitness function:
// extractEphemeralTopology() → here → scoreNodes/scoreEdges/scoreSymbols.
// ═══════════════════════════════════════════════════════════════════════════════

import type { GraphEdgeSnapshot, FileTopologySnapshot } from '../../../src/eval/types.js';
import type { NodeLabel } from '../../../src/graph/domain.js';
import type { EvalManifest } from '../types/eval-manifest.js';
import { isNodeEdge, isFunctionEdge } from '../types/eval-manifest.js';
import type { GraphSnapshot, EdgeResult } from './eval-scorer.js';

/** Flatten per-file nodes into a label → unique-names map (the scorer's input). */
export function snapshotsToGraphSnapshot(
    snapshots: Map<string, FileTopologySnapshot>,
): GraphSnapshot {
    const byLabel = new Map<string, Set<string>>();
    for (const snap of snapshots.values()) {
        for (const node of snap.nodes) {
            const set = byLabel.get(node.type) ?? new Set<string>();
            set.add(node.name);
            byLabel.set(node.type, set);
        }
    }
    const out: GraphSnapshot = new Map();
    for (const [label, names] of byLabel) out.set(label as NodeLabel, [...names]);
    return out;
}

/** All edges across every file in the snapshot. */
export function collectEdges(
    snapshots: Map<string, FileTopologySnapshot>,
): GraphEdgeSnapshot[] {
    return [...snapshots.values()].flatMap(s => s.edges);
}

/**
 * Cypher-free analog of eval-scorer.scoreEdges: matches each expected edge
 * against the in-memory edge list, mirroring the live scorer's match semantics
 * and description strings so reports read identically.
 */
export function scoreEdgesInMemory(
    manifest: EvalManifest,
    edges: GraphEdgeSnapshot[],
): EdgeResult {
    const missingEdges: string[] = [];
    let foundCount = 0;

    for (const edge of manifest.expected_edges) {
        const rels = edge.rel.split('|');
        const relOk = (e: GraphEdgeSnapshot) => rels.includes(e.relType);
        let found: boolean;
        let description: string;

        if (isNodeEdge(edge)) {
            description = `${edge.from} -[${edge.rel}]-> ${edge.to}`;
            found = edges.some(e => e.sourceName === edge.from && e.targetName === edge.to && relOk(e));
        } else if (isFunctionEdge(edge)) {
            description = `fn:${edge.from_function} -[${edge.rel}]-> ${edge.to}`;
            found = edges.some(e => e.sourceName === edge.from_function && e.targetName === edge.to && relOk(e));
        } else {
            description = `svc:${edge.from_service} -[${edge.rel}]-> ${edge.to}`;
            // ponytail: ephemeral snapshots carry no Service-[:CONTAINS]->Function
            // layer (that's stamped at graph-write time), so we can't scope by
            // service. A coverage fixture IS a single service, so match any
            // function-edge to the target. Add real service scoping if/when a
            // multi-service coverage fixture appears.
            found = edges.some(e => e.targetName === edge.to && relOk(e));
        }

        if (found) foundCount++;
        else missingEdges.push(description);
    }

    return { expectedCount: manifest.expected_edges.length, foundCount, missingEdges };
}
