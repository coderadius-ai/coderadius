import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CI Config Plugin — Presence-detection for CI/CD configuration files
//
// PURPOSE: Registers CI/CD configuration files as StructuralFile nodes in
// the graph WITHOUT extracting entities from their content.
//
// WHY a plugin exists at all: the plugin-manager only creates StructuralFile
// nodes for files matched by at least one plugin (matchingPlugins.length > 0).
// Without this plugin, .gitlab-ci.yml (and .yaml) and GitHub Actions workflows added to
// STRUCTURAL_GLOB_PATTERNS would be discovered but immediately skipped,
// leaving gp-005 ("every repo must have a CI config") unable to query them.
//
// The shortcut relationship created is:
//   (Repository|Service)-[:HAS_CONFIG]->(StructuralFile { path: '.gitlab-ci.yml' })
//
// Future evolution: when full CI config parsing is needed, extend this plugin's
// extract() to return CIConfig entities (stages, jobs, DinD usage, etc.).
// ═══════════════════════════════════════════════════════════════════════════════

export const ciConfigPlugin: StructuralPlugin = {
    name: 'ciconfig',
    label: 'CI Config',

    // No entity labels managed — this plugin only produces StructuralFile presence data.
    // The StructuralFile node itself is created by the plugin-manager on any match.
    managedLabels: [],

    matchFile(relativePath: string, basename: string): boolean {
        // Primary: GitLab CI
        if (basename === '.gitlab-ci.yml' || basename === '.gitlab-ci.yaml') return true;

        // Secondary: GitHub Actions workflow files
        // Must be under .github/workflows/ to avoid matching arbitrary YAML files
        if (
            (basename.endsWith('.yml') || basename.endsWith('.yaml')) &&
            relativePath.startsWith('.github/workflows/')
        ) {
            return true;
        }

        return false;
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    extract(_content: string, context: PluginContext): StructuralExtractionResult {
        // Intentionally returns no entities — the StructuralFile node created by the
        // plugin-manager IS the signal that gp-005 queries for via:
        //   MATCH (r:Repository)-[:HAS_CONFIG]->(sf:StructuralFile)
        //   WHERE sf.path IN ['.gitlab-ci.yml', '.gitlab-ci.yaml'] OR sf.path STARTS WITH '.github/workflows/'
        return {
            entities: [],
            summary: `CI/CD configuration detected: ${context.relativePath}`,
        };
    },
};
