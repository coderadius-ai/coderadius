/**
 * Search & Read Queries — Non-mutating graph reads
 *
 * Vector search, topology exploration, service topology, matchmaking hashes.
 */
import neo4j from 'neo4j-driver';
import { getMemgraphSession } from '../neo4j.js';
import { run } from './_run.js';
import { buildUrn } from '../urn.js';
import { VECTOR_INDEX } from '../vector-indexes.js';
import type { TopologyResult, TopologyNode, TopologyEdge, VectorSearchResult, ServiceTopology, ServiceTopologyFunction, OutboundDependency, InboundConsumer, ExposedEndpoint } from '../types.js';

// ─── Endpoint Search Result ──────────────────────────────────────────────────

export interface EndpointSearchResult {
    urn: string;
    path: string;
    method: string;
    operationId: string | null;
    summary: string | null;
    similarity: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Matchmaking Hash
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retrieve the matchmaking state hash for a given service by its URN.
 */
export async function getServiceMatchmakingHash(serviceUrn: string): Promise<string | null> {
    const result = await run(
        `MATCH (s:Service {id: $serviceUrn})
     RETURN s.matchmakingHash AS hash`,
        { serviceUrn },
    );

    if (result.records.length === 0) {
        return null;
    }

    return result.records[0].get('hash') as string | null;
}

/**
 * Update the matchmaking state hash for a given service by its URN.
 */
export async function updateServiceMatchmakingHash(serviceUrn: string, hash: string): Promise<void> {
    await run(
        `MERGE (s:Service {id: $serviceUrn})
     SET s.matchmakingHash = $hash`,
        { serviceUrn, hash },
    );
}

/**
 * Retrieve the global resolution state hash.
 */
export async function getGlobalResolutionHash(): Promise<string | null> {
    const result = await run(
        `MATCH (g:GlobalState {id: 'singleton'})
     RETURN g.globalResolutionHash AS hash`
    );

    if (result.records.length === 0) {
        return null;
    }

    return result.records[0].get('hash') as string | null;
}

/**
 * Update the global resolution state hash.
 */
export async function updateGlobalResolutionHash(hash: string): Promise<void> {
    await run(
        `MERGE (g:GlobalState {id: 'singleton'})
     SET g.globalResolutionHash = $hash`,
        { hash },
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Vector Search
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Vector similarity search on Function embeddings.
 *
 * Uses Memgraph native vector_search.search() against the function_embedding_idx.
 */
export async function vectorSearchFunctions(
    queryEmbedding: number[],
    topK: number = 5,
): Promise<VectorSearchResult[]> {
    const result = await run(
        `CALL vector_search.search($indexName, $topK, $queryEmbedding)
     YIELD node, similarity
     RETURN node.id AS id,
            node.name AS name,
            node.filepath AS filepath,
            node.intent AS intent,
            similarity AS score
     ORDER BY similarity DESC`,
        { indexName: VECTOR_INDEX.FUNCTION, queryEmbedding, topK: neo4j.int(topK) },
    );

    return result.records.map(r => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        filepath: r.get('filepath') as string,
        intent: r.get('intent') as string,
        score: r.get('score') as number,
    }));
}

/**
 * Vector similarity search on APIEndpoint embeddings.
 *
 * Used by the matchmaking L2 pre-filter to find the Top-K most semantically
 * similar endpoints for a given function embedding — server-side, zero CPU in Bun.
 *
 * @param queryEmbedding  The function's embedding vector
 * @param topK            Number of candidates to return
 * @param minSimilarity   Minimum cosine similarity threshold (0–1)
 */
export async function vectorSearchEndpoints(
    queryEmbedding: number[],
    topK: number = 5,
    minSimilarity: number = 0.65,
): Promise<EndpointSearchResult[]> {
    try {
        const result = await run(
            `CALL vector_search.search($indexName, $topK, $queryEmbedding)
         YIELD node, similarity
         WITH node, similarity
         WHERE similarity >= $minSimilarity
         RETURN node.id AS urn,
                node.path AS path,
                node.method AS method,
                node.operationId AS operationId,
                node.summary AS summary,
                similarity
         ORDER BY similarity DESC`,
            { indexName: VECTOR_INDEX.ENDPOINT, queryEmbedding, topK: neo4j.int(topK), minSimilarity },
        );

        return result.records.map(r => ({
            urn: r.get('urn') as string,
            path: r.get('path') as string,
            method: r.get('method') as string,
            operationId: r.get('operationId') as string | null,
            summary: r.get('summary') as string | null,
            similarity: r.get('similarity') as number,
        }));
    } catch {
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Topology Exploration
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Explore the topology around a node (blast radius analysis).
 * Traverses ALL edge types up to the given depth.
 */
export async function exploreTopology(
    nodeId: string,
    depth: number = 2,
): Promise<TopologyResult> {
    const result = await run(
        `MATCH (start {id: $nodeId})
     CALL apoc.path.subgraphAll(start, {maxLevel: $depth})
     YIELD nodes, relationships
     RETURN nodes, relationships`,
        { nodeId, depth },
    );

    if (result.records.length === 0) {
        // Fallback: try matching by name instead of id
        const fallback = await run(
            `MATCH (start {name: $nodeId})
       CALL apoc.path.subgraphAll(start, {maxLevel: $depth})
       YIELD nodes, relationships
       RETURN nodes, relationships`,
            { nodeId, depth },
        );

        if (fallback.records.length === 0) {
            return { nodes: [], edges: [] };
        }

        return extractTopology(fallback);
    }

    return extractTopology(result);
}

function extractTopology(result: { records: Array<{ get: (key: string) => unknown }> }): TopologyResult {
    const record = result.records[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawNodes = record.get('nodes') as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawRels = record.get('relationships') as any[];

    const nodes: TopologyNode[] = rawNodes.map(n => ({
        id: n.properties.id ?? n.properties.name ?? n.identity.toString(),
        labels: n.labels,
        properties: Object.fromEntries(
            Object.entries(n.properties).filter(([k]) => k !== 'embedding'),
        ),
    }));

    const edges: TopologyEdge[] = rawRels.map(r => ({
        source: r.startNodeElementId,
        target: r.endNodeElementId,
        type: r.type,
        properties: r.properties,
    }));

    return { nodes, edges };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Service Topology (Doc Generator)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract the full "Blast Radius" topology for a given service.
 * Returns functions, outbound dependencies, and inbound consumers.
 */
export async function getServiceTopology(serviceName: string): Promise<ServiceTopology> {
    // 1) Functions owned by the service
    const fnResult = await run(
        `MATCH (s:Service {name: $serviceName})-[:CONTAINS]->(f:Function)
         WHERE s.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
     RETURN f.id AS id, f.name AS name, f.filepath AS filepath, f.intent AS intent`,
        { serviceName },
    );

    const functions: ServiceTopologyFunction[] = fnResult.records.map(r => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        filepath: r.get('filepath') as string,
        intent: r.get('intent') as string | null,
    }));

    // 2) Outbound: resources reached by our functions (DataContainer, Datastore, MessageChannel, SystemProcess)
    const outResult = await run(
        `MATCH (s:Service {name: $serviceName})-[:CONTAINS]->(f:Function)
         WHERE s.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
     OPTIONAL MATCH (f)-[r1:READS|WRITES|MAPS_TO]->(dt:DataContainer) WHERE r1.valid_to_commit IS NULL AND dt.valid_to_commit IS NULL
     OPTIONAL MATCH (f)-[r2:CONNECTS_TO]->(ds:Datastore) WHERE r2.valid_to_commit IS NULL AND ds.valid_to_commit IS NULL
     OPTIONAL MATCH (f)-[r3:PUBLISHES_TO|LISTENS_TO]->(broker:MessageChannel) WHERE r3.valid_to_commit IS NULL AND broker.valid_to_commit IS NULL
     OPTIONAL MATCH (f)-[r4:SPAWNS]->(sp:SystemProcess) WHERE r4.valid_to_commit IS NULL AND sp.valid_to_commit IS NULL
     WITH f,
          COALESCE(dt.name, ds.name, broker.name, sp.name) AS resourceName,
          CASE
            WHEN dt IS NOT NULL THEN 'DataContainer'
            WHEN ds IS NOT NULL THEN 'Datastore'
            WHEN broker IS NOT NULL THEN 'MessageChannel'
            WHEN sp IS NOT NULL THEN 'SystemProcess'
          END AS resourceType
     WHERE resourceName IS NOT NULL
     RETURN f.name AS functionName,
            resourceName AS logicalResource,
            null AS physicalResource,
            resourceType AS resourceType`,
        { serviceName },
    );

    const outbound: OutboundDependency[] = outResult.records.map(r => ({
        functionName: r.get('functionName') as string,
        logicalResource: r.get('logicalResource') as string,
        physicalResource: r.get('physicalResource') as string | null,
        resourceType: r.get('resourceType') as string,
    }));

    // 3) Inbound: external functions that CALL our functions or share a DataContainer
    const inResult = await run(
        `MATCH (s:Service {name: $serviceName})-[:CONTAINS]->(f:Function)
         WHERE s.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
     OPTIONAL MATCH (extF:Function)-[r1:CALLS]->(f) WHERE extF.valid_to_commit IS NULL AND r1.valid_to_commit IS NULL
     OPTIONAL MATCH (extS:Service)-[r2:CONTAINS]->(extF) WHERE extS.valid_to_commit IS NULL AND r2.valid_to_commit IS NULL AND extS.name <> $serviceName
     RETURN extS.name AS externalService,
            extF.name AS externalFunction,
            'CALLS' AS relationship,
            null AS sharedResource

     UNION

     MATCH (s:Service {name: $serviceName})-[:CONTAINS]->(f:Function)-[r1:READS|WRITES|MAPS_TO]->(dt:DataContainer)
     WHERE s.valid_to_commit IS NULL AND f.valid_to_commit IS NULL AND r1.valid_to_commit IS NULL AND dt.valid_to_commit IS NULL
     MATCH (extF:Function)-[r2:READS|WRITES|MAPS_TO]->(dt) WHERE extF.valid_to_commit IS NULL AND r2.valid_to_commit IS NULL
     MATCH (extS:Service)-[r3:CONTAINS]->(extF) WHERE extS.valid_to_commit IS NULL AND r3.valid_to_commit IS NULL AND extS.name <> $serviceName
     RETURN DISTINCT extS.name AS externalService,
            extF.name AS externalFunction,
            'SHARED_RESOURCE' AS relationship,
            dt.name AS sharedResource`,
        { serviceName },
    );

    const inbound: InboundConsumer[] = inResult.records
        .filter(r => r.get('externalService') != null)
        .map(r => ({
            externalService: r.get('externalService') as string,
            externalFunction: r.get('externalFunction') as string,
            relationship: r.get('relationship') as string,
            sharedResource: r.get('sharedResource') as string | null,
        }));

    // 4) Exposed endpoints: all live APIEndpoint nodes reachable from this service.
    //    Two paths, deduplicated in JS by method+path (OpenAPI wins via lower priority integer).
    //
    //    Path A — EXPOSES_API → APIInterface → HAS_ENDPOINT → APIEndpoint (priority 0, OpenAPI-sourced)
    //    Path B — CONTAINS → Function → IMPLEMENTS_ENDPOINT → APIEndpoint (priority 1, code-inferred)
    //    JS dedup: when both exist for the same method+path, Path A (OpenAPI) wins.
    const epResult = await run(
        `MATCH (s:Service {name: $serviceName})-[:EXPOSES_API]->(api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
         WHERE s.valid_to_commit IS NULL AND api.valid_to_commit IS NULL AND ep.valid_to_commit IS NULL
         RETURN ep.id AS urn, ep.method AS method, ep.path AS path,
                ep.operationId AS operationId, ep.summary AS summary,
                api.title AS apiTitle,
                0 AS priority

         UNION

         MATCH (s:Service {name: $serviceName})-[:CONTAINS]->(f:Function)-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint)
         WHERE s.valid_to_commit IS NULL AND f.valid_to_commit IS NULL AND ep.valid_to_commit IS NULL
         RETURN ep.id AS urn, ep.method AS method, ep.path AS path,
                ep.operationId AS operationId, ep.summary AS summary,
                null AS apiTitle,
                1 AS priority`,
        { serviceName },
    );

    // Deduplicate by method+path, keeping the lower-priority (OpenAPI) entry when both exist
    const epMap = new Map<string, ExposedEndpoint>();
    for (const r of epResult.records) {
        const key = `${r.get('method')}:${r.get('path')}`;
        const priority = (r.get('priority') as any)?.toNumber?.() ?? r.get('priority') ?? 1;
        if (!epMap.has(key) || priority < (epMap.get(key) as any)._priority) {
            epMap.set(key, {
                urn: r.get('urn') as string,
                method: r.get('method') as string,
                path: r.get('path') as string,
                operationId: r.get('operationId') as string | null,
                summary: r.get('summary') as string | null,
                apiTitle: r.get('apiTitle') as string | null,
                _priority: priority,
            } as ExposedEndpoint & { _priority: number });
        }
    }

    const exposedEndpoints: ExposedEndpoint[] = [...epMap.values()]
        .sort((a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path))
        .map(({ ...ep }) => {
            const { _priority, ...clean } = ep as ExposedEndpoint & { _priority: number };
            return clean;
        });

    return { serviceName, functions, outbound, inbound, exposedEndpoints };
}

/**
 * List all services available in the graph.
 * Returns id (URN), name, and description.
 */
export async function getAllServices(): Promise<Array<{ id: string; name: string; description: string | null }>> {
    const result = await run(
        `MATCH (s:Service)
     WHERE s.valid_to_commit IS NULL
     RETURN s.id AS id, s.name AS name, s.description AS description
     ORDER BY s.name ASC`,
    );

    return result.records.map(r => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        description: r.get('description') as string | null,
    }));
}

/**
 * Execute a generic read-only Cypher query and return the raw records as objects.
 * Ensure the query only does MATCH / RETURN.
 */
export async function runGenericQuery(query: string, params: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
    const session = getMemgraphSession();
    try {
        const result = await session.executeRead(async (tx) => {
            return await tx.run(query, params);
        });
        return result.records.map(r => r.toObject());
    } finally {
        await session.close();
    }
}
