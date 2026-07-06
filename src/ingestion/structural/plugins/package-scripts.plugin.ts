import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';
import { buildUrn } from '../../../graph/urn.js';
import fs from 'node:fs';
import path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
// Package Scripts Plugin — Extract package manager scripts as Task nodes
//
// Parses `scripts` object from package.json and composer.json, creating
// Task nodes in the graph to represent runnable commands.
//
// Runner detection priority (most authoritative → least):
//   1. `packageManager` field in package.json (Corepack standard)
//   2. Lockfile presence in the same directory
//   3. Lockfile presence walking up to repo root
//   4. Fallback: 'npm'
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * JS/TS lockfile → runner mapping.
 * Order matters: first match wins in same-directory scan.
 */
const JS_LOCKFILE_RUNNERS: { filename: string; runner: string }[] = [
    { filename: 'pnpm-lock.yaml', runner: 'pnpm' },
    { filename: 'yarn.lock', runner: 'yarn' },
    { filename: 'bun.lock', runner: 'bun' },
    { filename: 'bun.lockb', runner: 'bun' },
    { filename: 'package-lock.json', runner: 'npm' },
];

/**
 * Detect the JS/TS package manager runner for a given package.json.
 *
 * Priority:
 *   1. `packageManager` field (Corepack: "pnpm@9.15.0" → "pnpm")
 *   2. Lockfile in the same directory or walking up to repoRoot
 *   3. Fallback: 'npm'
 *
 * Exported for unit testing.
 */
export function detectJsRunner(
    packageJsonContent: Record<string, unknown>,
    absolutePath: string,
    repoRoot: string,
): string {
    // ── Priority 1: `packageManager` field (Corepack) ────────────────────
    const pmField = packageJsonContent.packageManager;
    if (typeof pmField === 'string' && pmField.length > 0) {
        // Format: "pnpm@9.15.0", "yarn@4.1.0", "npm@10.2.0", "bun@1.2.0"
        const atIndex = pmField.indexOf('@');
        const name = atIndex > 0 ? pmField.substring(0, atIndex) : pmField;
        const normalized = name.toLowerCase().trim();
        if (['pnpm', 'yarn', 'npm', 'bun'].includes(normalized)) {
            return normalized;
        }
    }

    // ── Priority 2+3: Lockfile walk (same dir → repo root) ───────────────
    const resolvedRoot = path.resolve(repoRoot);
    let dir = path.dirname(absolutePath);

    while (true) {
        for (const { filename, runner } of JS_LOCKFILE_RUNNERS) {
            if (fs.existsSync(path.join(dir, filename))) {
                return runner;
            }
        }

        // Stop at repo root or filesystem root
        if (dir === resolvedRoot || path.dirname(dir) === dir) break;
        dir = path.dirname(dir);
    }

    // ── Fallback ─────────────────────────────────────────────────────────
    return 'npm';
}

export const packageScriptsPlugin: StructuralPlugin = {
    name: 'package-scripts',
    label: 'Package Scripts',
    managedLabels: ['Task'],

    matchFile(_relativePath: string, basename: string): boolean {
        return basename === 'package.json' || basename === 'composer.json';
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        let parsed: any;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            return { entities: [], summary: 'Invalid JSON' };
        }

        let runner: string;
        if (context.relativePath.endsWith('composer.json')) {
            runner = 'composer';
        } else {
            // Derive repo root from context: absolutePath minus relativePath
            const repoRoot = context.absolutePath.slice(
                0,
                context.absolutePath.length - context.relativePath.length - 1,
            );
            runner = detectJsRunner(parsed, context.absolutePath, repoRoot);
        }

        // Composer scripts can be arrays, strings, or objects with "@" hooks.
        // NPM scripts are strictly key -> string.
        const scriptsObj = parsed.scripts;
        if (!scriptsObj || typeof scriptsObj !== 'object') {
            return { entities: [], summary: 'No scripts found' };
        }

        const targets = Object.keys(scriptsObj).filter(key => {
            // Filter out Composer internal hook syntax if needed
            // (e.g. "@phpstan") but for now keep all user-defined scripts.
            return typeof key === 'string' && key.trim() !== '';
        });

        if (targets.length === 0) {
            return { entities: [], summary: 'No script targets found' };
        }

        const entities = targets.map(target => ({
            // We include the runner in the URN to avoid collisions with Makefile targets
            // having the same name (e.g. `build`), ensuring both appear independently.
            id: buildUrn('task', context.repoName, runner, target),
            labels: ['Task'],
            properties: {
                name: target,
                source: runner,
                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'DEFINES',
        }));

        return {
            entities,
            summary: `${targets.length} ${runner} script(s): ${targets.slice(0, 5).join(', ')}${targets.length > 5 ? '...' : ''}`,
        };
    },
};
