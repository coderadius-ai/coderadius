import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../../graph/types.js';
import type { FrameworkSignal, FrameworkSignalMetadataValue } from '../types.js';
// Framework-signal CONSUMPTION (match/format/overlay/merge) is language-agnostic
// and lives in the core. This plugin (a producer) imports back only the shared
// path/name helpers it needs (languages → core is the allowed direction).
import { normalizeHttpPath, lastSegment } from '../../framework-signal-overlay.js';

interface DecoratorInfo {
    rawText: string;
    name: string;
    argsText?: string;
    literalArgs: string[];
    packageName?: string;
    framework: string;
}

interface ImportBinding {
    localName: string;
    importedName: string;
    source: string;
}

const FUNCTION_ANCESTOR_TYPES = new Set([
    'function_declaration',
    'function',
    'method_definition',
    'arrow_function',
    'generator_function',
]);

const HTTP_METHOD_DECORATORS: Record<string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'> = {
    Get: 'GET',
    Post: 'POST',
    Put: 'PUT',
    Patch: 'PATCH',
    Delete: 'DELETE',
};

const FRAMEWORK_LABELS: Record<string, string> = {
    '@nestjs/common': 'NestJS',
    '@nestjs/graphql': 'NestJS GraphQL',
    '@nestjs/microservices': 'NestJS Microservices',
    '@nestjs/schedule': 'NestJS Schedule',
    '@nestjs/swagger': 'Nest Swagger',
    '@nestjs/cqrs': 'NestJS CQRS',
    '@golevelup/nestjs-rabbitmq': 'NestJS RabbitMQ',
    '@ssut/nestjs-sqs': 'NestJS SQS',
    'routing-controllers': 'routing-controllers',
    'tsoa': 'tsoa',
    'inversify-express-utils': 'inversify-express-utils',
    '@tsed/common': 'Ts.ED',
    '@tsed/di': 'Ts.ED',
    '@tsed/platform-params': 'Ts.ED',
    '@tsed/schema': 'Ts.ED',
    'type-graphql': 'type-graphql',
    'typeorm': 'TypeORM',
    '@mikro-orm/core': 'MikroORM',
    'sequelize-typescript': 'sequelize-typescript',
    'mongoose': 'Mongoose',
    '@nestjs/mongoose': 'NestJS Mongoose',
    '@typegoose/typegoose': 'Typegoose',
    'bull': 'Bull',
    'bullmq': 'BullMQ',
    'class-validator': 'class-validator',
    'class-transformer': 'class-transformer',
    'drizzle-orm/pg-core': 'Drizzle',
    'drizzle-orm/mysql-core': 'Drizzle',
    'drizzle-orm/sqlite-core': 'Drizzle',
};

const HTTP_CONTROLLER_DECORATORS = new Set(['Controller', 'JsonController', 'Route']);
const GRAPHQL_CLASS_DECORATORS = new Set(['Resolver']);
const ORM_CLASS_DECORATORS = new Set(['Entity', 'ViewEntity', 'ChildEntity', 'Table', 'Collection', 'Schema', 'modelOptions']);
const SCHEMA_CLASS_DECORATORS = new Set(['ObjectType', 'InputType', 'ArgsType', 'InterfaceType', 'Schema', 'ApiExtraModels']);
const SCHEMA_FIELD_DECORATORS = new Set(['ApiProperty', 'ApiPropertyOptional', 'Field', 'Expose', 'Exclude', 'Type', 'IsOptional', 'IsEnum', 'IsArray', 'Column', 'Property', 'Prop', 'prop']);
const MESSAGE_METHOD_DECORATORS = new Set(['MessagePattern', 'EventPattern', 'RabbitSubscribe', 'RabbitRPC', 'SqsMessageHandler', 'SqsConsumerEventHandler', 'Process']);
const MESSAGE_CLASS_DECORATORS = new Set(['Processor']);
const SCHEDULE_DECORATORS = new Set(['Cron', 'Interval', 'Timeout']);
const CLI_DECORATORS = new Set(['Command', 'SubCommand', 'CommandRunner', 'Cli']);
const CQRS_DECORATORS = new Set(['CommandHandler', 'QueryHandler', 'EventsHandler']);
const AUTH_DECORATORS = new Set(['Auth', 'Authenticated', 'UseGuards']);
const AUTHZ_DECORATORS = new Set(['Authorized', 'Roles', 'Permissions', 'Scopes']);
const RATE_LIMIT_DECORATORS = new Set(['Throttle', 'RateLimit', 'RateLimited']);
const CACHE_DECORATORS = new Set(['CacheTTL', 'CacheKey', 'Cached']);
const TRANSACTION_DECORATORS = new Set(['Transactional', 'Transaction']);

