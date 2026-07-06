import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../graph/types.js';
import {
    canonicalKey,
    extractEnvKey,
    extractStringLiteral,
} from './index.js';
import type {
    CriticalInvocationFact,
    ResolvedOperation,
    ResolvedResourceType,
    ValueFact,
} from './types.js';

type ResourceSpec = {
    resourceType: ResolvedResourceType;
    operation: ResolvedOperation;
    role: string;
    confidence?: number;
};

const RESOURCE_KEYS: Record<string, ResourceSpec> = {
    topic: { resourceType: 'MessageChannel', operation: 'WRITES', role: 'topic' },
    topicName: { resourceType: 'MessageChannel', operation: 'WRITES', role: 'topicName' },
    queue: { resourceType: 'MessageChannel', operation: 'READS', role: 'queue' },
    queueName: { resourceType: 'MessageChannel', operation: 'READS', role: 'queueName' },
    routingKey: { resourceType: 'MessageChannel', operation: 'WRITES', role: 'routingKey' },
    exchange: { resourceType: 'MessageChannel', operation: 'WRITES', role: 'exchange' },
    collection: { resourceType: 'Database', operation: 'WRITES', role: 'collection', confidence: 0.92 },
    table: { resourceType: 'Database', operation: 'WRITES', role: 'table', confidence: 0.92 },
    tableName: { resourceType: 'Database', operation: 'WRITES', role: 'tableName', confidence: 0.92 },
    bucket: { resourceType: 'ObjectStorage', operation: 'WRITES', role: 'bucket' },
    bucketName: { resourceType: 'ObjectStorage', operation: 'WRITES', role: 'bucketName' },
    url: { resourceType: 'ExternalAPI', operation: 'READS', role: 'url', confidence: 0.9 },
    endpoint: { resourceType: 'ExternalAPI', operation: 'READS', role: 'endpoint', confidence: 0.9 },
};

export function extractTypeScriptValueFacts(rootNode: Parser.SyntaxNode, _source: string, filepath: string): ValueFact[] {
    const facts: ValueFact[] = [];

    const add = (fact: Omit<ValueFact, 'filePath' | 'language' | 'confidence'> & { confidence?: number }) => {
        facts.push({
            filePath: filepath,
            language: 'typescript',
            ...fact,
            confidence: fact.confidence ?? 1,
        });
    };

    const visitLexical = (node: Parser.SyntaxNode): void => {
        const isConst = node.children.some(child => child.type === 'const' || child.text === 'const');
        if (!isConst) return;
        const exported = node.parent?.type === 'export_statement';

        for (const declarator of node.children) {
            if (declarator.type !== 'variable_declarator') continue;
            const nameNode = declarator.childForFieldName('name');
            const valueNode = declarator.childForFieldName('value');
            if (!nameNode || !valueNode) continue;

            extractTsValueForKey(nameNode.text, valueNode, exported, add);
        }
    };

    const visitClasses = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration' || node.type === 'class') {
            const className = node.childForFieldName('name')?.text;
            const body = node.childForFieldName('body');
            if (className && body) {
                for (const member of body.children) {
                    if (member.type === 'public_field_definition') {
                        const hasReadonly = member.children.some(child => child.type === 'readonly');
                        if (!hasReadonly) continue;
                        const isStatic = member.children.some(child => child.type === 'static');
                        const nameNode = member.childForFieldName('name');
                        const valueNode = member.childForFieldName('value');
                        if (!nameNode || !valueNode) continue;
                        extractTsValueForKey(
                            isStatic ? `${className}.${nameNode.text}` : `this.${nameNode.text}`,
                            valueNode,
                            false,
                            add,
                        );
                    } else if (member.type === 'method_definition' && member.childForFieldName('name')?.text === 'constructor') {
                        visitConstructorInjectedParams(member, add);
                    }
                }
            }
        }

        for (const child of node.children) visitClasses(child);
    };

    // NestJS config-factory pattern: `export default registerAs('scope', () =>
    // ({ key: value }))` (also `defineConfig(...)`). The scope becomes the
    // exported key prefix (`scope.key`), reusing extractTsValueForKey so the
    // same literal/env/fallback rules apply as any other exported constant.
    const visitFactoryConfigExport = (node: Parser.SyntaxNode): void => {
        if (node.type !== 'export_statement') return;
        if (!node.children.some(c => c.type === 'default')) return;
        const callExpr = node.children.find(c => c.type === 'call_expression');
        if (!callExpr) return;
        const fnName = callExpr.childForFieldName('function')?.text;
        if (fnName !== 'registerAs' && fnName !== 'defineConfig') return;
        const argsNode = callExpr.childForFieldName('arguments');
        if (!argsNode) return;

        let scope = '';
        for (const arg of argsNode.children) {
            if (arg.type === 'string') {
                scope = arg.text.replace(/^['"`]|['"`]$/g, '');
                break;
            }
        }
        if (!scope) return;

        for (const arg of argsNode.children) {
            if (arg.type !== 'arrow_function') continue;
            const body = arg.childForFieldName('body');
            const objectNode = body && unwrapToObjectLiteral(body);
            if (objectNode) extractTsValueForKey(scope, objectNode, true, add);
        }
    };

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'lexical_declaration') visitLexical(node);
        if (node.type === 'export_statement') visitFactoryConfigExport(node);
        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    visitClasses(rootNode);
    return dedupeFacts(facts);
}

