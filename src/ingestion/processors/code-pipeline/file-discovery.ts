import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { traceCollector } from '../../../telemetry/index.js';
import { discoverFiles } from '../../core/source-resolver.js';
import {
    computeFileHash,
    computeRepoHash,
    buildMerkleIndex,
} from '../../core/merkle.js';
import { mergeRepository } from '../../../graph/mutations/code-graph.js';
import { loadMerkleIndex } from '../../../graph/mutations/merkle.js';
import { telemetryCollector } from '../../../telemetry/index.js';
import type { ResolvedRepo } from '../../../graph/types.js';
import { buildUrn, getQualifiedRepoName } from '../../../graph/urn.js';
import { isCompatibleScanMode } from '../../../graph/scan-mode.js';
import type { ScanMode } from '../../../graph/scan-mode.js';
import type { DiscoveredService } from '../../extractors/autodiscovery.js';
import type {
    FileContext,
    DiscoveryResult,
    OwnershipRouting,
    ProgressReporter,
} from './types.js';
import { getAllPlugins } from '../../core/languages/registry.js';
import type { LanguagePlugin } from '../../core/languages/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 1: File Discovery & Routing
//
// Responsibility:
//   - Traverse directories and discover supported source files
//   - Classify files by monorepo ownership (service / library / repository)
//   - Compute Merkle hashes for incremental change detection
//   - Perform repo-level skip detection
//
// This stage knows NOTHING about Tree-sitter, LLMs, or Neo4j persistence.
// Its only Neo4j dependency is loading the previous Merkle index for
// incremental comparison.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Test / Asset Exclusion ──────────────────────────────────────────────────
//
// Test, asset, and build-output exclusion is owned end-to-end by ScopeManager
// (universal patterns) and the per-language plugins' `scopeExclusions`
// (extension-level conventions like `*Test.php`, `*.spec.ts`, `*_test.go`,
// `test_*.py`).
//
// Discovery already filters through ScopeManager before this stage runs, so we
// don't need a second per-file `isTestFile` predicate here.  Pushing all the
// rules through one filter has two benefits:
//   1. The (?!fixtures\/) carve-out that previously special-cased the cli's
//      own `tests/fixtures/microservices/<svc>` integration roots is gone:
//      those roots are passed in as `repo.path` by the test runner, so their
//      relative-to-repo paths never contain a leading `tests/` segment and
//      ScopeManager (which matches relative paths) is naturally safe.
//   2. Enterprise framework layouts (Symfony `Resources/public/**`, Laravel
//      `storage/framework/**`, Next.js `.next/**`, Storybook `storybook-static/**`,
//      pytest `.pytest_cache/**`, ...) live in each language plugin's
//      `scopeExclusions` so new frameworks get covered by extending the right
//      plugin, never the core file-discovery code.

// ─── Monorepo Routing ────────────────────────────────────────────────────────

/**
 * Map a file's repo-relative path to its owning :Service or :Library node.
 *
 * Recognised monorepo conventions:
 *   - `apps/<name>/...`     → :Service{name}    (NestJS/Nx apps, Turborepo apps)
 *   - `packages/<name>/...` → :Library{name}    (npm-workspaces, Lerna, Turborepo packages)
 *   - `libs/<name>/...`     → :Library{name}    (NestJS monorepo lib convention)
 *
 * Anything else routes to the repo root. The autodiscovery pass independently
 * detects whether a workspace under `libs/` is genuinely a library (presence
 * of `package.json` + classification via topology-resolver); without that
 * upstream signal the :Library node would not exist and the CONTAINS edge
 * would dangle. In practice the two paths agree: NestJS scaffolding creates
 * one `package.json` per `libs/<name>`, so autodiscovery promotes the
 * workspace and file-discovery attributes the files. Cases that fall out of
 * sync (e.g. `libs/types/` used purely as a `tsconfig.paths` alias with no
 * manifest) emit a Library URN here but the corresponding :Library node is
 * never created by topology, so the graph stays clean.
 *
 * Exported for unit-test pinning (no other production caller).
 */
export function getMonorepoRouting(relPath: string, qualifiedRepoName: string): OwnershipRouting {
    if (relPath.startsWith('apps/')) {
        const parts = relPath.split('/');
        const serviceName = parts[1];
        if (serviceName && serviceName.trim() !== '') {
            // Use namespaced service URN: cr:service:{qualifiedRepoName}:{serviceName}
            return { type: 'service', name: serviceName, urn: buildUrn('service', qualifiedRepoName, serviceName) };
        }
    } else if (relPath.startsWith('packages/') || relPath.startsWith('libs/')) {
        const parts = relPath.split('/');
        const libraryName = parts[1];
        if (libraryName && libraryName.trim() !== '') {
            return { type: 'library', name: libraryName, urn: buildUrn('library', libraryName) };
        }
    }

    return { type: 'repository', name: qualifiedRepoName, urn: buildUrn('repository', qualifiedRepoName) };
}

