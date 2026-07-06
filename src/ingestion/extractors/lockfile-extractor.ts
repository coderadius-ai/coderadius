import type { ResolvedRepo } from '../../graph/types.js';
import type { ProgressReporter } from '../core/progress.js';
import { getMemgraphSession } from '../../graph/neo4j.js';
import { buildUrn, getQualifiedRepoName } from '../../graph/urn.js';
import { logger } from '../../utils/logger.js';
import { getAllPlugins } from '../core/languages/registry.js';
import type { PackageDependency } from '../core/languages/types.js';

/**
 * Keep Bolt payloads bounded on large repositories (thousands of deps).
 */
const LOCKFILE_DEP_CHUNK_SIZE = 200;

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

export async function ingestLockfileDependencies(repos: ResolvedRepo[], reporter: ProgressReporter): Promise<void> {
    const REPO_TIMEOUT_MS = 60_000;

    for (const repo of repos) {
        reporter.report(`Processing lockfiles for ${repo.name}`);
        try {
            await Promise.race([
                processRepoLockfiles(repo, reporter),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`Lockfile processing timed out (${REPO_TIMEOUT_MS / 1000}s)`)), REPO_TIMEOUT_MS)
                )
            ]);
        } catch (e: any) {
            reporter.warn(`(lockfile) ⚠ Failed or Timed out processing ${repo.name}: ${e.message}`);
        }
    }

    reporter.report(`(lockfile) Completed: processed ${repos.length} repos`);
}

async function processRepoLockfiles(repo: ResolvedRepo, reporter: ProgressReporter): Promise<void> {
    const session = getMemgraphSession();
    try {
        const deps = await extractDependenciesForRepo(repo.path);

        if (deps.length === 0) {
            logger.debug(`(lockfile) No lockfile dependencies found for ${repo.name}`);
            return;
        }

        const repoUrn = buildUrn('repository', getQualifiedRepoName(repo));

        // ── Dedup: keep first occurrence per ecosystem:name, prefer non-dev ──
        const deduped = new Map<string, PackageDependency>();
        for (const dep of deps) {
            const key = `${dep.ecosystem}:${dep.name}`;
            const existing = deduped.get(key);
            if (!existing || (existing.isDev && !dep.isDev)) {
                deduped.set(key, dep);
            }
        }

        // ── UNWIND batch: chunked transactions to keep Bolt frames bounded ──
        const depRows = Array.from(deduped.values()).map(d => ({
            packageUrn: buildUrn('package', d.ecosystem, d.name),
            name: d.name,
            ecosystem: d.ecosystem,
            declaredRange: d.declaredRange,
            lockedVersion: d.lockedVersion,
            isDev: d.isDev,
        }));

        for (let i = 0; i < depRows.length; i += LOCKFILE_DEP_CHUNK_SIZE) {
            const chunk = depRows.slice(i, i + LOCKFILE_DEP_CHUNK_SIZE);
            await session.executeWrite(async (tx) => {
                await tx.run(
                    `UNWIND $deps AS dep
                     MERGE (p:Package {id: dep.packageUrn})
                     SET p.name = dep.name, p.ecosystem = dep.ecosystem, p.isInternal = coalesce(p.isInternal, false)
                     WITH p, dep
                     MATCH (r:Repository {id: $repoUrn})
                     MERGE (r)-[rel:DEPENDS_ON]->(p)
                     SET rel.requiredVersion = dep.declaredRange,
                         rel.installedVersion = dep.lockedVersion,
                         rel.isDev = dep.isDev`,
                    { repoUrn, deps: chunk }
                );
            });
        }

        logger.debug(`(lockfile) Persisted ${depRows.length} dependencies for ${repo.name} (deduped from ${deps.length})`);
    } finally {
        await session.close();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extraction Logic (Zero-LLM, plugin-based)
// ═══════════════════════════════════════════════════════════════════════════════

async function extractDependenciesForRepo(repoPath: string): Promise<PackageDependency[]> {
    const results: PackageDependency[] = [];

    for (const plugin of getAllPlugins()) {
        if (plugin.extractDependencies) {
            try {
                const deps = await plugin.extractDependencies(repoPath);
                results.push(...deps);
            } catch (e: any) {
                logger.debug(`(lockfile) Plugin ${plugin.language} failed to extract dependencies: ${e.message}`);
            }
        }
    }

    return results;
}
