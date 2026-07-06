import type { ProgressReporter } from '../core/progress.js';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { logger } from '../../utils/logger.js';
import { getAllManifestFiles, getManifestGlob, getAllIgnorePatterns, getLanguagePlugin } from '../core/languages/registry.js';
import type {
    FrameworkRoleSignals,
    LanguagePlugin,
    RuntimeServiceDependencyMarker,
    RuntimeServiceEntrypoint,
    RuntimeServiceManifestField,
    RuntimeServiceManifestPresence,
    RuntimeServiceSignals,
} from '../core/languages/types.js';
import type { DiscoveredComponent } from '../topology-resolver.js';

/**
 * A discovered service root within a repository.
 */
export interface DiscoveredService {
    /** Service name (basename of the service root directory). */
    name: string;
    /** Absolute path to the service root directory. */
    path: string;
    /** Inferred primary language from the manifest file found. */
    language: string;
    /**
     * Workspace classified as a runtime service (true) or a library (false).
     * The graph-writer routes Function ownership accordingly: true dispatches
     * to `linkServiceContainsFunction`, false dispatches to
     * `linkLibraryContainsFunction`. Without this flag the writer would
     * silently no-op against a non-existent Service node.
     */
    isRuntimeService: boolean;
    /**
     * Framework roles detected at this workspace (see `LanguagePlugin.frameworkRoleSignals`).
     * Examples: `'graphql-server'`. Downstream stages (e.g. the EXPOSES_API
     * gate in the graph writer) consult this set to decide whether the
     * service hosts a given runtime role.
     */
    frameworkRoles?: ReadonlySet<string>;
}

/**
 * Manifest files and their associated language, in priority order.
 * Derived from language plugins, with a Dockerfile fallback.
 */
const MANIFEST_PRIORITY: Array<{ file: string; language: string }> = [
    ...getAllManifestFiles(),
    { file: 'Dockerfile', language: 'unknown' },
];

/**
 * Glob pattern for all supported manifests.
 * Derived from language plugins, with Dockerfile appended.
 */
const MANIFEST_GLOB = (() => {
    const pluginGlob = getManifestGlob();
    // Inject Dockerfile into the glob: '{go.mod,...}' → '{go.mod,...,Dockerfile}'
    return pluginGlob.replace(/}$/, ',Dockerfile}');
})();

/**
 * Directories that are never service roots and should not be traversed.
 * Combines language-specific ignores (from plugins) with universal ignores.
 */
const IGNORE_DIRS = [
    ...new Set([
        ...getAllIgnorePatterns(),
        // Universal ignores (not language-specific)
        '**/.git/**',
        '**/.idea/**',
    ]),
];

/**
 * Auto-Discovery — Pure Discovery
 *
 * Scans repo for manifest files and returns DiscoveredComponent[].
 * Does NOT write to the graph. The topology-resolver handles that.
 *
 * Strategy (path-agnostic, works for any monorepo layout):
 *
 * 1. Use glob to find all manifest indicator files up to depth 4.
 * 2. The directory containing a manifest is treated as the service root.
 * 3. Deduplicate: if both a parent dir AND a child dir have manifests,
 *    keep the child (more specific).
 * 4. Skip paths already claimed by a catalog source (Backstage/Cortex).
 */
