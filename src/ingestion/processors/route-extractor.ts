import type Parser from 'tree-sitter';

// ─── Route Extractor ──────────────────────────────────────────────────────────
//
// Pure, framework-agnostic module for file-based HTTP route detection.
//
// Responsibility:
//   1. classifyRouteFile()        — classify a file path as a route file,
//                                   deriving the HTTP path from filesystem conventions.
//   2. extractHttpMethodsFromAST() — extract exact HTTP methods from AST exports
//                                    in a Next.js App Router route.ts file.
//
// NO side effects. NO I/O. NO LLM. NO graph writes. Input → Output only.
//
// Frameworks supported (V1):
//   - Next.js App Router  (app/**/route.ts)
//   - Next.js Pages Router (pages/api/**/*.ts)
//   - SvelteKit           (src/routes/**/*+server.ts)
//   - Nuxt 3              (server/routes/**/*.ts, server/api/**/*.ts)
//
// Explicitly NOT supported in V1 (deferred):
//   - page.tsx / layout.tsx / loading.tsx / error.tsx / not-found.tsx (UI pages)
//   - Remix app/routes/*.tsx (requires TSX parser validation)
//   - middleware.ts (interceptor, not a route)
//   - Express / Fastify / tRPC (programmatic routing, not file-based)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ───────────────────────────────────────────────────────────────────

/** Frameworks that use file-based routing conventions. */
export type RouteFramework =
    | 'nextjs-app-router'
    | 'nextjs-pages-router'
    | 'sveltekit'
    | 'nuxt'
    | 'nextjs-action';

/**
 * Result of classifying a file path as a route file.
 * Returned by classifyRouteFile(). Null means "not a route file, skip".
 */
export interface RouteFileInfo {
    /** True if this file is an API handler file that should produce INBOUND endpoints. */
    isRouteFile: boolean;
    /** True if this is a Server Action file ('use server' at file level). */
    isServerAction: boolean;
    /**
     * The HTTP path derived from the file path.
     * Dynamic segments: [id] → {param}, [...slug] → {param}, [[...slug]] → {param}
     * Route groups: (auth) → stripped
     */
    basePath: string;
    /** Detected framework. */
    framework: RouteFramework;
}

/**
 * Valid HTTP methods accepted by the graph pipeline.
 * NOTE: normalizeHttpMethod() in unified-analyzer.ts only accepts these five.
 * HEAD → normalized to GET. OPTIONS → normalized to POST.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// ─── Constants ────────────────────────────────────────────────────────────────

/** HTTP method names the pipeline accepts directly. */
const DIRECT_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * HTTP method normalization map.
 * Covers HEAD and OPTIONS which are valid in Next.js but are silently dropped
 * by unified-analyzer.ts normalizeHttpMethod() → we normalize before emission.
 */
const HTTP_METHOD_NORMALIZATION: Record<string, HttpMethod> = {
    HEAD: 'GET',      // semantically read-only, closest equivalent
    OPTIONS: 'POST',  // safe fallback
};

/**
 * Next.js App Router special file names that are NOT API handlers.
 * Any file matching these patterns must produce zero INBOUND endpoints.
 */
const NEXTJS_UI_SEGMENTS = new Set([
    'page', 'layout', 'loading', 'error', 'not-found', 'global-error',
    'template', 'default',
]);

// ─── Path Utilities ───────────────────────────────────────────────────────────

/**
 * Normalize a single path segment from filesystem conventions to HTTP conventions.
 *
 * Rules:
 *   [id]          → {param}    (dynamic segment)
 *   [slug]        → {param}    (dynamic segment, any name)
 *   [...slug]     → {param}    (catch-all)
 *   [[...slug]]   → {param}    (optional catch-all)
 *   (auth)        → null       (route group — strip from path)
 *   @modal        → PARALLEL   (parallel route — signals skip)
 *   (.)photo      → INTERCEPT  (intercepting route — signals skip)
 *   index         → null       (index file — strip from path)
 */
function normalizeSegment(
    seg: string,
): string | null | 'PARALLEL' | 'INTERCEPT' {
    // Parallel route segments: @name
    if (seg.startsWith('@')) return 'PARALLEL';

    // Intercepting route segments: (.), (..), (...)
    // These look like (auth) but start with ( followed by . chars
    if (/^\(\.+\)/.test(seg)) return 'INTERCEPT';

    // Route groups: (name) — strip from path
    if (seg.startsWith('(') && seg.endsWith(')')) return null;

    // Optional catch-all: [[...slug]]
    if (seg.startsWith('[[...') && seg.endsWith(']]')) return '{param}';

    // Catch-all: [...slug]
    if (seg.startsWith('[...') && seg.endsWith(']')) return '{param}';

    // Dynamic segment: [name]
    if (seg.startsWith('[') && seg.endsWith(']')) return '{param}';

    // Index file: strip 'index' segment
    if (seg === 'index') return null;

    return seg;
}