const ORM_SUFFIXES = ['Entity', 'TableSchema', 'Schema', 'Model'];

interface CustomBrokerDecorator {
    keys: string[];
    capability: string;
}

const CUSTOM_MESSAGE_CONSUMER_DECORATORS = new Map<string, CustomBrokerDecorator>();

export function registerCustomMessageConsumerDecorator(
    name: string,
    keys: string[] = ['routingKey', 'queue', 'name', 'topic'],
    capability: string = 'message-consumer',
): void {
    CUSTOM_MESSAGE_CONSUMER_DECORATORS.set(name.toLowerCase(), { keys, capability });
}

/** Clear all custom decorator registrations. Called between repo ingestions for multi-repo isolation. */
export function clearCustomMessageConsumerDecorators(): void {
    CUSTOM_MESSAGE_CONSUMER_DECORATORS.clear();
}

export function extractTypeScriptFrameworkSignals(
    rootNode: Parser.SyntaxNode,
    source: string,
    filepath: string,
): FrameworkSignal[] {
    const bindings = collectImportBindings(rootNode);
    const signals: FrameworkSignal[] = [];

    const walk = (node: Parser.SyntaxNode, className?: string) => {
        if (node.type === 'class_declaration' || node.type === 'class') {
            const classNameNode = node.childForFieldName('name');
            const nextClassName = classNameNode?.text || className;

            if (nextClassName) {
                for (const decoratorNode of collectDecoratorsForNode(node)) {
                    const info = parseDecoratorInfo(decoratorNode, bindings);
                    const signal = createClassSignal(info, nextClassName, decoratorNode, filepath, source);
                    if (signal) signals.push(signal);
                }

                const classBody = node.childForFieldName('body') ?? node.children.find(child => child.type === 'class_body');
                if (classBody) {
                    for (const child of classBody.children) {
                        if (child.type === 'method_definition') {
                            const methodName = child.childForFieldName('name')?.text;
                            if (!methodName) continue;

                            for (const decoratorNode of collectDecoratorsForNode(child)) {
                                const info = parseDecoratorInfo(decoratorNode, bindings);
                                const signal = createMethodSignal(info, `${nextClassName}.${methodName}`, decoratorNode);
                                if (signal) signals.push(signal);
                            }
                        }

                        if (isFieldLikeNode(child)) {
                            const fieldName = getFieldName(child);
                            if (!fieldName) continue;

                            for (const decoratorNode of collectDecoratorsForNode(child)) {
                                const info = parseDecoratorInfo(decoratorNode, bindings);
                                const signal = createFieldSignal(info, `${nextClassName}.${fieldName}`, decoratorNode);
                                if (signal) signals.push(signal);
                            }
                        }
                    }
                }
            }
        }

        if (node.type === 'function_declaration') {
            const fnName = node.childForFieldName('name')?.text;
            if (fnName) {
                for (const decoratorNode of collectDecoratorsForNode(node)) {
                    const info = parseDecoratorInfo(decoratorNode, bindings);
                    const signal = createMethodSignal(info, fnName, decoratorNode);
                    if (signal) signals.push(signal);
                }
            }
        }

        if (node.type === 'variable_declarator') {
            const builderSignals = createBuilderSignals(node, bindings);
            if (builderSignals.length > 0) {
                signals.push(...builderSignals);
            }
        }

        let nextClassName = className;
        if (node.type === 'class_declaration' || node.type === 'class') {
            nextClassName = node.childForFieldName('name')?.text || className;
        }

        for (const child of node.children) {
            walk(child, nextClassName);
        }
    };

    walk(rootNode);
    return dedupeSignals(signals);
}

