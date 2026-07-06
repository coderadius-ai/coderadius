import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DevTools Plugin — Presence detection for AI Factory standard files
//
// PURPOSE: Creates StructuralFile nodes for files that signal adoption of
// standard DevX tooling required by the AI Factory golden path:
//   - Renovate (dependency auto-update)
//   - DevContainers (reproducible dev environments for humans and Devin)
//   - Backstage catalog-info.yaml (software catalog registration)
//
// WHY presence-only: the semantic content of these files is handled by
// other pipeline stages (backstage-extractor for catalog-info, Renovate
// config parsing is not yet in scope). This plugin only ensures the
// StructuralFile node exists so policy Cypher queries can find it.
//
// Pattern: identical to ciconfig.plugin.ts — managedLabels: [], extract()
// returns entities: []. The StructuralFile node is created by the
// plugin-manager whenever matchFile() returns true.
// ═══════════════════════════════════════════════════════════════════════════════

/** All Renovate config file names, in discovery priority order. */
const RENOVATE_BASENAMES = new Set([
    'renovate.json',
    'renovate.json5',
    '.renovaterc',
    '.renovaterc.json',
]);

export const devtoolsPlugin: StructuralPlugin = {
    name: 'devtools',
    label: 'Dev Tools Config',
    managedLabels: [],  // presence-only — no entity nodes produced

    matchFile(relativePath: string, basename: string): boolean {
        // ── Renovate ──────────────────────────────────────────────────────────
        if (RENOVATE_BASENAMES.has(basename)) return true;
        // Renovate can also live in .github/
        if (relativePath === '.github/renovate.json') return true;

        // ── DevContainers ─────────────────────────────────────────────────────
        // Both root-level and nested forms
        if (basename === 'devcontainer.json') return true;

        // ── Backstage Software Catalog ────────────────────────────────────────
        // Presence detection only — full semantic parsing by backstage-extractor
        if (basename === 'catalog-info.yaml' || basename === 'catalog-info.yml' || basename === 'catalog.yaml' || basename === 'catalog.yml') return true;

        return false;
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    extract(_content: string, context: PluginContext): StructuralExtractionResult {
        return {
            entities: [],
            summary: `DevTools config detected: ${context.relativePath}`,
        };
    },
};
