/**
 * @coderadius/shared-types
 *
 * Pure domain DTOs shared between the CLI and the dashboard-ui.
 * This module is the API contract: it contains ZERO presentation logic.
 *
 * IMPORTANT: Types are re-declared here (not re-exported from CLI source)
 * to avoid pulling the CLI's transitive dependency tree into the frontend build.
 * Must be isomorphic (browser + server): no Node.js / Bun APIs.
 */

// Repository liveness (single source of truth for tier derivation).
// Backend writes only `livenessCommits` to the graph; UI and Cypher consumers
// derive the discrete tier via `tierFromCommits()`.
export {
    LIVENESS_THRESHOLDS,
    tierFromCommits,
    isActiveRepo,
} from './liveness.js';
export type { LivenessTier } from './liveness.js';

// Grounding ontology (single source of truth for source / quality enums
// and structural-family classification). Imported by both halves so a
// change here lands at compile time everywhere.
export {
    SOURCE_VALUES,
    QUALITY_VALUES,
    QUALITY_RANK,
    qualityAtLeast,
    isStructuralFamily,
} from './grounding.js';
export type {
    Source,
    Quality,
    LlmCallEvidence,
    Evidence,
    GroundingFields,
} from './grounding.js';

// Topology relationship vocabulary + blast tier classification (single source
// of truth for direction semantics, tier thresholds and the gauge mapping).
// Imported by both the backend (src/graph/constants.ts re-exports) and the
// dashboard (lib/topology.ts, lib/blastTier.ts) so they cannot drift.
export {
    DEPENDENCY_RELS,
    EMISSION_RELS,
    API_RELS,
    ARCH_RELS,
    DOWNSTREAM_RELS_BLAST,
    UPSTREAM_RELS_BLAST,
    BLAST_ARCH_LABELS,
    EMISSION_DIRECTION_RELS,
    PASSTHROUGH_TYPES,
    IMPL_EP_DISCOUNT,
    TIER_GRADES,
    TIER_THRESHOLDS,
    classifyTier,
    classifyGravityTier,
    normaliseToBar,
} from './topology-rels.js';
export type {
    GravityEvidence,
    GravityTierKey,
    BlastTierKey,
} from './topology-rels.js';

// ─── Agent Harness DTOs ─────────────────────────────────────────────────────

export interface MaturityRow {
    repoName: string;
    repoUrl: string | null;
    teamName: string;
    tools: string[];
    maturityLevel: number;     // 0–4
    maturityLabel: string;     // Dark / Aware / Configured / Skilled / Orchestrated
    configs: number;
    skills: number;
    workflows: number;
    subagents: number;
    ruleNames: string[];
    skillNames: string[];
    workflowNames: string[];
    subagentNames: string[];
    /** Raw 12-month no-merges commit count. null when no .git history. The
     *  discrete tier is derived on read via `tierFromCommits()` below. */
    livenessCommits: number | null;
}

export interface McpServerRow {
    serverName: string;
    repos: { name: string; url: string | null }[];
    teams: string[];
}

export interface DuplicateCluster {
    fingerprint: string;
    configType: string;
    description: string;
    instances: Array<{ repo: string; team: string; filePath: string }>;
}

export interface CapabilityCoverage {
    repo: string;
    team: string;
    coveredCapabilities: string[];
}

/** One distinct consumer of a capability: a service that has it installed,
 *  paired with its repo and owning team. Harness-dir copies within a service
 *  (`.agents` + `.claude`, symlinks) collapse to a single consumer. */
export interface CatalogConsumer {
    service: string;
    repo: string;
    repoUrl: string | null;
    team: string;
}

/** Where a skill was installed from (skills.lock provenance). Absent for
 *  hand-authored skills and for non-skill capabilities. */
export interface CatalogProvenance {
    source: string;           // e.g. "acme/agent-skills"
    url: string | null;       // full URL to the source repo
    type: string | null;      // "github" | "gitlab" | "local" | "well-known"
    installedAt: string | null;
    updatedAt: string | null;
}

