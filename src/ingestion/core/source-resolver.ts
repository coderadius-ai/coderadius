import path from 'node:path';
import fs from 'node:fs';
import { simpleGit, type SimpleGit } from 'simple-git';
import { glob } from 'glob';
import pLimit from 'p-limit';
import type { ResolvedRepo } from '../../graph/types.js';
import type { ProgressReporter } from './progress.js';
import 'dotenv/config';
import { logger } from '../../utils/logger.js';
import { paths } from '../../config/paths.js';
import { extractGitMetadata } from './git-metadata.js';
import { extractGitConventions } from '../extractors/git-convention-extractor.js';

import { getAllSupportedExtensions, getAllManifestFiles, getAllIgnorePatterns } from './languages/registry.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Source Strategy — Enterprise-Grade Repository Resolution
//
// Three strategies for resolving remote repositories:
//   - cache  (default): Zero network, use _cache directly. Instant re-runs.
//   - pull:  Git pull + worktree isolation. For fresh data.
//   - ci:    Auto-detect CI workspace. Zero cloning.
// ═══════════════════════════════════════════════════════════════════════════════

export type SourceStrategy = 'cache' | 'pull' | 'ci';

const SANDBOX_BASE = paths.sandbox;
const CACHE_BASE = path.join(SANDBOX_BASE, '_cache');

// ── Two-layer concurrency model ──────────────────────────────────────────────
//
// Layer 1 — Task concurrency (RESOLVE_CONCURRENCY / LARGE_SCAN_CONCURRENCY):
//   Controls how many repos are processed concurrently at the orchestration
//   level. Governs local I/O, metadata enrichment, git-status checks.
//   Can be relatively high because it's mostly CPU/disk work.
//
// Layer 2 — Network semaphore (GIT_NETWORK_CONCURRENCY):
//   Gates only the SSH wire operations: git clone and git pull.
//   MUST be ≤ 5 to stay below GitLab's MaxStartups limit (default: 10).
//   Opening 30 SSH handshakes from a single IP in <1s causes the server
//   to reset connections — the classic "Connection reset by peer" error.
//   This semaphore is module-level so it's shared across all batches.

/** Task-level concurrency: local I/O + metadata enrichment */
const RESOLVE_CONCURRENCY = 30;

/** Drop task concurrency further for very large scans to avoid Bun OOM */
const LARGE_SCAN_THRESHOLD = 150;
const LARGE_SCAN_CONCURRENCY = 15;

/** SSH/network concurrency: max simultaneous git clone/pull connections.
 *  Must be kept low to respect GitLab MaxStartups (and similar server limits). */
const GIT_NETWORK_CONCURRENCY = 5;

/** Module-level network semaphore — shared across all batch iterations. */
const gitNetworkLimit = pLimit(GIT_NETWORK_CONCURRENCY);

// Process this many repos per batch to bound peak memory.
// After each batch, references to completed simpleGit instances can be GC'd.
const BATCH_SIZE = 50;

// Stale session threshold (1 hour)
const STALE_SESSION_MS = 60 * 60 * 1000;

/**
 * Default timeout for git network operations (ms).
 * Can be overridden via RADIUS_GIT_TIMEOUT_MS environment variable.
 */
const GIT_NETWORK_TIMEOUT_MS = process.env.RADIUS_GIT_TIMEOUT_MS
    ? parseInt(process.env.RADIUS_GIT_TIMEOUT_MS, 10)
    : 60_000; // 60s for data-heavy ops (clone/pull)

// ─── Strategy Detection ──────────────────────────────────────────────────────

/**
 * Auto-detect the best source strategy based on environment and explicit flags.
 * Priority: explicit flag > CI detection > default (cache).
 */