/**
 * Constructor-property DI-config alias: `@Inject(BusConfig.KEY) private
 * readonly relayConfig: ConfigType<typeof BusConfig>` binds
 * `this.relayConfig` to the imported `BusConfig` module (NestJS
 * `registerAs()` attaches a `.KEY` static symbol to the factory). Without
 * this alias `this.relayConfig.topicSave` can never reach the
 * cross-file `busConfig.topicSave` fact emitted by
 * `visitFactoryConfigExport` in the config file.
 */
function visitConstructorInjectedParams(
    ctor: Parser.SyntaxNode,
    add: (fact: Omit<ValueFact, 'filePath' | 'language' | 'confidence'> & { confidence?: number }) => void,
): void {
    const params = ctor.childForFieldName('parameters');
    if (!params) return;
    for (const param of params.children) {
        if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') continue;
        const scope = extractInjectKeyScope(param);
        if (!scope) continue;
        const paramName = param.childForFieldName('pattern');
        if (!paramName) continue;
        add(baseFact(`this.${paramName.text}`, param, 'alias', {
            targetKey: canonicalKey(scope),
            confidence: 0.9,
        }));
    }
}

function extractInjectKeyScope(param: Parser.SyntaxNode): string | null {
    for (const child of param.children) {
        if (child.type !== 'decorator') continue;
        const callExpr = child.children.find(c => c.type === 'call_expression');
        if (!callExpr || callExpr.childForFieldName('function')?.text !== 'Inject') continue;
        const argsNode = callExpr.childForFieldName('arguments');
        const firstArg = argsNode?.children.find(c => c.type !== '(' && c.type !== ')' && c.type !== ',');
        if (!firstArg || firstArg.type !== 'member_expression') continue;
        const propertyNode = firstArg.childForFieldName('property');
        const objectNode = firstArg.childForFieldName('object');
        if (propertyNode?.text !== 'KEY' || !objectNode) continue;
        return objectNode.text;
    }
    return null;
}

/** Unwraps `() => ({...})` and `() => { return {...}; }` arrow bodies to the returned object literal. */
function unwrapToObjectLiteral(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === 'object') return node;
    if (node.type === 'parenthesized_expression') {
        const inner = node.children.find(c => c.type !== '(' && c.type !== ')');
        return inner ? unwrapToObjectLiteral(inner) : null;
    }
    if (node.type === 'statement_block') {
        for (const stmt of node.children) {
            if (stmt.type !== 'return_statement') continue;
            const retVal = stmt.children.find(c => c.type === 'object' || c.type === 'parenthesized_expression');
            if (retVal) return unwrapToObjectLiteral(retVal);
        }
    }
    return null;
}

