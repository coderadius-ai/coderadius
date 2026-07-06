/**
 * Entity Table Registry — Cross-File ORM Resolution
 *
 * Collects FQCN→TableName mappings from statically resolved ORM entity chunks
 * and provides three-tier fuzzy matching to inject resolved table names into
 * LLM prompts for repository/service files.
 *
 * This module is language-agnostic: any language plugin that implements
 * `extractStaticInfra()` with `operation: 'MAPS_TO'` feeds into the same registry.
 *
 * ─── Three-Tier Matching Strategy ─────────────────────────────────────────
 *
 * Tier 1 — Exact FQCN import:
 *   `use Acme\Entity\Record;` → matches registry key `Acme\Entity\Record`
 *
 * Tier 2 — Namespace prefix import:
 *   `use Acme\Entity;` → matches all entries under `Acme\Entity\*`
 *   if the short class name appears in the source code
 *
 * Tier 3 — Same-namespace implicit:
 *   File has `namespace Acme\Entity;` — all entries in `Acme\Entity`
 *   are available if the short class name appears in source code
 */

import type { StaticAnalysisResult } from './types.js';
import type { FileImportMap, ImportRef } from '../../core/import-graph.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EntityTableEntry {
    /** Fully Qualified Class Name (e.g. "Acme\\Entity\\Record") */
    fqcn: string;
    /** Resolved table name (e.g. "records") */
    tableName: string;
    /** Short class name (e.g. "Record") — last segment of FQCN */
    shortName: string;
    /** Namespace (e.g. "Acme\\Entity") — all but last segment of FQCN */
    namespace: string;
    /** Relative source path of the metadata declaration (e.g. src/entities/Save.entity.ts) */
    sourcePath?: string;
    /** Source module basename without extension (e.g. Save.entity) */
    moduleBasename?: string;
    /** Source module stem without common ORM suffixes (e.g. Save) */
    moduleStem?: string;
}

export type EntityTableRegistry = EntityTableEntry[];

// ─── Collection ──────────────────────────────────────────────────────────────

/**
 * Build the entity table registry from static analysis results.
 *
 * Scans all analysis results for tasks that:
 *   1. Are resolved statically (`isResolvedStatically === true`)
 *   2. Have infrastructure entries with `operation === 'MAPS_TO'`
 *   3. Have chunk names ending in `::__class_metadata`
 *
 * Derives the FQCN from the chunk name by stripping the `::__class_metadata` suffix.
 */
