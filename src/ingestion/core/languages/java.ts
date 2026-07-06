import Parser from 'tree-sitter';
import javaLang from 'tree-sitter-java';
import path from 'node:path';
import { patchLanguage } from '../../processors/parser/jsc-compat.js';
import type { CodeChunk } from '../../../graph/types.js';
import type { ImportRef, ClassPropertyAlias } from '../import-graph.js';
import type { LanguagePlugin, ImportContext, StaticInfraResult } from './types.js';
import { extractJavaRoutes } from '../../processors/route-extractor-java.js';

const FUNCTION_TYPES = new Set(['method_declaration', 'constructor_declaration']);
const TYPE_DECL_TYPES = new Set([
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Java Language Plugin
//
// Best-effort bootstrap. Implements the required LanguagePlugin surface plus
// `extractStaticInfra` so Spring / JAX-RS controllers contribute INBOUND
// APIEndpoints deterministically (no LLM). Optional cross-file/value-resolution
// hooks are intentionally absent at this tier.
// ═══════════════════════════════════════════════════════════════════════════════
export class JavaPlugin implements LanguagePlugin {
    readonly language = 'java';
    readonly ecosystem = 'maven';
    readonly extensions = ['.java'] as const;

    readonly scopeExclusions = [
        // ── Build output (Maven / Gradle / IDE) ─────────────────────────────
        'target/**', '**/target/**',
        'build/**', '**/build/**',
        'out/**', '**/out/**',
        'bin/**', '**/bin/**',
        '**/.gradle/**',
        // ── Generated sources ───────────────────────────────────────────────
        '**/generated/**', '**/generated-sources/**', '**/generated-test-sources/**',
        // ── Tests (Maven layout + JUnit naming) ─────────────────────────────
        '**/src/test/**',
        '*Test.java', '*Tests.java', '*IT.java',
        // ── Compiled artefacts / package descriptors ────────────────────────
        '*.class',
        'package-info.java', 'module-info.java',
    ] as const;

    readonly manifestFiles = [
        { file: 'pom.xml', language: 'java' },
        { file: 'build.gradle', language: 'java' },
        { file: 'build.gradle.kts', language: 'java' },
    ] as const;

    readonly ignorePatterns = [
        '**/target/**',
        '**/build/**',
    ] as const;

    private parserInstance: Parser | null = null;

    createParser(): Parser {
        if (!this.parserInstance) {
            this.parserInstance = new Parser();
            this.parserInstance.setLanguage(patchLanguage(javaLang));
        }
        return this.parserInstance;
    }

    // ─── Chunk Extraction ─────────────────────────────────────────────────────

    extractFunctions(tree: Parser.Tree, source: string, filepath: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];

        const walk = (node: Parser.SyntaxNode, parentName?: string): void => {
            if (FUNCTION_TYPES.has(node.type)) {
                const chunk = this.buildMethodChunk(node, filepath, parentName);
                if (chunk) chunks.push(chunk);
            }
            const typeName = TYPE_DECL_TYPES.has(node.type)
                ? node.childForFieldName('name')?.text
                : undefined;
            for (const child of node.children) walk(child, typeName ?? parentName);
        };
        walk(tree.rootNode);

        for (const route of extractJavaRoutes(tree.rootNode)) {
            chunks.push({
                name: `${route.method} ${route.path}::__route_handler`,
                filepath,
                sourceCode: `/* ${route.framework} route: ${route.method} ${route.path} */`,
                language: 'java',
                startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
            });
        }

        return chunks;
    }

    private buildMethodChunk(
        node: Parser.SyntaxNode,
        filepath: string,
        parentName?: string,
    ): CodeChunk | null {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        const name = parentName ? `${parentName}.${nameNode.text}` : nameNode.text;

        let sourceCode = node.text;
        const comments = extractPrecedingComments(node);
        if (comments) sourceCode = comments + sourceCode;

        const envVars = this.extractEnvVars(node);
        return {
            name,
            filepath,
            sourceCode,
            language: 'java',
            startLine: node.startPosition.row + 1,
            startColumn: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
            endColumn: node.endPosition.column + 1,
            ...(envVars.length > 0 && { envVars }),
            ...(parentName !== undefined && { parentClassName: parentName }),
        };
    }

    // ─── Static-First Infrastructure (route handlers → INBOUND endpoints) ──────

    extractStaticInfra(_rootNode: Parser.SyntaxNode, chunk: CodeChunk): StaticInfraResult | null {
        if (!chunk.name.endsWith('::__route_handler')) return null;

        const routePart = chunk.name.slice(0, -'::__route_handler'.length);
        const spaceIdx = routePart.indexOf(' ');
        if (spaceIdx === -1) return null;

        const method = routePart.slice(0, spaceIdx);
        const routePath = routePart.slice(spaceIdx + 1);
        const frameworkMatch = chunk.sourceCode.match(/\/\*\s*([^:]+)\s+route:/);
        const framework = frameworkMatch ? frameworkMatch[1].trim() : 'java';

        return {
            has_io: true,
            intent: `${framework} HTTP ${method} endpoint at ${routePath}`,
            infrastructure: [],
            capabilities: ['http-handler'],
            emergent_api_calls: [{ method, path: routePath, direction: 'INBOUND', framework }],
        };
    }

    // ─── Environment Variables ─────────────────────────────────────────────────

    extractEnvVars(node: Parser.SyntaxNode): string[] {
        const names = new Set<string>();
        const text = node.text;
        for (const match of text.matchAll(/System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g)) {
            names.add(match[1]);
        }
        // Spring property injection: @Value("${some.key:default}")
        for (const match of text.matchAll(/@Value\(\s*"\$\{\s*([A-Za-z0-9_.]+)/g)) {
            names.add(match[1]);
        }
        return [...names];
    }

    // ─── Import Graph / Taint Engine ───────────────────────────────────────────

    extractImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
        const imports: ImportRef[] = [];
        for (const line of rootNode.text.split('\n')) {
            const match = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?\s*;/);
            if (!match) continue;
            const qualified = match[1];
            const isWildcard = match[2] === '.*';
            const resolved = resolveJavaImport(qualified, isWildcard, context);
            const local = qualified.split('.').pop() ?? qualified;
            imports.push({
                source: resolved.source,
                specifiers: isWildcard ? ['*'] : [local],
                isExternal: !resolved.local,
                specifierBindings: [{
                    imported: isWildcard ? '*' : local,
                    local,
                    kind: isWildcard ? 'namespace' : 'named',
                }],
            });
        }
        return imports;
    }

    extractExports(rootNode: Parser.SyntaxNode): string[] {
        const exports = new Set<string>();
        const walk = (node: Parser.SyntaxNode): void => {
            if (TYPE_DECL_TYPES.has(node.type) || FUNCTION_TYPES.has(node.type)) {
                const name = node.childForFieldName('name')?.text;
                if (name) exports.add(name);
            }
            for (const child of node.children) walk(child);
        };
        walk(rootNode);
        return [...exports];
    }

    extractClassPropertyAliases(_rootNode: Parser.SyntaxNode): ClassPropertyAlias[] {
        return [];
    }

    // ─── Static Analyzer Helpers (LLM context) ─────────────────────────────────

    extractImportStatements(rootNode: Parser.SyntaxNode): string[] {
        const statements: string[] = [];
        for (const child of rootNode.children) {
            if (child.type === 'import_declaration') statements.push(child.text);
        }
        return statements;
    }

    extractConstructorSources(rootNode: Parser.SyntaxNode): Map<string, string> {
        const sources = new Map<string, string>();
        const walk = (node: Parser.SyntaxNode, className?: string): void => {
            if (node.type === 'constructor_declaration' && className) {
                sources.set(className, node.text);
            }
            const typeName = TYPE_DECL_TYPES.has(node.type)
                ? node.childForFieldName('name')?.text
                : undefined;
            for (const child of node.children) walk(child, typeName ?? className);
        };
        walk(rootNode);
        return sources;
    }
}

// ─── Module-Private Helpers ─────────────────────────────────────────────────────

function extractPrecedingComments(node: Parser.SyntaxNode): string {
    let comments = '';
    let curr = node.previousSibling;
    while (curr && (curr.type === 'comment' || curr.type === 'line_comment' || curr.type === 'block_comment')) {
        comments = curr.text + '\n' + comments;
        curr = curr.previousSibling;
    }
    return comments;
}

/**
 * Resolve a Java import to a repo file when one exists (enables file→file taint
 * edges). A dotted FQCN maps to `a/b/C.java`; we match on path suffix so the
 * Maven/Gradle `src/main/java/` prefix is irrelevant. Wildcard imports
 * (`a.b.*`) cannot resolve to a single file and stay external.
 */
function resolveJavaImport(
    qualified: string,
    isWildcard: boolean,
    context: ImportContext,
): { source: string; local: boolean } {
    if (!isWildcard) {
        const asPath = qualified.replace(/\./g, '/') + '.java';
        for (const file of context.allFilePaths) {
            if (file === asPath || file.endsWith(`/${asPath}`)) {
                return { source: file, local: true };
            }
        }
    }
    return { source: qualified, local: false };
}