export function extractTypeScriptCriticalInvocations(
    rootNode: Parser.SyntaxNode,
    _source: string,
    filepath: string,
    _chunk?: CodeChunk,
): CriticalInvocationFact[] {
    const invocations: CriticalInvocationFact[] = [];

    const add = (node: Parser.SyntaxNode, callee: string, expression: string, spec: ResourceSpec, evidence?: string) => {
        invocations.push({
            filePath: filepath,
            language: 'typescript',
            callee,
            resourceExpression: expression,
            resourceRole: spec.role,
            resourceType: spec.resourceType,
            operation: spec.operation,
            confidence: spec.confidence ?? 0.95,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            evidence,
        });
    };

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'call_expression') {
            const callee = node.childForFieldName('function')?.text ?? '';
            const args = callArguments(node);
            const name = simpleCalleeName(callee);

            for (const arg of args) {
                if (arg.type === 'object' && isCriticalObjectCallee(name)) {
                    // RC3a: scan resource-bearing keys at any depth. NestJS
                    // emit wrappers commonly nest under `eventConfiguration`
                    // (`{ eventConfiguration: { routingKey: [...], exchange: ... } }`).
                    // The previous top-level-only scan never reached
                    // `routingKey` and the LLM had to guess between
                    // exchange and routing key.
                    const collected: Array<{ resourceKey: string; valueNode: Parser.SyntaxNode }> = [];
                    walkObjectForResources(arg, (resourceKey, valueNode) => {
                        collected.push({ resourceKey, valueNode });
                    });

                    // RC3a precedence rule: when both a routing key and an
                    // exchange are emitted at the same call site (typical
                    // RabbitMQ pattern), only the routing key represents a
                    // logical MessageChannel. The exchange is broker
                    // topology (the same exchange carries many routing
                    // keys); emitting it as a sibling MessageChannel fact
                    // forces the bypass guard to drop EVERYTHING when the
                    // exchange expression is unresolved (a per-config
                    // value, often `this.rabbitMqConfig.exchange`).
                    const hasRoutingKey = collected.some(c => c.resourceKey === 'routingKey');
                    const filtered = hasRoutingKey
                        ? collected.filter(c => c.resourceKey !== 'exchange')
                        : collected;

                    for (const { resourceKey, valueNode } of filtered) {
                        const spec = RESOURCE_KEYS[resourceKey];
                        if (!spec) continue;
                        const expr = unwrapSingletonArrayExpression(valueNode);
                        add(node, callee, expr, spec, `${resourceKey}: ${expr}`);
                    }
                }
            }

            if (args[0]) {
                if (['publish', 'emit', 'send', 'produce'].includes(name)) {
                    if (args[0].type !== 'object') {
                        add(node, callee, args[0].text, { resourceType: 'MessageChannel', operation: 'WRITES', role: 'topic' });
                    }
                } else if (['subscribe', 'consume'].includes(name)) {
                    add(node, callee, args[0].text, { resourceType: 'MessageChannel', operation: 'READS', role: 'queue' });
                } else if (name === 'fetch' || /^axios\.(get|post|put|patch|delete)$/i.test(callee)) {
                    add(node, callee, args[0].text, { resourceType: 'ExternalAPI', operation: 'READS', role: 'url', confidence: 0.9 });
                } else if (['collection', 'table', 'from', 'query', 'execute', 'prepare'].includes(name)) {
                    add(node, callee, args[0].text, { resourceType: 'Database', operation: databaseOperationForCall(name, args[0].text), role: 'tableOrSql', confidence: 0.92 });
                } else if (['writePoint', 'writePoints'].includes(name)) {
                    // InfluxDB v2 client write (@influxdata/influxdb-client WriteApi).
                    // Schemaless time-series: no measurement container, role 'timeseries'
                    // → graph-writer binds function->Datastore directly (no DataContainer).
                    add(node, callee, '<DYNAMIC>', { resourceType: 'Database', operation: 'WRITES', role: 'timeseries', confidence: 0.9 });
                }
            }
        }

        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    return dedupeInvocations(invocations);
}

