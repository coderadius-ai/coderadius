import fs from 'node:fs';
import path from 'node:path';
import type { CodeChunk } from '../../../graph/types.js';
import type Parser from 'tree-sitter';
import { logger } from '../../../utils/logger.js';
import { getPluginForExtension } from '../../core/languages/registry.js';

// ─── Parser Dispatcher ───────────────────────────────────────────────────────
//
// This module is intentionally language-agnostic.
// All language-specific parsing logic lives in the language plugins under
// src/ingestion/core/languages/. To add a new language, register a new
// plugin there — this file does not change.
// ─────────────────────────────────────────────────────────────────────────────

// Singleton parser instances — one per plugin, reused across calls
const parserCache = new Map<string, ReturnType<typeof import('../../core/languages/typescript.js').TypeScriptPlugin.prototype.createParser>>();

// Defense-in-depth size limit for tree-sitter parsing. ScopeManager filters
// the bulk of large/bundled files at discovery (>300KB or low newline density),
// but vendored stub files, generated DTOs, and minified third-party assets
// occasionally slip through framework-specific paths. tree-sitter is in-process
// and synchronous, so a single pathological file can stall Stage 2 invisibly.
// Symbol extraction uses 512KB; the env-scanner uses 1MB; this guard sits at
// the larger of the two so we never refuse code that those layers accepted.
const MAX_PARSE_BYTES = 1_000_000;

/**
 * Parse a source file into function/method chunks and return the AST root.
 * Dispatches to the appropriate language plugin based on file extension.
 *
 * `relativePath` is the repo-relative path of the file; plugins use it for
 * web-facing identifiers (e.g. PHP legacy filesystem routes) so graph paths
 * never embed the machine-absolute prefix.
 */
export function parseFile(filePath: string, relativePath?: string): {
    chunks: CodeChunk[];
    rootNode: Parser.SyntaxNode | null;
    language: string;
} {
    try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_PARSE_BYTES) {
            logger.debug(
                `[Parser] Skipping ${path.basename(filePath)}: ${Math.round(stats.size / 1024)}KB > ${MAX_PARSE_BYTES / 1024}KB cap`,
            );
            return { chunks: [], rootNode: null, language: 'unknown' };
        }
    } catch {
        // Stat failures fall through to readFileSync, which will surface the
        // real error with a more useful path.
    }
    const source = fs.readFileSync(filePath, 'utf-8');
    return parseSource(filePath, source, relativePath);
}

export function parseSource(filePath: string, source: string, relativePath?: string): {
    chunks: CodeChunk[];
    rootNode: Parser.SyntaxNode | null;
    language: string;
} {
    const ext = path.extname(filePath).toLowerCase();
    const plugin = getPluginForExtension(ext);

    if (!plugin) {
        // Manifest/config files (JSON, YAML, etc.) — no AST parsing needed
        return { chunks: [], rootNode: null, language: 'unknown' };
    }

    // Get or create the parser for this language
    let parser = parserCache.get(plugin.language);
    if (!parser) {
        parser = plugin.createParser();
        parserCache.set(plugin.language, parser);
    }

    const tree = parser.parse(source);

    return {
        chunks: plugin.extractFunctions(tree, source, filePath, relativePath),
        rootNode: tree.rootNode,
        language: plugin.language,
    };
}

// Re-export name-resolvers for use by language plugins
export { resolveAnonymousName } from './name-resolvers.js';
