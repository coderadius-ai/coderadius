import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { logger } from '../../../utils/logger.js';
import type {
    BrokerCandidateHint,
    HttpEndpointHint,
    MessageBrokerHintProvider,
    TemplateSyntax,
} from './types.js';
import { defineHeuristic } from '../../core/heuristics.js';

export interface EnvVarEntry {
    value: string;
    sourceFile: string;
    confidence: 'high' | 'medium' | 'low';
}

export interface RepoEnvMap {
    vars: Map<string, EnvVarEntry>;
}

interface EnvFileTarget {
    rel: string;
    confidence: 'high' | 'medium' | 'low';
}

const ENV_FILE_PRIORITY: EnvFileTarget[] = [
    { rel: '.env.production', confidence: 'high' },
    { rel: '.env.prod', confidence: 'high' },
    { rel: '.env.local', confidence: 'high' },
    { rel: '.env', confidence: 'high' },
    { rel: '.env.example', confidence: 'medium' },
    { rel: '.env.sample', confidence: 'medium' },
    { rel: '.env.template', confidence: 'medium' },
];

const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function parseEnvFile(content: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = ENV_LINE_RE.exec(line);
        if (!m) continue;
        let value = m[2] ?? '';
        // strip surrounding quotes
        if (value.length >= 2 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        // trim trailing inline comment for unquoted values
        if (!m[2].startsWith('"') && !m[2].startsWith("'")) {
            const hashIdx = value.indexOf(' #');
            if (hashIdx >= 0) value = value.slice(0, hashIdx).trimEnd();
        }
        out.set(m[1], value);
    }
    return out;
}

export interface ComposeServiceEnv {
    serviceName: string;
    env: Map<string, string>;
    /** Relative paths declared under the service's `env_file:` (verbatim). */
    envFiles: string[];
}

/**
 * Normalize a compose `env_file:` field to a list of relative paths. Accepts
 * the string form (`env_file: ./x.env`), the list form, and the compose-spec
 * object form (`- path: ./x.env\n  required: false`).
 */
function parseEnvFileField(raw: any): string[] {
    const toPath = (item: any): string | null => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.path === 'string') return item.path;
        return null;
    };
    if (!raw) return [];
    if (typeof raw === 'string') return [raw];
    if (Array.isArray(raw)) return raw.map(toPath).filter((p): p is string => !!p);
    return [];
}

/**
 * Per-service compose env: the inline `environment:` block (array and object
 * forms) plus the verbatim `env_file:` paths. A service with only `env_file:`
 * (no inline block) is still returned so its referenced files get resolved.
 * The merged repo-global reader below is layered on top — its first-writer-wins
 * output is pinned.
 */
export function readDockerComposeEnvByService(content: string): ComposeServiceEnv[] {
    const out: ComposeServiceEnv[] = [];
    let doc: any;
    try { doc = yaml.load(content); } catch { return out; }
    if (!doc || typeof doc !== 'object') return out;
    const services = (doc as any).services;
    if (!services || typeof services !== 'object') return out;
    for (const [serviceName, svc] of Object.entries<any>(services)) {
        const env = svc?.environment;
        const envFiles = parseEnvFileField(svc?.env_file);
        const map = new Map<string, string>();
        if (Array.isArray(env)) {
            for (const item of env) {
                if (typeof item !== 'string') continue;
                const eq = item.indexOf('=');
                if (eq < 0) continue;
                const k = item.slice(0, eq).trim();
                const v = item.slice(eq + 1).trim();
                if (k && !map.has(k)) map.set(k, v);
            }
        } else if (env && typeof env === 'object') {
            for (const [k, v] of Object.entries(env)) {
                if (typeof v === 'string' && !map.has(k)) map.set(k, v);
            }
        }
        if (map.size > 0 || envFiles.length > 0) out.push({ serviceName, env: map, envFiles });
    }
    return out;
}

/**
 * Read and parse the env files referenced by a service's `env_file:`, resolved
 * relative to the compose project dir (the repo root). Missing/unreadable files
 * are skipped, never thrown. `cache` dedups reads across services that share a
 * file (e.g. an app + its workers all pointing at one local.env). Returned in
 * declared order; callers apply docker-compose precedence (later file wins).
 */
function readEnvFilesForService(
    repoPath: string,
    relPaths: readonly string[],
    cache: Map<string, Map<string, string>>,
): Array<{ rel: string; vars: Map<string, string> }> {
    const out: Array<{ rel: string; vars: Map<string, string> }> = [];
    for (const declared of relPaths) {
        const abs = path.resolve(repoPath, declared);
        let vars = cache.get(abs);
        if (!vars) {
            try {
                vars = fs.existsSync(abs) ? parseEnvFile(fs.readFileSync(abs, 'utf8')) : new Map<string, string>();
            } catch (e) {
                logger.debug(`[env-var-resolver] could not read env_file ${declared}: ${(e as Error).message}`);
                vars = new Map<string, string>();
            }
            cache.set(abs, vars);
        }
        out.push({ rel: path.relative(repoPath, abs), vars });
    }
    return out;
}

/**
 * Extract `name: ..., value: ...` env entries from Helm/k8s values-style YAML.
 * Recognizes the common shape used by Helm charts:
 *   envs:
 *     plain:
 *       - name: DATABASE_NAME
 *         value: 'orders_main'
 * and the Kubernetes container `env:` array.
 *
 * Skips entries that resolve via `valueFrom:` (secrets, configmap refs).
 */
const ENV_VAR_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const ENV_BLOCK_KEYS = new Set([
    'customenvs', 'envs', 'env', 'environment', 'plain', 'envvars',
    'envvariables', 'environmentvariables', 'app',
]);

