import { getMemgraphSession } from '../../graph/neo4j.js';
import type { Session } from 'neo4j-driver';
import type { StructuralEntity, StructuralFileIndexRow, StructuralEnrichment } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Structural Extraction Layer — Neo4j Queries
//
// Dedicated query module for the structural layer. Keeps Cypher queries
// isolated from the LLM pipeline's queries.ts to maintain separation of
// concerns and prevent accidental coupling.
// ═══════════════════════════════════════════════════════════════════════════════

async function run(cypher: string, params: Record<string, unknown> = {}) {
    const session = getMemgraphSession();
    try {
        return await session.executeWrite(async (tx) => {
            return await tx.run(cypher, params);
        });
    } finally {
        await session.close();
    }
}

// ─── Scoped Session ──────────────────────────────────────────────────────────
// Keeps one Memgraph session alive for a batch of queries executed within the
// same logical unit (e.g. one repo's structural extraction).  This reduces
// session open/close churn from ~3000 cycles to ~300 for a 300-repo scan,
// avoiding the Bun segfault (0xA002D002D002D) in the neo4j-driver Bolt parser.

/** Active scoped session, set by withScopedSession(). */
let _scopedSession: Session | null = null;

/**
 * Execute `fn` with a single reused Memgraph session.
 * All `run()` calls inside `fn` route through this session instead of
 * opening a fresh one. After `fn` completes (or throws), the session is closed.
 */
export async function withScopedSession<T>(fn: () => Promise<T>): Promise<T> {
    const session = getMemgraphSession();
    _scopedSession = session;
    try {
        return await fn();
    } finally {
        _scopedSession = null;
        await session.close();
    }
}

/**
 * Run a Cypher query using the scoped session if available, otherwise open a
 * fresh one.  This is the session-aware replacement for `run()` — all entity
 * persistence functions should call this.
 */
async function runScoped(cypher: string, params: Record<string, unknown> = {}) {
    if (_scopedSession) {
        return await _scopedSession.executeWrite(async (tx) => {
            return await tx.run(cypher, params);
        });
    }
    return run(cypher, params);
}

// ─── Structural Hash ─────────────────────────────────────────────────────────

/**
 * Load the structural hash for a repository.
 * Returns null if no structural hash has been set yet.
 */
export async function loadStructuralHash(repoUrn: string): Promise<string | null> {
    const result = await runScoped(
        `MATCH (r:Repository {id: $repoUrn})
         RETURN r.structuralHash AS structuralHash`,
        { repoUrn },
    );
    if (result.records.length === 0) return null;
    return result.records[0].get('structuralHash') as string | null;
}

/**
 * Update the structural hash for a repository.
 */
export async function updateStructuralHash(repoUrn: string, hash: string): Promise<void> {
    await runScoped(
        `MATCH (r:Repository {id: $repoUrn})
         SET r.structuralHash = $hash`,
        { repoUrn, hash },
    );
}

// ─── Structural File Index ───────────────────────────────────────────────────

/**
 * Load all structural file entries for a repository.
 * Used for per-file cache comparison.
 */
export async function loadStructuralFileIndex(repoUrn: string): Promise<StructuralFileIndexRow[]> {
    const result = await runScoped(
        `MATCH (r:Repository {id: $repoUrn})-[:HAS_CONFIG]->(sf:StructuralFile)
         RETURN sf.path AS path, sf.fileHash AS hash, sf.pluginName AS plugin`,
        { repoUrn },
    );
    return result.records.map(r => ({
        path: r.get('path') as string,
        fileHash: r.get('hash') as string,
        pluginName: r.get('plugin') as string,
    }));
}

/**
 * Persist a StructuralFile node and link it to the Repository.
 */
export async function mergeStructuralFile(
    sfUrn: string,
    path: string,
    fileHash: string,
    pluginName: string,
    ownerUrn: string,
    ownerLabel: 'Repository' | 'Service',
): Promise<void> {
    await runScoped(
        `MERGE (sf:StructuralFile {id: $sfUrn})
         SET sf.path = $path, sf.fileHash = $fileHash, sf.pluginName = $pluginName, sf.updatedAt = timestamp()
         WITH sf
         MATCH (o:${ownerLabel} {id: $ownerUrn})
         MERGE (o)-[:HAS_CONFIG]->(sf)`,
        { sfUrn, path, fileHash, pluginName, ownerUrn },
    );
}

// ─── Entity Persistence ──────────────────────────────────────────────────────

/**
 * Persist a structural entity node and link it from its defining StructuralFile.
 *
 * Uses dynamic label assignment via APOC-free approach:
 * We use a label-specific MERGE query generated per entity.
 */
