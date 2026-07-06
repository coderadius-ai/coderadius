// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine: Blast Radius Resolver
//
// Step 5 of the In-Memory Graph Overlay pipeline.
//
// Given a GraphDelta, this module queries the Memgraph master graph (READ-ONLY)
// to determine the impact of each topological change.
//
// Two types of impact are resolved:
//
//   1. Breaking Change (removedEdge):
//      "If we stop publishing to queue X, who currently listens to queue X?"
//      → Uses `analyzeBlast(targetUrn)` from the existing impact engine.
//      → If downstream consumers exist: DANGER finding.
//      → If no downstream consumers: INFO finding (safe removal).
//
//   2. Orphan Producer (addedEdge toward a NEW node):
//      "We're now publishing to queue Y, but does anyone listen to queue Y?"
//      → Checks if the targetId already exists in the master graph.
//      → If no existing consumers: WARNING finding (orphan producer).
//      → If consumers already exist: INFO finding (expected extension).
//
// CRITICAL: No writes to Memgraph. All queries are MATCH-only.
// ═══════════════════════════════════════════════════════════════════════════════

import { analyzeBlast, resolveResource } from '../graph/queries/blast.js';
import { getMemgraphSession } from '../graph/neo4j.js';
import type { ResolvedResource } from '../graph/types.js';
import { logger } from '../utils/logger.js';
import { getRemovedEdgesByTarget, getAddedEdgesByTarget } from './graph-differ.js';
import type { GraphDelta, GraphEdgeSnapshot, GuardrailFinding } from './types.js';

// ─── Blast Resolution ─────────────────────────────────────────────────────────

// "Producer" edges: the source node creates / exposes / publishes a resource
// to which others bind. Treated specially by the orphan-producer check:
// adding such an edge to a target with no consumers is a WARNING (something
// is being produced that nobody listens to / calls).
//   - PUBLISHES_TO / PRODUCES — message bus producers
//   - WRITES                  — data writers
//   - IMPLEMENTS_ENDPOINT     — HTTP route exposers (server side of an API)
const PRODUCER_REL_TYPES = new Set([
    'PUBLISHES_TO',
    'PRODUCES',
    'WRITES',
    'IMPLEMENTS_ENDPOINT',
]);

function plural(n: number, singular: string, pluralForm = singular + 's'): string {
    return `${n} ${n === 1 ? singular : pluralForm}`;
}

function edgeInstanceKey(edge: GraphEdgeSnapshot): string {
    return `${edge.sourceId}::${edge.sourceFile}::${edge.relType}::${edge.targetType}::${edge.targetId}`;
}

function isRenamePair(removed: GraphEdgeSnapshot, added: GraphEdgeSnapshot): boolean {
    if (removed.targetId === added.targetId) return false;
    if (removed.sourceFile !== added.sourceFile) return false;
    if (removed.relType !== added.relType) return false;
    if (removed.targetType !== added.targetType) return false;
    // A rename always changes the target's display identity. Same name with
    // different URN is a scope-drift artifact (e.g. cross-repo welder
    // collapsed two DataContainers, or coderadius.yaml databases[] config
    // shifted the scope segment). Treating it as a rename would emit a
    // misleading "X -> X" finding. The differ collapses these pairs upstream
    // in dropScopeDriftPairs; this guard is the second-line defense.
    if (removed.targetName === added.targetName) return false;

    if (removed.sourceId === added.sourceId) return true;
    if (removed.sourceName === added.sourceName) return true;

    // Endpoint route handlers carry the URL path inside the source identifier
    // (e.g. `POST /api/x/quote::__route_handler`). When the route is renamed,
    // BOTH the source URN and source name change, so the strict checks above
    // miss the pair and we end up with one DANGER + one INFO finding for the
    // same logical edit. Match on the function short-name (segment after the
    // last `::`) as a relaxed signal that the same handler implements both
    // the old and new endpoint.
    if (removed.relType === 'IMPLEMENTS_ENDPOINT') {
        const removedShort = removed.sourceName.split('::').at(-1);
        const addedShort = added.sourceName.split('::').at(-1);
        if (removedShort && removedShort === addedShort) return true;
    }

    return false;
}