// ─── Service Resolution ──────────────────────────────────────────────────────

function resolveServiceForFile(
    absoluteFilePath: string,
    serviceRoots: DiscoveredService[],
): DiscoveredService | null {
    let best: DiscoveredService | null = null;
    let bestLen = 0;

    for (const svc of serviceRoots) {
        const prefix = svc.path.endsWith(path.sep) ? svc.path : svc.path + path.sep;
        if (!absoluteFilePath.startsWith(prefix)) continue;

        // A strictly longer prefix always wins (more specific service root).
        const longer = prefix.length > bestLen;
        // Equal-length prefixes mean the SAME root path claimed by two roots:
        // the autodiscovery root (isRuntimeService=false when the language
        // heuristic did not fire) and the catalog-promoted root
        // (isRuntimeService=true). They tie because they are the same directory.
        // The catalog declaration is authoritative (declared > heuristic), so the
        // runtime root must win — otherwise ownership dispatches to a :Library
        // that the topology-resolver never created and the edge silently no-ops,
        // leaving the catalog :Service an empty shell (the single-repo case).
        const tieRuntimeWins = prefix.length === bestLen && svc.isRuntimeService && best !== null && !best.isRuntimeService;

        if (longer || tieRuntimeWins) {
            best = svc;
            bestLen = prefix.length;
        }
    }

    return best;
}

/**
 * Resolve the owning service for a file: longest-prefix match, with a
 * "sole runtime service of the repo" fallback.
 *
 * Primary: `resolveServiceForFile` (longest-prefix over `serviceRoots`).
 *
 * Fallback: when no root prefix-matches AND the file's repo hosts exactly one
 * runtime service, attribute the file to that service. This rescues a
 * single-service repo whose Service is catalog-declared (Backstage/Cortex)
 * with a root pointing at the `catalog-info.yaml` directory rather than the
 * code root, so the bare prefix-match never reaches the source files (the
 * acme-monolith case). It is the writer-side counterpart of the Tier-3
 * `soleServiceUrns` guard in `graph/queries/topology.ts`, and mirrors the
 * repo-root fallback in `openapi-extractor.getSpecOwner`, so the code pipeline
 * and the OpenAPI extractor agree on ownership instead of diverging.
 *
 * The guard (exactly one runtime service in the repo) keeps genuine monorepos
 * safe: a repo with ≥2 runtime services never attributes a loose file to an
 * arbitrary one. Library workspaces (`isRuntimeService === false`) do not count
 * toward the total, so a lone runtime service alongside libraries still wins.
 */
export function resolveOwnerService(
    absoluteFilePath: string,
    serviceRoots: DiscoveredService[],
    repoPath: string,
): DiscoveredService | null {
    const direct = resolveServiceForFile(absoluteFilePath, serviceRoots);
    if (direct) return direct;

    const repoPrefix = repoPath.endsWith(path.sep) ? repoPath : repoPath + path.sep;
    const repoRuntimeServices = serviceRoots.filter(svc =>
        svc.isRuntimeService &&
        (svc.path === repoPath || svc.path.startsWith(repoPrefix)),
    );

    return repoRuntimeServices.length === 1 ? repoRuntimeServices[0] : null;
}

// ─── Manifest Detection ─────────────────────────────────────────────────────

const MANIFEST_BASENAMES = new Set(['package.json', 'composer.json']);

