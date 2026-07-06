// ═══════════════════════════════════════════════════════════════════════════════
// Git Tag Scanner — Release History Backfill
//
// Scans git tags to reconstruct the full release timeline for internal
// packages. Called AFTER the structural plugin has identified which packages
// are published from a repository.
//
// Performance: exactly 2 git calls per repo (tag list + for-each-ref).
// Resilience: gracefully returns [] if .git is missing, git is unavailable,
// or any git operation fails.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import semver from 'semver';
import { logger } from '../../utils/logger.js';

export interface GitTagRelease {
    packageName: string;
    ecosystem: string;
    version: string;
    tagName: string;
    /** ISO 8601 date from the tag's commit */
    tagDate: string;
}

export interface PublisherInfo {
    packageName: string;
    ecosystem: string;
}

/**
 * Multi-strategy tag matching.
 *
 * Given a tag name and a list of known publishers, attempts to extract
 * a valid semver version and associate it with a publisher.
 *
 * Strategy order (most specific → least specific):
 *   1. Scoped exact:   `@scope/name@1.2.3`  or `@scope/name/v1.2.3`
 *   2. Unscoped exact: `name@1.2.3`         or `name/v1.2.3`
 *   3. Simple (only if repo has a single publisher): `v1.2.3` or `1.2.3`
 */
export function matchTagToPublisher(
    tagName: string,
    publishers: PublisherInfo[],
): { publisher: PublisherInfo; version: string } | null {

    // ── Strategy 1 & 2: name-prefixed tags ──────────────────────────────────
    for (const pub of publishers) {
        const name = pub.packageName;

        // Patterns:  @scope/pkg@1.2.3  |  @scope/pkg/v1.2.3  |  pkg@1.2.3  |  pkg/v1.2.3
        const prefixes = [
            `${name}@`,     // @acme/auth@1.2.3  or  logger-php@1.2.3
            `${name}/v`,    // @acme/auth/v1.2.3
            `${name}/`,     // @acme/auth/1.2.3
        ];

        // For scoped packages, also try the short name: @acme/auth → auth
        const shortName = name.includes('/') ? name.split('/').pop()! : null;
        if (shortName) {
            prefixes.push(`${shortName}@`);    // auth@1.2.3
            prefixes.push(`${shortName}/v`);   // auth/v1.2.3
        }

        for (const prefix of prefixes) {
            if (tagName.startsWith(prefix)) {
                const raw = tagName.slice(prefix.length);
                const cleaned = semver.valid(semver.clean(raw));
                if (cleaned) {
                    return { publisher: pub, version: cleaned };
                }
            }
        }
    }

    // ── Strategy 3: simple tags (only when exactly 1 publisher) ─────────────
    if (publishers.length === 1) {
        // v1.2.3 or 1.2.3
        const raw = tagName.startsWith('v') ? tagName.slice(1) : tagName;
        const cleaned = semver.valid(semver.clean(raw));
        if (cleaned) {
            return { publisher: publishers[0], version: cleaned };
        }
    }

    return null;
}

/**
 * Scan git tags in a repository and build Release entries for known publishers.
 *
 * Resilient by design:
 *  - No .git directory → returns []
 *  - git binary missing → returns []
 *  - Any git error → returns [] with a debug log
 *  - 5s timeout on git operations
 */
export async function scanGitTagReleases(
    repoPath: string,
    publishers: PublisherInfo[],
): Promise<GitTagRelease[]> {
    if (publishers.length === 0) return [];

    // ── Guard: no .git directory ────────────────────────────────────────────
    const gitDir = path.join(repoPath, '.git');
    if (!fs.existsSync(gitDir)) {
        logger.debug(`[GitTagScanner] No .git in ${repoPath} — skipped`);
        return [];
    }

    try {
        const git = simpleGit(repoPath).env({
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',   // never prompt for credentials
        });

        // ── 1. Get all tags ─────────────────────────────────────────────────
        const tagResult = await git.tags();
        const allTags = tagResult.all;

        if (allTags.length === 0) {
            logger.debug(`[GitTagScanner] No tags in ${repoPath}`);
            return [];
        }

        // ── 2. Match tags to publishers ─────────────────────────────────────
        const matched: Array<{ tagName: string; publisher: PublisherInfo; version: string }> = [];

        for (const tag of allTags) {
            const match = matchTagToPublisher(tag, publishers);
            if (match) {
                matched.push({ tagName: tag, ...match });
            }
        }

        if (matched.length === 0) {
            logger.debug(`[GitTagScanner] ${allTags.length} tags found, none matched publishers`);
            return [];
        }

        // ── 3. Get dates for matched tags in a single batch call ────────────
        // `git for-each-ref` with custom format is the fastest way to bulk-read
        // tag metadata without spawning N git processes.
        const refPatterns = matched.map(m => `refs/tags/${m.tagName}`);
        const rawOutput = await git.raw([
            'for-each-ref',
            '--format=%(refname:short)\t%(creatordate:iso-strict)',
            ...refPatterns,
        ]);

        const dateMap = new Map<string, string>();
        for (const line of rawOutput.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const [tagName, date] = trimmed.split('\t');
            if (tagName && date) {
                dateMap.set(tagName, date);
            }
        }

        // ── 4. Build release entries ────────────────────────────────────────
        const releases: GitTagRelease[] = [];

        for (const m of matched) {
            const tagDate = dateMap.get(m.tagName);
            if (!tagDate) {
                // Fallback: if for-each-ref didn't return a date (rare edge case),
                // use current time rather than losing the release entirely.
                logger.debug(`[GitTagScanner] No date for tag ${m.tagName}, using now`);
            }

            releases.push({
                packageName: m.publisher.packageName,
                ecosystem: m.publisher.ecosystem,
                version: m.version,
                tagName: m.tagName,
                tagDate: tagDate ?? new Date().toISOString(),
            });
        }

        logger.debug(`[GitTagScanner] Found ${releases.length} release(s) from ${allTags.length} tag(s) in ${repoPath}`);
        return releases;

    } catch (err) {
        // Total isolation: git failures must NEVER crash ingestion
        logger.debug(`[GitTagScanner] Git error in ${repoPath}: ${(err as Error).message}`);
        return [];
    }
}
