import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../../graph/types.js';
import { resolveAnonymousName, resolveAnonymousNameWithAmbiguity } from '../../../processors/parser/name-resolvers.js';
import {
    classifyRouteFile,
    extractHttpMethodsFromAST,
} from '../../../processors/route-extractor.js';
import { extractTsProgrammaticRoutes } from '../../../processors/route-extractor-ts-programmatic.js';
import type { FrameworkSignal } from '../types.js';
import { normalizeHttpPath, joinHttpPath } from '../../framework-signal-overlay.js';
import {
    buildTypeScriptMetadataChunks,
    extractTypeScriptFrameworkSignals,
} from '../typescript-framework-signals.js';
import { extractTypeScriptEnvVars } from './env-vars.js';

const NON_BOUNDARY_CALLBACK_METHODS = new Set([
    'pipe',
    'flow',
    'map',
    'mapleft',
    'mapwithindex',
    'chain',
    'chainw',
    'chainfirst',
    'chaineitherk',
    'chaintaskk',
    'chainiok',
    'chainioK',
    'ap',
    'aps',
    'bind',
    'bindw',
    'let',
    'alt',
    'altw',
    'fold',
    'match',
    'matchw',
    'getorelse',
    'getorelsew',
    'frompredicate',
    'fromoption',
    'fromtask',
    'trycatch',
    'orelse',
    'orelsefirstiok',
    'tap',
    'tapio',
    'filter',
    'filtermap',
    'reduce',
    'find',
    'findfirst',
    'some',
    'every',
    'then',
    'catch',
    'finally',
    'flatmap',
    'foreach',
]);

export function extractTypeScriptFunctions(tree: Parser.Tree, source: string, filepath: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const functionTypes = new Set([
        'function_declaration',
        'method_definition',
        'arrow_function',
        'function',
    ]);

    const walk = (node: Parser.SyntaxNode, parentName?: string) => {
        if (functionTypes.has(node.type)) {
            if (!shouldSkipStandaloneCallback(node)) {
                let name: string;
                let nameIsAmbiguous: boolean;

                const nameNode = node.childForFieldName('name');
                if (nameNode) {
                    name = nameNode.text;
                    nameIsAmbiguous = false;
                } else {
                    ({ name, nameIsAmbiguous } = resolveAnonymousNameWithAmbiguity(node));
                }

                if (parentName) {
                    name = `${parentName}.${name}`;
                }

                let sourceCode = node.text;
                const comments = extractPrecedingComments(node);
                if (comments) sourceCode = comments + sourceCode;

                const envVars = extractTypeScriptEnvVars(node);
                chunks.push(buildChunkFromNode(node, filepath, sourceCode, envVars, name, nameIsAmbiguous, parentName));
            }
        }

        let className: string | undefined;
        if (node.type === 'class_declaration' || node.type === 'class') {
            const classNameNode = node.childForFieldName('name');
            if (classNameNode) className = classNameNode.text;
        }

        for (const child of node.children) {
            walk(child, className ?? parentName);
        }
    };

    walk(tree.rootNode);

    const routeInfo = classifyRouteFile(filepath, source, tree.rootNode);
    if (routeInfo?.isRouteFile) {
        const isAppRouterRoute = routeInfo.framework === 'nextjs-app-router';
        const methods = isAppRouterRoute
            ? extractHttpMethodsFromAST(tree.rootNode, filepath)
            : ['POST'] as const;

        for (const method of methods) {
            chunks.push({
                name: `${method} ${routeInfo.basePath}::__route_handler`,
                filepath,
                sourceCode: source,
                language: 'typescript',
                ...fullFileLocation(source),
            });
        }
    } else if (routeInfo?.isServerAction) {
        const exportedFunctions = extractExportedFunctionNames(tree.rootNode);
        for (const functionName of exportedFunctions) {
            chunks.push({
                name: `POST /_action/${functionName}::__server_action`,
                filepath,
                sourceCode: source,
                language: 'typescript',
                ...fullFileLocation(source),
            });
        }
    }

    // Programmatic routes (Express/Fastify/Koa/Hono). The file-convention
    // extractor above only covers Next.js/SvelteKit/Nuxt; this picks up
    // app.get('/x', h) / app.route({method,url}). Dedup against file-based names.
    const programmaticRoutes = extractTsProgrammaticRoutes(tree.rootNode);
    if (programmaticRoutes.length > 0) {
        const existing = new Set(
            chunks.filter(c => c.name.endsWith('::__route_handler')).map(c => c.name),
        );
        for (const route of programmaticRoutes) {
            const name = `${route.method} ${route.path}::__route_handler`;
            if (existing.has(name)) continue;
            existing.add(name);
            chunks.push({
                name,
                filepath,
                sourceCode: source,
                language: 'typescript',
                ...fullFileLocation(source),
            });
        }
    }

    const frameworkSignals = extractTypeScriptFrameworkSignals(tree.rootNode, source, filepath);

    // Decorator routes (NestJS @Controller + @Get/@Post, routing-controllers).
    // framework-signals already parses & composes these, but the INBOUND endpoint
    // was only produced by the post-LLM overlay. Emit a static ::__route_handler
    // chunk so decorator routes resolve to APIEndpoints with ZERO LLM calls —
    // parity with the programmatic-router extractor. pruneDuplicateRouteImplementations
    // collapses the overlap with the controller-method chunks.
    for (const route of composeDecoratorRoutes(frameworkSignals)) {
        const name = `${route.method} ${route.path}::__route_handler`;
        if (chunks.some(c => c.name === name)) continue;
        chunks.push({ name, filepath, sourceCode: source, language: 'typescript', ...fullFileLocation(source) });
    }

    // Message-handler decorators (@MessagePattern/@EventPattern/@RabbitSubscribe/
    // @SqsMessageHandler/@Processor...). framework-signals already resolves the
    // channel name, but the MessageChannel was only produced by the post-LLM
    // overlay. Emit a static `::__message_handler` chunk so decorator consumers
    // resolve to MessageChannels with ZERO LLM calls — the broker analog of the
    // decorator-route extractor (composeDecoratorRoutes).
    for (const channel of composeMessageChannels(frameworkSignals)) {
        const name = `${channel}::__message_handler`;
        if (chunks.some(c => c.name === name)) continue;
        chunks.push({ name, filepath, sourceCode: source, language: 'typescript', ...fullFileLocation(source) });
    }

    const metadataChunks = buildTypeScriptMetadataChunks(tree.rootNode, source, filepath, frameworkSignals);
    if (metadataChunks.length > 0) {
        chunks.push(...metadataChunks);
    }

    // ── Consumer Rescue ──────────────────────────────────────────────────────
    // When a file has class-level consumer framework signals (e.g. @MessageConsumer)
    // but tree-sitter produced 0 regular method chunks (thin wrapper classes),
    // inject a synthetic full-file chunk so the consumer entrypoint is analyzed.
    // Without this, files like SaveUpdated.consumer.ts silently drop to "0 found".
    if (chunks.length === 0 && frameworkSignals.some(s => s.scope === 'class' && s.kind === 'message-consumer')) {
        chunks.push({
            name: `${frameworkSignals.find(s => s.scope === 'class' && s.kind === 'message-consumer')!.ownerName}::__consumer_entrypoint`,
            filepath,
            sourceCode: source,
            language: 'typescript',
            ...fullFileLocation(source),
        });
    }

    return chunks;
}

