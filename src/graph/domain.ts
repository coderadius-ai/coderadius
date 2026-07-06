import { z } from 'zod';
import { AI_TOOLS, AGENTIC_CONFIG_TYPES } from '../ingestion/structural/plugins/agentic-config.plugin.js';
import { GroundingFlatFieldsSchema } from './grounding.js';

// All node schemas merge `GroundingFlatFieldsSchema` so every node carries the
// 8 flat grounding properties (source, quality, evidence_extractors,
// evidence_llmCalls, evidence_fallbacksApplied, evidence_mergedFrom, needsReview,
// lastSeenCommit). Reconstruct the structured form via `unflattenGrounding`.

// ─── Enterprise Hierarchy ────────────────────────────────────────────────────

export const TenantSchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type TenantNode = z.infer<typeof TenantSchema>;

export const OrganizationSchema = z.object({
    id: z.string(),
    name: z.string(),
    fullPath: z.string(),
    level: z.number(),
}).merge(GroundingFlatFieldsSchema);
export type OrganizationNode = z.infer<typeof OrganizationSchema>;

// Technology: a canonical, kind-discriminated tech identity (language, datastore,
// broker, framework, ...). One node type; the edge verb (WRITTEN_IN / RUNS / USES)
// carries the relationship semantics. URN: cr:technology:{kind}:{slug}.
export const TechnologySchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    kind: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type TechnologyNode = z.infer<typeof TechnologySchema>;

// ─── C4 Skeleton Nodes (Backstage) ───────────────────────────────────────────

export const SystemSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type SystemNode = z.infer<typeof SystemSchema>;

export const DomainSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type DomainNode = z.infer<typeof DomainSchema>;

