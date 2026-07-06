// ═══════════════════════════════════════════════════════════════════════════════
// EvalManifest — Zod Schema for expected.graph.yaml
//
// Declarative specification of what a fixture's ingested graph MUST contain
// (expected_nodes, expected_edges, expected_symbols) and MUST NOT contain
// (negative_nodes, negative_patterns).
//
// Used by the eval-scorer to compute precision, recall, and critical
// regressions per entity category.
// ═══════════════════════════════════════════════════════════════════════════════

import { z } from 'zod';
import yaml from 'js-yaml';
import fs from 'node:fs';

// ─── Edge Assertion Variants ─────────────────────────────────────────────────

/** Node-to-node edge (e.g., Service DEPENDS_ON Service, System CONTAINS Service). */
const NodeEdgeSchema = z.object({
    from: z.string(),
    rel: z.string(),
    to: z.string(),
});

/**
 * Function-to-resource edge using EXACT FQN (e.g., "ShipmentLogWriter.persistTracking").
 * Never use substring matching — it causes test false positives.
 */
const FunctionEdgeSchema = z.object({
    from_function: z.string(),
    rel: z.string(),
    to: z.string(),
});

/** Service-to-resource edge (any function in the service touches this resource). */
const ServiceResourceEdgeSchema = z.object({
    from_service: z.string(),
    rel: z.string(),
    to: z.string(),
});

const ExpectedEdgeSchema = z.union([
    NodeEdgeSchema,
    FunctionEdgeSchema,
    ServiceResourceEdgeSchema,
]);

// ─── Symbol Resolution Assertion ─────────────────────────────────────────────

/**
 * Asserts that a DI container key was resolved to a physical infrastructure name.
 * Used to verify the ConfigSymbolExtractor → Sanitizer pipeline.
 */
const ExpectedSymbolSchema = z.object({
    /** The DI container key (e.g., "notredeemable.publisher") */
    diKey: z.string(),
    /** The physical name it must resolve to (e.g., "loyalty.not_redeemable") */
    resolvedTo: z.string(),
    /** Source config file that defines this binding (for documentation) */
    source: z.string().optional(),
});

// ─── Top-Level Manifest Schema ───────────────────────────────────────────────

export const EvalManifestSchema = z.object({
    /** Short fixture identifier (e.g., "microservices") */
    fixture: z.string(),
    /** Human-readable description */
    description: z.string().optional(),

    /**
     * Optional assessment target. `repo` scopes the live-graph snapshot to one
     * repository (qualified name, e.g. "acme/acme") so a manifest built for a
     * single repo stays honest on multi-repo graphs. Consumed by
     * scripts/assess-graph.ts when --repo is not passed explicitly.
     */
    target: z.object({
        repo: z.string().optional(),
    }).optional(),

    /**
     * Expected nodes by label. Key = Neo4j label, Value = array of exact names.
     * Example: { Service: ["order-service", "loyalty-service"] }
     */
    expected_nodes: z.record(z.string(), z.array(z.string())).default({}),

    /**
     * Expected edges. Three variants: node→node, function→resource, service→resource.
     * All use exact match — no substring/fuzzy.
     */
    expected_edges: z.array(ExpectedEdgeSchema).default([]),

    /**
     * Expected symbol resolutions. Each entry asserts that a DI key was resolved
     * to a physical name by the ConfigSymbolExtractor + Sanitizer pipeline.
     */
    expected_symbols: z.array(ExpectedSymbolSchema).default([]),

    /**
     * Negative nodes by label. Key = Neo4j label, Value = array of exact names
     * that MUST NOT exist in the graph. Violations are critical regressions.
     */
    negative_nodes: z.record(z.string(), z.array(z.string())).default({}),

    /**
     * Negative patterns by label. Key = Neo4j label, Value = array of regex
     * patterns that MUST NOT match any node name. Used to catch template leaks,
     * PascalCase class names, PHP variable names, etc.
     */
    negative_patterns: z.record(z.string(), z.array(z.string())).default({}),
});

// ─── Derived Types ───────────────────────────────────────────────────────────

export type EvalManifest = z.infer<typeof EvalManifestSchema>;
export type ExpectedEdge = z.infer<typeof ExpectedEdgeSchema>;
export type ExpectedSymbol = z.infer<typeof ExpectedSymbolSchema>;

// ─── Edge Type Guards ────────────────────────────────────────────────────────

export function isNodeEdge(edge: ExpectedEdge): edge is z.infer<typeof NodeEdgeSchema> {
    return 'from' in edge && !('from_function' in edge) && !('from_service' in edge);
}

export function isFunctionEdge(edge: ExpectedEdge): edge is z.infer<typeof FunctionEdgeSchema> {
    return 'from_function' in edge;
}

export function isServiceResourceEdge(edge: ExpectedEdge): edge is z.infer<typeof ServiceResourceEdgeSchema> {
    return 'from_service' in edge;
}

// ─── Manifest Loader ─────────────────────────────────────────────────────────

/**
 * Load and validate an expected.graph.yaml manifest from disk.
 * Throws on invalid YAML or schema violations.
 */
export function loadManifest(yamlPath: string): EvalManifest {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const parsed = yaml.load(raw);
    return EvalManifestSchema.parse(parsed);
}