export interface CapabilityEntry {
    name: string;
    type: string;
    description: string;
    filePath: string | null;
    repos: { name: string; url: string | null }[];
    teams: string[];
    capabilities: string[];
    /** Distinct consuming services (NOT physical file count). */
    usageCount: number;
    consumers: CatalogConsumer[];
    provenance?: CatalogProvenance;
}

export interface SemanticDuplicate {
    configIdA: string;
    serviceA: string;
    configA: string;
    configTypeA: string;
    filePathA: string;
    configIdB: string;
    serviceB: string;
    configB: string;
    configTypeB: string;
    filePathB: string;
    similarity: number;
    scope: 'same-service' | 'cross-service';
}

export interface TechBlindspot {
    technology: string;
    totalRepos: number;
    coveredRepos: number;
    uncoveredRepoNames: string[];
    coveragePct: number;
}

export interface SkillRecommendation {
    skillName: string;
    skillType: string;
    sourceTeam: string;
    sourceRepo: string;
    targetTeam: string;
    targetRepos: string[];
    sharedPackageCount: number;
}

export interface TeamAliasProposal {
    phantomName: string;
    canonicalTeam: string;
    confidence: number;
    reasoning: string;
    status: string;
    affectedRepos: number;
}

export interface SkillMemberView {
    configId: string;
    name: string;
    description: string;
    semanticIntent?: string;
    filePath: string;
    service: string;
    topics: string[];
    technologies: string[];
    peerSimilarity?: number;
    sourceUrl?: string;
    symlinkTarget?: string;
    installedVia?: string;
    contentFingerprint?: string;
}

export interface SkillDuplicateCluster {
    id: string;
    label: string;
    memberIds: string[];
    members: SkillMemberView[];
    size: number;
    similarity: { min: number; max: number; avg: number };
    services: string[];
    topics: string[];
    technologies: string[];
}

export interface SkillProjectionPoint {
    configId: string;
    x: number;
    y: number;
    clusterId: string | null;
}

export interface SkillDuplicatesView {
    clusters: SkillDuplicateCluster[];
    projection: SkillProjectionPoint[];
    threshold: number;
    totalSkills: number;
    totalCrossRepoClusters: number;
}

export interface AgentHarnessReport {
    matrix: MaturityRow[];
    mcpCensus: McpServerRow[];
    duplicates: DuplicateCluster[];
    capabilityCoverage: CapabilityCoverage[];
    catalog: CapabilityEntry[];
    semanticDuplicates: SemanticDuplicate[];
    techBlindspots: TechBlindspot[];
    skillRecommendations: SkillRecommendation[];
    teamAliasProposals: TeamAliasProposal[];
    skillDuplicates: SkillDuplicatesView;
}

// ─── Dependency Ecosystem DTOs ───────────────────────────────────────────────

export interface ReleaseEntry {
    version: string;
    publishedAt: string;
    confidence: string;
}

export interface DriftSummary {
    maxLevel: 'major' | 'minor' | 'patch' | 'none';
    consumersAtMajorDrift: number;
    consumersAtMinorDrift: number;
    consumersAtPatchDrift: number;
    consumersUpToDate: number;
}

export interface DepsVersionEntry {
    displayVersion: string;
    isLocked: boolean;
    isDev: boolean;
    /** How far behind this version is vs. latestPublished (pre-computed in CLI, avoids semver in frontend) */
    driftLevel?: 'major' | 'minor' | 'patch' | 'none';
    /** CVE IDs affecting this specific version (pre-computed in CLI from HAS_VULNERABILITY edges) */
    cveIds?: string[];
    consumers: {
        name: string;
        type: 'Service' | 'Library' | 'Repository';
        team: string | null;
        url: string | null;
        /** Repository name for service context disambiguation */
        repoName: string | null;
        requiredVersion: string;
        /** Commits in trailing 12 months (if available). Tier is derived via tierFromCommits(). */
        livenessCommits?: number | null;
    }[];
}

