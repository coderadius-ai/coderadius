/**
 * ConfigSymbol Mutations — Persistent Symbol Table for Targeted Cache Invalidation
 *
 * Manages `:ConfigSymbol` nodes and `(:SourceFile)-[:DEPENDS_ON_SYMBOL]->(:ConfigSymbol)`
 * edges. Used to track which source files depend on which DI registry symbols,
 * enabling surgical Merkle cache invalidation when config files change.
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';
import { astGrounding } from '../grounding.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SymbolExtractionFileStatus = 'success' | 'partial' | 'failed' | 'deleted';

export interface CachedRawSymbolBinding {
    diKey: string;
    /** Canonical physical name (table/topic/url). Empty string = class-only binding. */
    physicalName: string;
    category?: string;
    technology?: string;
    /** FQCN of the concrete component the DI key resolves to. */
    boundComponent?: string;
    /** JSON-serialized DiIoTag[] for the bound component. */
    ioTagsJson?: string;
    /** SHA256 fingerprint over (sourceFile + sourceHash + viaFiles + ioTags) — drives transitive cache invalidation. */
    bindingFingerprint?: string;
    /** Files traversed during DFS multi-hop propagation (canonical order). */
    viaFiles?: string[];
}

export interface SymbolSourceFileCache {
    path: string;
    contentHash: string;
    extractorVersion: string;
    status: SymbolExtractionFileStatus;
    rawBindings: CachedRawSymbolBinding[];
    error?: string;
    targetKind?: string;
}

export interface SymbolExtractionCacheState {
    version: string;
    candidateInventoryHash: string | null;
    targetPlanHash: string | null;
    envHash?: string | null;
    status?: 'healthy' | 'partial';
    sources: Record<string, SymbolSourceFileCache>;
}

export interface ConfigSymbolMetadata {
    rawValue?: string;
    resolvedValue?: string;
    sourceFile?: string;
    sourceHash?: string;
    technology?: string;
    confidence?: string;
    extractorVersion?: string;
    lastResolvedAt?: number;
    /**
     * Explicit physical-name marker. Empty string indicates
     * a class-only binding (serviceId → FQCN with no canonical resource
     * name). The sanitizer guard in `SymbolRegistry.resolve()` drops
     * bindings with empty `physicalName`.
     */
    physicalName?: string;
    boundComponent?: string;
    /** JSON-serialized DiIoTag[]; empty string when no ioTags. */
    ioTagsJson?: string;
    bindingFingerprint?: string;
    viaFiles?: string[];
}

// ─── Write Operations (Post-Ingestion) ──────────────────────────────────────

/**
 * Backfill optional Enterprise Symbol columns on existing POC nodes.
 * Idempotent and cheap; avoids runtime crashes when Zod/domain consumers read
 * old ConfigSymbol nodes that predate rawValue/resolvedValue/source metadata.
 */
export async function backfillConfigSymbolDefaults(repoName?: string): Promise<void> {
    // POC: no migration of new fields (physicalName, boundComponent,
    // bindingFingerprint, viaFiles, ioTagsJson). The cache version bump
    // (SYMBOL_EXTRACTION_CACHE_VERSION='symbol-cache-v4') forces a full
    // rebuild of ConfigSymbol nodes on the first run after upgrade, so we
    // never need to backfill these fields against legacy rows.
    const where = repoName ? 'WHERE cs.repoName = $repoName' : '';
    await run(
        `MATCH (cs:ConfigSymbol)
         ${where}
         SET cs.rawValue = coalesce(cs.rawValue, cs.value, ''),
             cs.resolvedValue = coalesce(cs.resolvedValue, cs.value, cs.rawValue, ''),
             cs.value = coalesce(cs.value, cs.resolvedValue, cs.rawValue, ''),
             cs.category = coalesce(cs.category, 'di_service'),
             cs.sourceFile = coalesce(cs.sourceFile, 'legacy'),
             cs.sourceHash = coalesce(cs.sourceHash, ''),
             cs.technology = coalesce(cs.technology, ''),
             cs.confidence = coalesce(cs.confidence, 'static'),
             cs.extractorVersion = coalesce(cs.extractorVersion, 'legacy'),
             cs.lastResolvedAt = coalesce(cs.lastResolvedAt, 0)`,
        { repoName },
    );
}

/**
 * Upsert a ConfigSymbol node. Called post-ingestion after the usages map is populated.
 */
