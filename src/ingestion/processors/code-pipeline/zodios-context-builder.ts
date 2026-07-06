import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import {
    extractZodiosAliases,
    hasZodiosDefinition,
    type ZodiosAliasMap,
} from '../../extractors/zodios-extractor.js';
import type { AnalysisTask } from './types.js';
import type { FileImportMap } from '../../core/import-graph.js';
import { escapeRegex, resolveImportSourceForFile, type BasenameSuffixIndex } from './static-analyzer-context.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Zodios Context Builder
//
// Phase 2 of the Zodios detection pipeline:
//   1. Collects all Zodios alias maps from parsed files (one-time scan)
//   2. For each AnalysisTask, traces the constructor type imports back to
//      their source Zodios definition file (Type-Based Tracing)
//   3. Scans the chunk source code for actually-used aliases (JIT filter)
//   4. Injects only the used aliases as File Constants into the LLM prompt
//
// Design:
//   - Type-Based Tracing instead of DI Token Resolution:
//     We follow `import { IAcmeShopRepository } from '...'` rather than
//     trying to resolve NestJS @Inject(Symbol) tokens. This is robust
//     against string tokens, inline providers, and class-based injection.
//
//   - JIT Injection instead of full map dump:
//     A Zodios file like AcmeApiClient has 30+ endpoints. Dumping all aliases
//     into every consumer's prompt wastes tokens. We regex-scan the chunk
//     source for `.aliasName(` patterns and inject only matched aliases.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Zodios alias index: maps file paths to their extracted alias maps.
 * Built once per discovery pass, then queried per analysis task.
 */
export type ZodiosIndex = Map<string, ZodiosAliasMap>;

/**
 * Maps a type/interface name → file path containing the Zodios definition.
 * Built by following type re-exports (e.g. IAcmeShopRepository → typeof api).
 */
export type ZodiosTypeIndex = Map<string, string>;

// ─── Phase 2a: Build Index ───────────────────────────────────────────────────

/**
 * Build the Zodios alias index from all parsed source files.
 *
 * Scans every file for `makeApi` usage and extracts the alias map.
 * Also builds a type index: typeName → zodiosFilePath, by following
 * `export type IFoo = typeof api` patterns in adjacent files.
 *
 * @param parsedFiles Array of { relativePath, fileContent } from the parse pass
 * @returns The ZodiosIndex (filePath → aliasMap)
 */