export function buildTypeScriptMetadataChunks(
    rootNode: Parser.SyntaxNode,
    source: string,
    filepath: string,
    signals: FrameworkSignal[],
): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const emitted = new Set<string>();
    const ormOwners = new Set(
        signals
            .filter(signal => signal.kind === 'orm-entity' && signal.scope !== 'field')
            .map(signal => signal.ownerName),
    );

    const walk = (node: Parser.SyntaxNode) => {
        if ((node.type === 'class_declaration' || node.type === 'class') && isTopLevelDeclaration(node)) {
            const className = node.childForFieldName('name')?.text;
            if (className && ormOwners.has(className) && !emitted.has(className)) {
                emitted.add(className);
                chunks.push({
                    name: `${className}::__class_metadata`,
                    filepath,
                    sourceCode: extractClassMetadataSource(node),
                    language: 'typescript',
                    startLine: node.startPosition.row + 1,
                    startColumn: node.startPosition.column + 1,
                    endLine: node.endPosition.row + 1,
                    endColumn: node.endPosition.column + 1,
                });
            }
        }

        if (node.type === 'variable_declarator' && isTopLevelDeclaration(node)) {
            const variableName = node.childForFieldName('name')?.text;
            if (variableName && ormOwners.has(variableName) && !emitted.has(variableName)) {
                emitted.add(variableName);
                chunks.push({
                    name: `${variableName}::__class_metadata`,
                    filepath,
                    sourceCode: extractNodeSource(source, node),
                    language: 'typescript',
                    startLine: node.startPosition.row + 1,
                    startColumn: node.startPosition.column + 1,
                    endLine: node.endPosition.row + 1,
                    endColumn: node.endPosition.column + 1,
                });
            }
        }

        for (const child of node.children) {
            walk(child);
        }
    };

    walk(rootNode);
    return chunks;
}

function createClassSignal(
    info: DecoratorInfo,
    className: string,
    decoratorNode: Parser.SyntaxNode,
    filepath: string,
    source: string,
): FrameworkSignal | null {
    if (HTTP_CONTROLLER_DECORATORS.has(info.name)) {
        return buildSignal(info, {
            kind: 'http-controller',
            scope: 'class',
            ownerName: className,
            resolvedName: normalizeHttpPath(resolveControllerPath(info)),
            metadata: {
                path: normalizeHttpPath(resolveControllerPath(info)),
                decoratorText: info.rawText,
                capability: 'http-handler',
            },
            node: decoratorNode,
        });
    }

    if (GRAPHQL_CLASS_DECORATORS.has(info.name)) {
        return buildSignal(info, {
            kind: 'graphql-resolver',
            scope: 'class',
            ownerName: className,
            resolvedName: info.literalArgs[0] || className,
            metadata: {
                decoratorText: info.rawText,
                capability: 'graphql-handler',
            },
            node: decoratorNode,
        });
    }

    if (MESSAGE_CLASS_DECORATORS.has(info.name)) {
        const channel = resolveMessageChannel(info, ['queue', 'name']);
        return buildSignal(info, {
            kind: 'message-processor',
            scope: 'class',
            ownerName: className,
            resolvedName: channel,
            metadata: {
                decoratorText: info.rawText,
                channel,
                decorator: info.name,
                capability: 'message-consumer',
            },
            node: decoratorNode,
        });
    }

    if (ORM_CLASS_DECORATORS.has(info.name) && isOrmDecorator(info)) {
        // Mongoose @Schema({ _id: false }) marks embedded subdocuments — they don't
        // have their own collection and must not be emitted as standalone entities.
        if (info.name === 'Schema' && resolveBooleanProperty(info.argsText, ['_id']) === false) {
            return null;
        }
        // TypeORM @ChildEntity() is a Single Table Inheritance discriminator —
        // it shares the parent @Entity's table and must not create a phantom DataContainer.
        if (info.name === 'ChildEntity') {
            return null;
        }
        const tableName = resolveOrmTableName(info) || toSnakeCase(stripKnownSuffix(className));
        return buildSignal(info, {
            kind: 'orm-entity',
            scope: 'class',
            ownerName: className,
            resolvedName: tableName,
            metadata: {
                tableName,
                filepath,
                sourceSnippet: extractNodeSource(source, decoratorNode.parent ?? decoratorNode),
                decoratorText: info.rawText,
                capability: 'orm-entity',
            },
            node: decoratorNode,
        });
    }

    if (SCHEMA_CLASS_DECORATORS.has(info.name) || isSchemaDecorator(info)) {
        return buildSignal(info, {
            kind: 'schema-structure',
            scope: 'class',
            ownerName: className,
            resolvedName: info.literalArgs[0] || className,
            metadata: {
                decoratorText: info.rawText,
                decorator: info.name,
            },
            node: decoratorNode,
        });
    }


    // ── Custom class-level consumer decorators (from coderadius.yaml) ────
    const customConsumer = CUSTOM_MESSAGE_CONSUMER_DECORATORS.get(info.name.toLowerCase());
    if (customConsumer) {
        const channel = resolveMessageChannel(info, customConsumer.keys);
        return buildSignal(info, {
            kind: "message-consumer",
            scope: "class",
            ownerName: className,
            resolvedName: channel,
            metadata: {
                decoratorText: info.rawText,
                channel,
                decorator: info.name,
                capability: customConsumer.capability,
                customDecorator: true,
            },
            node: decoratorNode,
        });
    }

    const capability = resolveCapabilityFromDecorator(info);
    if (capability) {
        return buildSignal(info, {
            kind: 'capability',
            scope: 'class',
            ownerName: className,
            metadata: {
                decoratorText: info.rawText,
                capability,
                decorator: info.name,
            },
            node: decoratorNode,
        });
    }

    return null;
}

