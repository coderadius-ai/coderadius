/**
 * Evaluation Snapshot Queries — Read-Only Cypher Queries for Graph Topology Snapshots
 *
 * These queries fetch the *current* topology of a set of source files from
 * the Memgraph master graph. They are used as Step 2 of the Blast Evaluation
 * pipeline (DB Snapshot) to establish the baseline state before the change.
 *
 * CRITICAL: These queries are READ-ONLY. They never CREATE, MERGE, DETACH
 * DELETE or SET properties. The evaluation pipeline must never write to the master graph.
 *
 * Return value structure mirrors FileTopologySnapshot from `src/eval/types.ts`.
 */

import { getMemgraphSession } from '../neo4j.js';
import { ARCH_RELS } from '../constants.js';
import { pruneDuplicateRouteImplementations } from '../../eval/endpoint-identity.js';
import type { GraphEdgeSnapshot, GraphNodeSnapshot, FileTopologySnapshot } from '../../eval/types.js';

/** Derive a canonical type string from a Memgraph node's labels array. */
function labelsToType(labels: string[]): string {
    const PRIORITY = ['MessageChannel', 'DataContainer', 'Datastore', 'APIEndpoint', 'SystemProcess', 'DataStructure'];
    for (const p of PRIORITY) {
        if (labels.includes(p)) return p;
    }
    return labels[0] ?? 'Unknown';
}

// ─── Relationship type resolution ─────────────────────────────────────────────

// Outbound relationships from Function nodes to resources — the ones we diff.
// We pull in the full ARCH_RELS set (DEPENDENCY_RELS + EMISSION_RELS + API_RELS)
// because the Cypher pattern below — `(f:Function)-[rel]->(resource)` — naturally
// filters out package-level rels like DEPENDS_ON; we get IMPLEMENTS_ENDPOINT for
// free without re-curating the list. CONNECTS_TO is added on top because it
// targets Datastore nodes and is not part of ARCH_RELS today.
export const TRACKED_RELS = [
    ...ARCH_RELS,
    'CONNECTS_TO',
] as const;

// Secondary chain rels: walked one hop deeper from any DataContainer reached
// by a PR-scoped Function. They surface ORM column-level state so the differ
// can detect `@ORM\Column` renames as `HAS_FIELD` edge pair changes.
const COLUMN_CHAIN_RELS = ['HAS_SCHEMA', 'HAS_FIELD'] as const;

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Fetch the current topology (edges + resource nodes) for a list of source
 * files from the Memgraph master graph.
 *
 * Returns a map of filePath → FileTopologySnapshot.
 * Files not found in the graph return an empty snapshot (no nodes, no edges).
 *
 * @param filePaths - Repo-relative file paths to snapshot.
 */
export async function fetchFileTopologySnapshots(
    filePaths: string[]
): Promise<Map<string, FileTopologySnapshot>> {
    if (filePaths.length === 0) {
        return new Map();
    }

    const session = getMemgraphSession();
    try {
        // Single batched query for all requested files.
        // Pattern:
        //   SourceFile → (CONTAINS) → Function → [TRACKED_REL] → Resource
        //
        // We also capture direct Function → Resource edges where SourceFile
        // directly contains the function (the common case).
        const result = await session.run(
            `
            UNWIND $filePaths AS fp
            MATCH (sf:SourceFile {path: fp})
            WHERE sf.valid_to_commit IS NULL
            OPTIONAL MATCH (sf)-[:CONTAINS]->(f:Function)
            WHERE f.valid_to_commit IS NULL
            OPTIONAL MATCH (f)-[rel]->(resource)
            WHERE type(rel) IN $trackedRels
              AND rel.valid_to_commit IS NULL
              AND resource.valid_to_commit IS NULL
            RETURN
                fp AS filePath,
                f.id AS functionId,
                f.name AS functionName,
                type(rel) AS relType,
                resource.id AS resourceId,
                COALESCE(resource.name, resource.path) AS resourceName,
                labels(resource) AS resourceLabels
            ORDER BY filePath, functionId, relType
            `,
            {
                filePaths,
                trackedRels: TRACKED_RELS,
            }
        );

        // Build result map — one snapshot per file
        const snapshots = new Map<string, FileTopologySnapshot>();

        // Initialize empty snapshots for all requested files
        for (const fp of filePaths) {
            snapshots.set(fp, { filePath: fp, nodes: [], edges: [] });
        }

        // Track already-added nodes per file to avoid duplicates
        const addedNodes = new Map<string, Set<string>>();
        for (const fp of filePaths) {
            addedNodes.set(fp, new Set());
        }

        for (const record of result.records) {
            const filePath: string = record.get('filePath');
            const functionId: string | null = record.get('functionId');
            const functionName: string | null = record.get('functionName');
            const relType: string | null = record.get('relType');
            const resourceId: string | null = record.get('resourceId');
            const resourceName: string | null = record.get('resourceName');
            const resourceLabels: string[] | null = record.get('resourceLabels');

            if (!functionId || !relType || !resourceId) continue;

            const snapshot = snapshots.get(filePath)!;
            const seenNodes = addedNodes.get(filePath)!;
            const resourceType = labelsToType(resourceLabels ?? []);

            // Add the resource node if not yet seen for this file
            if (!seenNodes.has(resourceId)) {
                const node: GraphNodeSnapshot = {
                    id: resourceId,
                    type: resourceType,
                    name: resourceName ?? resourceId,
                    sourceFile: filePath,
                };
                snapshot.nodes.push(node);
                seenNodes.add(resourceId);
            }

            // Add the edge
            const edge: GraphEdgeSnapshot = {
                sourceId: functionId,
                sourceName: functionName ?? functionId,
                targetId: resourceId,
                targetName: resourceName ?? resourceId,
                relType,
                sourceFile: filePath,
                targetType: resourceType,
            };
            snapshot.edges.push(edge);
        }

        // ── Secondary pass: column-level HAS_SCHEMA + HAS_FIELD chains ──
        // For each DataContainer reached above, hop one and two steps further
        // to capture the schema (DataStructure) and its columns (DataField).
        // Without this, the differ never sees column renames and the blast
        // resolver cannot surface `Column renamed: X -> Y` findings.
        await populateColumnChains(session, snapshots);

        for (const snapshot of snapshots.values()) {
            pruneDuplicateRouteImplementations(snapshot);
        }

        return snapshots;
    } finally {
        await session.close();
    }
}

