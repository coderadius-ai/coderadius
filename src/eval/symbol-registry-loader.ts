// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine — Symbol Registry Loader
//
// Thin eval wrapper over the Enterprise Symbol Extraction module.
// It keeps the public `loadHybridRegistry()` contract for callers, while using
// the same raw extraction + deterministic env resolution path as ingestion.
// ═══════════════════════════════════════════════════════════════════════════════

import { SymbolRegistry } from '../ingestion/core/symbol-registry.js';
import { loadSymbolRegistryForEval } from '../ingestion/core/symbol-extraction.js';
import { logger } from '../utils/logger.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SymbolRegistryLoaderOptions {
    /** The repo name (used to scope ConfigSymbol nodes in the graph). */
    repoName: string;
    /** Repo root on disk (used to read config files when re-extracting). */
    repoRoot: string;
    /** PR-changed files — used to detect if any config files were modified. */
    changedFiles: string[];
}

/**
 * Build a SymbolRegistry for use in CI dry-run extraction.
 *
 * Loads active ConfigSymbol nodes, re-runs extraction only for changed symbol
 * config files, and resolves env templates deterministically without triggering
 * LLM extraction for env-only changes.
 */
export async function loadHybridRegistry(
    opts: SymbolRegistryLoaderOptions
): Promise<SymbolRegistry> {
    const result = await loadSymbolRegistryForEval(opts);
    logger.debug(
        `[SymbolLoader] Hybrid registry ready: ${result.registry.size} binding(s), `
        + `${result.diagnostics.llmCalls} LLM call(s), status=${result.status}`
    );
    return result.registry;
}
