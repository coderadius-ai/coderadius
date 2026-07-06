/**
 * Blast Analysis Query Service
 *
 * Single source of truth for blast radius Cypher queries.
 * Both the CLI (`cr blast`) and the MCP server
 * (`analyze_blast_radius` tool) delegate to this module.
 */

import { getMemgraphSession } from '../neo4j.js';
import { RESOURCE_LABELS, labelCaseExpr } from '../domain.js';
import { DOWNSTREAM_RELS_BLAST, UPSTREAM_RELS_BLAST } from '../constants.js';
import { CR_SCHEME } from '../urn.js';
import {
    ResolvedResourceSchema,
    BlastAnalysisResultSchema,
    type ResolvedResource,
    type BlastAnalysisResult,
    type BlastedService,
    type BlastedFunction,
} from '../types.js';

// ─── Label filter clause ─────────────────────────────────────────────────────
const LABEL_FILTER = '(' + RESOURCE_LABELS.map(l => `n:${l}`).join(' OR ') + ` OR n:Service) AND n.id STARTS WITH "${CR_SCHEME}"`;

/**
 * Resolve a resource by name or URN using a 3-tier strategy:
 *   1. Exact URN match (if input starts with 'cr:')
 *   2. Exact name match (case-insensitive)
 *   3. Fuzzy CONTAINS fallback (partial name match)
 *
 * Also matches APIEndpoint.path for inputs like '/claims/submit'.
 */
export async function resolveResource(nameOrUrn: string): Promise<ResolvedResource[]> {
    const session = getMemgraphSession();
    try {
        const caseExpr = labelCaseExpr();

        // Context enrichment: join parent nodes per type for disambiguation
        const contextClause = `
             OPTIONAL MATCH (n)-[rc:STORED_IN]->(repo:Repository) WHERE rc.valid_to_commit IS NULL AND repo.valid_to_commit IS NULL AND n:Service
             OPTIONAL MATCH (n)-[rd:STORED_IN]->(ds:Datastore) WHERE rd.valid_to_commit IS NULL AND ds.valid_to_commit IS NULL AND n:DataContainer
             OPTIONAL MATCH (api:APIInterface)-[rh:HAS_ENDPOINT]->(n) WHERE rh.valid_to_commit IS NULL AND api.valid_to_commit IS NULL AND n:APIEndpoint
             OPTIONAL MATCH (exposer:Service)-[impl:IMPLEMENTS_ENDPOINT]->(n) WHERE impl.valid_to_commit IS NULL AND exposer.valid_to_commit IS NULL AND n:APIEndpoint
             WITH n, CASE ${caseExpr} END AS type,
                  collect(DISTINCT COALESCE(COALESCE(repo.url, repo.name), ds.name, exposer.name, api.title)) AS contexts`;
        const returnClause = `RETURN n.id AS urn, COALESCE(n.name, n.path) AS name, type, contexts`;

        // Tier 1: Exact URN match
        if (nameOrUrn.startsWith(CR_SCHEME)) {
            const result = await session.run(
                `MATCH (n) WHERE n.id = $param AND (${LABEL_FILTER}) AND n.valid_to_commit IS NULL
                 ${contextClause}
                 ${returnClause}`,
                { param: nameOrUrn },
            );
            return result.records.map((r: any) => {
                const contexts = r.get('contexts') as string[];
                const context = contexts && contexts.length > 0 ? contexts.join(', ') : undefined;
                return ResolvedResourceSchema.parse({ urn: r.get('urn'), name: r.get('name'), type: r.get('type'), context });
            });
        }

        // Tier 2: Exact name match (case-insensitive) + APIEndpoint path match
        const exactResult = await session.run(
            `MATCH (n) WHERE (toLower(n.name) = toLower($param) OR (n:APIEndpoint AND n.path = $param)) AND (${LABEL_FILTER}) AND n.valid_to_commit IS NULL
             ${contextClause}
             ${returnClause}`,
            { param: nameOrUrn },
        );

        if (exactResult.records.length > 0) {
            return exactResult.records.map((r: any) => {
                const contexts = r.get('contexts') as string[];
                const context = contexts && contexts.length > 0 ? contexts.join(', ') : undefined;
                return ResolvedResourceSchema.parse({ urn: r.get('urn'), name: r.get('name'), type: r.get('type'), context });
            });
        }

        // Tier 3: Fuzzy CONTAINS fallback (partial name match)
        // If param is empty, we are feeding the interactive search autocomplete.
        // We set a high limit (10000) so client-side filtering works on the whole graph.
        const limitStr = nameOrUrn ? 'LIMIT 20' : 'LIMIT 10000';
        const fuzzyResult = await session.run(
            `MATCH (n) WHERE (toLower(n.name) CONTAINS toLower($param) OR (n:APIEndpoint AND toLower(n.path) CONTAINS toLower($param))) AND (${LABEL_FILTER}) AND n.valid_to_commit IS NULL
             ${contextClause}
             ${returnClause}
             ${limitStr}`,
            { param: nameOrUrn },
        );

        return fuzzyResult.records.map((r: any) => {
            const contexts = r.get('contexts') as string[];
            const context = contexts && contexts.length > 0 ? contexts.join(', ') : undefined;
            return ResolvedResourceSchema.parse({ urn: r.get('urn'), name: r.get('name'), type: r.get('type'), context });
        });
    } finally {
        await session.close();
    }
}

