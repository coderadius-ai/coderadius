import { logger } from '../../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Zodios Alias Extractor
//
// Deterministically extracts endpoint alias→route mappings from Zodios
// `makeApi([...])` definitions. These are auto-generated files produced by
// `openapi-zod-client`, so their structure is extremely consistent:
//
//   const endpoints = makeApi([
//       { method: 'post', path: '/api/shop/quote', alias: 'execQuote', ... },
//       ...
//   ]);
//
// The extractor produces a map:
//   { "execQuote" → { method: "POST", path: "/api/shop/quote" } }
//
// This map is consumed by the Zodios context builder (Phase 2) to inject
// outbound API call metadata into the LLM prompt of consuming services.
//
// Design choice: Regex-based instead of full TypeScript AST.
// The `makeApi()` argument is always a static array literal with no computed
// values. A regex approach is simpler, faster, and sufficient for this
// highly constrained input. If future patterns break regex, swap to ts-morph.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ZodiosEndpointAlias {
    /** HTTP method (uppercase), e.g. "POST", "GET", "PATCH" */
    method: string;
    /** Route path, e.g. "/api/shop/checkout/quote" */
    path: string;
    /** Zodios alias (the method name on the client), e.g. "execQuote" */
    alias: string;
}

/** Per-file map: alias name → endpoint definition */
export type ZodiosAliasMap = Map<string, { method: string; path: string }>;

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Fast check: does this file source contain a Zodios `makeApi` usage?
 * Used as a gate before running the heavier extraction.
 */
export function hasZodiosDefinition(source: string): boolean {
    return source.includes('makeApi') && (
        source.includes('@zodios/core') ||
        source.includes('from \'@zodios/core\'') ||
        source.includes('from "@zodios/core"')
    );
}

/**
 * Fast check: does this file export a `createApiClient` function?
 * This is the factory pattern used across all Zodios clients in acme-platform.
 */
export function hasZodiosClientFactory(source: string): boolean {
    return source.includes('createApiClient') && source.includes('new Zodios');
}

// ─── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract the Zodios `makeApi([...])` block from file source.
 *
 * Strategy: Find the `makeApi([` call, then count bracket nesting to find
 * the matching `])`. This handles nested objects (parameters, schemas)
 * without a full parser.
 */
function extractMakeApiBlock(source: string): string | null {
    const startIdx = source.indexOf('makeApi(');
    if (startIdx === -1) return null;

    // Find the opening bracket of the array literal
    const arrayStart = source.indexOf('[', startIdx);
    if (arrayStart === -1) return null;

    // Walk forward, counting brackets to find the matching close
    let depth = 0;
    let inString: string | null = null;
    let escaped = false;

    for (let i = arrayStart; i < source.length; i++) {
        const char = source[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        // Track string boundaries (single-quote, double-quote, backtick)
        if (inString) {
            if (char === inString) inString = null;
            continue;
        }

        if (char === '\'' || char === '"' || char === '`') {
            inString = char;
            continue;
        }

        if (char === '[' || char === '(') depth++;
        if (char === ']' || char === ')') depth--;

        if (depth === 0) {
            return source.substring(arrayStart, i + 1);
        }
    }

    return null;
}

/**
 * Extract endpoint objects from the makeApi array block.
 *
 * Each endpoint is an object literal with `method`, `path`, and `alias`
 * as string literal properties. We extract these three fields using
 * targeted regexes applied to each top-level object in the array.
 */
function extractEndpointObjects(arrayBlock: string): ZodiosEndpointAlias[] {
    const endpoints: ZodiosEndpointAlias[] = [];

    // Split the array block into individual object blocks.
    // Strategy: find each top-level `{...}` by tracking brace depth.
    const objects: string[] = [];
    let depth = 0;
    let objectStart = -1;
    let inString: string | null = null;
    let escaped = false;

    // Skip the outer `[` and `]`
    for (let i = 1; i < arrayBlock.length - 1; i++) {
        const char = arrayBlock[i];

        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (inString) {
            if (char === inString) inString = null;
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') {
            inString = char;
            continue;
        }

        if (char === '{') {
            if (depth === 0) objectStart = i;
            depth++;
        }
        if (char === '}') {
            depth--;
            if (depth === 0 && objectStart !== -1) {
                objects.push(arrayBlock.substring(objectStart, i + 1));
                objectStart = -1;
            }
        }
    }

    // From each object block, extract method, path, alias
    for (const obj of objects) {
        const method = extractStringProperty(obj, 'method');
        const path = extractStringProperty(obj, 'path');
        const alias = extractStringProperty(obj, 'alias');

        if (method && path && alias) {
            endpoints.push({
                method: method.toUpperCase(),
                path,
                alias,
            });
        }
    }

    return endpoints;
}

/**
 * Extract a string-valued property from an object literal block.
 * Handles both single and double quotes.
 *
 * Pattern: `property: 'value'` or `property: "value"`
 */
function extractStringProperty(objectBlock: string, propertyName: string): string | null {
    // Match:  propertyName: 'value'  or  propertyName: "value"
    // Allow optional whitespace and newlines around the colon.
    const regex = new RegExp(
        `(?:^|[\\s,{])${propertyName}\\s*:\\s*['"]([^'"]+)['"]`,
        'm',
    );
    const match = objectBlock.match(regex);
    return match?.[1] ?? null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract all Zodios endpoint aliases from a TypeScript source file.
 *
 * @param source   Full file content
 * @param filePath Repo-relative path (for logging)
 * @returns Map of alias → { method, path }, or empty map if not a Zodios file.
 */
export function extractZodiosAliases(source: string, filePath: string): ZodiosAliasMap {
    const map: ZodiosAliasMap = new Map();

    if (!hasZodiosDefinition(source)) return map;

    const block = extractMakeApiBlock(source);
    if (!block) {
        logger.debug(`[ZodiosExtractor] makeApi found but block extraction failed in ${filePath}`);
        return map;
    }

    const endpoints = extractEndpointObjects(block);
    for (const ep of endpoints) {
        map.set(ep.alias, { method: ep.method, path: ep.path });
    }

    if (map.size > 0) {
        logger.debug(`[ZodiosExtractor] ${filePath}: ${map.size} alias(es) extracted → ${[...map.keys()].join(', ')}`);
    }

    return map;
}

/**
 * Find which type names are exported from a Zodios definition file.
 *
 * Looks for patterns like:
 *   export type IAcmeShopRepository = typeof api
 *   export const api = new Zodios(...)
 *
 * Returns the exported symbol names that represent the Zodios client type
 * (e.g. "api", "IAcmeShopRepository").
 */
export function extractZodiosExportedTypes(source: string): string[] {
    const types: string[] = [];

    // Match: export const api = new Zodios(...)
    const constMatch = source.match(/export\s+const\s+(\w+)\s*=\s*new\s+Zodios\b/);
    if (constMatch) types.push(constMatch[1]);

    // Match: export type IFoo = typeof api
    const typeMatches = [...source.matchAll(/export\s+type\s+(\w+)\s*=\s*typeof\s+(\w+)/g)];
    for (const match of typeMatches) {
        types.push(match[1]); // The type alias name (e.g. IAcmeShopRepository)
    }

    return types;
}