function extractTsValueForKey(
    key: string,
    valueNode: Parser.SyntaxNode,
    exported: boolean,
    add: (fact: Omit<ValueFact, 'filePath' | 'language' | 'confidence'> & { confidence?: number }) => void,
): void {
    const valueText = valueNode.text;
    const literal = safeLiteralValue(valueNode);
    if (literal !== undefined) {
        add(baseFact(key, valueNode, 'literal', { value: literal, exported, exportedAs: exported ? key : undefined }));
        if (exported) add(baseFact(`default.${key}`, valueNode, 'literal', { value: literal, exported: false, confidence: 0.9 }));
        return;
    }

    const zodDefaults = extractZodObjectDefaults(valueText);
    if (zodDefaults.length > 0) {
        for (const prop of zodDefaults) {
            add(baseFact(`${key}.${prop.name}`, valueNode, 'schema-default', {
                value: prop.value,
                fallbackValue: prop.value,
                envKey: /^[A-Z][A-Z0-9_]*$/.test(prop.name) ? prop.name : undefined,
                exported,
                exportedAs: exported ? `${key}.${prop.name}` : undefined,
                confidence: 0.95,
            }));
        }
        return;
    }

    // Object literals must recurse into their own properties BEFORE the
    // string-based fallback/env checks below: those regexes search `valueText`
    // (the whole object's source text) for a `process.env.X` occurrence
    // ANYWHERE inside it, which matches even when only one of several
    // properties references an env var — collapsing the whole object into a
    // single opaque env-key fact instead of per-property facts.
    if (valueNode.type === 'object') {
        for (const pair of valueNode.children.filter(child => child.type === 'pair')) {
            const propKey = pair.childForFieldName('key');
            const propValue = pair.childForFieldName('value');
            if (!propKey || !propValue) continue;
            const propName = normalizeObjectKey(propKey.text);
            extractTsValueForKey(`${key}.${propName}`, propValue, exported, add);
            if (exported) {
                extractTsValueForKey(`default.${propName}`, propValue, false, add);
            }
        }
        return;
    }

    const fallback = fallbackLiteral(valueText);
    if (fallback) {
        add(baseFact(key, valueNode, 'fallback', {
            fallbackValue: fallback,
            envKey: extractEnvKey(valueText),
            exported,
            exportedAs: exported ? key : undefined,
            confidence: 0.95,
        }));
        return;
    }

    const envKey = extractEnvKey(valueText);
    if (envKey) {
        add(baseFact(key, valueNode, 'env', { envKey, exported, exportedAs: exported ? key : undefined, confidence: 0.7 }));
        return;
    }

    const parseMatch = valueText.match(/^([A-Za-z_$][A-Za-z0-9_$.]*)\.(?:parse|safeParse)\(/);
    if (parseMatch) {
        add(baseFact(key, valueNode, 'alias', {
            targetKey: canonicalKey(parseMatch[1]),
            exported,
            exportedAs: exported ? key : undefined,
            confidence: 0.95,
        }));
        return;
    }

    if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:[.$][A-Za-z_$][A-Za-z0-9_$]*)*$/.test(valueText)) {
        add(baseFact(key, valueNode, 'alias', {
            targetKey: canonicalKey(valueText),
            exported,
            exportedAs: exported ? key : undefined,
            confidence: 0.95,
        }));
    }
}

export function extractPhpValueFacts(_rootNode: Parser.SyntaxNode, source: string, filepath: string): ValueFact[] {
    return extractLineBasedValueFacts(source, filepath, 'php');
}

export function extractPhpCriticalInvocations(_rootNode: Parser.SyntaxNode, source: string, filepath: string): CriticalInvocationFact[] {
    return extractLineBasedCriticalInvocations(source, filepath, 'php');
}

export function extractPythonValueFacts(_rootNode: Parser.SyntaxNode, source: string, filepath: string): ValueFact[] {
    return extractLineBasedValueFacts(source, filepath, 'python');
}

export function extractPythonCriticalInvocations(_rootNode: Parser.SyntaxNode, source: string, filepath: string): CriticalInvocationFact[] {
    return extractLineBasedCriticalInvocations(source, filepath, 'python');
}

export function extractGoValueFacts(_rootNode: Parser.SyntaxNode, source: string, filepath: string): ValueFact[] {
    return extractLineBasedValueFacts(source, filepath, 'go');
}

export function extractGoCriticalInvocations(_rootNode: Parser.SyntaxNode, source: string, filepath: string): CriticalInvocationFact[] {
    return extractLineBasedCriticalInvocations(source, filepath, 'go');
}

