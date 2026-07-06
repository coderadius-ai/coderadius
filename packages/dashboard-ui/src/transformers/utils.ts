/**
 * Shared display utilities for transformers.
 * Isomorphic — no Node.js / Bun APIs.
 */

export const getMaturityColor = (level: number) => {
    switch (level) {
        case 0: return "color-bg-dim";
        case 1: return "color-bg-yellow";
        case 2: return "color-bg-cyan";
        case 3: return "color-bg-green";
        case 4: return "color-bg-magenta";
        default: return "color-bg-dim";
    }
};

export const LIVENESS_LABEL: Record<string, string> = {
    elite: 'Elite',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    unknown: '—',
};

export const LIVENESS_COLOR: Record<string, string> = {
    elite: '#22c55e',
    high: '#22d3ee',
    medium: '#eab308',
    low: '#71717a',
    unknown: '#52525b',
};

import { tierFromCommits } from '@coderadius/shared-types';

export function activityFromCommits(commits: number | null | undefined): number {
    if (commits == null) return 0;
    return Math.min(100, Math.round((Math.log1p(Math.max(0, commits)) / Math.log1p(120)) * 100));
}

export const getPulseBadge = (commits: number | null | undefined): { text: string; color: any } => {
    switch (tierFromCommits(commits)) {
        case 'elite':  return { text: 'ELITE', color: 'green' };
        case 'high':   return { text: 'HIGH', color: 'cyan' };
        case 'medium': return { text: 'MEDIUM', color: 'yellow' };
        case 'low':    return { text: 'LOW', color: 'dim' };
        default:       return { text: '--', color: 'dim' };
    }
};

export const toHttpUrl = (rawUrl: string) => {
    let url = rawUrl.replace(/\.git$/, "");
    if (url.startsWith("git@")) {
        url = "https://" + url.replace("git@", "").replace(":", "/");
    }
    return url;
};

export const countWithTooltip = (count: number, names: string[] | Set<string>) => {
    const arr = Array.isArray(names) ? names : Array.from(names);
    const tooltip = arr.length > 0
        ? arr.slice(0, 15).join(', ') + (arr.length > 15 ? ` (+${arr.length - 15} more)` : '')
        : undefined;
    return { text: String(count), sortValue: count, tooltip };
};

/**
 * Count cell with a click-anchored list popover. Any non-zero count becomes
 * a clickable button, so the affordance is consistent regardless of list
 * size and users always have a way to drill in.
 *
 * `subtitleOf` lets the caller attach per-item context (e.g. file path)
 * without forcing the names array to carry it.
 */
export const countWithPopover = (
    count: number,
    names: string[] | Set<string>,
    title: string,
    subtitleOf?: (name: string) => string | undefined,
) => {
    const arr = Array.isArray(names) ? names : Array.from(names);
    const cell: { text: string; sortValue: number; popover?: { title: string; items: { text: string; subtitle?: string }[] } } = {
        text: String(count),
        sortValue: count,
    };
    if (arr.length > 0) {
        cell.popover = {
            title,
            items: arr.map(n => ({ text: n, subtitle: subtitleOf?.(n) })),
        };
    }
    return cell;
};

/** Extract org/repo path from a git URL for display: gitlab.com/org/repo → org/repo */
export function repoPath(url: string | null, fallbackName: string): string {
    if (!url) return fallbackName;
    const http = toHttpUrl(url);
    try {
        const u = new URL(http);
        // pathname: /org/group/repo → org/group/repo
        const path = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
        return path || fallbackName;
    } catch {
        return fallbackName;
    }
}

// ─── Fuzzy Matching ──────────────────────────────────────────────────────────

/** Levenshtein edit distance — for fuzzy "did you mean?" suggestions */
export function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
}

/** Find closest match with edit distance ≤ 2 (returns null if no close match) */
export function findClosestMatch(target: string, candidates: string[]): string | null {
    let best: string | null = null;
    let bestDist = 3; // threshold: edit distance must be < 3
    for (const c of candidates) {
        const d = levenshtein(target.toLowerCase(), c.toLowerCase());
        if (d > 0 && d < bestDist) { best = c; bestDist = d; }
    }
    return best;
}

// ─── Service Qualification ───────────────────────────────────────────────────

/** Service names that are inherently ambiguous without repo context */
const GENERIC_NAMES = new Set([
    'api', 'app', 'web', 'console', 'worker', 'gateway', 'proxy',
    'server', 'backend', 'frontend', 'service', 'core', 'main',
    'admin', 'client', 'scheduler', 'cron', 'jobs', 'auth',
    'helper', 'utils', 'shared', 'common', 'consumer', 'producer',
    'lambda', 'function', 'handler', 'bot', 'tool', 'cli',
]);

/** Whether a service name needs repo context to be meaningful. */
export function needsQualification(name: string): boolean {
    return GENERIC_NAMES.has(name.toLowerCase()) || name.length <= 3;
}

/** Extract short repo name from a git URL (e.g. git@gitlab.com:org/acme.git → acme). */
export function repoNameFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const http = toHttpUrl(url);
    try {
        const u = new URL(http);
        const segments = u.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
        return segments[segments.length - 1] || null;
    } catch {
        return null;
    }
}

/**
 * Build the set of repo names that contain ≥2 services. Pass any iterable of
 * objects exposing a repo name (`repoName`, `repository.name`, or anything
 * the caller maps to a string). Single source of truth for "this service
 * lives inside a monorepo, qualify it uniformly".
 */
export function buildMultiServiceRepoSet(repoNames: Iterable<string | null | undefined>): Set<string> {
    const counts = new Map<string, number>();
    for (const r of repoNames) {
        if (!r) continue;
        counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    const out = new Set<string>();
    for (const [r, n] of counts) if (n >= 2) out.add(r);
    return out;
}

/**
 * Compute the qualifiedContext for a service name given its repo name.
 *
 * - In a single-service repo, qualify only if the name is generic
 *   (e.g. `api`, `worker`) so non-generic names stay clean (`checkout` rather
 *   than `checkout-repo / checkout`).
 * - In a multi-service monorepo (`isMultiServiceRepo`), qualify EVERY service
 *   with the repo prefix so the table is visually uniform — `acme / api`
 *   sits next to `acme / cover`, never bare `cover` next to `acme / api`.
 */
export function getItemQualification(
    serviceName: string,
    repoName: string | null | undefined,
    isMultiServiceRepo = false,
): string | null {
    if (!repoName || repoName === serviceName) return null;
    if (isMultiServiceRepo) return repoName;
    if (!needsQualification(serviceName)) return null;
    return repoName;
}

/**
 * Same as getItemQualification but extracts the repo name from a URL first.
 */
export function getItemQualificationFromUrl(
    serviceName: string,
    repoUrl: string | null | undefined,
    isMultiServiceRepo = false,
): string | null {
    return getItemQualification(serviceName, repoNameFromUrl(repoUrl), isMultiServiceRepo);
}
