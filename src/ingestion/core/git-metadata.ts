/**
 * Git Metadata Extractor — Branch Topology & Hosting Platform Detection
 *
 * Extracts structural git metadata beyond the current HEAD:
 *   - Default branch name (main, master, etc.)
 *   - Core branches (develop, staging, release/*, hotfix/*)
 *   - Hosting platform (github, gitlab, bitbucket, azure-devops)
 *
 * Design constraints:
 *   - NEVER throws blocking exceptions — all git operations have silent fallbacks.
 *   - `git symbolic-ref` fails in most CI environments (detached HEAD, shallow clones);
 *     the ls-remote branch list is the authoritative fallback and primary CI path.
 *   - Network probe (ls-remote) is gated by a marker file to avoid repeated calls
 *     in cache mode. Marker is invalidated by --fresh flag and `cr prune cache`.
 *   - Platform detection is pure URL parsing — zero network cost.
 */

import path from 'node:path';
import fs from 'node:fs';
import { simpleGit } from 'simple-git';
import { logger } from '../../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HostingPlatform = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'aws-codecommit' | 'google-cloud' | 'unknown';

export interface GitMetadata {
    /** The actual default branch name (e.g. 'main', 'master') */
    defaultBranch: string | null;
    /** Core branches detected via ls-remote pattern matching */
    coreBranches: string[];
    /** SCM hosting platform derived from the remote URL */
    hostingPlatform: HostingPlatform;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Marker file written after a successful ls-remote probe to avoid repeated calls. */
const BRANCHES_MARKER = '.coderadius-branches-probed';

/**
 * Default timeout for git network operations (ms).
 * Can be overridden via RADIUS_GIT_TIMEOUT_MS environment variable.
 */
const GIT_TIMEOUT = process.env.RADIUS_GIT_TIMEOUT_MS
    ? parseInt(process.env.RADIUS_GIT_TIMEOUT_MS, 10)
    : 15_000;

/**
 * Branch name patterns considered "core" (structurally significant).
 * Exact matches are checked case-insensitively.
 * Prefix patterns (ending with /) match any branch under that namespace.
 */
const CORE_BRANCH_EXACT = new Set([
    'main',
    'master',
    'develop',
    'development',
    'staging',
    'prod',
    'production',
    'qa',
    'uat',
    'test',
    'testing',
    'preprod',
    'integration'
]);

// ─── Platform Detection (Zero Network) ──────────────────────────────────────

/**
 * Detect the SCM hosting platform from a git remote URL.
 *
 * Pure string matching — zero network cost. Handles both HTTPS and SSH formats.
 * Self-hosted GitLab instances are detected via the `gitlab.` domain prefix
 * and CI environment variable fallback.
 *
 * @param remoteUrl The git remote URL (e.g. git@github.com:org/repo.git)
 * @returns The detected platform or 'unknown'
 */
export function detectHostingPlatform(remoteUrl: string | undefined): HostingPlatform {
    if (!remoteUrl) {
        // CI fallback: check environment variables for self-hosted GitLab
        if (process.env.GITLAB_CI === 'true' || process.env.CI_SERVER_NAME === 'GitLab') {
            return 'gitlab';
        }
        if (process.env.GITHUB_ACTIONS === 'true') {
            return 'github';
        }
        if (process.env.BITBUCKET_PIPELINE_UUID) {
            return 'bitbucket';
        }
        if (process.env.SYSTEM_TEAMFOUNDATIONSERVERURI) {
            return 'azure-devops';
        }
        if (process.env.CODEBUILD_BUILD_ID) {
            return 'aws-codecommit';
        }
        return 'unknown';
    }

    const url = remoteUrl.toLowerCase();

    // Extract the hostname from SSH or HTTPS URLs
    let hostname = '';
    const sshMatch = url.match(/^git@([^:]+):/);
    if (sshMatch) {
        hostname = sshMatch[1];
    } else if (url.startsWith('codecommit::')) {
        return 'aws-codecommit';
    } else {
        const urlMatch = url.match(/^(?:https?|ssh):\/\/([^/]+)/);
        if (urlMatch) {
            hostname = urlMatch[1];
        }
    }

    if (!hostname) return 'unknown';

    // Exact domain matches
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return 'github';
    if (hostname === 'gitlab.com' || hostname.endsWith('.gitlab.com')) return 'gitlab';
    if (hostname === 'bitbucket.org' || hostname.endsWith('.bitbucket.org')) return 'bitbucket';
    if (hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')) return 'azure-devops';
    if (hostname.startsWith('git-codecommit.') && hostname.endsWith('.amazonaws.com')) return 'aws-codecommit';
    if (hostname === 'source.developers.google.com') return 'google-cloud';

    // Self-hosted patterns (hostname contains the platform name)
    if (hostname.startsWith('gitlab.') || hostname.includes('.gitlab.')) return 'gitlab';
    if (hostname.startsWith('github.') || hostname.includes('.github.')) return 'github';
    if (hostname.startsWith('bitbucket.') || hostname.includes('.bitbucket.')) return 'bitbucket';

    // CI env-var fallback for self-hosted instances with custom domains
    if (process.env.GITLAB_CI === 'true' || process.env.CI_SERVER_NAME === 'GitLab') return 'gitlab';
    if (process.env.GITHUB_ACTIONS === 'true') return 'github';

    return 'unknown';
}

// ─── Branch Detection ────────────────────────────────────────────────────────

/**
 * Check if a branch name matches the core branch patterns.
 */
function isCoreBranch(branchName: string): boolean {
    return CORE_BRANCH_EXACT.has(branchName.toLowerCase());
}

/**
 * Detect the default branch via `git symbolic-ref refs/remotes/origin/HEAD`.
 *
 * ⚠ TRAP 1: This WILL fail in CI environments (detached HEAD, shallow clones,
 * missing remote refs). Exit code 128 is caught silently — the caller must
 * always have a fallback strategy.
 *
 * @returns The default branch name (e.g. 'main') or null if detection fails.
 */
async function detectDefaultBranchViaSymbolicRef(repoPath: string): Promise<string | null> {
    try {
        const git = simpleGit({
            baseDir: repoPath,
            timeout: { block: GIT_TIMEOUT },
        });
        const raw = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
        // Output: "refs/remotes/origin/main\n"
        const ref = raw.trim();
        const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
        return match ? match[1] : null;
    } catch {
        // Expected failure in CI (exit code 128) — silent fallback
        logger.debug('(git-metadata) symbolic-ref failed (expected in CI/detached HEAD) — using fallback');
        return null;
    }
}

/**
 * Probe remote branches via `git ls-remote --heads origin`.
 *
 * Returns the full list of remote branch names and detects:
 *   1. Core branches matching our patterns
 *   2. The default branch (via symbolic-ref, with fallback to main/master heuristic)
 *
 * Network I/O: one lightweight ls-remote call (ref names only, no blob transfer).
 * Gated by the caller's network semaphore.
 *
 * ⚠ TRAP 2: Results are cached via a marker file. Invalidated by:
 *   - freshScan=true (--fresh flag)
 *   - `cr prune cache` (wipes the sandbox directory)
 *
 * @param repoPath  Path to the git repository on disk
 * @param freshScan If true, ignore the marker file and re-probe
 * @returns Object with defaultBranch and coreBranches
 */
async function probeBranches(
    repoPath: string,
    freshScan: boolean = false,
): Promise<{ defaultBranch: string | null; coreBranches: string[] }> {
    const gitDir = path.join(repoPath, '.git');
    const markerFile = path.join(
        fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()
            ? path.dirname(gitDir) // worktree: .git is a file pointing to the main repo
            : gitDir,
        BRANCHES_MARKER,
    );

    // ── Check marker (skip if --fresh) ──────────────────────────────────
    if (!freshScan && fs.existsSync(markerFile)) {
        try {
            const cached = JSON.parse(fs.readFileSync(markerFile, 'utf-8'));
            if (cached.defaultBranch !== undefined && Array.isArray(cached.coreBranches)) {
                logger.debug(`(git-metadata) [branches] Cache hit for ${repoPath}`);
                return { defaultBranch: cached.defaultBranch, coreBranches: cached.coreBranches };
            }
        } catch {
            // Corrupted marker — fall through to re-probe
        }
    }

    // ── Attempt symbolic-ref first (fast, no network) ───────────────────
    let defaultBranch = await detectDefaultBranchViaSymbolicRef(repoPath);

    // ── ls-remote probe ─────────────────────────────────────────────────
    const coreBranches: string[] = [];
    try {
        const git = simpleGit({
            baseDir: repoPath,
            timeout: { block: GIT_TIMEOUT },
        });
        const raw = await git.raw(['ls-remote', '--heads', 'origin']);

        // Parse output lines: "<sha>\trefs/heads/<branchName>"
        const lines = raw.trim().split('\n').filter(Boolean);
        for (const line of lines) {
            const refMatch = line.match(/\trefs\/heads\/(.+)$/);
            if (!refMatch) continue;
            const branchName = refMatch[1];

            if (isCoreBranch(branchName)) {
                coreBranches.push(branchName);
            }
        }

        // Deduplicate and sort for deterministic output
        coreBranches.sort();

        // Default branch fallback: if symbolic-ref failed, infer from ls-remote
        if (!defaultBranch) {
            if (coreBranches.includes('main')) {
                defaultBranch = 'main';
            } else if (coreBranches.includes('master')) {
                defaultBranch = 'master';
            }
            // If neither exists, defaultBranch remains null
        }

        // Ensure the default branch is in the core list
        if (defaultBranch && !coreBranches.includes(defaultBranch)) {
            coreBranches.unshift(defaultBranch);
        }

    } catch (err) {
        // ls-remote can fail: no remote, network down, auth failure, etc.
        logger.debug(`(git-metadata) [branches] ls-remote failed for ${repoPath}: ${(err as Error).message}`);

        // Best-effort fallback without network: check local refs
        if (!defaultBranch) {
            const refsDir = path.join(repoPath, '.git', 'refs', 'remotes', 'origin');
            if (fs.existsSync(path.join(refsDir, 'main'))) {
                defaultBranch = 'main';
                if (!coreBranches.includes('main')) coreBranches.push('main');
            } else if (fs.existsSync(path.join(refsDir, 'master'))) {
                defaultBranch = 'master';
                if (!coreBranches.includes('master')) coreBranches.push('master');
            }
        }
    }

    // ── Write marker ────────────────────────────────────────────────────
    try {
        const markerDir = path.dirname(markerFile);
        if (fs.existsSync(markerDir)) {
            fs.writeFileSync(markerFile, JSON.stringify({ defaultBranch, coreBranches }));
        }
    } catch {
        // Non-fatal — caching is best-effort
    }

    return { defaultBranch, coreBranches };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract full git metadata for a repository.
 *
 * Orchestrates platform detection (zero network) and branch probing
 * (one ls-remote call, cached). Designed to never throw.
 *
 * @param repoPath     Absolute path to the git repository on disk
 * @param remoteUrl    The git remote URL (for platform detection)
 * @param allowNetwork If false, skip ls-remote and use local refs only
 * @param freshScan    If true, ignore cached branch probe results
 */
export async function extractGitMetadata(
    repoPath: string,
    remoteUrl: string | undefined,
    allowNetwork: boolean = true,
    freshScan: boolean = false,
): Promise<GitMetadata> {
    const hostingPlatform = detectHostingPlatform(remoteUrl);

    if (!allowNetwork) {
        // Offline mode: skip ls-remote, use symbolic-ref + local refs only
        const defaultBranch = await detectDefaultBranchViaSymbolicRef(repoPath);
        return { defaultBranch, coreBranches: defaultBranch ? [defaultBranch] : [], hostingPlatform };
    }

    const { defaultBranch, coreBranches } = await probeBranches(repoPath, freshScan);

    return { defaultBranch, coreBranches, hostingPlatform };
}