function looksLikeEnvBlock(node: any): boolean {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const keys = Object.keys(node);
    if (keys.length === 0) return false;
    let envLike = 0;
    for (const k of keys) if (ENV_VAR_KEY_RE.test(k)) envLike++;
    return envLike >= Math.max(2, Math.ceil(keys.length * 0.6));
}

function readHelmValuesEnv(content: string): Map<string, string> {
    const out = new Map<string, string>();
    let doc: any;
    try { doc = yaml.load(content); } catch { return out; }
    if (!doc) return out;

    const recordIfPlainEnvVar = (k: string, v: any) => {
        if (typeof v !== 'string' || !v.length) return;
        if (/\{\{[^}]+\}\}/.test(v)) return;            // skip Helm templates
        if (!ENV_VAR_KEY_RE.test(k)) return;
        if (!out.has(k)) out.set(k, v);
    };

    const visit = (node: any, parentKey: string | null) => {
        if (node == null) return;

        // Form 1: name/value array (Kubernetes container env)
        if (Array.isArray(node)) {
            for (const item of node) {
                if (item && typeof item === 'object'
                    && typeof item.name === 'string'
                    && typeof item.value === 'string'
                    && item.value.length
                    && !/\{\{[^}]+\}\}/.test(item.value)) {
                    if (!out.has(item.name)) out.set(item.name, item.value);
                }
                visit(item, parentKey);
            }
            return;
        }

        if (typeof node !== 'object') return;

        // Form 2: direct mapping under env-block key (customEnvs, envs.plain, env, environment).
        const lc = (parentKey ?? '').toLowerCase();
        if (ENV_BLOCK_KEYS.has(lc) || looksLikeEnvBlock(node)) {
            for (const [k, v] of Object.entries(node)) recordIfPlainEnvVar(k, v);
        }

        for (const [k, v] of Object.entries(node)) visit(v, k);
    };
    visit(doc, null);
    return out;
}

export interface BuildRepoEnvMapOptions {
    /**
     * Absolute path of a specific service workspace within the repo. When
     * provided, `.env*` files under this dir are read FIRST (higher priority
     * than repo-root files), so a service-local `.env` wins over a generic
     * repo-root `.env` for the same key.
     */
    serviceRoot?: string;
    /**
     * Optional whitelist of env-var names referenced by the service's code
     * (typically produced by `scanCodeReferencedEnvVars(serviceRoot)`).
     * When provided, env-vars that arrive from REPO-ROOT files but are NOT
     * in this set are dropped. Vars from service-local `.env*` files are
     * trusted unconditionally — they belong to the service by definition.
     */
    codeReferencedFilter?: ReadonlySet<string>;
    /**
     * Literal default values harvested from declared env-accessor call sites
     * (coderadius.yaml `envAccessors`, e.g. `EnvVault::fetch('KEY', 'default')`).
     * Appended LAST (every file-based source wins) at confidence 'low'.
     * They bypass the codeReferencedFilter: a default harvested from a call
     * site is code-referenced by construction.
     */
    accessorDefaults?: ReadonlyArray<{ key: string; value: string }>;
    /**
     * Per-service compose scoping: keep ONLY the env block of the FIRST
     * listed name that matches a compose service key (exact lowercase
     * match, never fuzzy — callers pass [Service.name, dir-basename]). No
     * match → ZERO compose vars: an infra-only sidecar must not inherit the
     * app's broker env from the repo-global merge. `sourceFile` is stamped
     * `<composefile>#<service>`. Without this option the merged
     * first-writer-wins reader is byte-identical to the legacy behavior.
     */
    composeServiceNames?: ReadonlyArray<string>;
    /**
     * When false, skip the repo-global default sources — helm values and
     * accessor-harvested defaults. Used by the per-service resolver for
     * services WITHOUT code: helm env and accessor call-site defaults
     * describe the app processes, not infra-only compose services. Default
     * true (byte-identical without opts).
     */
    includeRepoGlobalDefaults?: boolean;
}