function findRenamePairs(delta: GraphDelta): {
    pairs: Array<{ removed: GraphEdgeSnapshot; added: GraphEdgeSnapshot }>;
    pairedRemovedKeys: Set<string>;
    pairedAddedKeys: Set<string>;
} {
    const pairs: Array<{ removed: GraphEdgeSnapshot; added: GraphEdgeSnapshot }> = [];
    const pairedRemovedKeys = new Set<string>();
    const pairedAddedKeys = new Set<string>();

    for (const removed of delta.removedEdges) {
        const added = delta.addedEdges.find(candidate => {
            const candidateKey = edgeInstanceKey(candidate);
            return !pairedAddedKeys.has(candidateKey) && isRenamePair(removed, candidate);
        });
        if (!added) continue;

        pairs.push({ removed, added });
        pairedRemovedKeys.add(edgeInstanceKey(removed));
        pairedAddedKeys.add(edgeInstanceKey(added));
    }

    return { pairs, pairedRemovedKeys, pairedAddedKeys };
}

function scopeFromUrn(urn: string): string | null {
    if (!urn.startsWith('cr:')) return null;
    const parts = urn.split(':');
    if (parts.length < 4) return null;
    return parts[2] || null;
}

function repoStemFromScope(scope: string | null): string | null {
    if (!scope) return null;
    return scope.split('/').at(-1)?.toLowerCase() ?? null;
}

function scoreResource(candidate: ResolvedResource, edge: GraphEdgeSnapshot, targetUrn: string): number {
    const targetName = edge.targetName.toLowerCase();
    const candidateName = candidate.name.toLowerCase();
    const expectedScope = scopeFromUrn(targetUrn);
    const candidateScope = scopeFromUrn(candidate.urn);
    const expectedStem = repoStemFromScope(expectedScope);
    const candidateStem = repoStemFromScope(candidateScope);

    let score = 0;
    if (candidate.urn === targetUrn) score += 1000;
    if (candidate.type === edge.targetType) score += 100;
    if (candidateName === targetName) score += 200;
    else if (candidateName.includes(targetName) || targetName.includes(candidateName)) score += 20;
    if (expectedScope && candidateScope && expectedScope === candidateScope) score += 80;
    if (expectedStem && candidateStem && expectedStem === candidateStem) score += 60;
    if (candidate.urn.endsWith(`:${edge.targetName}`)) score += 10;
    if (expectedStem && candidate.context?.toLowerCase().includes(expectedStem)) score += 5;
    return score;
}

function chooseBestResource(
    candidates: ResolvedResource[],
    edge: GraphEdgeSnapshot,
    targetUrn: string,
): ResolvedResource | null {
    if (candidates.length === 0) return null;

    const sameType = candidates.filter(candidate => candidate.type === edge.targetType);
    const pool = sameType.length > 0 ? sameType : candidates;
    const ranked = pool
        .map(candidate => ({ candidate, score: scoreResource(candidate, edge, targetUrn) }))
        .sort((a, b) => b.score - a.score || a.candidate.urn.localeCompare(b.candidate.urn));

    return ranked[0]?.candidate ?? null;
}

async function resolveBlastResource(
    edge: GraphEdgeSnapshot,
    targetUrn: string,
): Promise<ResolvedResource | null> {
    // Column-level edges (HAS_FIELD → DataField) have no blast consumers of
    // their own: the impact lives on the parent DataContainer (whoever reads
    // the table will see the column rename as a breaking change). Walk
    // (dc)-[HAS_SCHEMA]->(ds {id: sourceId}) once and blast on the DC.
    if (isColumnEdge(edge)) {
        const dc = await resolveColumnParentDataContainer(edge.sourceId);
        if (dc) return dc;
    }

    const exact = await resolveResource(targetUrn);
    const exactMatch = chooseBestResource(exact, edge, targetUrn);
    if (exactMatch) return exactMatch;

    const byName = await resolveResource(edge.targetName);
    return chooseBestResource(byName, edge, targetUrn);
}

