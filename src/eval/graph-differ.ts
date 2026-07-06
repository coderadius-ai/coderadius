// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine — Graph Differ
//
// Step 4 of the In-Memory Graph Overlay pipeline.
// 
// This is the most critical module in the Blast Evaluation Engine.
// A PURE FUNCTION: zero I/O, zero async, fully deterministic.
//
// Takes two topology maps:
//   - current:  what Memgraph currently knows (the "before" state from DB)
//   - proposed: what the LLM extracted from the PR files (the "after" state)
//
// Computes a GraphDelta by diffing on edge triples:
//   [sourceId] :: [relType] :: [targetId]
//
// Per Verdict Q2: we ONLY compare topological identity — the triple.
// We deliberately ignore node properties (labels, names, timestamps).
// A node rename (queue_a → queue_b) is correctly represented as:
//   - removedEdge { targetId: cr:broker:queue_a, ... }
//   - addedEdge   { targetId: cr:broker:queue_b, ... }
//
// Performance: O(E) where E = total edges across all changed files.
// For typical PRs (3-5 changed files, <20 edges each) this is <1ms.
// ═══════════════════════════════════════════════════════════════════════════════

import type { FileTopologySnapshot, GraphEdgeSnapshot, GraphNodeSnapshot, GraphDelta } from './types.js';
import { endpointIdentityKey } from './endpoint-identity.js';

// ─── Edge Key ────────────────────────────────────────────────────────────────

/**
 * Generate a canonical comparison key for a graph edge.
 * Only topological identity matters: [sourceId]::[relType]::[targetId].
 *
 * Special-case: IMPLEMENTS_ENDPOINT toward APIEndpoint nodes uses
 * `endpointIdentityKey` so that `cr:endpoint:code:POST:/x` and
 * `cr:endpoint:<repo>:<relPath>:POST:/x` collapse to the same key — the
 * URN prefix differs by producer (code-inferred vs OpenAPI-extracted) but
 * the topological identity (method, path) is the same.
 *
 * This key is the foundation of the entire diff algorithm.
 */
function edgeKey(edge: GraphEdgeSnapshot): string {
    if (edge.relType === 'IMPLEMENTS_ENDPOINT' && edge.targetType === 'APIEndpoint') {
        const endpointKey = endpointIdentityKey(edge.targetId, edge.targetName);
        if (endpointKey) return `${edge.sourceId}::${edge.relType}::${endpointKey}`;
    }

    return `${edge.sourceId}::${edge.relType}::${edge.targetId}`;
}

/**
 * Generate a canonical comparison key for a graph node.
 * For non-APIEndpoint nodes the URN is the key (type/name can drift without
 * topology impact). For APIEndpoint nodes we collapse producer-variant URNs
 * to the (method, path) identity to match the edgeKey behaviour.
 */
function nodeKey(node: GraphNodeSnapshot): string {
    if (node.type === 'APIEndpoint') {
        const endpointKey = endpointIdentityKey(node.id, node.name);
        if (endpointKey) return endpointKey;
    }

    return node.id;
}

// ─── Core Diff Algorithm ──────────────────────────────────────────────────────

/**
 * Diff two topology maps and produce a GraphDelta.
 *
 * Algorithm:
 *   1. Build an edge key set from `current` (DB state).
 *   2. Build an edge key set from `proposed` (LLM extracted state).
 *   3. AddedEdges = proposed keys NOT in current.
 *   4. RemovedEdges = current keys NOT in proposed.
 *   5. Same logic for nodes (by URN).
 *
 * @param current  Map<filePath, FileTopologySnapshot> from DB (before state).
 * @param proposed Map<filePath, FileTopologySnapshot> from ephemeral LLM (after state).
 * @param changedFiles  The list of PR-changed files (used as the scope boundary).
 */