/**
 * Derive the HTTP path from a file's path segments (after removing the framework prefix).
 * Returns null if the path contains a PARALLEL or INTERCEPT segment.
 *
 * @param segments - Array of path segment strings (no extension on last segment)
 */
function deriveHttpPath(segments: string[]): string | null {
    const pathParts: string[] = [];

    for (const seg of segments) {
        const normalized = normalizeSegment(seg);
        if (normalized === 'PARALLEL' || normalized === 'INTERCEPT') return null;
        if (normalized === null) continue; // stripped (route group or index)
        pathParts.push(normalized);
    }

    const joined = pathParts.join('/');
    return joined ? `/${joined}` : '/';
}

// ─── classifyRouteFile() ──────────────────────────────────────────────────────

/**
 * Classify a relative file path as a route file for a supported framework.
 *
 * Returns a RouteFileInfo if the file is a route handler, or null if:
 *   - The file is a UI page (page.tsx, layout.tsx, etc.)
 *   - The file is middleware
 *   - The file contains a parallel/intercepting route segment
 *   - The file is not recognized by any supported framework convention
 *
 * Server Action detection:
 *   - Preferred: provide `rootNode` for AST-based detection (correctly handles
 *     files with leading comments — copyright banners, ESLint disable comments).
 *   - Fallback: provide `sourceText` for regex-based detection (fast, covers
 *     ~95% of real-world files that have 'use server' as the literal first line).
 *   - Both can be provided; rootNode takes precedence.
 *
 * @param relativePath - Relative path from repo root (e.g. "app/checkout/route.ts")
 * @param sourceText   - Optional file source text (fallback for server action detection)
 * @param rootNode     - Optional tree-sitter root node (preferred for server action detection)
 */