function createMethodSignal(
    info: DecoratorInfo,
    ownerName: string,
    decoratorNode: Parser.SyntaxNode,
): FrameworkSignal | null {
    if (info.name in HTTP_METHOD_DECORATORS) {
        return buildSignal(info, {
            kind: 'http-route',
            scope: 'method',
            ownerName,
            resolvedName: normalizeHttpPath(resolveRoutePath(info)) || '/',
            metadata: {
                decoratorText: info.rawText,
                httpMethod: HTTP_METHOD_DECORATORS[info.name],
                path: normalizeHttpPath(resolveRoutePath(info)) || '/',
                capability: 'http-handler',
            },
            node: decoratorNode,
        });
    }

    if (info.name === 'Query' || info.name === 'Mutation' || info.name === 'Subscription') {
        const graphqlOperation = info.name.toUpperCase();
        const opName = resolveGraphQLOperationName(info, ownerName);
        return buildSignal(info, {
            kind: 'graphql-operation',
            scope: 'method',
            ownerName,
            resolvedName: opName,
            metadata: {
                decoratorText: info.rawText,
                graphqlOperation,
                capability: 'graphql-handler',
            },
            node: decoratorNode,
        });
    }

    if (MESSAGE_METHOD_DECORATORS.has(info.name)) {
        const channel = resolveMessageChannel(info, ['queue', 'routingKey', 'pattern', 'name', 'subject', 'topic', 'exchange']);
        return buildSignal(info, {
            kind: 'message-consumer',
            scope: 'method',
            ownerName,
            resolvedName: channel,
            metadata: {
                decoratorText: info.rawText,
                channel,
                decorator: info.name,
                capability: 'message-consumer',
            },
            node: decoratorNode,
        });
    }

    const customConsumer = CUSTOM_MESSAGE_CONSUMER_DECORATORS.get(info.name.toLowerCase());
    if (customConsumer) {
        const channel = resolveMessageChannel(info, customConsumer.keys);
        return buildSignal(info, {
            kind: 'message-consumer',
            scope: 'method',
            ownerName,
            resolvedName: channel,
            metadata: {
                decoratorText: info.rawText,
                channel,
                decorator: info.name,
                capability: customConsumer.capability,
            },
            node: decoratorNode,
        });
    }

    if (SCHEDULE_DECORATORS.has(info.name)) {
        return buildSignal(info, {
            kind: 'scheduled-job',
            scope: 'method',
            ownerName,
            resolvedName: info.literalArgs[0],
            metadata: {
                decoratorText: info.rawText,
                schedule: info.literalArgs[0],
                capability: 'scheduled-job',
            },
            node: decoratorNode,
        });
    }

    if (CLI_DECORATORS.has(info.name)) {
        return buildSignal(info, {
            kind: 'cli-entrypoint',
            scope: 'method',
            ownerName,
            resolvedName: resolveNamedDecoratorTarget(info),
            metadata: {
                decoratorText: info.rawText,
                capability: 'cli-entrypoint',
            },
            node: decoratorNode,
        });
    }

    if (CQRS_DECORATORS.has(info.name)) {
        return buildSignal(info, {
            kind: 'cqrs-handler',
            scope: 'method',
            ownerName,
            resolvedName: info.literalArgs[0],
            metadata: {
                decoratorText: info.rawText,
                capability: 'cqrs-handler',
            },
            node: decoratorNode,
        });
    }

    const capability = resolveCapabilityFromDecorator(info);
    if (capability) {
        return buildSignal(info, {
            kind: 'capability',
            scope: 'method',
            ownerName,
            metadata: {
                decoratorText: info.rawText,
                capability,
                decorator: info.name,
            },
            node: decoratorNode,
        });
    }

    return null;
}