export function collectZodiosAliasMaps(
    parsedFiles: Array<{ relativePath: string; fileContent: string }>,
    fileImportMaps: FileImportMap[],
    allFilePaths: Set<string>,
    basenameIndex?: BasenameSuffixIndex,
): { zodiosIndex: ZodiosIndex; zodiosTypeIndex: ZodiosTypeIndex } {
    const zodiosIndex: ZodiosIndex = new Map();
    const zodiosTypeIndex: ZodiosTypeIndex = new Map();

    // Pass 1: Extract alias maps from Zodios definition files
    for (const { relativePath, fileContent } of parsedFiles) {
        if (!fileContent || !hasZodiosDefinition(fileContent)) continue;

        const aliasMap = extractZodiosAliases(fileContent, relativePath);
        if (aliasMap.size === 0) continue;

        zodiosIndex.set(relativePath, aliasMap);
    }

    if (zodiosIndex.size === 0) return { zodiosIndex, zodiosTypeIndex };

    // Pass 2: Build type index by scanning for `export type IFoo = typeof xxx`
    // and following imports to Zodios definition files.
    //
    // Pattern A (direct): In the same file as makeApi
    //   export const api = new Zodios(endpoints) → typeName "api"
    //
    // Pattern B (re-export): In a separate interface file
    //   import type { api } from './AcmeShop.repository'
    //   export type IAcmeShopRepository = typeof api
    //
    // For Pattern B, we resolve the import source to find the Zodios file.
    for (const { relativePath, fileContent } of parsedFiles) {
        if (!fileContent) continue;

        // ── Pattern A/B: `export type TypeName = typeof importedSymbol`
        // Direct alias (same file or cross-file re-export)
        const typeOfMatches = [...fileContent.matchAll(
            /export\s+type\s+(\w+)\s*=\s*typeof\s+(\w+)/g,
        )];

        // ── Pattern C: `export type TypeName = Pick<typeof importedSymbol, ...>`
        //              `export type TypeName = Omit<typeof importedSymbol, ...>`
        // Common pattern when a consuming service exposes only a subset of
        // the Zodios client's methods (e.g. IPlacesApiRepository = Pick<typeof api, ...>).
        const mappedTypeMatches = [...fileContent.matchAll(
            /export\s+type\s+(\w+)\s*=\s*(?:Pick|Omit)\s*<\s*typeof\s+(\w+)\s*,/g,
        )];

        const allTypeMatches = [...typeOfMatches, ...mappedTypeMatches];

        for (const match of allTypeMatches) {
            const typeName = match[1];     // e.g. "IAcmeShopRepository"
            const sourceSymbol = match[2]; // e.g. "api"

            // Check if this file IS a Zodios file (Pattern A)
            if (zodiosIndex.has(relativePath)) {
                zodiosTypeIndex.set(typeName, relativePath);
                continue;
            }

            // Follow the import of `sourceSymbol` to find the Zodios file (Pattern B/C)
            const importMap = fileImportMaps.find(m => m.filePath === relativePath);
            if (!importMap) continue;

            for (const imp of importMap.imports) {
                if (imp.isExternal) continue;
                if (!imp.specifiers.includes(sourceSymbol)) continue;

                const resolvedFile = resolveImportSourceForFile(imp.source, relativePath, allFilePaths, basenameIndex);
                if (resolvedFile && zodiosIndex.has(resolvedFile)) {
                    zodiosTypeIndex.set(typeName, resolvedFile);
                    logger.debug(
                        `[ZodiosContext] Type ${typeName} (${relativePath}) → Zodios file ${resolvedFile}`,
                    );
                }
            }
        }

        // Also index the class/interface name if it directly imports and re-exports
        // the Zodios client. E.g.:
        //   import { createApiClient } from './AcmeShop.repository'
        // → The file that imports createApiClient is a provider; the TYPE on the
        //   consuming side is what we need.
    }

    // Pass 3: Index concrete class names from Zodios files
    // e.g. `export const api = new Zodios(...)` → register "api" as pointing to this file
    for (const [filePath] of zodiosIndex) {
        const fileContent = parsedFiles.find(f => f.relativePath === filePath)?.fileContent;
        if (!fileContent) continue;

        const constMatch = fileContent.match(/export\s+const\s+(\w+)\s*=\s*new\s+Zodios\b/);
        if (constMatch) {
            zodiosTypeIndex.set(constMatch[1], filePath);
        }
    }

    if (zodiosIndex.size > 0) {
        logger.debug(
            `[ZodiosContext] Index built: ${zodiosIndex.size} Zodios file(s), ${zodiosTypeIndex.size} type mapping(s)`,
        );
    }

    return { zodiosIndex, zodiosTypeIndex };
}

// ─── Phase 2b: Structured Call Resolution ────────────────────────────────────

/**
 * A Zodios API call resolved deterministically from the AST.
 * This is passed to semantic-extractor for post-LLM injection into
 * emergent_api_calls — entirely bypassing the LLM for this data.
 */
export interface ZodiosResolvedCall {
    /** The alias method name (e.g. 'execCompanyQuote') */
    alias: string;
    /** Uppercase HTTP method (e.g. 'POST') */
    method: string;
    /** API path (e.g. '/api/shop/checkout/companyQuote') */
    path: string;
    /** The TypeScript type that exposes this alias (e.g. 'IAcmeShopRepository') */
    sourceType: string;
}

/**
 * Pre-gate check: does this chunk actually call any Zodios endpoint method?
 *
 * Reuses the same receiver-resolution logic as {@link resolveZodiosCallsForTask}
 * but returns a boolean and skips constructing full ZodiosResolvedCall objects.
 * Called from Gate 7 to avoid sending functions that import a Zodios type but
 * never invoke an endpoint method (86% waste rate without this check).
 *
 * Only alias-based endpoint calls match. Factory/setup calls (setBaseUrl,
 * interceptor registration) are NOT in the Zodios alias map and won't match.
 */