export function detectSourceStrategy(explicit?: SourceStrategy): SourceStrategy {
    if (explicit) return explicit;

    // Auto-detect CI environments
    if (process.env.CI === 'true' || process.env.CI === '1') {
        logger.debug('(source-resolver) CI environment detected — using ci strategy');
        return 'ci';
    }

    return 'cache';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Detect if an input is a git remote URL.
 */
function isRemoteUrl(input: string): boolean {
    return input.startsWith('https://') || input.startsWith('git@') || input.startsWith('http://');
}

/**
 * Parse a git URL into org/repo-name for sandbox directory structure.
 */
export function parseRepoUrl(url: string): { org: string; repo: string } {
    // Handle HTTPS: https://github.com/org/repo.git
    //               https://gitlab.acme.com/group/sub-group/repo.git
    const httpsMatch = url.match(/(?:https?:\/\/[^/]+)\/(.+)\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch) {
        return { org: httpsMatch[1], repo: httpsMatch[2] };
    }
    // Handle SSH: git@github.com:org/repo.git
    //             git@gitlab.acme.com:group/sub-group/repo.git
    const sshMatch = url.match(/git@[^:]+:(.+)\/([^/]+?)(?:\.git)?$/);
    if (sshMatch) {
        return { org: sshMatch[1], repo: sshMatch[2] };
    }
    // Fallback
    const basename = path.basename(url, '.git');
    return { org: 'unknown', repo: basename };
}

/**
 * Resolve the org namespace from a local repository's git remote.
 *
 * Reads `git remote get-url origin` and extracts the org path via
 * `parseRepoUrl`. Returns `undefined` when:
 *   - the repo has no `origin` remote
 *   - the directory is not a git repository
 *   - the remote URL cannot be parsed
 *
 * Used by the eval pipeline (CLI + MCP) to reconstruct the qualified
 * repository name without access to `ResolvedRepo`.
 */
export function resolveLocalRepoOrg(repoRoot: string): string | undefined {
    try {
        const { execSync } = require('node:child_process');
        const remoteUrl = execSync('git remote get-url origin', {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr
        }).trim();
        if (!remoteUrl) return undefined;
        return parseRepoUrl(remoteUrl).org;
    } catch {
        // No remote, not a git repo, or parse failure — silent fallback
        return undefined;
    }
}

// ─── File-Based Mutex ────────────────────────────────────────────────────────

/**
 * Acquire a directory-based lock with timeout and stale-lock recovery.
 * Returns a release function.
 */
async function acquireLock(lockPath: string, timeoutMs = 90_000): Promise<() => void> {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;

    while (true) {
        try {
            fs.mkdirSync(lockPath);
            fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid));
            return () => { try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { } };
        } catch (e: any) {
            if (e.code === 'EEXIST') {
                // Recover stale locks (e.g. from crashed processes) intelligently
                try {
                    const pidStr = fs.readFileSync(path.join(lockPath, 'pid'), 'utf-8');
                    const pid = parseInt(pidStr, 10);
                    if (pid && pid !== process.pid) {
                        try {
                            process.kill(pid, 0); // Check if process is still alive
                        } catch {
                            // Process is dead! Safe to recover lock immediately
                            fs.rmSync(lockPath, { recursive: true, force: true });
                            continue;
                        }
                    }
                } catch { /* missing pid file — fallback */ }

                // Fallback stale check (1 hour limits so massive repos don't get interrupted)
                try {
                    const stat = fs.statSync(lockPath);
                    if (Date.now() - stat.mtimeMs > 60 * 60_000) {
                        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { }
                        continue;
                    }
                } catch { /* lock removed between check and stat — retry */ }

                if (Date.now() > deadline) {
                    throw new Error(`(source-resolver) Lock timeout: could not acquire ${lockPath} within ${timeoutMs}ms`);
                }
                await new Promise(r => setTimeout(r, 200));
            } else {
                throw e;
            }
        }
    }
}

// ─── Liveness Computation ───────────────────────────────────────────────────

export interface LivenessData {
    commits: number;
}

/**
 * Count human commits over the last 12 months on the repository's HEAD.
 *
 * Single signal by design: the discrete tier (elite/high/medium/low) is
 * derived on read by `tierFromCommits()` in `@coderadius/shared-types/liveness`.
 * Keeping only the raw count in the graph means the thresholds can move
 * without re-ingesting.
 *
 * Requires at least 12 months of commit history to be present.
 * Call `git fetch --shallow-since` before this to deepen a shallow clone.
 *
 * --no-merges: excludes merge commits, eliminating most auto-merge bot noise
 * (Dependabot PRs produce a merge commit that gets filtered out).
 */
async function computeLiveness(repoPath: string, allowFetch: boolean = true): Promise<LivenessData> {
    const markerFile = path.join(repoPath, '.git', '.coderadius-fetched');
    const hasFetched = fs.existsSync(markerFile);

    if (allowFetch || !hasFetched) {
        try {
            const repoGit = simpleGit({
                baseDir: repoPath,
                timeout: { block: GIT_NETWORK_TIMEOUT_MS },
            });

            // Deepen the shallow clone to include 12 months of commit graph.
            // --shallow-since is very efficient: only fetches commit + tree objects,
            // no file blobs. Typically a few MB even for large repos.
            await gitNetworkLimit(() => repoGit.raw(['fetch', '--shallow-since=1 year ago', '--no-tags', 'origin']));

            // Mark as fetched so we don't hit the network in future offline cache runs
            if (fs.existsSync(path.join(repoPath, '.git'))) {
                fs.writeFileSync(markerFile, '1');
            }
        } catch {
            // fetch can fail if: no remote ('origin'), CI detached head, local-only repo, etc.
            // In all those cases we fall back to counting whatever history is available.
            logger.debug('(source-resolver) [liveness] fetch --shallow-since skipped (non-remote or no origin)');
            // Also write marker on failure to prevent repeated failing network attempts in offline mode
            if (fs.existsSync(path.join(repoPath, '.git'))) {
                try { fs.writeFileSync(markerFile, '1'); } catch {}
            }
        }
    }

    try {
        const repoGit = simpleGit(repoPath);

        // Count human commits (merge commits excluded to filter bot auto-merges)
        const commitRaw = await repoGit.raw([
            'rev-list', '--count', '--no-merges', '--since=1 year ago', 'HEAD',
        ]);
        const commits = parseInt(commitRaw.trim(), 10) || 0;

        logger.debug(`(source-resolver) [liveness] ${repoPath}: commits=${commits}`);
        return { commits };
    } catch (err) {
        logger.debug(`(source-resolver) [liveness] Failed to compute for ${repoPath} (likely empty or corrupted). Falling back to dormant.`);
        return { commits: 0 };
    }
}

// ─── Cache Strategy ──────────────────────────────────────────────────────────