export interface DepsVulnerability {
    osvId: string;
    aliases?: string[];
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    summary?: string;
}

/** Display id for a vulnerability: prefer the CVE alias when present, else the OSV id (GHSA). */
export function resolveVulnerabilityDisplayId(vuln: DepsVulnerability): string {
    return vuln.aliases?.find(a => a.startsWith('CVE-')) ?? vuln.osvId;
}

export interface DepsPackageGroup {
    packageName: string;
    ecosystem: string;
    isInternal: boolean;
    versions: DepsVersionEntry[];
    totalConsumers: number;
    hasVersionSkew: boolean;
    latestPublished?: string;
    versionConfidence?: string;
    publishedBy?: string;
    publishedByUrl?: string;
    releaseHistory?: ReleaseEntry[];
    drift?: DriftSummary;
    vulnerabilities?: DepsVulnerability[];
}

export interface DepsReport {
    packages: DepsPackageGroup[];
    summary: {
        totalPackages: number;
        totalWithSkew: number;
        ecosystems: string[];
    };
}

// ─── Architecture Gravity DTOs ───────────────────────────────────────────────

export interface GravityServiceRef {
    name: string;
    /** Repo name for monorepo-aware UI qualification. */
    repoName?: string | null;
    /** Pre-computed display qualifier. UI re-derives from repoName when present. */
    context?: string | null;
    count?: number;
}

export interface GravityNodeSummary {
    urn: string;
    name: string;
    type: string;
    spofScore: number;
    distinctServicesCount: number;
    distinctTeamsCount: number;
    writeAccessCount: number;
    readAccessCount: number;
    teams: string[];
    writeServices?: GravityServiceRef[];
    readServices?: GravityServiceRef[];
    dependentServices?: GravityServiceRef[];
    repository: { name: string; url: string | null } | null;
    technology?: string | null;
    discoverySource?: string | null;
}

export interface GravityAnalysisResult {
    dataMonoliths: GravityNodeSummary[];
    serviceBottlenecks: GravityNodeSummary[];
    summary: {
        analyzedAt: string;
        totalNodesScanned: number;
    };
}

// ─── Blast Analysis DTOs ─────────────────────────────────────────────────────

export interface BlastedFunction {
    name: string;
    file: string | null;
}

export interface BlastedService {
    serviceName: string;
    serviceUrn: string;
    teamOwner: string | null;
    relationships: string[];
    functions: BlastedFunction[];
    repository: { name: string; url: string | null } | null;
}

export interface BlastRadiusFactors {
    downstreamServices: number;
    upstreamServices: number;
    crossTeamBlast: boolean;
    teamsInvolved: number;
    hasWriteDependencies: boolean;
}

export interface BlastSummary {
    blastRadiusScore: number;
    factors: BlastRadiusFactors;
    teamsInvolved: string[];
}

export interface BlastAnalysisResult {
    target: { urn: string; name: string; type: string };
    downstreamBlasts: BlastedService[];
    upstreamBlasts: BlastedService[];
    summary: BlastSummary;
}

// ─── Data Lineage DTOs ───────────────────────────────────────────────────────

export interface BridgeResource {
    name: string | null;
    type: string;
}

export interface LineageStep {
    serviceName: string;
    serviceUrn: string | null;
    teamOwner: string | null;
    /** Stable function URN (Phase 2). Required for batched field-access lookup. */
    functionId: string;
    functionName: string;
    action: string;
    bridgeResource: BridgeResource | null;
    structureName: string | null;
    repository: { name: string; url: string | null } | null;
    /**
     * Field-level contract participation for this step's function (Phase 2/3).
     * "Produced by / Consumed by" semantics, NOT real field access.
     */
    contractFields?: Array<{
        fieldName: string;
        participation: 'PRODUCES_FIELD' | 'CONSUMES_FIELD';
    }>;
}

