import fs from 'node:fs';
import path from 'node:path';
import stripJsonComments from 'strip-json-comments';
import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';
import { buildUrn } from '../../../graph/urn.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ToolConfig Plugin — Extract compiler/tool configuration as ToolConfig nodes
//
// Parses tsconfig.json files and extracts relevant compilerOptions,
// producing a generic ToolConfig node tagged with tool: 'TypeScript'.
//
// Design principle: the graph label is ToolConfig, not TSConfig, so that
// future plugins (PHPStan, ESLint, Biome, etc.) can produce the same label
// with a different `tool` property — keeping the ontology compact.
//
// Example future PHPStan plugin would produce:
//   (:ToolConfig { tool: 'PHPStan', level: 9 })
// ═══════════════════════════════════════════════════════════════════════════════

/** Compiler options to track in the graph. */
const TRACKED_FLAGS: string[] = [
    // Strictness
    'strict',
    'strictNullChecks',
    'strictFunctionTypes',
    'strictBindCallApply',
    'strictPropertyInitialization',
    'noImplicitAny',
    'noImplicitThis',
    'noImplicitReturns',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noFallthroughCasesInSwitch',
    // Module system
    'esModuleInterop',
    'skipLibCheck',
    'target',
    'module',
    'moduleResolution',
    // Output
    'outDir',
    'rootDir',
    'declaration',
    'sourceMap',
    // Isolation
    'isolatedModules',
    'verbatimModuleSyntax',
];

export const toolconfigPlugin: StructuralPlugin = {
    name: 'toolconfig',
    label: 'ToolConfig',
    managedLabels: ['ToolConfig'],

    matchFile(_relativePath: string, basename: string): boolean {
        return basename === 'tsconfig.json' || /^tsconfig\..+\.json$/i.test(basename);
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        let parsed: Record<string, unknown>;
        try {
            const stripped = stripJsonComments(content);
            parsed = JSON.parse(stripped);
        } catch {
            return { entities: [], summary: 'parse error (malformed JSON)' };
        }

        // ── Resolve `extends` chain (Fix C) ─────────────────────────────────────
        // If the tsconfig extends a local file (not a node_modules package),
        // merge the parent's compilerOptions UNDERNEATH ours so the child wins.
        let parentCompilerOptions: Record<string, unknown> = {};
        let strictSource: 'direct' | 'inherited' = 'direct';

        if (typeof parsed.extends === 'string' && !parsed.extends.startsWith('@')) {
            // Only resolve local relative extends (not npm package extends like @tsconfig/...)
            const parentRelPath = parsed.extends.endsWith('.json')
                ? parsed.extends
                : `${parsed.extends}.json`;
            const parentAbsPath = path.resolve(
                path.dirname(context.absolutePath),
                parentRelPath,
            );
            try {
                // Known limitation: readFileSync blocks the Event Loop when the plugin-manager
                // runs ingestion in parallel on many files. Making extends resolution
                // non-blocking would require the plugin interface to accept a
                // `context.readFile(path): Promise<string>` async helper (similar to a
                // VFS layer).
                const parentRaw = fs.readFileSync(parentAbsPath, 'utf-8');
                const parentParsed = JSON.parse(stripJsonComments(parentRaw)) as Record<string, unknown>;
                parentCompilerOptions = (parentParsed.compilerOptions ?? {}) as Record<string, unknown>;
            } catch {
                // Parent file unreadable (outside repo, broken path) — degrade gracefully
                parentCompilerOptions = {};
            }
        }

        const rawCompilerOptions = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
        // Merge: child options win over parent options
        const compilerOptions: Record<string, unknown> = { ...parentCompilerOptions, ...rawCompilerOptions };

        // Determine whether strict was set directly or inherited
        if (
            rawCompilerOptions.strict === undefined &&
            parentCompilerOptions.strict !== undefined
        ) {
            strictSource = 'inherited';
        }

        // Extract only tracked flags that are actually present
        const trackedProperties: Record<string, unknown> = {};
        let trackedCount = 0;

        for (const flag of TRACKED_FLAGS) {
            if (flag in compilerOptions) {
                trackedProperties[flag] = compilerOptions[flag];
                trackedCount++;
            }
        }

        if (trackedCount === 0 && !parsed.extends) {
            return { entities: [], summary: 'No relevant compilerOptions found' };
        }

        // Also capture `extends` for inheritance tracking
        if (parsed.extends) {
            trackedProperties.extends = parsed.extends;
        }

        // ── Resolved strict flags (for policy queries without false positives) ──
        const resolvedStrict = compilerOptions.strict === true;
        const resolvedNoFallthrough = compilerOptions.noFallthroughCasesInSwitch === true;
        const resolvedNoUnchecked = compilerOptions.noUncheckedIndexedAccess === true;
        trackedProperties.resolvedStrict = resolvedStrict;
        trackedProperties.resolvedNoFallthroughCasesInSwitch = resolvedNoFallthrough;
        trackedProperties.resolvedNoUncheckedIndexedAccess = resolvedNoUnchecked;
        trackedProperties.strictSource = strictSource;

        const entity = {
            id: buildUrn('toolconfig', 'TypeScript', context.repoName, context.relativePath),
            labels: ['ToolConfig'],
            properties: {
                name: context.relativePath,
                tool: 'TypeScript',
                ...trackedProperties,
                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'DEFINES',
        };

        // Build a concise summary focusing on strictness
        const strictStatus = compilerOptions.strict === true ? 'strict ✓' : 'strict ✗';
        const targetInfo = compilerOptions.target ? ` target=${compilerOptions.target}` : '';

        return {
            entities: [entity],
            summary: `[TypeScript] ${context.relativePath}: ${strictStatus}${targetInfo} (${trackedCount} flags)`,
        };
    },
};
