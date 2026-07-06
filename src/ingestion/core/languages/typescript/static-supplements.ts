import crypto from 'node:crypto';
import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../../graph/types.js';
import type {
    ClientBinding,
    ResourceDeclaration,
    StaticSupplementalResult,
} from '../types.js';

const DEFAULT_PORTS: Record<string, number> = {
    mongodb: 27017,
    mysql: 3306,
    mariadb: 3306,
    postgres: 5432,
};

type UseFactoryContext = {
    pairNode: Parser.SyntaxNode;
    valueNode: Parser.SyntaxNode;
    objectNode: Parser.SyntaxNode;
    callNode: Parser.SyntaxNode | null;
};

export function extractTypeScriptStaticSupplements(
    rootNode: Parser.SyntaxNode,
    source: string,
    filepath: string,
    chunk: CodeChunk,
): StaticSupplementalResult | null {
    const resourceDeclarations: ResourceDeclaration[] = [];
    const clientBindings: ClientBinding[] = [];
    const matchedUseFactory = findUseFactoryContext(rootNode, chunk);

    if (matchedUseFactory) {
        resourceDeclarations.push(...extractDeclarationsFromUseFactory(matchedUseFactory, chunk, source));

        const binding = extractClientBindingFromUseFactory(matchedUseFactory, source);
        if (binding) clientBindings.push(binding);
    }

    resourceDeclarations.push(...extractProviderConstructorDeclarations(chunk));

    if (resourceDeclarations.length === 0 && clientBindings.length === 0) {
        return null;
    }

    return {
        resourceDeclarations: dedupeDeclarations(resourceDeclarations),
        clientBindings: dedupeClientBindings(clientBindings),
    };
}

function extractDeclarationsFromUseFactory(
    ctx: UseFactoryContext,
    chunk: CodeChunk,
    source: string,
): ResourceDeclaration[] {
    const callText = ctx.callNode?.childForFieldName('function')?.text ?? ctx.callNode?.text ?? '';
    const chunkSource = chunk.sourceCode;
    const envVars = chunk.envVars ?? [];

    if (/TypeOrmModule\.forRoot(?:Async)?$/.test(callText)) {
        const parsed = parseTypeOrmConfig(chunkSource, source);
        if (!parsed) return [];
        return [buildDeclaration(parsed, envVars, 'nestjs-for-root', chunkSource)];
    }

    if (/(MongooseModule|MongoDatabaseModule)\.forRoot(?:Async)?$/.test(callText)) {
        const parsed = parseMongoConfig(chunkSource, source);
        if (!parsed) return [];
        return [buildDeclaration(parsed, envVars, 'nestjs-for-root', chunkSource)];
    }

    return [];
}