export async function discoverAutoComponents(
    repos: Array<{ name: string; path: string; org?: string }>,
    claimedPaths: string[],
    task?: ProgressReporter,
): Promise<{ components: DiscoveredComponent[]; serviceRoots: DiscoveredService[] }> {
    const components: DiscoveredComponent[] = [];
    const serviceRoots: DiscoveredService[] = [];

    // Normalize claimed paths for comparison
    const claimedSet = new Set(claimedPaths.map(p => p.replace(/\\/g, '/')));

    for (const repo of repos) {
        if (task) task.report(`Scanning ${repo.name} for service roots (depth 4)…`);

        // ── 1. Glob for all manifest files up to depth 4 ─────────────────────
        const manifestPaths = await glob(`**/${MANIFEST_GLOB}`, {
            cwd: repo.path,
            absolute: true,
            ignore: IGNORE_DIRS,
            maxDepth: 5,
        });

        if (manifestPaths.length === 0) {
            logger.debug(`(autodiscover) No manifests found in ${repo.name}.`);
            continue;
        }

        // ── 2. Derive unique service root directories ─────────────────────────
        const rootDirToManifests = new Map<string, string[]>();
        for (const mPath of manifestPaths) {
            const dir = path.dirname(mPath);
            const file = path.basename(mPath);
            const existing = rootDirToManifests.get(dir) ?? [];
            existing.push(file);
            rootDirToManifests.set(dir, existing);
        }

        // ── 3. Deduplicate: child-wins strategy ─────────────────────────────────
        const NOISE_DIR_RE = /\/(tests?|examples?|vendor|fixtures?|mocks?|__tests__)($|\/)/i;

        const dirs = [...rootDirToManifests.keys()].sort((a, b) => b.length - a.length);
        const pruned: string[] = [];

        for (const dir of dirs) {
            const normalizedDir = dir.replace(/\\/g, '/');
            const isNoiseDir = NOISE_DIR_RE.test(normalizedDir + '/');

            if (isNoiseDir) continue;

            const hasAcceptedDescendant = pruned.some(acceptedDir => {
                const normalizedAccepted = acceptedDir.replace(/\\/g, '/');
                const prefix = normalizedDir.endsWith('/') ? normalizedDir : normalizedDir + '/';
                return normalizedAccepted.startsWith(prefix);
            });

            if (!hasAcceptedDescendant) {
                pruned.push(dir);
            }
        }

        // ── 3b. Monolith-root rescue ─────────────────────────────────────────
        // Child-wins pruning assumes a root manifest is workspace tooling.
        // That assumption is falsified when the root manifest VENDORS the very
        // children that pruned it (e.g. Composer path repositories): the root
        // is then the application and the children are its local libraries.
        // Rescue the root as a component; role classification stays the normal
        // signal evaluation, and file routing stays longest-prefix, so child
        // workspaces keep owning their own subtrees.
        const repoRoot = path.resolve(repo.path);
        const rootManifests = rootDirToManifests.get(repoRoot);
        if (rootManifests && !pruned.includes(repoRoot)) {
            const rootLanguage = inferLanguage(rootManifests, repoRoot, repo.path);
            const rootPlugin = getLanguagePlugin(rootLanguage);
            const localDeps = rootPlugin?.loadLocalPathDependencies?.(repoRoot) ?? [];
            const vendorsChild = localDeps.length > 0 && pruned.some(dir =>
                matchesLocalPathDependency(localDeps, path.relative(repoRoot, dir).replace(/\\/g, '/')));
            if (vendorsChild) {
                pruned.push(repoRoot);
                if (task) task.report(`  Monolith root rescued: "${path.basename(repoRoot)}" vendors local workspace(s) via manifest path dependencies`);
            }
        }

        // ── 4. Build DiscoveredComponent objects ────────────────────────────────
        for (const dir of pruned) {
            const normalizedDir = dir.replace(/\\/g, '/');

            // Skip paths already claimed by a catalog source
            if (claimedSet.has(normalizedDir)) {
                logger.debug(`[AutoDiscovery] Skipping "${path.basename(dir)}" — already claimed by catalog source`);
                continue;
            }

            const manifests = rootDirToManifests.get(dir)!;
            const language = inferLanguage(manifests, dir, repo.path);
            const name = path.basename(dir);

            // Runtime vs library classification via the language plugin's
            // declarative signals. The orchestrator owns the I/O; plugins
            // declare data only (CLAUDE.md §1, §2).
            const plugin = getLanguagePlugin(language);
            const role = classifyServiceRole(dir, plugin);
            // 'runtime' → component carries type='service' so it becomes a
            //             :Service node downstream.
            // undefined → if the plugin declared any signals AND none fired,
            //             we treat it as a library (confident classification).
            //             Otherwise (no plugin or no signals) leave type
            //             undefined so the catalog can override later.
            const inferredType: 'service' | 'library' | undefined =
                role === 'runtime'
                    ? 'service'
                    : plugin?.runtimeServiceSignals
                        ? 'library'
                        : undefined;

            // Framework roles (e.g. 'graphql-server'). Empty set when the
            // plugin declares no frameworkRoleSignals.
            const frameworkRoles = classifyFrameworkRoles(dir, plugin);

            components.push({
                name,
                language,
                type: inferredType,
                catalogFile: dir,
                source: 'autodiscovery',
            });

            serviceRoots.push({
                name,
                path: dir,
                language,
                isRuntimeService: role === 'runtime',
                frameworkRoles: frameworkRoles.size > 0 ? frameworkRoles : undefined,
            });

            if (task) task.report(`  Found: ${name} (${language}) @ …/${path.relative(repo.path, dir)}`);
        }
    }

    return { components, serviceRoots };
}

