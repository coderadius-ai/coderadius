// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine: Git-web URL resolver for impacted file paths
//
// Builds clickable Git provider URLs (GitHub / GitLab style) for impacted
// function files, when the repository node carries a `url` (populated by
// `cr analyze code` from `git remote get-url origin`).
//
// Returns `null` when no URL is available so callers fall back to the
// relative path. ABSOLUTE LOCAL PATHS ARE INTENTIONALLY NOT PRODUCED here:
//   - They leak the developer's home directory in CI/demo output.
//   - They're not portable across reviewers (PR comments are seen on a
//     different machine than the runner).
// ═══════════════════════════════════════════════════════════════════════════════

export type FilePathResolver = (svcRepoUrl: string | null, relativeFile: string) => string | null;

export function makeFilePathResolver(): FilePathResolver {
    return (svcRepoUrl, relativeFile) => {
        if (!relativeFile) return null;
        if (!svcRepoUrl) return null;
        const cleanUrl = svcRepoUrl.replace(/\.git$/, '').replace(/\/+$/, '');
        // GitLab uses `/-/blob/<ref>/<path>`; GitHub uses `/blob/<ref>/<path>`.
        // Bitbucket uses `/src/<ref>/<path>`. Default to GitHub-style for
        // unknown hosts; the worst case is a slightly wrong link, not a leak.
        if (/gitlab\./i.test(cleanUrl)) {
            return `${cleanUrl}/-/blob/HEAD/${relativeFile}`;
        }
        if (/bitbucket\./i.test(cleanUrl)) {
            return `${cleanUrl}/src/HEAD/${relativeFile}`;
        }
        return `${cleanUrl}/blob/HEAD/${relativeFile}`;
    };
}