export function classifyRouteFile(
    relativePath: string,
    sourceText?: string,
    rootNode?: Parser.SyntaxNode | null,
): RouteFileInfo | null {
    // Normalize path separators (Windows compat)
    const normalized = relativePath.replace(/\\/g, '/');

    // ── Next.js App Router ────────────────────────────────────────────────────
    //
    // API handlers:  app/**/route.ts / route.js
    // UI pages:      app/**/page.tsx etc. → SKIP
    const appRouterMatch = normalized.match(/^(?:.*\/)?app\/(.+)\/(route\.[jt]s)$/);
    if (appRouterMatch) {
        const segmentString = appRouterMatch[1]; // e.g. "checkout" or "(auth)/login"
        const segments = segmentString.split('/');
        const httpPath = deriveHttpPath(segments);
        if (httpPath === null) return null; // parallel or intercepting route
        return {
            isRouteFile: true,
            isServerAction: false, // route.ts files are never server actions
            basePath: httpPath,
            framework: 'nextjs-app-router',
        };
    }

    // app/ root route.ts (no sub-path): app/route.ts
    const appRootRouteMatch = normalized.match(/^(?:.*\/)?app\/(route\.[jt]s)$/);
    if (appRootRouteMatch) {
        return {
            isRouteFile: true,
            isServerAction: false,
            basePath: '/',
            framework: 'nextjs-app-router',
        };
    }

    // Next.js App Router — UI files (must SKIP before falling through to generic rules)
    // Matches: app/**/page.tsx, app/**/layout.tsx, app/**/loading.tsx, etc.
    const appUiMatch = normalized.match(/^(?:.*\/)?app\/(?:.+\/)?([^/]+)\.(tsx?|jsx?)$/);
    if (appUiMatch) {
        const basename = appUiMatch[1];
        if (NEXTJS_UI_SEGMENTS.has(basename)) return null;
    }
    // Root middleware
    if (/^(?:.*\/)?middleware\.[jt]s$/.test(normalized)) return null;

    // ── Next.js Pages Router ──────────────────────────────────────────────────
    //
    // API routes: pages/api/**/*.ts
    // UI pages:   pages/**/*.tsx (non-api) → SKIP
    const pagesApiMatch = normalized.match(/^(?:.*\/)?pages\/api\/(.+)\.[jt]sx?$/);
    if (pagesApiMatch) {
        const segmentString = pagesApiMatch[1]; // e.g. "webhook" or "users/[id]"
        const segments = segmentString.split('/');
        const httpPath = deriveHttpPath(['api', ...segments]);
        if (httpPath === null) return null;
        return {
            isRouteFile: true,
            isServerAction: false,
            basePath: httpPath,
            framework: 'nextjs-pages-router',
        };
    }

    // pages/ non-api files → SKIP (UI pages)
    if (/^(?:.*\/)?pages\//.test(normalized) && !/^(?:.*\/)?pages\/api\//.test(normalized)) {
        return null;
    }

    // ── SvelteKit ─────────────────────────────────────────────────────────────
    //
    // Endpoints: src/routes/**/*+server.ts
    // UI pages:  src/routes/**/*+page.svelte → SKIP
    const sveltekitMatch = normalized.match(/^(?:.*\/)?src\/routes\/(.+)\/\+server\.[jt]s$/);
    if (sveltekitMatch) {
        const segmentString = sveltekitMatch[1];
        const segments = segmentString.split('/');
        const httpPath = deriveHttpPath(segments);
        if (httpPath === null) return null;
        return {
            isRouteFile: true,
            isServerAction: false,
            basePath: httpPath,
            framework: 'sveltekit',
        };
    }

    // SvelteKit root: src/routes/+server.ts
    if (/^(?:.*\/)?src\/routes\/\+server\.[jt]s$/.test(normalized)) {
        return {
            isRouteFile: true,
            isServerAction: false,
            basePath: '/',
            framework: 'sveltekit',
        };
    }

    // SvelteKit UI files → SKIP
    if (/\/\+page\./i.test(normalized) || /\/\+layout\./i.test(normalized) || /\/\+error\./i.test(normalized)) {
        return null;
    }

    // ── Nuxt 3: server/routes/ ────────────────────────────────────────────────
    const nuxtServerRoutesMatch = normalized.match(/^(?:.*\/)?server\/routes\/(.+)\.[jt]s$/);
    if (nuxtServerRoutesMatch) {
        const segmentString = nuxtServerRoutesMatch[1];
        const segments = segmentString.split('/');
        const httpPath = deriveHttpPath(segments);
        if (httpPath === null) return null;
        return {
            isRouteFile: true,
            isServerAction: false,
            basePath: httpPath,
            framework: 'nuxt',
        };
    }

    // ── Nuxt 3: server/api/ shorthand ─────────────────────────────────────────
    const nuxtApiMatch = normalized.match(/^(?:.*\/)?server\/api\/(.+)\.[jt]s$/);
    if (nuxtApiMatch) {
        const segmentString = nuxtApiMatch[1];
        const segments = segmentString.split('/');
        const httpPath = deriveHttpPath(['api', ...segments]);
        if (httpPath === null) return null;
        return {
            isRouteFile: true,
            isServerAction: false,
            basePath: httpPath,
            framework: 'nuxt',
        };
    }

    // ── Server Actions ────────────────────────────────────────────────────────
    //
    // Any .ts/.js file (not matched above) with 'use server' at file level.
    // Route files (matched above) take priority — they are never server actions.
    //
    // Detection order: AST (rootNode) > regex (sourceText)
    // AST is preferred: correctly skips leading comments (copyright banners,
    // ESLint disable comments) before the 'use server' directive.
    const hasServerDirective = rootNode !== undefined && rootNode !== null
        ? isFileServerActionFromAST(rootNode)
        : sourceText !== undefined
            ? isFileServerActionRegex(sourceText)
            : false;

    if (hasServerDirective) {
        return {
            isRouteFile: false,
            isServerAction: true,
            basePath: '/_action', // used as prefix by the chunk emitter
            framework: 'nextjs-action',
        };
    }

    return null;
}

/**
 * Regex-based detection of a file-level 'use server' directive.
 * Fast path — covers ~95% of real-world files where 'use server' is the literal first line.
 *
 * Limitation: does NOT handle comments before the directive (e.g. copyright banners,
 * ESLint disable comments). For accurate detection when an AST is available,
 * use isFileServerActionFromAST() instead.
 *
 * Matches:
 *   'use server';    (single quotes)
 *   "use server";    (double quotes)
 *   'use server'     (no semicolon)
 */