export function diffTopologySnapshots(
    current: Map<string, FileTopologySnapshot>,
    proposed: Map<string, FileTopologySnapshot>,
    changedFiles: string[],
): GraphDelta {
    // ── Build current edge/node index ─────────────────────────────────────
    const currentEdges = new Map<string, GraphEdgeSnapshot>();
    const currentNodes = new Map<string, GraphNodeSnapshot>();

    for (const [filePath, snapshot] of current) {
        // Only consider files that are in the PR scope
        if (!changedFiles.includes(filePath)) continue;

        for (const edge of snapshot.edges) {
            currentEdges.set(edgeKey(edge), edge);
        }
        for (const node of snapshot.nodes) {
            currentNodes.set(nodeKey(node), node);
        }
    }

    // ── Build proposed edge/node index ────────────────────────────────────
    const proposedEdges = new Map<string, GraphEdgeSnapshot>();
    const proposedNodes = new Map<string, GraphNodeSnapshot>();

    for (const [filePath, snapshot] of proposed) {
        if (!changedFiles.includes(filePath)) continue;

        for (const edge of snapshot.edges) {
            proposedEdges.set(edgeKey(edge), edge);
        }
        for (const node of snapshot.nodes) {
            proposedNodes.set(nodeKey(node), node);
        }
    }

    // ── Compute delta ─────────────────────────────────────────────────────
    const addedEdges: GraphEdgeSnapshot[] = [];
    const removedEdges: GraphEdgeSnapshot[] = [];
    const addedNodes: GraphNodeSnapshot[] = [];
    const removedNodes: GraphNodeSnapshot[] = [];

    // Edges in proposed but NOT in current → ADDED
    for (const [key, edge] of proposedEdges) {
        if (!currentEdges.has(key)) {
            addedEdges.push(edge);
        }
    }

    // Edges in current but NOT in proposed → REMOVED
    for (const [key, edge] of currentEdges) {
        if (!proposedEdges.has(key)) {
            removedEdges.push(edge);
        }
    }

    // Nodes in proposed but NOT in current → ADDED
    for (const [key, node] of proposedNodes) {
        if (!currentNodes.has(key)) {
            addedNodes.push(node);
        }
    }

    // Nodes in current but NOT in proposed → REMOVED
    for (const [key, node] of currentNodes) {
        if (!proposedNodes.has(key)) {
            removedNodes.push(node);
        }
    }

    // Collapse scope-drift pairs before returning. See dropScopeDriftPairs.
    const scopeDriftCleaned = dropScopeDriftPairs(addedEdges, removedEdges);
    // Collapse table-rename cascades next. See suppressTableRenameCascade.
    const cascadeCleaned = suppressTableRenameCascade(
        scopeDriftCleaned.addedEdges,
        scopeDriftCleaned.removedEdges,
    );

    return {
        changedFiles,
        addedEdges: cascadeCleaned.addedEdges,
        removedEdges: cascadeCleaned.removedEdges,
        addedNodes,
        removedNodes,
        ...(cascadeCleaned.tableRenameCascades.length > 0
            ? { tableRenameCascades: cascadeCleaned.tableRenameCascades }
            : {}),
    };
}

/**
 * Collapse "scope-drift" edge pairs to a no-op.
 *
 * An edge pair is scope-drift when the two edges share
 * `(sourceFile, sourceId|sourceName, relType, targetType, targetName)` and
 * differ only on `targetId`. This happens when the DB holds a node whose URN
 * was rewritten by a post-ingest welder (cross-repo DataContainer dedup by
 * physical endpoint, for example) while the ephemeral re-extraction emits
 * the naive single-repo URN — both refer to the same logical target, but the
 * differ would see them as `removed + added` because `edgeKey` is composed
 * from `targetId`.
 *
 * Without this pass the rename-pair detector in `blast-radius-resolver.ts`
 * would render misleading findings like `Table mapping changed: orders ->
 * orders`. The deeper fix lives in the ephemeral extractor (Step 2: weld
 * resolution before diff); this is defense in depth so the rendered output
 * is always coherent.
 *
 * Pure function: returns new arrays, leaves inputs untouched.
 */
