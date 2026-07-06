/**
 * git-url.ts — Git hosting URL normaliser
 *
 * Converts raw git remote URLs (SSH or HTTPS, with or without .git suffix)
 * into direct web links to a specific file in a repository.
 *
 * Supports GitHub, GitLab (cloud + self-hosted), and Bitbucket.
 *
 * Examples of inputs:
 *   git@github.com:org/repo.git        → https://github.com/org/repo
 *   git@gitlab.com:org/repo.git        → https://gitlab.com/org/repo
 *   git@gitlab.example.com:org/repo.git → https://gitlab.example.com/org/repo
 *   https://github.com/org/repo.git   → https://github.com/org/repo
 *   https://bitbucket.org/org/repo    → https://bitbucket.org/org/repo
 */

type GitHost = 'github' | 'gitlab' | 'bitbucket' | 'generic';

interface ParsedRepoUrl {
    host: string;
    hostType: GitHost;
    org: string;
    repo: string;
    /** Canonical HTTPS base URL (no trailing slash, no .git) */
    baseUrl: string;
}

/**
 * Detect the git hosting platform from the hostname.
 */
function detectHostType(host: string): GitHost {
    const h = host.toLowerCase();
    if (h === 'github.com' || h.endsWith('.github.com')) return 'github';
    if (h === 'gitlab.com' || h.includes('gitlab')) return 'gitlab';
    if (h === 'bitbucket.org' || h.includes('bitbucket')) return 'bitbucket';
    return 'generic';
}

/**
 * Parse a raw git remote URL (SSH or HTTPS) into structured parts.
 * Returns null if the URL cannot be recognised as a valid git remote.
 */
function parseRepoUrl(rawUrl: string): ParsedRepoUrl | null {
    if (!rawUrl) return null;

    let host: string;
    let path: string;

    // ── SSH format: git@HOST:ORG/REPO[.git] ────────────────────────────
    const sshMatch = rawUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch) {
        host = sshMatch[1];
        path = sshMatch[2]; // e.g. "org/repo" or "group/sub/repo"
    } else {
        // ── HTTPS format: https://HOST/ORG/REPO[.git] ──────────────────
        let url: URL;
        try {
            url = new URL(rawUrl);
        } catch {
            return null;
        }

        if (!['http:', 'https:'].includes(url.protocol)) return null;

        host = url.hostname;
        path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    }

    // path should be "org/repo" or "group/subgroup/repo" for GitLab
    // Single-segment paths (root-level projects on self-hosted GitLab) are also valid.
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 1) return null;

    const repo = parts[parts.length - 1];
    const org = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

    const baseUrl = org
        ? `https://${host}/${org}/${repo}`
        : `https://${host}/${repo}`;
    const hostType = detectHostType(host);

    return { host, hostType, org, repo, baseUrl };
}

/**
 * Build the URL segment for viewing a file blob, based on the hosting platform.
 *
 * | Platform   | Pattern                             |
 * |----------- |--------------------------------------|
 * | GitHub     | /blob/<branch>/<path>               |
 * | GitLab     | /-/blob/<branch>/<path>             |
 * | Bitbucket  | /src/<branch>/<path>                |
 * | Generic    | /blob/<branch>/<path>  (fallback)   |
 */
function blobSegment(hostType: GitHost, branch: string, filePath: string): string {
    // strip leading slash from filePath if any
    const fp = filePath.replace(/^\//, '');
    switch (hostType) {
        case 'gitlab':    return `/-/blob/${branch}/${fp}`;
        case 'bitbucket': return `/src/${branch}/${fp}`;
        default:          return `/blob/${branch}/${fp}`;
    }
}

/**
 * Builds a direct web link to a specific file (and optionally a specific line) in a git repository.
 *
 * @param repoUrl  - Raw git remote URL (SSH or HTTPS)
 * @param filePath - Relative file path within the repository
 * @param branch   - Branch name (defaults to "main")
 * @param line     - Optional start line number; appended as #L{n} anchor
 * @returns        - Full HTTPS URL to the file (with optional #L anchor), or null if it can't be built
 */
export function buildFileUrl(
    repoUrl: string | null | undefined,
    filePath: string | null | undefined,
    branch = 'main',
    line?: number | null,
): string | null {
    if (!repoUrl || !filePath) return null;

    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) return null;

    // Safety: if filePath looks like an absolute local path (starts with /),
    // we can't safely determine the relative portion — skip rather than produce garbage.
    // (This would indicate the graph has a stale absolute path stored.)
    if (filePath.startsWith('/')) {
        return null;
    }

    const base = `${parsed.baseUrl}${blobSegment(parsed.hostType, branch, filePath)}`;
    return (line != null && line > 0) ? `${base}#L${line}` : base;
}

/**
 * Normalise a raw git remote URL to a canonical HTTPS base URL for the repository
 * (no trailing slash, no .git suffix). Useful for repository-level links.
 *
 * Returns the original URL unchanged if it's already a valid HTTPS URL and just
 * needs .git stripped, or null if it can't be parsed.
 */
export function normaliseRepoUrl(rawUrl: string | null | undefined): string | null {
    if (!rawUrl) return null;
    const parsed = parseRepoUrl(rawUrl);
    return parsed?.baseUrl ?? null;
}