/**
 * Analyze the single-hop blast radius for a resolved resource URN.
 * Returns downstream consumers, upstream producers, and an aggregated summary.
 */
export async function analyzeBlast(urn: string): Promise<BlastAnalysisResult> {
    const session = getMemgraphSession();
    try {
        const caseExpr = labelCaseExpr();

        // 1. Resolve target metadata
        const targetResult = await session.run(
            `MATCH (n {id: $urn}) WHERE n.valid_to_commit IS NULL RETURN COALESCE(n.name, n.path) AS name, CASE ${caseExpr} END AS type`,
            { urn },
        );

        if (targetResult.records.length === 0) {
            throw new Error(`Resource with URN ${urn} not found.`);
        }

        const targetName = targetResult.records[0].get('name');
        const targetType = targetResult.records[0].get('type');

        // 2. Downstream consumers (Who depends on this resource?)
        const downstreamResult = await session.run(
            `MATCH (resource {id: $urn}) WHERE resource.valid_to_commit IS NULL
             OPTIONAL MATCH (resource)-[r_contains:CONTAINS]->(f:Function) WHERE r_contains.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
             WITH collect(DISTINCT f) + [resource] AS nodes, $urn AS targetUrn
             UNWIND nodes AS startNode
             MATCH (startNode)<-[rel]-(consumer)
             WHERE type(rel) IN $downstreamRels AND rel.valid_to_commit IS NULL AND consumer.valid_to_commit IS NULL
             
             // Identify the impacted service
             OPTIONAL MATCH (consumer)<-[r_s1:CONTAINS]-(s1:Service) WHERE r_s1.valid_to_commit IS NULL AND s1.valid_to_commit IS NULL
             WITH consumer, s1, rel, COALESCE(s1, CASE WHEN consumer:Service OR consumer:Package THEN consumer END) AS s, targetUrn
             WHERE s IS NOT NULL AND s.id <> targetUrn

             // Get repository context
             OPTIONAL MATCH (s)-[r_stored:STORED_IN]->(repo:Repository) WHERE r_stored.valid_to_commit IS NULL AND repo.valid_to_commit IS NULL

             // Get details
             WITH s, repo, collect(DISTINCT type(rel)) AS relationships, 
                  collect(DISTINCT CASE WHEN consumer:Function THEN {name: consumer.name, file: consumer.filepath} ELSE NULL END) AS functions
             OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL AND s.valid_to_commit IS NULL
             RETURN DISTINCT s.name AS serviceName, s.id AS serviceUrn, t.name AS teamOwner, relationships, functions,
                    repo.name AS repoName, repo.url AS repoUrl
             ORDER BY serviceName`,
            { urn, downstreamRels: [...DOWNSTREAM_RELS_BLAST] },
        );

        const downstreamBlasts: BlastedService[] = downstreamResult.records.map((r: any) => ({
            serviceName: r.get('serviceName'),
            serviceUrn: r.get('serviceUrn'),
            teamOwner: r.get('teamOwner'),
            relationships: r.get('relationships'),
            functions: (r.get('functions') as Array<{ name: string; file: string | null }>),
            repository: r.get('repoName') ? { name: r.get('repoName'), url: r.get('repoUrl') ?? null } : null,
        }));

        // 3. Upstream producers (Who does this resource depend on?)
        //    Uses two explicit directional patterns instead of startNode(rel)
        //    which is not supported in Memgraph.
        const upstreamResult = await session.run(
            `MATCH (resource {id: $urn}) WHERE resource.valid_to_commit IS NULL
             OPTIONAL MATCH (resource)-[r_contains:CONTAINS]->(f:Function) WHERE r_contains.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
             WITH collect(DISTINCT f) + [resource] AS nodes, $urn AS targetUrn
             UNWIND nodes AS n

             // Pattern A: Find providers that WRITE/PUBLISH into this resource
             OPTIONAL MATCH (n)<-[relA]-(providerA)
             WHERE type(relA) IN $rels AND relA.valid_to_commit IS NULL AND providerA.valid_to_commit IS NULL
             WITH targetUrn, n, collect(CASE WHEN providerA IS NOT NULL THEN [providerA, type(relA)] END) AS pairsA

             // Pattern B: Find targets that this resource CALLS or DEPENDS_ON outbound
             OPTIONAL MATCH (n)-[relB]->(providerB)
             WHERE type(relB) IN ['CALLS', 'COMMUNICATES_WITH', 'DEPENDS_ON'] AND relB.valid_to_commit IS NULL AND providerB.valid_to_commit IS NULL
             WITH targetUrn, n, pairsA, collect(CASE WHEN providerB IS NOT NULL THEN [providerB, type(relB)] END) AS pairsB

             // Merge both patterns into a unified provider set
             WITH targetUrn, pairsA + pairsB AS pairs
             UNWIND pairs AS pair
             WITH targetUrn, pair[0] AS provider, pair[1] AS relType

             // Identify the provider service
             OPTIONAL MATCH (provider)<-[r_s1_prov:CONTAINS]-(s1:Service) WHERE r_s1_prov.valid_to_commit IS NULL AND s1.valid_to_commit IS NULL
             WITH provider, s1, relType, COALESCE(s1, CASE WHEN provider:Service OR provider:Package THEN provider END) AS s, targetUrn
             WHERE s IS NOT NULL AND s.id <> targetUrn

             // Get repository context
             OPTIONAL MATCH (s)-[r_stored:STORED_IN]->(repo:Repository) WHERE r_stored.valid_to_commit IS NULL AND repo.valid_to_commit IS NULL

             WITH s, repo, collect(DISTINCT relType) AS relationships,
                  collect(DISTINCT CASE WHEN provider:Function THEN {name: provider.name, file: provider.filepath} ELSE NULL END) AS functions
             OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL AND s.valid_to_commit IS NULL
             RETURN DISTINCT s.name AS serviceName, s.id AS serviceUrn, t.name AS teamOwner, relationships, functions,
                    repo.name AS repoName, repo.url AS repoUrl
             ORDER BY serviceName`,
            { urn, rels: [...UPSTREAM_RELS_BLAST] },
        );

        const upstreamBlasts: BlastedService[] = upstreamResult.records.map((r: any) => ({
            serviceName: r.get('serviceName'),
            serviceUrn: r.get('serviceUrn'),
            teamOwner: r.get('teamOwner'),
            relationships: r.get('relationships'),
            functions: (r.get('functions') as Array<{ name: string; file: string | null }>),
            repository: r.get('repoName') ? { name: r.get('repoName'), url: r.get('repoUrl') ?? null } : null,
        }));

        // 4. Aggregate summary with composite scoring
        const allTeams = new Set<string>();
        const uniqueServices = new Set<string>();

        for (const impact of [...downstreamBlasts, ...upstreamBlasts]) {
            if (impact.teamOwner) allTeams.add(impact.teamOwner);
            uniqueServices.add(impact.serviceUrn);
        }

        const teamsInvolved = Array.from(allTeams).sort();
        const hasWriteDependencies = upstreamBlasts.length > 0;
        const crossTeamBlast = teamsInvolved.length > 1;

        const factors = {
            downstreamServices: downstreamBlasts.length,
            upstreamServices: upstreamBlasts.length,
            crossTeamBlast,
            teamsInvolved: teamsInvolved.length,
            hasWriteDependencies,
        };

        // Score = Downstream Gravity Score (degree-weighted, 2-hop)
        // Centralized calculation from topology.ts ensures MCP and Dashboard match exactly.
        const { getTopologyMap } = await import('./topology.js');
        const topology = await getTopologyMap();
        const blastRadiusScore = topology.nodes[urn]?.gravityScore ?? 0;

        // 5. Build and validate result via Zod
        return BlastAnalysisResultSchema.parse({
            target: { urn, name: targetName, type: targetType },
            downstreamBlasts,
            upstreamBlasts,
            summary: {
                blastRadiusScore,
                factors,
                teamsInvolved,
            },
        });
    } finally {
        await session.close();
    }
}