function extractProviderConstructorDeclarations(chunk: CodeChunk): ResourceDeclaration[] {
    const declarations: ResourceDeclaration[] = [];
    const source = chunk.sourceCode;
    const envVars = chunk.envVars ?? [];

    if (/new\s+MemcachedRepository\s*\(/.test(source)) {
        declarations.push(buildDeclaration({
            logicalId: 'memcached',
            technology: 'memcached',
        }, envVars, 'provider-factory', 'new MemcachedRepository(...)'));
    }

    if (/new\s+InfluxDbMonitoringRepository\s*\(/.test(source)) {
        declarations.push(buildDeclaration({
            logicalId: 'influxdb',
            technology: 'influxdb',
        }, envVars, 'provider-factory', 'new InfluxDbMonitoringRepository(...)'));
    }

    return declarations;
}

function extractClientBindingFromUseFactory(
    ctx: UseFactoryContext,
    source: string,
): ClientBinding | null {
    const token = extractProvideToken(ctx.objectNode);
    if (!token) return null;

    const body = ctx.valueNode.text;
    const isUrql = /\b(createClient|new\s+Client)\s*\(/.test(body) && /\burql\b/.test(source);
    const isApollo = /\bnew\s+ApolloClient\s*\(/.test(body) && /@apollo\/client/.test(source);

    if (!isUrql && !isApollo) return null;

    const urlLiteral = extractObjectLiteralString(body, ['url', 'uri']);
    const urlExpression = urlLiteral ? undefined : extractObjectLiteralExpression(body, ['url', 'uri']);
    const baseUrlHint = urlLiteral
        || (urlExpression ? extractAssignedExpression(body, [urlExpression]) ?? urlExpression : undefined)
        || extractAssignedExpression(body, ['gqlApiUrl', 'graphqlUrl', 'baseUrl', 'url']);

    return {
        token,
        clientKind: isApollo ? 'apollo' : 'urql',
        protocol: 'graphql',
        typeName: isApollo ? 'ApolloClient' : 'Client',
        baseUrlHint,
        evidence: firstNonEmptyLine(body),
    };
}

function parseTypeOrmConfig(source: string, lookupSource: string = source): {
    logicalId: string;
    technology: string;
    dbName?: string;
    host?: string;
    port?: number;
    endpointKey?: string;
    configuredVia?: string[];
} | null {
    const explicitType = extractObjectLiteralString(source, ['type'])?.toLowerCase();
    const url = extractObjectLiteralString(source, ['url', 'uri']);
    const urlEnvKey = url ? undefined : extractObjectLiteralEnvAccessor(source, ['url', 'uri'], lookupSource);
    const parsedUrl = url ? parseConnectionUrl(url, explicitType) : null;
    const technology = explicitType || parsedUrl?.technology;
    const dbName = extractObjectLiteralString(source, ['database']) || parsedUrl?.dbName;
    const dbNameEnvKey = dbName ? undefined : extractObjectLiteralEnvAccessor(source, ['database'], lookupSource);
    const host = extractObjectLiteralString(source, ['host']) || parsedUrl?.host;
    const hostEnvKey = host ? undefined : extractObjectLiteralEnvAccessor(source, ['host'], lookupSource);
    const port = extractObjectLiteralNumber(source, ['port']) || parsedUrl?.port;
    const portEnvKey = port ? undefined : extractObjectLiteralEnvAccessor(source, ['port'], lookupSource);
    const logicalId = dbName || buildEnvBackedLogicalId(dbNameEnvKey || urlEnvKey);

    if (!technology || !logicalId) return null;
    const endpointKey = host && port && dbName ? computeEndpointKey(host, port, dbName) : undefined;

    return {
        logicalId,
        technology,
        dbName,
        host,
        port,
        endpointKey,
        configuredVia: [dbNameEnvKey, hostEnvKey, portEnvKey, urlEnvKey].filter((value): value is string => Boolean(value)),
    };
}

function parseMongoConfig(source: string, lookupSource: string = source): {
    logicalId: string;
    technology: string;
    dbName?: string;
    host?: string;
    port?: number;
    endpointKey?: string;
    configuredVia?: string[];
} | null {
    const uri = extractObjectLiteralString(source, ['uri', 'url']);
    const uriEnvKey = uri ? undefined : extractObjectLiteralEnvAccessor(source, ['uri', 'url'], lookupSource);
    const parsedUrl = uri ? parseConnectionUrl(uri, 'mongodb') : null;
    const dbName = extractObjectLiteralString(source, ['dbName', 'database']) || parsedUrl?.dbName;
    const dbNameEnvKey = dbName ? undefined : extractObjectLiteralEnvAccessor(source, ['dbName', 'database'], lookupSource);
    const host = parsedUrl?.host;
    const port = parsedUrl?.port;
    const logicalId = dbName || buildEnvBackedLogicalId(dbNameEnvKey || uriEnvKey);

    // If we detected MongooseModule.forRootAsync but couldn't extract a connection URI
    // or dbName (e.g. NestJS @ConfigType DI injection), fall back to technology-only identity.
    // A mongodb datastore with a generic logicalId is better than missing the dependency entirely.
    if (!logicalId) {
        return {
            logicalId: 'mongodb',
            technology: 'mongodb',
            configuredVia: [dbNameEnvKey, uriEnvKey].filter((value): value is string => Boolean(value)),
        };
    }

    return {
        logicalId,
        technology: 'mongodb',
        dbName,
        host,
        port,
        endpointKey: host && port && dbName ? computeEndpointKey(host, port, dbName) : undefined,
        configuredVia: [dbNameEnvKey, uriEnvKey].filter((value): value is string => Boolean(value)),
    };
}

function buildDeclaration(
    parsed: {
        logicalId: string;
        technology: string;
        dbName?: string;
        host?: string;
        port?: number;
        endpointKey?: string;
        configuredVia?: string[];
    },
    envVars: string[],
    declarationSource: ResourceDeclaration['declarationSource'],
    evidence: string,
): ResourceDeclaration {
    const configuredVia = [...new Set([...(parsed.configuredVia ?? []), ...envVars])];

    return {
        kind: 'datastore',
        logicalId: parsed.logicalId,
        technology: parsed.technology,
        evidence,
        host: parsed.host,
        port: parsed.port,
        dbName: parsed.dbName,
        endpointKey: parsed.endpointKey,
        configuredVia: configuredVia.length > 0 ? configuredVia : undefined,
        declarationSource,
    };
}

function findUseFactoryContext(rootNode: Parser.SyntaxNode, chunk: CodeChunk): UseFactoryContext | null {
    let matched: UseFactoryContext | null = null;

    const walk = (node: Parser.SyntaxNode) => {
        if (matched) return;
        if (node.type === 'pair') {
            const keyNode = node.childForFieldName('key');
            const valueNode = node.childForFieldName('value');
            if (keyNode?.text === 'useFactory' && valueNode && nodeOverlapsChunk(valueNode, chunk)) {
                matched = {
                    pairNode: node,
                    valueNode,
                    objectNode: findAncestor(node, 'object') ?? node.parent ?? node,
                    callNode: findAncestor(node, 'call_expression'),
                };
                return;
            }
        }

        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    return matched;
}

function extractProvideToken(objectNode: Parser.SyntaxNode): string | null {
    for (const child of objectNode.children) {
        if (child.type !== 'pair') continue;
        const keyNode = child.childForFieldName('key');
        const valueNode = child.childForFieldName('value');
        if (keyNode?.text !== 'provide' || !valueNode) continue;
        return stripQuotes(valueNode.text);
    }
    return null;
}

function extractObjectLiteralString(source: string, keys: string[]): string | undefined {
    for (const key of keys) {
        const escaped = escapeRegex(key);
        const match = source.match(new RegExp(`${escaped}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`));
        if (match && !match[2].includes('${')) {
            return match[2];
        }
    }
    return undefined;
}

function extractAssignedExpression(source: string, names: string[]): string | undefined {
    for (const name of names) {
        const escaped = escapeRegex(name);
        const assignment = source.match(new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*([^;\\n]+)`));
        if (assignment?.[1]) return assignment[1].trim();
    }

    for (const key of names) {
        const escaped = escapeRegex(key);
        const pair = source.match(new RegExp(`${escaped}\\s*:\\s*([^,}\\n]+)`));
        if (pair?.[1]) return pair[1].trim();
    }
    return undefined;
}

function extractObjectLiteralExpression(source: string, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = extractObjectLiteralExpressionForKey(source, key);
        if (value) return value;
    }
    return undefined;
}

function extractObjectLiteralNumber(source: string, keys: string[]): number | undefined {
    for (const key of keys) {
        const escaped = escapeRegex(key);
        const match = source.match(new RegExp(`${escaped}\\s*:\\s*(\\d+)`));
        if (match) return parseInt(match[1], 10);
    }
    return undefined;
}

function extractObjectLiteralEnvAccessor(source: string, keys: string[], lookupSource: string = source): string | undefined {
    for (const key of keys) {
        const expression = extractObjectLiteralExpressionForKey(source, key);
        if (!expression) continue;
        const envKey = resolveEnvAccessorExpression(expression, lookupSource);
        if (envKey) return envKey;
    }
    return undefined;
}

function extractObjectLiteralExpressionForKey(source: string, key: string): string | undefined {
    const matcher = new RegExp(`${escapeRegex(key)}\\s*:`, 'g');
    let match: RegExpExecArray | null;

    while ((match = matcher.exec(source)) !== null) {
        const expression = readDelimitedExpression(source, match.index + match[0].length);
        if (expression) return expression;
    }

    return undefined;
}

function readDelimitedExpression(source: string, startIndex: number): string | undefined {
    let index = startIndex;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) return undefined;

    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let quote: '"' | '\'' | '`' | null = null;
    let escaped = false;

    for (let cursor = index; cursor < source.length; cursor += 1) {
        const char = source[cursor];

        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === '\'' || char === '`') {
            quote = char;
            continue;
        }

        if (char === '(') {
            parenDepth += 1;
            continue;
        }
        if (char === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
            continue;
        }
        if (char === '{') {
            braceDepth += 1;
            continue;
        }
        if (char === '}') {
            if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                return source.slice(index, cursor).trim() || undefined;
            }
            braceDepth = Math.max(0, braceDepth - 1);
            continue;
        }
        if (char === '[') {
            bracketDepth += 1;
            continue;
        }
        if (char === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            continue;
        }
        if (char === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
            return source.slice(index, cursor).trim() || undefined;
        }
    }

    return source.slice(index).trim() || undefined;
}

function resolveEnvAccessorExpression(expression: string, source: string): string | undefined {
    const unwrapped = unwrapExpression(expression);

    const processEnvDot = unwrapped.match(/^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (processEnvDot && isLikelyEnvVarName(processEnvDot[1])) return processEnvDot[1];

    const processEnvBracket = unwrapped.match(/^process\.env\[\s*([^\]]+)\s*\]$/);
    if (processEnvBracket) {
        const resolved = resolveStringLiteralValue(processEnvBracket[1], source);
        if (resolved && isLikelyEnvVarName(resolved)) return resolved;
    }

    const configCall = unwrapped.match(
        /^(?:this\.)?(?:cfg|config|[A-Za-z_$][A-Za-z0-9_$]*config[A-Za-z0-9_$]*)(?:\??\.)get(?:OrThrow)?(?:<[^>]+>)?\(\s*([^,)\n]+?)\s*(?:,[^)]*)?\)$/i,
    );
    if (!configCall) return undefined;

    const resolved = resolveStringLiteralValue(configCall[1], source);
    if (resolved && isLikelyEnvVarName(resolved)) return resolved;
    return undefined;
}

function resolveStringLiteralValue(expression: string, source: string): string | undefined {
    const unwrapped = unwrapExpression(expression);
    const literal = extractLiteralStringValue(unwrapped);
    if (literal !== undefined) return literal;

    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(unwrapped)) {
        return extractModuleConstStringValue(source, unwrapped);
    }

    const memberMatch = unwrapped.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (memberMatch) {
        return extractStaticReadonlyStringValue(source, memberMatch[1], memberMatch[2]);
    }

    return undefined;
}

function unwrapExpression(expression: string): string {
    let current = expression.trim();
    let changed = true;

    while (changed) {
        changed = false;

        if (current.startsWith('(') && current.endsWith(')') && isBalancedParenthesized(current)) {
            current = current.slice(1, -1).trim();
            changed = true;
            continue;
        }

        current = current.replace(/\s+as\s+[A-Za-z_$][A-Za-z0-9_$<>\[\]|&.,\s]*$/g, '').trim();
        current = current.replace(/!$/, '').trim();

        const wrapper = current.match(/^(?:Number|String|Boolean|parseInt|parseFloat)\(\s*([\s\S]*?)\s*(?:,\s*[^)]*)?\)$/);
        if (wrapper?.[1]) {
            current = wrapper[1].trim();
            changed = true;
        }
    }

    return current;
}