async function resolveColumnParentDataContainer(dataStructureUrn: string): Promise<ResolvedResource | null> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (dc:DataContainer)-[hs:HAS_SCHEMA]->(ds:DataStructure {id: $dsUrn})
             WHERE dc.valid_to_commit IS NULL
               AND hs.valid_to_commit IS NULL
               AND ds.valid_to_commit IS NULL
             RETURN dc.id AS urn, dc.name AS name LIMIT 1`,
            { dsUrn: dataStructureUrn },
        );
        const rec = result.records[0];
        if (!rec) return null;
        return {
            urn: rec.get('urn') as string,
            name: rec.get('name') as string,
            type: 'DataContainer',
        };
    } catch (err) {
        logger.debug(`[BlastRadius] Parent DC lookup failed for ${dataStructureUrn}: ${(err as Error).message}`);
        return null;
    } finally {
        await session.close();
    }
}

function affectedServicesFromBlast(blastResult: Awaited<ReturnType<typeof analyzeBlast>>) {
    return blastResult.downstreamBlasts.map(s => ({
        name: s.serviceName,
        urn: s.serviceUrn,
        teamOwner: s.teamOwner,
        functions: s.functions,
        repository: s.repository,
    }));
}

function dependencyTitlePrefix(edge: GraphEdgeSnapshot): string {
    if (edge.relType === 'HAS_FIELD' && edge.targetType === 'DataField') return 'Column';
    if (edge.relType === 'MAPS_TO' && edge.targetType === 'DataContainer') return 'Table mapping';
    if (edge.relType === 'IMPLEMENTS_ENDPOINT' || edge.targetType === 'APIEndpoint') return 'Endpoint';
    if (edge.targetType === 'MessageChannel') return 'Message channel';
    if (edge.targetType === 'Cache') return 'Cache';
    if (edge.targetType === 'Database') return 'Database';
    if (edge.targetType === 'ObjectStorage') return 'Object storage';
    if (edge.targetType === 'ExternalAPI') return 'External API';
    return 'Dependency';
}

function isColumnEdge(edge: GraphEdgeSnapshot): boolean {
    return edge.relType === 'HAS_FIELD' && edge.targetType === 'DataField';
}

function parentTableFromColumnEdge(edge: GraphEdgeSnapshot): string | null {
    // DataField URN scheme: cr:schema:database_table:<table>:field:<name>
    // The parent table name lives at segment index 3.
    if (!edge.targetId.startsWith('cr:schema:database_table:')) return null;
    const segments = edge.targetId.split(':');
    return segments[3] ?? null;
}

const HTTP_METHOD_RE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/i;

/**
 * Endpoint URNs are stored in two shapes depending on the extractor:
 *   - OpenAPI extractor → `targetName = '/api/x/quote'` (path only)
 *   - PHP route handler → `targetName = 'POST /api/x/quote'` (METHOD + path)
 *
 * Same logical endpoint, two textual forms. When a rename pair combines one
 * of each, the diff would look like `/api/x/quote -> POST /api/x/quota` which
 * misleadingly suggests the method changed. This is a data-shape artefact,
 * not a real diff signal — so the renderer strips the method prefix from
 * whichever side has it, so both sides display as paths and the diff focuses
 * on the path change. RENDER-ONLY: the underlying URN is left untouched.
 *
 * If both sides carry a method (e.g. real GET → POST rename), they are kept
 * as-is and the method change is visible.
 */
function normalizeEndpointPair(
    oldName: string,
    newName: string,
    targetType: string,
): { oldDisplay: string; newDisplay: string } {
    if (targetType !== 'APIEndpoint') return { oldDisplay: oldName, newDisplay: newName };
    const oldMethod = oldName.match(HTTP_METHOD_RE)?.[1];
    const newMethod = newName.match(HTTP_METHOD_RE)?.[1];
    if (!oldMethod && newMethod) {
        return { oldDisplay: oldName, newDisplay: newName.replace(HTTP_METHOD_RE, '') };
    }
    if (oldMethod && !newMethod) {
        return { oldDisplay: oldName.replace(HTTP_METHOD_RE, ''), newDisplay: newName };
    }
    return { oldDisplay: oldName, newDisplay: newName };
}

/**
 * Tight two-line body for a rename pair, optimised for the press-release
 * TTY layout. Renders as:
 *
 *   <old>  ->  <new>
 *   <source> in <file>
 *
 * The renderer can prepend a ROOT CAUSE title line (e.g. "Table renamed",
 * "Column renamed") and trailing context (e.g. "(N columns inherited: ...)")
 * as separate lines without parsing this body.
 */
function formatRenameDiff(removed: GraphEdgeSnapshot, added: GraphEdgeSnapshot): string {
    if (isColumnEdge(removed)) {
        const table = parentTableFromColumnEdge(removed) ?? removed.sourceName;
        return (
            `Column renamed: \`${removed.targetName}\` -> \`${added.targetName}\` in table \`${table}\`\n` +
            `source: \`${removed.sourceName}\` in \`${removed.sourceFile}\``
        );
    }
    const { oldDisplay, newDisplay } = normalizeEndpointPair(removed.targetName, added.targetName, removed.targetType);
    return (
        `\`${oldDisplay}\` -> \`${newDisplay}\`\n` +
        `source: \`${removed.sourceName}\` in \`${removed.sourceFile}\``
    );
}

