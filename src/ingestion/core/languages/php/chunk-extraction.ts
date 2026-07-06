import path from 'node:path';
import type Parser from 'tree-sitter';
import { likelyHasIOWithTaint } from '../../heuristic-filter.js';
import { extractLegacyFilesystemRoute, extractPhpRoutes } from '../../../processors/route-extractor-php.js';
import type { CodeChunk } from '../../../../graph/types.js';
import { extractClassMetadata } from './orm-static.js';
import { extractPhpEnvVars, extractPrecedingComments } from './shared/ast-utils.js';

const FUNCTION_TYPES = new Set(['function_definition', 'method_declaration']);
const EXCLUDED_TOP_LEVEL_TYPES = new Set([
    'function_definition',
    'class_declaration',
    'namespace_definition',
    'namespace_use_declaration',
    'php_tag',
    'comment',
]);

function buildChunk(
    name: string,
    filepath: string,
    sourceCode: string,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
    envVars: string[] = [],
    parentClassName?: string,
): CodeChunk {
    return {
        name,
        filepath,
        sourceCode,
        language: 'php',
        startLine,
        startColumn,
        endLine,
        endColumn,
        ...(envVars.length > 0 && { envVars }),
        ...(parentClassName !== undefined && { parentClassName }),
    };
}

function extractCurrentNamespace(rootNode: Parser.SyntaxNode): string {
    const namespaceNode = rootNode.children.find(child => child.type === 'namespace_definition');
    return namespaceNode?.childForFieldName('name')?.text ?? '';
}

function extractQualifiedFunctionName(
    node: Parser.SyntaxNode,
    currentNamespace: string,
    parentName?: string,
): string {
    let name = node.childForFieldName('name')!.text;
    if (parentName) {
        name = `${parentName}.${name}`;
    }
    return currentNamespace ? `${currentNamespace}\\${name}` : name;
}

function collectTopLevelStatements(rootNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    return rootNode.children.filter(child => !EXCLUDED_TOP_LEVEL_TYPES.has(child.type));
}

function buildMainChunk(filepath: string, topLevelStatements: Parser.SyntaxNode[]): CodeChunk | null {
    if (topLevelStatements.length === 0) return null;

    const sourceCode = topLevelStatements.map(statement => statement.text).join('\n');
    if (sourceCode.length <= 50) return null;

    const fileName = path.basename(filepath, path.extname(filepath));
    const envVars = [...new Set(topLevelStatements.flatMap(statement => extractPhpEnvVars(statement)))];
    // Emit unconditionally above the size threshold. The architectural gates
    // downstream (taint propagation, framework signals) decide if the chunk
    // is worth LLM analysis. No more regex-based I/O sniffing here.
    return buildChunk(
        `${fileName}::main`,
        filepath,
        sourceCode,
        topLevelStatements[0].startPosition.row + 1,
        topLevelStatements[0].startPosition.column + 1,
        topLevelStatements[topLevelStatements.length - 1].endPosition.row + 1,
        topLevelStatements[topLevelStatements.length - 1].endPosition.column + 1,
        envVars,
    );
}

function buildClassMetadataChunk(
    classNode: Parser.SyntaxNode,
    filepath: string,
    currentNamespace: string,
): CodeChunk | null {
    const metadata = extractClassMetadata(classNode);
    if (!metadata) return null;

    const className = classNode.childForFieldName('name')!.text;
    const qualifiedName = currentNamespace ? `${currentNamespace}\\${className}` : className;
    const chunk = buildChunk(
        `${qualifiedName}::__class_metadata`,
        filepath,
        metadata,
        classNode.startPosition.row + 1,
        classNode.startPosition.column + 1,
        classNode.endPosition.row + 1,
        classNode.endPosition.column + 1,
    );

    return likelyHasIOWithTaint(chunk).passed ? chunk : null;
}

function buildRouteChunks(source: string, rootNode: Parser.SyntaxNode, filepath: string): CodeChunk[] {
    return extractPhpRoutes(rootNode, source, filepath).map(route =>
        buildChunk(
            `${route.method} ${route.path}::__route_handler`,
            filepath,
            `/* ${route.framework} route: ${route.method} ${route.path} */`,
            1,
            1,
            1,
            1,
        ),
    );
}

function buildLegacyRouteChunks(
    source: string,
    filepath: string,
    routePath: string,
    topLevelStatements: Parser.SyntaxNode[],
    topLevelSource: string,
    routeChunkCount: number,
): CodeChunk[] {
    if (topLevelStatements.length === 0 || topLevelSource.length <= 50 || routeChunkCount > 0) {
        return [];
    }

    return extractLegacyFilesystemRoute(source, routePath).map(route =>
        buildChunk(
            `${route.method} ${route.path}::__route_handler`,
            filepath,
            `/* ${route.framework} route: ${route.method} ${route.path} */`,
            1,
            1,
            1,
            1,
        ),
    );
}

export function extractPhpFunctions(
    tree: Parser.Tree,
    source: string,
    filepath: string,
    relativePath?: string,
): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const rootNode = tree.rootNode;
    const currentNamespace = extractCurrentNamespace(rootNode);

    const walk = (node: Parser.SyntaxNode, parentName?: string): void => {
        if (FUNCTION_TYPES.has(node.type)) {
            const name = extractQualifiedFunctionName(node, currentNamespace, parentName);
            let sourceCode = node.text;
            const comments = extractPrecedingComments(node);
            if (comments) {
                sourceCode = comments + sourceCode;
            }

            const envVars = extractPhpEnvVars(node);
            const qualifiedParentClass = parentName
                ? (currentNamespace ? `${currentNamespace}\\${parentName}` : parentName)
                : undefined;
            chunks.push(buildChunk(
                name,
                filepath,
                sourceCode,
                node.startPosition.row + 1,
                node.startPosition.column + 1,
                node.endPosition.row + 1,
                node.endPosition.column + 1,
                envVars,
                qualifiedParentClass,
            ));
        }

        const className = node.type === 'class_declaration'
            ? node.childForFieldName('name')?.text
            : undefined;

        for (const child of node.children) {
            walk(child, className ?? parentName);
        }
    };

    walk(rootNode);

    const topLevelStatements = collectTopLevelStatements(rootNode);
    const topLevelSource = topLevelStatements.map(statement => statement.text).join('\n');

    const mainChunk = buildMainChunk(filepath, topLevelStatements);
    if (mainChunk) {
        chunks.push(mainChunk);
    }

    for (const child of rootNode.children) {
        if (child.type !== 'class_declaration') continue;
        const metadataChunk = buildClassMetadataChunk(child, filepath, currentNamespace);
        if (metadataChunk) {
            chunks.push(metadataChunk);
        }
    }

    const routeChunks = buildRouteChunks(source, rootNode, filepath);
    chunks.push(...routeChunks);

    chunks.push(...buildLegacyRouteChunks(
        source,
        filepath,
        relativePath ?? filepath,
        topLevelStatements,
        topLevelSource,
        routeChunks.length,
    ));

    return chunks;
}
