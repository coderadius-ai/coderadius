import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';
import { buildUrn } from '../../../graph/urn.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Makefile Plugin — Extract build targets as Task nodes
//
// Parses Makefile target definitions (lines matching `target:`) and creates
// Task nodes in the graph. Filters out internal targets (starting with `.`).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Regex to match Makefile target definitions.
 * Matches lines like:
 *   build:
 *   test: deps
 *   setup: install build
 *   deploy-prod:
 *
 * Does NOT match:
 *   .PHONY: ...
 *   \t recipe lines
 *   VAR = value
 *   # comments
 */
const TARGET_REGEX = /^([a-zA-Z0-9][a-zA-Z0-9_-]*)\s*:/gm;

/** Targets to exclude (conventional internals or noise). */
const EXCLUDED_TARGETS = new Set([
    'FORCE',
    'all',  // too generic, often just a dependency list
]);

export const makefilePlugin: StructuralPlugin = {
    name: 'makefile',
    label: 'Makefile',
    managedLabels: ['Task'],

    matchFile(_relativePath: string, basename: string): boolean {
        return /^(Makefile|makefile|GNUmakefile)$/i.test(basename);
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        const targets: string[] = [];
        let match: RegExpExecArray | null;

        // Reset regex state
        TARGET_REGEX.lastIndex = 0;
        while ((match = TARGET_REGEX.exec(content)) !== null) {
            const target = match[1];
            // Skip internal/excluded targets
            if (target.startsWith('.') || EXCLUDED_TARGETS.has(target)) continue;
            // Deduplicate
            if (!targets.includes(target)) {
                targets.push(target);
            }
        }

        if (targets.length === 0) {
            return { entities: [], summary: 'No targets found' };
        }

        const entities = targets.map(target => ({
            id: buildUrn('task', context.repoName, target),
            labels: ['Task'],
            properties: {
                name: target,
                source: 'makefile',
                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'DEFINES',
        }));

        return {
            entities,
            summary: `${targets.length} target(s): ${targets.join(', ')}`,
        };
    },
};