// Fix P2.4: array fields that should be dedup-merged (additive) instead of
// clobber-overwrite when an entity is touched by multiple plugins / runs.
// Mirrors the grounding `reduce()` pattern in `_run.ts:groundingWriteClause`.
const DEDUP_ARRAY_PROPS = new Set([
    'evidence_extractors',
    'evidence_fallbacksApplied',
    'evidence_mergedFrom',
]);

const GROUNDING_DEFAULTS: Record<string, unknown> = {
    source: 'ast',
    quality: 'exact',
    needsReview: false,
    evidence_extractors: ['structural-plugin@v1'],
};

export function ensureGrounding(props: Record<string, unknown>): Record<string, unknown> {
    if (props.quality != null && props.quality !== null) return props;
    const { quality: _q, ...rest } = props;
    return { ...GROUNDING_DEFAULTS, ...rest };
}

export async function mergeStructuralEntity(
    entity: StructuralEntity,
    sfUrn: string,
): Promise<void> {
    entity = { ...entity, properties: ensureGrounding(entity.properties) };
    const propKeys = Object.keys(entity.properties);
    const setClauses = propKeys.map(k => {
        if (DEDUP_ARRAY_PROPS.has(k)) {
            return `n.${k} = reduce(_acc = [], _x IN coalesce(n.${k}, []) + coalesce($props.${k}, []) | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`;
        }
        return `n.${k} = $props.${k}`;
    }).join(', ');
    const setStr = setClauses ? `, ${setClauses}` : '';

    // We must use the label directly in the query string (Neo4j doesn't support parameterized labels)
    const label = entity.labels[0]; // Primary label
    const relType = entity.relationshipType;

    // Build optional SET clause for edge properties (context, scope on USES_IMAGE)
    const relProps = entity.relationshipProperties;
    const relPropKeys = relProps ? Object.keys(relProps) : [];
    const relSetStr = relPropKeys.map(k => `r.${k} = $relProps.${k}`).join(', ');
    const relSetClause = relSetStr ? `SET ${relSetStr}` : '';

    await runScoped(
        `MERGE (n:${label} {id: $entityId})
         SET n.updatedAt = timestamp(), n.valid_to_commit = null${setStr}
         WITH n
         MATCH (sf:StructuralFile {id: $sfUrn})
         MERGE (sf)-[r:${relType}]->(n)
         ${relSetClause}`,
        { entityId: entity.id, sfUrn, props: entity.properties, relProps: relProps ?? {} },
    );
}

/**
 * Persist a structural entity without creating Repository/StructuralFile
 * provenance. Used by single-file infra ingest where the file itself is an
 * operator-provided snapshot and storing its absolute path would leak local
 * filesystem details into the graph.
 */
export async function mergeStandaloneStructuralEntity(
    entity: StructuralEntity,
): Promise<void> {
    entity = { ...entity, properties: ensureGrounding(entity.properties) };
    const propKeys = Object.keys(entity.properties);
    const setClauses = propKeys.map(k => {
        if (DEDUP_ARRAY_PROPS.has(k)) {
            return `n.${k} = reduce(_acc = [], _x IN coalesce(n.${k}, []) + coalesce($props.${k}, []) | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`;
        }
        return `n.${k} = $props.${k}`;
    }).join(', ');
    const setStr = setClauses ? `, ${setClauses}` : '';
    const label = entity.labels[0];

    await runScoped(
        `MERGE (n:${label} {id: $entityId})
         SET n.updatedAt = timestamp()${setStr}`,
        { entityId: entity.id, props: entity.properties },
    );
}

/**
 * Persist a ProjectDirectory entity and link it directly to the Repository.
 * Ghost directories don't have a StructuralFile parent — they link to the repo.
 */
export async function mergeProjectDirectory(
    id: string,
    name: string,
    dirPath: string,
    category: string,
    ownerUrn: string,
    ownerLabel: 'Repository' | 'Service',
): Promise<void> {
    await run(
        `MERGE (d:ProjectDirectory {id: $id})
         SET d.name = $name, d.path = $dirPath, d.category = $category, d.updatedAt = timestamp()
         WITH d
         MATCH (o:${ownerLabel} {id: $ownerUrn})
         MERGE (o)-[:CONTAINS_DIRECTORY]->(d)`,
        { id, name, dirPath, category, ownerUrn },
    );
}

/**
 * Batch persist ProjectDirectory entities using UNWIND for high performance.
 */
