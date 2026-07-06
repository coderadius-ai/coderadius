/**
 * Architecture Doc Enrichment — Application Service
 *
 * Orchestrates the "Enriched Context" pipeline for doc generation:
 *   1. Extract service topology from the graph
 *   2. Run blast-radius analysis for the target service
 *   3. Run global gravity analysis, filter for entries relevant to this service
 *   4. Assemble an EnrichedDocContext for the LLM
 *
 * UI-agnostic: the CLI `doc generate` command delegates to this module.
 */

import { getServiceTopology } from '../mutations/search.js';
import { resolveResource, analyzeBlast } from '../queries/blast.js';
import { analyzeGravity } from './gravity.service.js';
import type { ServiceTopology, GravityNodeSummary, BlastAnalysisResult } from '../types.js';

// ─── Public DTOs ─────────────────────────────────────────────────────────────

export interface RiskMetrics {
    blastRadiusScore: number;
    /** Where the blastRadiusScore was derived from */
    scoreSource: 'blast' | 'gravity' | 'composite';
    downstreamServicesImpacted: number;
    upstreamServicesImpacted: number;
    crossTeamBlast: boolean;
    teamsInvolved: string[];
    isServiceBottleneck: GravityNodeSummary | undefined;
    upstreamBottlenecks: GravityNodeSummary[];
    criticalDataDependencies: GravityNodeSummary[];
    dataConfidence: 'high' | 'low';
}

export interface EnrichedDocContext {
    topology: ServiceTopology;
    riskMetrics: RiskMetrics | null;
}

export interface CrossServiceEdge {
    from: string;
    to: string;
    mechanism: 'API' | 'Queue' | 'SharedDB' | 'DirectCall';
    resource: string;
}

export interface MultiServiceDocContext {
    services: EnrichedDocContext[];
    crossServiceEdges: CrossServiceEdge[];
}

// ─── Application Service ─────────────────────────────────────────────────────

/**
 * Build the enriched context for a service, combining topology with risk metrics.
 *
 * @param serviceName - Name of the service to document
 * @param options.skipRisk - If true, skip the risk analysis (returns riskMetrics: null)
 * @returns EnrichedDocContext ready for LLM consumption
 */
export async function buildEnrichedDocContext(
    serviceName: string,
    options?: { skipRisk?: boolean },
): Promise<EnrichedDocContext> {
    // 1. Extract topology (always required)
    const topology = await getServiceTopology(serviceName);

    if (options?.skipRisk) {
        return { topology, riskMetrics: null };
    }

    // 2. Run blast-radius + gravity in parallel
    let blastResult: BlastAnalysisResult | null = null;
    let gravityResult: Awaited<ReturnType<typeof analyzeGravity>> | null = null;

    try {
        // Resolve service URN for impact analysis
        const matches = await resolveResource(serviceName);
        const serviceMatch = matches.find(m => m.type === 'Service');

        const [blast, gravity] = await Promise.all([
            serviceMatch ? analyzeBlast(serviceMatch.urn) : Promise.resolve(null),
            analyzeGravity({ limit: 10000 }),
        ]);

        blastResult = blast;
        gravityResult = gravity;
    } catch (err) {
        // Graceful degradation: if risk queries fail, return topology with empty risk metrics
        const riskMetrics: RiskMetrics = {
            blastRadiusScore: 0,
            scoreSource: 'blast',
            downstreamServicesImpacted: 0,
            upstreamServicesImpacted: 0,
            crossTeamBlast: false,
            teamsInvolved: [],
            isServiceBottleneck: undefined,
            upstreamBottlenecks: [],
            criticalDataDependencies: [],
            dataConfidence: 'low',
        };
        return { topology, riskMetrics };
    }

    // 3. Filter gravity data for entries relevant to this service
    const outboundResourceNames = new Set(
        topology.outbound.map(dep => dep.logicalResource.toLowerCase()),
    );

    const criticalDataDependencies = gravityResult
        ? gravityResult.dataMonoliths.filter(db =>
            outboundResourceNames.has(db.name.toLowerCase()),
        )
        : [];

    // Check if this service is itself a bottleneck
    const isServiceBottleneck = gravityResult?.serviceBottlenecks.find(
        b => b.name.toLowerCase() === serviceName.toLowerCase(),
    );

    // Check if services we depend on are bottlenecks (upstream SPOF risk)
    const outboundServiceNames = new Set(
        topology.inbound
            .map(dep => dep.externalService.toLowerCase())
            .concat(topology.outbound
                .filter(dep => dep.resourceType === 'Service')
                .map(dep => dep.logicalResource.toLowerCase()),
            ),
    );

    const upstreamBottlenecks = gravityResult
        ? gravityResult.serviceBottlenecks.filter(b =>
            outboundServiceNames.has(b.name.toLowerCase()),
        )
        : [];

    // 4. Compute data confidence
    const hasTeamData = (blastResult && blastResult.summary.teamsInvolved.length > 0)
        || (upstreamBottlenecks.some(b => b.teams.length > 0))
        || (criticalDataDependencies.some(d => d.teams.length > 0));

    const dataConfidence: 'high' | 'low' = hasTeamData ? 'high' : 'low';

    // 5. Assemble risk metrics with composite scoring
    //    The impact query is designed for resource nodes (DataContainer, MessageChannel).
    //    When targeting a Service, it often returns score 0. In that case, derive
    //    a meaningful score from gravity data (critical data dependencies + bottleneck).
    const blastScore = blastResult?.summary.blastRadiusScore ?? 0;

    // Gravity-derived score: max SPOF score of critical dependencies + bottleneck score
    const maxDataDepScore = criticalDataDependencies.length > 0
        ? Math.max(...criticalDataDependencies.map(d => d.spofScore))
        : 0;
    const bottleneckScore = isServiceBottleneck?.spofScore ?? 0;
    const gravityDerivedScore = Math.max(maxDataDepScore, bottleneckScore);

    // Use the higher of impact vs gravity, but track the source
    let blastRadiusScore: number;
    let scoreSource: RiskMetrics['scoreSource'];

    if (blastScore > 0 && gravityDerivedScore > 0) {
        blastRadiusScore = Math.max(blastScore, gravityDerivedScore);
        scoreSource = 'composite';
    } else if (gravityDerivedScore > 0) {
        blastRadiusScore = gravityDerivedScore;
        scoreSource = 'gravity';
    } else {
        blastRadiusScore = blastScore;
        scoreSource = 'blast';
    }

    // Also derive cross-team from gravity when impact has no data
    const gravityCrossTeam = criticalDataDependencies.some(d => d.distinctTeamsCount > 1);
    const gravityTeams = [...new Set(criticalDataDependencies.flatMap(d => d.teams))].sort();

    const riskMetrics: RiskMetrics = {
        blastRadiusScore,
        scoreSource,
        downstreamServicesImpacted: blastResult?.downstreamBlasts.length ?? 0,
        upstreamServicesImpacted: blastResult?.upstreamBlasts.length ?? 0,
        crossTeamBlast: (blastResult?.summary.factors.crossTeamBlast ?? false) || gravityCrossTeam,
        teamsInvolved: (blastResult?.summary.teamsInvolved?.length ?? 0) > 0
            ? blastResult!.summary.teamsInvolved
            : gravityTeams,
        isServiceBottleneck,
        upstreamBottlenecks,
        criticalDataDependencies,
        dataConfidence,
    };

    return { topology, riskMetrics };
}

