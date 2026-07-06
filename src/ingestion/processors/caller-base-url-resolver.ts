/**
 * Caller-side base URL resolution for the `:CALLS` edge.
 *
 * When the LLM emits an emergent endpoint like `POST /quote`, the graph
 * writer needs to know WHICH base URL the caller actually targeted (so the
 * URL-match welder in `global-resolver.ts` can match it against a provider
 * `:APIDeployment`). The base URL is usually NOT in the LLM output: it's
 * threaded through an env-var at call site.
 *
 * This module extracts env-var references from the chunk source code,
 * resolves them against the repo env-map, and returns the canonicalised
 * caller URL + the environment it was sourced from.
 *
 * Language-agnostic: works on `process.env.X`, `\getenv('X')`, `os.Getenv("X")`,
 * `os.environ["X"]`. Plugins MAY provide stricter extractors via
 * `LanguagePlugin.extractEnvVars`, but for our purposes the regex below
 * covers all four target languages today.
 */
import { resolveTemplates, type RepoEnvMap } from './connection-extractors/env-var-resolver.js';
import { canonicalizeBaseUrl, parseBaseUrl } from '../../utils/url-normalizer.js';

// Order matters: try the most specific pattern first. Each regex captures the
// env-var name in group 1.
const ENV_REF_PATTERNS: ReadonlyArray<RegExp> = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,         // TS/JS: process.env.X
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g, // TS/JS bracket: process.env['X']
    /\\?getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,  // PHP: \getenv('X') / getenv('X')
    /\$_(?:ENV|SERVER)\[['"]([A-Z][A-Z0-9_]*)['"]\]/g, // PHP superglobals
    /os\.Getenv\(\s*"([A-Z][A-Z0-9_]*)"/g,       // Go: os.Getenv("X")
    /os\.environ(?:\.get)?\[?['"]([A-Z][A-Z0-9_]*)['"]\]?/g, // Python: os.environ["X"] / .get('X')
    /\bgetenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,    // Plain C/shell-style fallback
];

export interface CallerBaseUrlResolution {
    /** Canonicalised base URL (scheme://host[:port][basePath]). */
    canonicalUrl: string;
    /** Verbatim resolved value (audit). */
    rawUrl: string;
    /** Env-var key the URL was sourced from (e.g. `PAYMENT_URL`). */
    sourceEnvKey: string;
    /** Environment tag derived from the source file (`production`, `staging`, ...). */
    environment: string;
}

/**
 * Extract env-var references from a chunk's source code and return the
 * resolved base URL, if any. Returns `null` when:
 *   - no env-var matches one of `ENV_REF_PATTERNS`
 *   - the matching env-var key is not in `envMap`
 *   - the resolved value is not a valid base URL (no scheme, port-only, etc.)
 *
 * When multiple env-vars in the chunk resolve to base URLs, returns the
 * first one found (chunk source is usually short; the heuristic is good
 * enough for the URL welder, which falls back gracefully on no match).
 */
export function resolveCallerBaseUrl(
    sourceCode: string,
    envMap: RepoEnvMap,
): CallerBaseUrlResolution | null {
    const seen = new Set<string>();
    for (const pattern of ENV_REF_PATTERNS) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(sourceCode)) !== null) {
            const key = m[1];
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const entry = envMap.vars.get(key);
            if (!entry) continue;
            const resolved = resolveTemplates(entry.value, 'shell', envMap, { maxDepth: 5 });
            if (!resolved.resolved) continue;
            const parsed = parseBaseUrl(resolved.value);
            if (!parsed) continue;
            return {
                canonicalUrl: canonicalizeBaseUrl(resolved.value),
                rawUrl: resolved.value,
                sourceEnvKey: key,
                environment: deriveEnvironmentFromSource(entry.sourceFile),
            };
        }
    }
    return null;
}

/**
 * Heuristic: file path → environment label.
 *   `.env.production` / `values-production.yaml` / `helm/prod/...`  → 'production'
 *   `.env.staging`    / `values-staging.yaml`                       → 'staging'
 *   `.env.dev` / `.env.local` / `docker-compose.override.yml`       → 'dev' / 'local'
 *   `.env` / `docker-compose.yml`                                   → 'unknown'
 */
export function deriveEnvironmentFromSource(sourceFile: string): string {
    const f = sourceFile.toLowerCase();
    if (/(?:^|[\/.])\.?env\.prod(?:uction)?\b/.test(f)) return 'production';
    if (/values-?prod(?:uction)?/.test(f)) return 'production';
    if (/\bprod(?:uction)?\b/.test(f) && !/non-?prod/.test(f)) return 'production';
    if (/(?:^|[\/.])\.?env\.staging\b/.test(f)) return 'staging';
    if (/values-?staging/.test(f)) return 'staging';
    if (/(?:^|[\/.])\.?env\.(?:dev|development|qa|test|canary)\b/.test(f)) return 'dev';
    if (/values-?(?:dev|qa|test|canary)/.test(f)) return 'dev';
    if (/(?:^|[\/.])\.?env\.local\b/.test(f)) return 'local';
    if (/docker-compose\.override\.ya?ml/.test(f)) return 'local';
    return 'unknown';
}