/**
 * Resolve a remote URL using the cache strategy.
 * - If _cache/org/repo exists → use it directly (zero I/O, zero network).
 * - If not → clone --depth 1 into _cache, then use it.
 */
async function resolveCached(url: string): Promise<ResolvedRepo> {
    const { org, repo } = parseRepoUrl(url);
    const cacheDir = path.join(CACHE_BASE, org, repo);

    let livenessCommits: number | undefined = undefined;

    if (fs.existsSync(path.join(cacheDir, '.git'))) {
        // Cache hit — zero I/O, zero network
        logger.debug(`(source-resolver) [cache] Hit: ${org}/${repo}`);
    } else {
        // Cache miss — clone once, gated by SSH network semaphore
        logger.debug(`(source-resolver) [cache] Miss: cloning ${url} (shallow) → _cache`);
        const lockPath = path.join(CACHE_BASE, `${org}_${repo}.lock`);
        const releaseLock = await acquireLock(lockPath);
        try {
            // Double-check after acquiring lock (another process may have cloned)
            if (!fs.existsSync(path.join(cacheDir, '.git'))) {
                await gitNetworkLimit(async () => {
                    const git: SimpleGit = simpleGit({
                        timeout: { block: GIT_NETWORK_TIMEOUT_MS },
                    });
                    await git.clone(url, cacheDir, ['--depth', '1']);
                });
            }
        } finally {
            releaseLock();
        }
    }

    // Extract git metadata from cache
    let branch = 'main';
    let commit = 'unknown';
    try {
        const repoGit = simpleGit(cacheDir);
        const status = await repoGit.status();
        branch = status.current?.trim() || 'main';
        commit = (await repoGit.revparse(['HEAD'])).trim();
    } catch (err) {
        logger.debug(`(source-resolver) Failed to extract git info for ${url}: ${(err as Error).message}`);
    }

    // Always compute local liveness. Offline mode: do not fetch, just use what we have locally
    const liveness = await computeLiveness(cacheDir, false);
    livenessCommits = liveness.commits;

    // Branch topology & platform detection (cached marker — no fresh probe in cache mode)
    const gitMeta = await gitNetworkLimit(() => extractGitMetadata(cacheDir, url, /* allowNetwork */ true, /* freshScan */ false));
    const gitConventions = await extractGitConventions(cacheDir);

    return {
        name: repo,
        path: cacheDir,
        origin: 'remote',
        remoteUrl: url,
        branch,
        commit,
        org,
        cachePath: cacheDir,
        livenessCommits,
        defaultBranch: gitMeta.defaultBranch ?? undefined,
        coreBranches: gitMeta.coreBranches.length > 0 ? gitMeta.coreBranches : undefined,
        hostingPlatform: gitMeta.hostingPlatform,
        gitConventions,
    };
}

// ─── Pull Strategy ───────────────────────────────────────────────────────────

/**
 * Resolve a remote URL using the pull strategy.
 * - Always git pull to update the cache.
 * - Compare local HEAD with previously ingested commit (from Memgraph).
 * - If unchanged → use _cache directly (no worktree overhead).
 * - If changed → create a git worktree for session isolation.
 */