export async function mergeProjectDirectoriesBatch(
    directories: Array<{
        id: string;
        name: string;
        dirPath: string;
        category: string;
        ownerUrn: string;
        ownerLabel: 'Repository' | 'Service';
    }>
): Promise<void> {
    if (directories.length === 0) return;

    const repoDirs = directories.filter(d => d.ownerLabel === 'Repository');
    const serviceDirs = directories.filter(d => d.ownerLabel === 'Service');

    // Keep Bolt payload bounded on large monorepos with many ghost dirs.
    const chunkRaw = Number(process.env.RADIUS_STRUCTURAL_DIR_CHUNK_SIZE ?? '200');
    const DIRS_CHUNK_SIZE = Number.isFinite(chunkRaw) && chunkRaw > 0
        ? Math.floor(chunkRaw)
        : 200;

    for (let i = 0; i < repoDirs.length; i += DIRS_CHUNK_SIZE) {
        const chunk = repoDirs.slice(i, i + DIRS_CHUNK_SIZE);
        await runScoped(
            `UNWIND $dirs AS d
             MERGE (node:ProjectDirectory {id: d.id})
             SET node.name = d.name, node.path = d.dirPath, node.category = d.category, node.updatedAt = timestamp()
             WITH node, d
             MATCH (o:Repository {id: d.ownerUrn})
             MERGE (o)-[:CONTAINS_DIRECTORY]->(node)`,
            { dirs: chunk },
        );
    }

    for (let i = 0; i < serviceDirs.length; i += DIRS_CHUNK_SIZE) {
        const chunk = serviceDirs.slice(i, i + DIRS_CHUNK_SIZE);
        await runScoped(
            `UNWIND $dirs AS d
             MERGE (node:ProjectDirectory {id: d.id})
             SET node.name = d.name, node.path = d.dirPath, node.category = d.category, node.updatedAt = timestamp()
             WITH node, d
             MATCH (o:Service {id: d.ownerUrn})
             MERGE (o)-[:CONTAINS_DIRECTORY]->(node)`,
            { dirs: chunk },
        );
    }
}

// ─── Shortcut Edges (Golden Path Fast Queries) ──────────────────────────────

/**
 * Create a shortcut edge from the owner node directly to an extracted entity.
 * These edges bypass the StructuralFile provenance chain for fast compliance queries
 * (e.g. `cr policy verify`).
 *
 * Full mapping (mirrors architecture.md "Golden Path Shortcut Edges"):
 *   Task         → (Owner)-[:HAS_TASK]---------->(Task)
 *   DockerImage  → (Owner)-[:HAS_DOCKER_IMAGE]-->(DockerImage)
 *   ToolConfig   → (Owner)-[:HAS_TOOL_CONFIG]-->(ToolConfig)   [tsconfig, renovate, ...]
 *   AgenticConfig→ (Owner)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig)
 *   CIPipeline   → (Owner)-[:HAS_CI_PIPELINE]-->(CIPipeline)   [gitlab-ci, github-actions]
 *
 * Owner is either Repository or Service depending on where the StructuralFile
 * is attached. Both are valid for all shortcut types.
 */
const SHORTCUT_REL_MAP: Record<string, string> = {
    Task: 'HAS_TASK',
    DockerImage: 'HAS_DOCKER_IMAGE',
    ToolConfig: 'HAS_TOOL_CONFIG',
    AgenticConfig: 'HAS_AGENTIC_CONFIG',
    CIPipeline: 'HAS_CI_PIPELINE',
    CIComponent: 'INCLUDES_COMPONENT',
};

