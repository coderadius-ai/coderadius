// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine — Git Delta Detection
//
// Step 1 of the In-Memory Graph Overlay pipeline.
//
// Detects the list of changed files in a PR using `git diff`. Supports two
// input modes:
//   1. Git-native: computes `git diff --name-only <base>...<head>` internally
//   2. Explicit file list: parses a comma/newline-separated list of paths
//
// In both cases, the output is filtered against .crignore rules (same
// topological filter used during ingestion) so files like vendor/, dist/,
// or test fixtures are excluded.
// ═══════════════════════════════════════════════════════════════════════════════

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

// ─── Crignore Filter ────────────────────────────────────────────────────────

/**
 * Loads ignore patterns from the nearest .crignore file.
 * Returns an empty array if no .crignore is found.
 */
function loadCrignorePatterns(repoRoot: string): RegExp[] {
    const crignorePath = path.join(repoRoot, '.crignore');
    if (!fs.existsSync(crignorePath)) return [];

    const lines = fs.readFileSync(crignorePath, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

    return lines.map(pattern => {
        // Convert glob-style patterns to RegExp
        const escaped = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars, except * and ?
            .replace(/\*/g, '.*')                   // * → .*
            .replace(/\?/g, '.');                   // ? → .
        return new RegExp(escaped);
    });
}

/**
 * Filter out files matching .crignore patterns.
 */
function applyCrignoreFilter(files: string[], repoRoot: string): string[] {
    const patterns = loadCrignorePatterns(repoRoot);
    if (patterns.length === 0) return files;

    return files.filter(file => {
        const shouldIgnore = patterns.some(p => p.test(file));
        if (shouldIgnore) {
            logger.debug(`[GitDelta] Ignoring (crignore): ${file}`);
        }
        return !shouldIgnore;
    });
}

// ─── Git integration ─────────────────────────────────────────────────────────

function runGitDiff(base: string, head: string, repoRoot: string): string[] {
    try {
        let output = '';

        if (head === 'HEAD') {
            // Local Mode: Compare the branch fork point against the local working directory.
            // This captures all uncommitted and staged changes perfectly.
            try {
                const mergeBase = execSync(`git merge-base ${base} HEAD`, { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                output = execSync(`git diff --name-only --diff-filter=ACMRT ${mergeBase}`, { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            } catch (err) {
                // Fallback if merge-base calculation fails
                logger.debug(`[GitDelta] Local merge-base calculation failed, falling back to direct diff against base: ${(err as Error).message}`);
                output = execSync(`git diff --name-only --diff-filter=ACMRT ${base}`, { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            }
        } else {
            // CI Mode: Three-dot diff strictly between two committed refs without looking at the working tree.
            output = execSync(
                `git diff --name-only --diff-filter=ACMRT ${base}...${head}`,
                { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
        }

        if (!output) return [];
        return output.split('\n').map(l => l.trim()).filter(Boolean);

    } catch (err) {
        throw new Error(
            `Git diff failed. Ensure git is available and refs are valid.\n` +
            `  base="${base}", head="${head}"\n` +
            `  Error: ${(err as Error).message}`
        );
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface GitDeltaOptions {
    /** Git base ref (e.g. 'origin/main', a commit SHA). */
    base?: string;
    /** Git head ref (e.g. 'HEAD', a branch name, a commit SHA). */
    head?: string;
    /** Explicit comma-or-newline-separated file paths (skips git diff). */
    explicitFiles?: string;
    /** Root of the git repository. Defaults to process.cwd(). */
    repoRoot?: string;
}

export interface GitDeltaResult {
    /** Repo-relative paths of changed files, filtered by .crignore. */
    changedFiles: string[];
    /** Number of files excluded by .crignore. */
    filteredCount: number;
    /** The git base ref used (for reporting). */
    base: string;
    /** The git head ref used (for reporting). */
    head: string;
}

/**
 * Compute the set of files changed in a PR.
 *
 * Supports two modes:
 *   1. Explicit: `--files "src/A.php,src/B.ts"` — parse the list directly.
 *   2. Git-native: `--base origin/main --head HEAD` — run `git diff`.
 *
 * In both modes, the result is filtered via .crignore rules.
 */
export async function computeGitDelta(opts: GitDeltaOptions = {}): Promise<GitDeltaResult> {
    const repoRoot = opts.repoRoot ?? process.cwd();
    const base = opts.base ?? 'origin/main';
    const head = opts.head ?? 'HEAD';

    let rawFiles: string[];

    if (opts.explicitFiles) {
        // Mode B: parse explicit file list
        rawFiles = opts.explicitFiles
            .split(/[,\n]/)
            .map(f => f.trim())
            .filter(Boolean);
        logger.debug(`[GitDelta] Using explicit file list: ${rawFiles.length} files`);
    } else {
        // Mode A: git diff
        logger.debug(`[GitDelta] Running git diff ${base}...${head} in ${repoRoot}`);
        rawFiles = runGitDiff(base, head, repoRoot);
        logger.debug(`[GitDelta] Git diff found ${rawFiles.length} changed files`);
    }

    const filteredFiles = applyCrignoreFilter(rawFiles, repoRoot);
    const filteredCount = rawFiles.length - filteredFiles.length;

    if (filteredCount > 0) {
        logger.debug(`[GitDelta] .crignore excluded ${filteredCount} file(s)`);
    }

    return {
        changedFiles: filteredFiles,
        filteredCount,
        base,
        head,
    };
}

/**
 * Check whether a list of changed files includes any known infrastructure
 * config files (e.g. services.yaml, AmqpConfig.php). Used by the
 * ephemeral-extractor to decide whether to re-run the Scout on those files.
 */
export function detectConfigFiles(changedFiles: string[]): string[] {
    const CONFIG_PATTERNS = [
        /\.ya?ml$/i,
        /config/i,
        /\.env/i,
        /coderadius\.yaml$/i,
        /services\.(xml|yaml|php)$/i,
    ];

    return changedFiles.filter(f =>
        CONFIG_PATTERNS.some(p => p.test(f))
    );
}