async function resolvePull(
    url: string,
    sessionId: string,
    graphCommits: Map<string, string | null>,
): Promise<ResolvedRepo> {
    const { org, repo } = parseRepoUrl(url);
    const cacheDir = path.join(CACHE_BASE, org, repo);
    const lockPath = path.join(CACHE_BASE, `${org}_${repo}.lock`);

    // Phase 1: Pull with lock, gated by SSH network semaphore
    const releaseLock = await acquireLock(lockPath);
    try {
        if (fs.existsSync(path.join(cacheDir, '.git'))) {
            logger.debug(`(source-resolver) [pull] Pulling latest for ${org}/${repo}...`);
            await gitNetworkLimit(async () => {
                const repoGit = simpleGit({
                    baseDir: cacheDir,
                    timeout: { block: GIT_NETWORK_TIMEOUT_MS },
                });
                try {
                    await repoGit.pull();
                } catch (pullErr) {
                    logger.debug(`(source-resolver) [pull] Failed to pull ${org}/${repo}. Recovering with fresh clone...`);
                    fs.rmSync(cacheDir, { recursive: true, force: true });
                    const git: SimpleGit = simpleGit({
                        timeout: { block: GIT_NETWORK_TIMEOUT_MS },
                    });
                    await git.clone(url, cacheDir, ['--depth', '1']);
                }
            });
        } else {
            logger.debug(`(source-resolver) [pull] Cloning ${url} (shallow) → _cache`);
            await gitNetworkLimit(async () => {
                const git: SimpleGit = simpleGit({
                    timeout: { block: GIT_NETWORK_TIMEOUT_MS },
                });
                await git.clone(url, cacheDir, ['--depth', '1']);
            });
        }
    } finally {
        releaseLock();
    }

    // Phase 2: Check if this commit was already ingested
    let branch = 'main';
    let commit = 'unknown';
    try {
        const repoGit = simpleGit(cacheDir);
        const status = await repoGit.status();
        branch = status.current?.trim() || 'main';
        commit = (await repoGit.revparse(['HEAD'])).trim();
    } catch (err) {
        logger.debug(`(source-resolver) Failed to extract git info (e.g. HEAD) for ${url}`);
    }

    // Compute liveness now that we have a fresh pull — network I/O is already expected here.
    const liveness = await computeLiveness(cacheDir, true);

    // Branch topology & platform detection (fresh probe — pull strategy expects network)
    const gitMeta = await gitNetworkLimit(() => extractGitMetadata(cacheDir, url, /* allowNetwork */ true, /* freshScan */ true));
    const gitConventions = await extractGitConventions(cacheDir);

    const graphCommit = graphCommits.get(repo);
    if (graphCommit && graphCommit === commit) {
        // Already ingested this exact commit — skip worktree, use cache directly
        logger.debug(`(source-resolver) [pull] Skipping ${org}/${repo} — commit ${commit.slice(0, 8)} already ingested`);
        return {
            name: repo,
            path: cacheDir,
            origin: 'remote',
            remoteUrl: url,
            branch,
            commit,
            org,
            cachePath: cacheDir,
            livenessCommits: liveness.commits,
            defaultBranch: gitMeta.defaultBranch ?? undefined,
            coreBranches: gitMeta.coreBranches.length > 0 ? gitMeta.coreBranches : undefined,
            hostingPlatform: gitMeta.hostingPlatform,
            gitConventions,
        };
    }

    // Phase 3: New commit detected — create isolated worktree for safe processing
    const worktreeDir = path.join(SANDBOX_BASE, sessionId, org, repo);
    try {
        fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
        const repoGit = simpleGit(cacheDir);
        await repoGit.raw(['worktree', 'add', '--detach', worktreeDir]);
        logger.debug(`(source-resolver) [pull] Worktree created for ${org}/${repo} at ${worktreeDir}`);
    } catch (err) {
        // Worktree creation can fail in edge cases — fallback to cache direct
        logger.debug(`(source-resolver) [pull] Worktree failed for ${org}/${repo}. Using cache directly.`);
        return {
            name: repo,
            path: cacheDir,
            origin: 'remote',
            remoteUrl: url,
            branch,
            commit,
            org,
            cachePath: cacheDir,
        };
    }

    // Restore .crignore cache if missing in git
    const cacheCrignore = path.join(cacheDir, '.crignore');
    const targetCrignore = path.join(worktreeDir, '.crignore');
    if (fs.existsSync(cacheCrignore) && !fs.existsSync(targetCrignore)) {
        fs.copyFileSync(cacheCrignore, targetCrignore);
    }

    return {
        name: repo,
        path: worktreeDir,
        origin: 'remote',
        remoteUrl: url,
        branch,
        commit,
        org,
        cachePath: cacheDir,
        livenessCommits: liveness.commits,
        defaultBranch: gitMeta.defaultBranch ?? undefined,
        coreBranches: gitMeta.coreBranches.length > 0 ? gitMeta.coreBranches : undefined,
        hostingPlatform: gitMeta.hostingPlatform,
        gitConventions,
    };
}

// ─── CI Strategy ─────────────────────────────────────────────────────────────

/**
 * Resolve a source in CI mode.
 * Uses the CI runner's checkout directory — zero cloning, zero network.
 */
async function resolveCi(input: string): Promise<ResolvedRepo[]> {
    // In CI, the workspace is already checked out
    const ciDir = process.env.CI_PROJECT_DIR
        || process.env.GITHUB_WORKSPACE
        || process.cwd();

    const commitSha = process.env.CI_COMMIT_SHA
        || process.env.GITHUB_SHA
        || 'unknown';

    const branchRef = process.env.CI_COMMIT_REF_NAME
        || process.env.GITHUB_REF_NAME
        || 'main';

    // If the input is a remote URL in CI, we ignore it and use the CI workspace
    if (isRemoteUrl(input)) {
        logger.debug(`(source-resolver) [ci] Ignoring remote URL in CI mode — using workspace: ${ciDir}`);
        const { org, repo } = parseRepoUrl(input);
        return [{
            name: repo,
            path: ciDir,
            origin: 'local',
            remoteUrl: input,
            branch: branchRef,
            commit: commitSha,
            org,
        }];
    }

    // For local paths in CI, use the standard local resolver
    return findLocalRepos(input);
}

// ─── Stale Session Cleanup ───────────────────────────────────────────────────

/**
 * Clean up stale session directories (UUID-named) and prune orphaned worktrees.
 * Runs asynchronously to avoid blocking the CLI startup.
 */