function dropScopeDriftPairs(
    addedEdges: GraphEdgeSnapshot[],
    removedEdges: GraphEdgeSnapshot[],
): { addedEdges: GraphEdgeSnapshot[]; removedEdges: GraphEdgeSnapshot[] } {
    if (addedEdges.length === 0 || removedEdges.length === 0) {
        return { addedEdges, removedEdges };
    }

    const droppedAdded = new Set<number>();
    const droppedRemoved = new Set<number>();

    for (let i = 0; i < removedEdges.length; i++) {
        const removed = removedEdges[i];
        for (let j = 0; j < addedEdges.length; j++) {
            if (droppedAdded.has(j)) continue;
            const added = addedEdges[j];
            if (isScopeDriftPair(removed, added)) {
                droppedRemoved.add(i);
                droppedAdded.add(j);
                break;
            }
        }
    }

    if (droppedAdded.size === 0 && droppedRemoved.size === 0) {
        return { addedEdges, removedEdges };
    }

    return {
        addedEdges: addedEdges.filter((_, idx) => !droppedAdded.has(idx)),
        removedEdges: removedEdges.filter((_, idx) => !droppedRemoved.has(idx)),
    };
}

function isScopeDriftPair(removed: GraphEdgeSnapshot, added: GraphEdgeSnapshot): boolean {
    if (removed.targetId === added.targetId) return false;
    if (removed.targetName !== added.targetName) return false;
    if (removed.targetType !== added.targetType) return false;
    if (removed.relType !== added.relType) return false;
    if (removed.sourceFile !== added.sourceFile) return false;
    // Same chunk: identity matches on either URN or display name.
    return removed.sourceId === added.sourceId || removed.sourceName === added.sourceName;
}

/**
 * Collapse the column-cascade noise that an ORM entity table rename
 * generates.
 *
 * Renaming `@ORM\Table(name="orders")` to `name="purchases"` flips the parent
 * table name. Because the DataStructure URN scheme is
 * `cr:schema:database_table:<table>`, EVERY dependent edge churns: the
 * DataStructure itself, every DataField, every HAS_FIELD, the HAS_SCHEMA
 * join with the DataContainer, and the Function PRODUCES edge. The blast
 * resolver would otherwise emit one DANGER per HAS_FIELD removal, drowning
 * the legitimate "Table mapping changed" finding in noise.
 *
 * Strategy: detect table renames as MAPS_TO pairs whose `sourceName` ends
 * with `::__class_metadata`. For each detected `(oldTable, newTable)`,
 * drop every edge whose `sourceId` or `targetId` references the old or new
 * `cr:schema:database_table:<table>` namespace. Collect the dropped column
 * names so the resolver can surface them in the table-rename finding.
 *
 * Column renames *inside* an unchanged table (Step 3 happy path) are
 * untouched because no table-rename pair is detected for them.
 *
 * Pure function: returns new arrays, leaves inputs untouched.
 */