async function populateColumnChains(
    session: ReturnType<typeof getMemgraphSession>,
    snapshots: Map<string, FileTopologySnapshot>,
): Promise<void> {
    // Bucket DataContainer URNs by file so the secondary records land in the
    // right snapshot. A single DC URN may appear in multiple files (cross-
    // repo welded survivor), so we keep a multimap.
    const dcUrnByFile = new Map<string, string[]>();
    for (const [filePath, snap] of snapshots) {
        for (const node of snap.nodes) {
            if (node.type === 'DataContainer') {
                if (!dcUrnByFile.has(filePath)) dcUrnByFile.set(filePath, []);
                dcUrnByFile.get(filePath)!.push(node.id);
            }
        }
    }
    const allDcUrns = [...new Set([...dcUrnByFile.values()].flat())];
    if (allDcUrns.length === 0) return;

    const result = await session.run(
        `UNWIND $dcUrns AS dcUrn
         MATCH (dc:DataContainer {id: dcUrn})
         WHERE dc.valid_to_commit IS NULL
         OPTIONAL MATCH (dc)-[hs:HAS_SCHEMA]->(ds:DataStructure)
         WHERE hs.valid_to_commit IS NULL AND ds.valid_to_commit IS NULL
         OPTIONAL MATCH (ds)-[hf:HAS_FIELD]->(df:DataField)
         WHERE hf.valid_to_commit IS NULL AND df.valid_to_commit IS NULL
         RETURN dcUrn AS dcUrn,
                ds.id AS dsId, ds.name AS dsName,
                df.id AS dfId, df.name AS dfName`,
        { dcUrns: allDcUrns, columnChainRels: COLUMN_CHAIN_RELS },
    );

    // Group rows by dcUrn, then fan out to every file that referenced it.
    interface ChainRow { dsId: string; dsName: string | null; dfId: string | null; dfName: string | null; }
    const chainsByDc = new Map<string, ChainRow[]>();
    for (const rec of result.records) {
        const dcUrn = rec.get('dcUrn') as string | null;
        const dsId = rec.get('dsId') as string | null;
        if (!dcUrn || !dsId) continue;
        const rows = chainsByDc.get(dcUrn) ?? [];
        rows.push({
            dsId,
            dsName: rec.get('dsName') as string | null,
            dfId: rec.get('dfId') as string | null,
            dfName: rec.get('dfName') as string | null,
        });
        chainsByDc.set(dcUrn, rows);
    }

    for (const [filePath, dcUrns] of dcUrnByFile) {
        const snap = snapshots.get(filePath)!;
        const seenNodes = new Set(snap.nodes.map(n => n.id));
        const seenEdges = new Set(snap.edges.map(e => `${e.sourceId}::${e.relType}::${e.targetId}`));

        for (const dcUrn of dcUrns) {
            const rows = chainsByDc.get(dcUrn);
            if (!rows) continue;
            for (const row of rows) {
                // DataStructure node + HAS_SCHEMA edge from DC.
                if (!seenNodes.has(row.dsId)) {
                    snap.nodes.push({
                        id: row.dsId,
                        type: 'DataStructure',
                        name: row.dsName ?? row.dsId,
                        sourceFile: filePath,
                    });
                    seenNodes.add(row.dsId);
                }
                const hsKey = `${dcUrn}::HAS_SCHEMA::${row.dsId}`;
                if (!seenEdges.has(hsKey)) {
                    snap.edges.push({
                        sourceId: dcUrn,
                        sourceName: row.dsName ?? row.dsId,
                        targetId: row.dsId,
                        targetName: row.dsName ?? row.dsId,
                        relType: 'HAS_SCHEMA',
                        sourceFile: filePath,
                        targetType: 'DataStructure',
                    });
                    seenEdges.add(hsKey);
                }
                // DataField node + HAS_FIELD edge from DS.
                if (row.dfId) {
                    if (!seenNodes.has(row.dfId)) {
                        snap.nodes.push({
                            id: row.dfId,
                            type: 'DataField',
                            name: row.dfName ?? row.dfId,
                            sourceFile: filePath,
                        });
                        seenNodes.add(row.dfId);
                    }
                    const hfKey = `${row.dsId}::HAS_FIELD::${row.dfId}`;
                    if (!seenEdges.has(hfKey)) {
                        snap.edges.push({
                            sourceId: row.dsId,
                            sourceName: row.dsName ?? row.dsId,
                            targetId: row.dfId,
                            targetName: row.dfName ?? row.dfId,
                            relType: 'HAS_FIELD',
                            sourceFile: filePath,
                            targetType: 'DataField',
                        });
                        seenEdges.add(hfKey);
                    }
                }
            }
        }
    }
}
