/**
 * Repo-wide scanner for env-var REFERENCES in source code.
 *
 * Returns the set of env-var names that the analyzed repo's code actually
 * READS at runtime — via `getenv()`, `process.env.X`, `os.environ.get()`,
 * `os.Getenv()`, Symfony `%env(X)%`, etc.
 *
 * Why this exists:
 *   docker-compose.yml frequently declares env vars for SIDECAR services
 *   (auxiliary containers like a Mongo, a quote engine, a workers pool…)
 *   that the analyzed repo's code never references. The orchestrator's
 *   env-trio synthesizers, if applied to the raw merged env map, would
 *   emit phantom Datastore identities for those sidecar vars (e.g.
 *   `DB_SELF_HOST + DB_SELF_DBNAME` from a sidecar service) — the LLM
 *   assignment step then has to invent splits between phantom and real DBs.
 *
 *   The authoritative signal for "this env var represents a real datastore"
 *   is "the code reads it". Whatever lives in deployment manifests is
 *   irrelevant if the code never consumes it.
 *
 *   This signal is robust against the deployment edge cases that defeat
 *   service-scoped env-var attribution:
 *     - One `.env` file mounted into multiple containers.
 *     - External docker folders (outside the repo).
 *     - Dynamic compose: includes, partials, profiles, anchors.
 *     - Templated values (`{{ .Values.x }}`, `${VAR}`, `%env(...)%`).
 *
 * Trade-off: dynamic name construction (`getenv("DB_" . $prefix . "_HOST")`)
 * is invisible to a static scan. Repos that rely on this pattern fall
 * through to the manual `coderadius.yaml databases[]` path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import type { EnvAccessor } from '../../../config/repo-hints.js';
import { scanCodeAccessorEnvVars } from './env-accessor-scanner.js';

// ─── Read patterns ───────────────────────────────────────────────────────────
//
// Each pattern's first capture group is the env-var name. Names are filtered
// to UPPERCASE_WITH_UNDERSCORES to keep noise out (lowercase identifiers in
// these positions are usually local variables, not env vars).

const ENV_REF_PATTERNS: RegExp[] = [
    // PHP
    /getenv\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    /\$_ENV\s*\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
    /\$_SERVER\s*\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
    // JS / TS
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
    // Python
    /os\.environ\.get\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    /os\.environ\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
    /os\.getenv\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    // Go
    /os\.Getenv\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    /os\.LookupEnv\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    // .NET
    /Environment\.GetEnvironmentVariable\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    // Symfony / Helm-style %env(KEY)% — handles modifiers (`resolve:`, `default:fallback:`, …)
    /%env\(\s*(?:[a-z]+\s*:\s*)*([A-Z][A-Z0-9_]+)\s*\)%/g,
];

// ─── Walk strategy ───────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
    '.git', '.hg', '.svn',
    'node_modules', 'vendor',
    'dist', 'build', '.next', '.nuxt', 'out', 'target',
    '.venv', 'venv', '.env',                    // .env DIR — `.env` FILE is scanned
    'coverage', '.cache', '.pytest_cache', '__pycache__',
    'public', 'static', 'assets',
]);

const SCAN_EXTENSIONS = new Set([
    '.php', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.cs', '.rb', '.kt', '.java', '.scala', '.rs',
    '.yaml', '.yml', '.json', '.xml', '.ini', '.conf', '.toml',
]);

const MAX_FILE_BYTES = 1_000_000;     // 1 MB; skip larger files (asset blobs)

function shouldScanFile(name: string): boolean {
    // .env, .env.production, .env.dist, .env.example, … contain VALUES, not
    // references. Skip them — `getenv` patterns won't match anyway, and the
    // names defined there are not "code-referenced" by definition.
    if (name.startsWith('.env')) return false;
    const ext = path.extname(name).toLowerCase();
    return SCAN_EXTENSIONS.has(ext);
}

// ─── Shared file walk ────────────────────────────────────────────────────────

/**
 * @internal Walk every scannable source file under `repoPath` (same skip-dir,
 * extension and size policy as the env-reference scan). Shared with the
 * declared env-accessor scanner so both lexical passes see the same universe.
 */
export function* walkScannableFiles(repoPath: string): Generator<{ abs: string; content: string }> {
    const stack: string[] = [repoPath];

    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) {
            logger.debug(`[CodeEnvScanner] readdir failed: ${dir}: ${(e as Error).message}`);
            continue;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            if (!shouldScanFile(entry.name)) continue;
            let stat: fs.Stats;
            try { stat = fs.statSync(full); } catch { continue; }
            if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;
            let content: string;
            try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
            yield { abs: full, content };
        }
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Walk the repo and return the union of env-var names referenced by source
 * code: the built-in ENV_REF_PATTERNS plus any keys read through DECLARED
 * env-accessor wrappers (coderadius.yaml `envAccessors`).
 *
 * Memoized per (repoPath, accessor config) — the accessor set is part of the
 * cache key, so the same path scanned under different configs never bleeds.
 * Call `clearCodeEnvVarCache(repoPath)` to invalidate every variant.
 */
const _cache = new Map<string, Set<string>>();

const cacheKey = (repoPath: string, accessors: readonly EnvAccessor[]) =>
    `${repoPath} ${JSON.stringify(accessors)}`;

export function clearCodeEnvVarCache(repoPath?: string): void {
    if (!repoPath) { _cache.clear(); return; }
    const prefix = `${repoPath} `;
    for (const k of [..._cache.keys()]) if (k.startsWith(prefix)) _cache.delete(k);
}

export function scanCodeReferencedEnvVars(
    repoPath: string,
    accessors: readonly EnvAccessor[] = [],
): Set<string> {
    const key = cacheKey(repoPath, accessors);
    const cached = _cache.get(key);
    if (cached) return cached;

    const out = new Set<string>();
    for (const { content } of walkScannableFiles(repoPath)) {
        for (const pat of ENV_REF_PATTERNS) {
            pat.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = pat.exec(content)) !== null) {
                out.add(m[1]);
            }
        }
    }

    if (accessors.length > 0) {
        for (const k of scanCodeAccessorEnvVars(repoPath, accessors).keys) out.add(k);
    }

    _cache.set(key, out);
    return out;
}