export async function mergeConfigSymbol(
    key: string,
    value: string,
    category: string,
    repoName: string,
    commitHash: string,
    metadata: ConfigSymbolMetadata = {},
): Promise<void> {
    const id = buildUrn('configsymbol', repoName, key);
    const rawValue = metadata.rawValue ?? value;
    const resolvedValue = metadata.resolvedValue ?? value;
    const sourceFile = metadata.sourceFile ?? 'unknown';
    const sourceHash = metadata.sourceHash ?? '';
    const technology = metadata.technology ?? '';
    const extractorVersion = metadata.extractorVersion ?? 'legacy';
    const lastResolvedAt = metadata.lastResolvedAt ?? Date.now();
    const physicalName = metadata.physicalName ?? '';
    const boundComponent = metadata.boundComponent ?? '';
    const ioTagsJson = metadata.ioTagsJson ?? '';
    const bindingFingerprint = metadata.bindingFingerprint ?? '';
    const viaFiles = metadata.viaFiles ?? [];
    // ConfigSymbol comes from deterministic config-symbol extractors (DI containers,
    // Symfony services.yaml, etc.). Grounding: ast/exact.
    const prov = astGrounding(`config-symbol-${metadata.confidence ?? 'static'}@v1`);
    await run(
        `MERGE (cs:ConfigSymbol {id: $id})
         ON CREATE SET cs.key = $key, cs.value = $resolvedValue, cs.rawValue = $rawValue,
                       cs.resolvedValue = $resolvedValue, cs.category = $category,
                       cs.sourceFile = $sourceFile, cs.sourceHash = $sourceHash,
                       cs.technology = $technology,
                       cs.extractorVersion = $extractorVersion, cs.lastResolvedAt = $lastResolvedAt,
                       cs.physicalName = $physicalName, cs.boundComponent = $boundComponent,
                       cs.ioTagsJson = $ioTagsJson, cs.bindingFingerprint = $bindingFingerprint,
                       cs.viaFiles = $viaFiles,
                       cs.repoName = $repoName, cs.valid_from_commit = $commitHash,
                       cs.valid_to_commit = null, cs.createdAt = timestamp()
         ON MATCH SET cs.value = $resolvedValue, cs.rawValue = $rawValue,
                      cs.resolvedValue = $resolvedValue, cs.category = $category,
                      cs.sourceFile = $sourceFile, cs.sourceHash = $sourceHash,
                      cs.technology = $technology,
                      cs.extractorVersion = $extractorVersion, cs.lastResolvedAt = $lastResolvedAt,
                      cs.physicalName = $physicalName, cs.boundComponent = $boundComponent,
                      cs.ioTagsJson = $ioTagsJson, cs.bindingFingerprint = $bindingFingerprint,
                      cs.viaFiles = $viaFiles,
                      cs.valid_from_commit = coalesce(cs.valid_from_commit, $commitHash),
                      cs.valid_to_commit = null
         ${groundingWriteClause('cs')}`,
        {
            id, key, value, rawValue, resolvedValue, category, repoName, commitHash,
            sourceFile, sourceHash, technology, extractorVersion, lastResolvedAt,
            physicalName, boundComponent, ioTagsJson, bindingFingerprint, viaFiles,
            ...groundingParams(prov, commitHash),
        },
    );
}

/**
 * Link a SourceFile to a ConfigSymbol via DEPENDS_ON_SYMBOL.
 * Uses existing SourceFile nodes (created by the Merkle module).
 */
