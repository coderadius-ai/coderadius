/**
 * MCP Server Integration Test
 *
 * Tests the full round-trip: Client ←→ InMemoryTransport ←→ McpServer ←→ MockRepository
 *
 * This verifies that:
 * 1. All 6 tools are registered and discoverable
 * 2. Tool calls correctly invoke the repository and return formatted responses
 * 3. Error handling works when the repository throws
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { type McpRepository, type ServiceContextHints } from '../../../packages/mcp-server/src/index.js';

// Re-export type if needed or just import it from the repository since mcp-server package isn't linked for imports in this test environment usually
// Actually, it was using @coderadius/mcp-server package export. Let's see if we can still use it or if we need absolute path.
// The original was: import { ... } from '@coderadius/mcp-server';
// In the current setup it might be better to import from src/index.ts of the package if package resolution is tricky in vitest
import { createCodeRadiusMcpServer as createServer } from '../../../packages/mcp-server/src/index.js';

// ─── InMemoryTransport ──────────────────────────────────────────────────────
// A linked pair of transports that pipe messages directly between client and server.
// No stdio, no sockets, no network — pure in-process message passing.

function createLinkedTransportPair(): [Transport, Transport] {
    let transportA: Transport;
    let transportB: Transport;

    transportA = {
        async start() { },
        async send(message: JSONRPCMessage, _options?: TransportSendOptions) {
            // When A sends, B receives
            transportB.onmessage?.(message);
        },
        async close() {
            transportA.onclose?.();
        },
    };

    transportB = {
        async start() { },
        async send(message: JSONRPCMessage, _options?: TransportSendOptions) {
            // When B sends, A receives
            transportA.onmessage?.(message);
        },
        async close() {
            transportB.onclose?.();
        },
    };

    return [transportA, transportB];
}

// ─── Mock Repository ────────────────────────────────────────────────────────

function createMockRepository(): McpRepository {
    return {
        async getDataContract(input: { schemaName?: string; structureUrn?: string } | string) {
            const schemaName = typeof input === 'string' ? input : (input.schemaName ?? input.structureUrn ?? '');
            if (schemaName === 'OrderPayload') {
                return {
                    schemaFields: [
                        { source: 'schema', name: 'order_id', type: 'string', required: true },
                        { source: 'schema', name: 'amount', type: 'number', required: true },
                        { source: 'schema', name: 'currency', type: 'string', required: false },
                    ],
                    endpointContracts: [],
                };
            }
            return { schemaFields: [], endpointContracts: [] };
        },

        async analyzeBlastRadius(resourceName: string) {
            if (resourceName === 'order-events') {
                return {
                    target: { urn: 'cr://channel/order-events', name: 'order-events', type: 'MessageChannel' },
                    downstreamBlasts: [{
                        serviceName: 'notification-service',
                        serviceUrn: 'cr://service/notification-service',
                        teamOwner: 'platform-team',
                        relationships: ['LISTENS_TO'],
                        functions: [{ name: 'handleOrderEvent', file: 'src/handlers/order.ts' }],
                        repository: { name: 'ecommerce-monorepo', url: 'https://github.com/org/ecommerce-monorepo' },
                    }],
                    upstreamBlasts: [{
                        serviceName: 'checkout-service',
                        serviceUrn: 'cr://service/checkout-service',
                        teamOwner: 'payments-team',
                        relationships: ['PUBLISHES_TO'],
                        functions: [{ name: 'publishOrder', file: 'src/publishers/order.ts' }],
                        repository: { name: 'ecommerce-monorepo', url: 'https://github.com/org/ecommerce-monorepo' },
                    }],
                    summary: { blastRadiusScore: 4, factors: {}, teamsInvolved: ['platform-team', 'payments-team'] },
                };
            }
            if (resourceName === 'ambiguous') {
                return {
                    warning: 'Ambiguous resource name. Multiple matches found.',
                    availableTargets: ['cr://datacontainer/ambiguous-a', 'cr://channel/ambiguous-b'],
                };
            }
            return { error: 'Resource not found' };
        },

        async traceDataLineage(fieldName: string) {
            if (fieldName === 'email') {
                return {
                    targetField: { urn: 'cr://schema/message_payload/UserPayload/field/email', name: 'email', structure: 'UserPayload' },
                    journey: [
                        { serviceName: 'user-service', functionName: 'createUser', action: 'PRODUCES', bridgeResource: { name: 'user-events', type: 'MessageChannel' }, structureName: 'UserPayload' },
                        { serviceName: 'notification-service', functionName: 'sendWelcome', action: 'CONSUMES', bridgeResource: null, structureName: 'UserPayload' },
                    ],
                    summary: { servicesTraversed: 2, totalHops: 2, requiresDeepScan: false },
                };
            }
            if (fieldName === 'ambiguous_field') {
                return {
                    warning: 'Ambiguous field name. Multiple matches found.',
                    availableTargets: [
                        'cr://schema/message_payload/OrderPayload/field/id (in OrderPayload)',
                        'cr://schema/message_payload/UserPayload/field/id (in UserPayload)',
                    ],
                };
            }
            return { error: 'Data Field not found' };
        },

        async resolveServiceContext(hints: ServiceContextHints) {
            if (hints.filePath?.includes('checkout')) {
                return [{
                    name: 'checkout-service',
                    language: 'typescript',
                    description: 'Handles checkout flow',
                    team: 'payments-team',
                    repository: 'ecommerce-monorepo',
                    repositoryUrl: 'https://github.com/org/ecommerce-monorepo',
                    pathInRepo: 'services/checkout',
                }];
            }
            if (hints.repositoryName === 'ecommerce-monorepo') {
                return [
                    { name: 'checkout-service', language: 'typescript', team: 'payments-team' },
                    { name: 'notification-service', language: 'typescript', team: 'platform-team' },
                ];
            }
            return [];
        },

        async listServices() {
            return [
                { id: 'cr://service/checkout-service', name: 'checkout-service', languages: ['typescript'], description: 'Checkout flow', team: 'payments-team', repository: { name: 'ecommerce-monorepo', url: 'https://github.com/org/ecommerce-monorepo' }, indexedFunctionCount: 25 },
                { id: 'cr://service/notification-service', name: 'notification-service', languages: ['typescript'], description: 'Notifications', team: 'platform-team', repository: { name: 'ecommerce-monorepo', url: null }, indexedFunctionCount: 5 },
                { id: 'cr://service/user-service', name: 'user-service', languages: ['go'], description: 'User management', team: 'identity-team', repository: { name: 'user-service', url: null }, indexedFunctionCount: 10 },
            ];
        },

        async getServiceDetails(serviceName: string) {
            if (serviceName === 'api') {
                return {
                    warning: 'Ambiguous service name. Multiple matches found.',
                    availableTargets: [
                        'cr://service/info-products:api (in info-products)',
                        'cr://service/acme-platform:api (in electronics/core/acme-platform)',
                    ],
                };
            }
            if (serviceName === 'checkout-service') {
                return {
                    id: 'cr://service/checkout-service',
                    name: 'checkout-service',
                    description: 'Handles checkout flow',
                    team: 'payments-team',
                    languages: ['typescript'],
                    repository: {
                        name: 'ecommerce-monorepo',
                        url: 'https://github.com/org/ecommerce-monorepo',
                        pathInRepo: 'services/checkout',
                    },
                    exposedApis: [{
                        title: 'Checkout API',
                        version: '1.0.0',
                        endpointCount: 3,
                        hint: 'Use get_data_contract("Checkout API") to explore endpoints and schemas',
                    }],
                    indexedFunctionCount: 25,
                };
            }
            return null;
        },

        async analyzeArchitectureGravity() {
            return {
                dataMonoliths: [],
                serviceBottlenecks: [],
            };
        },
        async analyzeAgenticContext() {
            return {
                matrix: [],
                mcpCensus: [],
                duplicates: [],
                capabilityCoverage: [],
                catalog: [],
                semanticDuplicates: [],
                techBlindspots: [],
                skillRecommendations: [],
                teamAliasProposals: [],
            };
        },
        async getRepositoryDetails(repositoryName: string) {
            if (repositoryName === 'ecommerce-monorepo') {
                return {
                    name: 'ecommerce-monorepo',
                    url: 'https://github.com/org/ecommerce-monorepo',
                    branch: 'main',
                    scanMode: 'fast',
                    livenessCommits: 120,
                    fileCount: 55,
                    services: [
                        { name: 'checkout-service', language: 'typescript', team: 'payments-team' },
                        { name: 'notification-service', language: 'typescript', team: 'platform-team' },
                    ],
                    infrastructure: {
                        ciPipelines: [{ tool: 'gitlab-ci', filePath: '.gitlab-ci.yml', hasTestStage: true, hasDeployStage: true, jobCount: 5 }],
                        dockerImages: [{ name: 'node', tag: '20-alpine', filePath: 'Dockerfile' }],
                        toolConfigs: [{ tool: 'TypeScript', filePath: 'tsconfig.json' }],
                        tasks: [{ name: 'build', runner: 'makefile' }, { name: 'test', runner: 'makefile' }],
                    },
                };
            }
            return null;
        },
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCP Server (In-Memory Round Trip)', () => {
    let client: Client;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        const mockRepo = createMockRepository();
        const server = createServer(mockRepo); // Using renamed factory from package

        const [clientTransport, serverTransport] = createLinkedTransportPair();

        // Connect server to its side of the transport
        await server.connect(serverTransport);

        // Connect client to its side
        client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);

        cleanup = async () => {
            await client.close();
            await server.close();
        };
    });

    afterAll(async () => {
        await cleanup();
    });

    // ── Tool Discovery ──────────────────────────────────────────────────────

    it('should list all registered tools', async () => {
        const result = await client.listTools();
        const toolNames = result.tools.map(t => t.name).sort();

        expect(toolNames).toEqual([
            'analyze_agentic_context',
            'analyze_architecture_gravity',
            'analyze_blast_radius',
            'evaluate_code_change_impact',
            'get_data_contract',
            'get_repository_details',
            'get_service_details',
            'list_services',
            'resolve_service_context',
            'trace_data_lineage',
        ]);
    });

    it('every tool should have a non-empty description', async () => {
        const result = await client.listTools();
        for (const tool of result.tools) {
            expect(tool.description, `Tool '${tool.name}' has no description`).toBeTruthy();
        }
    });

    // ── Service Discovery Tools ─────────────────────────────────────────────

    it('resolve_service_context — should resolve by file path', async () => {
        const result = await client.callTool({ name: 'resolve_service_context', arguments: { filePath: 'services/checkout/src/handler.ts' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('Resolved service context');
        expect(text).toContain('checkout-service');
        expect(text).toContain('payments-team');
    });

    it('resolve_service_context — should resolve by repository name', async () => {
        const result = await client.callTool({ name: 'resolve_service_context', arguments: { repositoryName: 'ecommerce-monorepo' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('checkout-service');
        expect(text).toContain('notification-service');
    });

    it('resolve_service_context — returns fallback message when nothing matches', async () => {
        const result = await client.callTool({ name: 'resolve_service_context', arguments: { filePath: 'unknown/path/file.ts' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('No service found');
        expect(text).toContain('list_services');
    });

    it('list_services — should return all services', async () => {
        const result = await client.callTool({ name: 'list_services', arguments: {} });
        const text = (result as any).content[0].text;

        expect(text).toContain('checkout-service');
        expect(text).toContain('notification-service');
        expect(text).toContain('user-service');
    });

    it('get_service_details — should return full service info', async () => {
        const result = await client.callTool({ name: 'get_service_details', arguments: { serviceName: 'checkout-service' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('checkout-service');
        expect(text).toContain('payments-team');
        expect(text).toContain('Checkout API');
        expect(text).toContain('endpointCount');
        expect(text).toContain('indexedFunctionCount');
        expect(text).toContain('ecommerce-monorepo');
        expect(text).toContain('cr://service/checkout-service');
    });

    it('get_service_details — returns fallback for unknown service', async () => {
        const result = await client.callTool({ name: 'get_service_details', arguments: { serviceName: 'nonexistent' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('not found');
    });

    it('get_service_details — returns ambiguity warning instead of first match', async () => {
        const result = await client.callTool({ name: 'get_service_details', arguments: { serviceName: 'api' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('Ambiguous service name');
        expect(text).toContain('cr://service');
    });

    // ── Repository Details ───────────────────────────────────────────────────

    it('get_repository_details — should return full repo info with infrastructure', async () => {
        const result = await client.callTool({ name: 'get_repository_details', arguments: { repositoryName: 'ecommerce-monorepo' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('ecommerce-monorepo');
        expect(text).toContain('checkout-service');
        expect(text).toContain('notification-service');
        expect(text).toContain('gitlab-ci');
        expect(text).toContain('node');
        expect(text).toContain('TypeScript');
        expect(text).toContain('build');
        expect(text).toContain('test');
    });

    it('get_repository_details — returns fallback for unknown repo', async () => {
        const result = await client.callTool({ name: 'get_repository_details', arguments: { repositoryName: 'nonexistent' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('not found');
    });

    // ── Data Contract ───────────────────────────────────────────────────────

    it('get_data_contract — should return schema fields', async () => {
        const result = await client.callTool({ name: 'get_data_contract', arguments: { schemaName: 'OrderPayload' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('order_id');
        expect(text).toContain('amount');
        expect(text).toContain('currency');
    });

    // ── Blast Radius (with disambiguation) ──────────────────────────────────

    it('analyze_blast_radius — should return downstream and upstream', async () => {
        const result = await client.callTool({ name: 'analyze_blast_radius', arguments: { resourceName: 'order-events' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('downstreamBlasts');
        expect(text).toContain('upstreamBlasts');
        expect(text).toContain('notification-service');
        expect(text).toContain('checkout-service');
        expect(text).toContain('platform-team');
        expect(text).toContain('payments-team');
        expect(text).toContain('ecommerce-monorepo');
    });

    it('analyze_blast_radius — returns error for unknown resource', async () => {
        const result = await client.callTool({ name: 'analyze_blast_radius', arguments: { resourceName: 'nonexistent' } });
        const text = (result as any).content[0].text;

        const parsed = JSON.parse(text.replace(/^Blast Radius for nonexistent:\n/, ''));
        expect(parsed.error).toBe('Resource not found');
    });

    it('analyze_blast_radius — returns disambiguation warning for ambiguous names', async () => {
        const result = await client.callTool({ name: 'analyze_blast_radius', arguments: { resourceName: 'ambiguous' } });
        const text = (result as any).content[0].text;

        const parsed = JSON.parse(text.replace(/^Blast Radius for ambiguous:\n/, ''));
        expect(parsed.warning).toContain('Ambiguous');
        expect(parsed.availableTargets).toHaveLength(2);
    });

    // ── Data Lineage ────────────────────────────────────────────────────────

    it('trace_data_lineage — should return multi-hop journey', async () => {
        const result = await client.callTool({ name: 'trace_data_lineage', arguments: { fieldName: 'email' } });
        const text = (result as any).content[0].text;

        expect(text).toContain('email');
        expect(text).toContain('user-service');
        expect(text).toContain('notification-service');
        expect(text).toContain('UserPayload');
        expect(text).toContain('user-events');
        expect(text).toContain('servicesTraversed');
    });

    it('trace_data_lineage — returns error for unknown field', async () => {
        const result = await client.callTool({ name: 'trace_data_lineage', arguments: { fieldName: 'nonexistent_field' } });
        const text = (result as any).content[0].text;

        const parsed = JSON.parse(text.replace(/^Data Lineage for 'nonexistent_field':\n/, ''));
        expect(parsed.error).toBe('Data Field not found');
    });

    it('trace_data_lineage — returns disambiguation warning for ambiguous fields', async () => {
        const result = await client.callTool({ name: 'trace_data_lineage', arguments: { fieldName: 'ambiguous_field' } });
        const text = (result as any).content[0].text;

        const parsed = JSON.parse(text.replace(/^Data Lineage for 'ambiguous_field':\n/, ''));
        expect(parsed.warning).toContain('Ambiguous');
        expect(parsed.availableTargets).toHaveLength(2);
        // Should include structure name for context
        expect(parsed.availableTargets[0]).toContain('(in ');
    });
});
