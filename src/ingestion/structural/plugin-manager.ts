import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { computeFileHash, hashContent } from '../core/merkle.js';
import { logger } from '../../utils/logger.js';
import { recycleDriver } from '../../graph/neo4j.js';
import { ScopeManager } from '../core/scope-manager.js';
import type { ResolvedRepo } from '../../graph/types.js';
import type { DiscoveredService } from '../extractors/autodiscovery.js';
import type { ProgressReporter } from '../core/progress.js';
import type {
    StructuralPlugin,
    DirectoryPlugin,
    StructuralEntity,
    PluginContext,
    StructuralIngestionMetrics,
} from './types.js';
import * as structQueries from './queries.js';
import { withScopedSession } from './queries.js';
import { buildUrn, urnPrefix, getQualifiedRepoName } from '../../graph/urn.js';
import { generateEmbedding, generateEmbeddingsBatch, flushEmbeddingCache } from '../../ai/embeddings.js';
import { ensureVectorIndexes } from '../../graph/vector-indexes.js';
import { resolveEmbeddingDimension } from '../../ai/embedding-model-meta.js';
import { configManager } from '../../config/index.js';
import { getMastra } from '../../ai/mastra/index.js';
import { AgenticMetadataExtractionSchema } from '../../ai/agents/agentic-metadata-extractor.js';
import { telemetryCollector } from '../../telemetry/collector.js';
import { withCongestionControl } from '../../utils/congestion-control.js';

// ── Import Plugins ───────────────────────────────────────────────────────────
import { makefilePlugin } from './plugins/makefile.plugin.js';
import { dockerfilePlugin } from './plugins/dockerfile.plugin.js';
import { containerImagePlugin } from './plugins/container-image.plugin.js';
import { toolconfigPlugin } from './plugins/toolconfig.plugin.js';
import { ghostDirectoriesPlugin } from './plugins/ghost-directories.plugin.js';
import { agenticConfigPlugin } from './plugins/agentic-config.plugin.js';
import { packagePublisherPlugin } from './plugins/package-publisher.plugin.js';
import { ciConfigPlugin } from './plugins/ciconfig.plugin.js';
import { gitlabCiPlugin } from './plugins/gitlabci.plugin.js';
import { githubActionsPlugin } from './plugins/githubactions.plugin.js';
import { devtoolsPlugin } from './plugins/devtools.plugin.js';
import { packageScriptsPlugin } from './plugins/package-scripts.plugin.js';
import { simpleToolsPlugin } from './plugins/simple-tools.plugin.js';
import { renovatePlugin } from './plugins/renovate.plugin.js';
import { mergeRelease, linkRepositoryPublishesPackage, recomputeLatestVersion } from '../../graph/mutations/packages.js';
import { scanGitTagReleases, type PublisherInfo } from './git-tag-scanner.js';
import { detectGitSubmoduleProvenance } from '../core/source-resolver.js';
import { pruneNonAgenticNodes } from '../../graph/mutations/context-provenance.js';

// ── Import Contrib Plugins ───────────────────────────────────────────────────
import { crossplanePubsubPlugin } from './plugins/contrib/crossplane-pubsub.plugin.js';
import { rabbitmqConfigPlugin } from './plugins/messaging/rabbitmq-config.plugin.js';
import { symfonyMessengerPlugin } from './plugins/messaging/symfony-messenger.plugin.js';
import { laminasRabbitmqPlugin } from './plugins/messaging/laminas-rabbitmq.plugin.js';
import { laminasMessengerPhpPlugin } from './plugins/messaging/laminas-messenger-php.plugin.js';
import { doctrineMigrationsPlugin } from './plugins/doctrine-migrations.plugin.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Plugin Manager — Structural Extraction Orchestrator
//
// Orchestrates all structural plugins in a single pass:
//   1. Discover structural files via glob
//   2. Route files to matching plugins
//   3. Check per-file Merkle cache → skip unchanged
//   4. Run plugins (with per-plugin error isolation)
//   5. Run ghost directory scanner
//   6. Reconcile graph state (Mark & Sweep)
//   7. Persist entities + update structural hash
//
// This module has ZERO LLM dependencies. All extraction is deterministic.
// ═══════════════════════════════════════════════════════════════════════════════

/** All registered file-based plugins. */
export const FILE_PLUGINS: StructuralPlugin[] = [
    makefilePlugin,
    dockerfilePlugin,
    containerImagePlugin,   // Docker Compose / Helm / K8s → DockerImage nodes via USES_IMAGE
    toolconfigPlugin,
    agenticConfigPlugin,
    packagePublisherPlugin,
    ciConfigPlugin,          // presence-detection only — registers StructuralFile for gp-005
    gitlabCiPlugin,          // content extraction → CIPipeline node for gp-012, gp-015
    githubActionsPlugin,     // content extraction → CIPipeline node for gp-012, gp-015
    devtoolsPlugin,          // presence-detection for Renovate, catalog-info, devcontainer
    renovatePlugin,          // content extraction → ToolConfig node with governance signals
    packageScriptsPlugin,    // content extraction → Task node for npm/composer scripts
    simpleToolsPlugin,       // presence-to-entity mapping for backstage, dependabot, linters
    // ── Contrib Plugins (domain-specific, always loaded) ──
    crossplanePubsubPlugin,   // Crossplane CRD → MessageChannel + ROUTES_TO edges
    rabbitmqConfigPlugin,     // RabbitMQ definitions.json + rabbitmq.conf → broker + channels + bindings
    symfonyMessengerPlugin,   // messenger.yaml → meta-broker + transports + logical channels
    laminasRabbitmqPlugin,    // Laminas RabbitMqModule `return ['rabbitmq'=>...]` → exchange/queue channels
    laminasMessengerPhpPlugin,// Symfony Messenger config as PHP array (Laminas bridge) → exchange/queue channels
    doctrineMigrationsPlugin, // doctrine/migrations Version*.php DDL → DataContainer (ast/exact)
];