function createFieldSignal(
    info: DecoratorInfo,
    ownerName: string,
    decoratorNode: Parser.SyntaxNode,
): FrameworkSignal | null {
    if (!SCHEMA_FIELD_DECORATORS.has(info.name) && !isSchemaDecorator(info)) return null;

    const required = info.name === 'ApiPropertyOptional' || info.name === 'IsOptional'
        ? false
        : resolveBooleanProperty(info.argsText, ['required']);

    const alias = extractObjectLiteralStringProperty(info.argsText, ['name', 'alias', 'fieldName']);
    const fieldType = extractArrowTypeName(info.argsText) || info.literalArgs[0];

    return buildSignal(info, {
        kind: 'schema-field',
        scope: 'field',
        ownerName,
        resolvedName: alias || lastSegment(ownerName),
        metadata: {
            decoratorText: info.rawText,
            decorator: info.name,
            alias,
            required,
            fieldType,
        },
        node: decoratorNode,
    });
}

function createBuilderSignals(
    node: Parser.SyntaxNode,
    bindings: Map<string, ImportBinding>,
): FrameworkSignal[] {
    if (!isTopLevelDeclaration(node)) return [];

    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');
    if (!nameNode || !valueNode) return [];

    const variableName = nameNode.text;
    const signals: FrameworkSignal[] = [];

    if (valueNode.type === 'new_expression') {
        const ctor = valueNode.childForFieldName('constructor')?.text;
        const ctorName = lastSegment(ctor || '');
        const binding = ctorName ? bindings.get(ctorName) : undefined;
        const framework = binding ? resolveFrameworkLabel(binding.source) : 'TypeScript';
        const argsText = valueNode.childForFieldName('arguments')?.text || '';

        if (ctorName === 'EntitySchema' && (binding?.source === 'typeorm' || !binding?.source)) {
            const tableName = extractObjectLiteralStringProperty(argsText, ['name', 'tableName']) || toSnakeCase(stripKnownSuffix(variableName));
            signals.push({
                framework,
                kind: 'orm-entity',
                scope: 'module',
                ownerName: variableName,
                resolvedName: tableName,
                literalArgs: extractStringLiterals(argsText),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                confidence: 0.99,
                metadata: {
                    tableName,
                    builder: ctorName,
                    capability: 'orm-entity',
                },
            });
        }
    }

    if (valueNode.type === 'call_expression') {
        const calleeText = valueNode.childForFieldName('function')?.text || '';
        const calleeName = lastSegment(calleeText) || calleeText;
        const binding = bindings.get(calleeName);
        const framework = binding ? resolveFrameworkLabel(binding.source) : 'TypeScript';
        const argsText = valueNode.childForFieldName('arguments')?.text || '';
        const literalArgs = extractStringLiterals(argsText);

        if (['pgTable', 'mysqlTable', 'sqliteTable'].includes(calleeName)) {
            const tableName = literalArgs[0] || toSnakeCase(stripKnownSuffix(variableName));
            signals.push({
                framework: binding ? framework : 'Drizzle',
                kind: 'orm-entity',
                scope: 'module',
                ownerName: variableName,
                resolvedName: tableName,
                literalArgs,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                confidence: 0.99,
                metadata: {
                    tableName,
                    builder: calleeName,
                    capability: 'orm-entity',
                },
            });
        }

        if (calleeName === 'model' && (binding?.source === 'mongoose' || !binding?.source)) {
            const tableName = literalArgs[2] || pluralizeLower(literalArgs[0] || variableName);
            signals.push({
                framework: binding ? framework : 'Mongoose',
                kind: 'orm-entity',
                scope: 'module',
                ownerName: variableName,
                resolvedName: tableName,
                literalArgs,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                confidence: 0.95,
                metadata: {
                    tableName,
                    builder: calleeName,
                    capability: 'orm-entity',
                },
            });
        }
    }

    return signals;
}