/**
 * Context-aware noun for "what will break" given the target type. Avoids
 * the generic "reads/writes" phrasing, which sounds DB-flavored when the
 * target is actually an HTTP endpoint or a message channel.
 */
export function breakageVerb(targetType: string | undefined): string {
    switch (targetType) {
        case 'APIEndpoint': return 'downstream calls';
        case 'MessageChannel': return 'message handlers';
        case 'DataContainer': return 'reads/writes';
        case 'Cache': return 'cache reads';
        case 'Database': return 'queries';
        case 'ObjectStorage': return 'storage access';
        case 'ExternalAPI': return 'downstream calls';
        default: return 'downstream usage';
    }
}

/**
 * Active-voice verb phrase for a graph relType. Used in sentence templates
 * like "`source` no longer ${action} `target`" / "`source` now ${action} `target`".
 *
 * Designed so that concatenating with a `target` produces a grammatical
 * sentence. The verbs carry their own preposition where required
 * (`publishes to`, `reads from`, ...), so callers should NOT add a trailing
 * "to" or "from".
 *
 * Falls back to `"relates to"` for unknown relTypes.
 */
export function formatRelAction(relType: string): string {
    const known: Record<string, string> = {
        'PUBLISHES_TO': 'publishes to',
        'PRODUCES': 'produces',
        'WRITES': 'writes to',
        'READS': 'reads from',
        'CONSUMES': 'consumes',
        'CALLS': 'calls',
        'LISTENS_TO': 'listens to',
        'IMPLEMENTS_ENDPOINT': 'exposes',
        'MAPS_TO': 'maps to',
        'CONNECTS_TO': 'connects to',
        'STORED_IN': 'is stored in',
        'DEPENDS_ON': 'depends on',
    };
    return known[relType] ?? 'relates to';
}

/**
 * Resolve the blast radius for a single removed edge.
 *
 * Queries: "Who currently depends on this target resource?"
 * Returns DANGER if downstream consumers exist, INFO otherwise.
 */