function isManifestFile(filePath: string): boolean {
    return MANIFEST_BASENAMES.has(path.basename(filePath));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Discover and classify all source files across the given repositories.
 *
 * Returns one DiscoveryResult per repo, containing typed FileContext objects
 * ready for Stage 2 consumption, plus repo-level Merkle data for skip detection.
 */
export async function discoverAndRoute(
    repos: ResolvedRepo[],
    serviceRoots: DiscoveredService[],
    task?: ProgressReporter,
    scanMode: ScanMode = 'semantic',
    scoutedConfigFilesByRepo?: Map<string, Set<string>>,
    symbolTaintedFilesByRepo?: Map<string, Map<string, Set<string>>>,
    freshScan: boolean = false,
    taintDepth?: number,
): Promise<DiscoveryResult[]> {
    const results: DiscoveryResult[] = [];

    for (const repo of repos) {
        if (task) task.report(`Scanning ${repo.name}...`);
        const qualifiedRepoName = getQualifiedRepoName(repo);
        const analyzedAt = new Date().toISOString();
        const scoutedConfigFiles = scoutedConfigFilesByRepo?.get(qualifiedRepoName);
        const symbolTaintedFiles = symbolTaintedFilesByRepo?.get(qualifiedRepoName);

        // Ensure a Repository anchor node exists
        await mergeRepository(
            repo.name,
            repo.remoteUrl,
            repo.commit ?? 'SYSTEM',
            repo.org,
            repo.livenessCommits != null ? {
                commits:    repo.livenessCommits,
                computedAt: analyzedAt,
            } : undefined,
            repo.branch,
            repo.defaultBranch,
            repo.coreBranches,
            repo.hostingPlatform,
            repo.gitConventions,
        );

        // ── Load Merkle Index from MemGraph ──────────────────────────────────
        const merkleRows = await loadMerkleIndex(qualifiedRepoName);
        const merkleIndex = buildMerkleIndex(merkleRows);

        // ── Discover files ────────────────────────────────────────────────
        const filePaths = await discoverFiles(repo.path);

        // ── Compute file hashes ───────────────────────────────────────────
        const fileHashes = new Map<string, string>();
        for (const filePath of filePaths) {
            fileHashes.set(filePath, computeFileHash(filePath, taintDepth?.toString() || '8'));
        }

        // ── Repo-level skip detection ─────────────────────────────────────
        const repoHash = computeRepoHash([...fileHashes.values()]);
        const isCacheValid = isCompatibleScanMode(
            merkleIndex.repoScanMode,
            scanMode,
        );
        // ── Build allFilePaths and dependencyMappings ──────────────────────
        const allFilePaths = new Set(filePaths.map(absPath => path.relative(repo.path, absPath).replace(/\\/g, '/')));
        const dependencyMappings = getAllPlugins().flatMap((p: LanguagePlugin) =>
            p.loadDependencyMappings?.(repo.path) ?? [],
        );

        if (!freshScan && merkleIndex.repoHash === repoHash && isCacheValid && (!symbolTaintedFiles || symbolTaintedFiles.size === 0)) {
            telemetryCollector.incrementFilesSkipped(filePaths.length);
            traceCollector.traceDiscovery('CACHE_HIT', qualifiedRepoName, 'repo hash unchanged', { repoHash, fileCount: filePaths.length });
            await mergeRepository(
                repo.name,
                repo.remoteUrl,
                repo.commit ?? 'SYSTEM',
                repo.org,
                repo.livenessCommits != null ? {
                    commits:    repo.livenessCommits,
                    computedAt: analyzedAt,
                } : undefined,
                repo.branch,
                repo.defaultBranch,
                repo.coreBranches,
                repo.hostingPlatform,
                repo.gitConventions,
                analyzedAt,
            );

            results.push({
                repo,
                files: [],
                merkleIndex,
                repoHash,
                skippedCount: filePaths.length,
                allFilePaths,
                dependencyMappings,
            });
            continue;
        }

        // ── Build FileContext for each file ───────────────────────────────
        const files: FileContext[] = [];
        let skippedCount = 0;

        // Trace: repo hash mismatch — processing needed
        traceCollector.traceDiscovery('INFO', qualifiedRepoName, 'repo hash changed, processing files', { oldHash: merkleIndex.repoHash, newHash: repoHash, totalFiles: filePaths.length });

        for (const absolutePath of filePaths) {
            const relativePath = path.relative(repo.path, absolutePath);

            // Scout-discovered config file exclusion: these have already been
            // processed by the ConfigSymbolExtractor in Pass 0.5 and should not
            // be re-analyzed as regular source files (prevents ghost functions).
            if (scoutedConfigFiles?.has(relativePath) || scoutedConfigFiles?.has(relativePath.replace(/\\/g, '/'))) {
                skippedCount++;
                telemetryCollector.incrementFilesSkipped();
                logger.debug(`[Discovery] Skipping scouted config file: ${relativePath}`);
                traceCollector.traceDiscovery('EXCLUDE', relativePath, 'scouted config file (processed by Symbol Extractor)');
                continue;
            }
            const fileHash = fileHashes.get(absolutePath)!;
            const routing = getMonorepoRouting(relativePath, qualifiedRepoName);
            const ownerService = serviceRoots.length > 0
                ? resolveOwnerService(absolutePath, serviceRoots, repo.path)
                : null;

            traceCollector.traceDiscovery('INCLUDE', relativePath, 'included for analysis', { fileHash, routing: `${routing.type}:${routing.name}`, ownerService: ownerService?.name ?? null, isManifest: isManifestFile(absolutePath) });

            files.push({
                absolutePath,
                relativePath,
                repo,
                routing,
                fileHash,
                ownerService,
                isManifest: isManifestFile(absolutePath),
            });
        }

        results.push({
            repo,
            files,
            merkleIndex,
            repoHash,
            skippedCount,
            allFilePaths,
            dependencyMappings,
        });
    }

    return results;
}