function buildSignal(
    info: DecoratorInfo,
    params: {
        kind: string;
        scope: FrameworkSignal['scope'];
        ownerName: string;
        resolvedName?: string;
        metadata?: Record<string, FrameworkSignalMetadataValue>;
        node: Parser.SyntaxNode;
    },
): FrameworkSignal {
    return {
        framework: info.framework,
        kind: params.kind,
        scope: params.scope,
        ownerName: params.ownerName,
        resolvedName: params.resolvedName,
        literalArgs: info.literalArgs,
        startLine: params.node.startPosition.row + 1,
        endLine: params.node.endPosition.row + 1,
        confidence: 0.98,
        metadata: params.metadata,
    };
}

function collectImportBindings(rootNode: Parser.SyntaxNode): Map<string, ImportBinding> {
    const bindings = new Map<string, ImportBinding>();

    const walk = (node: Parser.SyntaxNode) => {
        if (node.type === 'import_statement') {
            const sourceNode = node.childForFieldName('source');
            const source = sourceNode ? stripQuotes(sourceNode.text) : '';
            const statement = node.text;

            const beforeFrom = statement.split(/\s+from\s+/)[0]
                .replace(/^import\s+/, '')
                .replace(/^type\s+/, '')
                .trim();

            if (beforeFrom.startsWith('* as ')) {
                const alias = beforeFrom.slice('* as '.length).trim();
                bindings.set(alias, { localName: alias, importedName: '*', source });
            } else if (beforeFrom.startsWith('{')) {
                parseNamedImports(beforeFrom, source, bindings);
            } else if (beforeFrom.includes('{')) {
                const [defaultPart, namedPart] = beforeFrom.split('{');
                const defaultImport = defaultPart.replace(/,$/, '').trim();
                if (defaultImport) {
                    bindings.set(defaultImport, { localName: defaultImport, importedName: 'default', source });
                }
                parseNamedImports(`{${namedPart}`, source, bindings);
            } else if (beforeFrom.length > 0) {
                bindings.set(beforeFrom, { localName: beforeFrom, importedName: 'default', source });
            }
        }

        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    return bindings;
}

function parseNamedImports(
    clause: string,
    source: string,
    bindings: Map<string, ImportBinding>,
): void {
    const inner = clause.trim().replace(/^\{/, '').replace(/\}$/, '');
    for (const rawPart of inner.split(',')) {
        const part = rawPart.trim();
        if (!part) continue;

        const [importedName, localName] = part.split(/\s+as\s+/).map(piece => piece.trim());
        const resolvedLocal = localName || importedName;
        bindings.set(resolvedLocal, {
            localName: resolvedLocal,
            importedName,
            source,
        });
    }
}

function collectDecoratorsForNode(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const decorators = node.children.filter(child => child.type === 'decorator');
    const parent = node.parent;
    if (!parent) return decorators;

    const idx = parent.children.findIndex(child => child.id === node.id);
    if (idx === -1) return decorators;

    if (parent.type === 'export_statement') {
        const exportedDecorators = parent.children
            .slice(0, idx)
            .filter(child => child.type === 'decorator');
        return [...exportedDecorators, ...decorators];
    }

    const leading: Parser.SyntaxNode[] = [];
    for (let i = idx - 1; i >= 0; i--) {
        const sibling = parent.children[i];
        if (sibling.type === 'decorator') {
            leading.unshift(sibling);
            continue;
        }
        if (sibling.type === 'comment' || isModifierNode(sibling)) continue;
        break;
    }

    return [...leading, ...decorators];
}

function parseDecoratorInfo(
    node: Parser.SyntaxNode,
    bindings: Map<string, ImportBinding>,
): DecoratorInfo {
    const rawText = node.text.trim();
    const match = rawText.match(/^@([\w$.]+)(?:\(([\s\S]*)\))?$/);
    const fullName = match?.[1] || rawText.replace(/^@/, '');
    const name = lastSegment(fullName) || fullName;
    const argsText = match?.[2]?.trim();
    const binding = bindings.get(name);
    const packageName = binding?.source;

    return {
        rawText,
        name,
        argsText,
        literalArgs: extractStringLiterals(argsText),
        packageName,
        framework: resolveFrameworkLabel(packageName, name),
    };
}

function resolveFrameworkLabel(packageName?: string, decoratorName?: string): string {
    if (packageName && FRAMEWORK_LABELS[packageName]) return FRAMEWORK_LABELS[packageName];
    if (packageName) return packageName;

    if (decoratorName && ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Controller', 'UseGuards'].includes(decoratorName)) {
        return 'Decorator HTTP';
    }
    if (decoratorName && ['Query', 'Mutation', 'Subscription', 'Resolver', 'Field', 'ObjectType', 'InputType'].includes(decoratorName)) {
        return 'Decorator GraphQL';
    }
    if (decoratorName && ['Entity', 'Table', 'Column', 'Property'].includes(decoratorName)) {
        return 'Decorator ORM';
    }
    return 'TypeScript';
}

function resolveControllerPath(info: DecoratorInfo): string | undefined {
    return extractObjectLiteralStringProperty(info.argsText, ['path', 'route'])
        || info.literalArgs[0];
}

function resolveRoutePath(info: DecoratorInfo): string | undefined {
    return extractObjectLiteralStringProperty(info.argsText, ['path', 'route'])
        || info.literalArgs[0];
}

function resolveGraphQLOperationName(info: DecoratorInfo, ownerName: string): string {
    return extractObjectLiteralStringProperty(info.argsText, ['name'])
        || info.literalArgs[0]
        || lastSegment(ownerName);
}

function resolveOrmTableName(info: DecoratorInfo): string | undefined {
    return extractObjectLiteralStringProperty(info.argsText, [
        'name',
        'tableName',
        'collection',
    ]) || info.literalArgs[0];
}

function resolveNamedDecoratorTarget(info: DecoratorInfo): string | undefined {
    return extractObjectLiteralStringProperty(info.argsText, ['name', 'command'])
        || info.literalArgs[0];
}

function resolveMessageChannel(
    info: DecoratorInfo,
    keys: string[],
): string | undefined {
    return extractObjectLiteralStringProperty(info.argsText, keys)
        || info.literalArgs[0];
}

function resolveCapabilityFromDecorator(info: DecoratorInfo): string | null {
    if (AUTH_DECORATORS.has(info.name)) return 'authenticated-endpoint';
    if (AUTHZ_DECORATORS.has(info.name)) return 'authorized-endpoint';
    if (RATE_LIMIT_DECORATORS.has(info.name)) return 'rate-limited-endpoint';
    if (CACHE_DECORATORS.has(info.name)) return 'cached-endpoint';
    if (TRANSACTION_DECORATORS.has(info.name)) return 'transactional';

    if (info.name === 'UseInterceptors' && /CacheInterceptor/.test(info.argsText || '')) {
        return 'cached-endpoint';
    }

    return null;
}

function isOrmDecorator(info: DecoratorInfo): boolean {
    if (info.packageName && ['typeorm', '@mikro-orm/core', 'sequelize-typescript', '@nestjs/mongoose', '@typegoose/typegoose', 'mongoose'].includes(info.packageName)) {
        return true;
    }
    return ORM_CLASS_DECORATORS.has(info.name);
}

function isSchemaDecorator(info: DecoratorInfo): boolean {
    return Boolean(info.packageName && ['@nestjs/swagger', 'type-graphql', 'class-validator', 'class-transformer', '@nestjs/graphql'].includes(info.packageName));
}

function extractStringLiterals(text?: string): string[] {
    if (!text) return [];
    const matches = [...text.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)];
    return matches
        .map(match => match[2])
        .filter(value => !value.includes('${'));
}