function extractLineBasedValueFacts(source: string, filepath: string, language: CodeChunk['language']): ValueFact[] {
    const facts: ValueFact[] = [];
    const lines = source.split('\n');
    const add = (line: number, key: string, expression: string, patch: Partial<ValueFact>) => {
        facts.push({
            filePath: filepath,
            language,
            key: canonicalKey(key),
            expression,
            kind: patch.kind ?? 'dynamic',
            value: patch.value,
            envKey: patch.envKey,
            fallbackValue: patch.fallbackValue,
            targetKey: patch.targetKey ? canonicalKey(patch.targetKey) : undefined,
            exported: patch.exported,
            exportedAs: patch.exportedAs,
            confidence: patch.confidence ?? 0.9,
            startLine: line,
            endLine: line,
        });
    };

    for (let idx = 0; idx < lines.length; idx++) {
        const lineNo = idx + 1;
        const line = lines[idx];
        const assignment = matchAssignment(line, language);
        if (!assignment) continue;

        const literal = extractStringLiteral(assignment.expression);
        const fallback = fallbackLiteral(assignment.expression);
        const envKey = extractEnvKey(assignment.expression);

        if (literal !== undefined) {
            add(lineNo, assignment.key, assignment.expression, { kind: 'literal', value: literal, exported: assignment.exported, exportedAs: assignment.exported ? canonicalKey(assignment.key) : undefined, confidence: 1 });
        } else if (fallback) {
            add(lineNo, assignment.key, assignment.expression, { kind: 'fallback', fallbackValue: fallback, envKey, exported: assignment.exported, exportedAs: assignment.exported ? canonicalKey(assignment.key) : undefined, confidence: 0.93 });
        } else if (envKey) {
            add(lineNo, assignment.key, assignment.expression, { kind: 'env', envKey, exported: assignment.exported, exportedAs: assignment.exported ? canonicalKey(assignment.key) : undefined, confidence: 0.7 });
        } else if (isSimpleReference(assignment.expression)) {
            add(lineNo, assignment.key, assignment.expression, { kind: 'alias', targetKey: assignment.expression, exported: assignment.exported, exportedAs: assignment.exported ? canonicalKey(assignment.key) : undefined, confidence: 0.9 });
        }

        for (const prop of extractInlineMapProperties(assignment.expression)) {
            add(lineNo, `${assignment.key}.${prop.key}`, prop.expression, {
                kind: prop.value !== undefined ? 'object-property' : prop.envKey ? 'env' : 'fallback',
                value: prop.value,
                envKey: prop.envKey,
                fallbackValue: prop.fallbackValue,
                exported: assignment.exported,
                exportedAs: assignment.exported ? `${canonicalKey(assignment.key)}.${prop.key}` : undefined,
                confidence: prop.value !== undefined ? 1 : 0.9,
            });
        }
    }

    return dedupeFacts(facts);
}

function extractLineBasedCriticalInvocations(
    source: string,
    filepath: string,
    language: CodeChunk['language'],
): CriticalInvocationFact[] {
    const invocations: CriticalInvocationFact[] = [];
    const lines = source.split('\n');
    let inBlockComment = false;
    let inMultilineString: string | null = null;
    let heredocTerminator: string | null = null;
    for (let idx = 0; idx < lines.length; idx++) {
        const line = stripNonCodeLine(lines[idx], language, {
            inBlockComment,
            inMultilineString,
            heredocTerminator,
        });
        inBlockComment = line.inBlockComment;
        inMultilineString = line.inMultilineString;
        heredocTerminator = line.heredocTerminator;
        if (!line.code) continue;
        const lineNo = idx + 1;
        const calls = [
            ...matchCalls(line.code, /(publish|emit|send|produce|basic_publish|send_task)\s*\(([\s\S]*)\)/gi, { resourceType: 'MessageChannel', operation: 'WRITES', role: 'topic' }),
            ...matchCalls(line.code, /(subscribe|consume|queue_declare|basic_consume)\s*\(([\s\S]*)\)/gi, { resourceType: 'MessageChannel', operation: 'READS', role: 'queue' }),
            ...matchCalls(line.code, /(fetch|curl_init|requests\.(?:get|post|put|patch|delete)|http\.(?:Get|Post))\s*\(([\s\S]*)\)/g, { resourceType: 'ExternalAPI', operation: 'READS', role: 'url', confidence: 0.9 }),
            ...matchCalls(line.code, /(collection|table|from|query|execute|prepare|Query|Exec|Collection)\s*\(([\s\S]*)\)/g, { resourceType: 'Database', operation: 'WRITES', role: 'tableOrSql', confidence: 0.9 }),
            ...(language === 'php' ? matchCalls(line.code, /\b(exec|passthru|system|proc_open|popen|shell_exec|pcntl_exec)\s*\(([\s\S]*)\)/g, { resourceType: 'Process', operation: 'WRITES', role: 'script', confidence: 0.85 }) : []),
        ];
        for (const call of calls) {
            invocations.push({
                filePath: filepath,
                language,
                callee: call.callee,
                resourceExpression: call.expression,
                resourceRole: call.spec.role,
                resourceType: call.spec.resourceType,
                operation: call.spec.operation,
                confidence: call.spec.confidence ?? 0.9,
                startLine: lineNo,
                endLine: lineNo,
            });
        }
    }
    return dedupeInvocations(invocations);
}

