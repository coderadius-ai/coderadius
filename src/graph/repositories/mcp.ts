/**
 * Neo4j MCP Repository — Thin Adapter
 *
 * Zero-Cypher implementation of McpRepository.
 * Every method delegates to the shared CQRS query layer under `queries/`.
 * Blast radius and lineage include LLM-friendly disambiguation logic.
 */

import { McpRepository, ServiceContextHints } from '@coderadius/mcp-server';
import { resolveResource, analyzeBlast } from '../queries/blast.js';
import { resolveDataField, analyzeLineage } from '../queries/lineage.js';
import { resolveServiceContext, listServices, getServiceDetails, getRepositoryDetails } from '../queries/services.js';
import { getDataContract } from '../queries/contracts.js';
import { analyzeGravity } from '../application/gravity.service.js';
import { evaluateCodeChangeBlast } from '../../mcp/tools/evaluate-change.js';
import { getAgentHarnessReport } from '../mutations/agentic.js';

export class Neo4jMcpRepository implements McpRepository {

    // ─── Service Discovery (pure delegation) ─────────────────────────────────

    async resolveServiceContext(hints: ServiceContextHints) {
        return resolveServiceContext(hints);
    }

    async listServices(limit?: number, offset?: number) {
        return listServices(limit, offset);
    }

    async getServiceDetails(serviceName: string) {
        return getServiceDetails(serviceName);
    }

    async getRepositoryDetails(repositoryName: string) {
        return getRepositoryDetails(repositoryName);
    }

    // ─── Data Contract (pure delegation) ─────────────────────────────────────

    async getDataContract(input: import('../queries/contracts.js').GetDataContractInput | string) {
        return getDataContract(input);
    }

    // ─── Blast Analysis (delegation + disambiguation) ───────────────────────

    /**
     * Delegates to the shared query service with LLM-friendly disambiguation.
     * Forces the calling agent to pick the exact URN when the name is ambiguous.
     */
    async analyzeBlastRadius(resourceName: string) {
        const matches = await resolveResource(resourceName);

        if (matches.length === 0) {
            return { error: 'Resource not found' };
        }

        if (matches.length > 1) {
            return {
                warning: 'Ambiguous resource name. Multiple matches found.',
                availableTargets: matches.map(m => m.urn),
            };
        }

        return analyzeBlast(matches[0].urn);
    }

    // ─── Data Lineage (delegation + disambiguation) ──────────────────────────

    /**
     * Delegates to the lineage query service with LLM-friendly disambiguation.
     * Forces the calling agent to pick the exact URN when the field name is ambiguous.
     */
    async traceDataLineage(fieldName: string) {
        const matches = await resolveDataField(fieldName);

        if (matches.length === 0) {
            return { error: 'Data Field not found' };
        }

        if (matches.length > 1) {
            return {
                warning: 'Ambiguous field name. Multiple matches found.',
                availableTargets: matches.map(m => `${m.urn} (in ${m.structureName})`),
            };
        }

        return analyzeLineage(matches[0].urn);
    }

    // ─── Architecture Gravity (pure delegation) ──────────────────────────────

    /**
     * Delegates to the gravity application service.
     * Returns top 5 results for LLM context-window efficiency.
     */
    async analyzeArchitectureGravity() {
        return analyzeGravity({ limit: 5 });
    }

    // ─── Agentic Context Radar (pure delegation) ───────────────────────────
    async analyzeAgenticContext() {
        return getAgentHarnessReport();
    }

    // ─── Ephemeral Analysis (pure delegation) ───────────────────────────────

    /**
     * Evaluates the blast radius of a proposed code change without modifying
     * the graph, using an ephemeral in-memory extraction pipeline over a VFS.
     */
    async evaluateCodeChangeBlast(input: {
        prTitle?: string | undefined;
        changedFiles: { path: string; proposedContent: string }[];
    }) {
        return evaluateCodeChangeBlast(input);
    }
}
