import { getMemgraphSession } from '../neo4j.js';
import { RESOURCE_LABELS, labelCaseExpr } from '../domain.js';
import { GravityNodeSummarySchema, type GravityNodeSummary } from '../types.js';

/**
 * Helper to calculate SPOF score.
 * Formula prioritizes cross-team coupling and write contention:
 * spofScore = min(100, (distinctServices × 10) + (distinctTeams × 20) + (writeCount × 8) + (readCount × 3))
 *
 * Writes are weighted higher (×8) because concurrent writes create contention risk.
 * Reads are weighted lower (×3) but non-zero because they create coupling risk.
 */
function calculateSpofScore(distinctServices: number, distinctTeams: number, writeCount: number, readCount: number = 0): number {
    // We compute a raw risk factor where 10 is moderate, 20 is high, 30+ is massive.
    // Services and distinct Teams are the primary drivers of cross-team coupling.
    // Writes create contention/locks, Reads create read-only coupling (less severe).
    const rawScore = (distinctServices * 2.0) + (distinctTeams * 3.0) + (writeCount * 1.5) + (readCount * 0.5);
    
    // We map the raw score asymptotically to 100 using a curve:
    // math: 100 * (1 - e^(-raw / 15))
    // 
    // Examples (Services, Teams, Writes, Reads):
    // - 2, 2, 5, 4 => raw: 4 + 6 + 7.5 + 2 = 19.5 => score 72 (High)
    // - 3, 3, 4, 3 => raw: 6 + 9 + 6 + 1.5 = 22.5 => score 77 (High)
    // - 4, 3, 10, 10 => raw: 8 + 9 + 15 + 5 = 37 => score 91 (Critical)
    // - 10, 5, 30, 50 => raw: 20 + 15 + 45 + 25 = 105 => score 99 (Max SPOF)
    const curveDivisor = 15;
    const score = 100 * (1 - Math.exp(-rawScore / curveDivisor));
    
    return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Analyzes Data Gravity (Top Data Monoliths).
 * Targets DataContainer, Datastore, MessageChannel.
 * Ranks them by the SPOF Score calculation.
 */
export async function analyzeDataGravity(limit: number = 10): Promise<GravityNodeSummary[]> {
    const session = getMemgraphSession();
    try {
        const caseExpr = labelCaseExpr();

        const result = await session.run(`
            MATCH (n) WHERE (n:DataContainer OR n:Datastore OR n:MessageChannel) AND n.valid_to_commit IS NULL
            
            OPTIONAL MATCH (n)<-[rel]-(f:Function)<-[r2:CONTAINS]-(s:Service)
            WHERE rel.valid_to_commit IS NULL AND f.valid_to_commit IS NULL AND r2.valid_to_commit IS NULL AND s.valid_to_commit IS NULL
              AND type(rel) IN ['READS', 'WRITES', 'MAPS_TO', 'PUBLISHES_TO', 'CONSUMES', 'LISTENS_TO', 'CONNECTS_TO']

            // Repo each impacted Service belongs to (for monorepo-aware UI qualification)
            OPTIONAL MATCH (s)-[rs_si:STORED_IN]->(srepo:Repository)
            WHERE rs_si.valid_to_commit IS NULL AND srepo.valid_to_commit IS NULL

            // Runtime Gravity: count DeploymentUnit facets per impacted Service
            OPTIONAL MATCH (s)-[r_du:DEPLOYED_AS]->(du:DeploymentUnit)
            WHERE r_du.valid_to_commit IS NULL AND du.valid_to_commit IS NULL

            WITH n, s, srepo, du,
                 sum(CASE WHEN type(rel) IN ['WRITES', 'PUBLISHES_TO'] THEN 1 ELSE 0 END) AS serviceWriteCount,
                 sum(CASE WHEN type(rel) IN ['READS', 'CONSUMES', 'LISTENS_TO', 'CONNECTS_TO', 'MAPS_TO'] THEN 1 ELSE 0 END) AS serviceReadCount

            OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE t.valid_to_commit IS NULL AND r_owns.valid_to_commit IS NULL

            WITH n,
                 count(DISTINCT s) AS distinctServicesCount,
                 count(DISTINCT t) AS distinctTeamsCount,
                 collect(DISTINCT t.name) AS teams,
                 sum(serviceWriteCount) AS writeAccessCount,
                 sum(serviceReadCount) AS readAccessCount,
                 count(DISTINCT du) AS runtimeImpactedDUs,
                 collect(DISTINCT CASE WHEN serviceWriteCount > 0 THEN { name: s.name, repoName: srepo.name, context: s.context, count: serviceWriteCount } END) AS writeServices,
                 collect(DISTINCT CASE WHEN serviceReadCount > 0 THEN { name: s.name, repoName: srepo.name, context: s.context, count: serviceReadCount } END) AS readServices
            
            WHERE distinctServicesCount > 1
            
            RETURN n.id AS urn, n.name AS name, CASE ${caseExpr} END AS type, distinctServicesCount, distinctTeamsCount, writeAccessCount, readAccessCount, runtimeImpactedDUs, teams, writeServices, readServices, n.technology AS technology, n.discovery_source AS discoverySource
        `);

        // Compute scores and sort in memory (scales fine since result set is relatively small, usually < 1000 nodes, 
        // and we only return the top N). We do this in TS because of the custom weighted formula.
        const nodes = result.records.map((r: any): GravityNodeSummary => {
            const distinctServicesCount = r.get('distinctServicesCount').toNumber();
            const distinctTeamsCount = r.get('distinctTeamsCount').toNumber();
            const writeAccessCount = r.get('writeAccessCount').toNumber();
            const readAccessCount = r.get('readAccessCount').toNumber();

            const spofScore = calculateSpofScore(distinctServicesCount, distinctTeamsCount, writeAccessCount, readAccessCount);

            const runtimeImpactedDUs = r.get('runtimeImpactedDUs').toNumber();

            return GravityNodeSummarySchema.parse({
                urn: r.get('urn'),
                name: r.get('name') ?? 'Unknown',
                type: r.get('type') ?? 'Unknown',
                spofScore,
                distinctServicesCount,
                distinctTeamsCount,
                writeAccessCount,
                readAccessCount,
                teams: r.get('teams').filter(Boolean),
                writeServices: r.get('writeServices').filter(Boolean).map((s: any) => ({ ...s, count: s.count && typeof s.count.toNumber === 'function' ? s.count.toNumber() : s.count })),
                readServices: r.get('readServices').filter(Boolean).map((s: any) => ({ ...s, count: s.count && typeof s.count.toNumber === 'function' ? s.count.toNumber() : s.count })),
                repository: null,
                technology: r.get('technology') || null,
                discoverySource: r.get('discoverySource') || null,
                runtimeImpactedDUs: runtimeImpactedDUs > 0 ? runtimeImpactedDUs : undefined,
            });
        });

        nodes.sort((a, b) => b.spofScore - a.spofScore);

        return nodes.slice(0, limit);
    } finally {
        await session.close();
    }
}

/**
 * Analyzes Service Bottlenecks.
 * Targets Service nodes, evaluating how many other distinct services depend on them directly or indirectly.
 */
export async function analyzeServiceBottlenecks(limit: number = 10): Promise<GravityNodeSummary[]> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(`
            MATCH (target:Service) WHERE target.valid_to_commit IS NULL
            
            OPTIONAL MATCH (depService:Service)-[r_c1:CONTAINS]->(f:Function)
            WHERE depService.valid_to_commit IS NULL AND r_c1.valid_to_commit IS NULL AND f.valid_to_commit IS NULL AND depService <> target

            OPTIONAL MATCH (f)-[rel1:CALLS|COMMUNICATES_WITH]->(targetFunc:Function)<-[r_c2:CONTAINS]-(target)
            WHERE rel1.valid_to_commit IS NULL AND targetFunc.valid_to_commit IS NULL AND r_c2.valid_to_commit IS NULL

            OPTIONAL MATCH (f)-[r_c4:CALLS]->(ep:APIEndpoint)<-[r_c5:HAS_ENDPOINT]-(api:APIInterface)<-[r_c6:EXPOSES_API]-(target)
            WHERE r_c4.valid_to_commit IS NULL AND ep.valid_to_commit IS NULL AND r_c5.valid_to_commit IS NULL AND api.valid_to_commit IS NULL AND r_c6.valid_to_commit IS NULL

            OPTIONAL MATCH (f)-[r_c9:READS|WRITES|MAPS_TO|PUBLISHES_TO|LISTENS_TO]->(shared)<-[r_c8:READS|WRITES|MAPS_TO|PUBLISHES_TO|LISTENS_TO]-(tf:Function)<-[r_c7:CONTAINS]-(target)
            WHERE r_c9.valid_to_commit IS NULL AND shared.valid_to_commit IS NULL AND r_c8.valid_to_commit IS NULL AND tf.valid_to_commit IS NULL AND r_c7.valid_to_commit IS NULL AND (shared:DataContainer OR shared:MessageChannel)

            WITH target, depService, f,
                 CASE WHEN rel1 IS NOT NULL OR r_c4 IS NOT NULL OR r_c9 IS NOT NULL THEN 1 ELSE 0 END AS depends

            WHERE depends = 1

            // Runtime Gravity: count DeploymentUnit facets of dependent services
            OPTIONAL MATCH (depService)-[r_du:DEPLOYED_AS]->(du:DeploymentUnit)
            WHERE r_du.valid_to_commit IS NULL AND du.valid_to_commit IS NULL

            WITH target, depService, count(DISTINCT f) AS serviceFuncCount, count(DISTINCT du) AS depDuCount

            OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(depService) WHERE t.valid_to_commit IS NULL AND r_owns.valid_to_commit IS NULL

            // Repo of the dependent service (monorepo-aware UI qualification)
            OPTIONAL MATCH (depService)-[r_dep_si:STORED_IN]->(depRepo:Repository)
            WHERE r_dep_si.valid_to_commit IS NULL AND depRepo.valid_to_commit IS NULL

            WITH target,
                 count(DISTINCT depService) AS distinctServicesCount,
                 count(DISTINCT t) AS distinctTeamsCount,
                 collect(DISTINCT t.name) AS teams,
                 sum(depDuCount) AS runtimeImpactedDUs,
                 collect(DISTINCT CASE WHEN serviceFuncCount > 0 THEN { name: depService.name, repoName: depRepo.name, context: depService.context, count: serviceFuncCount } END) AS dependentServices

            WHERE distinctServicesCount > 0

            OPTIONAL MATCH (target)-[r_stored:STORED_IN]->(repo:Repository) WHERE r_stored.valid_to_commit IS NULL AND repo.valid_to_commit IS NULL

            RETURN target.id AS urn, target.name AS name, distinctServicesCount, distinctTeamsCount, teams, runtimeImpactedDUs, dependentServices, repo.name AS repoName, repo.url AS repoUrl
        `);

        // Compute scores and sort
        const nodes = result.records.map((r: any): GravityNodeSummary => {
            const distinctServicesCount = r.get('distinctServicesCount').toNumber();
            const distinctTeamsCount = r.get('distinctTeamsCount').toNumber();

            // Service bottlenecks usually don't have "writeAccessCount" in the same sense as databases,
            // we treat dependency as purely structural for bottlenecks, so write=0.
            const spofScore = calculateSpofScore(distinctServicesCount, distinctTeamsCount, 0);

            const runtimeImpactedDUs = r.get('runtimeImpactedDUs').toNumber();

            return GravityNodeSummarySchema.parse({
                urn: r.get('urn'),
                name: r.get('name') ?? 'Unknown',
                type: 'Service',
                spofScore,
                distinctServicesCount,
                distinctTeamsCount,
                writeAccessCount: 0,
                readAccessCount: 0,
                teams: r.get('teams').filter(Boolean),
                dependentServices: r.get('dependentServices').filter(Boolean).map((s: any) => ({ ...s, count: s.count && typeof s.count.toNumber === 'function' ? s.count.toNumber() : s.count })),
                repository: r.get('repoName') ? { name: r.get('repoName'), url: r.get('repoUrl') ?? null } : null,
                runtimeImpactedDUs: runtimeImpactedDUs > 0 ? runtimeImpactedDUs : undefined,
            });
        });

        nodes.sort((a, b) => b.spofScore - a.spofScore);

        return nodes.slice(0, limit);
    } finally {
        await session.close();
    }
}