/**
 * Salt for the repo-level structural cache hash. The cache key is otherwise
 * file-content-only, so a plugin code change (new extractor, fixed emission)
 * would be invisible on unchanged repos and the run would skip re-extraction
 * — and the Mark & Sweep would never re-mark previously emitted entities.
 * Bump on any change to plugin emission semantics.
 */
const STRUCTURAL_EXTRACTOR_VERSION = '2026-06-07.1';

/** The directory-based plugin. */
const DIR_PLUGIN: DirectoryPlugin = ghostDirectoriesPlugin;

/** Glob patterns for discovering structural files. */
const STRUCTURAL_GLOB_PATTERNS = [
    '**/Makefile',
    // ── CI/CD Configuration ──
    '**/.gitlab-ci.yml',
    '**/.gitlab-ci.yaml',
    '**/.github/workflows/*.yml',
    '**/.github/workflows/*.yaml',
    '**/makefile',
    '**/GNUmakefile',
    '**/Dockerfile',
    '**/Dockerfile.*',
    '**/*.dockerfile',
    '**/tsconfig.json',
    '**/tsconfig.*.json',
    '**/package.json',
    '**/composer.json',
    // ── Dependency Management ──
    '**/renovate.json',
    '**/renovate.json5',
    '**/.renovaterc',
    '**/.renovaterc.json',
    '**/.github/renovate.json',
    // ── DevContainers ──
    '**/.devcontainer/devcontainer.json',
    '**/.devcontainer.json',
    // ── Backstage Software Catalog (presence — semantics from backstage-extractor) ──
    '**/catalog-info.yaml',
    '**/catalog-info.yml',
    '**/catalog.yaml',
    '**/catalog.yml',
    // ── Code Quality & Testing Tools ──
    '**/.github/dependabot.yml',
    '**/.github/dependabot.yaml',
    '**/.eslintrc*',
    '**/eslint.config.*',
    '**/.prettierrc*',
    '**/prettier.config.*',
    '**/jest.config.*',
    '**/vitest.config.*',
    '**/coderadius.yaml',
    '**/coderadius.hints.yaml',
    // ── Messaging broker topology (Phase 1) ──
    // Framework-specific discovery paths (RabbitMQ definitions, Symfony
    // messenger.yaml, ...) are owned by each plugin's `discoveryGlobs`
    // (merged via collectStructuralGlobPatterns) — never duplicated here.
    // ── Package Manager Lockfiles (presence → ToolConfig for package manager detection) ──
    '**/package-lock.json',
    '**/yarn.lock',
    '**/.yarnrc.yml',
    '**/pnpm-lock.yaml',
    '**/pnpm-workspace.yaml',
    '**/bun.lock',
    '**/bun.lockb',
    '**/composer.lock',
    // ── Python Package Manager Lockfiles ──
    '**/Pipfile.lock',
    '**/poetry.lock',
    '**/uv.lock',
    '**/pdm.lock',
    // ── Go Lockfile ──
    '**/go.sum',
    // ── Agentic AI Coding Configurations ──
    '**/.mcp.json',
    '**/.mcp.*.json',
    '**/.prompts/**/*.prompt',
    '**/.cursorrules',
    '**/.cursor/rules/*.md',
    '**/.cursor/rules/*.mdc',
    '**/.cursor/mcp.json',
    '**/.cursor/mcp.*.json',
    '**/.cursor/skills/*/[Ss][Kk][Ii][Ll][Ll].[Mm][Dd]',
    '**/.github/copilot-instructions.md',
    '**/.github/copilot/*.md',
    '**/.windsurfrules',
    '**/.windsurf/rules/*.md',
    '**/.windsurf/cascade.json',
    '**/.clinerules',
    '**/.cline/rules/*.md',
    '**/.roorules',
    '**/.roo/rules/*.md',
    '**/GEMINI.md',
    '**/GEMINI.*.md',
    '**/.gemini/settings.json',
    '**/.gemini/settings.*.json',
    '**/CLAUDE.md',
    '**/CLAUDE.*.md',
    '**/.worktreeinclude',
    '**/.claude/settings.json',
    '**/.claude/settings.*.json',
    '**/.claude/rules/**/*.md',
    '**/.claude/rules/**/*.mdc',
    '**/.claude/skills/*/SKILL.md',
    '**/.claude/commands/*.md',
    '**/.claude/output-styles/*.md',
    '**/.claude/agents/*.md',
    '**/.devin/**',
    '**/devin.json',
    '**/devin.*.json',
    '**/.goosehints',
    '**/.bolt/prompt',
    '**/promptfoo.yaml',
    '**/.amazonq/rules/*.md',
    '**/.coderabbit.yaml',
    '**/.aider.conf.yml',
    '**/.aiderignore',
    '**/.continue/config.json',
    '**/.continue/config.yaml',
    '**/AGENT.md',
    '**/AGENT.*.md',
    '**/AGENTS.md',
    '**/AGENTS.*.md',
    '**/CODEX.md',
    '**/CODEX.*.md',
    '**/codex.md',
    '**/codex.*.md',
    '**/augment-guidelines.md',
    '**/.agents/rules/**/*.md',
    '**/.agents/rules/**/*.mdc',
    '**/.agents/skills/*/SKILL.md',
    '**/.agents/workflows/*.md',
    '**/.agents/plugins/*/plugin.json',
    '**/.agent/rules/**/*.md',
    '**/.agent/rules/**/*.mdc',
    '**/.agent/skills/*/SKILL.md',
    '**/.agent/workflows/*.md',
    '**/_agents/rules/**/*.md',
    '**/_agents/rules/**/*.mdc',
    '**/_agents/skills/*/SKILL.md',
    '**/_agents/workflows/*.md',
    '**/_agent/rules/**/*.md',
    '**/_agent/rules/**/*.mdc',
    '**/_agent/skills/*/SKILL.md',
    '**/_agent/workflows/*.md',
    '**/.ai/**/*.md',
    '**/.ai/**/*.mdc',
    '**/.ai/**/*.blade.php',
    '**/.ai/**/plugin.json',
    // ── skills.sh lock file ──
    '**/skills-lock.json',
    // ── Knowledge Base — shared rules repos with root-level markdown ──
    // Intentionally root-only (no ** prefix) to avoid scanning every .md file
    // in the repo. Combined with the NON_AGENTIC_MD exclusion list in the plugin,
    // this captures files like BACKBONE.md, GOLDEN_PATH.md without noise.
    '*.md',
    // ── Infrastructure Manifests (Duck Typed by plugins via contentSignatures) ──
    '**/*.yaml',
    '**/*.yml',
];