/**
 * Build a multi-service document context by enriching each service
 * individually and then deriving cross-service edges from the topology.
 */
export async function buildMultiServiceDocContext(
    serviceNames: string[],
    options?: { skipRisk?: boolean },
): Promise<MultiServiceDocContext> {
    const services = await Promise.all(
        serviceNames.map(name => buildEnrichedDocContext(name, options)),
    );

    const nameSet = new Set(serviceNames.map(n => n.toLowerCase()));
    const crossServiceEdges: CrossServiceEdge[] = [];
    const seen = new Set<string>();

    for (const svc of services) {
        const svcName = svc.topology.serviceName;

        for (const dep of svc.topology.inbound) {
            if (!nameSet.has(dep.externalService.toLowerCase())) continue;
            const mechanism = dep.relationship === 'SHARED_RESOURCE' ? 'SharedDB' : 'DirectCall';
            const key = `${dep.externalService}→${svcName}:${mechanism}:${dep.sharedResource ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            crossServiceEdges.push({
                from: dep.externalService,
                to: svcName,
                mechanism,
                resource: dep.sharedResource ?? dep.externalFunction,
            });
        }

        for (const dep of svc.topology.outbound) {
            if (dep.resourceType === 'MessageChannel') {
                for (const other of services) {
                    if (other.topology.serviceName === svcName) continue;
                    const listens = other.topology.outbound.some(
                        o => o.resourceType === 'MessageChannel' && o.logicalResource === dep.logicalResource,
                    ) || other.topology.inbound.some(
                        i => i.sharedResource === dep.logicalResource,
                    );
                    if (!listens) continue;
                    const key = `${svcName}→${other.topology.serviceName}:Queue:${dep.logicalResource}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    crossServiceEdges.push({
                        from: svcName,
                        to: other.topology.serviceName,
                        mechanism: 'Queue',
                        resource: dep.logicalResource,
                    });
                }
            }
        }

        for (const ep of svc.topology.exposedEndpoints) {
            for (const other of services) {
                if (other.topology.serviceName === svcName) continue;
                const calls = other.topology.inbound.some(
                    i => i.externalService === svcName && i.relationship === 'CALLS',
                );
                if (!calls) continue;
                const key = `${other.topology.serviceName}→${svcName}:API:${ep.method} ${ep.path}`;
                if (seen.has(key)) continue;
                seen.add(key);
                crossServiceEdges.push({
                    from: other.topology.serviceName,
                    to: svcName,
                    mechanism: 'API',
                    resource: `${ep.method} ${ep.path}`,
                });
            }
        }
    }

    return { services, crossServiceEdges };
}