export function buildRepoEnvMap(repoPath: string, opts?: BuildRepoEnvMapOptions): RepoEnvMap {
    const vars = new Map<string, EnvVarEntry>();
    const filter = opts?.codeReferencedFilter;
    const serviceRoot = opts?.serviceRoot;
    const filterEnabled = !!filter && filter.size > 0;

    // First-writer-wins across these calls. Service-local files run BEFORE
    // repo-root scan so they capture priority. The bypassFilter flag tells
    // us this source is trusted (service-local) and ignores the whitelist.
    const setIfAbsent = (
        k: string,
        value: string,
        sourceFile: string,
        confidence: 'high' | 'medium' | 'low',
        opts?: { bypassFilter?: boolean },
    ) => {
        if (vars.has(k)) return;
        if (filterEnabled && !opts?.bypassFilter && !filter!.has(k)) return;
        vars.set(k, { value, sourceFile, confidence });
    };

    // ── Service-local .env* (priority over repo-root) ────────────────────
    if (serviceRoot) {
        for (const target of ENV_FILE_PRIORITY) {
            const abs = path.join(serviceRoot, target.rel);
            if (!fs.existsSync(abs)) continue;
            try {
                const txt = fs.readFileSync(abs, 'utf8');
                const rel = path.relative(repoPath, abs);
                for (const [k, v] of parseEnvFile(txt)) {
                    setIfAbsent(k, v, rel, target.confidence, { bypassFilter: true });
                }
            } catch (e) {
                logger.debug(`[env-var-resolver] could not read ${path.relative(repoPath, abs)}: ${(e as Error).message}`);
            }
        }
    }

    // ── Repo-root .env* (filtered when codeReferencedFilter is set) ──────
    for (const target of ENV_FILE_PRIORITY) {
        const abs = path.join(repoPath, target.rel);
        if (!fs.existsSync(abs)) continue;
        try {
            const txt = fs.readFileSync(abs, 'utf8');
            for (const [k, v] of parseEnvFile(txt)) setIfAbsent(k, v, target.rel, target.confidence);
        } catch (e) {
            logger.debug(`[env-var-resolver] could not read ${target.rel}: ${(e as Error).message}`);
        }
    }

    // docker-compose env blocks (literal values only — references like ${X} stay as-is)
    // `docker-compose.override.yml` is included: local-dev workflows commonly put
    // real per-environment URLs there (it shadows docker-compose.yml at runtime),
    // so omitting it leaves customer env-vars invisible to the resolver.
    const composeServiceNames = opts?.composeServiceNames?.map(n => n.toLowerCase());
    const envFileCache = new Map<string, Map<string, string>>();
    // docker-compose precedence: inline `environment:` overrides `env_file:`,
    // and a later env_file overrides an earlier one. setIfAbsent is
    // first-writer-wins, so inline is applied first and env_file lists are
    // applied last-declared-first.
    const applyEnvFiles = (envFiles: readonly string[]) => {
        const efs = readEnvFilesForService(repoPath, envFiles, envFileCache);
        for (let i = efs.length - 1; i >= 0; i--) {
            for (const [k, v] of efs[i].vars) setIfAbsent(k, v, efs[i].rel, 'high');
        }
    };
    for (const compose of [
        'docker-compose.yml',
        'docker-compose.yaml',
        'docker-compose.override.yml',
        'docker-compose.override.yaml',
        'docker-compose.prod.yml',
        'docker-compose.production.yml',
    ]) {
        const abs = path.join(repoPath, compose);
        if (!fs.existsSync(abs)) continue;
        try {
            const txt = fs.readFileSync(abs, 'utf8');
            const blocks = readDockerComposeEnvByService(txt);
            if (composeServiceNames) {
                // Per-service scope: the FIRST listed candidate matching a
                // compose service key wins; no match → no compose vars.
                const match = composeServiceNames
                    .map(name => blocks.find(b => b.serviceName.toLowerCase() === name))
                    .find(b => b !== undefined);
                if (match) {
                    for (const [k, v] of match.env) setIfAbsent(k, v, `${compose}#${match.serviceName}`, 'high');
                    applyEnvFiles(match.envFiles);
                }
            } else {
                // Repo-global merge, first-writer-wins. Inline blocks for every
                // service first (legacy precedence preserved), then env_file.
                for (const b of blocks) for (const [k, v] of b.env) setIfAbsent(k, v, compose, 'high');
                for (const b of blocks) applyEnvFiles(b.envFiles);
            }
        } catch (e) {
            logger.debug(`[env-var-resolver] could not read ${compose}: ${(e as Error).message}`);
        }
    }

    const includeRepoGlobalDefaults = opts?.includeRepoGlobalDefaults ?? true;

    // Helm/k8s values: production env vars (high authority for cross-repo welding).
    // Walks .helm/, .charts/, helm/, and chart/ directories shallowly.
    // Repo-global default source — skipped for codeless services (see opts).
    const helmRoots = includeRepoGlobalDefaults ? ['.helm', '.charts', 'helm', 'chart', 'charts'] : [];
    for (const root of helmRoots) {
        const rootAbs = path.join(repoPath, root);
        if (!fs.existsSync(rootAbs)) continue;
        const files = walkValuesYaml(rootAbs, 4);
        for (const abs of files) {
            try {
                const txt = fs.readFileSync(abs, 'utf8');
                const rel = path.relative(repoPath, abs);
                const conf: 'high' | 'medium' = /production|prod\b/.test(rel) ? 'high' : 'medium';
                for (const [k, v] of readHelmValuesEnv(txt)) setIfAbsent(k, v, rel, conf);
            } catch (e) {
                logger.debug(`[env-var-resolver] could not read helm values: ${(e as Error).message}`);
            }
        }
    }

    // Accessor-harvested defaults: weakest source, appended last so every
    // file-based source wins. Code-referenced by construction → bypass filter.
    // Repo-global default source — skipped for codeless services (see opts).
    if (includeRepoGlobalDefaults) {
        for (const d of opts?.accessorDefaults ?? []) {
            setIfAbsent(d.key, d.value, '<accessor-default>', 'low', { bypassFilter: true });
        }
    }

    return { vars };
}

function walkValuesYaml(dir: string, maxDepth: number): string[] {
    const out: string[] = [];
    const stack: Array<{ d: string; depth: number }> = [{ d: dir, depth: 0 }];
    while (stack.length) {
        const { d, depth } = stack.pop()!;
        if (depth > maxDepth) continue;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const abs = path.join(d, e.name);
            if (e.isDirectory()) { stack.push({ d: abs, depth: depth + 1 }); continue; }
            if (!e.isFile()) continue;
            if (/^values(?:[.-].+)?\.ya?ml$/.test(e.name)) out.push(abs);
        }
    }
    // Priority: production > staging > others > base values.yaml
    // setIfAbsent in the caller means "first reader wins" — give env-suffixed
    // files first crack at literal values.
    out.sort((a, b) => prioritizeValuesFile(b) - prioritizeValuesFile(a));
    return out;
}

function prioritizeValuesFile(p: string): number {
    const base = path.basename(p).toLowerCase();
    if (/values-?prod(?:uction)?/.test(base)) return 100;
    if (/values-?staging/.test(base)) return 80;
    if (/values-?(?:dev|qa|test|canary)/.test(base)) return 60;
    if (base === 'values.yaml' || base === 'values.yml') return 10;
    return 50;
}

const SENTINEL_VALUES = new Set([
    '<host>', 'your-host', 'xxx', 'changeme', 'replaceme',
    '<dbname>', 'your-database', 'your-db',
]);

export interface ResolveResult {
    value: string;
    resolved: boolean;
    trail: string[];
    confidenceFloor: 'high' | 'medium' | 'low';
}