export async function linkFileToSymbol(
    sourceFilePath: string,
    symbolKey: string,
    repoName: string,
    commitHash: string,
): Promise<void> {
    const symbolId = buildUrn('configsymbol', repoName, symbolKey);
    const fileId = buildUrn('sourcefile', repoName, sourceFilePath);
    await run(
        `MATCH (cs:ConfigSymbol {id: $symbolId})
         MATCH (sf:SourceFile {id: $fileId})
         MERGE (sf)-[rel:DEPENDS_ON_SYMBOL]->(cs)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
         ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { symbolId, fileId, commitHash },
    );
}

// ─── Read Operations (Pre-Flight) ───────────────────────────────────────────

export interface StoredConfigSymbol {
    key: string;
    value: string;
    category: string;
    rawValue?: string;
    resolvedValue?: string;
    sourceFile?: string;
    sourceHash?: string;
    technology?: string;
    confidence?: string;
    extractorVersion?: string;
    physicalName?: string;
    boundComponent?: string;
    ioTagsJson?: string;
    bindingFingerprint?: string;
    viaFiles?: string[];
}

/**
 * Load all active ConfigSymbol nodes for a given repo.
 * Used in pre-flight diff to detect registry changes.
 */
export async function loadConfigSymbols(repoName: string): Promise<StoredConfigSymbol[]> {
    await backfillConfigSymbolDefaults(repoName);
    const result = await run(
        `MATCH (cs:ConfigSymbol {repoName: $repoName})
         WHERE cs.valid_to_commit IS NULL
         RETURN cs.key AS key,
                coalesce(cs.resolvedValue, cs.value, cs.rawValue, '') AS value,
                coalesce(cs.rawValue, cs.value, '') AS rawValue,
                coalesce(cs.resolvedValue, cs.value, cs.rawValue, '') AS resolvedValue,
                coalesce(cs.category, 'di_service') AS category,
                coalesce(cs.sourceFile, 'legacy') AS sourceFile,
                coalesce(cs.sourceHash, '') AS sourceHash,
                coalesce(cs.technology, '') AS technology,
                coalesce(cs.confidence, 'static') AS confidence,
                coalesce(cs.extractorVersion, 'legacy') AS extractorVersion,
                coalesce(cs.physicalName, '') AS physicalName,
                coalesce(cs.boundComponent, '') AS boundComponent,
                coalesce(cs.ioTagsJson, '') AS ioTagsJson,
                coalesce(cs.bindingFingerprint, '') AS bindingFingerprint,
                coalesce(cs.viaFiles, []) AS viaFiles`,
        { repoName },
    );
    return result!.records.map(r => ({
        key: r.get('key') as string,
        value: r.get('value') as string,
        rawValue: r.get('rawValue') as string,
        resolvedValue: r.get('resolvedValue') as string,
        category: r.get('category') as string,
        sourceFile: r.get('sourceFile') as string,
        sourceHash: r.get('sourceHash') as string,
        technology: r.get('technology') as string,
        confidence: r.get('confidence') as string,
        extractorVersion: r.get('extractorVersion') as string,
        physicalName: r.get('physicalName') as string,
        boundComponent: r.get('boundComponent') as string,
        ioTagsJson: r.get('ioTagsJson') as string,
        bindingFingerprint: r.get('bindingFingerprint') as string,
        viaFiles: r.get('viaFiles') as string[],
    }));
}

/**
 * Load all source file paths that depend on a specific symbol key.
 * Used in pre-flight to compute taintedFiles set.
 */
export async function loadSymbolDependents(symbolKey: string, repoName: string): Promise<string[]> {
    const symbolId = buildUrn('configsymbol', repoName, symbolKey);
    const result = await run(
        `MATCH (sf:SourceFile)-[rel:DEPENDS_ON_SYMBOL]->(cs:ConfigSymbol {id: $symbolId})
         WHERE sf.valid_to_commit IS NULL AND rel.valid_to_commit IS NULL
         RETURN sf.path AS path`,
        { symbolId },
    );
    return result!.records.map(r => r.get('path') as string);
}

/**
 * Bulk load source files depending on any of the provided symbol keys.
 */
export async function loadSymbolDependentsBatch(symbolKeys: string[], repoName: string): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (symbolKeys.length === 0) return out;
    const rows = symbolKeys.map(key => ({ key, id: buildUrn('configsymbol', repoName, key) }));
    const result = await run(
        `UNWIND $rows AS row
         MATCH (sf:SourceFile)-[rel:DEPENDS_ON_SYMBOL]->(cs:ConfigSymbol {id: row.id})
         WHERE sf.valid_to_commit IS NULL AND rel.valid_to_commit IS NULL
         RETURN row.key AS key, collect(DISTINCT sf.path) AS paths`,
        { rows },
    );
    for (const record of result!.records) {
        out.set(record.get('key') as string, record.get('paths') as string[]);
    }
    return out;
}

/**
 * Soft-delete all ConfigSymbol nodes and their edges for a repo.
 * Called before persisting new symbols.
 */
export async function softDeleteConfigSymbols(repoName: string, commitHash: string): Promise<void> {
    await run(
        `MATCH (cs:ConfigSymbol {repoName: $repoName})
         WHERE cs.valid_to_commit IS NULL
         SET cs.valid_to_commit = $commitHash`,
        { repoName, commitHash },
    );
    await run(
        `MATCH (:SourceFile)-[rel:DEPENDS_ON_SYMBOL]->(cs:ConfigSymbol {repoName: $repoName})
         WHERE rel.valid_to_commit IS NULL
         SET rel.valid_to_commit = $commitHash`,
        { repoName, commitHash },
    );
}

/**
 * Soft-delete a SINGLE ConfigSymbol and its DEPENDS_ON_SYMBOL edges.
 * Used when a specific DI key is removed from the config file.
 * Does NOT touch other symbols or their edges (prevents phantom edge drop).
 */
export async function softDeleteSingleSymbol(symbolKey: string, repoName: string, commitHash: string): Promise<void> {
    const symbolId = buildUrn('configsymbol', repoName, symbolKey);
    await run(
        `MATCH (cs:ConfigSymbol {id: $symbolId})
         WHERE cs.valid_to_commit IS NULL
         SET cs.valid_to_commit = $commitHash`,
        { symbolId, commitHash },
    );
    await run(
        `MATCH (:SourceFile)-[rel:DEPENDS_ON_SYMBOL]->(cs:ConfigSymbol {id: $symbolId})
         WHERE rel.valid_to_commit IS NULL
         SET rel.valid_to_commit = $commitHash`,
        { symbolId, commitHash },
    );
}

/**
 * Soft-delete ConfigSymbol nodes and their dependency edges in bulk.
 */
export async function softDeleteSymbols(symbolKeys: string[], repoName: string, commitHash: string): Promise<void> {
    if (symbolKeys.length === 0) return;
    const ids = symbolKeys.map(key => buildUrn('configsymbol', repoName, key));
    await run(
        `MATCH (cs:ConfigSymbol)
         WHERE cs.id IN $ids AND cs.valid_to_commit IS NULL
         SET cs.valid_to_commit = $commitHash`,
        { ids, commitHash },
    );
    await run(
        `MATCH (:SourceFile)-[rel:DEPENDS_ON_SYMBOL]->(cs:ConfigSymbol)
         WHERE cs.id IN $ids AND rel.valid_to_commit IS NULL
         SET rel.valid_to_commit = $commitHash`,
        { ids, commitHash },
    );
}

/**
 * Save/update the registryHash and scouted config file paths on a Repository node.
 */
export async function saveRegistryHash(qualifiedRepoName: string, registryHash: string, scoutedPaths?: string[]): Promise<void> {
    const rUrn = buildUrn('repository', qualifiedRepoName);
    await run(
        `MATCH (r:Repository {id: $rUrn})
         WHERE r.valid_to_commit IS NULL
         SET r.registryHash = $registryHash, r.scoutedConfigPaths = $scoutedPaths`,
        { rUrn, registryHash, scoutedPaths: scoutedPaths ? JSON.stringify(scoutedPaths) : null },
    );
}

export interface RegistryCache {
    registryHash: string | null;
    scoutedPaths: string[];
    symbolCacheState?: SymbolExtractionCacheState | null;
}

/**
 * Load the cached registryHash and scouted paths from a Repository node.
 */
export async function loadRegistryCache(qualifiedRepoName: string): Promise<RegistryCache> {
    const rUrn = buildUrn('repository', qualifiedRepoName);
    const result = await run(
        `MATCH (r:Repository {id: $rUrn})
         WHERE r.valid_to_commit IS NULL
         RETURN r.registryHash AS registryHash,
                r.scoutedConfigPaths AS scoutedConfigPaths,
                r.symbolCacheState AS symbolCacheState`,
        { rUrn },
    );
    if (!result || result.records.length === 0) return { registryHash: null, scoutedPaths: [] };
    const hash = (result.records[0].get('registryHash') as string) ?? null;
    const pathsJson = result.records[0].get('scoutedConfigPaths') as string | null;
    const symbolCacheJson = result.records[0].get('symbolCacheState') as string | null;
    let paths: string[] = [];
    if (pathsJson) {
        try { paths = JSON.parse(pathsJson); } catch { /* ignore */ }
    }
    let symbolCacheState: SymbolExtractionCacheState | null = null;
    if (symbolCacheJson) {
        try { symbolCacheState = JSON.parse(symbolCacheJson) as SymbolExtractionCacheState; } catch { /* ignore */ }
    }
    return { registryHash: hash, scoutedPaths: paths, symbolCacheState };
}

/**
 * Save/update Enterprise Symbol Extraction cache state on a Repository node.
 */
export async function saveSymbolExtractionCacheState(
    qualifiedRepoName: string,
    state: SymbolExtractionCacheState,
): Promise<void> {
    const rUrn = buildUrn('repository', qualifiedRepoName);
    await run(
        `MATCH (r:Repository {id: $rUrn})
         WHERE r.valid_to_commit IS NULL
         SET r.symbolCacheState = $state,
             r.registryHash = null,
             r.scoutedConfigPaths = $scoutedPaths`,
        {
            rUrn,
            state: JSON.stringify(state),
            scoutedPaths: JSON.stringify(Object.keys(state.sources).sort()),
        },
    );
}
