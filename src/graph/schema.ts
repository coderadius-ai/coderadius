/**
 * Graph Schema Definition
 * 
 * This file centralizes the definition of nodes and relationships in the Neo4j graph.
 * It is used for schema initialization and to dynamically inform the AI agents.
 */

import { ONTOLOGY } from './domain.js';

export const GRAPH_SCHEMA = {
    nodes: Object.entries(ONTOLOGY).map(([name, schema]) => ({
        name,
        // Extract properties from the Zod Schema shape
        properties: Object.keys(schema.shape),
    })),
    relationships: [
        // Enterprise Hierarchy (Organizations are single-level)
        '(Organization)-[:PART_OF]->(Tenant)',
        '(Repository)-[:BELONGS_TO]->(Organization)',
        // C4 Skeleton
        '(System)-[:PART_OF]->(Domain)',
        '(System)-[:CONTAINS]->(Service)',
        '(Team)-[:OWNS]->(Service)',
        '(Team)-[:OWNS]->(Repository)',
        '(Service)-[:DEPENDS_ON]->(Service)',
        '(Service)-[:STORED_IN]->(Repository)',
        '(Library)-[:STORED_IN]->(Repository)',
        '(Service)-[:CONTAINS]->(Function)',
        '(Library)-[:CONTAINS]->(Function)',
        '(Service)-[:WRITTEN_IN]->(Technology)',
        '(Function)-[:WRITTEN_IN]->(Technology)',
        '(Repository / Service / Library)-[:CONTAINS]->(SourceFile)',
        '(SourceFile)-[:CONTAINS]->(Function)',
        '(Function)-[:READS_ENV]->(EnvVar)',
        '(Function)-[:CALLS]->(Function)',
        '(Function)-[:READS]->(DataContainer)',
        '(Function)-[:WRITES]->(DataContainer)',
        '(Function)-[:MAPS_TO]->(DataContainer)',
        '(Function)-[:CONNECTS_TO]->(Datastore)',
        '(DataContainer)-[:STORED_IN]->(Datastore)',
        '(Datastore)-[:SERVED_BY]->(DatabaseEndpoint)',
        '(Datastore)-[:CONFIGURED_VIA]->(EnvVar)',
        // Removed legacy `(Datastore)-[:BOUND_TO]->(PhysicalResource)` edge:
        // never implemented in code; Datastores bind to :DatabaseEndpoint
        // (its own family) via :SERVED_BY above.
        '(Function)-[:PUBLISHES_TO {routingKey?, partitionKey?, headers?}]->(MessageChannel)',
        '(Function)-[:LISTENS_TO {consumerGroup?, ackMode?, filterExpression?}]->(MessageChannel)',
        '(MessageChannel)-[:ROUTES_TO {bindingKey, isPattern, patternRegex, filter, headerMatch?}]->(MessageChannel)',
        '(MessageChannel)-[:HOSTED_ON]->(MessageBroker)',
        '(MessageChannel{scope:logical})-[:MANIFESTS_AS]->(MessageChannel{scope:physical})',
        '(MessageChannel{scope:transport})-[:BACKED_BY]->(MessageChannel{scope:physical})',
        '(MessageChannel)-[:DEAD_LETTERS_TO {retryLimit?, ttl?}]->(MessageChannel)',
        '(DataStructure)-[:CARRIED_BY]->(MessageChannel)',
        '(MessageChannel)-[:HAS_SCHEMA]->(DataStructure)',
        '(DataContainer)-[:HAS_SCHEMA]->(DataStructure)',
        '(APIEndpoint)-[:HAS_REQUEST_SCHEMA]->(DataStructure)',
        '(APIEndpoint)-[:HAS_RESPONSE_SCHEMA]->(DataStructure)',
        '(Function)-[:SPAWNS]->(SystemProcess)',
        '(TraceSpan)-[:OBSERVED_IN]->(Function)',
        '(SourceFile)-[:DEFINES_SCHEMA]->(DataStructure)',
        '(DataStructure)-[:HAS_FIELD]->(DataField)',
        // Phase 2: field-level contract participation (deep-mode-only, capped per payload).
        '(Function)-[:PRODUCES_FIELD]->(DataField)',
        '(Function)-[:CONSUMES_FIELD]->(DataField)',
        // Phase 3 (Fix #2): type-string base name → DataStructure resolution.
        '(DataField)-[:REFERENCES_TYPE]->(DataStructure)',
        '(Repository)-[:CONTAINS]->(SourceFile)',
        '(SourceFile)-[:DEFINES_API]->(APIInterface)',
        '(Service)-[:EXPOSES_API]->(APIInterface)',
        '(Service)-[:CONSUMES_API]->(APIInterface)',
        '(APIInterface)-[:HAS_ENDPOINT]->(APIEndpoint)',
        '(APIInterface)-[:DEPLOYED_AT]->(APIDeployment)',
        '(Function)-[:CALLS]->(APIEndpoint)',
        // Structural Extraction Layer (Zero-LLM)
        '(Repository)-[:HAS_CONFIG]->(StructuralFile)',
        '(StructuralFile)-[:DEFINES]->(Task)',
        '(StructuralFile)-[:USES_BASE_IMAGE]->(DockerImage)',
        '(StructuralFile)-[:USES_IMAGE]->(DockerImage)',
        '(StructuralFile)-[:DEFINES]->(ToolConfig)',
        '(Repository)-[:CONTAINS_DIRECTORY]->(ProjectDirectory)',
        '(Repository)-[:HAS_TASK]->(Task)',
        '(Repository)-[:HAS_DOCKER_IMAGE]->(DockerImage)',
        '(Repository)-[:HAS_TOOL_CONFIG]->(ToolConfig)',
        '(Repository)-[:HAS_CI_PIPELINE]->(CIPipeline)',
        '(StructuralFile)-[:DEFINES]->(AgenticConfig)',
        '(Repository)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig)',
        '(Service)-[:HAS_TOOL_CONFIG]->(ToolConfig)',
        '(Service)-[:HAS_CI_PIPELINE]->(CIPipeline)',
        '(Service)-[:HAS_DOCKER_IMAGE]->(DockerImage)',
        '(Service)-[:HAS_TASK]->(Task)',
        '(Service)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig)',
        '(Service)-[:HAS_LINK]->(Link)',
        '(Service)-[:INCLUDES_COMPONENT]->(CIComponent)',
        '(Repository)-[:INCLUDES_COMPONENT]->(CIComponent)',
        // Context Provenance — cross-repo AI context import tracking
        '(Repository)-[:IMPORTS_CONTEXT_FROM]->(Repository)',
        // Team Alias Resolution — AI-proposed team identity mappings
        '(TeamAlias)-[:PROPOSED_ALIAS_OF]->(Team)',
        // Unmapped Data Contracts
        '(Function)-[:PRODUCES]->(DataStructure)',
        '(Function)-[:CONSUMES]->(DataStructure)',
        // Unmapped Package Dependencies
        '(Service)-[:DEPENDS_ON]->(Package)',
        '(Library)-[:DEPENDS_ON]->(Package)',
        '(Repository)-[:DEPENDS_ON]->(Package)',
        '(Package)-[:HAS_RELEASE]->(Release)',
        '(Package)-[:HAS_VULNERABILITY {vulnerableInstalledVersions, affectedRanges, fixedVersion}]->(Vulnerability)',
        '(Repository)-[:PUBLISHES]->(Package)',
        // Unmapped API Endpoints Backlinks
        '(Function)-[:IMPLEMENTS_ENDPOINT]->(APIEndpoint)',
        // Unmapped Registry Dependencies
        '(SourceFile)-[:DEPENDS_ON_SYMBOL]->(ConfigSymbol)',
        // Catalog Declared Truth Layer
        '(CatalogEntity)-[:DESCRIBES]->(Service)',
        '(CatalogEntity)-[:DESCRIBES]->(Repository)',
    ]
};

/**
 * Returns a markdown-formatted string describing the graph schema
 * for injection into AI agent instructions.
 */
export function getFormattedSchema(): string {
    let out = '## Graph Schema Reference\n';
    out += 'You must rely strictly on the following nodes and relationships when writing Cypher queries:\n\n';

    out += '**Nodes:**\n';
    for (const node of GRAPH_SCHEMA.nodes) {
        out += `- \`${node.name}\` (${node.properties.join(', ')})\n`;
    }

    out += '\n**Relationships:**\n';
    for (const rel of GRAPH_SCHEMA.relationships) {
        out += `- \`${rel}\`\n`;
    }

    return out;
}