export interface LineageAnalysisResult {
    targetField: { urn: string; name: string; structure: string };
    journey: LineageStep[];
    summary: {
        servicesTraversed: number;
        totalHops: number;
        requiresDeepScan: boolean;
    };
}

// ─── API Endpoint Classification ────────────────────────────────────────────
// Typed literal unions for APIEndpoint data model — used in graph, LLM, and UI.

/** API contract kind: what paradigm the endpoint implements. */
export type ApiKind = 'rest' | 'graphql' | 'grpc' | 'soap' | 'websocket' | 'sse';

/** HTTP verb — only meaningful when apiKind='rest'. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** GraphQL operation type — used when apiKind='graphql'. */
export type GqlOperation = 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';

/** How the endpoint was discovered / sourced. */
export type EndpointSource = 'openapi' | 'sdl' | 'proto' | 'code' | 'emergent';

// ─── Topology Skeleton ─────────────────────────────────────────────────────
// Lightweight adjacency map for client-side 1-hop impact lookup.
// Built by a single Cypher query at dashboard generation time.

/** Minimal node descriptor keyed by URN in the topology map */
export interface TopologyNode {
    /** Human-readable name (service name, table name, etc.) */
    name: string;
    /** Architectural type: 'Service' | 'DataTable' | 'MessageChannel' | ... */
    type: string;
    /** Long-form human description sourced from catalog (Backstage `description`
     *  or equivalent). Surfaced in NodeInspectorModal as a subtitle. */
    description?: string | null;
    /** Owning team name, if known */
    teamOwner?: string | null;
    /** Source repository, if known */
    repository?: { name: string; url: string | null; mainBranch?: string | null } | null;
    /** For MessageChannel nodes, indicates the messaging primitive: 'topic', 'queue', 'exchange', etc. */
    channelKind?: string | null;
    /** Free-form tags for SDK/framework identification (e.g. ['AcmeBusSDK']). */
    tags?: string[] | null;
    /** How this node was discovered: 'backstage', 'autodiscovery', 'code-analysis', 'crossplane', etc. */
    discoverySource?: string | null;
    /** Infrastructure technology: 'postgres', 'redis', 'kafka', 'rabbitmq', 'mongodb', etc. */
    technology?: string | null;
    /** Primary programming language. Set on Service nodes (e.g. 'typescript',
     *  'go', 'python'). Surfaces as a brand-coloured chip in the popover. */
    language?: string | null;
    /** Package ecosystem (`npm`, `composer`, `pypi`, `golang`, ...). Set on
     *  Package / Library nodes. Used by the graph card identity strip and
     *  the popover metadata grid. */
    ecosystem?: string | null;
    /** Physical infrastructure trace for DataContainers. An array because a
     *  single container can be STORED_IN more than one datastore: a conservative
     *  ambiguous bind (bindingReason 'ambiguous-multi-candidate', needsReview=true)
     *  links every candidate rather than guessing one. By convention [0] is the
     *  primary (first STORED_IN edge returned); the rest are co-candidates. */
    datastore?: Array<{ name: string; host?: string | null }> | null;
    /** API contract kind — only set for APIEndpoint nodes: 'rest', 'graphql', 'grpc', etc. */
    apiKind?: ApiKind | null;
    /** API spec-format discriminator for APIInterface nodes: 'openapi', 'sdl', 'code', 'env-var'. */
    apiSource?: string | null;
    /** API interface title (spec title for OAS/SDL, alias for env-var). */
    title?: string | null;
    /** Protocol-specific operation type. GQL: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION'. gRPC: 'UNARY'. Only set for APIEndpoint nodes. */
    operation?: string | null;
    /**
     * Pre-computed Downstream Gravity Score.
     * Measures "what breaks if this node dies" — weighted by the connectivity
     * (degree) of each downstream dependency. Feeds the T0–T4 tier classifier.
     * Calculated server-side during dashboard generation; the frontend only reads it.
     * See docs/architecture/impact-scoring.md for the formula.
     */
    gravityScore?: number;
    /**
     * Evidence backing `gravityScore`, stamped by the same engine pass.
     * `observed: false` means no real dependent was seen in the scanned graph
     * (no dependency in-edge, no Tier-2 transitive node, no consumed endpoint):
     * the score is the node's own write/publish footprint and the UI demotes
     * the tier chip to "T? Unverified" instead of a numeric T0-T4.
     * Absent on payloads generated before this field existed: never demote then.
     */
    gravityEvidence?: import('./topology-rels.js').GravityEvidence;
    /**
     * Analyser self-assessment of how sure we are that this node is real,
     * `0..1`. Surfaces in the UI as ambient border treatment (solid-bright /
     * solid-dim / dashed) and as a numeric "Confidence: 73%" line in the
     * popover. Same field returned by MCP tools.
     *
     * Conventions:
     *   - `≥ 0.75` = parsed from typed evidence (ORM annotations, OpenAPI specs,
     *     framework decorators) — "we're sure"
     *   - `0.45 ≤ x < 0.75` = inferred from multiple weaker signals — "probable"
     *   - `< 0.45` = LLM-only inference, treat with skepticism
     *   - `undefined` = legacy node that predates this field; UI treats as the
     *     mid-tier band (~0.6) so legacy graphs aren't visually punished.
     *
     * @deprecated Prefer `quality` (categorical tier from grounding model).
     */
    confidence?: number;
    /**
     * Grounding source (who produced the fact): 'ast' | 'heuristic' | 'llm' |
     * 'composite' | 'declared' | 'infra' | 'runtime'. Mirrors backend
     * `n.source`. Optional during the POC migration: older snapshots may
     * pre-date grounding and surface as `null`.
     */
    groundingSource?: string | null;
    /**
     * Grounding quality tier (categorical, not derived math): 'exact' |
     * 'high' | 'medium' | 'low' | 'speculative'. Mirrors backend `n.quality`.
     * Drives the QualityBadge colour and the "Verified only" filter chip.
     */
    quality?: string | null;
    /** Whether this node was flagged for human review (cr review pending). */
    needsReview?: boolean | null;
    /** Commit sha at which the fact was last reconciled against fresh code. */
    lastSeenCommit?: string | null;
    /** Names of the extractors that contributed to the fact (versioned, e.g.
     *  'symfony-messenger-php@v1'). Surfaces in the Provenance breakdown
     *  drawer section when populated. */
    evidence_extractors?: string[] | null;
    /** Heuristic fallbacks that fired during extraction (e.g.
     *  'env-var-stem-normalize'). The presence of any fallback demotes
     *  `quality` by one tier on the backend. */
    evidence_fallbacksApplied?: string[] | null;
    /** URNs of welded predecessors (cross-kind dedup, suffix dedup,
     *  class-name bridge). Populated on nodes created by a merge. */
    evidence_mergedFrom?: string[] | null;
    /** Count of LLM calls that contributed to / confirmed the fact. Opaque
     *  to the UI — only the integer is rendered, never the blob. */
    evidence_llmCallCount?: number | null;
}