function stripNonCodeLine(
    rawLine: string,
    language: CodeChunk['language'],
    state: {
        inBlockComment: boolean;
        inMultilineString: string | null;
        heredocTerminator: string | null;
    },
): {
    code: string;
    inBlockComment: boolean;
    inMultilineString: string | null;
    heredocTerminator: string | null;
} {
    const trimmed = rawLine.trim();

    if (state.inBlockComment) {
        return {
            code: '',
            inBlockComment: !trimmed.includes('*/'),
            inMultilineString: state.inMultilineString,
            heredocTerminator: state.heredocTerminator,
        };
    }

    if (state.inMultilineString) {
        return {
            code: '',
            inBlockComment: false,
            inMultilineString: trimmed.includes(state.inMultilineString) ? null : state.inMultilineString,
            heredocTerminator: state.heredocTerminator,
        };
    }

    if (state.heredocTerminator) {
        const terminator = state.heredocTerminator;
        return {
            code: '',
            inBlockComment: false,
            inMultilineString: null,
            heredocTerminator: trimmed === terminator || trimmed === `${terminator};` ? null : terminator,
        };
    }

    if (!trimmed) return noCode();
    if (language === 'python' && trimmed.startsWith('#')) return noCode();
    if ((language === 'php' || language === 'go') && (trimmed.startsWith('//') || trimmed.startsWith('#'))) {
        return noCode();
    }
    if ((language === 'php' || language === 'go') && trimmed.startsWith('/*')) {
        return {
            code: '',
            inBlockComment: !trimmed.includes('*/'),
            inMultilineString: null,
            heredocTerminator: null,
        };
    }

    if (language === 'python') {
        const triple = trimmed.match(/^(?:[rubfRUBF]+)?("""|''')/);
        if (triple) {
            return {
                code: '',
                inBlockComment: false,
                inMultilineString: trimmed.indexOf(triple[1], triple[0].length) === -1 ? triple[1] : null,
                heredocTerminator: null,
            };
        }
    }

    if (language === 'go' && rawLine.includes('`')) {
        const count = (rawLine.match(/`/g) ?? []).length;
        return {
            code: '',
            inBlockComment: false,
            inMultilineString: count % 2 === 1 ? '`' : null,
            heredocTerminator: null,
        };
    }

    if (language === 'php') {
        const heredoc = rawLine.match(/<<<['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
        if (heredoc) {
            return {
                code: '',
                inBlockComment: false,
                inMultilineString: null,
                heredocTerminator: heredoc[1],
            };
        }
    }

    return {
        code: rawLine,
        inBlockComment: false,
        inMultilineString: null,
        heredocTerminator: null,
    };
}

function noCode(): {
    code: string;
    inBlockComment: boolean;
    inMultilineString: string | null;
    heredocTerminator: string | null;
} {
    return {
        code: '',
        inBlockComment: false,
        inMultilineString: null,
        heredocTerminator: null,
    };
}

function baseFact(
    key: string,
    node: Parser.SyntaxNode,
    kind: ValueFact['kind'],
    patch: Partial<ValueFact>,
): Omit<ValueFact, 'filePath' | 'language' | 'confidence'> & { confidence?: number } {
    return {
        key: canonicalKey(key),
        expression: node.text,
        kind,
        value: patch.value,
        envKey: patch.envKey,
        fallbackValue: patch.fallbackValue,
        targetKey: patch.targetKey ? canonicalKey(patch.targetKey) : undefined,
        exported: patch.exported,
        exportedAs: patch.exportedAs ? canonicalKey(patch.exportedAs) : undefined,
        confidence: patch.confidence,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    };
}

function callArguments(callNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const args = callNode.childForFieldName('arguments');
    if (!args) return [];
    return args.children.filter(child => !['(', ')', ','].includes(child.type) && !['(', ')', ','].includes(child.text));
}

function simpleCalleeName(callee: string): string {
    const clean = callee.replace(/\?\./g, '.');
    return clean.split('.').pop()?.replace(/[^A-Za-z0-9_$]/g, '') ?? clean;
}

function isCriticalObjectCallee(name: string): boolean {
    return [
        'createAdapter', 'publish', 'emit', 'send', 'produce', 'connect',
        'configure', 'register', 'forRoot',
        // RC3a: NestJS-style emit wrappers seen in real codebases (acme-platform
        // MessageEmitterService.emitEvent, CQRS CommandBus.dispatch).
        // Without these the eventConfiguration.routingKey field below
        // never produces a critical invocation and the LLM is the only
        // path, where it routinely hallucinates the exchange name.
        'emitEvent', 'dispatch', 'dispatchEvent', 'sendEvent',
    ].includes(name);
}

function normalizeObjectKey(raw: string): string {
    return raw.replace(/^['"`]|['"`]$/g, '');
}

/**
 * Recursively walk an object literal calling `visit(key, value)` for each
 * pair whose key matches a resource role (topic/routingKey/queue/exchange/…).
 * Descends into nested objects (typical NestJS shape:
 * `{ eventConfiguration: { routingKey: [...], exchange: ... } }`).
 * Stops at unknown nested objects' value boundary; never recurses into
 * arrays or function expressions (those are not config blocks).
 */
function walkObjectForResources(
    node: Parser.SyntaxNode,
    visit: (resourceKey: string, valueNode: Parser.SyntaxNode) => void,
): void {
    if (node.type !== 'object') return;
    for (const pair of node.children.filter(c => c.type === 'pair')) {
        const key = pair.childForFieldName('key');
        const value = pair.childForFieldName('value');
        if (!key || !value) continue;
        const normalized = normalizeObjectKey(key.text);
        if (RESOURCE_KEYS[normalized]) {
            visit(normalized, value);
            continue;
        }
        if (value.type === 'object') walkObjectForResources(value, visit);
    }
}

/**
 * Unwrap `[X]` to `X` when an array literal contains a single element.
 * NestJS-style emit APIs accept `routingKey: [this.X]` (array form) but
 * the resolveExpression downstream understands `this.X` directly. Keeping
 * the brackets would force the value-resolver to treat the whole array
 * literal as opaque text.
 */
function unwrapSingletonArrayExpression(node: Parser.SyntaxNode): string {
    if (node.type !== 'array') return node.text;
    const elements = node.children.filter(c =>
        c.type !== '[' && c.type !== ']' && c.type !== ',',
    );
    if (elements.length !== 1) return node.text;
    return elements[0].text;
}

function safeLiteralValue(node: Parser.SyntaxNode): string | undefined {
    if (node.type === 'string' || node.type === 'template_string') {
        if (node.text.includes('${')) return undefined;
        return node.text.replace(/^[`"']|[`"']$/g, '');
    }
    return undefined;
}

function fallbackLiteral(expression: string): string | undefined {
    const match = expression.match(/(?:\?\?|\|\||\bor\b|:)\s*(['"`])([\s\S]*?)\1\s*$/)
        ?? expression.match(/\.(?:default|catch)\(\s*(['"`])([\s\S]*?)\1\s*\)/)
        ?? expression.match(/(?:os\.getenv|os\.environ\.get)\(\s*(['"`])[A-Z][A-Z0-9_]*\1\s*,\s*(['"`])([\s\S]*?)\2\s*\)/);
    if (!match) return undefined;
    const value = match[3] ?? match[2];
    return value?.includes('${') ? undefined : value;
}

function extractZodObjectDefaults(expression: string): Array<{ name: string; value: string }> {
    if (!/\bz\.object\s*\(/.test(expression)) return [];
    const out: Array<{ name: string; value: string }> = [];
    const propRegex = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*z\.[A-Za-z0-9_$]+(?:\([^)]*\))?(?:\.[A-Za-z0-9_$]+(?:\([^)]*\))?)*\.(?:default|catch)\(\s*(['"`])([\s\S]*?)\2\s*\)/g;
    for (const match of expression.matchAll(propRegex)) {
        if (!match[3].includes('${')) out.push({ name: match[1], value: match[3] });
    }
    return out;
}

function databaseOperationForCall(name: string, expression: string): ResolvedOperation {
    if (/^\s*['"`]\s*(?:select|show|with)\b/i.test(expression)) return 'READS';
    if (['from', 'collection'].includes(name)) return 'READS';
    return 'WRITES';
}

function matchAssignment(line: string, language: CodeChunk['language']): { key: string; expression: string; exported?: boolean } | null {
    if (language === 'php') {
        const classConst = line.match(/\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+)/);
        if (classConst) return { key: classConst[1], expression: classConst[2] };
        const variable = line.match(/\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+)/);
        if (variable) return { key: variable[1], expression: variable[2] };
    }
    if (language === 'python') {
        const assignment = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (assignment) return { key: assignment[2], expression: assignment[3] };
        const classAttr = line.match(/self\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (classAttr) return { key: `this.${classAttr[1]}`, expression: classAttr[2] };
    }
    if (language === 'go') {
        const assignment = line.match(/\b(?:const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*|[A-Za-z0-9_*.[\]]+\s*=\s*)(.+)$/);
        if (assignment) return { key: assignment[1], expression: assignment[2] };
        const shortAssign = line.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+)$/);
        if (shortAssign) return { key: shortAssign[1], expression: shortAssign[2] };
    }
    return null;
}

function isSimpleReference(expression: string): boolean {
    return /^[\s$A-Za-z_][A-Za-z0-9_$.[\]'":>\-\s]*$/.test(expression)
        && !/[()[\]{}]/.test(expression.replace(/\[['"`][^'"`]+['"`]\]/g, ''));
}

function extractInlineMapProperties(expression: string): Array<{
    key: string;
    expression: string;
    value?: string;
    envKey?: string;
    fallbackValue?: string;
}> {
    const out: Array<{ key: string; expression: string; value?: string; envKey?: string; fallbackValue?: string }> = [];
    const propRegex = /['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?\s*(?:=>|:)\s*([^,}\]]+)/g;
    for (const match of expression.matchAll(propRegex)) {
        const propExpression = match[2].trim();
        out.push({
            key: match[1],
            expression: propExpression,
            value: extractStringLiteral(propExpression),
            envKey: extractEnvKey(propExpression),
            fallbackValue: fallbackLiteral(propExpression),
        });
    }
    return out;
}

function matchCalls(
    line: string,
    pattern: RegExp,
    spec: ResourceSpec,
): Array<{ callee: string; expression: string; spec: ResourceSpec }> {
    const out: Array<{ callee: string; expression: string; spec: ResourceSpec }> = [];
    for (const match of line.matchAll(pattern)) {
        const firstArg = splitArgs(match[2])[0];
        if (!firstArg) continue;
        out.push({ callee: match[1], expression: firstArg.trim(), spec });
    }
    return out;
}

function splitArgs(raw: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: string | null = null;
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (quote) {
            current += ch;
            if (ch === quote && raw[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === '\'' || ch === '`') {
            quote = ch;
            current += ch;
            continue;
        }
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) {
            args.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) args.push(current);
    return args;
}

function dedupeFacts(facts: ValueFact[]): ValueFact[] {
    const seen = new Set<string>();
    const out: ValueFact[] = [];
    for (const fact of facts) {
        const key = `${fact.filePath}:${fact.key}:${fact.startLine}:${fact.kind}:${fact.value ?? fact.targetKey ?? fact.envKey ?? fact.fallbackValue ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(fact);
    }
    return out;
}

function dedupeInvocations(invocations: CriticalInvocationFact[]): CriticalInvocationFact[] {
    const seen = new Set<string>();
    const out: CriticalInvocationFact[] = [];
    for (const invocation of invocations) {
        const key = `${invocation.filePath}:${invocation.startLine}:${invocation.callee}:${invocation.resourceExpression}:${invocation.resourceRole}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(invocation);
    }
    return out;
}