function suppressTableRenameCascade(
    addedEdges: GraphEdgeSnapshot[],
    removedEdges: GraphEdgeSnapshot[],
): {
    addedEdges: GraphEdgeSnapshot[];
    removedEdges: GraphEdgeSnapshot[];
    tableRenameCascades: Array<{ oldTable: string; newTable: string; columns: string[] }>;
} {
    // Detect table-rename pairs. We don't reuse `findRenamePairs` from
    // blast-radius-resolver.ts to keep the differ free of resolver coupling.
    const renames: Array<{ oldTable: string; newTable: string }> = [];
    const seenAddedKeys = new Set<number>();
    for (const removed of removedEdges) {
        if (!isTableRenameCandidate(removed)) continue;
        const addedIdx = addedEdges.findIndex((added, idx) =>
            !seenAddedKeys.has(idx)
            && isTableRenameCandidate(added)
            && added.sourceFile === removed.sourceFile
            && (added.sourceId === removed.sourceId || added.sourceName === removed.sourceName)
            && added.targetName !== removed.targetName,
        );
        if (addedIdx === -1) continue;
        const added = addedEdges[addedIdx];
        seenAddedKeys.add(addedIdx);
        renames.push({
            oldTable: removed.targetName.toLowerCase(),
            newTable: added.targetName.toLowerCase(),
        });
    }

    if (renames.length === 0) {
        return { addedEdges, removedEdges, tableRenameCascades: [] };
    }

    // Build the URN prefix set whose edges count as cascade dependents.
    // The MAPS_TO rename pair itself is excluded so the resolver can emit
    // the user-visible "Table mapping changed" finding.
    const tableNamespaces = new Set<string>();
    for (const { oldTable, newTable } of renames) {
        tableNamespaces.add(`cr:schema:database_table:${oldTable}`);
        tableNamespaces.add(`cr:schema:database_table:${newTable}`);
    }

    const belongsToCascade = (edge: GraphEdgeSnapshot): boolean => {
        // Never drop the MAPS_TO rename pair itself.
        if (edge.relType === 'MAPS_TO' && edge.targetType === 'DataContainer') return false;
        for (const ns of tableNamespaces) {
            if (edge.sourceId === ns || edge.sourceId.startsWith(`${ns}:`)) return true;
            if (edge.targetId === ns || edge.targetId.startsWith(`${ns}:`)) return true;
        }
        return false;
    };

    // Collect dropped column names per (oldTable). Only HAS_FIELD edges on
    // the OLD-side DataStructure tell us what columns the entity used to
    // declare; that's the list we want to show in the finding.
    const columnsByOldTable = new Map<string, string[]>();
    for (const { oldTable } of renames) columnsByOldTable.set(oldTable, []);
    for (const edge of removedEdges) {
        if (edge.relType !== 'HAS_FIELD' || edge.targetType !== 'DataField') continue;
        for (const { oldTable } of renames) {
            const ns = `cr:schema:database_table:${oldTable}`;
            if (edge.sourceId === ns || edge.sourceId.startsWith(`${ns}:`)) {
                columnsByOldTable.get(oldTable)!.push(edge.targetName);
                break;
            }
        }
    }

    return {
        addedEdges: addedEdges.filter(e => !belongsToCascade(e)),
        removedEdges: removedEdges.filter(e => !belongsToCascade(e)),
        tableRenameCascades: renames.map(r => ({
            oldTable: r.oldTable,
            newTable: r.newTable,
            columns: columnsByOldTable.get(r.oldTable) ?? [],
        })),
    };
}

function isTableRenameCandidate(edge: GraphEdgeSnapshot): boolean {
    return edge.relType === 'MAPS_TO'
        && edge.targetType === 'DataContainer'
        && edge.sourceName.endsWith('::__class_metadata');
}

// ─── Analysis Helpers ─────────────────────────────────────────────────────────

/**
 * Check whether a delta is empty (no structural changes detected).
 */
export function isDeltaEmpty(delta: GraphDelta): boolean {
    return (
        delta.addedEdges.length === 0 &&
        delta.removedEdges.length === 0 &&
        delta.addedNodes.length === 0 &&
        delta.removedNodes.length === 0
    );
}

/**
 * Get all distinct resource URNs affected by the delta.
 * Useful for batching blast-radius queries.
 */
export function getAffectedResourceUrns(delta: GraphDelta): Set<string> {
    const urns = new Set<string>();
    for (const edge of delta.addedEdges) urns.add(edge.targetId);
    for (const edge of delta.removedEdges) urns.add(edge.targetId);
    return urns;
}

/**
 * Get all removed edges grouped by their target resource URN.
 * Used by the blast-radius resolver to batch impact queries.
 */
export function getRemovedEdgesByTarget(
    delta: GraphDelta
): Map<string, GraphEdgeSnapshot[]> {
    const byTarget = new Map<string, GraphEdgeSnapshot[]>();
    for (const edge of delta.removedEdges) {
        const existing = byTarget.get(edge.targetId) ?? [];
        existing.push(edge);
        byTarget.set(edge.targetId, existing);
    }
    return byTarget;
}

/**
 * Get all added edges grouped by their target resource URN.
 * Used for orphan node detection (added edges toward unknown resources).
 */
export function getAddedEdgesByTarget(
    delta: GraphDelta
): Map<string, GraphEdgeSnapshot[]> {
    const byTarget = new Map<string, GraphEdgeSnapshot[]>();
    for (const edge of delta.addedEdges) {
        const existing = byTarget.get(edge.targetId) ?? [];
        existing.push(edge);
        byTarget.set(edge.targetId, existing);
    }
    return byTarget;
}