export async function cleanupStaleSessions(): Promise<void> {
    try {
        if (!fs.existsSync(SANDBOX_BASE)) return;

        const entries = fs.readdirSync(SANDBOX_BASE, { withFileTypes: true });
        const now = Date.now();
        let cleaned = 0;

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === '_cache') continue;

            // UUID pattern check (session directories)
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) continue;

            const sessionPath = path.join(SANDBOX_BASE, entry.name);
            try {
                const stat = fs.statSync(sessionPath);
                if (now - stat.mtimeMs > STALE_SESSION_MS) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    cleaned++;
                }
            } catch { /* ignore — race condition or permission issue */ }
        }

        if (cleaned > 0) {
            logger.debug(`(source-resolver) Cleaned up ${cleaned} stale session(s)`);
        }

        // Prune orphaned worktrees — only in repos that actually have worktrees.
        // .git/worktrees/ only exists if `git worktree add` was used on this repo.
        // This reduces spawned git processes from O(all cached repos) to O(repos-with-worktrees),
        // typically 0-5 instead of 180.
        if (fs.existsSync(CACHE_BASE)) {
            const orgs = fs.readdirSync(CACHE_BASE, { withFileTypes: true });
            for (const orgEntry of orgs) {
                if (!orgEntry.isDirectory() || orgEntry.name.endsWith('.lock')) continue;
                const orgPath = path.join(CACHE_BASE, orgEntry.name);
                const repos = fs.readdirSync(orgPath, { withFileTypes: true });
                for (const repoEntry of repos) {
                    if (!repoEntry.isDirectory()) continue;
                    const repoPath = path.join(orgPath, repoEntry.name);
                    const worktreesDir = path.join(repoPath, '.git', 'worktrees');
                    // Only prune if this repo has ever had worktrees created
                    if (fs.existsSync(worktreesDir)) {
                        try {
                            await simpleGit(repoPath).raw(['worktree', 'prune']);
                        } catch { /* ignore — repo might be locked */ }
                    }
                }
            }
        }
    } catch (err) {
        logger.debug(`(source-resolver) Cleanup error (non-fatal): ${(err as Error).message}`);
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse .gitmodules in a directory and return the set of known submodule paths.
 * Returns both relative path strings and absolute paths for easy lookup.
 */
export function readGitSubmodulePaths(repoPath: string): Set<string> {
    const gitmodulesPath = path.join(repoPath, '.gitmodules');
    const result = new Set<string>();
    if (!fs.existsSync(gitmodulesPath)) return result;

    try {
        const content = fs.readFileSync(gitmodulesPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
            if (match) {
                const relPath = match[1];
                result.add(relPath);                        // e.g. 'vendor/acme'
                result.add(path.join(repoPath, relPath));  // absolute path
                result.add(relPath.split('/')[0]);          // top-level dir name
            }
        }
    } catch (err) {
        logger.debug(`(source-resolver) Failed to read .gitmodules: ${(err as Error).message}`);
    }
    return result;
}

// ─── Context Provenance ───────────────────────────────────────────────────────

/**
 * Mechanisms through which a repository can import AI context from an external source.
 * This union is intentionally generic — git submodules are the first implementation,
 * but the type is designed to accommodate future mechanisms without schema changes.
 */
export type ProvenanceMechanism =
    | 'git_submodule'
    | 'npm_package'
    | 'symlink'
    | 'cursor_plugin'
    | 'mcp';

/**
 * Describes a single external context source that a repository imports.
 * The type is mechanism-agnostic: the same structure is used whether the
 * import comes from a git submodule, npm package, symlink, or any future method.
 */
export interface ContextProvenance {
    /** Canonical name of the source repo or package (e.g. "ai-rules", "@tech-co/cursor-rules") */
    sourceName: string;
    /** Full URI of the source — git remote URL, "npm:@org/pkg", "mcp:server-id", etc. */
    sourceUri: string;
    /** How the external context is imported into the consuming repository */
    mechanism: ProvenanceMechanism;
    /** Local path where the external context is mounted (e.g. ".ai-rules", "node_modules/@org/rules") */
    mountPoint: string;
    /** Organisation extracted from the source URI (e.g. "acme/docs") */
    sourceOrg?: string;
}

/**
 * Resolve a submodule URL that may be relative (e.g. "../rules.git") against
 * the parent repository's remote URL to produce a canonical absolute URL.
 *
 * Git itself uses the same logic when resolving relative submodule URLs.
 */
function resolveSubmoduleUrl(parentRemoteUrl: string | undefined, submoduleUrl: string): string {
    // Already absolute — return as-is
    if (
        submoduleUrl.startsWith('git@') ||
        submoduleUrl.startsWith('https://') ||
        submoduleUrl.startsWith('http://')
    ) {
        return submoduleUrl;
    }

    // Relative URL without a parent remote — best-effort fallback
    if (!parentRemoteUrl) {
        logger.debug(`(source-resolver) Cannot resolve relative submodule URL "${submoduleUrl}" — no parent remote available`);
        return submoduleUrl;
    }

    // SSH format: git@host:org/group/repo.git → resolve relative against path component
    const sshMatch = parentRemoteUrl.match(/^(git@[^:]+:)(.+?)(\.git)?$/);
    if (sshMatch) {
        const prefix = sshMatch[1];               // e.g. "git@gitlab.com:"
        const parentPath = sshMatch[2];            // e.g. "org/group/repo"
        // path.posix.resolve treats the parent as a directory and applies the relative segments
        const parentDir = path.posix.dirname(parentPath);
        const resolved = path.posix.normalize(path.posix.join(parentDir, submoduleUrl.replace(/\.git$/, '')));
        return `${prefix}${resolved}.git`;
    }

    // HTTPS format: https://host/org/group/repo.git
    const httpsMatch = parentRemoteUrl.match(/^(https?:\/\/[^/]+)\/(.+?)(\.git)?$/);
    if (httpsMatch) {
        const origin = httpsMatch[1];              // e.g. "https://gitlab.com"
        const parentPath = httpsMatch[2];          // e.g. "org/group/repo"
        const parentDir = path.posix.dirname(parentPath);
        const resolved = path.posix.normalize(path.posix.join(parentDir, submoduleUrl.replace(/\.git$/, '')));
        return `${origin}/${resolved}.git`;
    }

    // Unknown format — return raw
    logger.debug(`(source-resolver) Unrecognised parent remote format "${parentRemoteUrl}" — using raw submodule URL`);
    return submoduleUrl;
}

/**
 * Detect context provenance from git submodules declared in .gitmodules.
 *
 * Reads and parses .gitmodules, resolves relative submodule URLs against the
 * parent repo's remote URL, and returns typed ContextProvenance entries.
 *
 * To add support for a new provenance mechanism (npm packages, symlinks, etc.)
 * create a new function with the same return type and call it alongside this one
 * in the governance scan workflow — no other changes required.
 *
 * @param repoPath        Absolute path to the repository on disk
 * @param parentRemoteUrl Remote URL of the parent repo (used to resolve relative submodule URLs)
 */
export function detectGitSubmoduleProvenance(
    repoPath: string,
    parentRemoteUrl?: string,
): ContextProvenance[] {
    const gitmodulesPath = path.join(repoPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return [];

    const entries: ContextProvenance[] = [];

    try {
        const content = fs.readFileSync(gitmodulesPath, 'utf-8');
        const lines = content.split('\n');

        // Mini state-machine: accumulate fields per [submodule] section
        let currentName: string | undefined;
        let currentPath: string | undefined;
        let currentUrl: string | undefined;

        const flush = () => {
            if (!currentPath || !currentUrl) return;
            const resolvedUri = resolveSubmoduleUrl(parentRemoteUrl, currentUrl);
            const { org, repo } = parseRepoUrl(resolvedUri);
            entries.push({
                sourceName: repo,
                sourceUri: resolvedUri,
                mechanism: 'git_submodule',
                mountPoint: currentPath,
                sourceOrg: org !== 'unknown' ? org : undefined,
            });
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('[submodule ')) {
                flush(); // persist previous section before starting new one
                currentName = trimmed.match(/\[submodule\s+"?([^"\]]+)"?\]/)?.[1];
                currentPath = undefined;
                currentUrl = undefined;
            } else {
                const pathMatch = trimmed.match(/^path\s*=\s*(.+)$/);
                if (pathMatch) { currentPath = pathMatch[1].trim(); continue; }

                const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/);
                if (urlMatch) { currentUrl = urlMatch[1].trim(); }
            }
        }
        flush(); // flush final section

    } catch (err) {
        logger.debug(`(source-resolver) Failed to parse .gitmodules in ${repoPath}: ${(err as Error).message}`);
    }

    return entries;
}

