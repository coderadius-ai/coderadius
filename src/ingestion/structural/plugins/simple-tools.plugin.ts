import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';
import { buildUrn } from '../../../graph/urn.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Simple Tools Plugin — Presence-to-Entity mapper for standard dev tools
//
// Detects common configuration files (linters, testers, catalogs) and emits
// a generic ToolConfig node for them. This provides visibility in the UI
// and structural graph without needing deep semantic parsing of their contents.
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolPattern {
    id: string; // The tool identifier used in the graph and UI
    match: (relativePath: string, basename: string) => boolean;
}

const TOOL_PATTERNS: ToolPattern[] = [
    {
        id: 'backstage',
        match: (_path, basename) => basename === 'catalog-info.yaml' || basename === 'catalog-info.yml' || basename === 'catalog.yaml' || basename === 'catalog.yml',
    },
    {
        id: 'codeowners',
        match: (path, basename) => basename === 'CODEOWNERS' || path === '.github/CODEOWNERS' || path === '.gitlab/CODEOWNERS' || path === 'docs/CODEOWNERS',
    },
    {
        id: 'dependabot',
        match: (path, _basename) => path === '.github/dependabot.yml' || path === '.github/dependabot.yaml',
    },
    {
        id: 'eslint',
        match: (_path, basename) => basename.startsWith('.eslintrc') || basename.startsWith('eslint.config.'),
    },
    {
        id: 'prettier',
        match: (_path, basename) => basename.startsWith('.prettierrc') || basename.startsWith('prettier.config.'),
    },
    {
        id: 'jest',
        match: (_path, basename) => basename.startsWith('jest.config.'),
    },
    {
        id: 'vitest',
        match: (_path, basename) => basename.startsWith('vitest.config.'),
    },
    {
        id: 'coderadius',
        match: (_path, basename) => basename === 'coderadius.yaml' || basename === 'coderadius.hints.yaml',
    },
    {
        id: 'npm',
        match: (_path, basename) => basename === 'package-lock.json',
    },
    {
        id: 'yarn',
        match: (_path, basename) => basename === 'yarn.lock' || basename === '.yarnrc.yml',
    },
    {
        id: 'pnpm',
        match: (_path, basename) => basename === 'pnpm-lock.yaml' || basename === 'pnpm-workspace.yaml',
    },
    {
        id: 'bun',
        match: (_path, basename) => basename === 'bun.lockb' || basename === 'bun.lock',
    },
    {
        id: 'composer',
        match: (_path, basename) => basename === 'composer.lock',
    },
    // ── Python Package Managers ──
    {
        id: 'pipenv',
        match: (_path, basename) => basename === 'Pipfile.lock',
    },
    {
        id: 'poetry',
        match: (_path, basename) => basename === 'poetry.lock',
    },
    {
        id: 'uv',
        match: (_path, basename) => basename === 'uv.lock',
    },
    {
        id: 'pdm',
        match: (_path, basename) => basename === 'pdm.lock',
    },
    // ── Go ──
    {
        id: 'go',
        match: (_path, basename) => basename === 'go.sum',
    },
];

export const simpleToolsPlugin: StructuralPlugin = {
    name: 'simple-tools',
    label: 'Simple Tools',
    managedLabels: ['ToolConfig'],

    matchFile(relativePath: string, basename: string): boolean {
        return TOOL_PATTERNS.some(p => p.match(relativePath, basename));
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    extract(_content: string, context: PluginContext): StructuralExtractionResult {
        const basename = context.relativePath.split('/').pop() || '';
        const toolsFound = TOOL_PATTERNS.filter(p => p.match(context.relativePath, basename));

        if (toolsFound.length === 0) {
            return { entities: [], summary: 'No tools matched' };
        }

        // It is theoretically possible for one file to match multiple patterns
        // (though unlikely with these specific rules), so we map all matches.
        const entities = toolsFound.map(t => ({
            id: buildUrn('toolconfig', t.id, context.repoName, context.relativePath),
            labels: ['ToolConfig'],
            properties: {
                name: context.relativePath,
                tool: t.id,
                filePath: context.relativePath,
                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'DEFINES',
        }));

        const toolNames = toolsFound.map(t => t.id).join(', ');

        return {
            entities,
            summary: `Detected tool config: ${toolNames}`,
        };
    },
};