const STRUCTURAL_GLOB_IGNORE = [
    '**/node_modules/**',
    '**/vendor/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/.next/**',
    '**/coverage/**',
    '**/.venv/**',
    '**/venv/**',
    '**/.tox/**',
    '**/__pycache__/**',
];

// ─── File Discovery ──────────────────────────────────────────────────────────

/**
 * Discover all structural files in a repository that can be handled by plugins.
 * Submodule mount-point directories are excluded to prevent misattribution of
 * submodule artifacts (package.json, Makefiles, etc.) to the consumer repo.
 */
/**
 * Fix 8: union of static `STRUCTURAL_GLOB_PATTERNS` and per-plugin
 * `discoveryGlobs`, deduplicated. Each plugin can declare its own globs
 * declaratively so adding a new plugin doesn't require touching the manager.
 *
 * Exported pure function so unit tests can verify the union behaviour without
 * spying on `glob()`.
 */
export function collectStructuralGlobPatterns(plugins: ReadonlyArray<StructuralPlugin>): string[] {
    const pluginGlobs = plugins.flatMap(p => p.discoveryGlobs ?? []);
    return Array.from(new Set([...STRUCTURAL_GLOB_PATTERNS, ...pluginGlobs]));
}

async function discoverStructuralFiles(
    repoPath: string,
    excludePaths?: string[],
): Promise<string[]> {
    const ignore = [...STRUCTURAL_GLOB_IGNORE];
    // Exclude submodule directories from ALL plugins, not just agentic-config.
    // This is a correctness fix: a Makefile or package.json inside a submodule
    // must not be attributed to the consuming repository.
    if (excludePaths) {
        for (const p of excludePaths) {
            ignore.push(`${p}/**`);
        }
    }
    const patterns = collectStructuralGlobPatterns(FILE_PLUGINS);
    return glob(patterns, {
        cwd: repoPath,
        absolute: true,
        ignore,
        nodir: true,
        dot: true,
    });
}

/**
 * Resolve whether a repo-relative file is reached through an in-repo symlink —
 * the leaf file OR any ancestor directory. The common cross-harness case is
 * `.agents/skills/X -> .claude/skills/X`: the SKILL.md leaf is a regular file,
 * so a leaf-only `lstat` misses it and the same skill is ingested twice as
 * independent nodes. Returns the canonical in-repo target (relative to the repo
 * root) when it differs from the logical path, else undefined.
 *
 * `repoRealPath` MUST be canonicalized (fs.realpathSync) so a symlinked repo
 * prefix (e.g. /tmp -> /private/tmp on macOS) cancels out and never produces a
 * false positive. Targets resolving outside the repo are ignored.
 */
export function resolveInRepoSymlink(
    repoRealPath: string,
    relativePath: string,
    realpath: (p: string) => string = fs.realpathSync,
): string | undefined {
    let resolvedRel: string;
    try {
        resolvedRel = path.relative(repoRealPath, realpath(path.join(repoRealPath, relativePath)));
    } catch {
        return undefined; // broken symlink — already filtered upstream
    }
    if (resolvedRel === relativePath || resolvedRel.startsWith('..')) return undefined;
    return resolvedRel;
}

/**
 * Find the best service owner for a file path via longest-prefix match.
 */
