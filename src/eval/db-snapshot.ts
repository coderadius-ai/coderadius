// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine — DB Snapshot Module
//
// Step 2 of the In-Memory Graph Overlay pipeline.
//
// Fetches the current topology (the "before" state) of changed files from
// the Memgraph master graph using READ-ONLY Cypher queries.
//
// The result is a Map<filePath, FileTopologySnapshot> that represents the
// ground truth — what the graph currently looks like for each PR-changed file.
// This map is later compared against the ephemeral extraction (the "after"
// state) to compute the GraphDelta.
// ═══════════════════════════════════════════════════════════════════════════════

import { fetchFileTopologySnapshots } from '../graph/queries/eval-snapshot.js';
import { logger } from '../utils/logger.js';
import type { FileTopologySnapshot } from './types.js';

export interface DbSnapshotResult {
    /** Map of filePath → current topology (from the master Memgraph graph). */
    snapshots: Map<string, FileTopologySnapshot>;
    /** Files that were found in the graph. */
    knownFiles: string[];
    /** Files that have no presence in the graph (new files in the PR). */
    unknownFiles: string[];
}

/**
 * Fetch the current graph topology for a set of PR-changed files.
 *
 * This is a pure READ operation on the master graph. It does not modify
 * any data and is safe to run concurrently with production graph writes.
 *
 * Files not found in the graph are returned as empty snapshots — this is
 * the correct behavior for new files being added in the PR (they have no
 * "before" state to compare against, so the diff will classify all their
 * edges as "added").
 *
 * @param changedFiles - Repo-relative paths of changed files.
 */
export async function fetchDbSnapshot(changedFiles: string[]): Promise<DbSnapshotResult> {
    logger.debug(`[DbSnapshot] Fetching topology for ${changedFiles.length} file(s) from master graph`);

    const snapshots = await fetchFileTopologySnapshots(changedFiles);

    const knownFiles: string[] = [];
    const unknownFiles: string[] = [];

    for (const [filePath, snapshot] of snapshots) {
        if (snapshot.edges.length > 0 || snapshot.nodes.length > 0) {
            knownFiles.push(filePath);
            logger.debug(
                `[DbSnapshot] ${filePath}: ${snapshot.edges.length} edges, ${snapshot.nodes.length} nodes`
            );
        } else {
            unknownFiles.push(filePath);
            logger.debug(`[DbSnapshot] ${filePath}: not in graph (new file or no topology)`);
        }
    }

    logger.debug(
        `[DbSnapshot] Snapshot complete: ${knownFiles.length} known, ${unknownFiles.length} unknown`
    );

    return { snapshots, knownFiles, unknownFiles };
}
