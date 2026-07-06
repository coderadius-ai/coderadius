/**
 * Dashboard Payload Types — CLI-side definitions.
 *
 * These mirror the types in packages/shared-types/index.ts.
 * They are defined here to avoid rootDir issues (the CLI's rootDir is `src/`).
 * The dashboard-ui frontend imports from @coderadius/shared-types instead.
 */

import type { AgentHarnessReport } from '../graph/mutations/agentic.js';
import type { DepsReport } from '../graph/queries/deps.js';
import type { GravityAnalysisResult, BlastAnalysisResult, LineageAnalysisResult } from '../graph/types.js';
import type { InventoryReport } from '../graph/queries/inventory.js';
import type { GovernanceReport } from '../graph/queries/governance.js';

/** Lightweight node in the topology adjacency map */
export interface TopologyNode {
    name: string;
    type: string;
    teamOwner?: string | null;
    repository?: { name: string; url: string | null } | null;
    /** How this node was discovered: 'backstage', 'autodiscovery', 'code-analysis', 'crossplane', etc. */
    discoverySource?: string | null;
    /** Infrastructure technology: 'postgres', 'redis', 'kafka', 'rabbitmq', 'mongodb', etc. */
    technology?: string | null;
}

/** Directed edge in the topology adjacency map */
export interface TopologyEdge {
    source: string;
    target: string;
    rel: string;
    functions?: { name: string; file: string | null }[];
}

/** In-memory adjacency map: nodes + dual in/out edge indexes */
export interface TopologyMap {
    nodes: Record<string, TopologyNode>;
    out: Record<string, TopologyEdge[]>;
    in: Record<string, TopologyEdge[]>;
}

/** Unified dashboard payload — the CLI emits this, the frontend consumes it. */
export interface RadiusDashboardPayload {
    generatedAt: string;
    cliVersion?: string;
    /**
     * Domain focus filter. Single value (e.g. 'governance') or comma-separated
     * list (e.g. 'governance,inventory'). When set, only the listed domains
     * are populated; the others are surfaced as teaser placeholders in the
     * dashboard. Empty/undefined means the full assessment was generated.
     */
    focus?: string;
    radar: AgentHarnessReport | null;
    deps: DepsReport | null;
    gravity: GravityAnalysisResult | null;
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
