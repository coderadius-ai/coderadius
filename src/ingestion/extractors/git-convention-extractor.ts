/**
 * Git Convention Extractor — Commit Message Compliance Signals
 *
 * Scans recent commit messages on the default branch and computes compliance
 * rates against two common conventions:
 *
 *   1. Ticket ID prefix:        e.g. "ABC-123 ..."          → ticketIdRate
 *   2. Conventional Commits:    e.g. "feat: ...", "fix: ..."  → conventionalCommitRate
 *
 * Output is two ratios in [0..1] plus the sample size actually scanned. The
 * function never throws: any git failure (shallow clone, missing HEAD, etc.)
 * collapses to zeros so the ingestion pipeline keeps moving.
 */
import { simpleGit } from 'simple-git';
import { logger } from '../../utils/logger.js';

const GIT_TIMEOUT = process.env.RADIUS_GIT_TIMEOUT_MS
    ? parseInt(process.env.RADIUS_GIT_TIMEOUT_MS, 10)
    : 15_000;

/** Default number of commits to inspect when no override is provided. */
const DEFAULT_MAX_COMMITS = 50;

/** Matches a leading ticket-ID like "ABC-123", "ORD-7", "BUG-9001" — at least 2 letters, then dash, then digits. */
const TICKET_ID_RE = /^[A-Z]{2,}-\d+\b/;

/**
 * Matches the Conventional Commits prefix. Body and footer are not considered;
 * the prefix is the load-bearing signal.
 *
 *   [TICKET-123 ]<type>[(scope)][!]: <description>
 *
 * An optional ticket-ID prefix is tolerated because some workflows (Jira-driven
 * teams, for example) interleave ticket and conv prefix as
 *   "ABC-123 feat: new endpoint".
 * The intent of the policy is to score the conv prefix, not to forbid the
 * ticket annotation that precedes it.
 */
const CONVENTIONAL_COMMITS_RE =
    /^(?:[A-Z]{2,}-\d+\s+)?(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|hotfix|wip)(\([^)]+\))?(!)?:\s+/i;

export interface GitConventions {
    /** Fraction of scanned commits whose subject starts with a ticket ID prefix. 0..1 */
    ticketIdRate: number;
    /** Fraction of scanned commits whose subject follows Conventional Commits. 0..1 */
    conventionalCommitRate: number;
    /** How many commits were actually scanned (may be less than maxCommits on shallow clones). */
    sampleSize: number;
}

const EMPTY: GitConventions = {
    ticketIdRate: 0,
    conventionalCommitRate: 0,
    sampleSize: 0,
};

/**
 * Compute commit-message convention compliance for a local git repository.
 *
 * Never throws. On any git failure (no HEAD, shallow clone, IO error) returns
 * the EMPTY sentinel so the caller can write zeros into the graph without
 * special-casing.
 */
export async function extractGitConventions(
    repoPath: string,
    options?: { maxCommits?: number },
): Promise<GitConventions> {
    const maxCommits = options?.maxCommits ?? DEFAULT_MAX_COMMITS;

    try {
        const git = simpleGit({
            baseDir: repoPath,
            timeout: { block: GIT_TIMEOUT },
        });

        // simple-git returns a Log with `all: ReadonlyArray<DefaultLogFields>`.
        // We only need the subject line — the format token %s is the default
        // when no `format` override is passed but we ask explicitly so the
        // payload stays small.
        const log = await git.log({ maxCount: maxCommits, format: { subject: '%s' } });
        const subjects = log.all
            .map(entry => (entry as unknown as { subject?: string }).subject ?? '')
            .filter(s => s.length > 0);

        if (subjects.length === 0) {
            return EMPTY;
        }

        let ticketMatches = 0;
        let conventionalMatches = 0;
        for (const subject of subjects) {
            if (TICKET_ID_RE.test(subject)) ticketMatches++;
            if (CONVENTIONAL_COMMITS_RE.test(subject)) conventionalMatches++;
        }

        return {
            ticketIdRate: ticketMatches / subjects.length,
            conventionalCommitRate: conventionalMatches / subjects.length,
            sampleSize: subjects.length,
        };
    } catch (err) {
        logger.debug(`(git-convention) skipped ${repoPath}: ${(err as Error).message}`);
        return EMPTY;
    }
}
