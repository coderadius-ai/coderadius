// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine: Ephemeral Weld Resolver
//
// Replays the writer-side DataContainer welder over the ephemeral snapshot
// before the diff. Without this pass the ephemeral extractor emits the naive
// single-repo URN (e.g. cr:datacontainer:local/orders:orders) while the DB
// snapshot returns the welder's winner URN (cr:datacontainer:acme/orders-core:
// orders). The differ then sees a phantom scope-drift pair and would
// otherwise render the misleading "Table mapping changed: X -> X" finding.
//
// The welder that establishes this mapping is
// `weldDataContainersByEndpoint` in src/graph/mutations/data-contracts.ts.
// It stamps `welded_into = <winnerUrn>` on the tombstoned loser, which is
// the property this resolver reads.
//
// READ-ONLY: never mutates the master graph.
// ═══════════════════════════════════════════════════════════════════════════════

import { getMemgraphSession } from '../graph/neo4j.js';
import { logger } from '../utils/logger.js';
import type { FileTopologySnapshot } from './types.js';

/**
 * For each DataContainer URN in `urns`, look up the welder winner. Returns
 * a map from the loser URN to the winner `{ urn, name }`. URNs that have not
 * been welded (or do not exist in the graph) are omitted from the result.
 */
export async function resolveWeldedDataContainerUrns(
    urns: string[],
): Promise<Map<string, { urn: string; name: string }>> {
    const result = new Map<string, { urn: string; name: string }>();
    if (urns.length === 0) return result;

    const session = getMemgraphSession();
    try {
        const records = await session.run(
            `UNWIND $urns AS u
             MATCH (loser:DataContainer {id: u})
             WHERE loser.valid_to_commit IS NOT NULL AND loser.welded_into IS NOT NULL
             MATCH (winner:DataContainer {id: loser.welded_into})
             WHERE winner.valid_to_commit IS NULL
             RETURN u AS loserUrn, winner.id AS winnerUrn, winner.name AS winnerName`,
            { urns },
        );
        for (const record of records.records) {
            const loserUrn = record.get('loserUrn') as string | null;
            const winnerUrn = record.get('winnerUrn') as string | null;
            const winnerName = record.get('winnerName') as string | null;
            if (loserUrn && winnerUrn) {
                result.set(loserUrn, { urn: winnerUrn, name: winnerName ?? winnerUrn });
            }
        }
    } finally {
        await session.close();
    }
    return result;
}

/**
 * Rewires every DataContainer edge (and matching node) whose target URN has
 * been welded into a winner. Mutates `snapshots` in place. Safe to call when
 * no DataContainer edges are present (early return, no DB query).
 *
 * Errors from the lookup are swallowed and logged; a failing welder lookup
 * must never crash the blast pipeline. The differ-level `dropScopeDriftPairs`
 * pass still catches any divergence that slips through.
 */
export async function rewireEphemeralEdgesToWeldedTargets(
    snapshots: Map<string, FileTopologySnapshot>,
): Promise<void> {
    const candidateUrns = new Set<string>();
    for (const snapshot of snapshots.values()) {
        for (const edge of snapshot.edges) {
            if (edge.targetType === 'DataContainer') {
                candidateUrns.add(edge.targetId);
            }
        }
    }
    if (candidateUrns.size === 0) return;

    let weldMap: Map<string, { urn: string; name: string }>;
    try {
        weldMap = await resolveWeldedDataContainerUrns([...candidateUrns]);
    } catch (err) {
        logger.debug(`[EphemeralWeldResolver] Lookup failed: ${(err as Error).message}`);
        return;
    }
    if (weldMap.size === 0) return;

    for (const snapshot of snapshots.values()) {
        for (const edge of snapshot.edges) {
            if (edge.targetType !== 'DataContainer') continue;
            const winner = weldMap.get(edge.targetId);
            if (winner) {
                edge.targetId = winner.urn;
                edge.targetName = winner.name;
            }
        }
        for (const node of snapshot.nodes) {
            if (node.type !== 'DataContainer') continue;
            const winner = weldMap.get(node.id);
            if (winner) {
                node.id = winner.urn;
                node.name = winner.name;
            }
        }
    }
}