function extractObjectLiteralStringProperty(
    text: string | undefined,
    propertyNames: string[],
): string | undefined {
    if (!text) return undefined;

    for (const propertyName of propertyNames) {
        const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`${escaped}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`);
        const match = text.match(regex);
        if (match && !match[2].includes('${')) return match[2];
    }

    return undefined;
}

function extractArrowTypeName(text?: string): string | undefined {
    if (!text) return undefined;
    const match = text.match(/\(\)\s*=>\s*([A-Za-z_][A-Za-z0-9_]*)/);
    return match?.[1];
}

function resolveBooleanProperty(
    text: string | undefined,
    propertyNames: string[],
): boolean | undefined {
    if (!text) return undefined;

    for (const propertyName of propertyNames) {
        const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`${escaped}\\s*:\\s*(true|false)`);
        const match = text.match(regex);
        if (match) return match[1] === 'true';
    }

    return undefined;
}

function isFieldLikeNode(node: Parser.SyntaxNode): boolean {
    return node.type === 'public_field_definition'
        || node.type === 'property_signature'
        || node.type === 'field_definition';
}

function isModifierNode(node: Parser.SyntaxNode): boolean {
    return node.type === 'export'
        || node.type === 'default'
        || node.type === 'async'
        || node.type === 'public'
        || node.type === 'private'
        || node.type === 'protected'
        || node.type === 'static'
        || node.type === 'abstract'
        || node.type === 'readonly'
        || node.type === 'override';
}