/**
 * True when `relDir` (repo-root-relative, forward slashes) matches one of the
 * manifest-declared local path dependency patterns. Patterns follow the
 * manifest glob convention: `*` matches within one path segment, `**` crosses
 * segments. Non-glob patterns require an exact match.
 *
 * Exported for unit testing.
 */
export function matchesLocalPathDependency(patterns: readonly string[], relDir: string): boolean {
    for (const pattern of patterns) {
        if (!pattern.includes('*')) {
            if (pattern === relDir) return true;
            continue;
        }
        const regexSource = pattern
            .split('**')
            .map(part => part.split('*').map(escapeRegExp).join('[^/]*'))
            .join('.*');
        if (new RegExp(`^${regexSource}$`).test(relDir)) return true;
    }
    return false;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Max ancestor hops to walk (inclusive of the service dir itself) when
 *  hunting for a tsconfig.json that disambiguates TS from JS. Three covers
 *  the common cases: per-service tsconfig (0 hops), apps/-shared tsconfig
 *  (1 hop), repo-root tsconfig (2 hops). Beyond that the file likely
 *  belongs to a different concern. */
const TSCONFIG_WALK_MAX_HOPS = 3;

/**
 * Given the list of manifest filenames found in a directory, return the
 * inferred language using MANIFEST_PRIORITY order. Promotes `javascript`
 * (from a `package.json` match) to `typescript` when a `tsconfig.json` is
 * visible at the service root or up to two ancestor dirs (still within
 * the repo) — covers per-app tsconfig, monorepo-workspace shared tsconfig,
 * and repo-root tsconfig without flagging unrelated stray tsconfigs.
 *
 * Exported for unit testing.
 */
/**
 * Infer a workspace's language by scanning its directory for known manifest
 * files. Used when a catalog component lacks a usable language hint
 * (Backstage falls back to 'unknown' for most names).
 */
export function inferLanguageFromDir(dir: string, repoPath: string): string {
    let manifests: string[] = [];
    try {
        manifests = fs.readdirSync(dir).filter(name => {
            try { return fs.statSync(path.join(dir, name)).isFile(); }
            catch { return false; }
        });
    } catch { /* unreadable dir → 'unknown' */ }
    return inferLanguage(manifests, dir, repoPath);
}

export function inferLanguage(manifests: string[], dir: string, repoPath: string): string {
    let base = 'unknown';
    for (const { file, language } of MANIFEST_PRIORITY) {
        if (manifests.includes(file)) {
            base = language;
            break;
        }
    }
    if (base === 'javascript' && hasTsConfigAncestor(dir, repoPath)) {
        return 'typescript';
    }
    return base;
}

/** Hard cap on entrypoint file size in bytes; oversized files are skipped. */
const ENTRYPOINT_FILE_MAX_BYTES = 512 * 1024;

/**
 * Classify a workspace directory as a *runtime service* by evaluating the
 * declarative signals declared by the language plugin.
 *
 * Returns:
 *   - `'runtime'` when ANY signal fires (any-of semantics)
 *   - `undefined` when no signal fires (treated as `library` by downstream
 *     bucketing per the plan; explicit `library` is set only when the
 *     catalog declares `type: 'library'`)
 *
 * Language-agnostic short-circuit: a `Dockerfile` in the workspace root
 * always promotes the workspace to runtime, even when the language plugin
 * declares no signals (or is null for unknown languages).
 *
 * Per CLAUDE.md §1, §2: the orchestrator owns all fs reads and predicate
 * evaluation; plugins declare data, never control flow.
 */
export function classifyServiceRole(
    dir: string,
    plugin: LanguagePlugin | null,
): 'runtime' | undefined {
    if (fileExists(path.join(dir, 'Dockerfile'))) return 'runtime';

    const signals = plugin?.runtimeServiceSignals;
    if (!signals) return undefined;

    return evalSignalSet(dir, signals) ? 'runtime' : undefined;
}

/**
 * Evaluate a single `RuntimeServiceSignals` block against a directory.
 *
 * Two signal tiers with different semantics:
 *
 *   - STRONG signals: `manifestFields` (e.g. `scripts.start` / `bin`),
 *     `entrypoints` (bootstrap pattern in a known entry file),
 *     `dependencyMarkers` (e.g. `next` in dependencies, framework-specific).
 *     ANY-OF: the first match short-circuits → `runtime`.
 *
 *   - SUPPORTING signals: `manifestPresence` (e.g. "package.json with
 *     ≥10 TS files"). On its own this is too permissive — a NestJS
 *     `libs/helper` workspace with 16 helper-only TS files and a `nest
 *     build` script trivially matches without being a runtime entry.
 *     SUPPORTING signals only fire when AT LEAST ONE strong signal also
 *     fires; alone they are not sufficient.
 *
 * Note: a Dockerfile in the workspace root is handled earlier by
 * `classifyServiceRole` and bypasses this evaluation entirely.
 */
function evalSignalSet(dir: string, signals: RuntimeServiceSignals): boolean {
    for (const field of signals.manifestFields ?? []) {
        if (evalManifestField(dir, field)) return true;
    }
    for (const ep of signals.entrypoints ?? []) {
        if (evalEntrypoint(dir, ep)) return true;
    }
    for (const dm of signals.dependencyMarkers ?? []) {
        if (evalDependencyMarker(dir, dm)) return true;
    }
    // `manifestPresence` is a SUPPORTING signal: must be combined with a
    // strong signal above, never standalone. Falling through here means
    // no strong signal fired, so the workspace is not a runtime service.
    return false;
}

/**
 * Evaluate the per-workspace `frameworkRoleSignals` map and return the set of
 * role keys whose signal block fires at the given directory.
 *
 * Pure orchestration. Plugins declare *what* to detect; the orchestrator
 * owns *how* to look (CLAUDE.md §1, §2).
 */
export function classifyFrameworkRoles(
    dir: string,
    plugin: LanguagePlugin | null,
): Set<string> {
    const roles = new Set<string>();
    const map: FrameworkRoleSignals | undefined = plugin?.frameworkRoleSignals;
    if (!map) return roles;
    for (const [role, signals] of Object.entries(map)) {
        if (evalSignalSet(dir, signals)) roles.add(role);
    }
    return roles;
}

function fileExists(p: string): boolean {
    try { return fs.statSync(p).isFile(); }
    catch { return false; }
}

function readManifestJson(dir: string, manifest: string): Record<string, unknown> | null {
    const abs = path.join(dir, manifest);
    if (!fileExists(abs)) return null;
    try {
        const raw = fs.readFileSync(abs, 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function walkJsonPath(obj: unknown, jsonPath: string): unknown {
    if (!jsonPath) return obj;
    const segments = jsonPath.split('.');
    let cur: unknown = obj;
    for (const seg of segments) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

function evalManifestField(dir: string, field: RuntimeServiceManifestField): boolean {
    const manifest = readManifestJson(dir, field.manifest);
    if (!manifest) return false;
    const value = walkJsonPath(manifest, field.jsonPath);
    if (value === undefined || value === null) return false;
    if (field.condition === 'exists') {
        if (typeof value === 'string') return value.length > 0;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.keys(value as object).length > 0;
        return true;
    }
    // condition === 'matches'
    if (!field.valuePattern) return false;
    const stringified = typeof value === 'string' ? value : JSON.stringify(value);
    return field.valuePattern.test(stringified);
}

function evalEntrypoint(dir: string, ep: RuntimeServiceEntrypoint): boolean {
    const concretePaths: string[] = [];
    for (const rel of ep.files) {
        if (rel.includes('*')) {
            // Glob expansion (one or more wildcards). Scoped to the workspace dir.
            try {
                const matches = glob.sync(rel, { cwd: dir, absolute: true, nodir: true });
                concretePaths.push(...matches);
            } catch { /* glob errors silenced — treat as no match */ }
        } else {
            concretePaths.push(path.join(dir, rel));
        }
    }
    for (const abs of concretePaths) {
        if (!fileExists(abs)) continue;
        let content: string;
        try {
            const stats = fs.statSync(abs);
            if (stats.size > ENTRYPOINT_FILE_MAX_BYTES) continue;
            content = fs.readFileSync(abs, 'utf8');
        } catch { continue; }
        for (const re of ep.patterns) {
            if (re.test(content)) return true;
        }
    }
    return false;
}

function evalDependencyMarker(dir: string, dm: RuntimeServiceDependencyMarker): boolean {
    const manifest = readManifestJson(dir, dm.manifest);
    if (!manifest) return false;
    const sections = dm.sections ?? ['dependencies', 'devDependencies', 'require', 'require-dev'];
    for (const section of sections) {
        const block = manifest[section];
        if (!block || typeof block !== 'object') continue;
        const keys = Object.keys(block as object);
        for (const pkg of dm.packages) {
            if (keys.includes(pkg)) return true;
        }
    }
    return false;
}

function evalManifestPresence(dir: string, mp: RuntimeServiceManifestPresence): boolean {
    const manifest = readManifestJson(dir, mp.manifest);
    if (!manifest) return false;
    const section = walkJsonPath(manifest, mp.requireSection);
    if (!section || typeof section !== 'object') return false;
    const nonEmpty = Array.isArray(section)
        ? section.length > 0
        : Object.keys(section as object).length > 0;
    if (!nonEmpty) return false;
    return countSourceFiles(dir, mp.sourceExtensions) >= mp.minSourceFiles;
}

/** Hard cap so we never traverse beyond a reasonable depth for the presence count. */
const PRESENCE_SCAN_MAX_DEPTH = 6;

/**
 * Count files in `dir` whose extension is in `extensions`. Skips the universal
 * `IGNORE_DIRS` (node_modules, vendor, .git, dist, ...) so a single
 * `composer.json` in `vendor/` does not falsely look like a real codebase.
 */
function countSourceFiles(dir: string, extensions: readonly string[]): number {
    if (extensions.length === 0) return 0;
    const exts = new Set(extensions.map(e => e.toLowerCase()));
    let count = 0;
    const walk = (current: string, depth: number) => {
        if (depth > PRESENCE_SCAN_MAX_DEPTH) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
            const name = entry.name;
            if (name.startsWith('.')) continue;
            if (entry.isDirectory()) {
                if (PRESENCE_SKIP_DIRS.has(name)) continue;
                walk(path.join(current, name), depth + 1);
            } else if (entry.isFile()) {
                const ext = path.extname(name).toLowerCase();
                if (exts.has(ext)) count++;
            }
        }
    };
    walk(dir, 0);
    return count;
}

/**
 * Directory basenames that are never part of the workspace's own source.
 * Mirrors the language-agnostic ignore set without re-evaluating
 * `getAllIgnorePatterns()` against absolute paths.
 */
const PRESENCE_SKIP_DIRS = new Set<string>([
    'node_modules', 'vendor', 'dist', 'build', 'out',
    '.next', '.nuxt', 'coverage', 'bower_components',
    '__pycache__', '.venv', 'venv', 'tests', 'test', '__tests__',
    'examples', 'example', 'fixtures', 'docs', 'doc',
]);

/**
 * Walks up at most `TSCONFIG_WALK_MAX_HOPS` ancestors looking for a
 * `tsconfig.json`. Never crosses the repo boundary (`repoPath`) or the
 * filesystem root.
 */
function hasTsConfigAncestor(startDir: string, repoPath: string): boolean {
    const repoRoot = path.resolve(repoPath);
    let cur = path.resolve(startDir);
    for (let i = 0; i < TSCONFIG_WALK_MAX_HOPS; i++) {
        if (fs.existsSync(path.join(cur, 'tsconfig.json'))) return true;
        if (cur === repoRoot) break;
        const parent = path.dirname(cur);
        if (parent === cur) break; // reached filesystem root
        cur = parent;
        // Defensive: never go above the repo even if the start dir was given
        // outside of `repoPath` (would happen only via a misconfigured call).
        if (!cur.startsWith(repoRoot)) break;
    }
    return false;
}