export const RepositorySchema = z.object({
    id: z.string(), // cr:repository:{name}
    name: z.string(),
    url: z.string().optional(),
    repoHash: z.string().optional(),
    /** The canonical default branch (e.g. 'main', 'master') — detected via symbolic-ref or ls-remote heuristic */
    defaultBranch: z.string().optional(),
    /** Structurally significant branches (main, master, develop, release/*, hotfix/*) detected via ls-remote */
    coreBranches: z.array(z.string()).optional(),
    /** SCM hosting platform inferred from remote URL: github | gitlab | bitbucket | azure-devops | unknown */
    hostingPlatform: z.string().optional(),
    /** ISO UTC timestamp of the last successful analysis/cache validation for this repository. */
    lastAnalyzedAt: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type RepositoryNode = z.infer<typeof RepositorySchema>;

export const LibrarySchema = z.object({
    id: z.string(), // cr:library:{name}
    name: z.string(),
    description: z.string().optional(),
    repoHash: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type LibraryNode = z.infer<typeof LibrarySchema>;

export const TeamSchema = z.object({
    id: z.string(),
    name: z.string(),
    teamType: z.enum(['squad', 'team', 'guild', 'tribe', 'department', 'chapter', 'unknown']).optional(),
}).merge(GroundingFlatFieldsSchema);
export type TeamNode = z.infer<typeof TeamSchema>;

export const LinkSchema = z.object({
    id: z.string(),
    url: z.string(),
    title: z.string().optional(),
    icon: z.string().optional(),
    type: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type LinkNode = z.infer<typeof LinkSchema>;

export const CatalogEntitySchema = z.object({
    id: z.string(),
    name: z.string(),
    catalogSource: z.string(),
    kind: z.string(),
    namespace: z.string(),
    entityRef: z.string(),
    type: z.string().optional(),
    owner: z.string().optional(),
    system: z.string().optional(),
    description: z.string().optional(),
    lifecycle: z.string().optional(),
    dependsOnJson: z.string().optional(),
    providesApisJson: z.string().optional(),
    consumesApisJson: z.string().optional(),
    labelsJson: z.string().optional(),
    tagsJson: z.string().optional(),
    linksJson: z.string().optional(),
    specJson: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type CatalogEntityNode = z.infer<typeof CatalogEntitySchema>;

/**
 * CI Component declaration parsed from a CI pipeline `include`-style block.
 *
 * Technology-neutral container: the `tool` discriminator ('gitlab-ci' |
 * 'github-actions') tells which CI tool's component this is, mirroring the
 * same pattern used by :CIPipeline. Today only GitLab Components (16.0+) are
 * extracted; a future GitHub Actions reusable-workflow extractor would
 * populate the same node shape with tool='github-actions'.
 *
 * The node captures the declaration shape — host, project path, component
 * name, ref, and the inputs map. Fetch+resolve of the remote template YAML
 * (which would populate resolvedImage / resolvedScriptTokens / hasDeployStage
 * / hasReviewEnv) is a separate async step; until that runs, fetchStatus
 * stays 'skipped'.
 */
export const CIComponentSchema = z.object({
    id: z.string(),
    /** CI tool that defines this component: 'gitlab-ci' | 'github-actions' */
    tool: z.string(),
    host: z.string(),
    projectPath: z.string(),
    name: z.string(),
    ref: z.string(),
    templateUrl: z.string(),
    inputsJson: z.string().optional(),
    fetchStatus: z.enum(['skipped', 'pending', 'ok', 'auth_required', 'not_found', 'timeout', 'parse_error']).default('skipped'),
    fetchError: z.string().optional(),
    resolvedImage: z.string().optional(),
    resolvedScriptTokens: z.string().optional(),
    hasDeployStage: z.boolean().optional(),
    hasReviewEnv: z.boolean().optional(),
}).merge(GroundingFlatFieldsSchema);
export type CIComponentNode = z.infer<typeof CIComponentSchema>;

export const ServiceSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type ServiceNode = z.infer<typeof ServiceSchema>;

export const DeploymentUnitSchema = z.object({
    id: z.string(),      // cr:deploymentunit:{qualifiedRepoName}:{name}
    name: z.string(),
    description: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type DeploymentUnitNode = z.infer<typeof DeploymentUnitSchema>;

/**
 * Placeholder for a catalog `dependsOn` reference whose target Service
 * has not yet been ingested. Replaced by an edge to the real :Service
 * by `bindUnresolvedDependencies` at the end of the global workflow.
 *
 * URN is global (not repo-scoped) so multiple consumers in different
 * repos that declare `dependsOn: foo` collapse on the same node and
 * a single bind reconciles them all.
 */
export const UnresolvedDependencySchema = z.object({
    id: z.string(),  // cr:unresolveddep:{name}
    name: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type UnresolvedDependencyNode = z.infer<typeof UnresolvedDependencySchema>;

// ─── Code Graph Nodes ────────────────────────────────────────────────────────

export const FunctionSchema = z.object({
    id: z.string(),
    name: z.string(),
    filepath: z.string(),
    intent: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    embedding: z.array(z.number()).optional(),
    startLine: z.number(),
    endLine: z.number(),
}).merge(GroundingFlatFieldsSchema);
export type FunctionNode = z.infer<typeof FunctionSchema>;

export const SourceFileSchema = z.object({
    id: z.string(),
    path: z.string(),
    name: z.string(),
    fileHash: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type SourceFileNode = z.infer<typeof SourceFileSchema>;

/**
 * `:Datastore` — the LOGICAL database identity (business name + technology).
 *
 * Paradigm A (logical/physical split): the Datastore carries NO host/port and
 * NO `environments` blob. Each physical deployment surface (prod / staging /
 * dev) is a separate `:DatabaseEndpoint{environment}` linked via SERVED_BY.
 * "Which prod DBs are SPOF" is a direct node query, not a JSON UNWIND.
 */
export const DatastoreSchema = z.object({
    id: z.string(),
    name: z.string(),
    technology: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type DatastoreNode = z.infer<typeof DatastoreSchema>;

/**
 * `STORED_IN` edge schema — DataContainer → Datastore.
 *
 * `bindingReason` captures the decision rule applied; `grounding.quality`
 * (via the merged GroundingFlatFieldsSchema) captures the overall trust
 * tier.
 */
export const StoredInEdgeSchema = z.object({
    valid_from_commit: z.string(),
    valid_to_commit: z.string().nullable(),
    bindingReason: z.enum([
        'sole-candidate',
        'p0-yaml',
        'llm-assignment',
        'env-canonical-default',
    ]),
    /** Set by `pruneIncompatibleStoredInEdges` when tombstoning. */
    prunedReason: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type StoredInEdge = z.infer<typeof StoredInEdgeSchema>;

export const DatabaseEndpointSchema = z.object({
    id: z.string(),              // cr:dbendpoint:{endpointKey}:{environment}
    endpointKey: z.string(),     // sha256_trunc8(host:port/dbName) — stable cross-repo fingerprint
    environment: z.string(),     // production | staging | development | test | unknown
    dbName: z.string(),          // logical database name
    technology: z.string(),      // mongodb, postgres, mysql, redis, etc.
    host: z.string().optional(), // only populated when allowPlainTextHosts is true
    port: z.number().optional(), // physical port (informational; part of endpointKey fingerprint)
}).merge(GroundingFlatFieldsSchema);
export type DatabaseEndpointNode = z.infer<typeof DatabaseEndpointSchema>;

export const DataContainerSchema = z.object({
    id: z.string(),
    name: z.string(),
    /** Physical database name hint — populated only when a manual database_scope override is in effect. */
    databaseName: z.string().optional(),
    /** Source repository when this table is shared across repos via database_scope. */
    sourceRepo: z.string().optional(),
    /** URN scope — repo-qualified by default, may be a database_scope override id. Persisted ON CREATE. */
    scope: z.string().optional(),
    scopeSource: z.enum(['manual_override', 'repo_fallback']).optional(),
    /** Datastore tech for this container (mirror of the bound Datastore.technology). */
    technology: z.string().optional(),
    /** 16-hex fingerprint of the underlying physical endpoint. Required for cross-service welding. */
    physicalEndpointKey: z.string().optional(),
    /** Postgres schema / Kafka cluster id / namespace qualifier — disambiguates same-name across schemas. */
    schemaOrNs: z.string().optional(),
    /** Coarse family — prevents welding across mismatched stores. */
    kindFamily: z.enum(['rdbms', 'document', 'kv', 'timeseries', 'broker', 'queue', 'object']).optional(),
    /** Pointer to the bound Datastore URN for fast traversal. */
    datastoreUrn: z.string().optional(),
    /** Endpoint-binding strength — separate semantic from grounding.quality; 'high' required for welding. */
    physicalEndpointConfidence: z.enum(['high', 'medium', 'low']).optional(),
    /** Set on the loser of a weld pair: URN of the canonical winner. */
    weldedInto: z.string().optional(),
    /** Bitemporal: tombstone marker after weld. */
    valid_to_commit: z.string().nullable().optional(),
}).merge(GroundingFlatFieldsSchema);
export type DataContainerNode = z.infer<typeof DataContainerSchema>;

export const MessageChannelSchema = z.object({
    id: z.string(),
    name: z.string(),
    technology: z.string().optional(),
    channelKind: z.enum(['topic', 'subscription', 'queue', 'exchange']).optional(),
    schemaFormat: z.enum(['avro', 'json-schema', 'protobuf']).optional(),
    schemaPath: z.string().optional(),
    // scope distinguishes business event ('logical') from broker address ('physical')
    // and Symfony-Messenger-style transport indirection ('transport').
    scope: z.enum(['logical', 'physical', 'transport']).optional(),
    // Set only when scope='physical' and the channel is bound to a discovered MessageBroker.
    brokerUrn: z.string().optional(),
    durable: z.boolean().optional(),
    autoDelete: z.boolean().optional(),
    // FIFO SQS, Kafka partition ordering, MQTT QoS-2.
    ordered: z.boolean().optional(),
    confidence: z.number().optional(),
}).merge(GroundingFlatFieldsSchema);
export type MessageChannelNode = z.infer<typeof MessageChannelSchema>;

/**
 * Physical broker instance (RabbitMQ cluster, Kafka cluster, SQS/SNS account+region,
 * GCP project, Pulsar tenant/namespace, Azure SB namespace, NATS cluster, etc.).
 *
 * Identity rule (strict): two MessageBroker nodes are the SAME iff their fingerprint
 * matches. Fingerprint = sha256_trunc8(provider + host + port + vhost). Channels on
 * different brokers are NEVER welded heuristically; mirror semantics require an
 * explicit `channelAliases` declaration in coderadius.yaml.
 */
export const MessageBrokerSchema = z.object({
    id: z.string(),                       // cr:broker:{provider}:{fingerprint}[:{vhost-slug}]
    provider: z.enum([
        'rabbitmq', 'kafka', 'pubsub', 'sqs', 'sns', 'azure-service-bus',
        'nats', 'pulsar', 'redis-streams', 'mqtt', 'mosquitto', 'zeromq',
        'symfony-messenger',
    ]),
    cluster: z.string().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    vhost: z.string().optional(),
    region: z.string().optional(),
    env: z.string().optional(),
    fingerprint: z.string(),
    declaredVia: z.enum(['config', 'crossplane', 'backstage', 'coderadius.yaml', 'inferred']),
    confidence: z.number().min(0).max(1).optional(),
}).merge(GroundingFlatFieldsSchema);
export type MessageBrokerNode = z.infer<typeof MessageBrokerSchema>;

export const SystemProcessSchema = z.object({
    id: z.string(),
    name: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type SystemProcessNode = z.infer<typeof SystemProcessSchema>;

/**
 * `:APIDeployment` — a deployment surface (URL endpoint) of an `:APIInterface`.
 *
 * One `:APIInterface` can have N `:APIDeployment` (public ingress, internal
 * mesh, admin URL, per-env URLs). Each carries provenance for URL-match
 * welding: scheme/host/port/basePath are parsed components used by the
 * global resolver to weld emergent endpoints to canonical ones via URL
 * exact-match (tier L0a in the resolver funnel).
 *
 * Renamed from `:PhysicalResource` (POC mode in-place): the old label was
 * misleading semantically (it modelled only API surfaces, not generic infra)
 * and risked becoming a god-node if extended for DB / broker / pod. Each
 * physical-thing-family now has its own label (`:DatabaseEndpoint`,
 * `:MessageBroker`, `:APIDeployment`).
 */
export const APIDeploymentSchema = z.object({
    id: z.string(),                // cr:apideployment:<canonicalUrl>
    name: z.string(),              // verbatim baseUrl (audit)
    canonicalUrl: z.string().optional(),  // scheme://host[:port][basePath]
    scheme: z.string().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    basePath: z.string().optional(),
    environment: z.string().optional(),   // 'production' | 'staging' | 'dev' | 'local' | 'unknown'
    visibility: z.string().optional(),    // 'public' | 'internal' | 'admin' | 'partner' | 'unknown'
    declaredBy: z.string().optional(),    // 'oas-servers' | 'helm-ingress' | 'k8s-ingress' | 'catalog-link' | 'docker-compose' | 'declared' | 'inferred'
    confidence: z.string().optional(),    // 'exact' | 'high' | 'medium' | 'low'
    cluster: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type APIDeploymentNode = z.infer<typeof APIDeploymentSchema>;

export const TraceSpanSchema = z.object({
    spanId: z.string(),
    traceId: z.string().optional(),
    operationName: z.string(),
    serviceName: z.string(),
    parentSpanId: z.string().optional(),
    latency_ms: z.number(),
    status: z.string(),
    language: z.string().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
}).merge(GroundingFlatFieldsSchema);
export type TraceSpanNode = z.infer<typeof TraceSpanSchema>;

// ─── Emergent Schema Nodes ───────────────────────────────────────────────────

export const DataStructureSchema = z.object({
    id: z.string(),      // cr:schema:{type}:{name} OR cr:schema:message_payload:{scopeSegs}:{name}
    name: z.string(),
    type: z.enum(['database_table', 'message_payload']),
    namespace: z.string().optional(),    // Avro namespace (e.g. "com.acme.events")
    doc: z.string().optional(),          // Schema documentation
    schemaFormat: z.enum(['avro', 'json-schema', 'protobuf']).optional(),
    /**
     * Bounded-context scope for emergent message_payload schemas (LLM-inferred,
     * no schemaFormat). Form `{repoSeg}:{serviceSeg}` (e.g. `acme:orders`).
     * Null/undefined for deterministic schemas and database_table (where
     * scoping lives at the DataContainer level).
     */
    scopeKey: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type DataStructureNode = z.infer<typeof DataStructureSchema>;

export const DataFieldSchema = z.object({
    id: z.string(),      // cr:schema:{type}:{name}:field:{fieldName}
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    logicalType: z.string().optional(),          // Avro logical type (timestamp-millis, uuid, decimal)
    enumSymbols: z.array(z.string()).optional(),  // Native string array for enum values
    isArray: z.boolean().optional(),              // Field is an array of type
    isMap: z.boolean().optional(),                // Field is a map with value type
    doc: z.string().optional(),                   // Field documentation
    defaultValue: z.string().optional(),          // Serialized default value
}).merge(GroundingFlatFieldsSchema);
export type DataFieldNode = z.infer<typeof DataFieldSchema>;

// ─── API Contract Nodes ──────────────────────────────────────────────────────

export const APIInterfaceSchema = z.object({
    id: z.string(),      // cr:api:{source}:{serviceName}
    title: z.string(),
    version: z.string(),
    /**
     * Direction of the contract from the owning service's perspective.
     *  INBOUND  : the service exposes this contract (EXPOSES_API)
     *  OUTBOUND : the service consumes this contract (CONSUMES_API)
     * Persisted on the node so dashboards can segment without re-deriving
     * via relationship traversal.
     */
    direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
}).merge(GroundingFlatFieldsSchema);
export type APIInterfaceNode = z.infer<typeof APIInterfaceSchema>;

export const APIEndpointSchema = z.object({
    id: z.string(),      // cr:endpoint:{origin}:{method}:{path}
    name: z.string(),    // Same as `path` — set for consistency with other node types
    path: z.string(),
    method: z.string(),
    summary: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type APIEndpointNode = z.infer<typeof APIEndpointSchema>;

// ─── Package (Dependency) Nodes ──────────────────────────────────────────────

export const PackageSchema = z.object({
    id: z.string(),      // cr:package:{ecosystem}:{name}
    name: z.string(),
    ecosystem: z.enum(['npm', 'composer', 'go', 'pypi']),
    isInternal: z.boolean(),
    // ─── Publisher Side ────────────────
    latestKnownVersion: z.string().optional(),
    /** How the latest known version was discovered: kept as domain-specific extractor identity. Grounding.evidence.extractors carries the broader picture. */
    latestKnownConfidence: z.enum(['manifest', 'tag', 'registry', 'webhook']).optional(),
    publishRegistry: z.string().optional(),
    sourceRepoName: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type PackageNode = z.infer<typeof PackageSchema>;

// ─── Package Release Timeline ────────────────────────────────────────────────

export const ReleaseSchema = z.object({
    id: z.string(),                    // cr:release:{ecosystem}:{name}:{version}
    version: z.string(),               // "2.3.0"
    publishedAt: z.string().optional(), // ISO 8601 — first seen by CodeRadius
    /** Release-discovery method, kept as domain-specific tag (mirrors PackageSchema.latestKnownConfidence). */
    releaseSource: z.enum(['manifest', 'tag', 'registry', 'webhook']).optional(),
    commitHash: z.string().optional(),  // git commit when this version was detected
    deprecated: z.boolean().optional(),
}).merge(GroundingFlatFieldsSchema);
export type ReleaseNode = z.infer<typeof ReleaseSchema>;

// ─── Vulnerability (CVE / Advisory) ─────────────────────────────────────────

export const VulnerabilitySchema = z.object({
    id: z.string(),                    // cr:vulnerability:{osvId}
    osvId: z.string(),
    aliases: z.array(z.string()).optional(),
    summary: z.string(),
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),
    cvssScore: z.number().optional(),
    cvssVector: z.string().optional(),
    published: z.string().optional(),
    modified: z.string().optional(),
    withdrawn: z.string().optional(),
    references: z.array(z.string()).optional(),
    lastFetchedAt: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type VulnerabilityNode = z.infer<typeof VulnerabilitySchema>;

// ─── Environment Variables Nodes ─────────────────────────────────────────────

export const EnvVarSchema = z.object({
    id: z.string(),
    name: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type EnvVarNode = z.infer<typeof EnvVarSchema>;

// ─── Structural Extraction Layer Nodes ───────────────────────────────────────

export const TaskSchema = z.object({
    id: z.string(),
    name: z.string(),
    /** Origin file or extractor identity for this task (e.g. 'package.json', 'composer.json', 'gitlab-ci.yml'). Renamed from `source` to avoid collision with grounding.source. */
    taskOrigin: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type TaskNode = z.infer<typeof TaskSchema>;

export const DockerImageSchema = z.object({
    id: z.string(),
    name: z.string(),
    tag: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type DockerImageNode = z.infer<typeof DockerImageSchema>;

export const ToolConfigSchema = z.object({
    id: z.string(),
    name: z.string(),
    tool: z.string(),
    strict: z.boolean().optional(),
    target: z.string().optional(),
    module: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type ToolConfigNode = z.infer<typeof ToolConfigSchema>;

export const CIPipelineSchema = z.object({
    id: z.string(),
    tool: z.string(),                           // 'gitlab-ci' | 'github-actions'
    filePath: z.string(),
    hasTestStage: z.boolean().optional(),
    hasDeployStage: z.boolean().optional(),
    jobCount: z.number().optional(),
    stages: z.string().optional(),               // comma-separated stage names (GitLab CI: real stages; GHA: empty)
    triggers: z.string().optional(),             // comma-separated trigger events (push, pull_request, schedule, etc.)
}).merge(GroundingFlatFieldsSchema);
export type CIPipelineNode = z.infer<typeof CIPipelineSchema>;

export const ProjectDirectorySchema = z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    category: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type ProjectDirectoryNode = z.infer<typeof ProjectDirectorySchema>;

export const StructuralFileSchema = z.object({
    id: z.string(),
    path: z.string(),
    fileHash: z.string(),
    pluginName: z.string(),
}).merge(GroundingFlatFieldsSchema);
export type StructuralFileNode = z.infer<typeof StructuralFileSchema>;

export const AgenticConfigSchema = z.object({
    id: z.string(),             // cr:agenticconfig:{repo}:{tool}:{normalizedPath}
    name: z.string(),
    tool: z.enum(AI_TOOLS),
    configType: z.enum(AGENTIC_CONFIG_TYPES),
    contentHash: z.string(),    // SHA-256
    contentPreview: z.string(),
    filePath: z.string(),
    fileSize: z.number(),
    description: z.string().optional(),
    scope: z.string().optional(),
    alwaysApply: z.boolean().optional(),
    mcpServers: z.string().optional(),
    skillName: z.string().optional(),
    semanticIntent: z.string().optional(),
    topics: z.string().optional(),           // comma-separated governance domains
    technologies: z.string().optional(),     // comma-separated tech tags (e.g. "react,typescript,jest")
    embedding: z.array(z.number()).optional(),       // 768-dim cosine embedding vector
    embeddingModel: z.string().optional(),           // e.g. "gemini-embedding-001"
    skillSource: z.string().optional(),              // skills.sh provenance: "vercel-labs/agent-skills"
    skillSourceUrl: z.string().optional(),           // full URL to source repo
    skillSourceType: z.string().optional(),          // "github" | "gitlab" | "local" | "well-known"
    skillHash: z.string().optional(),                // content integrity hash from skills.lock
    skillInstalledAt: z.string().optional(),         // ISO timestamp
    skillUpdatedAt: z.string().optional(),           // ISO timestamp
    symlinkTarget: z.string().optional(),            // resolved symlink target (relative to repo root)
    installedVia: z.string().optional(),             // "symlink" when the file is a symlink
}).merge(GroundingFlatFieldsSchema);
export type AgenticConfigNode = z.infer<typeof AgenticConfigSchema>;

// ─── Team Alias Resolution ───────────────────────────────────────────────────

export const TeamAliasSchema = z.object({
    id: z.string(),            // cr:teamalias:{phantomName}
    phantomName: z.string(),   // e.g. "auto-integration"
    reasoning: z.string(),     // LLM explanation
    status: z.enum(['pending', 'approved', 'rejected']),
    proposedAt: z.string(),    // ISO timestamp
    resolvedAt: z.string().optional(),
}).merge(GroundingFlatFieldsSchema);
export type TeamAliasNode = z.infer<typeof TeamAliasSchema>;

// ─── Config Symbol Resolution ────────────────────────────────────────────────

export const ConfigSymbolSchema = z.object({
    id: z.string(),
    key: z.string(),
    value: z.string().optional().default(''),
    rawValue: z.string().optional().default(''),
    resolvedValue: z.string().optional().default(''),
    category: z.string().optional().default('di_service'),
    repoName: z.string(),
    sourceFile: z.string().optional().default(''),
    sourceHash: z.string().optional().default(''),
    technology: z.string().optional().default(''),
    extractorVersion: z.string().optional().default('legacy'),
    lastResolvedAt: z.number().optional().default(0),
    // Plan v10 §A: class-only DI bindings persist these so the next-run
    // reload reconstructs the boundComponent guard and (eventually) ioTags.
    physicalName: z.string().optional().default(''),
    boundComponent: z.string().optional().default(''),
    ioTagsJson: z.string().optional().default(''),
    bindingFingerprint: z.string().optional().default(''),
    viaFiles: z.array(z.string()).optional().default([]),
}).merge(GroundingFlatFieldsSchema);
export type ConfigSymbolNode = z.infer<typeof ConfigSymbolSchema>;

// ─── Ontology Registry ────────────────────────────────────────────────────────

export const NODE_LABELS = [
    'Tenant', 'Organization', 'Technology',
    'System', 'Domain', 'Team', 'Service', 'DeploymentUnit', 'Library', 'Repository',
    'SourceFile', 'Function', 'EnvVar', 'Datastore', 'DatabaseEndpoint', 'DataContainer',
    'MessageChannel', 'MessageBroker', 'SystemProcess', 'APIDeployment', 'TraceSpan',
    'DataStructure', 'DataField', 'APIInterface', 'APIEndpoint',
    'Package', 'Release', 'Vulnerability', 'Task', 'DockerImage', 'ToolConfig', 'CIPipeline', 'ProjectDirectory',
    'StructuralFile', 'AgenticConfig', 'TeamAlias', 'ConfigSymbol', 'Link',
    'CIComponent',
    'CatalogEntity',
] as const;

export type NodeLabel = typeof NODE_LABELS[number];

export const RESOURCE_LABELS: readonly NodeLabel[] = [
    'APIEndpoint', 'DataStructure', 'Datastore', 'DataContainer',
    'MessageChannel', 'SystemProcess',
] as const;

export const ONTOLOGY: Record<NodeLabel, z.ZodObject<any>> = {
    Tenant: TenantSchema,
    Organization: OrganizationSchema,
    Technology: TechnologySchema,
    System: SystemSchema,
    Domain: DomainSchema,
    Team: TeamSchema,
    Service: ServiceSchema,
    DeploymentUnit: DeploymentUnitSchema,
    Library: LibrarySchema,
    Repository: RepositorySchema,
    SourceFile: SourceFileSchema,
    Function: FunctionSchema,
    EnvVar: EnvVarSchema,
    Datastore: DatastoreSchema,
    DatabaseEndpoint: DatabaseEndpointSchema,
    DataContainer: DataContainerSchema,
    MessageChannel: MessageChannelSchema,
    MessageBroker: MessageBrokerSchema,
    SystemProcess: SystemProcessSchema,
    APIDeployment: APIDeploymentSchema,
    TraceSpan: TraceSpanSchema,
    DataStructure: DataStructureSchema,
    DataField: DataFieldSchema,
    APIInterface: APIInterfaceSchema,
    APIEndpoint: APIEndpointSchema,
    Package: PackageSchema,
    Release: ReleaseSchema,
    Vulnerability: VulnerabilitySchema,
    Task: TaskSchema,
    DockerImage: DockerImageSchema,
    ToolConfig: ToolConfigSchema,
    CIPipeline: CIPipelineSchema,
    ProjectDirectory: ProjectDirectorySchema,
    StructuralFile: StructuralFileSchema,
    AgenticConfig: AgenticConfigSchema,
    TeamAlias: TeamAliasSchema,
    ConfigSymbol: ConfigSymbolSchema,
    Link: LinkSchema,
    CIComponent: CIComponentSchema,
    CatalogEntity: CatalogEntitySchema,
};

export const CONSTRAINT_MAP: Record<NodeLabel, string> = {
    Tenant: 'id',
    Organization: 'id',
    Technology: 'id',
    System: 'id',
    Domain: 'id',
    Team: 'id',
    Service: 'id',
    DeploymentUnit: 'id',
    Library: 'id',
    Repository: 'id',
    SourceFile: 'id',
    Function: 'id',
    EnvVar: 'id',
    Datastore: 'id',
    DatabaseEndpoint: 'id',
    DataContainer: 'id',
    MessageChannel: 'id',
    MessageBroker: 'id',
    SystemProcess: 'id',
    APIDeployment: 'id',
    TraceSpan: 'spanId',
    DataStructure: 'id',
    DataField: 'id',
    APIInterface: 'id',
    APIEndpoint: 'id',
    Package: 'id',
    Release: 'id',
    Vulnerability: 'id',
    Task: 'id',
    DockerImage: 'id',
    ToolConfig: 'id',
    CIPipeline: 'id',
    ProjectDirectory: 'id',
    StructuralFile: 'id',
    AgenticConfig: 'id',
    TeamAlias: 'id',
    ConfigSymbol: 'id',
    Link: 'id',
    CIComponent: 'id',
    CatalogEntity: 'id',
};

/**
 * Secondary (non-unique) indexes used to speed up matching queries that filter
 * or join on properties OTHER than the primary `id` key.
 *
 * Adding an entry here causes initSchema() to issue
 *   `CREATE INDEX ON :Label(property);`
 * on Memgraph startup. CREATE INDEX is idempotent and silently ignored when
 * the index already exists.
 *
 * When to add an entry: a Cypher query in production filters on or compares
 * a property and that property has high cardinality (so an index pays off).
 *
 * Concrete drivers:
 *   APIEndpoint(path)   — `weldOpenApiAcrossSpecs` joins consumer↔authoritative
 *                         on equality of `path`. Without this index Memgraph
 *                         scans the cartesian product of all OpenAPI endpoints,
 *                         which is O(N²) for large polyrepo customers.
 *   APIEndpoint(method) — same query joins on `toUpper(method)`; pre-filtering
 *                         the candidate set by method first narrows the scan.
 *   APIEndpoint(source) — `getEmergentEndpoints`, the rewires, and the cross-spec
 *                         weld all filter on `source IN ('openapi','code',…)`.
 *   APIInterface(source) — same: rewire and weld both gate on this property.
 *   MessageChannel(name)  — dashboard fuzzy search and alias resolution match on name.
 *   MessageChannel(channelKind) — Taxonomy UI filter ("show me all queues") and
 *                         ingestion-time kind-aware MERGE lookups.
 */
export const SECONDARY_INDEXES: Array<{ label: NodeLabel; property: string }> = [
    { label: 'APIEndpoint', property: 'path' },
    { label: 'APIEndpoint', property: 'method' },
    { label: 'APIEndpoint', property: 'source' },
    { label: 'APIInterface', property: 'source' },
    { label: 'MessageChannel', property: 'name' },
    { label: 'MessageChannel', property: 'channelKind' },
    { label: 'MessageChannel', property: 'scope' },
    { label: 'MessageChannel', property: 'brokerUrn' },
    { label: 'MessageBroker', property: 'provider' },
    { label: 'MessageBroker', property: 'fingerprint' },
    // DataStructure / DataField (Phase 1C orphan GC + Phase 1A scoping diagnostic).
    // No (id) indexes here: CONSTRAINT_MAP already enforces uniqueness on id and
    // automatically materialises the supporting index.
    { label: 'DataStructure', property: 'scopeKey' },
    { label: 'DataStructure', property: 'source' },
    { label: 'DataStructure', property: 'valid_to_commit' },
    { label: 'DataStructure', property: 'name' },
    { label: 'DataField', property: 'name' },
    { label: 'DataField', property: 'valid_to_commit' },
    { label: 'Vulnerability', property: 'osvId' },
    { label: 'Vulnerability', property: 'severity' },
    { label: 'CatalogEntity', property: 'catalogSource' },
    { label: 'Organization', property: 'fullPath' },
    { label: 'Organization', property: 'level' },
    { label: 'Technology', property: 'kind' },
    { label: 'Technology', property: 'slug' },
];

// ─── Cypher Helpers ──────────────────────────────────────────────────────────

/**
 * Cypher CASE expression that deterministically resolves an architectural
 * node's type label. Accepts an optional alias for the node variable
 * (defaults to 'n').
 *
 * Usage in Cypher: `CASE ${labelCaseExpr('n')} END AS type`
 */
export function labelCaseExpr(alias: string = 'n'): string {
    return RESOURCE_LABELS
        .map(l => `WHEN ${alias}:${l} THEN '${l}'`)
        .join(' ') + ` ELSE labels(${alias})[0]`;
}
