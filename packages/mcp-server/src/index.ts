import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface ServiceContextHints {
    filePath?: string | undefined;
    repositoryUrl?: string | undefined;
    repositoryName?: string | undefined;
}

export interface GetDataContractInput {
    structureUrn?: string;
    schemaName?: string;
    scopeKey?: string;
}

export interface McpRepository {
    getDataContract(input: GetDataContractInput | string): Promise<any>;
    analyzeBlastRadius(resourceName: string): Promise<any>;
    traceDataLineage(fieldName: string): Promise<any>;
    resolveServiceContext(hints: ServiceContextHints): Promise<any>;
    listServices(limit?: number, offset?: number): Promise<any>;
    getServiceDetails(serviceName: string): Promise<any>;
    getRepositoryDetails?(repositoryName: string): Promise<any>;
    analyzeArchitectureGravity(): Promise<any>;
    analyzeAgenticContext(): Promise<any>;
    evaluateCodeChangeBlast?(input: {
        prTitle?: string | undefined;
        changedFiles: { path: string; proposedContent: string }[];
    }): Promise<any>;
}

// ─── Tool Registration ──────────────────────────────────────────────────────

/**
 * Registers all CodeRadius MCP tools on the given server instance,
 * using the provided repository for data access.
 */
function registerTools(server: McpServer, repo: McpRepository) {
    server.registerTool(
        "get_data_contract",
        {
            description: "Use this tool to get the exact data schema (fields and types) of a payload, event, or database table. Always use it before modifying a JSON or a query to understand what other services expect. After Phase 1A URN scoping, the same schemaName may map to multiple emergent DataStructures (different services). Pass `structureUrn` (preferred) OR `schemaName` + `scopeKey` to disambiguate; `schemaName` alone returns a best-effort single result with `structureUrn`/`scopeKey` populated so you can re-query with precision.",
            inputSchema: {
                schemaName: z.string().optional().describe("The name of the data schema (e.g. 'OrderCreatedEvent'). Ambiguous after URN scoping — prefer structureUrn for precision."),
                structureUrn: z.string().optional().describe("Exact DataStructure URN (e.g. `cr:schema:message_payload:acme:orders:OrderCreatedEvent`). Precise."),
                scopeKey: z.string().optional().describe("Bounded-context scope (e.g. `acme:orders`). Combined with schemaName for scoped lookup."),
            },
        },
        async ({ schemaName, structureUrn, scopeKey }) => {
            try {
                if (schemaName == null && structureUrn == null) {
                    return {
                        content: [{ type: "text", text: "Error: provide schemaName or structureUrn." }],
                        isError: true,
                    };
                }
                const fields = await repo.getDataContract({ schemaName, structureUrn, scopeKey });
                const jsonString = JSON.stringify(fields, null, 2);
                const label = structureUrn ?? schemaName ?? '(unknown)';
                return {
                    content: [{ type: "text", text: `Data Contract for ${label}:\n${jsonString}` }]
                };
            } catch (error: any) {
                console.error("Error executing get_data_contract:", error);
                return {
                    content: [{ type: "text", text: `Error executing query: ${error.message}` }],
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        "analyze_blast_radius",
        {
            description: "Calculate the single-hop Blast Radius of a resource (DataTable, MessageChannel, APIEndpoint). Returns upstream producers and downstream consumers. It handles fuzzy matching, so you can pass names like 'orders'. If it returns a 'warning' about ambiguity, read the available URNs and call this tool again with the exact URN.",
            inputSchema: {
                resourceName: z.string().describe("The name or URN of the resource"),
            },
        },
        async ({ resourceName }) => {
            try {
                const result = await repo.analyzeBlastRadius(resourceName);
                const jsonString = JSON.stringify(result, null, 2);
                return {
                    content: [{ type: "text", text: `Blast Radius for ${resourceName}:\n${jsonString}` }]
                };
            } catch (error: any) {
                console.error("Error executing analyze_blast_radius:", error);
                return {
                    content: [{ type: "text", text: `Error executing query: ${error.message}` }],
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        "trace_data_lineage",
        {
            description: "Trace the multi-hop semantic journey of a specific DataField (e.g., 'email', 'customerId') across the microservice ecosystem. It checks if the field survives across MessageChannels and APIs. If it returns a 'warning' about ambiguity, read the available URNs and call this tool again with the exact URN.",
            inputSchema: {
                fieldName: z.string().describe("The name or URN of the data field to trace"),
            },
        },
        async ({ fieldName }) => {
            try {
                const result = await repo.traceDataLineage(fieldName);
                const jsonString = JSON.stringify(result, null, 2);
                return {
                    content: [{ type: "text", text: `Data Lineage for '${fieldName}':\n${jsonString}` }]
                };
            } catch (error: any) {
                console.error("Error executing trace_data_lineage:", error);
                return {
                    content: [{ type: "text", text: `Error executing query: ${error.message}` }],
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        "resolve_service_context",
        {
            description: "Identify which service you are currently working in. Pass a file path from your workspace (e.g. 'apps/checkout/src/handler.ts'), a git remote URL, or a repository name. Returns the matched service with its team owner, repository, and language. Use this FIRST before calling any other tool.",
            inputSchema: {
                filePath: z.string().optional().describe("A file path from the workspace (relative or absolute). The tool will match path segments against known services."),
                repositoryUrl: z.string().optional().describe("The git remote URL of the repository (e.g. 'github.com/org/repo')"),
                repositoryName: z.string().optional().describe("The name of the repository"),
            },
        },
        async ({ filePath, repositoryUrl, repositoryName }) => {
            try {
                const result = await repo.resolveServiceContext({ filePath, repositoryUrl, repositoryName });
                const jsonString = JSON.stringify(result, null, 2);
                return {
                    content: [{ type: "text", text: result.length > 0
                        ? `Resolved service context:\n${jsonString}`
                        : `No service found matching the given hints. Use list_services to browse all available services.` }]
                };
            } catch (error: any) {
                console.error("Error executing resolve_service_context:", error);
                return {
                    content: [{ type: "text", text: `Error resolving service context: ${error.message}` }],
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        "list_services",
        {
            description: "List all services in the architecture graph with their unique id, team owner, repository (name + URL), languages, indexed function count, and deployment topology. Services with deploymentUnitCount > 0 are monoliths with multiple runtime facets (use get_service_details to see their names). Supports pagination using limit and offset.",
            inputSchema: {
                limit: z.number().int().min(1).max(200).optional().describe("Number of services to return (default 50)"),
                offset: z.number().int().min(0).optional().describe("Number of services to skip (default 0)")
            },
        },
        async (args) => {
            try {
                const limit = (args as any).limit as number | undefined;
                const offset = (args as any).offset as number | undefined;
                const services = await repo.listServices(limit, offset);
                const jsonString = JSON.stringify(services, null, 2);
                return {
                    content: [{ type: "text", text: `Available services:\n${jsonString}` }]
                };
            } catch (error: any) {
                console.error("Error executing list_services:", error);
                return {
                    content: [{ type: "text", text: `Error listing services: ${error.message}` }],
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        "get_service_details",
        {
            description: "Get detailed information about a specific service including its unique id, team owner, repository (name + URL), detected languages, exposed APIs with endpoint counts, indexed function count, deployment units (runtime facets for monolith services), and infrastructure details (CI/CD pipelines, Docker images, tool configurations, build tasks). Use this after identifying the service with resolve_service_context or list_services. To explore an API's endpoints, use get_data_contract with the API title from the exposedApis hint. To explore the repository's full governance posture, use get_repository_details.",
            inputSchema: {
                serviceName: z.string().describe("The exact name of the service"),
            },
        },
        async ({ serviceName }) => {
            try {
                const details = await repo.getServiceDetails(serviceName);
                const jsonString = JSON.stringify(details, null, 2);
                return {
                    content: [{ type: "text", text: details
                        ? `Service details for '${serviceName}':\n${jsonString}`
                        : `Service '${serviceName}' not found. Use list_services to browse available services.` }]
                };
            } catch (error: any) {
                console.error("Error executing get_service_details:", error);
                return {
                    content: [{ type: "text", text: `Error getting service details: ${error.message}` }],
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        "get_repository_details",
        {
            description: "Get detailed information about a repository including its services, CI/CD pipelines, Docker images, tool configurations (tsconfig, renovate, etc.), and build tasks. Use this to understand the operational posture and governance compliance of a repository. Also returns liveness metrics (commit activity) and scan mode.",
            inputSchema: {
                repositoryName: z.string().describe("The exact name of the repository"),
            },
        },
        async ({ repositoryName }) => {
            try {
                if (!repo.getRepositoryDetails) {
                    throw new Error("This MCP server does not support get_repository_details.");
                }
                const details = await repo.getRepositoryDetails(repositoryName);
                const jsonString = JSON.stringify(details, null, 2);
                return {
                    content: [{ type: "text", text: details
                        ? `Repository details for '${repositoryName}':\n${jsonString}`
                        : `Repository '${repositoryName}' not found.` }]
                };
            } catch (error: any) {
                console.error("Error executing get_repository_details:", error);
                return {
                    content: [{ type: "text", text: `Error getting repository details: ${error.message}` }],
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        "analyze_architecture_gravity",
        {
            description: "Analyzes the entire architecture to find Single Points of Failure (SPOFs), shared database anti-patterns, and highly coupled services. Returns the top data monoliths (shared databases/brokers) and service bottlenecks ranked by SPOF score (0-100). When monolith services are involved, includes runtimeImpactedDUs showing how many deployment units would stop functioning. Use this to understand technical debt, advise on decoupling priorities, or assess architectural risk. No input required — this is a global scan.",
            inputSchema: {},
        },
        async () => {
            try {
                const result = await repo.analyzeArchitectureGravity();
                const jsonString = JSON.stringify(result, null, 2);
                return {
                    content: [{ type: "text", text: `Architecture Gravity Analysis:\n${jsonString}` }]
                };
            } catch (error: any) {
                console.error("Error executing analyze_architecture_gravity:", error);
                return {
                    content: [{ type: "text", text: `Error executing gravity analysis: ${error.message}` }],
                    isError: true
                };
            }
        }
    );
    server.registerTool(
        "analyze_agentic_context",
        {
            description: "Scans agentic context across the architecture: tools, configurations, skills, and workflows per repository. Returns the data powering the Agentic Context Radar dashboard.",
            inputSchema: {},
        },
        async () => {
            try {
                const report = await repo.analyzeAgenticContext();
                if (!report || !report.matrix || report.matrix.length === 0) {
                    return {
                        content: [{ type: "text", text: "No Agentic Config data found. Tell the user they need to run `cr ingest meta` first." }]
                    };
                }

                let markdown = '# Agentic Context Radar\n\n';
                markdown += '| Team | Repository | Tools Used | Configs | Skills | Workflows |\n';
                markdown += '|---|---|---|---|---|---|\n';

                for (const row of report.matrix) {
                    const toolsStr = Array.isArray(row.tools) && row.tools.length > 0 ? row.tools.join(', ') : 'None';
                    markdown += `| ${row.teamName} | ${row.repoName} | ${toolsStr} | ${row.configs} | ${row.skills} | ${row.workflows} |\n`;
                }
                
                return {
                    content: [{ type: "text", text: markdown }]
                };
            } catch (error: any) {
                console.error("Error executing analyze_agentic_context:", error);
                return {
                    content: [{ type: "text", text: `Error executing analyze_agentic_context: ${error.message}` }],
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        "evaluate_code_change_impact",
        {
            description: "Calculate the architectural Blast Radius (breaking changes, orphan resources) for a proposed code change before committing. It performs an in-memory topological diff of the changes without modifying the master graph.",
            inputSchema: {
                prTitle: z.string().optional().describe("A brief description of the overarching change, used as context for the AI analyzer."),
                changedFiles: z.array(z.object({
                    path: z.string().describe("The repo-relative path of the modified file."),
                    proposedContent: z.string().describe("The complete proposed new source code for this file.")
                })).describe("The list of changed files with their proposed new content."),
            },
        },
        async (input) => {
            try {
                if (!repo.evaluateCodeChangeBlast) {
                    throw new Error("This MCP server does not support evaluate_code_change_impact tool execution.");
                }
                const result = await repo.evaluateCodeChangeBlast(input);
                const strResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                return {
                    content: [{ type: "text", text: strResult }]
                };
            } catch (error: any) {
                console.error("Error executing evaluate_code_change_impact:", error);
                return {
                    content: [{ type: "text", text: `Error evaluating change impact: ${error.message}` }],
                    isError: true
                };
            }
        }
    );
}

// ─── Server Factory & Startup ───────────────────────────────────────────────

/**
 * Creates a fully configured MCP server with all CodeRadius tools registered.
 * Use this for testing (connect with an in-memory transport) or for custom setups.
 */
export function createCodeRadiusMcpServer(repository: McpRepository): McpServer {
    const server = new McpServer({
        name: "radius",
        version: "1.0.0",
    });
    registerTools(server, repository);
    return server;
}

/**
 * Creates a CodeRadius MCP server, connects it to stdio, and starts serving.
 * This is the production entry point used by `cr mcp`.
 */
export async function startMcpServer(repository: McpRepository) {
    const server = createCodeRadiusMcpServer(repository);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("CodeRadius MCP Server running on stdio");

    const cleanup = async () => {
        console.error("Shutting down MCP server...");
        await server.close();
    };

    process.once("SIGINT", async () => {
        await cleanup();
        process.exit(0);
    });

    process.once("SIGTERM", async () => {
        await cleanup();
        process.exit(0);
    });
}
