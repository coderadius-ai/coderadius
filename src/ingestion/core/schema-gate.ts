import type Parser from 'tree-sitter';
import path from 'node:path';
import fs from 'node:fs';

// ─── Schema Gate (AST-Based) ───────────────────────────────────────────────────
//
// Structural pre-filter that determines if a file MAY contain data schemas.
// Uses Tree-sitter AST nodes and declarative file fallbacks.

const DATA_STRUCTURE_NODE_TYPES: Record<string, string[]> = {
    typescript: ['interface_declaration', 'type_alias_declaration', 'class_declaration'],
    php: ['class_declaration'],
    python: ['class_definition'],
    go: ['type_spec'],
    rust: ['struct_item', 'enum_item'],
    java: ['class_declaration', 'record_declaration'],
    csharp: ['class_declaration', 'record_declaration'],
};

// Note: .graphql and .gql are intentionally EXCLUDED here.
// GraphQL SDL files are processed by graphql-schema-extractor.ts, which uses
// graphql-js (the official GraphQL Foundation parser) to extract root field
// definitions. Routing them through the generic schema-gate would send them
// to the LLM schema extractor, which expects class/interface structures —
// not SDL type definitions.
const DECLARATIVE_EXTENSIONS = new Set(['.sql', '.prisma', '.proto']);

/**
 * Check if a source file MAY contain data schema definitions.
 */
export function mayContainSchemas(
    astRoot: Parser.SyntaxNode | null,
    filePath: string,
    language: string
): boolean {
    // 1. Declarative Fallbacks (Fast Pass)
    const ext = path.extname(filePath).toLowerCase();
    if (DECLARATIVE_EXTENSIONS.has(ext)) return true;

    if (ext === '.yaml' || ext === '.yml') {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (/openapi|swagger/i.test(content)) return true;
        } catch { /* ignore read errors */ }
    }

    // Fast pass for files containing code that often defines implicit message payloads / API contracts
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (/rabbitChannel\.publish|req\.body|fetch\(|pgPool\.query|db->prepare|pgTable\(|z\.object\(|z\.array\(|z\.enum\(|defineTable\(|createTable\(/i.test(content)) return true;
    } catch { /* ignore read errors */ }

    if (!astRoot) return false;

    // 2. AST structural check
    const targetTypes = DATA_STRUCTURE_NODE_TYPES[language] || [];

    // If we don't know the node types for this language, we default to TRUE
    // to avoid missing potential schemas (High Recall).
    if (targetTypes.length === 0 && language !== 'unknown') return true;

    return hasNodesOfType(astRoot, targetTypes);
}

/**
 * Recursively walks the AST to find any node matching the target types.
 */
function hasNodesOfType(node: Parser.SyntaxNode, types: string[]): boolean {
    if (types.includes(node.type)) return true;
    for (const child of node.children) {
        if (hasNodesOfType(child, types)) return true;
    }
    return false;
}