/** Directed edge in the topology skeleton */
export interface TopologyEdge {
    /** URN of the source node (who owns this edge) */
    source: string;
    /** URN of the target node */
    target: string;
    /** Cypher relationship type: 'CALLS', 'WRITES', 'READS', ... */
    rel: string;
    /** Impacted functions (if applicable/available) */
    functions?: { name: string; file: string | null; startLine?: number | null }[];
    /**
     * Edge-level confidence (`0..1`) — same semantics as `TopologyNode.confidence`.
     * Drives the edge stroke opacity (and dashed treatment when very low) in
     * the graph view. `undefined` is treated as the mid-tier default.
     */
    confidence?: number;
    /**
     * For `STORED_IN` edges: explains how the DataContainer→Datastore binding
     * was resolved. One of 'sole-candidate', 'p0-yaml', 'llm-assignment',
     * 'env-canonical-default'. Surfaced as a chip on the drawer path leg so
     * the operator can tell whether the binding is grounded or inferred.
     */
    bindingReason?: string | null;
}

/**
 * A `DataStructure` shown in the side drawer.
 *
 * Attached to one of three node kinds:
 *   - `MessageChannel` via `HAS_SCHEMA` (event payload)
 *   - `DataContainer`  via name-match on `DataStructure {type:'database_table'}` (table columns)
 *   - `APIEndpoint`    via the implementing `Function`'s `PRODUCES`/`CONSUMES` (request / response)
 *
 * The `role` field disambiguates the direction for APIEndpoint payloads.
 */