export async function createShortcutEdge(
    ownerUrn: string,
    ownerLabel: 'Repository' | 'Service',
    entityId: string,
    entityLabel: string,
): Promise<void> {
    const relType = SHORTCUT_REL_MAP[entityLabel];
    if (!relType) return; // No shortcut for this label

    await runScoped(
        `MATCH (o:${ownerLabel} {id: $ownerUrn}), (n:${entityLabel} {id: $entityId})
         MERGE (o)-[:${relType}]->(n)`,
        { ownerUrn, entityId },
    );
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Fetch all existing entity IDs for a given label linked to a repository's
 * structural files. Used for Mark & Sweep reconciliation.
 *
 * Traverses THREE paths to cover all possible ownership topologies:
 *   1. (Repository)-[:HAS_CONFIG]->(StructuralFile)→(Entity)          [direct]
 *   2. (Service)-[:STORED_IN]->(Repository) + (Service)-[:HAS_CONFIG]->(StructuralFile)→(Entity)  [via Service]
 *   3. (Repository|Service)-[:shortcutRel]->(Entity)                  [orphaned shortcut edges]
 *
 * Path 3 catches "zombie" entities whose StructuralFile was already deleted
 * but whose shortcut edges (HAS_AGENTIC_CONFIG, HAS_TOOL_CONFIG, etc.)
 * survived because DETACH DELETE only removed the StructuralFile node.
 */
export async function getExistingStructuralEntityIds(
    repoUrn: string,
    label: string,
): Promise<string[]> {
    // Resolve the shortcut relationship type for this label
    const shortcutRel = SHORTCUT_REL_MAP[label];

    // Build a dynamic OPTIONAL MATCH for the shortcut path (path 3)
    const shortcutClause = shortcutRel
        ? `OPTIONAL MATCH (r)-[:${shortcutRel}]->(n3:${label})
           OPTIONAL MATCH (svc)-[:${shortcutRel}]->(n4:${label})`
        : '';
    const shortcutCollect = shortcutRel
        ? ' + collect(DISTINCT n3) + collect(DISTINCT n4)'
        : '';

    const result = await runScoped(
        `MATCH (r:Repository {id: $repoUrn})
         OPTIONAL MATCH (r)-[:HAS_CONFIG]->(:StructuralFile)-[]->(n1:${label})
         OPTIONAL MATCH (svc:Service)-[:STORED_IN]->(r)
         OPTIONAL MATCH (svc)-[:HAS_CONFIG]->(:StructuralFile)-[]->(n2:${label})
         ${shortcutClause}
         WITH collect(DISTINCT n1) + collect(DISTINCT n2)${shortcutCollect} AS nodes
         UNWIND nodes AS node
         WITH node WHERE node IS NOT NULL
         RETURN DISTINCT node.id AS existingId`,
        { repoUrn },
    );
    return result.records.map(r => r.get('existingId') as string);
}

/**
 * Fetch all existing ProjectDirectory IDs for a repository.
 */
export async function getExistingProjectDirectoryIds(repoUrn: string): Promise<string[]> {
    const result = await runScoped(
        `MATCH (o)-[:CONTAINS_DIRECTORY]->(d:ProjectDirectory)
         WHERE o.id = $repoUrn OR (o:Service AND o.repositoryUrn = $repoUrn)
         RETURN d.id AS existingId`,
        { repoUrn },
    );
    return result.records.map(r => r.get('existingId') as string);
}

/**
 * Delete stale structural nodes that are no longer present in the extraction.
 * Uses DETACH DELETE to remove all relationships.
 */
export async function deleteStaleEntities(staleIds: string[]): Promise<void> {
    if (staleIds.length === 0) return;
    const staleChunkRaw = Number(process.env.RADIUS_STALE_DELETE_CHUNK_SIZE ?? '500');
    const STALE_DELETE_CHUNK_SIZE = Number.isFinite(staleChunkRaw) && staleChunkRaw > 0
        ? Math.floor(staleChunkRaw)
        : 500;
    for (let i = 0; i < staleIds.length; i += STALE_DELETE_CHUNK_SIZE) {
        const chunk = staleIds.slice(i, i + STALE_DELETE_CHUNK_SIZE);
        await runScoped(
            `UNWIND $staleIds AS staleId
             MATCH (n {id: staleId})
             DETACH DELETE n`,
            { staleIds: chunk },
        );
    }
}

/**
 * Remove orphaned StructuralFile nodes whose files no longer exist on disk.
 *
 * Scans BOTH paths:
 *   (Repository)-[:HAS_CONFIG]->(StructuralFile)
 *   (Service)-[:STORED_IN]->(Repository) + (Service)-[:HAS_CONFIG]->(StructuralFile)
 */
export async function deleteOrphanedStructuralFiles(
    repoUrn: string,
    currentPaths: string[],
): Promise<number> {
    const result = await runScoped(
        `MATCH (r:Repository {id: $repoUrn})
         OPTIONAL MATCH (r)-[:HAS_CONFIG]->(sf1:StructuralFile)
         OPTIONAL MATCH (svc:Service)-[:STORED_IN]->(r)
         OPTIONAL MATCH (svc)-[:HAS_CONFIG]->(sf2:StructuralFile)
         WITH collect(sf1) + collect(sf2) AS allFiles
         UNWIND allFiles AS sf
         WITH DISTINCT sf
         WHERE sf IS NOT NULL AND NOT sf.path IN $currentPaths
         DETACH DELETE sf
         RETURN count(sf) AS deleted`,
        { repoUrn, currentPaths },
    );
    const count = result.records[0]?.get('deleted');
    return typeof count === 'object' && count !== null && 'toNumber' in count
        ? (count as { toNumber: () => number }).toNumber()
        : (count as number) ?? 0;
}

// ─── Inter-Entity Edges ──────────────────────────────────────────────────────

/** Allowed relationship types for structural edges (defense-in-depth against injection). */
const ALLOWED_EDGE_TYPES = new Set([
    'ROUTES_TO',
    'PROVISIONS',
    'DEPENDS_ON',
    'LINKS_TO',
    'REFERENCES',
    // Messaging topology (Phase 1)
    'HOSTED_ON',
    'MANIFESTS_AS',
    'BACKED_BY',
    'DEAD_LETTERS_TO',
]);

/**
 * Create an edge between two graph nodes by URN.
 * Used by plugins that declare inter-entity relationships via `StructuralEntity.edges`.
 *
 * The relationship type is validated against a whitelist to prevent Cypher injection
 * (plugin code is trusted, but defense-in-depth is good practice).
 *
 * Optional `properties` are stamped on the edge in a single `SET r += $props`
 * clause. Messaging plugins use this to carry routing metadata (bindingKey,
 * isPattern, patternRegex, ...) onto `ROUTES_TO` edges.
 */
export async function mergeStructuralEdge(
    sourceUrn: string,
    targetUrn: string,
    type: string,
    properties?: Record<string, unknown>,
): Promise<void> {
    if (!ALLOWED_EDGE_TYPES.has(type)) {
        throw new Error(`[Structural] Rejected edge type "${type}" — not in ALLOWED_EDGE_TYPES whitelist`);
    }

    // Gotcha #1 fix: for routing-like edges (`ROUTES_TO`, `MANIFESTS_AS`,
    // `BACKED_BY`) the *binding key* (or the legacy routing_key) is the part
    // that distinguishes two parallel relationships between the same nodes.
    // We compute a single `identityKey` and embed it in the MERGE pattern so
    // two distinct bindings produce two distinct edges instead of collapsing.
    const bindingKey = properties?.bindingKey;
    const legacyKey = properties?.routing_key;
    const identityKey: string = typeof bindingKey === 'string' ? bindingKey
        : typeof legacyKey === 'string' ? legacyKey
        : '';

    const hasProps = properties && Object.keys(properties).length > 0;
    await runScoped(
        `MATCH (a {id: $sourceUrn})
         MATCH (b {id: $targetUrn})
         MERGE (a)-[r:${type} {bindingKey: $identityKey}]->(b)
         ${hasProps ? 'SET r += $props' : ''}`,
        { sourceUrn, targetUrn, identityKey, props: properties ?? {} },
    );
}

// ─── Edge-Level Reconciliation ───────────────────────────────────────────────

/**
 * Delete stale USES_IMAGE edges from a specific StructuralFile.
 *
 * Called after processing a YAML manifest to remove edges for images
 * that are no longer referenced in the file. This catches the case where
 * an `image:` line is removed from docker-compose.yml without the file
 * itself being deleted (which would not trigger deleteOrphanedStructuralFiles).
 *
 * @param sfUrn            URN of the StructuralFile that was just processed
 * @param currentImageIds  IDs of DockerImage entities emitted in this extraction
 * @returns                Number of stale edges deleted
 */
export async function sweepStaleImageEdges(
    sfUrn: string,
    currentImageIds: string[],
): Promise<number> {
    const result = await runScoped(
        `MATCH (sf:StructuralFile {id: $sfUrn})-[r:USES_IMAGE]->(d:DockerImage)
         WHERE NOT d.id IN $currentImageIds
         DELETE r
         RETURN count(r) AS deleted`,
        { sfUrn, currentImageIds },
    );
    const raw = result.records[0]?.get('deleted');
    return typeof raw === 'object' && raw !== null && 'toNumber' in raw
        ? (raw as { toNumber: () => number }).toNumber()
        : (raw as number) ?? 0;
}

/**
 * Apply enrichment properties to existing nodes matched by label + field.
 * Used by manifest parsers (skills-lock.json) to stamp provenance onto nodes
 * created by other plugins without creating duplicates.
 */
export async function applyEnrichment(enrichment: StructuralEnrichment): Promise<boolean> {
    const { label, matchField, matchValue, properties } = enrichment;
    const propKeys = Object.keys(properties);
    if (propKeys.length === 0) return false;

    const setClauses = propKeys.map(k => `n.${k} = $props.${k}`).join(', ');

    const result = await runScoped(
        `MATCH (n:${label})
         WHERE n.${matchField} = $matchValue
         SET ${setClauses}
         RETURN count(n) AS matched`,
        { matchValue, props: properties },
    );
    const matched = Number(result.records[0]?.get('matched') ?? 0);
    return matched > 0;
}
