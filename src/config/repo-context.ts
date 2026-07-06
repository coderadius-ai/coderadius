import { loadRepoHints, clearRepoHintsCache } from './repo-hints.js';
import type { RepoHints } from './repo-hints.js';
import { extractAllPhysicalHints } from '../ingestion/processors/connection-extractors/registry.js';
import { canonicalizeDatastoreIdentities } from '../ingestion/processors/connection-extractors/canonicalizer.js';
import { extractEnvVarDictionary } from '../ingestion/processors/infra-manifest-resolver.js';
import type { DatastoreIdentity } from '../ingestion/processors/db-scope-resolver.js';
import type { EnvVarBinding } from '../ingestion/processors/infra-manifest-resolver.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Enriched Repo Context
//
// Composes YAML repo hints (from repo-hints.ts) with auto-discovered
// infrastructure signals (P1 connection strings, P2 infra manifests,
// P3 config vars) into a single memoized object.
//
// This module exists to avoid a cyclic dependency: repo-hints.ts (config/)
// cannot import from ingestion/processors/. This layer sits between them.
//
// Consumers that need auto-discovery (graph-writer, ephemeral-extractor)
// should use loadRepoContext(). Consumers that only need hints
// or packages config (static-analyzer, orchestrator) continue using loadRepoHints().
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Enriched repository context: YAML hints + auto-discovered signals.
 *
 * Used by graph-writer and ephemeral-extractor for resolveDatastoreBinding().
 */
export interface EnrichedRepoContext {
    /** Parsed coderadius.yaml */
    hints: RepoHints;
    /**
     * Canonical Datastore identities — the unit consumed by
     * `resolveDatastoreBinding`. Built by:
     *   1. Aggregating all PhysicalEndpointHint from the connection-extractor
     *      orchestrator (TypeORM, Doctrine, env-var trios, DSN URLs).
     *   2. Collapsing env variants (helm-prod + docker-compose-dev for the
     *      same logical DB) via `canonicalizeDatastoreIdentities`.
     */
    identities: DatastoreIdentity[];
    /** Generic env var name→value dictionary from deployment configs. */
    envVarDict: Map<string, EnvVarBinding>;
}

/** Module-level memoization per repo path. */
const _ctxCache = new Map<string, EnrichedRepoContext>();

/**
 * Load the enriched repo context for a given repo path.
 *
 * Composes:
 *   - loadRepoHints() (memoized YAML config)
 *   - extractAllPhysicalHints() → canonicalizeDatastoreIdentities()
 *   - extractEnvVarDictionary()
 *
 * Results are memoized per repo path. Call clearRepoContextCache() to invalidate.
 *
 * @param repoPath  Absolute path to the repository root
 */
export function loadRepoContext(repoPath: string): EnrichedRepoContext {
    if (_ctxCache.has(repoPath)) return _ctxCache.get(repoPath)!;

    const orch = extractAllPhysicalHints(repoPath);
    const identities = canonicalizeDatastoreIdentities(orch.hints);

    const ctx: EnrichedRepoContext = {
        hints:      loadRepoHints(repoPath),
        identities,
        envVarDict: extractEnvVarDictionary(repoPath),
    };

    _ctxCache.set(repoPath, ctx);
    return ctx;
}

/**
 * Invalidate the repo context cache (and underlying repo hints cache).
 *
 * Called by:
 *   - --force mode (flush all caches before re-ingest)
 *   - Test cleanup (beforeEach / afterEach)
 *
 * @param repoPath  Optional: clear only this repo. If omitted, clears all.
 */
export function clearRepoContextCache(repoPath?: string): void {
    if (repoPath) {
        _ctxCache.delete(repoPath);
        clearRepoHintsCache(repoPath);
    } else {
        _ctxCache.clear();
        clearRepoHintsCache();
    }
}