export interface TopologySchema {
    /** Human-readable schema name (e.g. 'save', 'quotedBundleV2') */
    name: string;
    /** Schema format: 'avro', 'json-schema', 'protobuf' */
    format?: string | null;
    /** Repo-relative paths to the schema source files (e.g. ['schemas/save.avsc']) */
    sourcePaths?: string[];
    /** SCM repository URL defining the schema */
    repoUrl?: string | null;
    /** Main branch of the repository (e.g. 'main', 'master') */
    mainBranch?: string | null;
    /** Schema fields with optional type annotations and required constraints */
    fields: { name: string; type?: string | null; required?: boolean | null }[];
    /** Role qualifier for endpoint payloads — 'request' (CONSUMES) or 'response' (PRODUCES). */
    role?: 'request' | 'response' | 'table' | 'event' | null;
}

/**
 * In-memory adjacency map injected into the dashboard HTML.
 * - `nodes`: all architectural nodes keyed by URN
 * - `out[urn]`:  edges leaving `urn` (what `urn` depends on  → upstream providers)
 * - `in[urn]`:   edges entering `urn` (who depends on `urn` → downstream consumers)
 * - `schemas`:   data schemas keyed by node URN (MessageChannel / DataContainer / APIEndpoint).
 *                Always an array — APIEndpoints commonly have both a request and a response.
 *
 * 1-hop lookup is O(1): upstream = out[urn], downstream = in[urn].
 * No BFS needed for MVP. Multi-hop can be layered on top in Phase 2.
 */
export interface TopologyMap {
    nodes: Record<string, TopologyNode>;
    out: Record<string, TopologyEdge[]>;
    in: Record<string, TopologyEdge[]>;
    schemas?: Record<string, TopologySchema[]>;
    /** Graph-wide coverage signal — surfaced in the blast radius banner to
     *  indicate that gravity scores are lower bounds when not all repos are scanned. */
    coverage?: {
        /** Repos with at least 'semantic' scan depth */
        scannedRepos: number;
        /** Total known repos (Backstage catalog + autodiscovery) */
        totalKnownRepos?: number;
    };
}

// ─── System Registry (Inventory) DTOs ────────────────────────────────────────

export interface InventoryRepo {
    name: string;
    url: string | null;
    org: string | null;
    repoHash: string | null;
    services: string[];
    fileCount: number;
    functionCount: number;
    teams: string[];
    languages: string[];
    /** Inferred ingestion depth: 'contracts' (data contract extraction), 'semantic' (code analysis), 'structure' (structural only) */
    ingestionLevel: 'contracts' | 'semantic' | 'structure';
    /** Git branch at time of last ingestion */
    branch: string | null;
    /** The canonical default branch (main, master) — detected via git metadata probing */
    defaultBranch: string | null;
    /** Core branches (main, master, develop, release/*, hotfix/*) — structural governance data */
    coreBranches: string[];
    /** SCM hosting platform: github | gitlab | bitbucket | azure-devops | unknown */
    hostingPlatform: string | null;
    /** Liveness pulse — raw 12-month commit count from the Repository node. */
    livenessCommits: number | null;
    /** ISO UTC timestamp of the last successful analysis/cache validation. */
    lastAnalyzedAt: string | null;
    /** Structural governance nodes */
    ciPipelines?: Array<{ tool: string; filePath: string; hasTestStage: boolean; hasDeployStage: boolean; jobCount: number }>;
    dockerImages?: Array<{ imageTag: string | null; filePath: string }>;
    toolConfigs?: Array<{ toolType: string; filePath: string }>;
    tasks?: Array<{ name: string; runner: string | null }>;
}