export function hasZodiosCallsInChunk(
    chunkSource: string,
    constructorSource: string,
    fileImportMap: FileImportMap,
    allFilePaths: Set<string>,
    zodiosIndex: ZodiosIndex,
    zodiosTypeIndex: ZodiosTypeIndex,
    basenameIndex?: BasenameSuffixIndex,
): boolean {
    if (zodiosIndex.size === 0) return false;

    const reachableAliasMaps: ZodiosAliasMap[] = [];
    for (const imp of fileImportMap.imports) {
        if (imp.isExternal) continue;
        for (const specifier of imp.specifiers) {
            const zodiosFile = zodiosTypeIndex.get(specifier);
            if (zodiosFile) {
                const aliasMap = zodiosIndex.get(zodiosFile);
                if (aliasMap) reachableAliasMaps.push(aliasMap);
                continue;
            }
            const resolvedFile = resolveImportSourceForFile(imp.source, fileImportMap.filePath, allFilePaths, basenameIndex);
            if (resolvedFile && zodiosIndex.has(resolvedFile)) {
                reachableAliasMaps.push(zodiosIndex.get(resolvedFile)!);
            }
        }
    }

    if (reachableAliasMaps.length === 0) return false;

    const combinedSource = `${chunkSource}\n${constructorSource}`;
    for (const aliasMap of reachableAliasMaps) {
        for (const [alias] of aliasMap) {
            const aliasRegex = new RegExp(
                `(?:\\.|\\[['"])${escapeRegex(alias)}(?:\\(|['"]\\])`,
            );
            if (aliasRegex.test(combinedSource)) return true;
        }
    }
    return false;
}

/**
 * Resolve Zodios API calls for a single analysis task.
 *
 * Strategy:
 *   1. Look at the task's constructor imports to find type references
 *      that map to a Zodios definition file.
 *   2. Scan the chunk source code for `.aliasName(` patterns to find
 *      which aliases are actually called (JIT filter).
 *   3. Return structured ZodiosResolvedCall[] for post-LLM injection.
 *
 * @returns Array of resolved calls, empty if no Zodios calls found.
 */
export function resolveZodiosCallsForTask(
    analysisTask: AnalysisTask,
    fileImportMap: FileImportMap | undefined,
    allFilePaths: Set<string>,
    zodiosIndex: ZodiosIndex,
    zodiosTypeIndex: ZodiosTypeIndex,
    basenameIndex?: BasenameSuffixIndex,
): ZodiosResolvedCall[] {
    if (zodiosIndex.size === 0) return [];
    if (!fileImportMap) return [];

    const chunkSource = analysisTask.chunk.sourceCode;
    const constructorSource = analysisTask.constructorSource ?? '';

    // Step 1: Find which Zodios alias maps are reachable from this file.
    // Strategy: scan the file's imports for types that are in the zodiosTypeIndex.
    const reachableAliasMaps: Array<{ typeName: string; aliasMap: ZodiosAliasMap }> = [];

    for (const imp of fileImportMap.imports) {
        if (imp.isExternal) continue;

        for (const specifier of imp.specifiers) {
            // Direct type match: import { IAcmeShopRepository } from '...'
            const zodiosFile = zodiosTypeIndex.get(specifier);
            if (zodiosFile) {
                const aliasMap = zodiosIndex.get(zodiosFile);
                if (aliasMap) {
                    reachableAliasMaps.push({ typeName: specifier, aliasMap });
                }
                continue;
            }

            // Follow import to source file — maybe it IS the Zodios file
            const resolvedFile = resolveImportSourceForFile(imp.source, fileImportMap.filePath, allFilePaths, basenameIndex);
            if (resolvedFile && zodiosIndex.has(resolvedFile)) {
                const aliasMap = zodiosIndex.get(resolvedFile)!;
                reachableAliasMaps.push({ typeName: specifier, aliasMap });
            }
        }
    }

    if (reachableAliasMaps.length === 0) return [];

    // Step 2: JIT filter — only resolve aliases that are actually called.
    // Scan for `.aliasName(` in the chunk source AND constructor source.
    const combinedSource = `${chunkSource}\n${constructorSource}`;
    const resolvedCalls: ZodiosResolvedCall[] = [];

    for (const { typeName, aliasMap } of reachableAliasMaps) {
        for (const [alias, { method, path }] of aliasMap) {
            // Check if the alias is referenced in the source code
            // Patterns: .execQuote(, .execQuote , ['execQuote']
            const aliasRegex = new RegExp(
                `(?:\\.|\\[['"])${escapeRegex(alias)}(?:\\(|['"]\\])`,
            );
            if (aliasRegex.test(combinedSource)) {
                resolvedCalls.push({
                    alias,
                    method: method.toUpperCase(),
                    path,
                    sourceType: typeName,
                });
            }
        }
    }

    if (resolvedCalls.length > 0) {
        logger.debug(
            `[ZodiosContext] ${analysisTask.fileContext.relativePath}:${analysisTask.chunk.name}: ` +
            `${resolvedCalls.length} Zodios call(s) resolved deterministically → ` +
            resolvedCalls.map(c => `${c.alias}→${c.method} ${c.path}`).join(', '),
        );
    }

    return resolvedCalls;
}