/**
 * Enrich a bare repo descriptor with git metadata (branch, commit, remoteUrl).
 * Safe to call on directories without .git — returns 'unknown' for git fields.
 */
async function enrichRepo(repo: { name: string; path: string; origin: 'local' | 'remote' }): Promise<ResolvedRepo> {
    let branch = 'unknown';
    let commit = 'unknown';
    let remoteUrl: string | undefined = undefined;
    let livenessCommits: number | undefined = undefined;

    try {
        if (fs.existsSync(path.join(repo.path, '.git'))) {
            const repoGit = simpleGit(repo.path);
            const status = await repoGit.status();
            branch = status.current?.trim() || 'unknown';
            commit = (await repoGit.revparse(['HEAD'])).trim();
            try {
                const remotes = await repoGit.getRemotes(true);
                if (remotes.length > 0) remoteUrl = remotes[0].refs.fetch;
            } catch { /* no remote — that's fine */ }

            // For local repos, compute liveness immediately since no network fetch is strictly required.
            const liveness = await computeLiveness(repo.path);
            livenessCommits = liveness.commits;
        }
    } catch (err) {
        logger.debug(`(source-resolver) Failed to extract git info for ${repo.name}: ${(err as Error).message}`);
    }

    let org = 'unknown';
    if (remoteUrl) {
        try {
            org = parseRepoUrl(remoteUrl).org;
        } catch { /* ignore parsing errors — default 'unknown' is fine */ }
    }

    // Branch topology & platform detection for local repos
    let defaultBranch: string | undefined;
    let coreBranches: string[] | undefined;
    let hostingPlatform: string | undefined;
    let gitConventions: { ticketIdRate: number; conventionalCommitRate: number; sampleSize: number } | undefined;
    if (fs.existsSync(path.join(repo.path, '.git'))) {
        const gitMeta = !!remoteUrl
            ? await gitNetworkLimit(() => extractGitMetadata(repo.path, remoteUrl, true))
            : await extractGitMetadata(repo.path, remoteUrl, false);
        defaultBranch = gitMeta.defaultBranch ?? undefined;
        coreBranches = gitMeta.coreBranches.length > 0 ? gitMeta.coreBranches : undefined;
        hostingPlatform = gitMeta.hostingPlatform;
        gitConventions = await extractGitConventions(repo.path);
    }

    return { ...repo, branch, commit, remoteUrl, org, livenessCommits, defaultBranch, coreBranches, hostingPlatform, gitConventions };
}