export interface InventoryService {
    /** Canonical `cr:service:{repo}:{name}` URN. Used to deep-link into the Blast Radius Explorer. */
    urn: string;
    name: string;
    team: string | null;
    languages: string[];
    repository: { name: string | null; url: string | null };
    indexedFunctionCount: number;
    exposedEndpointCount: number;
    dependencyCount: number;
}

export interface InventoryTeam {
    name: string;
    teamType: string | null;
    serviceCount: number;
    repoCount: number;
    languages: string[];
}

/** Single-level org grouping (GitLab base group, GitHub org, IDP unit). */
export interface InventoryOrganization {
    name: string;
    fullPath: string;
    repoCount: number;
    serviceCount: number;
}

export interface InventoryTenant {
    name: string;
    slug: string;
    description?: string;
}

/** A deployment surface of an API: where it answers, in which env, for whom. */
export interface InventoryApiDeployment {
    url: string;
    environment: string;
    visibility: string;
}

export interface InventoryApiEndpoint {
    /** Null for non-HTTP operations (GraphQL SDL). */
    method: string | null;
    path: string;
}

export interface InventoryApiExposer {
    service: string;
    serviceUrn: string;
}

/** One exposed logical API surface with everything the catalog row needs. */
export interface InventoryApi {
    urn: string;
    title: string;
    version: string;
    apiSource: string;
    exposers: InventoryApiExposer[];
    team: string | null;
    repository: string | null;
    specPath: string | null;
    deployments: InventoryApiDeployment[];
    endpoints: InventoryApiEndpoint[];
    consumerCount: number;
}

export interface InventoryReport {
    repositories: InventoryRepo[];
    services: InventoryService[];
    teams: InventoryTeam[];
    organizations: InventoryOrganization[];
    apiCatalog: InventoryApi[];
    tenant?: InventoryTenant;
    summary: {
        totalRepos: number;
        totalServices: number;
        totalTeams: number;
        totalFiles: number;
        totalFunctions: number;
    };
}

// ─── Governance DTOs ─────────────────────────────────────────────────────────

export interface StructuredCheckItem {
    label: string;
    status: 'pass' | 'fail' | 'warn';
}

export interface GovernanceStructuredDetail {
    checks: StructuredCheckItem[];
    /** Found items in the entity — used by the UI for fuzzy "did you mean?" hints */
    found: string[];
}

export interface GovernanceEvaluation {
    id: string;
    ruleId: string;
    ruleName: string;
    level: 'error' | 'warning' | 'note';
    scope: string;
    /** Evaluation result: 'pass' = compliant, 'fail' = violation. */
    status: 'pass' | 'fail';
    entityId: string;
    entityName: string;
    entityType: string;
    /** URL of the entity (repository URL, etc.) for clickable links */
    entityUrl: string | null;
    /** Team that owns this entity. Null if unowned. */
    teamOwner: string | null;
    /** Raw 12-month no-merges commit count on the repository where this entity lives.
     *  The discrete tier is derived on read via `tierFromCommits()`. */
    livenessCommits: number | null;
    /** Repository name that holds this entity. For Repository-scoped evaluations this equals entityName. */
    repoName: string | null;
    /** Backstage System that contains this entity (directly for Services, transitively for Repositories). */
    systemName: string | null;
    /** CSV string of the rule's tags, denormalised from PolicyRule.tags. */
    tags: string;
    detail: string;
    /** Rich checklist data — parsed from JSON. */
    structuredDetail?: GovernanceStructuredDetail;
    evaluatedAt: string;
}

/** @deprecated Use GovernanceEvaluation instead */
export type GovernanceViolation = GovernanceEvaluation;