const CONFIDENCE_RANK: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 };

function takeMin(a: 'high' | 'medium' | 'low', b: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' {
    return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

interface ResolveCtx {
    env: RepoEnvMap;
    seen: Set<string>;
    trail: string[];
    confidenceFloor: 'high' | 'medium' | 'low';
    maxDepth: number;
    depth: number;
    resolved: boolean;
}

function lookupVar(ctx: ResolveCtx, name: string): string | undefined {
    const entry = ctx.env.vars.get(name);
    if (!entry) return undefined;
    ctx.trail.push(name);
    ctx.confidenceFloor = takeMin(ctx.confidenceFloor, entry.confidence);
    return entry.value;
}

function resolveSymfony(value: string, ctx: ResolveCtx): string {
    // %env(VAR)%, %env(resolve:VAR)%, %env(default:fallback:VAR)%, %env(string:VAR)%, %env(int:VAR)%
    const SYMFONY_RE = /%env\(([^)]+)\)%/g;
    return value.replace(SYMFONY_RE, (full, body: string) => {
        const parts = body.split(':').map(p => p.trim());
        const varName = parts[parts.length - 1];
        const modifiers = parts.slice(0, -1);
        const looked = lookupVar(ctx, varName);
        if (looked === undefined) {
            // default:fallback:VAR — use fallback when defined
            const dIdx = modifiers.indexOf('default');
            if (dIdx >= 0 && modifiers[dIdx + 1] !== undefined) {
                ctx.resolved = true;
                return modifiers[dIdx + 1];
            }
            ctx.resolved = false;
            return full;
        }
        // recursive resolution if 'resolve' modifier present
        if (modifiers.includes('resolve')) {
            if (ctx.depth >= ctx.maxDepth) {
                logger.warn(`[env-var-resolver] symfony resolve max depth exceeded at ${varName}`);
                ctx.resolved = false;
                return full;
            }
            if (ctx.seen.has(varName)) {
                logger.warn(`[env-var-resolver] symfony resolve cycle at ${varName}`);
                ctx.resolved = false;
                return full;
            }
            ctx.seen.add(varName);
            ctx.depth++;
            const sub = resolveTemplatesInternal(looked, 'symfony-env', ctx);
            ctx.depth--;
            return sub;
        }
        return looked;
    });
}

function resolveJs(value: string, ctx: ResolveCtx): string {
    // process.env.VAR, process.env['VAR'], process.env["VAR"]
    const RE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
    return value.replace(RE, (full, dot: string | undefined, brk: string | undefined) => {
        const name = dot ?? brk ?? '';
        if (!name) { ctx.resolved = false; return full; }
        const looked = lookupVar(ctx, name);
        if (looked === undefined) { ctx.resolved = false; return full; }
        return looked;
    });
}

function resolveShell(value: string, ctx: ResolveCtx): string {
    // ${VAR}, ${VAR:-default}, ${VAR:?error}, $VAR
    const BRACE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*)|:\?[^}]*)?\}/g;
    let out = value.replace(BRACE, (full, name: string, fallback: string | undefined) => {
        const looked = lookupVar(ctx, name);
        if (looked !== undefined) return looked;
        if (fallback !== undefined) { ctx.resolved = true; return fallback; }
        ctx.resolved = false;
        return full;
    });
    // bare $VAR — only when isolated (word boundary)
    const BARE = /\$([A-Za-z_][A-Za-z0-9_]*)\b/g;
    out = out.replace(BARE, (full, name: string) => {
        const looked = lookupVar(ctx, name);
        if (looked === undefined) { ctx.resolved = false; return full; }
        return looked;
    });
    return out;
}

function resolveSpring(value: string, ctx: ResolveCtx): string {
    // ${VAR:default}, ${spring.X.Y}
    const RE = /\$\{([^:}]+)(?::([^}]*))?\}/g;
    return value.replace(RE, (full, name: string, fallback: string | undefined) => {
        const looked = lookupVar(ctx, name);
        if (looked !== undefined) return looked;
        if (fallback !== undefined) { ctx.resolved = true; return fallback; }
        ctx.resolved = false;
        return full;
    });
}

function resolveHelm(value: string, ctx: ResolveCtx): string {
    // {{ .Values.x.y }} — Phase 1: never resolvable from .env alone.
    if (/\{\{[^}]+\}\}/.test(value)) {
        ctx.resolved = false;
    }
    return value;
}

function resolveTemplatesInternal(value: string, syntax: TemplateSyntax, ctx: ResolveCtx): string {
    if (!value) return value;
    let v = value;
    switch (syntax) {
        case 'symfony-env':     v = resolveSymfony(v, ctx); break;
        case 'js-template':     v = resolveJs(v, ctx); break;
        case 'shell':           v = resolveShell(v, ctx); break;
        case 'spring-property': v = resolveSpring(v, ctx); break;
        case 'helm':            v = resolveHelm(v, ctx); break;
        case 'none': /* literal */ break;
    }
    // Sentinel-value guard: even if substitution succeeded, sentinels mean unusable.
    if (SENTINEL_VALUES.has(v.trim().toLowerCase())) ctx.resolved = false;
    return v;
}