function getFieldName(node: Parser.SyntaxNode): string | undefined {
    return node.childForFieldName('name')?.text
        || node.children.find(child => child.type === 'property_identifier' || child.type === 'identifier')?.text;
}

function isTopLevelDeclaration(node: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (FUNCTION_ANCESTOR_TYPES.has(current.type) || current.type === 'class_body') return false;
        current = current.parent;
    }
    return true;
}

function extractClassMetadataSource(node: Parser.SyntaxNode): string {
    const decorators = collectDecoratorsForNode(node).map(decorator => decorator.text);
    const className = node.childForFieldName('name')?.text || 'AnonymousClass';
    const heritage = node.children
        .filter(child => child.type === 'extends_clause' || child.type === 'implements_clause')
        .map(child => child.text)
        .join(' ');

    const fieldLines: string[] = [];
    const classBody = node.childForFieldName('body') ?? node.children.find(child => child.type === 'class_body');
    if (classBody) {
        for (const child of classBody.children) {
            if (!isFieldLikeNode(child)) continue;
            fieldLines.push(child.text);
        }
    }

    return [
        ...decorators,
        `class ${className}${heritage ? ` ${heritage}` : ''} {`,
        ...fieldLines,
        '}',
    ].join('\n');
}

function dedupeSignals(signals: FrameworkSignal[]): FrameworkSignal[] {
    const seen = new Set<string>();
    const deduped: FrameworkSignal[] = [];

    for (const signal of signals) {
        const key = [
            signal.scope,
            signal.ownerName,
            signal.kind,
            signal.resolvedName ?? '',
            signal.framework,
        ].join('|');

        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(signal);
    }

    return deduped;
}

function toSnakeCase(value: string): string {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[.\-\s]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

function stripKnownSuffix(value: string): string {
    for (const suffix of ORM_SUFFIXES) {
        if (value.endsWith(suffix) && value.length > suffix.length) {
            return value.slice(0, -suffix.length);
        }
    }
    return value;
}

function pluralizeLower(value: string): string {
    const base = stripKnownSuffix(value);
    const lower = base.toLowerCase();
    return lower.endsWith('s') ? lower : `${lower}s`;
}

function stripQuotes(value: string): string {
    return value.replace(/^['"`]|['"`]$/g, '');
}

function extractNodeSource(source: string, node: Parser.SyntaxNode): string {
    return source.slice(node.startIndex, node.endIndex);
}