/**
 * Compose @Controller(prefix) + @Get/@Post(path) decorator signals into HTTP
 * routes, mirroring buildFrameworkSignalOverlay's INBOUND join so the static
 * path produces exactly what the post-LLM overlay would. Used to emit static
 * ::__route_handler chunks for decorator routers (NestJS / routing-controllers).
 */
function composeDecoratorRoutes(signals: FrameworkSignal[]): Array<{ method: string; path: string }> {
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
    const controllerPrefixes = signals
        .filter(s => s.kind === 'http-controller')
        .map(s => normalizeHttpPath(str(s.metadata?.path)))
        .filter((v): v is string => Boolean(v));
    const routes: Array<{ method: string; path: string }> = [];
    for (const s of signals) {
        if (s.kind !== 'http-route') continue;
        const method = str(s.metadata?.httpMethod) ?? 'POST';
        const methodPath = normalizeHttpPath(str(s.metadata?.path)) ?? '/';
        const fullPath = controllerPrefixes.length > 0
            ? joinHttpPath(controllerPrefixes[controllerPrefixes.length - 1], methodPath)
            : methodPath;
        routes.push({ method, path: fullPath });
    }
    return routes;
}

/**
 * Collect the named channels bound by message-consumer decorators
 * (@MessagePattern/@EventPattern/@RabbitSubscribe/@SqsMessageHandler/@Processor,
 * plus custom-registered ones). framework-signals already resolves the channel
 * name from the decorator argument; this just harvests the resolved names so
 * chunk-extraction can emit static `::__message_handler` chunks — the broker
 * analog of composeDecoratorRoutes for HTTP routes.
 */
function composeMessageChannels(signals: FrameworkSignal[]): string[] {
    const channels: string[] = [];
    for (const s of signals) {
        // Method-scope handlers (@MessagePattern/@EventPattern/...) are
        // 'message-consumer'; class-scope @Processor is 'message-processor'.
        // Both carry a resolved channel name and capability 'message-consumer'.
        if (s.kind !== 'message-consumer' && s.kind !== 'message-processor') continue;
        const channel = typeof s.resolvedName === 'string' ? s.resolvedName.trim() : '';
        if (channel.length > 0) channels.push(channel);
    }
    return channels;
}

