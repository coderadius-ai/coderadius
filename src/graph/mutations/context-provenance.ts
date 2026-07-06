import { run } from './_run.js';
import { buildUrn, getQualifiedRepoName } from '../urn.js';
import { sanitizeOrg, mergeOrganization, linkRepositoryBelongsToOrg } from './organization.js';
import type { ContextProvenance } from '../../ingestion/core/source-resolver.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Context Provenance Mutations
//
// Persists IMPORTS_CONTEXT_FROM edges between Repository nodes.
// These edges capture how a repository imports AI context (rules, skills,
// workflows) from an external source — git submodules being the first
// supported mechanism.
//
// Design notes:
//   - Source Repository nodes use MERGE ON CREATE: if the source repo has
//     already been ingested as a full Repository, we only add the edge; if not,
//     we create a stub node that future ingestion will enrich.
//   - The Cypher is mechanism-agnostic: the `mechanism` property on the edge
//     discriminates the origin (git_submodule, npm_package, etc.).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Persist IMPORTS_CONTEXT_FROM edges from a consumer repository to its
 * declared context sources.
 *
 * Each entry in `provenance` produces one (idempotent) edge. The source
 * Repository node is created as a stub if it doesn't already exist so the
 * edge is always valid even when the source repo hasn't been ingested yet.
 *
 * @param qualifiedConsumerRepoName  Org-qualified name (e.g. "acme/docs/acme-platform")
 * @param provenance                 Array of ContextProvenance entries
 * @returns                          Number of edges created or updated
 */
export async function mergeContextProvenanceEdges(
    qualifiedConsumerRepoName: string,
    provenance: ContextProvenance[],
): Promise<number> {
    if (provenance.length === 0) return 0;

    const consumerUrn = buildUrn('repository', qualifiedConsumerRepoName);

    const entries = provenance.map(p => ({
        sourceName: p.sourceName,
        sourceUrn: buildUrn('repository', getQualifiedRepoName({ name: p.sourceName, org: p.sourceOrg })),
        sourceUri: p.sourceUri,
        sourceOrg: p.sourceOrg ?? null,
        mechanism: p.mechanism,
        mountPoint: p.mountPoint,
    }));

    const result = await run(
        `MATCH (consumer:Repository {id: $consumerUrn})
         UNWIND $entries AS entry
         MERGE (source:Repository {id: entry.sourceUrn})
           ON CREATE SET
             source.name = entry.sourceName,
             source.url  = entry.sourceUri
         MERGE (consumer)-[r:IMPORTS_CONTEXT_FROM]->(source)
         SET r.mechanism   = entry.mechanism,
             r.mountPoint  = entry.mountPoint,
             r.sourceUri   = entry.sourceUri,
             r.updatedAt   = datetime()
         RETURN count(r) AS edgesCreated`,
        { consumerUrn, entries },
    );

    // Org lives on the BELONGS_TO edge (not a property): build the hierarchy for
    // any source repo with a derivable org, mirroring mergeRepository.
    for (const entry of entries) {
        if (sanitizeOrg(entry.sourceOrg)) {
            await mergeOrganization(entry.sourceOrg!, 'SYSTEM');
            await linkRepositoryBelongsToOrg(entry.sourceUrn, entry.sourceOrg!, 'SYSTEM');
        }
    }

    const count = result.records[0]?.get('edgesCreated');
    return count !== undefined && count !== null ? Number(count) : 0;
}

/**
 * Remove AgenticConfig nodes that the LLM classified as non-agentic content.
 *
 * Called after LLM enrichment to prune false positives introduced by the
 * root-level *.md glob (knowledge_base catch-all matcher). The LLM acts as
 * the final filter in the "Filter Funnel":
 *   Glob → Regex/Exclusion-list → LLM (this prune step)
 *
 * Uses DETACH DELETE so all edges (HAS_AGENTIC_CONFIG, DEFINES) are also removed.
 *
 * @param nodeIds  URNs of AgenticConfig nodes to delete
 * @returns        Number of nodes deleted
 */
export async function pruneNonAgenticNodes(nodeIds: string[]): Promise<number> {
    if (nodeIds.length === 0) return 0;

    const result = await run(
        `UNWIND $nodeIds AS nodeId
         MATCH (ac:AgenticConfig {id: nodeId})
         DETACH DELETE ac
         RETURN count(ac) AS deleted`,
        { nodeIds },
    );

    const deleted = result.records[0]?.get('deleted');
    return deleted !== undefined && deleted !== null ? Number(deleted) : 0;
}