/**
 * Find all git repos within a local directory (recursive).
 * If the directory itself is a repo, return just that.
 *
 * Fallback strategy (no .git found anywhere):
 *   Treat the INPUT directory itself as a single repo. This handles:
 *   - Legacy PHP monoliths with no composer.json/git
 *   - Plain source dumps / test fixtures
 *   The auto-discovery pass will identify services within it via manifest files.
 *
 * Note: git submodules listed in .gitmodules are excluded from the top-level scan
 * to avoid double-ingesting code that belongs to the parent repo.
 */
export async function findLocalRepos(dirPath: string): Promise<ResolvedRepo[]> {
    const absPath = path.resolve(dirPath);

    if (!fs.existsSync(absPath)) {
        logger.debug(`(source-resolver) Path does not exist: ${absPath}`);
        return [];
    }

    // ── Case 1: Directory IS a git repo ──────────────────────────────────────
    if (fs.existsSync(path.join(absPath, '.git'))) {
        return [await enrichRepo({ name: path.basename(absPath), path: absPath, origin: 'local' })];
    }

    // ── Case 2: Scan subdirectories for git repos (monorepo layout) ──────────
    // Read .gitmodules so we can skip git submodules — they belong to the parent.
    const submodulePaths = readGitSubmodulePaths(absPath);
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    const repos: ResolvedRepo[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

        const subPath = path.join(absPath, entry.name);

        // Skip git submodules
        if (submodulePaths.has(entry.name) || submodulePaths.has(subPath)) {
            logger.debug(`(source-resolver) Skipping git submodule: ${entry.name}`);
            continue;
        }

        if (fs.existsSync(path.join(subPath, '.git'))) {
            repos.push(await enrichRepo({ name: entry.name, path: subPath, origin: 'local' }));
        } else {
            // Recurse one more level (keeps it bounded)
            const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
            for (const subEntry of subEntries) {
                if (subEntry.isDirectory() && fs.existsSync(path.join(subPath, subEntry.name, '.git'))) {
                    repos.push(await enrichRepo({
                        name: subEntry.name,
                        path: path.join(subPath, subEntry.name),
                        origin: 'local',
                    }));
                }
            }
        }
    }

    if (repos.length > 0) return repos;

    // ── Case 3: No git repos found anywhere → single repo fallback ───────────
    // Treat the input directory itself as one repo. The auto-discovery pass will
    // find services within it (via composer.json, package.json, etc.).
    logger.debug(`(source-resolver) No .git repos found in subdirectories — treating as single repo: ${path.basename(absPath)}`);
    return [await enrichRepo({ name: path.basename(absPath), path: absPath, origin: 'local' })];
}

/**
 * Resolve a single source input (local path or remote URL) to one or more repos.
 * Dispatches to the correct strategy handler.
 */
async function resolveSource(
    input: string,
    sessionId: string,
    strategy: SourceStrategy,
    graphCommits: Map<string, string | null>,
): Promise<ResolvedRepo[]> {
    if (strategy === 'ci') {
        return resolveCi(input);
    }

    if (!isRemoteUrl(input)) {
        return findLocalRepos(input);
    }

    // Remote URL — dispatch to strategy
    switch (strategy) {
        case 'cache': {
            const repo = await resolveCached(input);
            return [repo];
        }
        case 'pull': {
            const repo = await resolvePull(input, sessionId, graphCommits);
            return [repo];
        }
    }
}

/**
 * Resolve multiple source inputs to a flat list of repos.
 * Uses parallel resolution with p-limit for concurrency control.
 * Deduplicates inputs before resolution to avoid lock contention.
 */
export async function resolveAllSources(
    inputs: string[],
    sessionId: string,
    strategy?: SourceStrategy,
    reporter?: ProgressReporter,
    graphCommits?: Map<string, string | null>,
): Promise<ResolvedRepo[]> {
    const resolvedStrategy = detectSourceStrategy(strategy);

    // Deduplicate inputs (prevents two workers racing on the same repo)
    const uniqueInputs = [...new Set(inputs)];
    if (uniqueInputs.length < inputs.length) {
        logger.debug(`(source-resolver) Deduplicated ${inputs.length} inputs → ${uniqueInputs.length} unique`);
    }

    // Lazy cleanup — non-blocking, runs in background
    cleanupStaleSessions().catch(() => { /* swallow */ });

    const strategyLabel = resolvedStrategy.toUpperCase();
    if (reporter) reporter.report(`Source strategy: ${strategyLabel}`);
    logger.debug(`(source-resolver) Strategy: ${resolvedStrategy} | Session: ${sessionId} | Inputs: ${uniqueInputs.length}`);

    // For pull strategy, we need the graph commits map
    const commits = graphCommits ?? new Map<string, string | null>();

    // Adaptive concurrency: lower for large scans to avoid Bun OOM
    const concurrency = uniqueInputs.length > LARGE_SCAN_THRESHOLD
        ? LARGE_SCAN_CONCURRENCY
        : RESOLVE_CONCURRENCY;
    logger.debug(`(source-resolver) Concurrency: ${concurrency} (${uniqueInputs.length > LARGE_SCAN_THRESHOLD ? 'large-scan' : 'normal'})`);

    const results: ResolvedRepo[] = [];
    let cached = 0;
    let pulled = 0;

    // Process in batches to bound peak memory.
    // After each batch completes, interim simpleGit instances become eligible for GC.
    for (let batchStart = 0; batchStart < uniqueInputs.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, uniqueInputs.length);
        const batch = uniqueInputs.slice(batchStart, batchEnd);
        const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(uniqueInputs.length / BATCH_SIZE);

        if (totalBatches > 1) {
            const memMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);
            logger.debug(`(source-resolver) Batch ${batchNum}/${totalBatches} (${batch.length} repos, RSS: ${memMB}MB)`);
        }

        const limit = pLimit(concurrency);
        const tasks = batch.map(input => limit(async () => {
            try {
                const repos = await resolveSource(input, sessionId, resolvedStrategy, commits);
                return repos;
            } catch (err: any) {
                // simple-git errors often put the actual failure reason (e.g. from stderr)
                // in the subsequent lines. We extract the full message and replace newlines.
                const shortMsg = err.message.split('\n').filter((l: string) => l.trim().length > 0).join(' - ');
                if (reporter) {
                    reporter.warn(`[FAILED] Skipping ${input.split('/').pop()?.replace('.git', '') ?? input}: ${shortMsg}`);
                }
                logger.debug(`(source-resolver) [FAILED] Skipping source resolution for ${input}: ${err.message}`);
                return [];
            }
        }));

        const batchResults = await Promise.all(tasks);
        for (const repos of batchResults) {
            results.push(...repos);
        }


    }

    // Count stats for reporting
    for (const repo of results) {
        if (repo.origin === 'local') continue;
        if (repo.path === repo.cachePath) {
            cached++;
        } else {
            pulled++;
        }
    }

    const memMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);
    const summary = `Resolved ${results.length} repo(s) (${strategyLabel}: ${cached} cached, ${pulled} worktree-isolated) [RSS: ${memMB}MB]`;
    logger.debug(`(source-resolver) ${summary}`);
    if (reporter) reporter.report(summary);

    return results;
}