function buildChunkFromNode(
    node: Parser.SyntaxNode,
    filepath: string,
    sourceCode: string,
    envVars: string[],
    name: string,
    nameIsAmbiguous = false,
    parentClassName?: string,
): CodeChunk {
    return {
        name,
        filepath,
        sourceCode,
        language: 'typescript',
        startLine: node.startPosition.row + 1,
        startColumn: node.startPosition.column + 1,
        endLine: node.endPosition.row + 1,
        endColumn: node.endPosition.column + 1,
        ...(envVars.length > 0 && { envVars }),
        ...(nameIsAmbiguous && { nameIsAmbiguous: true }),
        ...(parentClassName !== undefined && { parentClassName }),
    };
}

function fullFileLocation(sourceCode: string): Pick<CodeChunk, 'startLine' | 'startColumn' | 'endLine' | 'endColumn'> {
    const lines = sourceCode.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    return {
        startLine: 1,
        startColumn: 1,
        endLine: lines.length,
        endColumn: Math.max(lastLine.length, 0) + 1,
    };
}

function shouldSkipStandaloneCallback(node: Parser.SyntaxNode): boolean {
    if (node.type !== 'arrow_function' && node.type !== 'function') {
        return false;
    }

    if (looksArchitecturalCallback(node.text)) {
        return false;
    }

    if (isNonBoundaryCallArgument(node)) {
        return true;
    }

    return isAnonymousNestedClosure(node);
}

function looksArchitecturalCallback(source: string): boolean {
    return /\b(emitEvent|publish|routingKey|eventName|client\.(query|mutate|subscribe)|fetch\(|axios\.)\b/.test(source);
}

function isNonBoundaryCallArgument(node: Parser.SyntaxNode): boolean {
    if (node.parent?.type !== 'arguments') {
        return false;
    }

    const callExpr = node.parent.parent;
    if (callExpr?.type !== 'call_expression') {
        return false;
    }

    const methodName = getCallExpressionMethodName(callExpr);
    if (!methodName) {
        return false;
    }

    return NON_BOUNDARY_CALLBACK_METHODS.has(methodName.toLowerCase());
}

function isAnonymousNestedClosure(node: Parser.SyntaxNode): boolean {
    if (node.childForFieldName('name')) {
        return false;
    }

    const inferredName = resolveAnonymousName(node);
    if (inferredName !== 'anonymous') {
        return false;
    }

    const parentType = node.parent?.type;
    if (!parentType) {
        return false;
    }

    if (['public_field_definition', 'field_definition', 'property_definition', 'variable_declarator', 'pair', 'export_statement'].includes(parentType)) {
        return false;
    }

    return findEnclosingFunction(node.parent) !== null;
}

function findEnclosingFunction(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null {
    let current = node;
    while (current) {
        if (['function_declaration', 'method_definition', 'arrow_function', 'function'].includes(current.type)) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

function getCallExpressionMethodName(node: Parser.SyntaxNode): string | null {
    const callee = node.childForFieldName('function');
    if (!callee) return null;

    const property = callee.childForFieldName('property');
    if (property) return property.text;

    const name = callee.childForFieldName('name');
    if (name) return name.text;

    return callee.text || null;
}

function extractPrecedingComments(node: Parser.SyntaxNode): string {
    const precedingTypes = new Set(['comment', 'line_comment', 'block_comment', 'decorator']);
    let prefix = '';
    let current = node.previousSibling;
    while (current && precedingTypes.has(current.type)) {
        prefix = current.text + '\n' + prefix;
        current = current.previousSibling;
    }
    return prefix;
}

function extractExportedFunctionNames(rootNode: Parser.SyntaxNode): string[] {
    const names: string[] = [];

    for (const node of rootNode.children) {
        if (node.type !== 'export_statement') continue;

        const functionDecl = node.children.find(child => child.type === 'function_declaration');
        if (functionDecl) {
            const nameNode = functionDecl.childForFieldName('name');
            if (nameNode) names.push(nameNode.text);
            continue;
        }

        const lexicalDecl = node.children.find(child => child.type === 'lexical_declaration');
        if (lexicalDecl) {
            for (const child of lexicalDecl.children) {
                if (child.type === 'variable_declarator') {
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) names.push(nameNode.text);
                }
            }
            continue;
        }

        const exportClause = node.children.find(child => child.type === 'export_clause');
        if (exportClause) {
            for (const specifier of exportClause.children) {
                if (specifier.type !== 'export_specifier') continue;
                const aliasNode = specifier.childForFieldName('alias');
                const nameNode = specifier.childForFieldName('name');
                const exportedName = aliasNode ?? nameNode;
                if (exportedName) names.push(exportedName.text);
            }
        }
    }

    return [...new Set(names)];
}
