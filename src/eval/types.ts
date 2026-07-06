// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine: Core Types
//
// Defines the data contracts shared across all CI modules:
//   - GraphEdgeSnapshot / GraphNodeSnapshot: snapshot of a graph topology slice
//   - FileTopologySnapshot: topology extracted from a single source file
//   - GraphDelta: the diff between current (DB) and proposed (PR) topology
//   - GuardrailFinding: a single architectural finding (DANGER / WARNING / INFO)
//   - GuardrailReport: the complete report emitted to stdout or a file
//
// The key invariant: at no point do these types touch the DB in write mode.
// The flow is strictly: DB read → in-memory diff → DB read (blast radius) → output.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Topology Snapshot ───────────────────────────────────────────────────────

/**
 * A single edge in the architectural graph, captured as a triple.
 * The comparison key is: `${sourceId}::${relType}::${targetId}`.
 * Only topological identity matters for the diff, not metadata.
 */
export interface GraphEdgeSnapshot {
    /** URN of the source node (usually a Function node). */
    sourceId: string;
    /** Human-readable name of the source (for report rendering). */
    sourceName: string;
    /** URN of the target node (MessageChannel, DataContainer, APIEndpoint, ...). */
    targetId: string;
    /** Human-readable name of the target (for report rendering). */
    targetName: string;
    /** Graph relationship type (PUBLISHES_TO, CONSUMES, CALLS, WRITES, READS, ...). */
    relType: string;
    /** File that generated this edge (repo-relative path). */
    sourceFile: string;
    /** Resolved node type of the target (MessageChannel, DataContainer, ...). */
    targetType: string;
}

/**
 * A single node captured from the graph snapshot.
 */
export interface GraphNodeSnapshot {
    /** Canonical URN. */
    id: string;
    /** Node type label (MessageChannel, DataContainer, APIEndpoint, ...). */
    type: string;
    /** Human-readable name. */
    name: string;
    /** File that generated this node. */
    sourceFile: string;
    /** DataContainer scope: the namespace used in the URN (populated when type === 'DataContainer'). */
    scope?: string;
    /** How the scope was determined: 'manual_override' (from coderadius.yaml) or 'repo_fallback'. */
    scopeSource?: string;
    /** The qualifiedRepoName of the repo that declared this table. */
    sourceRepo?: string;
}

/**
 * All topology expressed by a single source file: nodes it defines
 * (MessageChannel, APIEndpoint, DataContainer) and edges it creates
 * (PUBLISHES_TO, CONSUMES, CALLS, WRITES, READS, ...).
 */
export interface FileTopologySnapshot {
    /** Repo-relative file path. */
    filePath: string;
    /** Infrastructure nodes declared or used in this file. */
    nodes: GraphNodeSnapshot[];
    /** Directional relationships from functions in this file to resources. */
    edges: GraphEdgeSnapshot[];
}

// ─── Graph Delta ─────────────────────────────────────────────────────────────

/**
 * The topological diff between the current state (from DB) and the
 * proposed state (from the ephemeral LLM extraction of changed files).
 *
 * This is the most important data structure in the Blast Evaluation Engine.
 * Everything after this point is blast-radius resolution on the delta.
 */
export interface GraphDelta {
    /** Files that were included in the PR diff. */
    changedFiles: string[];
    /** Edges that appear in the proposed topology but NOT in the current DB state. */
    addedEdges: GraphEdgeSnapshot[];
    /** Edges that appear in the current DB state but NOT in the proposed topology. */
    removedEdges: GraphEdgeSnapshot[];
    /** Resource nodes that appear in the proposed topology but NOT in the current DB state. */
    addedNodes: GraphNodeSnapshot[];
    /** Resource nodes that appear in the current DB state but NOT in the proposed topology. */
    removedNodes: GraphNodeSnapshot[];
    /**
     * Table-rename cascades suppressed by the differ. Populated when a
     * MAPS_TO rename pair on a `::__class_metadata` source is detected:
     * the differ drops all dependent HAS_FIELD / HAS_SCHEMA / PRODUCES
     * edges so the resolver emits ONE table-rename DANGER instead of
     * N per-column cascades. The resolver consumes this metadata to
     * enrich the table-rename finding with `(N columns inherited: ...)`.
     */
    tableRenameCascades?: Array<{
        /** Lowercased old table name (matches the DataStructure URN segment). */
        oldTable: string;
        /** Lowercased new table name. */
        newTable: string;
        /** Column names dropped from the old-table side, in detection order. */
        columns: string[];
    }>;
}