function resolveServiceForFile(
    absolutePath: string,
    serviceRoots: DiscoveredService[],
): string | undefined {
    let best: string | undefined;
    let bestLen = 0;

    for (const svc of serviceRoots) {
        const prefix = svc.path.endsWith(path.sep) ? svc.path : svc.path + path.sep;
        if (absolutePath.startsWith(prefix) && prefix.length > bestLen) {
            best = svc.name;
            bestLen = prefix.length;
        }
    }

    return best;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the Structural Extraction Layer for all repositories.
 *
 * This is the single entry point called by the workflow.
 * It handles file discovery, caching, plugin execution,
 * reconciliation, and persistence — completely independent
 * from the LLM pipeline.
 */
export interface IngestStructuralOptions {
    /** Force a full re-scan even if the structural hash matches. Useful when the
     *  graph may have stale data from a previous broken run. */
    force?: boolean;
}

export async function ingestStructural(
    repos: ResolvedRepo[],
    serviceRoots: DiscoveredService[],
    reporter: ProgressReporter,
    options?: IngestStructuralOptions,
): Promise<StructuralIngestionMetrics> {
    const metrics: StructuralIngestionMetrics = {
        filesProcessed: 0,
        filesSkipped: 0,
        entitiesPersisted: 0,
        entitiesRemoved: 0,
        ghostDirectoriesFound: 0,
        pluginErrors: 0,
    };

    const embCfg = configManager.getAiConfig('ingest');
    const embDim = resolveEmbeddingDimension(
        embCfg.embeddingProvider || embCfg.provider,
        embCfg.embeddingModel,
        configManager.getEmbeddingDimensionOverride(),
    );
    await ensureVectorIndexes(embDim);

    const recycleRaw = Number(process.env.RADIUS_DRIVER_RECYCLE_EVERY ?? '10');
    const DRIVER_RECYCLE_EVERY = Number.isFinite(recycleRaw) && recycleRaw > 0
        ? Math.floor(recycleRaw)
        : 10;
    const TRACE_STRUCTURAL = process.env.RADIUS_STRUCTURAL_TRACE === 'true';


    for (let repoIdx = 0; repoIdx < repos.length; repoIdx++) {
        const repo = repos[repoIdx];
        if (TRACE_STRUCTURAL) {
            reporter.report(`[Structural] Repo ${repoIdx + 1}/${repos.length}: ${repo.name}`);
        }

        // Per-repo try/catch: one bad repo must never crash the entire scan
        try {
            // withScopedSession keeps ONE Memgraph session alive for all queries
            // within this repo, reducing session churn from ~10 open/close per repo
            // to 1.  At 300+ repos this avoids the Bun segfault in the Bolt parser.
            const entitiesToEmbed = await withScopedSession<StructuralEntity[]>(async () => {
                const qualifiedRepoName = getQualifiedRepoName(repo);
                const repoUrn = buildUrn('repository', qualifiedRepoName);
                const scopeManager = new ScopeManager(repo.path);
                // Canonical repo root: symlink detection compares against this so a
                // symlinked repo prefix doesn't flag every file as a symlink.
                let repoRealPath = repo.path;
                try { repoRealPath = fs.realpathSync(repo.path); } catch { /* keep logical path */ }

                // ── 1. Discover structural files ─────────────────────────────────
                // Detect submodule provenance first so we can exclude their
                // directories from the glob — preventing misattribution.
                const submoduleProvenance = detectGitSubmoduleProvenance(repo.path, repo.remoteUrl);
                const submoduleMountPoints = submoduleProvenance.map(p => p.mountPoint);

                let filePaths = await discoverStructuralFiles(repo.path, submoduleMountPoints);

                // ── 2. Compute structural hash for repo-level skip ───────────────
                const fileHashes = new Map<string, string>();
                const validFilePaths: string[] = [];

                for (const fp of filePaths) {
                    try {
                        fileHashes.set(fp, computeFileHash(fp));
                        validFilePaths.push(fp);
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                            logger.debug(`[Structural] Skipped missing file / broken symlink: ${fp}`);
                            continue;
                        }
                        throw err;
                    }
                }

                filePaths = validFilePaths;

                const structuralHash = hashContent(
                    [...fileHashes.values()].sort().join(':') + ':' + STRUCTURAL_EXTRACTOR_VERSION,
                );

                // ── 3. Repo-level cache check ────────────────────────────────────
                const prevHash = options?.force ? null : await structQueries.loadStructuralHash(repoUrn);
                if (prevHash === structuralHash) {
                    const ghostResult = DIR_PLUGIN.scan(repo.path, repo.name, repoUrn, scopeManager, serviceRoots);
                    await persistGhostDirectories(ghostResult.entities, repoUrn, metrics);
                    metrics.ghostDirectoriesFound += ghostResult.entities.length;
                    if (TRACE_STRUCTURAL && ghostResult.entities.length > 0) {
                        reporter.report(`  [Ghost Directories] ${ghostResult.entities.length} for "${repo.name}"`);
                    }

                    if (filePaths.length > 0) {
                        metrics.filesSkipped += filePaths.length;
                        reporter.report(`Structural files unchanged for "${repo.name}" — skipped`);
                    }
                    return []; // no entities to embed
                }

                // ── 4. Load per-file index for incremental check ─────────────────
                const fileIndex = options?.force ? [] : await structQueries.loadStructuralFileIndex(repoUrn);
                const indexMap = new Map<string, string>();
                for (const row of fileIndex) {
                    indexMap.set(row.path, row.fileHash);
                }

                // ── 5. Route files to plugins and extract ────────────────────────
                const allEntities: StructuralEntity[] = [];
                const allEnrichments: import('./types.js').StructuralEnrichment[] = [];
                const processedFilePaths: string[] = [];

                for (const absolutePath of filePaths) {
                    const relativePath = path.relative(repo.path, absolutePath);
                    const basename = path.basename(absolutePath);
                    const fileHash = fileHashes.get(absolutePath)!;

                    const matchingPlugins = FILE_PLUGINS.filter(p =>
                        p.matchFile(relativePath, basename),
                    );

                    if (matchingPlugins.length === 0) continue;

                    let content: string;
                    try {
                        // Guardrail: Skip giant files (e.g., OpenAPI JSON dumps, test fixtures)
                        // Infrastructure manifests (Helm/Crossplane) are never > 1MB.
                        // Reading huge files would block the event loop and crash regex matching.
                        const stats = fs.statSync(absolutePath);
                        if (stats.size > 1024 * 1024) {
                            reporter.warn(`[Structural] Skipping ${relativePath}: File too large (${(stats.size / 1024).toFixed(1)} KB)`);
                            continue;
                        }

                        content = fs.readFileSync(absolutePath, 'utf-8');
                    } catch (err) {
                        reporter.warn(`[Structural] Failed to read ${relativePath}: ${(err as Error).message}`);
                        metrics.pluginErrors++;
                        continue;
                    }

                    // Pre-filter plugins by content signatures (Duck Typing)
                    const validPlugins = matchingPlugins.filter(plugin => {
                        if (!plugin.contentSignatures || plugin.contentSignatures.length === 0) return true;
                        return plugin.contentSignatures.some(re => re.test(content));
                    });

                    if (validPlugins.length === 0) continue;

                    processedFilePaths.push(relativePath);

                    const prevFileHash = indexMap.get(relativePath);
                    const isCachedFile = prevFileHash === fileHash;

                    const symlinkTarget = resolveInRepoSymlink(repoRealPath, relativePath);

                    const context: PluginContext = {
                        relativePath,
                        absolutePath,
                        repoName: qualifiedRepoName,
                        repoUrn,
                        ownerService: resolveServiceForFile(absolutePath, serviceRoots),
                        scopeManager,
                        symlinkTarget,
                    };

                    for (const plugin of validPlugins) {
                        try {
                            const result = plugin.extract(content, context);
                            allEntities.push(...result.entities);
                            if (result.enrichments) allEnrichments.push(...result.enrichments);

                            if (!isCachedFile && (result.entities.length > 0 || (result.enrichments?.length ?? 0) > 0)) {
                                reporter.report(`  [${plugin.label}] ${result.summary}`);
                            }
                        } catch (err) {
                            reporter.warn(`[Structural] Plugin "${plugin.name}" failed on ${relativePath}: ${(err as Error).message}`);
                            metrics.pluginErrors++;
                        }
                    }

                    if (isCachedFile) {
                        metrics.filesSkipped++;
                    } else {
                        const ownerUrn = context.ownerService ? buildUrn('service', qualifiedRepoName, context.ownerService) : repoUrn;
                        const ownerLabel = context.ownerService ? 'Service' : 'Repository';
                        const sfUrn = buildUrn('structuralfile', qualifiedRepoName, relativePath);
                        const pluginNames = validPlugins.map(p => p.name).join(',');
                        await structQueries.mergeStructuralFile(sfUrn, relativePath, fileHash, pluginNames, ownerUrn, ownerLabel);
                        metrics.filesProcessed++;
                    }
                }

                // ── 6. Ghost Directory Scan ──────────────────────────────────────
                const ghostResult = DIR_PLUGIN.scan(repo.path, repo.name, repoUrn, scopeManager, serviceRoots);
                await persistGhostDirectories(ghostResult.entities, repoUrn, metrics);
                metrics.ghostDirectoriesFound += ghostResult.entities.length;

                if (ghostResult.entities.length > 0) {
                    reporter.report(`  [${DIR_PLUGIN.label}] ${ghostResult.summary}`);
                }

                // ── 7. Reconciliation: Mark & Sweep ──────────────────────────────
                const allManagedLabels = new Set<string>();
                for (const plugin of FILE_PLUGINS) {
                    for (const label of plugin.managedLabels) {
                        allManagedLabels.add(label);
                    }
                }

                const extractedIdsByLabel = new Map<string, Set<string>>();
                for (const entity of allEntities) {
                    for (const label of entity.labels) {
                        if (!extractedIdsByLabel.has(label)) {
                            extractedIdsByLabel.set(label, new Set());
                        }
                        extractedIdsByLabel.get(label)!.add(entity.id);
                    }
                }

                for (const label of allManagedLabels) {
                    const existingIds = await structQueries.getExistingStructuralEntityIds(repoUrn, label);
                    const extractedIds = extractedIdsByLabel.get(label) ?? new Set();
                    const staleIds = existingIds.filter(id => !extractedIds.has(id));

                    if (staleIds.length > 0) {
                        await structQueries.deleteStaleEntities(staleIds);
                        metrics.entitiesRemoved += staleIds.length;
                        logger.debug(`[Structural] Reconciled ${label}: removed ${staleIds.length} stale node(s)`);
                    }
                }

                const existingDirIds = await structQueries.getExistingProjectDirectoryIds(repoUrn);
                const extractedDirIds = new Set(ghostResult.entities.map(e => e.id));
                const staleDirIds = existingDirIds.filter(id => !extractedDirIds.has(id));
                if (staleDirIds.length > 0) {
                    await structQueries.deleteStaleEntities(staleDirIds);
                    metrics.entitiesRemoved += staleDirIds.length;
                }

                await structQueries.deleteOrphanedStructuralFiles(repoUrn, processedFilePaths);

                // ── 8. Persist all entities + shortcut edges ────────────────────
                const newAgenticConfigIds = new Set<string>();
                const discoveredPublishers: PublisherInfo[] = [];

                for (const entity of allEntities) {
                    const sfUrn = findStructuralFileUrn(entity, qualifiedRepoName, filePaths, repo.path);

                    if (entity.labels.includes('Release')) {
                        const pName = entity.properties._packageName as string;
                        const pEcosystem = entity.properties._ecosystem as string;
                        const pVersion = entity.properties._version as string;
                        const pRegistry = entity.properties._registryUrl as string | null;

                        await mergeRelease(pEcosystem, pName, pVersion, 'manifest', repo.commit ?? 'unknown');
                        await linkRepositoryPublishesPackage(qualifiedRepoName, pEcosystem, pName, pVersion, pRegistry, 'manifest', repo.commit ?? 'unknown');

                        // Collect publisher for git tag scanning
                        discoveredPublishers.push({ packageName: pName, ecosystem: pEcosystem });

                        metrics.entitiesPersisted++;
                        continue;
                    }

                    const ownerService = entity.properties._ownerService as string | undefined;
                    const ownerUrn = ownerService ? buildUrn('service', qualifiedRepoName, ownerService) : repoUrn;
                    const ownerLabel = ownerService ? 'Service' : 'Repository';

                    await structQueries.mergeStructuralEntity(entity, sfUrn);
                    await structQueries.createShortcutEdge(ownerUrn, ownerLabel, entity.id, entity.labels[0]);
                    metrics.entitiesPersisted++;

                    if (entity.labels.includes('AgenticConfig')) {
                        const sourcePath = entity.properties._sourcePath as string | undefined;
                        const prevFileHash = sourcePath ? indexMap.get(sourcePath) : undefined;
                        const currentHash = entity.properties.contentHash as string | undefined;
                        if (prevFileHash !== entity.properties.contentHash || !currentHash) {
                            newAgenticConfigIds.add(entity.id);
                        }
                    }
                }

                // ── 8.1. Persist inter-entity edges from plugins ─────────────────
                for (const entity of allEntities) {
                    if (entity.edges) {
                        for (const edge of entity.edges) {
                            try {
                                await structQueries.mergeStructuralEdge(
                                    edge.sourceUrn,
                                    edge.targetUrn,
                                    edge.type,
                                    edge.properties,
                                );
                            } catch (err) {
                                reporter.warn(`[Structural] Failed to create edge ${edge.type}: ${(err as Error).message}`);
                                metrics.pluginErrors++;
                            }
                        }
                    }
                }

                // ── 8.2. Per-file edge sweep for USES_IMAGE ─────────────────────
                // When a YAML file is re-processed and an image reference is removed,
                // the plugin no longer emits that entity. The node-level sweep handles
                // deletion if no other plugin emits the same URN. But the USES_IMAGE
                // edge from the specific StructuralFile must also be cleaned up.
                const imageIdsByFile = new Map<string, string[]>();
                for (const entity of allEntities) {
                    if (entity.labels[0] === 'DockerImage' && entity.relationshipType === 'USES_IMAGE') {
                        const sfUrn = findStructuralFileUrn(entity, qualifiedRepoName, filePaths, repo.path);
                        if (!imageIdsByFile.has(sfUrn)) imageIdsByFile.set(sfUrn, []);
                        imageIdsByFile.get(sfUrn)!.push(entity.id);
                    }
                }
                for (const [sfUrn, ids] of imageIdsByFile) {
                    const swept = await structQueries.sweepStaleImageEdges(sfUrn, ids);
                    if (swept > 0) {
                        logger.debug(`[Structural] Swept ${swept} stale USES_IMAGE edge(s) from ${sfUrn}`);
                        metrics.entitiesRemoved += swept;
                    }
                }

                // ── 8.5. Git Tag Backfill — reconstruct release timeline ─────────
                // Runs AFTER manifest releases are persisted so the MERGE is
                // idempotent: tags found for the same version simply upgrade
                // confidence from 'manifest' → 'tag' and set the real date.
                if (discoveredPublishers.length > 0) {
                    try {
                        const tagReleases = await scanGitTagReleases(repo.path, discoveredPublishers);
                        for (const tr of tagReleases) {
                            await mergeRelease(tr.ecosystem, tr.packageName, tr.version, 'tag', repo.commit ?? 'unknown', tr.tagDate);
                            metrics.entitiesPersisted++;
                        }
                        if (tagReleases.length > 0) {
                            logger.debug(`[Structural] Git tag backfill: ${tagReleases.length} historical release(s) for "${repo.name}"`);
                        }

                        // Recompute latestKnownVersion from all Release nodes
                        // (semver-greatest wins over manifest placeholders)
                        const recomputedPkgs = new Set<string>();
                        for (const pub of discoveredPublishers) {
                            const key = `${pub.ecosystem}:${pub.packageName}`;
                            if (!recomputedPkgs.has(key)) {
                                recomputedPkgs.add(key);
                                await recomputeLatestVersion(pub.ecosystem, pub.packageName);
                            }
                        }
                    } catch (err) {
                        // Total isolation: tag scanning must NEVER break ingestion
                        logger.debug(`[Structural] Git tag scanning failed for "${repo.name}": ${(err as Error).message}`);
                    }
                }

                // ── 8.75. Apply manifest enrichments ──────────────────────────
                if (allEnrichments.length > 0) {
                    let enriched = 0;
                    for (const enrichment of allEnrichments) {
                        const matched = await structQueries.applyEnrichment(enrichment);
                        if (matched) enriched++;
                    }
                    if (enriched > 0) {
                        logger.debug(`[Structural] Applied ${enriched}/${allEnrichments.length} enrichment(s) for "${repo.name}"`);
                    }
                }

                // ── 9. Update structural hash ────────────────────────────────────
                await structQueries.updateStructuralHash(repoUrn, structuralHash);

                // Return entities needing embedding (so we can generate outside the session)
                return allEntities.filter(e => newAgenticConfigIds.has(e.id));

            }); // end withScopedSession — session is now closed

            // ── 8.25. LLM Metadata Enrichment OUTSIDE the scoped session ─────
            // Extract structured intent + topics from AgenticConfig content via
            // Gemini Flash. Accumulates results in memory, then flushes to
            // Memgraph in chunked UNWIND writes.
            const enrichedIntents = new Map<string, string>();

            if (entitiesToEmbed && entitiesToEmbed.length > 0) {
                const total = entitiesToEmbed.length;
                const metadataAgent = getMastra().getAgent('agenticMetadataExtractorAgent');
                let enrichOk = 0;
                let enrichFail = 0;
                const enrichT0 = Date.now();

                reporter.report(`[Agentic Enrichment] ${total} agentic config(s) to enrich in "${repo.name}"`);

                // ── Accumulator: collect LLM results in memory ───────────────
                const metadataPatches: Array<{
                    nodeId: string;
                    intent: string;
                    topicsCsv: string;
                    techsCsv: string;
                }> = [];

                // knowledge_base nodes that the LLM classifies as non-agentic
                // (false positives from the SCREAMING_CASE catch-all matcher)
                const nonAgenticNodeIds: string[] = [];

                // Process a single entity — isolated, never throws
                const enrichEntity = async (entity: StructuralEntity, idx: number) => {
                    const name = entity.properties.name as string;
                    const configType = entity.properties.configType as string;
                    const filePath = (entity.properties.filePath as string) ?? '';
                    const preview = (entity.properties.contentPreview as string) ?? '';

                    reporter.report(`[Agentic Enrichment] (${idx + 1}/${total}) ${name} [${configType}] — ${filePath}`);
                    const t0 = Date.now();

                    try {
                        const response = await withCongestionControl(() =>
                            metadataAgent.generate(
                                `Config name: ${name}\nConfig type: ${configType}\n\n${preview}`,
                                {
                                    structuredOutput: { schema: AgenticMetadataExtractionSchema },
                                    modelSettings: { maxRetries: 0, temperature: 0 },
                                },
                            )
                        );
                        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                        telemetryCollector.addTokensForPhase('agentic_metadata', response.usage);

                        const metadata = response.object;
                        if (metadata?.intent && metadata?.topics) {
                            // Filter funnel step 3: LLM classification
                            // Only knowledge_base nodes are checked — specific matchers
                            // (cursor, claude, etc.) are reliable enough to skip this.
                            const tool = entity.properties.tool as string | undefined;
                            if (tool === 'knowledge_base' && metadata.isAgenticContent === false) {
                                nonAgenticNodeIds.push(entity.id);
                                reporter.report(`[Agentic Enrichment] ✖ ${name} — classified as non-agentic content (will be pruned)`);
                                return;
                            }

                            const topicsCsv = metadata.topics.join(',');
                            const techsCsv = (metadata.technologies ?? []).map((t: string) => t.toLowerCase()).join(',');
                            // Accumulate — no DB write here
                            metadataPatches.push({ nodeId: entity.id, intent: metadata.intent, topicsCsv, techsCsv });
                            enrichedIntents.set(entity.id, metadata.intent);
                            enrichOk++;
                            reporter.report(`[Agentic Enrichment] ✔ ${name} (${elapsed}s) → [${topicsCsv}] {${techsCsv}}`);
                            logger.debug(`[Agentic Enrichment]   "${metadata.intent}"`);
                        } else {
                            enrichFail++;
                            telemetryCollector.addEnrichError({
                                repoName: repo.name,
                                filePath,
                                errorMessage: 'model returned empty metadata',
                                errorType: 'EmptyMetadata',
                            });
                            reporter.warn(`[Agentic Enrichment] ✖ ${name} (${elapsed}s) — model returned empty metadata`);
                        }
                    } catch (err) {
                        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                        enrichFail++;
                        const errorObj = err as Error;
                        const errMsg = errorObj.message?.split('\n')[0] ?? 'unknown';

                        let errorType = 'UnknownError';
                        if (errorObj.message?.includes('429') || errorObj.message?.includes('Rate Limit') || errorObj.message?.includes('quota')) {
                            errorType = 'RateLimitExceeded';
                        } else if (errorObj.message?.includes('Zod') || errorObj.message?.includes('validation')) {
                            errorType = 'ZodValidationError';
                        } else if (errorObj.message?.includes('Timeout') || errorObj.message?.includes('ECONN') || errorObj.message?.includes('fetch')) {
                            errorType = 'NetworkError';
                        } else if (errorObj.name) {
                            errorType = errorObj.name;
                        }

                        telemetryCollector.addEnrichError({
                            repoName: repo.name,
                            filePath,
                            errorMessage: errorObj.message || 'unknown',
                            stackTrace: errorObj.stack,
                            errorType,
                        });

                        // Graceful fallback: log and continue, don't cascade to Vercel Gateway
                        reporter.warn(`[Agentic Enrichment] ✖ ${name} (${elapsed}s) — ${errMsg}`);
                    }
                };

                // Sliding-window parallel execution (concurrency = 5)
                const CONCURRENCY = 5;
                for (let start = 0; start < total; start += CONCURRENCY) {
                    const batch = entitiesToEmbed.slice(start, start + CONCURRENCY);
                    await Promise.allSettled(batch.map((e, i) => enrichEntity(e, start + i)));
                }

                // ── Flush: chunked UNWIND writes for metadata patches ────────
                if (metadataPatches.length > 0) {
                    await bulkPatchMetadata(metadataPatches);
                    logger.debug(`[Agentic Enrichment] Flushed ${metadataPatches.length} metadata patch(es) with chunked Bolt writes`);
                }

                // ── Prune false-positive knowledge_base nodes ────────────────
                if (nonAgenticNodeIds.length > 0) {
                    const pruned = await pruneNonAgenticNodes(nonAgenticNodeIds);
                    reporter.report(`[Agentic Enrichment] Pruned ${pruned} non-agentic node(s) from graph`);
                    metrics.entitiesRemoved += pruned;
                }

                const totalElapsedMs = Date.now() - enrichT0;
                const totalElapsed = (totalElapsedMs / 1000).toFixed(1);
                reporter.report(`[Agentic Enrichment] Done: ${enrichOk}/${total} enriched, ${enrichFail} failed (${totalElapsed}s)`);

                // Feed enrichment counters to telemetry for final report
                telemetryCollector.incrementEnrichOk(enrichOk);
                telemetryCollector.incrementEnrichFail(enrichFail);
                telemetryCollector.addEnrichTime(totalElapsedMs);
            }

            // ── 8.5. Generate embeddings OUTSIDE the scoped session ──────────
            // Embedding generation calls external APIs (Vertex/Ollama) and can
            // take seconds — holding a Memgraph session open would waste connections.
            // Uses enriched intent (if available) for higher-quality vectors.
            // DB writes are chunked via UNWIND batches.
            if (entitiesToEmbed && entitiesToEmbed.length > 0) {
                logger.debug(`[Structural] Generating embeddings for ${entitiesToEmbed.length} AgenticConfig node(s)...`);

                const texts = entitiesToEmbed.map(entity => {
                    const name = entity.properties.name as string;
                    // Prefer LLM-enriched intent over raw description/preview
                    const intent = enrichedIntents.get(entity.id)
                        ?? (entity.properties.description as string)
                        ?? '';
                    return [name, intent].filter(Boolean).join(' ');
                });

                let embeddings: (number[] | null)[];
                try {
                    embeddings = await generateEmbeddingsBatch(texts);
                } catch (err) {
                    reporter.warn(`[Structural] Batch embedding failed: ${(err as Error).message}. Skipping.`);
                    embeddings = entitiesToEmbed.map(() => null);
                }

                // ── Flush: chunked UNWIND writes for embedding patches ───────
                const embeddingPatches: Array<{ nodeId: string; embedding: number[]; model: string }> = [];
                for (let i = 0; i < entitiesToEmbed.length; i++) {
                    const embedding = embeddings[i];
                    if (!embedding) continue;
                    embeddingPatches.push({ nodeId: entitiesToEmbed[i].id, embedding, model: 'gemini-embedding-001' });
                }
                if (embeddingPatches.length > 0) {
                    await bulkPatchEmbeddings(embeddingPatches);
                    logger.debug(`[Structural] Flushed ${embeddingPatches.length} embedding patch(es) with chunked Bolt writes`);
                }
                flushEmbeddingCache();
            }
        } catch (err) {
            // Graceful degradation: log the error and continue to next repo
            reporter.warn(`[Structural] ⚠ Failed processing repo "${repo.name}": ${(err as Error).message}`);
            metrics.pluginErrors++;
        }
        // Recycle the neo4j driver every N repos to fully reset Bun's
        // internal TCP socket state.  Without this, Bun's native `net`
        // module accumulates corrupt state after ~200 session cycles,
        // causing a deterministic segfault (0x6D6F632220200A7B).
        // This is NOT a GC call — it simply closes the TCP connection pool
        // and lets getMemgraphDriver() lazily recreate fresh connections.
        if ((repoIdx + 1) % DRIVER_RECYCLE_EVERY === 0) {
            await recycleDriver();
            logger.debug(`[Structural] Recycled neo4j driver after ${repoIdx + 1} repos`);
        }
    }

    return metrics;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Persist ghost directory entities and reconcile removals.
 */
async function persistGhostDirectories(
    entities: StructuralEntity[],
    repoUrn: string,
    metrics: StructuralIngestionMetrics,
): Promise<void> {
    const batch = entities.map((entity) => {
        const props = entity.properties;
        const ownerService = props._ownerService as string | undefined;
        // Extract qualifiedRepoName from repoUrn: 'cr:repository:{org/repo}' -> '{org/repo}'
        const repoQualified = repoUrn.replace(/^cr:repository:/, '');
        return {
            id: entity.id,
            name: props.name as string,
            dirPath: props.path as string,
            category: props.category as string,
            ownerUrn: ownerService ? buildUrn('service', repoQualified, ownerService) : repoUrn,
            ownerLabel: (ownerService ? 'Service' : 'Repository') as 'Repository' | 'Service',
        };
    });

    await structQueries.mergeProjectDirectoriesBatch(batch);
}

/**
 * Determine the StructuralFile URN that owns an entity.
 * Entities store context about which file they came from via their ID pattern.
 */
function findStructuralFileUrn(
    entity: StructuralEntity,
    repoName: string,
    filePaths: string[],
    repoPath: string,
): string {
    // Entity IDs follow patterns like:
    //   urn:task:{repo}:{target}        → from Makefile
    //   urn:dockerimage:{image}:{tag}   → from Dockerfile
    //   urn:tsconfig:{repo}:{path}      → from tsconfig.json
    //
    // We need to find which StructuralFile the entity came from.
    // Since entities are processed per-file, we rely on the entity's
    // properties to reconstruct the source path.

    // For TSConfig: the ID contains the path
    if (entity.id.startsWith(urnPrefix('tsconfig'))) {
        const tsconfigPrefix = urnPrefix('tsconfig', repoName);
        const tsPath = entity.id.startsWith(tsconfigPrefix)
            ? decodeURIComponent(entity.id.slice(tsconfigPrefix.length))
            : entity.id;
        return buildUrn('structuralfile', repoName, tsPath);
    }

    // For Task: find the Makefile in the repo
    if (entity.id.startsWith(urnPrefix('task'))) {
        // Entities from Makefiles — find the Makefile path
        const sourcePath = entity.properties._sourcePath as string | undefined;
        if (sourcePath) {
            return buildUrn('structuralfile', repoName, sourcePath);
        }
        // Fallback: try to find a Makefile
        for (const fp of filePaths) {
            const rel = path.relative(repoPath, fp);
            const bn = path.basename(fp);
            if (/^(Makefile|makefile|GNUmakefile)$/.test(bn)) {
                return buildUrn('structuralfile', repoName, rel);
            }
        }
    }

    // For DockerImage: find the Dockerfile
    if (entity.id.startsWith(urnPrefix('dockerimage'))) {
        const sourcePath = entity.properties._sourcePath as string | undefined;
        if (sourcePath) {
            return buildUrn('structuralfile', repoName, sourcePath);
        }
        for (const fp of filePaths) {
            const bn = path.basename(fp);
            if (/^Dockerfile/i.test(bn) || fp.endsWith('.dockerfile')) {
                return buildUrn('structuralfile', repoName, path.relative(repoPath, fp));
            }
        }
    }

    // Generic fallback: all plugins set _sourcePath on their entities
    const sourcePath = entity.properties._sourcePath as string | undefined;
    if (sourcePath) {
        return buildUrn('structuralfile', repoName, sourcePath);
    }

    // Ultimate fallback — should not happen in practice
    return buildUrn('structuralfile', repoName, 'unknown');
}

// ─── Bulk Embedding Patch ─────────────────────────────────────────────────────

/**
 * Batch-patch embedding fields on already-persisted graph nodes.
 *
 * Chunked into groups of EMBEDDING_CHUNK_SIZE to prevent Bolt frame overflow.
 * Each embedding is 768 float64 values (gemini-embedding-001) = ~6.1KB.
 * Sending 50+ embeddings in one UNWIND produces a ~300KB Bolt message which
 * overflows the native neo4j-driver's internal parser buffer, causing a
 * use-after-free surfaced as a segfault in Bun/JSC.
 * At chunk size 10 → ~60KB/frame, well within the driver's safe limits.
 */
const EMBEDDING_CHUNK_SIZE = 10;

async function bulkPatchEmbeddings(
    patches: Array<{ nodeId: string; embedding: number[]; model: string }>,
): Promise<void> {
    if (patches.length === 0) return;
    const { run } = await import('../../graph/mutations/_run.js');
    for (let i = 0; i < patches.length; i += EMBEDDING_CHUNK_SIZE) {
        const chunk = patches.slice(i, i + EMBEDDING_CHUNK_SIZE);
        await run(
            `UNWIND $patches AS p
             MATCH (n {id: p.nodeId})
             SET n.embedding = p.embedding, n.embeddingModel = p.model`,
            { patches: chunk },
        );
    }
}

// ─── Bulk Metadata Patch ──────────────────────────────────────────────────────

/**
 * Batch-patch LLM-extracted semantic metadata on AgenticConfig nodes.
 * Overwrites the regex-based topics with higher-quality LLM results
 * and sets the semanticIntent + technologies fields.
 *
 * Chunked to prevent oversized Bolt frames on very large scans.
 */
const METADATA_CHUNK_SIZE = 25;

async function bulkPatchMetadata(
    patches: Array<{ nodeId: string; intent: string; topicsCsv: string; techsCsv: string }>,
): Promise<void> {
    if (patches.length === 0) return;
    const { run } = await import('../../graph/mutations/_run.js');
    for (let i = 0; i < patches.length; i += METADATA_CHUNK_SIZE) {
        const chunk = patches.slice(i, i + METADATA_CHUNK_SIZE);
        await run(
            `UNWIND $patches AS p
             MATCH (n {id: p.nodeId})
             SET n.semanticIntent = p.intent, n.topics = p.topicsCsv, n.technologies = p.techsCsv`,
            { patches: chunk },
        );
    }
}