// ─── File Discovery ──────────────────────────────────────────────────────────

/**
 * Discover parseable source files in a repo directory.
 */
export async function discoverFiles(repoPath: string): Promise<string[]> {
    // Generate glob patterns dynamically from registered language plugins.
    // Adding a new language plugin automatically includes it here.
    const sourcePatterns = getAllSupportedExtensions().map(ext => `**/*${ext}`);

    // Manifest patterns derived from language plugins.
    const manifestPatterns = getAllManifestFiles().map(m => `**/${m.file}`);

    const patterns = [...sourcePatterns, ...manifestPatterns];

    // Strict glob-level exclusions for directories that would flood the results
    // before ScopeManager gets a chance to filter. ScopeManager handles the rest.
    const ignore = ['**/node_modules/**', '**/.git/**'];

    const rawFiles = await glob(patterns, {
        cwd: repoPath,
        absolute: true,
        ignore,
        nodir: true,
    });

    const { ScopeManager } = await import('./scope-manager.js');
    const scopeManager = new ScopeManager(repoPath);

    return rawFiles.filter(file => !scopeManager.isOmitted(file, repoPath));
}

/**
 * Discover specification and configuration files (OpenAPI, AsyncAPI, Protobuf, Docker, etc.)
 * anywhere in the repository, including doc/, docs/, config/, and other non-standard locations.
 */
export async function discoverSpecFiles(repoPath: string): Promise<string[]> {
    const patterns = [
        '**/openapi.{json,yaml,yml}',
        '**/swagger.{json,yaml,yml}',
        '**/*.openapi.{json,yaml,yml}',
        '**/asyncapi.{json,yaml,yml}',
        // Broad search for potential specs
        '**/*.{json,yaml,yml}',
        // Protobuf and Avro
        '**/*.proto',
        '**/*.avsc',
    ];
    // Language-specific ignores from plugins + universal ignores
    const ignore = [...new Set([...getAllIgnorePatterns(), '**/.git/**'])];

    const allFiles = await glob(patterns, {
        cwd: repoPath,
        absolute: true,
        ignore,
        nodir: true,
    });

    const specMarkers = [
        'openapi:',
        'swagger:',
        'asyncapi:',
        '"openapi":',
        '"swagger":',
        '"asyncapi":',
    ];

    const discovered = new Set<string>();

    for (const file of allFiles) {
        const ext = path.extname(file).toLowerCase();

        // Protobuf and Avro are always included if they match the glob
        if (ext === '.proto' || ext === '.avsc') {
            discovered.add(file);
            continue;
        }

        // Standard names are always included
        const basename = path.basename(file).toLowerCase();
        if (
            basename.startsWith('openapi.') ||
            basename.startsWith('swagger.') ||
            basename.startsWith('asyncapi.') ||
            basename.includes('.openapi.')
        ) {
            discovered.add(file);
            continue;
        }

        // For other JSON/YAML files, check content
        try {
            // Read first 2KB for performance - markers are usually at the top
            const buffer = Buffer.alloc(2048);
            const fd = fs.openSync(file, 'r');
            const bytesRead = fs.readSync(fd, buffer, 0, 2048, 0);
            fs.closeSync(fd);

            const content = buffer.toString('utf8', 0, bytesRead);
            if (specMarkers.some(marker => content.includes(marker))) {
                discovered.add(file);
            }
        } catch (err) {
            // Skip files we can't read
            logger.debug(`(source-resolver) Failed to read ${file} for marker check: ${(err as Error).message}`);
        }
    }

    return Array.from(discovered);
}