function isFileServerActionRegex(source: string): boolean {
    const trimmed = source.trimStart();
    return /^['"]use server['"];?(\r?\n|$)/.test(trimmed);
}

/**
 * AST-based detection of a file-level 'use server' directive.
 *
 * Walks the root node's children, skipping `comment` nodes (// and /* *\/).
 * Checks if the first non-comment child is an `expression_statement` whose
 * inner string literal is exactly 'use server' or "use server".
 *
 * This correctly handles files like:
 *
 *   // Copyright (c) 2024 Acme Corp. All rights reserved.
 *   'use server';
 *
 *   /* eslint-disable @typescript-eslint/no-explicit-any *\/
 *   'use server';
 *
 * Does NOT trigger for function-level 'use server' (inside a function body),
 * because those nodes are nested inside a function_declaration, not at the root.
 *
 * @param rootNode - Tree-sitter root SyntaxNode of the parsed file.
 */
export function isFileServerActionFromAST(
    rootNode: Parser.SyntaxNode,
): boolean {
    for (const child of rootNode.children) {
        // Skip comment nodes (// single-line and /* */ multi-line)
        if (child.type === 'comment') continue;

        // First non-comment child must be an expression_statement
        if (child.type !== 'expression_statement') return false;

        // The expression must be a string literal node
        const stringNode = child.children.find(c => c.type === 'string');
        if (!stringNode) return false;

        // Strip the surrounding quotes and compare
        const text = stringNode.text.replace(/^['"]|['"]$/g, '');
        return text === 'use server';
    }
    return false;
}

// ─── extractHttpMethodsFromAST() ──────────────────────────────────────────────

/**
 * Extract HTTP method names from the exported identifiers of a route.ts file.
 *
 * Handles all 4 TypeScript export forms:
 *   Form 1: export function GET(...) {}
 *   Form 2: export const GET = async () => {}
 *   Form 3: const GET = ...; export { GET, POST }
 *   Form 4: export { GET } from './handlers.js'  (method detection only — body not analyzed)
 *
 * Normalization:
 *   - HEAD → GET   (normalizeHttpMethod compat: HEAD is not accepted by the pipeline)
 *   - OPTIONS → POST (same reason)
 *   - Results are deduplicated
 *
 * @param rootNode - Tree-sitter root node of the parsed file. null → safe default.
 * @param _filepath - File path (unused in V1 but useful for future per-framework logic).
 * @returns Array of deduplicated, normalized HTTP methods. Never empty (POST fallback).
 */
export function extractHttpMethodsFromAST(
    rootNode: Parser.SyntaxNode | null,
    _filepath: string,
): HttpMethod[] {
    if (!rootNode) return ['POST'];

    const methods = new Set<HttpMethod>();

    for (const node of rootNode.children) {
        if (node.type !== 'export_statement') continue;

        // ── Form 1: export function GET(...) {} ───────────────────────────────
        const funcDecl = node.children.find(c => c.type === 'function_declaration');
        if (funcDecl) {
            const nameNode = funcDecl.childForFieldName('name');
            if (nameNode) {
                const method = resolveHttpMethod(nameNode.text);
                if (method) methods.add(method);
            }
            continue;
        }

        // ── Form 2: export const GET = async () => {} ─────────────────────────
        const lexicalDecl = node.children.find(c => c.type === 'lexical_declaration');
        if (lexicalDecl) {
            for (const child of lexicalDecl.children) {
                if (child.type === 'variable_declarator') {
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) {
                        const method = resolveHttpMethod(nameNode.text);
                        if (method) methods.add(method);
                    }
                }
            }
            continue;
        }

        // ── Form 3 & 4: export { GET, POST } [from '...'] ────────────────────
        //
        // Both forms share the `export_clause` AST node.
        // Form 4 additionally has a `string` child (the `from` source module).
        // We handle both identically for method detection purposes.
        const exportClause = node.children.find(c => c.type === 'export_clause');
        if (exportClause) {
            for (const specifier of exportClause.children) {
                if (specifier.type !== 'export_specifier') continue;

                // The exported (public) name is the `alias` field if present, else the `name` field.
                // Example: export { handler as GET } → alias = GET
                // Example: export { GET }            → name = GET
                const aliasNode = specifier.childForFieldName('alias');
                const nameNode = specifier.childForFieldName('name');
                const exportedName = aliasNode ?? nameNode;

                if (exportedName) {
                    const method = resolveHttpMethod(exportedName.text);
                    if (method) methods.add(method);
                }
            }
            continue;
        }
    }

    // Safe default: if no HTTP methods found, emit POST (avoid ANY/ALL which are dropped by the pipeline)
    return methods.size > 0 ? [...methods] : ['POST'];
}

/**
 * Resolve an identifier string to a normalized HTTP method.
 * Returns null if the identifier is not an HTTP method name.
 *
 * Normalization:
 *   HEAD    → GET   (pipeline compat)
 *   OPTIONS → POST  (pipeline compat)
 */
function resolveHttpMethod(identifier: string): HttpMethod | null {
    const upper = identifier.trim().toUpperCase();

    if (DIRECT_HTTP_METHODS.has(upper)) return upper as HttpMethod;

    const normalized = HTTP_METHOD_NORMALIZATION[upper];
    return normalized ?? null;
}