export function resolveTemplates(
    raw: string,
    syntax: TemplateSyntax,
    env: RepoEnvMap,
    opts?: { maxDepth?: number },
): ResolveResult {
    if (raw === undefined || raw === null) return { value: '', resolved: false, trail: [], confidenceFloor: 'high' };
    const ctx: ResolveCtx = {
        env,
        seen: new Set<string>(),
        trail: [],
        confidenceFloor: 'high',
        maxDepth: opts?.maxDepth ?? 5,
        depth: 0,
        resolved: true,
    };
    if (typeof raw !== 'string' || raw === '') {
        return { value: String(raw ?? ''), resolved: false, trail: [], confidenceFloor: 'high' };
    }
    const value = resolveTemplatesInternal(raw, syntax, ctx);
    // If after substitution any unresolved template marker remains, mark unresolved.
    if (/\$\{|process\.env|%env\(|\{\{/.test(value)) ctx.resolved = false;
    return { value, resolved: ctx.resolved, trail: ctx.trail, confidenceFloor: ctx.confidenceFloor };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP endpoint synthesis
//
// Walk an already-resolved env map for variables whose name encodes "this is
// a base URL for some external HTTP service" and whose value is a real
// http(s):// URL (or a bare host). Each match is normalised into an
// `HttpEndpointHint` consumed downstream by the dependency resolver, which
// either welds it to an existing :Service or materialises an
// :APIInterface(apiSource='env-var') + :APIDeployment.
//
// Language-agnostic: operates on env-var map only. No AST, no plugin
// dispatch — pure orchestrator concern (CLAUDE.md §1, §3).
// ─────────────────────────────────────────────────────────────────────────────

const HTTP_URL_KEY_SUFFIX_RE = /^([A-Z][A-Z0-9_]*?)_(URL|HOST|ENDPOINT|API|BASE_URL)$/;
const BARE_HOST_VALUE_RE = /^[a-z][a-z0-9.-]*(?::[0-9]{1,5})?$/i;
const PORT_ONLY_VALUE_RE = /^[0-9]{1,5}$/;

// Env-var name prefixes that mark a *datastore* or *message broker* connection
// rather than an HTTP service. These are already covered by
// `synthesizeFromEnvTrios` (or per-tech DSN logic) and must NOT be re-emitted
// as HTTP endpoints — otherwise rabbitmq/memcached/mysql hosts pollute the
// :APIInterface(env-var) bucket with infrastructure that belongs in the
// :Datastore / :MessageBroker family.
const TECH_PREFIX_BLACKLIST = [
    'MYSQL_', 'MARIADB_',
    'POSTGRES_', 'POSTGRESQL_', 'PG_', 'PGSQL_',
    'MONGO_', 'MONGODB_',
    'REDIS_', 'VALKEY_',
    'RABBITMQ_', 'AMQP_',
    'KAFKA_',
    'MEMCACHED_', 'MEMCACHE_',
    'INFLUXDB_', 'INFLUX_',
    'CASSANDRA_', 'SCYLLA_',
    'DB_', 'DATABASE_',
    'ELASTICSEARCH_', 'OPENSEARCH_',
    'NATS_', 'PULSAR_',
];

function isTechPrefixedKey(key: string): boolean {
    return TECH_PREFIX_BLACKLIST.some(prefix => key.startsWith(prefix));
}

/**
 * Hosts considered "not a real external API" — compose service names, plain
 * loopback aliases, or anything that lacks a public-FQDN dot. These are kept
 * out of the env-var API bucket because they routinely refer to in-network
 * datastores / sidecars (`mysql`, `redis`, `pricing-engine`, `app`).
 */
function isPubliclyAddressableHost(host: string): boolean {
    if (!host) return false;
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === 'host.docker.internal') return false;
    if (/^127\.\d+\.\d+\.\d+$/.test(host)) return false;
    // Compose service names / single-label hostnames have no dots. Customer
    // partner endpoints always carry a TLD (acme.example.com, foo.k8s.cluster).
    if (!host.includes('.')) return false;
    return true;
}

function parseHttpValue(raw: string): { baseUrl: string; host: string; port: number | undefined; isInferredScheme: boolean } | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (PORT_ONLY_VALUE_RE.test(trimmed)) return null;

    // Form 1: fully-formed http(s) URL.
    const schemeMatch = /^(https?):\/\/(.+)$/i.exec(trimmed);
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        let rest = schemeMatch[2];
        // Strip credentials (`user:pass@host`).
        const atIdx = rest.indexOf('@');
        if (atIdx >= 0) rest = rest.slice(atIdx + 1);
        // Split host[:port] / path.
        let hostAndPort = rest;
        let tail = '';
        const slashIdx = rest.indexOf('/');
        const qIdx = rest.indexOf('?');
        const hashIdx = rest.indexOf('#');
        const cutCandidates = [slashIdx, qIdx, hashIdx].filter(i => i >= 0);
        if (cutCandidates.length > 0) {
            const cut = Math.min(...cutCandidates);
            hostAndPort = rest.slice(0, cut);
            tail = rest.slice(cut);
        }
        let host = hostAndPort;
        let port: number | undefined;
        const portMatch = /^(.+?):([0-9]{1,5})$/.exec(hostAndPort);
        if (portMatch) {
            host = portMatch[1];
            port = parseInt(portMatch[2], 10);
        }
        host = host.toLowerCase();
        if (!host) return null;
        const baseUrl = `${scheme}://${hostAndPort.toLowerCase()}${tail}`;
        return { baseUrl, host, port, isInferredScheme: false };
    }

    // Form 2: bare host (`payment.acme.example.com[:port]`).
    if (BARE_HOST_VALUE_RE.test(trimmed)) {
        let host = trimmed;
        let port: number | undefined;
        const portMatch = /^(.+?):([0-9]{1,5})$/.exec(trimmed);
        if (portMatch) {
            host = portMatch[1];
            port = parseInt(portMatch[2], 10);
        }
        host = host.toLowerCase();
        return { baseUrl: `https://${host}`, host, port, isInferredScheme: true };
    }

    return null;
}

function deriveAliasFromKey(key: string): string {
    const m = HTTP_URL_KEY_SUFFIX_RE.exec(key);
    if (!m) return key.toLowerCase();
    return m[1].toLowerCase().replace(/_/g, '-');
}

const CONFIDENCE_PRIORITY_BY_SUFFIX: Record<string, number> = {
    URL: 5,
    BASE_URL: 5,
    ENDPOINT: 4,
    API: 3,
    HOST: 2,
};

function suffixPriority(key: string): number {
    const m = HTTP_URL_KEY_SUFFIX_RE.exec(key);
    return m ? (CONFIDENCE_PRIORITY_BY_SUFFIX[m[2]] ?? 1) : 0;
}

/**
 * Synthesize `HttpEndpointHint`s from env-var entries that look like base URLs.
 *
 * Selection rule: variable name matches `^[A-Z][A-Z0-9_]*?_(URL|HOST|ENDPOINT|API|BASE_URL)$`
 * AND value parses as an http(s)// URL or a bare hostname (per RFC-ish regex).
 *
 * Dedup: keyed by `(host, alias)`. When multiple env-vars map to the same key
 * (e.g. `ORDERS_URL` and `ORDERS_HOST`), the variant with the strongest suffix
 * priority wins (full URL > endpoint > api > host), so the survivor carries
 * the most informative source.
 */
export function synthesizeHttpEndpoints(env: RepoEnvMap): HttpEndpointHint[] {
    const byKey = new Map<string, HttpEndpointHint>();

    for (const [key, entry] of env.vars.entries()) {
        if (!HTTP_URL_KEY_SUFFIX_RE.test(key)) continue;
        if (isTechPrefixedKey(key)) continue;
        const parsed = parseHttpValue(entry.value);
        if (!parsed) continue;
        if (!isPubliclyAddressableHost(parsed.host)) continue;
        const alias = deriveAliasFromKey(key);
        const hint: HttpEndpointHint = {
            technology: 'http',
            baseUrl: parsed.baseUrl,
            host: parsed.host,
            port: parsed.port,
            alias,
            isTemplate: false,
            isInferredScheme: parsed.isInferredScheme || undefined,
            sourceFile: entry.sourceFile,
            sourceEnvKey: key,
            confidence: entry.confidence,
        };
        const dedupKey = `${parsed.host}|${alias}`;
        const existing = byKey.get(dedupKey);
        if (!existing || suffixPriority(key) > suffixPriority(existing.sourceEnvKey)) {
            byKey.set(dedupKey, hint);
        }
    }

    return [...byKey.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker CANDIDATE discovery from env vars (three lanes, priority s1 > s3 > s0)
//
// No lane mints a `:MessageBroker` directly anymore: every recognizer emits a
// `BrokerCandidateHint` and brokers are born only in `bindBrokerCandidates()`
// (anchor on an existing broker, scheme self-anchor, cross-repo convergence).
// Hints never carry credentials.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-provider config: env-var key patterns + extraction strategy.
 * Order matters when a generic key (`REDIS_HOST`) is co-disambiguated by
 * companion keys (`REDIS_STREAM_*` → broker, otherwise → cache only).
 */
interface BrokerProviderConfig {
    provider: MessageBrokerHintProvider;
    /** Env-var key that triggers detection. The hint's `sourceEnvKey`. */
    triggerKey: RegExp;
    /** Companion keys whose presence is REQUIRED for ambiguous providers. */
    companionKeys?: RegExp[];
    /** Default port if not derivable from the value. */
    defaultPort?: number;
    /**
     * Optional URL scheme that the value must start with (e.g. `nats://`).
     * When set, the URL is parsed for host/port/vhost; when unset, the value
     * is a bare host (optionally `host:port`).
     */
    urlScheme?: string;
    /** Optional sibling key for port (e.g. `RABBITMQ_PORT`). */
    portKey?: RegExp;
    /** Optional sibling key for vhost (e.g. `RABBITMQ_VHOST`). */
    vhostKey?: RegExp;
}

const BROKER_PROVIDER_CONFIGS: BrokerProviderConfig[] = [
    {
        provider: 'rabbitmq',
        triggerKey: /^RABBITMQ_HOST$/,
        defaultPort: 5672,
        portKey: /^RABBITMQ_PORT$/,
        vhostKey: /^RABBITMQ_VHOST$/,
    },
    {
        provider: 'kafka',
        triggerKey: /^KAFKA_BOOTSTRAP_SERVERS$/,
        defaultPort: 9092,
    },
    {
        provider: 'nats',
        triggerKey: /^NATS_URL$/,
        urlScheme: 'nats',
        defaultPort: 4222,
    },
    {
        provider: 'pulsar',
        triggerKey: /^PULSAR_URL$/,
        urlScheme: 'pulsar',
        defaultPort: 6650,
    },
    {
        provider: 'redis-streams',
        // Redis is dual-purpose (cache or streams). Only treat as broker when
        // a companion stream-specific key is present.
        triggerKey: /^REDIS_HOST$/,
        companionKeys: [/^REDIS_STREAM(_|$)/, /^REDIS_STREAMS_/, /^REDIS_GROUP(_|$)/, /^REDIS_CONSUMER_GROUP/],
        defaultPort: 6379,
        portKey: /^REDIS_PORT$/,
    },
];

/**
 * s3 lane — legacy key-name trigger table, DECLARED as a convention-guess:
 * these env-var NAMES are customer free choices (`RBMQ_H` is just as legal),
 * so a match may only ever yield a `needsReview` candidate whose provider is
 * `providerSource='key-name'`. Binding cleanliness is decided downstream.
 */
const BROKER_KEY_NAME_HEURISTIC = defineHeuristic({
    id: 'broker-key-name',
    class: 'convention-guess',
    emits: 'BrokerCandidate (provider from env-var key name)',
    surfacedBy: 'brokerGuessOnlyBindings funnel row + MessageBroker.needsReview',
    value: BROKER_PROVIDER_CONFIGS,
});

function findVar(env: RepoEnvMap, pattern: RegExp): { key: string; entry: EnvVarEntry } | undefined {
    for (const [key, entry] of env.vars.entries()) {
        if (pattern.test(key)) return { key, entry };
    }
    return undefined;
}

function findAnyVar(env: RepoEnvMap, patterns: RegExp[]): boolean {
    for (const key of env.vars.keys()) {
        if (patterns.some(p => p.test(key))) return true;
    }
    return false;
}

interface ParsedBrokerValue {
    host: string;
    port?: number;
    vhost?: string;
}

/**
 * Parse a broker value: `scheme://[user:pass@]host[:port][/vhost]` when a
 * scheme is given, bare `host[:port]` otherwise. Shared value-shape utility
 * (also consumed by the php-config-array messenger DSN path). Credentials
 * are stripped, never surfaced.
 */
export function parseHostPortVhost(value: string, scheme: string | undefined): ParsedBrokerValue | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (scheme) {
        const m = new RegExp(`^${scheme}://(.+)$`, 'i').exec(trimmed);
        if (!m) return null;
        let rest = m[1];
        const atIdx = rest.indexOf('@');
        if (atIdx >= 0) rest = rest.slice(atIdx + 1); // strip credentials
        let pathPart = '';
        const slashIdx = rest.indexOf('/');
        if (slashIdx >= 0) {
            pathPart = rest.slice(slashIdx + 1);
            rest = rest.slice(0, slashIdx);
        }
        let host = rest;
        let port: number | undefined;
        const pm = /^(.+?):([0-9]{1,5})$/.exec(rest);
        if (pm) { host = pm[1]; port = parseInt(pm[2], 10); }
        return { host: host.toLowerCase(), port, vhost: pathPart || undefined };
    }
    // Bare host[:port], no credentials expected
    const atIdx = trimmed.indexOf('@');
    const usable = atIdx >= 0 ? trimmed.slice(atIdx + 1) : trimmed;
    const pm = /^(.+?):([0-9]{1,5})$/.exec(usable);
    if (pm) return { host: pm[1].toLowerCase(), port: parseInt(pm[2], 10) };
    return { host: usable.toLowerCase() };
}

/**
 * s1 lane — broker URI schemes (CONTRACT: the scheme self-declares the
 * provider, no key name involved). `amqps` carries its own TLS default port.
 */
const BROKER_SCHEMES: Array<{ scheme: string; provider: MessageBrokerHintProvider; defaultPort: number; hasVhost: boolean }> = [
    { scheme: 'amqps', provider: 'rabbitmq', defaultPort: 5671, hasVhost: true },
    { scheme: 'amqp', provider: 'rabbitmq', defaultPort: 5672, hasVhost: true },
    { scheme: 'kafka', provider: 'kafka', defaultPort: 9092, hasVhost: false },
    { scheme: 'nats', provider: 'nats', defaultPort: 4222, hasVhost: false },
    { scheme: 'pulsar', provider: 'pulsar', defaultPort: 6650, hasVhost: false },
];

/**
 * Published default port for a broker provider (single source: the s1 scheme
 * contract table). Multiple schemes may map to one provider (amqp/amqps):
 * the PLAIN scheme (shortest name) carries the canonical default, the TLS
 * variant is the marked case. Consumed by the registry's broker-connection
 * resolution.
 */
export function brokerProviderDefaultPort(provider: MessageBrokerHintProvider): number | undefined {
    return BROKER_SCHEMES
        .filter(s => s.provider === provider)
        .sort((a, b) => a.scheme.length - b.scheme.length)[0]?.defaultPort;
}

/** Unresolved template / sentinel values must never become candidates. */
const CANDIDATE_VALUE_TEMPLATE_RE = /\$\{|%env\(|process\.env|\{\{|^<.*>$/;

/**
 * s0 shape gate — the VALUE itself must carry host evidence: a multi-label
 * hostname (optionally trailing-dot FQDN) or any hostname with an explicit
 * `:port`. A bare single-label word ('rabbitmq', 'production') has NO shape
 * evidence and never candidates, regardless of the key name.
 */
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const HOST_SHAPE_RE = new RegExp(`^(${HOST_LABEL})((?:\\.${HOST_LABEL})*)\\.?(?::([0-9]{1,5}))?$`, 'i');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * Dotted FILENAMES satisfy the host grammar (`account-key.json`) but their
 * last label is a file extension, which is never a TLD. Published file-format
 * vocabulary, value-shape check — no key names involved.
 */
const FILE_EXTENSION_LABELS = new Set([
    'json', 'yaml', 'yml', 'xml', 'txt', 'csv', 'ini', 'conf', 'toml',
    'pem', 'crt', 'cer', 'key', 'p12', 'pfx', 'jks',
    'log', 'sql', 'gz', 'zip', 'tar', 'bak',
    'php', 'js', 'ts', 'py', 'sh', 'rb',
]);

function parseHostShapedValue(value: string): { host: string; port?: number } | null {
    const trimmed = value.trim();
    if (!trimmed || CANDIDATE_VALUE_TEMPLATE_RE.test(trimmed)) return null;
    if (trimmed.includes('://')) return null; // any scheme belongs to s1 (or to HTTP/datastore lanes)
    const m = HOST_SHAPE_RE.exec(trimmed);
    if (!m) return null;
    const hasMoreLabels = (m[2] ?? '').length > 0;
    const port = m[3] ? parseInt(m[3], 10) : undefined;
    if (!hasMoreLabels && port === undefined) return null; // single label, no port: no evidence
    const host = trimmed.replace(/:(\d{1,5})$/, '');
    const labels = host.toLowerCase().replace(/\.$/, '').split('.');
    if (FILE_EXTENSION_LABELS.has(labels[labels.length - 1])) return null; // filename, not a host
    if (LOOPBACK_HOSTS.has(host.toLowerCase().replace(/\.$/, ''))) return null;
    return { host, port };
}

/**
 * s0 EMISSION filter (never a binding signal): env keys whose suffix names a
 * CHANNEL per published AMQP/streaming vocabulary carry queue/exchange/topic
 * NAMES as values — dotted routing keys satisfy the host grammar and would
 * otherwise leak into the host-shape lane.
 */
const CHANNEL_NAME_KEY_SUFFIX_RE = /_(EXCHANGE|QUEUE|TOPIC|ROUTING_KEY|BINDING|STREAM|SUBSCRIPTION|CHANNEL)(_NAME)?$/;

function schemeCandidateOf(key: string, entry: EnvVarEntry): BrokerCandidateHint | null {
    const value = entry.value.trim();
    if (CANDIDATE_VALUE_TEMPLATE_RE.test(value)) return null;
    const schemeIdx = value.indexOf('://');
    if (schemeIdx <= 0) return null;
    const cfg = BROKER_SCHEMES.find(s => s.scheme === value.slice(0, schemeIdx).toLowerCase());
    if (!cfg) return null;
    const parsed = parseHostPortVhost(value, cfg.scheme);
    if (!parsed || !parsed.host) return null;
    const vhost = cfg.hasVhost ? decodeURIComponent(parsed.vhost ?? '') || '/' : undefined;
    return {
        source: 's1-scheme',
        provider: cfg.provider,
        providerSource: 'scheme',
        host: parsed.host,
        port: parsed.port ?? cfg.defaultPort,
        vhost,
        sourceEnvKey: key,
        sourceFile: entry.sourceFile,
        confidence: entry.confidence,
    };
}

function keyNameCandidates(env: RepoEnvMap, claimed: Set<string>): BrokerCandidateHint[] {
    const out: BrokerCandidateHint[] = [];
    // Sibling/companion keys belong to the matched broker's CONFIG CLUSTER
    // (ports, vhosts, stream/queue names): claim them so their values (often
    // dotted routing keys) never leak into the s0 host-shape lane.
    const claimMatching = (re?: RegExp) => {
        if (!re) return;
        for (const k of env.vars.keys()) if (re.test(k)) claimed.add(k);
    };
    for (const cfg of BROKER_KEY_NAME_HEURISTIC.value) {
        const trigger = findVar(env, cfg.triggerKey);
        if (!trigger || claimed.has(trigger.key)) continue;
        if (cfg.companionKeys && !findAnyVar(env, cfg.companionKeys)) continue;
        claimMatching(cfg.portKey);
        claimMatching(cfg.vhostKey);
        for (const companion of cfg.companionKeys ?? []) claimMatching(companion);
        if (CANDIDATE_VALUE_TEMPLATE_RE.test(trigger.entry.value)) continue;
        const parsed = parseHostPortVhost(trigger.entry.value, cfg.urlScheme);
        if (!parsed || !parsed.host) continue;

        let port = parsed.port ?? cfg.defaultPort;
        if (!parsed.port && cfg.portKey) {
            const portEntry = findVar(env, cfg.portKey);
            if (portEntry) {
                const n = parseInt(portEntry.entry.value, 10);
                if (Number.isFinite(n) && n > 0) port = n;
            }
        }

        let vhost = parsed.vhost;
        if (!vhost && cfg.vhostKey) {
            const vh = findVar(env, cfg.vhostKey);
            if (vh) vhost = vh.entry.value;
        }

        claimed.add(trigger.key);
        out.push({
            source: 's3-key-name',
            provider: cfg.provider,
            providerSource: 'key-name',
            host: parsed.host,
            port,
            vhost,
            sourceEnvKey: trigger.key,
            sourceFile: trigger.entry.sourceFile,
            confidence: trigger.entry.confidence,
        });
    }
    return out;
}

export interface SynthesizeBrokerCandidatesOptions {
    /**
     * Env-var keys already claimed by the datastore extractors (DSN keys,
     * tech trios). EXPLICIT set handed over by those extractors — never a
     * parallel regex re-implementation of their matching.
     */
    claimedEnvKeys?: ReadonlySet<string>;
}

/**
 * Emit `BrokerCandidateHint[]` from an env map. Three lanes with per-key
 * priority s1 (scheme contract) > s3 (legacy key-name guess) > s0 (host-shaped
 * value under an arbitrary key). Candidates NEVER become brokers here — that
 * is `bindBrokerCandidates()`'s job, where anchors and convergence decide.
 */
export function synthesizeBrokerCandidateHints(
    env: RepoEnvMap,
    opts?: SynthesizeBrokerCandidatesOptions,
): BrokerCandidateHint[] {
    const out: BrokerCandidateHint[] = [];
    const claimed = new Set<string>(opts?.claimedEnvKeys ?? []);

    // s1 — scheme DSN values (contract), any key name.
    for (const [key, entry] of env.vars.entries()) {
        if (claimed.has(key)) continue;
        const hint = schemeCandidateOf(key, entry);
        if (hint) { out.push(hint); claimed.add(key); }
    }

    // s3 — legacy key-name triggers (declared convention-guess).
    out.push(...keyNameCandidates(env, claimed));

    // s0 — host-shaped values under arbitrary keys (provider unknown).
    for (const [key, entry] of env.vars.entries()) {
        if (claimed.has(key)) continue;
        if (CHANNEL_NAME_KEY_SUFFIX_RE.test(key)) continue; // value is a channel NAME, not a host
        const parsed = parseHostShapedValue(entry.value);
        if (!parsed) continue;
        out.push({
            source: 's0-host-shape',
            host: parsed.host,
            port: parsed.port,
            sourceEnvKey: key,
            sourceFile: entry.sourceFile,
            confidence: entry.confidence,
        });
    }

    return out;
}
