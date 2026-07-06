import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { generateEmbedding } from '../embeddings.js';
import { exploreTopology as exploreTopologyQuery, runGenericQuery, vectorSearchFunctions } from '../../graph/mutations/search.js';

/**
 * semantic_search — Vectorize a natural language query and find the
 * top K most relevant Function nodes in the graph.
 */
export const semanticSearch = createTool({
    id: 'semantic_search',
    description: `Search the codebase graph using natural language. Takes a query string,
vectorizes it, and finds the most semantically similar functions across all services.
Use this to find relevant code when investigating a feature, dependency, or change impact.
Returns function names, file paths, intent summaries, and similarity scores.`,
    inputSchema: z.object({
        query: z.string().describe('Natural language query describing what you are looking for'),
        topK: z.coerce.number().min(1).max(20).optional().default(5).describe('Number of results to return (1-20)'),
    }),
    outputSchema: z.object({
        results: z.array(z.object({
            id: z.string(),
            name: z.string(),
            filepath: z.string(),
            intent: z.string(),
            score: z.number(),
        })),
        message: z.string(),
    }),
    execute: async (inputData) => {
        const { query, topK } = inputData as { query: string; topK?: number };

        // Embed the query text
        const embedding = await generateEmbedding(query);
        if (!embedding) {
            return {
                results: [],
                message: 'Failed to generate embedding for the query. Is Ollama running?',
            };
        }

        // Vector search in Neo4j
        const results = await vectorSearchFunctions(embedding, topK ?? 5);

        return {
            results,
            message: `Found ${results.length} matching function(s) for: "${query}"`,
        };
    },
});

/**
 * explore_topology — Given a node ID (function or service), traverse the
 * graph up to a specified depth and return the subgraph (blast radius).
 */
export const exploreTopology = createTool({
    id: 'explore_topology',
    description: `Explore the graph topology around a node to understand its blast radius.
Given a node ID or name, traverses all edge types (CONTAINS, CALLS, READS, WRITES, CONNECTS_TO,
PUBLISHES_TO, LISTENS_TO, SPAWNS, DEPENDS_ON, OWNS, OBSERVED_IN) up to the specified depth.
Use this after semantic_search to understand the full impact of a change.
Returns the subgraph as lists of nodes and edges.`,
    inputSchema: z.object({
        nodeId: z.string().describe('The ID or name of the node to start exploration from'),
        depth: z.coerce.number().min(1).max(3).optional().default(2).describe('How many hops to traverse (1-3)'),
    }),
    outputSchema: z.object({
        nodes: z.array(z.object({
            id: z.string(),
            labels: z.array(z.string()),
            properties: z.record(z.string(), z.unknown()),
        })).describe('Array of nodes to return containing properties'),
        edges: z.array(z.object({
            source: z.string(),
            target: z.string(),
            type: z.string(),
            properties: z.record(z.string(), z.unknown()),
        })),
        message: z.string(),
    }),
    execute: async (inputData) => {
        const { nodeId, depth } = inputData as { nodeId: string; depth?: number };

        const topology = await exploreTopologyQuery(nodeId, depth ?? 2);

        return {
            ...topology,
            message: `Explored topology for "${nodeId}" at depth ${depth ?? 2}: found ${topology.nodes.length} node(s) and ${topology.edges.length} edge(s).`,
        };
    },
});

/**
 * run_cypher_query — Execute a read-only Cypher query against the Neo4j graph.
 */
export const runCypherQuery = createTool({
    id: 'run_cypher_query',
    description: `Execute a read-only Cypher query against the codebase Neo4j graph.
Use this when you need specific metrics, aggregations, counts, or tailored lists that
aren't covered by semantic search or topology exploration.

The graph contains nodes like: Service, Function, APIEndpoint, APIInterface, Package, 
DataStructure, DataField, TraceSpan, Datastore, DatabaseEndpoint, DataContainer, MessageChannel, MessageBroker, SystemProcess, APIDeployment, Team, System.

Example queries:
- MATCH (s:Service) RETURN count(s) as count
- MATCH (ep:APIEndpoint) RETURN ep.method, ep.path

Use this tool responsibly and ONLY use read-only queries (MATCH, RETURN, WITH, etc.).
DO NOT run mutations (CREATE, MERGE, SET, DELETE, REMOVE, DROP).`,
    inputSchema: z.object({
        query: z.string().describe('The read-only Cypher query string to execute'),
    }),
    outputSchema: z.object({
        records: z.array(z.record(z.string(), z.unknown())),
        message: z.string(),
    }),
    execute: async (inputData) => {
        const { query } = inputData;

        // Basic check to prevent mutations
        const upperQuery = query.toUpperCase();
        if (
            upperQuery.includes('CREATE ') ||
            upperQuery.includes('MERGE ') ||
            upperQuery.includes('SET ') ||
            upperQuery.includes('DELETE ') ||
            upperQuery.includes('REMOVE ') ||
            upperQuery.includes('DROP ') ||
            upperQuery.includes('CALL apoc.')
        ) {
            console.error('[Agent Cypher Tool] Blocked mutation query.');
            return {
                records: [],
                message: 'Error: Only read-only queries (MATCH, RETURN, WITH) are allowed.',
            };
        }

        try {
            const result = await runGenericQuery(query);
            return {
                records: result,
                message: `Successfully executed query. Returned ${result.length} record(s).`,
            };
        } catch (error: any) {
            console.error(`[Agent Cypher Tool] Error: ${error.message}`);
            return {
                records: [],
                message: `Failed to execute query: ${error.message}`,
            };
        }
    },
});