function isBalancedParenthesized(expression: string): boolean {
    let depth = 0;
    let quote: '"' | '\'' | '`' | null = null;
    let escaped = false;

    for (let index = 0; index < expression.length; index += 1) {
        const char = expression[index];

        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) quote = null;
            continue;
        }

        if (char === '"' || char === '\'' || char === '`') {
            quote = char;
            continue;
        }
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (depth === 0 && index < expression.length - 1) return false;
    }

    return depth === 0;
}

function extractLiteralStringValue(expression: string): string | undefined {
    const match = expression.match(/^(['"`])([\s\S]*)\1$/);
    if (!match || match[2].includes('${')) return undefined;
    return match[2];
}

function extractModuleConstStringValue(source: string, name: string): string | undefined {
    const escaped = escapeRegex(name);
    const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${escaped}\\s*=\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`));
    if (!match || match[2].includes('${')) return undefined;
    return match[2];
}

function extractStaticReadonlyStringValue(source: string, className: string, fieldName: string): string | undefined {
    const classEscaped = escapeRegex(className);
    const fieldEscaped = escapeRegex(fieldName);
    const match = source.match(
        new RegExp(
            `class\\s+${classEscaped}\\b[\\s\\S]*?\\b(?:public|private|protected)?\\s*static\\s+readonly\\s+${fieldEscaped}\\s*=\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`,
        ),
    );
    if (!match || match[2].includes('${')) return undefined;
    return match[2];
}

function isLikelyEnvVarName(value: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(value);
}

function buildEnvBackedLogicalId(envKey?: string): string | undefined {
    if (!envKey || !isLikelyEnvVarName(envKey)) return undefined;
    return `env:${envKey.toLowerCase()}`;
}

function parseConnectionUrl(
    rawUrl: string,
    technologyHint?: string,
): { technology: string; host: string; port: number; dbName: string } | null {
    if (/\$\{/.test(rawUrl)) return null;

    try {
        const parsed = new URL(rawUrl);
        const technology = normalizeTechnology(technologyHint || parsed.protocol.replace(/:$/, ''));
        if (!technology) return null;

        const dbName = parsed.pathname.replace(/^\/+/, '').split('/')[0];
        if (!dbName) return null;

        return {
            technology,
            host: parsed.hostname,
            port: parsed.port ? parseInt(parsed.port, 10) : (DEFAULT_PORTS[technology] ?? 0),
            dbName,
        };
    } catch {
        return null;
    }
}

function normalizeTechnology(raw?: string): string | null {
    if (!raw) return null;
    const value = raw.toLowerCase();
    if (value === 'postgresql') return 'postgres';
    if (value === 'mongodb+srv') return 'mongodb';
    if (['postgres', 'mysql', 'mariadb', 'mongodb', 'memcached', 'influxdb'].includes(value)) return value;
    return null;
}

function computeEndpointKey(host: string, port: number, dbName: string): string {
    const raw = `${host.toLowerCase()}:${port}/${dbName.toLowerCase()}`;
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

function nodeOverlapsChunk(node: Parser.SyntaxNode, chunk: CodeChunk): boolean {
    const nodeStartLine = node.startPosition.row + 1;
    const nodeEndLine = node.endPosition.row + 1;
    return nodeStartLine <= chunk.endLine && nodeEndLine >= chunk.startLine;
}

function findAncestor(node: Parser.SyntaxNode | null | undefined, type: string): Parser.SyntaxNode | null {
    let current = node?.parent ?? null;
    while (current) {
        if (current.type === type) return current;
        current = current.parent;
    }
    return null;
}

function firstNonEmptyLine(text: string): string {
    return text.split('\n').map(line => line.trim()).find(Boolean) ?? text.trim();
}

function stripQuotes(value: string): string {
    return value.replace(/^['"`]|['"`]$/g, '');
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupeDeclarations(items: ResourceDeclaration[]): ResourceDeclaration[] {
    const seen = new Set<string>();
    return items.filter(item => {
        const key = `${item.technology}|${item.logicalId}|${item.endpointKey ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function dedupeClientBindings(items: ClientBinding[]): ClientBinding[] {
    const seen = new Set<string>();
    return items.filter(item => {
        const key = `${item.token}|${item.clientKind}|${item.protocol}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