export function collectEntityTableRegistry(
    analysisResults: StaticAnalysisResult[],
): EntityTableRegistry {
    const registry: EntityTableRegistry = [];

    for (const result of analysisResults) {
        for (const task of result.analysisTasks) {
            if (!task.isResolvedStatically) continue;
            if (!task.staticAnalysis?.infrastructure) continue;

            for (const infra of task.staticAnalysis.infrastructure) {
                if (infra.operation !== 'MAPS_TO' || infra.type !== 'Database') continue;

                const metaSuffix = '::__class_metadata';
                if (!task.chunk.name.endsWith(metaSuffix)) continue;

                const fqcn = task.chunk.name.slice(0, -metaSuffix.length);
                const segments = fqcn.split('\\');
                const shortName = segments[segments.length - 1];
                const namespace = segments.length > 1 ? segments.slice(0, -1).join('\\') : '';

                registry.push({
                    fqcn,
                    tableName: infra.name,
                    shortName,
                    namespace,
                    sourcePath: task.chunk.filepath,
                    moduleBasename: stripExtension(task.chunk.filepath.split('/').pop() ?? ''),
                    moduleStem: deriveModuleStem(task.chunk.filepath),
                });
            }
        }
    }

    return registry;
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Match a non-static analysis task against the entity registry.
 *
 * Uses three-tier matching (most precise → least precise):
 *   Tier 1: Exact FQCN import match (via structured ImportRef or raw import strings)
 *   Tier 2: Namespace prefix import (entity FQCN starts with imported namespace)
 *   Tier 3: Same-namespace implicit (file namespace === entity namespace)
 *
 * Only injects entries where the entity's shortName appears as a word boundary
 * in the task's source code (`\bRecord\b`), preventing false positives.
 *
 * Returns a formatted context string for the LLM prompt, or null if no matches.
 */
export function buildEntityTableContext(
    task: import('./types.js').AnalysisTask,
    registry: EntityTableRegistry,
    fileImportMap?: FileImportMap,
    fileNamespace?: string,
): string | null {
    if (registry.length === 0) return null;

    const sourceCode = task.chunk.sourceCode;
    const matched = new Map<string, EntityTableEntry>(); // fqcn → entry (dedup)

    for (const entry of registry) {
        // Quick bail: if the short class name doesn't appear in the source code
        // (either function body or raw import strings), skip this entity entirely
        const shortNameRegex = new RegExp(`\\b${escapeRegex(entry.shortName)}\\b`);
        const inSource = shortNameRegex.test(sourceCode);
        const inImports = task.imports?.some(imp => shortNameRegex.test(imp)) ?? false;

        if (!inSource && !inImports) continue;

        // ── Tier 1: Exact FQCN import match ──────────────────────────
        if (matchTier1(entry, fileImportMap, task.imports)) {
            matched.set(entry.fqcn, entry);
            continue;
        }

        // ── Tier 2: Namespace prefix import ──────────────────────────
        // Only fire if shortName appears in the FUNCTION source code
        // (not just the import strings — Tier 1 already covered those)
        if (inSource && matchTier2(entry, fileImportMap, task.imports)) {
            matched.set(entry.fqcn, entry);
            continue;
        }

        // ── Tier 3: Same-namespace implicit ──────────────────────────
        if (inSource && fileNamespace && entry.namespace === fileNamespace) {
            matched.set(entry.fqcn, entry);
        }
    }

    if (matched.size === 0) return null;

    return formatContext([...matched.values()]);
}

// ─── Tier 1: Exact FQCN match ───────────────────────────────────────────────

function matchTier1(
    entry: EntityTableEntry,
    fileImportMap?: FileImportMap,
    rawImports?: string[],
): boolean {
    // Check structured ImportRef data
    if (fileImportMap) {
        for (const imp of fileImportMap.imports) {
            // source === FQCN (PHP namespace imports resolve to FQCN when external)
            if (imp.source === entry.fqcn) return true;

            // specifier matches shortName AND source resolves to entity FQCN
            // This catches `use Acme\Entity\Record as Rec;` (source = FQCN, specifier = "Rec")
            if (imp.specifiers.includes(entry.shortName) && isEntitySource(imp.source, entry)) return true;

            // Aliased import: source contains the FQCN, specifier is an alias
            // `use Acme\Entity\Record as Rec;` → source might be resolved path or FQCN
            if (sourceMatchesFQCN(imp.source, entry.fqcn)) return true;
        }
    }

    // Fallback: check raw import strings (e.g. "use Acme\Entity\Record;")
    if (rawImports) {
        for (const raw of rawImports) {
            // PHP: `use Acme\Entity\Record;` or `use Acme\Entity\Record as Rec;`
            if (raw.includes(entry.fqcn)) return true;
            if (entry.moduleBasename && raw.includes(entry.moduleBasename) && raw.includes(entry.shortName)) return true;
            if (entry.moduleStem && raw.includes(entry.moduleStem) && raw.includes(entry.shortName)) return true;
        }
    }

    return false;
}

// ─── Tier 2: Namespace prefix match ──────────────────────────────────────────

function matchTier2(
    entry: EntityTableEntry,
    fileImportMap?: FileImportMap,
    rawImports?: string[],
): boolean {
    if (!entry.namespace) return false;

    // Check structured imports for namespace-level imports
    if (fileImportMap) {
        for (const imp of fileImportMap.imports) {
            // `use Acme\Entity;` → source = "Acme\Entity", specifier = "Entity"
            // Entity FQCN starts with this namespace prefix
            if (entry.fqcn.startsWith(imp.source + '\\')) return true;
        }
    }

    // Fallback: check raw import strings for namespace imports
    if (rawImports) {
        for (const raw of rawImports) {
            // Extract namespace from `use Acme\Entity;`
            const nsMatch = raw.match(/use\s+([\w\\]+);/);
            if (nsMatch) {
                const importedNs = nsMatch[1];
                if (entry.fqcn.startsWith(importedNs + '\\')) return true;
            }
        }
    }

    return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if an import source resolves to the entity's file/FQCN.
 * Handles both FQCN sources and resolved file paths.
 */
function isEntitySource(source: string, entry: EntityTableEntry): boolean {
    // Direct FQCN match
    if (source === entry.fqcn) return true;

    // File path match: source ends with a path that matches the entity's class name
    // e.g. "src/Entity/Record.php" → shortName "Record"
    const basename = source.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
    if (basename === entry.shortName) return true;
    if (entry.moduleBasename && basename === entry.moduleBasename) return true;
    if (entry.moduleStem && basename === entry.moduleStem) return true;

    const normalizedSource = normalizePath(source);
    const normalizedEntryPath = entry.sourcePath ? normalizePath(entry.sourcePath) : '';
    if (normalizedEntryPath) {
        const withoutExtension = stripExtension(normalizedEntryPath);
        if (normalizedSource === withoutExtension || normalizedSource.endsWith(withoutExtension)) return true;
    }

    return false;
}

/**
 * Check if a source string matches or contains the entity FQCN.
 * Handles resolved file paths by checking if the FQCN segments map to the path.
 */
function sourceMatchesFQCN(source: string, fqcn: string): boolean {
    if (source === fqcn) return true;
    // PHP PSR-4: Acme\Entity\Record → src/Entity/Record.php
    // Check if the source path ends with the namespace-derived path
    const fqcnPath = fqcn.replace(/\\/g, '/');
    if (source.endsWith(fqcnPath + '.php') || source.endsWith(fqcnPath)) return true;
    return false;
}

function deriveModuleStem(filePath: string): string {
    const basename = stripExtension(filePath.split('/').pop() ?? '');
    return basename.replace(/\.(entity|model|schema)$/i, '');
}

function stripExtension(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '');
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/');
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Output Formatting ──────────────────────────────────────────────────────

function formatContext(entries: EntityTableEntry[]): string {
    const lines = entries.map(e => `  ${e.shortName} → table "${e.tableName}"`);

    return `
--- Resolved Entity Table Names (ground truth from ORM annotations) ---
The following entity classes are imported and have KNOWN table mappings.
You MUST use these table names — do NOT infer from class name.

${lines.join('\n')}

When you see a Repository, Service, or Handler that uses createQueryBuilder(),
EntityManager, or similar ORM queries on these entities, use the table name shown here.
--- End Entity Table Names ---`;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Resolved Entity Context for Sanitizer
 */
export interface ResolvedEntityContext {
    entityNames: Set<string>;
    tableNames: Set<string>;
}

/**
 * Extract resolved entity class names and table names from the formatted context string.
 * Used by the sanitizer to:
 *   1. Filter phantom DataStructure payloads (entityNames)
 *   2. Bypass hallucination checks for ground-truth database tables (tableNames)
 *
 * Parses lines like `  Record → table "records"` and returns both sets.
 */
export function extractResolvedEntityContext(entityTableContext?: string): ResolvedEntityContext | undefined {
    if (!entityTableContext) return undefined;

    const entityNames = new Set<string>();
    const tableNames = new Set<string>();

    // Match lines like: `  Record → table "records"`
    const regex = /^\s+(\w+)\s+→\s+table\s+"([^"]+)"/gm;
    let match;
    while ((match = regex.exec(entityTableContext)) !== null) {
        entityNames.add(match[1]);
        tableNames.add(match[2]);
    }

    if (entityNames.size === 0 && tableNames.size === 0) return undefined;

    return { entityNames, tableNames };
}