// ─── Guardrail Findings ──────────────────────────────────────────────────────

export type FindingSeverity = 'DANGER' | 'WARNING' | 'INFO';
export type FindingCategory =
    | 'breaking_change'      // A downstream consumer of a removed edge will break
    | 'orphan_producer'      // An added edge targets a resource with no consumers
    | 'orphan_consumer'      // A consuming function now points to a non-existent resource
    | 'renamed_dependency'   // A resource mapping changed from one target to another
    | 'new_dependency'       // A new outbound dependency added (informational)
    | 'removed_dependency';  // An outbound dependency removed (informational)

/**
 * A single architectural finding produced by the Blast Evaluation analysis.
 */
export interface GuardrailFinding {
    severity: FindingSeverity;
    category: FindingCategory;
    title: string;
    /** What changed: a one-sentence description of the topological delta. */
    whatChanged: string;
    /** Why this matters: severity-agnostic rationale for the finding. Rendered under a severity-conditional label ("Why this is dangerous" / "Why this matters" / "Context"). */
    rationale: string;
    /** Services that will be impacted (for breaking_change findings). */
    affectedServices?: Array<{
        name: string;
        urn: string;
        teamOwner: string | null;
        functions: Array<{ name: string; file: string | null }>;
        repository: { name: string; url: string | null } | null;
    }>;
    /** The edge that was removed (for breaking_change / removed_dependency). */
    removedEdge?: GraphEdgeSnapshot;
    /** The edge that was added (for orphan_producer / new_dependency). */
    addedEdge?: GraphEdgeSnapshot;
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface GuardrailReportRepository {
    /** Canonical repository identifier used in the graph, e.g. "org/repo" or "local/repo". */
    name: string;
    /** Absolute repository root used for this analysis. */
    path: string;
    /**
     * Public remote URL (origin) when available. Resolved from
     * `git remote get-url origin` at CLI time; null when the repo has no
     * remote (e.g. local-only) or git is unavailable. Rendered in the
     * report header so the reader can click through to the codebase.
     */
    url?: string | null;
}

export interface GuardrailReportComparison {
    /** Human-readable comparison label, e.g. "origin/main...HEAD". */
    ref: string;
    /** Git base ref supplied to the analysis, when available. */
    baseRef?: string;
    /** Git head ref supplied to the analysis, when available. */
    headRef?: string;
}

export interface GuardrailReportBaseline {
    /** Baseline source used for the "before" topology. */
    source: 'graph' | 'graph+git';
    /** Changed files found in the baseline graph. */
    knownFiles: string[];
    /** Changed files reconstructed from the Git base ref because they were absent from the graph. */
    gitFallbackFiles?: string[];
    /** Changed files absent from the baseline graph. Removed dependencies may be under-reported for these files. */
    unknownFiles: string[];
}

/**
 * The complete output of a Blast Evaluation run.
 */
export interface GuardrailReport {
    /** Legacy PR title, intent, or git ref for backwards compatibility. */
    prRef: string;
    /** Repository analyzed by this report. */
    repository?: GuardrailReportRepository;
    /** Git comparison analyzed by this report. */
    comparison?: GuardrailReportComparison;
    /** Baseline topology coverage for changed files. */
    baseline?: GuardrailReportBaseline;
    /** Files inspected as part of this PR. */
    changedFiles: string[];
    /** All architectural findings, ordered DANGER → WARNING → INFO. */
    findings: GuardrailFinding[];
    summary: {
        danger: number;
        warning: number;
        info: number;
        /** Composite blast radius score (sum of downstream impacts). Kept for backwards-compat with CI consumers. */
        blastRadiusScore: number;
        /** Concrete impact counts derived from DANGER findings. */
        blastCounts: {
            services: number;
            functions: number;
        };
        /** Confidence in the report based on baseline graph coverage. */
        confidence: {
            level: 'HIGH' | 'MEDIUM' | 'LOW';
            reason: string;
        };
    };
    generatedAt: string;
    /** Wall-clock duration for the entire analysis in milliseconds. */
    durationMs: number;
    /** LLM token usage for the ephemeral extraction step (when applicable). */
    tokensUsed?: {
        /** Prompt / input tokens. */
        in: number;
        /** Completion / output tokens. */
        out: number;
        /** Cached input tokens (subset of `in` billed at the cached rate). */
        cached: number;
    };
}
