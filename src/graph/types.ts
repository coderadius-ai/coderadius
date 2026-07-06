import { z } from 'zod';

// ─── Generic Graph Result Wrappers ───────────────────────────────────────────

export const GraphNodeSchema = z.object({
    id: z.string(),
    labels: z.array(z.string()),
    properties: z.record(z.string(), z.unknown()),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
    source: z.string(),
    target: z.string(),
    type: z.string(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// ─── Backstage Catalog Entity ────────────────────────────────────────────────

export const BackstageCatalogEntitySchema = z.object({
    apiVersion: z.string().optional(),
    kind: z.string(),
    metadata: z.object({
        name: z.string(),
        namespace: z.string().optional(),
        description: z.string().optional().nullable(),
        labels: z.record(z.string(), z.string()).optional(),
        tags: z.array(z.string()).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
        links: z.array(z.object({
            url: z.string(),
            title: z.string().optional(),
            icon: z.string().optional(),
            type: z.string().optional(),
        })).optional(),
    }),
    spec: z.object({
        type: z.string().optional(),
        lifecycle: z.string().optional(),
        owner: z.string().optional(),
        system: z.string().optional(),
        domain: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        partOf: z.array(z.string()).optional(),
        providesApis: z.array(z.string()).optional(),
        consumesApis: z.array(z.string()).optional(),
    }).passthrough().optional(),
});
export type BackstageCatalogEntity = z.infer<typeof BackstageCatalogEntitySchema>;

// ─── Code Chunk (from parser) ────────────────────────────────────────────────

export const CodeChunkSchema = z.object({
    name: z.string(),
    filepath: z.string(),
    sourceCode: z.string(),
    language: z.enum(['typescript', 'php', 'go', 'python', 'java']),
    startLine: z.number(),
    startColumn: z.number(),
    endLine: z.number(),
    endColumn: z.number(),
    envVars: z.array(z.string()).optional(),
    /**
     * When true the chunk name cannot be guaranteed unique within its file
     * (e.g. anonymous callbacks, call-argument-derived names like
     * "forEach_callback" or "it_does X" that can repeat in the same file).
     * The static analyzer uses this to add a start-position suffix to the
     * function URN so different chunks with the same name remain distinct.
     *
     * Set by language plugins at chunk-extraction time — NOT inferred from
     * name patterns in urn.ts (which must stay language-agnostic).
     */
    nameIsAmbiguous: z.boolean().optional(),
    /**
     * Enclosing class name when the chunk is a method or anonymous inner
     * function declared inside a class body. Set by language plugins at
     * chunk-extraction time. Used by Gate 5 (Repository convention) so that
     * anonymous arrow-fields inside a Repository class — whose chunk name
     * cannot match the verb whitelist — still inherit the class signal.
     */
    parentClassName: z.string().optional(),
});
export type CodeChunk = z.infer<typeof CodeChunkSchema>;

// ─── Resolved Repo (from source resolver) ────────────────────────────────────

export const ResolvedRepoSchema = z.object({
    name: z.string(),
    path: z.string(),
    origin: z.enum(['local', 'remote']),
    remoteUrl: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    // Git org/group namespace (e.g. 'acme/payments'). Identity-only: feeds the
    // URN namespace via getQualifiedRepoName() and the BELONGS_TO -> Organization
    // edge. Never stored as a node property (r.org does not exist in the graph).
    org: z.string().optional(),
    cachePath: z.string().optional(),
    // Liveness signal — raw 12-month no-merges commit count. The discrete
    // tier is derived on read by `tierFromCommits()` in
    // `@coderadius/shared-types/liveness`. Populated only when git history
    // is available (pull strategy).
    livenessCommits: z.number().optional(),
    // Branch topology & hosting platform — populated by git-metadata extractor
    /** The canonical default branch name (main, master, etc.) */
    defaultBranch: z.string().optional(),
    /** Core branches detected via ls-remote: main, master, develop, release/*, hotfix/*, etc. */
    coreBranches: z.array(z.string()).optional(),
    /** SCM hosting platform: github | gitlab | bitbucket | azure-devops | unknown */
    hostingPlatform: z.string().optional(),
    /** Commit-message convention compliance (ticket-ID + Conventional Commits) — populated by git-convention-extractor.
     *  Signal for change traceability and AI-agent context quality: ticket-prefixed and
     *  Conventional-Commit subjects link diffs back to issue tracker and tool-readable types,
     *  which agents leverage to understand change rationale during downstream automation. */
    gitConventions: z.object({
        ticketIdRate: z.number(),
        conventionalCommitRate: z.number(),
        sampleSize: z.number(),
    }).optional(),
});
export type ResolvedRepo = z.infer<typeof ResolvedRepoSchema>;

// ─── Topology Result ─────────────────────────────────────────────────────────

export interface TopologyNode {
    id: string;
    labels: string[];
    properties: Record<string, unknown>;
}

export interface TopologyEdge {
    source: string;
    target: string;
    type: string;
    properties: Record<string, unknown>;
}

export interface TopologyResult {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
}

export interface VectorSearchResult {
    id: string;
    name: string;
    filepath: string;
    intent: string;
    score: number;
}

// ─── Service Topology (Doc Generator) ────────────────────────────────────────

export interface ServiceTopologyFunction {
    id: string;
    name: string;
    filepath: string;
    intent: string | null;
}

export interface OutboundDependency {
    functionName: string;
    logicalResource: string;
    physicalResource: string | null;
    resourceType: string;
}

export interface InboundConsumer {
    externalService: string;
    externalFunction: string;
    relationship: string;
    sharedResource: string | null;
}

export interface ExposedEndpoint {
    method: string;
    path: string;
    operationId: string | null;
    summary: string | null;
    /** URN of the canonical APIEndpoint node (OpenAPI-sourced when available) */
    urn: string;
    /** Title of the parent APIInterface (e.g. OpenAPI spec title) */
    apiTitle: string | null;
}

export interface ServiceTopology {
    serviceName: string;
    functions: ServiceTopologyFunction[];
    outbound: OutboundDependency[];
    inbound: InboundConsumer[];
    /** HTTP/gRPC/GraphQL endpoints exposed by this service */
    exposedEndpoints: ExposedEndpoint[];
}

// ─── Blast Analysis DTOs (Query Layer) ───────────────────────────────────────

export const ResolvedResourceSchema = z.object({
    urn: z.string(),
    name: z.string(),
    type: z.string(),
    context: z.string().nullable().optional(),
});
export type ResolvedResource = z.infer<typeof ResolvedResourceSchema>;

export const BlastedFunctionSchema = z.object({
    name: z.string(),
    file: z.string().nullable(),
});
export type BlastedFunction = z.infer<typeof BlastedFunctionSchema>;

export const BlastedServiceSchema = z.object({
    serviceName: z.string(),
    serviceUrn: z.string(),
    teamOwner: z.string().nullable(),
    relationships: z.array(z.string()),
    functions: z.array(BlastedFunctionSchema),
    repository: z.object({ name: z.string(), url: z.string().nullable() }).nullable(),
});
export type BlastedService = z.infer<typeof BlastedServiceSchema>;

export const BlastRadiusFactorsSchema = z.object({
    downstreamServices: z.number(),
    upstreamServices: z.number(),
    crossTeamBlast: z.boolean(),
    teamsInvolved: z.number(),
    hasWriteDependencies: z.boolean(),
});
export type BlastRadiusFactors = z.infer<typeof BlastRadiusFactorsSchema>;

export const BlastSummarySchema = z.object({
    blastRadiusScore: z.number(),
    factors: BlastRadiusFactorsSchema,
    teamsInvolved: z.array(z.string()),
});
export type BlastSummary = z.infer<typeof BlastSummarySchema>;

export const BlastAnalysisResultSchema = z.object({
    target: z.object({ urn: z.string(), name: z.string(), type: z.string() }),
    downstreamBlasts: z.array(BlastedServiceSchema),
    upstreamBlasts: z.array(BlastedServiceSchema),
    summary: BlastSummarySchema,
});
export type BlastAnalysisResult = z.infer<typeof BlastAnalysisResultSchema>;

// ─── Data Lineage DTOs (Query Layer) ─────────────────────────────────────────

export const ResolvedDataFieldSchema = z.object({
    urn: z.string(),
    name: z.string(),
    structureName: z.string(),
    structureUrn: z.string(),
    serviceName: z.string().nullable(),
});
export type ResolvedDataField = z.infer<typeof ResolvedDataFieldSchema>;

export const BridgeResourceSchema = z.object({
    name: z.string().nullable(),  // Nullable for defensive downstream handling
    type: z.string(), // MessageChannel | APIEndpoint | DataContainer | SystemProcess
});
export type BridgeResource = z.infer<typeof BridgeResourceSchema>;

export const LineageStepSchema = z.object({
    serviceName: z.string(),
    serviceUrn: z.string().nullable(),
    teamOwner: z.string().nullable(),
    /**
     * Stable function URN (Phase 2). Required to batch field-access queries
     * across the journey in a single round-trip.
     */
    functionId: z.string(),
    functionName: z.string(),
    action: z.string(),           // PRODUCES | CONSUMES
    bridgeResource: BridgeResourceSchema.nullable(),
    structureName: z.string().nullable(),
    repository: z.object({ name: z.string(), url: z.string().nullable() }).nullable(),
    /**
     * Field-level contract participation for this step's function (Phase 2/3).
     * Semantics: "produced by / consumed by" — NOT real field access.
     */
    contractFields: z.array(z.object({
        fieldName: z.string(),
        participation: z.enum(['PRODUCES_FIELD', 'CONSUMES_FIELD']),
    })).optional(),
});
export type LineageStep = z.infer<typeof LineageStepSchema>;

export const LineageAnalysisResultSchema = z.object({
    targetField: z.object({ urn: z.string(), name: z.string(), structure: z.string() }),
    journey: z.array(LineageStepSchema),
    summary: z.object({
        servicesTraversed: z.number(),
        totalHops: z.number(),
        requiresDeepScan: z.boolean(),
    }),
});
export type LineageAnalysisResult = z.infer<typeof LineageAnalysisResultSchema>;

// ─── Gravity & SPOF Analysis DTOs (Query Layer) ──────────────────────────────

export const GravityServiceRefSchema = z.object({
    name: z.string(),
    /** Repo name for monorepo-aware UI qualification. */
    repoName: z.string().nullable().optional(),
    /** Pre-computed display qualifier (e.g. "acme"). UI may override using repoName. */
    context: z.string().nullable().optional(),
    count: z.number().optional(),
});
export type GravityServiceRef = z.infer<typeof GravityServiceRefSchema>;

export const GravityNodeSummarySchema = z.object({
    urn: z.string(),
    name: z.string(),
    type: z.string(),
    spofScore: z.number(),
    distinctServicesCount: z.number(),
    distinctTeamsCount: z.number(),
    writeAccessCount: z.number(),
    readAccessCount: z.number(),
    teams: z.array(z.string()),
    writeServices: z.array(GravityServiceRefSchema).optional(),
    readServices: z.array(GravityServiceRefSchema).optional(),
    dependentServices: z.array(GravityServiceRefSchema).optional(),
    repository: z.object({ name: z.string(), url: z.string().nullable() }).nullable().optional(),
    technology: z.string().nullable().optional(),
    discoverySource: z.string().nullable().optional(),
    /** Runtime Gravity: total DeploymentUnit facets across all impacted Services that would stop functioning */
    runtimeImpactedDUs: z.number().optional(),
});
export type GravityNodeSummary = z.infer<typeof GravityNodeSummarySchema>;

export const GravityAnalysisResultSchema = z.object({
    dataMonoliths: z.array(GravityNodeSummarySchema),
    serviceBottlenecks: z.array(GravityNodeSummarySchema),
    summary: z.object({
        analyzedAt: z.string(),
        totalNodesScanned: z.number(),
    }),
});
export type GravityAnalysisResult = z.infer<typeof GravityAnalysisResultSchema>;