async function resolveRemovedEdgeBlast(
    edge: GraphEdgeSnapshot,
    targetUrn: string,
    addedEdge?: GraphEdgeSnapshot,
): Promise<GuardrailFinding | null> {
    try {
        const resolved = await resolveBlastResource(edge, targetUrn);
        const category = addedEdge ? 'renamed_dependency' : 'removed_dependency';

        if (!resolved) {
            return {
                severity: 'WARNING',
                category,
                title: `Blast unresolved: \`${edge.targetName}\` not found in graph`,
                whatChanged:
                    `\`${edge.sourceName}\` (in \`${edge.sourceFile}\`) ` +
                    `${addedEdge
                        ? `changes its target from \`${edge.targetName}\` to \`${addedEdge.targetName}\``
                        : `no longer ${formatRelAction(edge.relType)} \`${edge.targetName}\``}.`,
                rationale:
                    `The previous ${dependencyTitlePrefix(edge).toLowerCase()} target could not be resolved in the master graph. ` +
                    `Downstream impact may be under-reported; impact analysis was skipped.`,
                removedEdge: edge,
                ...(addedEdge ? { addedEdge } : {}),
                affectedServices: [],
            };
        }

        // Run the full blast radius analysis on the existing resource
        const blastResult = await analyzeBlast(resolved.urn);
        const downstreamConsumers = blastResult.downstreamBlasts;
        const prefix = dependencyTitlePrefix(edge);

        if (addedEdge && downstreamConsumers.length === 0) {
            return {
                severity: 'INFO',
                category: 'renamed_dependency',
                title: `${prefix} changed: \`${edge.targetName}\` -> \`${addedEdge.targetName}\``,
                whatChanged: formatRenameDiff(edge, addedEdge),
                rationale:
                    `The previous target (\`${edge.targetName}\`) resolved to \`${resolved.urn}\`. ` +
                    `No downstream services currently depend on it, so this change is safe.`,
                removedEdge: edge,
                addedEdge,
                affectedServices: [],
            };
        }

        if (downstreamConsumers.length === 0) {
            // Safe removal: nobody downstream depended on this edge
            return {
                severity: 'INFO',
                category: 'removed_dependency',
                title: `Safe removal: ${dependencyTitlePrefix(edge).toLowerCase()} \`${edge.targetName}\``,
                whatChanged: `\`${edge.sourceName}\` (in \`${edge.sourceFile}\`) no longer ${formatRelAction(edge.relType)} \`${edge.targetName}\`.`,
                rationale:
                    `No downstream services currently depend on this resource. ` +
                    `Removal will not break any consumers.`,
                removedEdge: edge,
                affectedServices: [],
            };
        }

        // DANGER: downstream consumers exist and will break
        const isColumn = isColumnEdge(edge);
        const dangerTitle = addedEdge
            ? isColumn
                ? `Column renamed: \`${edge.targetName}\` -> \`${addedEdge.targetName}\` impacts ${plural(downstreamConsumers.length, 'service')}`
                : `${prefix} changed: \`${edge.targetName}\` -> \`${addedEdge.targetName}\` impacts ${plural(downstreamConsumers.length, 'service')}`
            : `Breaking change: removing \`${edge.targetName}\` breaks ${plural(downstreamConsumers.length, 'consumer')}`;
        return {
            severity: 'DANGER',
            category: addedEdge ? 'renamed_dependency' : 'breaking_change',
            title: dangerTitle,
            whatChanged: addedEdge
                ? formatRenameDiff(edge, addedEdge)
                : `\`${edge.sourceName}\` (in \`${edge.sourceFile}\`) no longer ${formatRelAction(edge.relType)} \`${edge.targetName}\`.`,
            rationale: isColumn
                ? `Column \`${edge.targetName}\` is used by ${plural(downstreamConsumers.length, 'downstream service')} via the parent table. ` +
                  `Renaming it will break SQL reads/writes that reference the old column name.`
                : `${addedEdge ? 'The previous target' : 'The target'} \`${edge.targetName}\` ` +
                  `is consumed by ${plural(downstreamConsumers.length, 'downstream service')}. ` +
                  `Removing or changing it will break ${breakageVerb(edge.targetType)} in those consumers.`,
            removedEdge: edge,
            ...(addedEdge ? { addedEdge } : {}),
            affectedServices: affectedServicesFromBlast(blastResult),
        };
    } catch (err) {
        logger.debug(`[BlastRadius] Failed to resolve impact for ${targetUrn}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Resolve the orphan producer check for a single added edge.
 *
 * Queries: "Does the target resource already have consumers in the master graph?"
 * Returns WARNING if the resource is new and has no listeners, INFO otherwise.
 */
async function resolveAddedEdgeOrphan(
    edge: GraphEdgeSnapshot,
    targetUrn: string,
): Promise<GuardrailFinding | null> {
    // Only relevant for PUBLISHES_TO / PRODUCES relationships: adding a listener
    // is always safe, it's adding a producer to a potentially unheard queue that
    // creates orphan resources.
    if (!PRODUCER_REL_TYPES.has(edge.relType)) {
        return {
            severity: 'INFO',
            category: 'new_dependency',
            title: `New dependency: ${formatRelAction(edge.relType)} \`${edge.targetName}\``,
            whatChanged: `\`${edge.sourceName}\` (in \`${edge.sourceFile}\`) now ${formatRelAction(edge.relType)} \`${edge.targetName}\`.`,
            rationale: `Consumer edges (read, consume, call) are typically safe. This adds a new outbound dependency.`,
            addedEdge: edge,
        };
    }

    try {
        const existing = await resolveBlastResource(edge, targetUrn);

        if (!existing) {
            return {
                severity: 'WARNING',
                category: 'orphan_producer',
                title: `Orphan producer: \`${edge.targetName}\` has no consumers`,
                whatChanged: `\`${edge.sourceName}\` (in \`${edge.sourceFile}\`) now ${formatRelAction(edge.relType)} \`${edge.targetName}\`.`,
                rationale:
                    `CodeRadius detects no existing resource in the master graph that matches this target. ` +
                    `If the consumer has not yet been deployed or discovered, this message may go unhandled.`,
                addedEdge: edge,
                affectedServices: [],
            };
        }

        // Resource exists: run impact analysis to see who's already listening
        const blastResult = await analyzeBlast(existing.urn);
        const existingConsumers = blastResult.downstreamBlasts;

        if (existingConsumers.length === 0) {
            return {
                severity: 'WARNING',
                category: 'orphan_producer',
                title: `Orphan producer: \`${edge.targetName}\` has no consumers`,
                whatChanged: `\`${edge.sourceName}\` (in \`${edge.sourceFile}\`) now ${formatRelAction(edge.relType)} \`${edge.targetName}\`.`,
                rationale:
                    `The resource exists in the graph but no service currently consumes it. ` +
                    `This message or task may go unhandled if the consumer has not yet been implemented.`,
                addedEdge: edge,
                affectedServices: [],
            };
        }

        // Resource has consumers: this is a safe addition
        return {
            severity: 'INFO',
            category: 'new_dependency',
            title: `New producer: \`${edge.targetName}\` (${plural(existingConsumers.length, 'existing consumer')})`,
            whatChanged: `\`${edge.sourceName}\` (in \`${edge.sourceFile}\`) now ${formatRelAction(edge.relType)} \`${edge.targetName}\`.`,
            rationale:
                `The target already has ${plural(existingConsumers.length, 'existing consumer')}. ` +
                `Adding a new producer to an already-consumed resource is typically safe.`,
            addedEdge: edge,
            affectedServices: affectedServicesFromBlast(blastResult),
        };
    } catch (err) {
        logger.debug(`[BlastRadius] Failed to resolve orphan check for ${targetUrn}: ${(err as Error).message}`);
        return null;
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface BlastRadiusResolution {
    findings: GuardrailFinding[];
    blastRadiusScore: number;
}

/**
 * Resolve the full blast radius of a GraphDelta by querying the Memgraph
 * master graph (read-only).
 *
 * For each removed edge: checks for downstream consumers (DANGER if found).
 * For each added producer edge: checks for orphan resources (WARNING if none).
 *
 * Returns an ordered list of GuardrailFindings sorted DANGER → WARNING → INFO.
 */
export async function resolveBlastRadius(delta: GraphDelta): Promise<BlastRadiusResolution> {
    const findings: GuardrailFinding[] = [];

    // ── Deduplicate by targetId: one impact query per resource ──────────
    const removedByTarget = getRemovedEdgesByTarget(delta);
    const addedByTarget = getAddedEdgesByTarget(delta);
    const { pairs: renamePairs, pairedRemovedKeys, pairedAddedKeys } = findRenamePairs(delta);

    // Table-rename cascades captured by the differ — used below to enrich
    // the surviving MAPS_TO rename finding with the inherited column list
    // and to suppress redundant orphan WARNINGs on the new-side table.
    const cascadeByNewTable = new Map<string, { oldTable: string; newTable: string; columns: string[] }>();
    const cascadeByOldTable = new Map<string, { oldTable: string; newTable: string; columns: string[] }>();
    for (const cascade of delta.tableRenameCascades ?? []) {
        cascadeByNewTable.set(cascade.newTable, cascade);
        cascadeByOldTable.set(cascade.oldTable, cascade);
    }

    // ── Resolve renamed edges first to avoid removed+added duplicate noise ─
    for (const pair of renamePairs) {
        logger.debug(`[BlastRadius] Checking renamed resource: ${pair.removed.targetId} -> ${pair.added.targetId}`);
        const finding = await resolveRemovedEdgeBlast(pair.removed, pair.removed.targetId, pair.added);
        if (finding) {
            enrichTableRenameFinding(finding, pair.removed, cascadeByOldTable);
            findings.push(finding);
        }
    }

    // ── Resolve removed edges (breaking change check) ─────────────────────
    for (const [targetUrn, edges] of removedByTarget) {
        const unpairedEdges = edges.filter(edge => !pairedRemovedKeys.has(edgeInstanceKey(edge)));
        if (unpairedEdges.length === 0) continue;

        logger.debug(`[BlastRadius] Checking removed resource: ${targetUrn}`);
        // Use the first representative edge for the finding (most descriptive)
        const representativeEdge = unpairedEdges[0];
        const finding = await resolveRemovedEdgeBlast(representativeEdge, targetUrn);
        if (finding) findings.push(finding);
    }

    // ── Resolve added edges (orphan producer check) ───────────────────────
    for (const [targetUrn, edges] of addedByTarget) {
        const unpairedEdges = edges.filter(edge => !pairedAddedKeys.has(edgeInstanceKey(edge)));
        if (unpairedEdges.length === 0) continue;

        // Skip if this resource is ALSO being removed (renamed resource, already covered)
        if (removedByTarget.has(targetUrn)) continue;

        // Skip orphan check when the target is the new-side of a table rename:
        // the cascade-suppression has already collapsed the cascade into the
        // MAPS_TO rename finding, and an orphan WARNING here would re-amplify
        // the same noise we just dropped.
        const representativeEdge = unpairedEdges[0];
        if (representativeEdge.targetType === 'DataContainer'
            && cascadeByNewTable.has(representativeEdge.targetName.toLowerCase())) {
            continue;
        }

        logger.debug(`[BlastRadius] Checking added resource: ${targetUrn}`);
        const finding = await resolveAddedEdgeOrphan(representativeEdge, targetUrn);
        if (finding) findings.push(finding);
    }

    // ── Sort: DANGER first, then WARNING, then INFO ───────────────────────
    const severityOrder: Record<string, number> = { DANGER: 0, WARNING: 1, INFO: 2 };
    findings.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

    // ── Compute composite blast radius score ──────────────────────────────
    const blastRadiusScore = findings.reduce((sum, f) => {
        const affectedCount = f.affectedServices?.length ?? 0;
        if (f.severity === 'DANGER') return sum + (affectedCount * 2 + 1);
        if (f.severity === 'WARNING') return sum + 1;
        return sum;
    }, 0);

    return { findings, blastRadiusScore };
}

/**
 * Append `(N columns inherited: a, b, c, ...)` to a table-rename finding so
 * the reader sees the consolidated impact of the cascade without per-column
 * spam. Mutates the finding in place.
 */
function enrichTableRenameFinding(
    finding: GuardrailFinding,
    removed: GraphEdgeSnapshot,
    cascadeByOldTable: Map<string, { oldTable: string; newTable: string; columns: string[] }>,
): void {
    if (finding.category !== 'renamed_dependency') return;
    if (removed.relType !== 'MAPS_TO' || removed.targetType !== 'DataContainer') return;
    const cascade = cascadeByOldTable.get(removed.targetName.toLowerCase());
    if (!cascade) return;
    const columnList = cascade.columns.length > 0 ? cascade.columns.join(', ') : '(none detected)';
    const suffix = `\n(${cascade.columns.length} columns inherited: ${columnList})`;
    finding.whatChanged = `${finding.whatChanged}${suffix}`;
}
