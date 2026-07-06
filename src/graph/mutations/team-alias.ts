/**
 * Team Alias Resolution — Graph Mutations
 *
 * Manages AI-proposed team identity aliases. When approved, materializes
 * [:OWNS] edges between the canonical Team and orphan Repositories/Services,
 * so all existing read queries (teamNameExpr) work without modification.
 *
 * CRITICAL: `reapplyApprovedAliases()` must run on every ingestion to catch
 * new repos that appear under an already-approved phantom org prefix.
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamAliasProposal {
    phantomName: string;
    canonicalTeam: string;
    confidence: number;
    reasoning: string;
    status: string;
    affectedRepos: number;
}

// ─── Internal: Edge Materialization ──────────────────────────────────────────

/**
 * Materialize [:OWNS] edges for a single approved alias.
 * Finds orphan Repositories and Services under the phantom org prefix
 * and links them to the canonical Team.
 *
 * Idempotent: MERGE ensures no duplicate edges are created.
 */
async function materializeOwnershipEdges(
    aliasUrn: string,
    phantomName: string,
): Promise<{ reposLinked: number; servicesLinked: number }> {
    // Materialize OWNS edges on orphan Repositories
    const repoResult = await run(
        `MATCH (a:TeamAlias {id: $urn})-[:PROPOSED_ALIAS_OF]->(t:Team)
         MATCH (r:Repository)-[:BELONGS_TO]->(org:Organization)
         WHERE org.fullPath = $phantomName
           AND NOT EXISTS { MATCH (:Team)-[:OWNS]->(r) }
         MERGE (t)-[rel:OWNS]->(r)
         ON CREATE SET rel.source = 'alias_resolver',
                       rel.valid_from_commit = 'SYSTEM'
         RETURN count(r) AS linked`,
        { urn: aliasUrn, phantomName },
    );
    const reposLinked = Number(repoResult.records[0]?.get('linked') ?? 0);

    // Materialize OWNS edges on orphan Services stored in those repos
    const svcResult = await run(
        `MATCH (a:TeamAlias {id: $urn})-[:PROPOSED_ALIAS_OF]->(t:Team)
         MATCH (r:Repository)-[:BELONGS_TO]->(org:Organization)
         WHERE org.fullPath = $phantomName
         MATCH (svc:Service)-[:STORED_IN]->(r)
         WHERE NOT EXISTS { MATCH (:Team)-[:OWNS]->(svc) }
         MERGE (t)-[rel:OWNS]->(svc)
         ON CREATE SET rel.source = 'alias_resolver',
                       rel.valid_from_commit = 'SYSTEM'
         RETURN count(svc) AS linked`,
        { urn: aliasUrn, phantomName },
    );
    const servicesLinked = Number(svcResult.records[0]?.get('linked') ?? 0);

    return { reposLinked, servicesLinked };
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Persist an AI-proposed team alias.
 * Creates a TeamAlias node with status='pending' and a [:PROPOSED_ALIAS_OF] edge
 * pointing to the canonical Team. No ownership edges are created at this stage.
 */
export async function mergeTeamAlias(
    phantomName: string,
    canonicalTeamName: string,
    confidence: number,    // legacy numeric confidence; mapped to quality tier below
    reasoning: string,
) {
    const urn = buildUrn('teamalias', phantomName);
    const canonicalUrn = buildUrn('team', canonicalTeamName);
    // Team alias is proposed by the LLM team-alias resolver. Map the legacy
    // numeric confidence into a categorical quality tier:
    //   >= 0.9 → high ; >= 0.6 → medium ; < 0.6 → low
    const quality = confidence >= 0.9 ? 'high' as const : confidence >= 0.6 ? 'medium' as const : 'low' as const;
    const prov = {
        source: 'llm' as const,
        quality,
        evidence: {
            extractors: ['team-alias-resolver@v1'],
            llmCalls: [{ model: 'unified-analyzer', promptHash: 'team-alias@v1', timestamp: new Date().toISOString() }],
        },
    };
    const commitHash = 'SYSTEM';
    await run(
        `MATCH (t:Team {id: $canonicalUrn})
         MERGE (a:TeamAlias {id: $urn})
         ON CREATE SET a.phantomName = $phantomName,
                       a.reasoning = $reasoning,
                       a.status = 'pending',
                       a.proposedAt = $now
         ${groundingWriteClause('a')}
         MERGE (a)-[:PROPOSED_ALIAS_OF]->(t)`,
        { urn, canonicalUrn, phantomName, reasoning, now: new Date().toISOString(), ...groundingParams(prov, commitHash) },
    );
}

/**
 * Approve a team alias and materialize ownership edges.
 *
 * This is the critical mutation: it creates physical [:OWNS {source: 'alias_resolver'}]
 * edges between the canonical Team and all orphan Repositories whose org prefix
 * matches the phantom name. After this, teamNameExpr() resolves them automatically
 * via the existing OWNS traversal — zero changes to read queries.
 */
export async function approveTeamAlias(phantomName: string): Promise<{
    reposLinked: number;
    servicesLinked: number;
}> {
    const urn = buildUrn('teamalias', phantomName);

    // Step 1: Update status
    await run(
        `MATCH (a:TeamAlias {id: $urn})
         SET a.status = 'approved', a.resolvedAt = $now`,
        { urn, now: new Date().toISOString() },
    );

    // Step 2: Materialize OWNS edges
    return materializeOwnershipEdges(urn, phantomName);
}

/**
 * Reject a team alias proposal. No ownership edges are created.
 */
export async function rejectTeamAlias(phantomName: string) {
    const urn = buildUrn('teamalias', phantomName);
    await run(
        `MATCH (a:TeamAlias {id: $urn})
         SET a.status = 'rejected', a.resolvedAt = $now`,
        { urn, now: new Date().toISOString() },
    );
}

/**
 * Re-apply all approved aliases to catch new orphan repos/services.
 *
 * This MUST run on every ingestion. Without it, new repos appearing under
 * an already-approved phantom org prefix (e.g. a new `frontend-v2` repo
 * under org `fe-squad` after `fe-squad` was already approved) would remain
 * orphaned forever — the LLM proposal step skips known aliases, and the
 * approve step already ran in the past.
 *
 * This is the "Day-2 fix": it ensures materialized edges are a living
 * projection, not a one-shot snapshot.
 */
export async function reapplyApprovedAliases(): Promise<{
    totalReposLinked: number;
    totalServicesLinked: number;
    aliasesProcessed: number;
}> {
    // Find all approved aliases
    const result = await run(
        `MATCH (a:TeamAlias {status: 'approved'})
         RETURN a.id AS urn, a.phantomName AS phantomName`,
    );

    let totalReposLinked = 0;
    let totalServicesLinked = 0;

    for (const rec of result.records) {
        const urn = rec.get('urn') as string;
        const phantomName = rec.get('phantomName') as string;
        const { reposLinked, servicesLinked } = await materializeOwnershipEdges(urn, phantomName);
        totalReposLinked += reposLinked;
        totalServicesLinked += servicesLinked;
    }

    return {
        totalReposLinked,
        totalServicesLinked,
        aliasesProcessed: result.records.length,
    };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Fetch all team alias proposals with their affected repo counts.
 * Used by the CLI (`cr team-alias list`) and dashboard Governance Alerts.
 */
export async function queryTeamAliasProposals(): Promise<TeamAliasProposal[]> {
    const result = await run(
        `MATCH (a:TeamAlias)-[:PROPOSED_ALIAS_OF]->(t:Team)
         OPTIONAL MATCH (r:Repository)-[:BELONGS_TO]->(org:Organization)
         WHERE org.fullPath = a.phantomName
         WITH a, t.name AS canonicalTeam, count(DISTINCT r) AS affectedRepos
         RETURN a.phantomName AS phantomName,
                canonicalTeam,
                a.confidence AS confidence,
                a.reasoning AS reasoning,
                a.status AS status,
                affectedRepos
         ORDER BY a.status, a.confidence DESC`,
    );
    return result.records.map(rec => ({
        phantomName:   rec.get('phantomName') as string,
        canonicalTeam: rec.get('canonicalTeam') as string,
        confidence:    Number(rec.get('confidence')),
        reasoning:     rec.get('reasoning') as string,
        status:        rec.get('status') as string,
        affectedRepos: Number(rec.get('affectedRepos')),
    }));
}