export interface GovernanceRuleResult {
    ruleId: string;
    ruleName: string;
    level: 'error' | 'warning' | 'note';
    scope: string;
    /** All evaluations for this rule (pass + fail). */
    evaluations: GovernanceEvaluation[];
    /** Failing evaluations only. */
    violations: GovernanceEvaluation[];
    /** Number of unique entities evaluated by this rule */
    evaluatedCount: number;
    /** Number of unique entities that passed this rule */
    compliantCount: number;
}

/** A rule definition from the PolicyRule nodes in the graph (full catalog) */
export interface GovernanceRuleCatalogEntry {
    id: string;
    name: string;
    description: string;
    level: 'error' | 'warning' | 'note';
    scope: string;
    tags: string[];
    /** ISO timestamp of when this rule was last evaluated */
    lastEvaluatedAt: string;
    /** Total entities evaluated by this rule (-1 = query failed) */
    evaluatedCount: number;
    /** Entities that passed this rule (-1 = query failed) */
    compliantCount: number;
    /** Entities that failed this rule (-1 = query failed) */
    violationCount: number;
    /** Whether the last evaluation succeeded */
    ok: boolean;
    /** Error message if the last evaluation failed */
    error: string | null;
    /** Cypher query definition */
    query: string;
}

export interface GovernanceReport {
    generatedAt: string;
    /** Total unique entities evaluated across all rules. */
    totalEvaluated: number;
    /** Total unique entities that passed ALL evaluated rules. */
    totalCompliant: number;
    /** Compliance percentage (totalCompliant / totalEvaluated * 100). */
    compliancePct: number;
    totalViolations: number;
    errorViolations: number;
    warningViolations: number;
    noteViolations: number;
    /** Rules grouped by ruleId — reconstructed from PolicyEvaluation nodes */
    ruleBreakdown: GovernanceRuleResult[];
    /** Number of distinct rules that have at least one violation */
    rulesViolated: number;
    /** Full rule catalog — ALL rules including those with 0 violations */
    ruleCatalog: GovernanceRuleCatalogEntry[];
}

// ─── API Payload Types ──────────────────────────────────────────────────────

/** Unified dashboard payload — the CLI emits this, the frontend consumes it. */
export interface RadiusDashboardPayload {
    generatedAt: string;
    cliVersion?: string;
    focus?: 'agentic-radar' | 'deps' | 'gravity' | 'blast' | 'inventory' | 'governance';
    radar: AgentHarnessReport | null;
    deps: DepsReport | null;
    gravity: GravityAnalysisResult | null;
    /** Full architecture topology for client-side blast radius exploration */
    topology: TopologyMap | null;
    /** System Registry — auto-generated service catalog */
    inventory: InventoryReport | null;
    /** Governance — policy violations read from the graph (written by `cr policy verify --output graph`) */
    governance: GovernanceReport | null;
}


/** Blast analysis payload — the blast command emits this. */
export interface BlastDashboardPayload {
    generatedAt: string;
    cliVersion?: string;
    blast: BlastAnalysisResult;
}

/** Lineage analysis payload — the lineage command emits this. */
export interface LineageDashboardPayload {
    generatedAt: string;
    cliVersion?: string;
    lineage: LineageAnalysisResult;
}

/** Union type for all payloads the frontend can receive. */
export type DashboardPayload = RadiusDashboardPayload | BlastDashboardPayload | LineageDashboardPayload;

/** Type guard: check if payload is a dashboard type */
export function isRadiusDashboard(p: DashboardPayload): p is RadiusDashboardPayload {
    return 'radar' in p || 'deps' in p || 'gravity' in p;
}

/** Type guard: check if payload is a blast type */
export function isBlastDashboard(p: DashboardPayload): p is BlastDashboardPayload {
    return 'blast' in p;
}

/** Type guard: check if payload is a lineage type */
export function isLineageDashboard(p: DashboardPayload): p is LineageDashboardPayload {
    return 'lineage' in p;
}
