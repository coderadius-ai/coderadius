// ═══════════════════════════════════════════════════════════════════════════════
// Structural Extraction Layer — Type Contracts
//
// Defines the plugin interface and data contracts for the Zero-LLM
// structural extraction system. All plugins implement StructuralPlugin
// and return StructuralEntity arrays for graph persistence.
// ═══════════════════════════════════════════════════════════════════════════════
import type { DiscoveredService } from '../extractors/autodiscovery.js';
import type { ScopeManager } from '../core/scope-manager.js';

/**
 * Describes a single entity extracted by a structural plugin.
 * Each entity becomes one node + its outbound edges in the graph.
 */
export interface StructuralEntity {
    /** Deterministic URN for MERGE idempotency (e.g. urn:task:myrepo:build). */
    id: string;
    /** Neo4j label(s) for the node (e.g. ['Task']). */
    labels: string[];
    /** Node properties (excluding `id`, which is set from `id` above). */
    properties: Record<string, unknown>;
    /**
     * Relationships to create FROM this entity's defining StructuralFile.
     * The target is this entity itself — the relationship goes
     * (StructuralFile)-[type]->(this entity).
     */
    relationshipType: string;
    /**
     * Properties to set on the (StructuralFile)-[relationshipType]->(Entity) provenance edge.
     * Used by USES_IMAGE to carry context/scope metadata on the edge rather than
     * on the node itself, preventing last-write-wins collisions on global URNs.
     *
     * When undefined, no SET clause is appended to the MERGE — zero impact on existing plugins.
     */
    relationshipProperties?: Record<string, unknown>;
    /**
     * Additional edges to create between emitted entities (or existing graph nodes).
     * Unlike `relationshipType` (which always links FROM StructuralFile TO this entity),
     * these edges can link any two nodes by URN.
     *
     * Use cases: Crossplane subscription→topic linking, Terraform module dependencies,
     * ArgoCD application→service mapping, Docker-Compose service linking.
     */
    edges?: Array<{
        sourceUrn: string;
        targetUrn: string;
        type: string;
        /**
         * Optional properties stamped on the edge. Used by messaging plugins
         * to carry routing metadata (bindingKey, isPattern, patternRegex, ...)
         * onto `ROUTES_TO` edges. When omitted the edge has no properties
         * beyond the relationship type.
         */
        properties?: Record<string, unknown>;
    }>;
}

/**
 * Properties to stamp onto an existing node matched by label + key field.
 * Used by manifest files (skills-lock.json) that enrich nodes created by
 * other plugins rather than creating standalone entities.
 */
export interface StructuralEnrichment {
    label: string;
    matchField: string;
    matchValue: string;
    properties: Record<string, unknown>;
}

/**
 * Result returned by a plugin's extract() method.
 */
export interface StructuralExtractionResult {
    /** Entities to persist in the graph. */
    entities: StructuralEntity[];
    /** Human-readable summary for CLI reporting. */
    summary: string;
    /** Properties to stamp onto existing nodes (matched by label + field). */
    enrichments?: StructuralEnrichment[];
}

/**
 * Context passed to each plugin during extraction.
 */
export interface PluginContext {
    /** Relative path from repo root. */
    relativePath: string;
    /** Absolute path on disk. */
    absolutePath: string;
    /** Repository name. */
    repoName: string;
    /** Repository URN (e.g. urn:repository:myrepo). */
    repoUrn: string;
    /** Owner service name, if resolved via auto-discovery. */
    ownerService?: string;
    /** Manager for respecting .gitignore and .crignore rules. */
    scopeManager: ScopeManager;
    /** Resolved symlink target path (relative to repo root), set when the file is a symlink. */
    symlinkTarget?: string;
}

/**
 * Contract for a Structural Extraction Plugin.
 *
 * Each plugin is responsible for:
 * 1. Declaring WHICH files it can handle (via `matchFile()`)
 * 2. Parsing the file content deterministically (via `extract()`)
 * 3. Returning strongly-typed entities for graph persistence
 *
 * Plugins MUST be stateless — all context is passed via method args.
 * Plugins MUST NOT throw — errors are caught by the PluginManager.
 */
export interface StructuralPlugin {
    /** Unique plugin identifier (kebab-case). */
    readonly name: string;
    /** Human-friendly label for CLI output. */
    readonly label: string;
    /** Neo4j label(s) this plugin creates — used for reconciliation cleanup. */
    readonly managedLabels: string[];

    /** 
     * Optional fast-fail regex signatures applied to the file content.
     * If provided, the plugin manager will only call extract() if the content matches
     * at least one signature. Ideal for Duck Typing infrastructure manifests (Open/Closed principle).
     * 
     * @warning **CATASTROPHIC BACKTRACKING (ReDoS) PREVENTION:**
     * Do NOT use complex unbounded regexes (e.g. `/(.*)*foo/`) here. These signatures are executed 
     * against potentially large files across the entire codebase. A malformed regex could freeze the 
     * Node.js Event Loop. ALWAYS use "dumb", literal-heavy regexes (e.g. `/kind:\s*AcmePubSubTopicClaim/`).
     */
    readonly contentSignatures?: RegExp[];

    /**
     * Optional glob patterns this plugin contributes to structural discovery
     * (Fix 8). Plugin manager unions all plugin globs with the static
     * STRUCTURAL_GLOB_PATTERNS, deduplicated, before walking the filesystem.
     *
     * Replaces the tech-leakage pattern where each new plugin's globs had to
     * be hardcoded centrally in `plugin-manager.ts`. `matchFile` still decides
     * per-file applicability after discovery.
     */
    readonly discoveryGlobs?: string[];

    /**
     * Determine if this plugin should process a given file.
     * Called for every file discovered in the repo.
     * Must be FAST (filename/path matching only, no I/O).
     */
    matchFile(relativePath: string, basename: string): boolean;

    /**
     * Extract structural entities from the file content.
     * Called only when matchFile() returns true AND the file hash has changed.
     *
     * @param content   Raw file content (UTF-8)
     * @param context   Metadata about the file and its owning repo
     * @returns         Extracted entities, or empty result if nothing found
     */
    extract(content: string, context: PluginContext): StructuralExtractionResult;
}

/**
 * Interface for directory-based structural plugins (e.g. Ghost Directories).
 * Scans a repository for high-level patterns instead of per-file analysis.
 */
export interface DirectoryPlugin {
    readonly name: string;
    readonly label: string;
    readonly managedLabels: string[];

    /**
     * Scan the repo root for ghost directories (directories excluded
     * from LLM analysis that should still be registered in the graph).
     */
    scan(repoPath: string, repoName: string, repoUrn: string, scopeManager: ScopeManager, serviceRoots?: DiscoveredService[]): StructuralExtractionResult;
}

/**
 * Metrics returned by the structural ingestion step.
 */
export interface StructuralIngestionMetrics {
    /** Number of structural files processed. */
    filesProcessed: number;
    /** Number of structural files skipped (cache hit). */
    filesSkipped: number;
    /** Total entities persisted across all plugins. */
    entitiesPersisted: number;
    /** Number of stale entities removed via reconciliation. */
    entitiesRemoved: number;
    /** Number of ghost directories registered. */
    ghostDirectoriesFound: number;
    /** Per-plugin error count (for observability). */
    pluginErrors: number;
}

/**
 * Structural file index row, loaded from Neo4j for cache comparison.
 */
export interface StructuralFileIndexRow {
    path: string;
    fileHash: string;
    pluginName: string;
}
