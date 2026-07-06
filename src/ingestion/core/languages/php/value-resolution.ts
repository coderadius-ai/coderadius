import type Parser from 'tree-sitter';
import {
    canonicalKey,
    extractEnvKey,
} from '../../value-resolution/index.js';
import {
    extractPhpCriticalInvocations as extractLegacyPhpCriticalInvocations,
    extractPhpValueFacts as extractLegacyPhpValueFacts,
} from '../../value-resolution/extractors.js';
import type {
    CriticalInvocationFact,
    ResolvedOperation,
    ResolvedResourceType,
    ValueFact,
} from '../../value-resolution/types.js';
import { extractStringLiteralValueRaw } from './shared/ast-utils.js';
import { enrichPhpChainedMethods } from './chained-method-enricher.js';

type PhpReference = {
    key: string;
    confidence: number;
};

type ResourceSpec = {
    resourceType: ResolvedResourceType;
    operation: ResolvedOperation;
    role: string;
    confidence?: number;
};

// PHP built-in process-spawning calls. Unlike imported sinks (e.g. amqplib),
// these are language builtins so the import-based taint registry never
// catches them. Emitting them as CriticalInvocationFact ensures legacy PHP
// monoliths that use `exec`, `system`, etc. as their I/O boundary are still
// scheduled for analysis even when the host class lacks a Runner/Scraper
// suffix that heuristic-filter Gate 2 expects.
const PHP_PROCESS_BUILTINS = new Set([
    'exec',
    'passthru',
    'system',
    'proc_open',
    'popen',
    'shell_exec',
    'pcntl_exec',
]);

type FactAdder = (
    key: string,
    node: Parser.SyntaxNode,
    kind: ValueFact['kind'],
    patch: Partial<ValueFact>,
) => void;

const MAX_ARRAY_DEPTH = 4;

export function extractPhpValueFacts(rootNode: Parser.SyntaxNode, source: string, filepath: string): ValueFact[] {
    try {
        const astFacts = extractPhpValueFactsFromAst(rootNode, filepath);
        return astFacts.length > 0 ? astFacts : extractLegacyPhpValueFacts(rootNode, source, filepath);
    } catch {
        return extractLegacyPhpValueFacts(rootNode, source, filepath);
    }
}

export function extractPhpCriticalInvocations(rootNode: Parser.SyntaxNode, source: string, filepath: string): CriticalInvocationFact[] {
    let invocations: CriticalInvocationFact[];
    try {
        const astInvocations = extractPhpCriticalInvocationsFromAst(rootNode, filepath);
        invocations = astInvocations.length > 0 ? astInvocations : extractLegacyPhpCriticalInvocations(rootNode, source, filepath);
    } catch {
        invocations = extractLegacyPhpCriticalInvocations(rootNode, source, filepath);
    }
    // Plan v10 §C: populate chainedMethod on `serviceId` facts so the DI
    // propagator can resolve `$container->get('id')->method()` and
    // `$this->prop->method()` chains. Mutates `invocations` in place.
    try {
        enrichPhpChainedMethods(rootNode, invocations, filepath);
    } catch {
        // Enrichment is purely additive — if it fails the rest of the
        // pipeline behaves exactly as before (LLM fallback).
    }
    return invocations;
}

function extractPhpValueFactsFromAst(rootNode: Parser.SyntaxNode, filepath: string): ValueFact[] {
    const facts: ValueFact[] = [];

    const add: FactAdder = (key, node, kind, patch) => {
        const normalizedKey = canonicalKey(key);
        if (!normalizedKey) return;
        facts.push({
            filePath: filepath,
            language: 'php',
            key: normalizedKey,
            expression: node.text,
            kind,
            value: patch.value,
            envKey: patch.envKey,
            fallbackValue: patch.fallbackValue,
            targetKey: patch.targetKey ? canonicalKey(patch.targetKey) : undefined,
            exported: patch.exported,
            exportedAs: patch.exportedAs ? canonicalKey(patch.exportedAs) : undefined,
            confidence: patch.confidence ?? 1,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
        });
    };

    const walk = (node: Parser.SyntaxNode, className: string | null, functionDepth: number): void => {
        if (node.type === 'class_declaration') {
            const nextClassName = node.childForFieldName('name')?.text ?? null;
            for (const child of node.children) {
                walk(child, nextClassName, functionDepth);
            }
            return;
        }

        if (node.type === 'function_definition' || node.type === 'method_declaration') {
            if (node.type === 'method_declaration' && node.childForFieldName('name')?.text === '__construct') {
                extractPromotedPropertyFacts(node, className, add);
            }
            for (const child of node.children) {
                walk(child, className, functionDepth + 1);
            }
            return;
        }

        if (node.type === 'const_declaration') {
            extractConstFacts(node, className, add);
        } else if (node.type === 'property_declaration' && className) {
            extractPropertyFacts(node, className, add);
        } else if (node.type === 'assignment_expression') {
            extractAssignmentFact(node, className, add);
        } else if (node.type === 'function_call_expression') {
            extractDefineFact(node, add);
        } else if (node.type === 'return_statement' && !className && functionDepth === 0) {
            extractReturnConfigFacts(node, add);
        }

        for (const child of node.children) {
            walk(child, className, functionDepth);
        }
    };

    walk(rootNode, null, 0);
    return dedupeFacts(facts);
}

function extractConstFacts(node: Parser.SyntaxNode, className: string | null, add: FactAdder): void {
    for (const element of node.children) {
        if (element.type !== 'const_element') continue;
        const nameNode = element.children.find(child => child.type === 'name');
        const valueNode = valueAfterEquals(element);
        if (!nameNode || !valueNode) continue;

        const key = className ? `${className}.${nameNode.text}` : nameNode.text;
        emitValueFactsForKey(key, valueNode, className, add, {
            exported: true,
            exportedAs: key,
        });
    }
}

function extractPropertyFacts(node: Parser.SyntaxNode, className: string, add: FactAdder): void {
    const isStatic = node.children.some(child => child.text === 'static');
    for (const element of node.children) {
        if (element.type !== 'property_element') continue;
        const nameNode = element.children.find(child => child.type === 'variable_name');
        const valueNode = valueAfterEquals(element);
        if (!nameNode || !valueNode) continue;

        const propName = nameNode.text.replace(/^\$/, '');
        const key = isStatic ? `${className}.${propName}` : `this.${propName}`;
        emitValueFactsForKey(key, valueNode, className, add, {
            exported: isStatic,
            exportedAs: isStatic ? key : undefined,
        });
    }
}

function extractPromotedPropertyFacts(node: Parser.SyntaxNode, className: string | null, add: FactAdder): void {
    if (!className) return;
    const parameters = node.childForFieldName('parameters')
        ?? node.children.find(child => child.type === 'formal_parameters');
    if (!parameters) return;

    for (const param of parameters.children) {
        if (param.type !== 'property_promotion_parameter' && param.type !== 'simple_parameter') continue;
        const hasVisibility = param.children.some(child => child.type === 'visibility_modifier');
        if (!hasVisibility) continue;

        const variableNode = param.children.find(child => child.type === 'variable_name');
        if (!variableNode) continue;
        const key = `this.${variableNode.text.replace(/^\$/, '')}`;

        const autowireService = extractAutowireServiceId(param);
        if (autowireService) {
            add(key, param, 'literal', {
                value: autowireService,
                confidence: isLikelyChannelServiceId(autowireService) ? 0.97 : 0.82,
            });
            continue;
        }

        const defaultValue = valueAfterEquals(param);
        if (defaultValue) {
            emitValueFactsForKey(key, defaultValue, className, add);
        }
    }
}

function extractAssignmentFact(node: Parser.SyntaxNode, className: string | null, add: FactAdder): void {
    const eqIndex = node.children.findIndex(child => child.text === '=');
    if (eqIndex <= 0 || eqIndex >= node.children.length - 1) return;
    const left = node.children[eqIndex - 1];
    const right = node.children[eqIndex + 1];
    const reference = canonicalizePhpReference(left, className);
    if (!reference) return;
    emitValueFactsForKey(reference.key, right, className, add, {
        confidence: reference.confidence,
    });
}

function extractDefineFact(node: Parser.SyntaxNode, add: FactAdder): void {
    const name = phpFunctionName(node);
    if (name !== 'define') return;
    const args = phpCallArguments(node);
    const key = args[0] ? phpLiteralValue(args[0]) : undefined;
    const valueNode = args[1];
    if (!key || !valueNode) return;
    emitValueFactsForKey(key, valueNode, null, add, {
        exported: true,
        exportedAs: key,
    });
}

function extractReturnConfigFacts(node: Parser.SyntaxNode, add: FactAdder): void {
    const returned = node.children.find(child =>
        child.type !== 'return'
        && child.text !== 'return'
        && child.text !== ';',
    );
    if (!returned || unwrapPhpNode(returned).type !== 'array_creation_expression') return;
    emitPhpArrayProperties(unwrapPhpNode(returned), 'default', null, add, {
        exported: true,
        exportedAsPrefix: 'default',
    });
}

function emitValueFactsForKey(
    key: string,
    valueNode: Parser.SyntaxNode,
    className: string | null,
    add: FactAdder,
    options: { exported?: boolean; exportedAs?: string; exportedAsPrefix?: string; confidence?: number } = {},
): void {
    const value = unwrapPhpNode(valueNode);

    const envDefault = extractPhpEnvDefault(value);
    if (envDefault) {
        add(key, value, 'fallback', {
            envKey: envDefault.envKey,
            fallbackValue: envDefault.fallbackValue,
            exported: options.exported,
            exportedAs: options.exportedAs ?? key,
            confidence: Math.min(options.confidence ?? 0.95, 0.95),
        });
        return;
    }

    const fallback = extractPhpFallback(value);
    if (fallback) {
        add(key, value, 'fallback', {
            envKey: fallback.envKey,
            fallbackValue: fallback.fallbackValue,
            exported: options.exported,
            exportedAs: options.exportedAs ?? key,
            confidence: Math.min(options.confidence ?? 0.95, fallback.confidence),
        });
        return;
    }

    const envKey = phpEnvKey(value);
    if (envKey) {
        add(key, value, 'env', {
            envKey,
            exported: options.exported,
            exportedAs: options.exportedAs ?? key,
            confidence: Math.min(options.confidence ?? 0.7, 0.7),
        });
        return;
    }

    const laravelConfig = phpLaravelConfigAlias(value);
    if (laravelConfig) {
        add(key, value, 'alias', {
            targetKey: laravelConfig,
            exported: options.exported,
            exportedAs: options.exportedAs ?? key,
            confidence: Math.min(options.confidence ?? 0.78, 0.78),
        });
        return;
    }

    const literal = phpLiteralValue(value);
    if (literal !== undefined) {
        add(key, value, 'literal', {
            value: literal,
            exported: options.exported,
            exportedAs: options.exportedAs ?? key,
            confidence: options.confidence ?? 1,
        });
        return;
    }

    if (value.type === 'array_creation_expression') {
        emitPhpArrayProperties(value, key, className, add, {
            exported: options.exported,
            exportedAsPrefix: options.exportedAsPrefix ?? options.exportedAs ?? key,
            confidence: options.confidence,
        });
        return;
    }

    const reference = canonicalizePhpReference(value, className);
    if (reference && reference.key !== canonicalKey(key)) {
        add(key, value, 'alias', {
            targetKey: reference.key,
            exported: options.exported,
            exportedAs: options.exportedAs ?? key,
            confidence: Math.min(options.confidence ?? 0.95, reference.confidence),
        });
    }
}

function emitPhpArrayProperties(
    arrayNode: Parser.SyntaxNode,
    baseKey: string,
    className: string | null,
    add: FactAdder,
    options: { exported?: boolean; exportedAsPrefix?: string; confidence?: number } = {},
    depth = 0,
): void {
    if (depth >= MAX_ARRAY_DEPTH) return;

    for (const element of arrayNode.children) {
        if (element.type !== 'array_element_initializer') continue;
        const arrowIndex = element.children.findIndex(child => child.text === '=>');
        if (arrowIndex <= 0 || arrowIndex >= element.children.length - 1) continue;

        const keyNode = element.children[arrowIndex - 1];
        const valueNode = element.children[arrowIndex + 1];
        const propKey = phpArrayKeyValue(keyNode);
        if (!propKey || !valueNode) continue;

        const factKey = `${baseKey}.${propKey}`;
        const exportedAs = options.exportedAsPrefix ? `${options.exportedAsPrefix}.${propKey}` : factKey;
        const value = unwrapPhpNode(valueNode);
        if (value.type === 'array_creation_expression') {
            emitPhpArrayProperties(value, factKey, className, add, {
                exported: options.exported,
                exportedAsPrefix: exportedAs,
                confidence: options.confidence,
            }, depth + 1);
        } else {
            emitValueFactsForKey(factKey, value, className, add, {
                exported: options.exported,
                exportedAs,
                confidence: options.confidence,
            });
        }
    }
}

function extractPhpCriticalInvocationsFromAst(rootNode: Parser.SyntaxNode, filepath: string): CriticalInvocationFact[] {
    const invocations: CriticalInvocationFact[] = [];

    const add = (node: Parser.SyntaxNode, callee: string, resourceExpression: string, spec: ResourceSpec, evidence?: string) => {
        invocations.push({
            filePath: filepath,
            language: 'php',
            callee,
            resourceExpression,
            resourceRole: spec.role,
            resourceType: spec.resourceType,
            operation: spec.operation,
            confidence: spec.confidence ?? 0.95,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            evidence,
        });
    };

    // File-level scope: parsed once, used to resolve type-hints during the
    // class-by-class binding pass.
    const fileScope = extractPhpFileScope(rootNode);

    // Tracks the active class's DI bindings while we recurse into its body.
    // null when outside any class.
    let currentClassBindings: Map<string, DiBinding> | null = null;

    const walk = (node: Parser.SyntaxNode): void => {
        // When entering a class, build its DI binding map and use it for all
        // descendants. Restore on exit.
        if (node.type === 'class_declaration') {
            const previous = currentClassBindings;
            currentClassBindings = buildClassDiBindings(node, fileScope);
            for (const child of node.children) walk(child);
            currentClassBindings = previous;
            return;
        }

        if (node.type === 'function_call_expression') {
            extractPhpFunctionInvocation(node, add);
        } else if (node.type === 'member_call_expression') {
            extractPhpMemberInvocation(node, add, currentClassBindings);
        } else if (node.type === 'scoped_call_expression') {
            extractPhpScopedInvocation(node, add);
        } else if (node.type === 'method_declaration') {
            extractPhpHandlerInbound(node, add);
        }

        for (const child of node.children) {
            walk(child);
        }
    };

    walk(rootNode);
    return dedupeInvocations(invocations);
}

function extractPhpFunctionInvocation(node: Parser.SyntaxNode, add: (
    node: Parser.SyntaxNode,
    callee: string,
    resourceExpression: string,
    spec: ResourceSpec,
    evidence?: string,
) => void): void {
    const name = phpFunctionName(node);
    const args = phpCallArguments(node);
    if (!name) return;

    if (name === 'curl_init' && args[0]) {
        add(node, name, args[0].text, { resourceType: 'ExternalAPI', operation: 'READS', role: 'url', confidence: 0.9 });
        return;
    }

    if (name === 'curl_setopt' && args[1]?.text === 'CURLOPT_URL' && args[2]) {
        add(node, name, args[2].text, { resourceType: 'ExternalAPI', operation: 'READS', role: 'url', confidence: 0.9 });
        return;
    }

    if (name === 'basic_publish') {
        addRabbitPublishInvocation(node, name, args, add);
        return;
    }

    if (name === 'queue_declare' || name === 'basic_consume') {
        if (args[0]) add(node, name, args[0].text, { resourceType: 'MessageChannel', operation: 'READS', role: 'queue' });
        return;
    }

    if ((name === 'dispatch' || name === 'event') && args[0]) {
        addDispatchInvocation(node, name, args[0], add);
        return;
    }

    if (PHP_PROCESS_BUILTINS.has(name) && args[0]) {
        add(node, name, args[0].text, { resourceType: 'Process', operation: 'WRITES', role: 'script' });
    }
}

function extractPhpMemberInvocation(node: Parser.SyntaxNode, add: (
    node: Parser.SyntaxNode,
    callee: string,
    resourceExpression: string,
    spec: ResourceSpec,
    evidence?: string,
) => void, classBindings: Map<string, DiBinding> | null = null): void {
    const method = phpMemberMethodName(node);
    const receiver = phpMemberReceiver(node);
    const args = phpCallArguments(node);
    if (!method) return;
    const callee = receiver ? `${receiver.text}->${method}` : method;

    if (method === 'basic_publish') {
        addRabbitPublishInvocation(node, callee, args, add);
        return;
    }

    if (method === 'queue_declare' || method === 'basic_consume' || method === 'consume' || method === 'subscribe') {
        if (args[0]) add(node, callee, args[0].text, { resourceType: 'MessageChannel', operation: 'READS', role: 'queue' });
        return;
    }

    if (method === 'dispatch' && args[0]) {
        addDispatchInvocation(node, callee, args[0], add);
        return;
    }

    // Google Cloud Pub/Sub client surface: `$client->topic('name')` /
    // `$client->subscription('name')`. The topic/subscription NAME is the
    // channel; the publish()/pull() on the returned handle is the I/O, and the
    // canonical SDK usage stores the handle in a local var first
    // (`$t = $client->topic('x'); $t->publish(...)`), so recognise the
    // NAME-bearing accessor directly — the InfluxDB `writePoints` precedent.
    // Gate on a literal or resolvable resource arg so a bare `->topic()` /
    // `->subscription()` on an unrelated object cannot masquerade as a channel.
    if ((method === 'topic' || method === 'subscription') && args[0]
        && (phpLiteralValue(args[0]) !== undefined || isLikelyResourceExpression(args[0]))) {
        add(node, callee, args[0].text, {
            resourceType: 'MessageChannel',
            operation: method === 'subscription' ? 'READS' : 'WRITES',
            role: method, // 'topic' | 'subscription' → channelKindForRole maps it
            confidence: 0.9,
        });
        return;
    }

    if (['publish', 'send', 'emit', 'produce'].includes(method)) {
        const resource = choosePublishResource(receiver, args);
        if (resource) {
            add(node, callee, resource.text, {
                resourceType: 'MessageChannel',
                operation: 'WRITES',
                role: resource.role,
                confidence: resource.confidence,
            });
        }
        return;
    }

    if (method === 'request' && (args[1] || args[0])) {
        const urlArg = args[1] ?? args[0];
        add(node, callee, urlArg.text, { resourceType: 'ExternalAPI', operation: 'READS', role: 'url', confidence: 0.9 });
        return;
    }

    // PSR-11 / Symfony service-locator: $container->get('di.key'),
    // $container->getParameter('config.key'). Register as a critical invocation
    // so any function performing a DI lookup falls through to the LLM via the
    // prompt-only-role guard in buildStaticAnalysisFromResolvedInvocations.
    //
    // The DI key (or parameter key) is opaque to static analysis — only the
    // sanitizer's DI registry path can substitute it for a physical resource
    // name (queue, topic, connection). Without registering this invocation
    // here, mixed DB+DI consumer functions like
    //     $consumer = $this->container->get('order.events.consumer');
    //     $consumer->receive();
    //     $db->prepare('INSERT INTO ...');
    // bypass the LLM entirely (DB-only static result), losing the broker.
    if ((method === 'get' || method === 'getParameter') && receiver && isLikelyServiceContainer(receiver.text)) {
        const resolved = serviceLocatorResource(node);
        if (resolved) {
            add(node, callee, resolved.text, {
                resourceType: 'MessageChannel',  // placeholder; the LLM/sanitizer assigns the real type
                operation: method === 'getParameter' ? 'READS' : 'READS',
                role: resolved.role,             // 'serviceId' or 'parameterId' — both prompt-only
                confidence: resolved.confidence,
            });
        }
        return;
    }

    // HTTP-verb method invocations (`$client->get('/api/users')`) emit an
    // ExternalAPI hint — but ONLY when args[0] looks URL-shaped. Without this
    // guard, every Doctrine `ArrayCollection::get($id)`, every repository
    // `->get($key)`, and every DTO accessor would be misclassified as an
    // outbound API call (Symfony Collection.get is the most common one).
    //
    // Evidence-required philosophy mirrors the kindFamily gate added for
    // database connections: classify only when the static signal is strong.
    // The LLM path remains the safety net for edge cases (e.g. clients that
    // call `->get($computedUrl)` where $computedUrl is built dynamically).
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method) && args[0] && looksLikeHttpUrlArg(args[0])) {
        add(node, callee, args[0].text, { resourceType: 'ExternalAPI', operation: 'READS', role: 'url', confidence: 0.9 });
        return;
    }

    // MongoDB PHP driver — MongoDB\Client / MongoDB\Database / MongoDB\Collection.
    //   Client::selectCollection(string $db, string $collection)   → args[1] is the resource
    //   Database::selectCollection(string $collection)             → args[0] is the resource
    //   Database::createCollection(string $collection, ...)        → args[0] is the resource
    //   Client::selectDatabase(string $db)                         → not a DataContainer; the
    //                                                                database is the Datastore.
    //                                                                Do NOT register.
    //
    // Without this branch, the legacy generic regex extractor (extractors.ts)
    // matches any `(collection|table|from|query|...)` call and unconditionally
    // takes args[0] — so `$client->selectCollection('archive', 'events')` would
    // emit `archive` (the Mongo database name) as a DataContainer instead of
    // the real collection `events`. The role 'collection' maps deterministically
    // to kindFamily='document' via inferKindFamilyFromRole, so the structural
    // family signal is preserved and the binding gate accepts the Mongo
    // connection for these DCs.
    if (method === 'selectCollection') {
        const idx = args.length >= 2 ? 1 : 0;
        if (args[idx]) {
            // A dynamic collection name (`sprintf('quote_%s', $tipo)` /
            // `'quote_' . $tipo`) is unresolvable verbatim and would be dropped at
            // the completeness gate, losing a NAMED Mongo collection. Resolve it to
            // a prefix STUB ('quote_{tipo}') — the SQL dynamic-table precedent — so
            // it survives as a named document DataContainer (and the dynamic-infra
            // resolver can expand it), instead of collapsing to a name-less binding.
            const stub = phpDynamicCollectionStub(args[idx]);
            const collExpr = stub !== null ? `'${stub}'` : args[idx].text;
            add(node, callee, collExpr, {
                resourceType: 'Database',
                operation: 'READS',
                role: 'collection',
                confidence: 0.92,
            });
        }
        return;
    }
    if (method === 'createCollection' && args[0]) {
        add(node, callee, args[0].text, {
            resourceType: 'Database',
            operation: 'WRITES',
            role: 'collection',
            confidence: 0.92,
        });
        return;
    }

    // InfluxDB client write surface — influxdb/influxdb-php `\InfluxDB\Database::writePoints`,
    // v2 client `writePoint`. A time-series store is schemaless (metric points, no
    // table/collection), so there is no logical container: emit a measurement-less
    // Database write with name `<DYNAMIC>` and role `timeseries`. `<DYNAMIC>` routes
    // graph-writer to its no-DataContainer path, which (with kindFamily `timeseries`)
    // binds the function -> Datastore directly — the memcached analog, not an ORM table.
    // Recognise ONLY the standard client method names, never a bespoke wrapper class.
    if (method === 'writePoints' || method === 'writePoint') {
        add(node, callee, '<DYNAMIC>', {
            resourceType: 'Database',
            operation: 'WRITES',
            role: 'timeseries',
            confidence: 0.9,
        });
        return;
    }

    if (['prepare', 'query', 'exec', 'executeQuery', 'executeStatement', 'from', 'insert', 'update', 'delete'].includes(method) && args[0]) {
        // Dynamic-table resolution: when the SQL interpolates a local variable
        // whose assignment carries a literal prefix
        // (`$table = 'shipment_log_' . $carrierType`), substitute the variable
        // with a prefix STUB (`shipment_log_{carrierType}`) so the downstream
        // SQL-table extractor yields a rewireable stub instead of abstaining.
        // The literal prefix is ground truth in the AST — zero hallucination
        // risk — so the deterministic static path can own it rather than
        // deferring an opaque `<DYNAMIC>` to the LLM.
        const sqlExpr = resolvePhpDynamicTableSql(node, args[0].text);
        add(node, callee, sqlExpr, {
            resourceType: 'Database',
            operation: databaseOperationForPhp(method, sqlExpr),
            role: ['from', 'insert', 'update', 'delete'].includes(method) ? 'table' : 'sql',
            confidence: 0.92,
        });
    }

    // DI binding fallback: when the receiver is `$this->X` and X corresponds
    // to a promoted property bound via #[Autowire] (priority 1) or type-hint
    // FQCN (priority 2 — Symfony >= 4.3 default autowire-by-type), register
    // an additional critical invocation with the prompt-only `serviceId`
    // role. This routes the function through the LLM/DI-registry path so
    // arbitrary methods on injected services (`->process()`, `->run()`,
    // custom consumer/handler protocols) are visible end-to-end.
    //
    // Recognised broker/SQL/HTTP methods above already returned with their
    // specific resource shape; this fallback only fires when those branches
    // didn't match — or when SQL matched (no return), in which case we
    // co-emit so the bypass guard still routes to the LLM for DI recovery.
    if (classBindings && classBindings.size > 0 && receiver) {
        const propName = thisPropertyName(receiver);
        if (propName) {
            const binding = classBindings.get(propName);
            if (binding) {
                add(node, callee, JSON.stringify(binding.serviceId), {
                    resourceType: 'MessageChannel',  // placeholder; sanitizer/LLM assigns the real type
                    operation: 'READS',
                    role: 'serviceId',                // prompt-only: triggers static-bypass guard
                    confidence: binding.confidence,
                });
            }
        }
    }
}

function extractPhpScopedInvocation(node: Parser.SyntaxNode, add: (
    node: Parser.SyntaxNode,
    callee: string,
    resourceExpression: string,
    spec: ResourceSpec,
    evidence?: string,
) => void): void {
    const { className, methodName } = phpScopedCallParts(node);
    const args = phpCallArguments(node);
    if (!methodName) return;
    const callee = className ? `${className}::${methodName}` : methodName;

    if (['dispatch', 'push'].includes(methodName) && args[0]) {
        const messageClass = objectCreationClassName(args[0]);
        if (messageClass) {
            add(node, callee, messageClass, {
                resourceType: 'MessageChannel',
                operation: 'WRITES',
                role: 'messageClass',
                confidence: 0.72,
            }, args[0].text);
            return;
        }
        if (isLikelyResourceExpression(args[0])) {
            add(node, callee, args[0].text, {
                resourceType: 'MessageChannel',
                operation: 'WRITES',
                role: 'topic',
                confidence: 0.86,
            });
        }
    }
}

/**
 * Detect Symfony Messenger handler entry points and emit a `messageClass`
 * critical-invocation for the typed parameter. Without this, the LLM has no
 * canonical-routing-key context for handlers and falls back to extracting from
 * log message strings, producing short stems like `save.requested` instead
 * of the canonical `acme.inventory.save.requested`.
 *
 * Two recognition paths (legacy + modern PHP both supported):
 *   - **Modern**: any method decorated with `#[AsMessageHandler]` attribute.
 *     The method name is free; the attribute IS the handler signal.
 *   - **Legacy**: a method named `__invoke` whose first typed parameter
 *     matches the CQRS suffix pattern (`Message|Event|Command|Query`).
 *     CQRS-suffix is a heuristic; registry cross-check is deferred to the
 *     downstream value-resolution where `SymfonyMessenger.routing.<Class>`
 *     facts are looked up.
 *
 * Emitted invocation: same shape as `dispatch(new XxxMessage())` but with
 * `operation: 'READS'` (consumption side). The downstream
 * `resolveMessageClassInvocation` then maps the class name to the canonical
 * routing key via `SymfonyMessenger.routing.<Class>` lookup.
 */
const CQRS_PARAM_PATTERN = /(Message|Event|Command|Query)$/;

function extractPhpHandlerInbound(
    methodNode: Parser.SyntaxNode,
    add: (
        node: Parser.SyntaxNode,
        callee: string,
        resourceExpression: string,
        spec: ResourceSpec,
        evidence?: string,
    ) => void,
): void {
    const methodName = methodNode.children.find(c => c.type === 'name')?.text;
    if (!methodName) return;

    const hasAttribute = methodNode.children.some(c =>
        c.type === 'attribute_list' && /\bAsMessageHandler\b/.test(c.text)
    );

    // Legacy gate: only __invoke methods are considered without the attribute.
    if (!hasAttribute && methodName !== '__invoke') return;

    const formalParameters = methodNode.children.find(c => c.type === 'formal_parameters');
    if (!formalParameters) return;

    const firstParam = formalParameters.children.find(c =>
        c.type === 'simple_parameter' || c.type === 'property_promotion_parameter'
    );
    if (!firstParam) return;

    // Extract the type-hint class name. Accept named_type, union_type (first variant),
    // intersection_type (first variant). Reject parameters with no type-hint.
    const typeNode = firstParam.children.find(c =>
        c.type === 'named_type' || c.type === 'union_type' || c.type === 'intersection_type'
    );
    if (!typeNode) return;

    // Strip leading backslashes and any namespace prefix, keep the bare class name.
    // For union/intersection types, take the first name-like child.
    const typeText = (typeNode.type === 'named_type')
        ? typeNode.text
        : typeNode.children.find(c => c.type === 'named_type')?.text ?? typeNode.text;
    const stripped = typeText.replace(/^\\+/, '').trim();
    const className = stripped.split('\\').pop() ?? stripped;
    if (!className) return;

    // Legacy fallback gate: without the attribute we require CQRS suffix to
    // avoid emitting on every PHP method named __invoke (e.g. invokable
    // commands taking a Request object).
    if (!hasAttribute && !CQRS_PARAM_PATTERN.test(className)) return;

    add(methodNode, `${methodName}(${className})`, className, {
        resourceType: 'MessageChannel',
        operation: 'READS',
        role: 'messageClass',
        confidence: 0.72,
    });
}

function addRabbitPublishInvocation(
    node: Parser.SyntaxNode,
    callee: string,
    args: Parser.SyntaxNode[],
    add: (
        node: Parser.SyntaxNode,
        callee: string,
        resourceExpression: string,
        spec: ResourceSpec,
        evidence?: string,
    ) => void,
): void {
    if (args[2]) {
        add(node, callee, args[2].text, { resourceType: 'MessageChannel', operation: 'WRITES', role: 'routingKey' });
        return;
    }
    if (args[1]) {
        add(node, callee, args[1].text, { resourceType: 'MessageChannel', operation: 'WRITES', role: 'exchange' });
    }
}

function addDispatchInvocation(
    node: Parser.SyntaxNode,
    callee: string,
    arg: Parser.SyntaxNode,
    add: (
        node: Parser.SyntaxNode,
        callee: string,
        resourceExpression: string,
        spec: ResourceSpec,
        evidence?: string,
    ) => void,
): void {
    const messageClass = objectCreationClassName(arg);
    if (messageClass) {
        add(node, callee, messageClass, {
            resourceType: 'MessageChannel',
            operation: 'WRITES',
            role: 'messageClass',
            confidence: 0.72,
        }, arg.text);
    }
}

function choosePublishResource(
    receiver: Parser.SyntaxNode | null,
    args: Parser.SyntaxNode[],
): { text: string; role: string; confidence: number } | null {
    if (args[0]) {
        const laravelConfig = phpLaravelConfigAlias(args[0]);
        if (laravelConfig) {
            // Generic role token: the agnostic core branches on 'configRef'
            // (framework config-accessor reference, prompt-only) without
            // knowing which framework produced it.
            return { text: laravelConfig, role: 'configRef', confidence: 0.78 };
        }
    }

    if (args[0] && isLikelyResourceExpression(args[0])) {
        return { text: args[0].text, role: inferMessageRole(args[0].text), confidence: 0.95 };
    }

    const serviceId = receiver ? serviceLocatorResource(receiver) : null;
    if (serviceId) {
        return serviceId;
    }

    // A bare local variable (`$topic->publish(...)`) is a HANDLE, not a channel
    // name — its real name was captured upstream where it was assigned (e.g. the
    // Pub/Sub `->topic('name')` accessor, recognized above). Returning the
    // variable text here only produces an unresolvable noise channel that trips
    // the fail-closed MessageChannel guard. Property/method receivers
    // (`$this->topicName`) still resolve via value facts and are kept.
    if (receiver && isLikelyResourceExpression(receiver)
        && unwrapPhpNode(receiver).type !== 'variable_name') {
        return { text: receiver.text, role: inferMessageRole(receiver.text), confidence: 0.95 };
    }

    // The final fallback takes the first arg as the channel name, but a publish
    // PAYLOAD is never a name. Skip the two payload shapes: an array
    // (`publish(['data' => ...])`) and a constructed object
    // (`publish(new OrderEvent([...]))` — the event/message class is the
    // serialized body, the channel is the topic the wrapper targets, resolved
    // elsewhere). CQRS `dispatch(new XMessage())` on an abstract bus has its own
    // branch (addDispatchInvocation) and is unaffected.
    if (args[0]) {
        const argKind = unwrapPhpNode(args[0]).type;
        if (argKind !== 'array_creation_expression' && argKind !== 'object_creation_expression') {
            return { text: args[0].text, role: 'message', confidence: 0.72 };
        }
    }

    return null;
}

function phpLaravelConfigAlias(node: Parser.SyntaxNode): string | null {
    const value = unwrapPhpNode(node);
    if (value.type !== 'function_call_expression') return null;
    if (phpFunctionName(value) !== 'config') return null;

    const args = phpCallArguments(value);
    if (args.length === 0) return null;
    const configKey = phpLiteralValue(args[0]);
    if (!configKey || !/^[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)*$/.test(configKey)) return null;
    return `__laravel_config_${configKey}`;
}

function serviceLocatorResource(node: Parser.SyntaxNode): { text: string; role: string; confidence: number } | null {
    const value = unwrapPhpNode(node);
    if (value.type !== 'member_call_expression') return null;

    const method = phpMemberMethodName(value);
    if (method !== 'get' && method !== 'getParameter') return null;

    const receiver = phpMemberReceiver(value);
    if (!receiver || !isLikelyServiceContainer(receiver.text)) return null;

    const args = phpCallArguments(value);
    if (!args[0]) return { text: value.text, role: 'serviceId', confidence: 0.45 };

    const literal = phpLiteralValue(args[0]);
    if (literal !== undefined) {
        return { text: JSON.stringify(literal), role: method === 'getParameter' ? 'parameterId' : 'serviceId', confidence: 0.75 };
    }

    const argValue = unwrapPhpNode(args[0]);
    const constant = argValue.type === 'class_constant_access_expression'
        ? canonicalizePhpReference(argValue, null)
        : null;
    if (constant) {
        return { text: constant.key, role: method === 'getParameter' ? 'parameterId' : 'serviceId', confidence: 0.7 };
    }

    return { text: args[0].text, role: method === 'getParameter' ? 'parameterId' : 'serviceId', confidence: 0.45 };
}

function isLikelyServiceContainer(text: string): boolean {
    return /\$?(?:this->)?(?:container|services|serviceLocator)\b/i.test(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// DI binding helpers — Symfony 4.3+ autowire by type-hint
//
// Modern Symfony autowires constructor-injected services by type-hint FQCN
// (e.g. `private MessageBusInterface $bus`). The `#[Autowire]` attribute is
// only used to disambiguate multiple implementations of the same interface.
//
// To recognise these injection patterns the plugin must:
//   1. Resolve the parameter type-hint against the file's `use` statements +
//      class namespace to obtain a FQCN.
//   2. Use that FQCN as the service identifier, falling through the existing
//      prompt-only-role guard so the function is routed to the LLM.
//
// No customer-specific names or interfaces are hardcoded — the filter is
// purely syntactic (FQCN-shape).
// ─────────────────────────────────────────────────────────────────────────────

const PHP_SCALAR_TYPES = new Set([
    'string', 'int', 'integer', 'float', 'double', 'bool', 'boolean',
    'array', 'iterable', 'object', 'callable', 'void', 'null', 'mixed',
    'never', 'self', 'static', 'parent', 'true', 'false', 'resource',
]);

function isScalarPhpType(typeHint: string): boolean {
    const trimmed = typeHint.replace(/^[?]/, '').trim().toLowerCase();
    if (!trimmed) return true;
    return PHP_SCALAR_TYPES.has(trimmed);
}

export interface PhpFileScope {
    /** Map: local alias (or short name) → fully-qualified class name. */
    useAliases: Map<string, string>;
    /** Namespace declared at the top of the file, or empty for global. */
    namespace: string;
}

export function extractPhpFileScope(rootNode: Parser.SyntaxNode): PhpFileScope {
    const useAliases = new Map<string, string>();
    let namespace = '';

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'namespace_definition') {
            const nameNode = node.children.find(c => c.type === 'qualified_name' || c.type === 'name' || c.type === 'namespace_name');
            if (nameNode) namespace = nameNode.text.replace(/^\\/, '');
            return;
        }
        if (node.type === 'namespace_use_declaration') {
            for (const clause of node.children) {
                if (clause.type !== 'namespace_use_clause') continue;
                const fullNode = clause.children.find(c => c.type === 'qualified_name' || c.type === 'name');
                if (!fullNode) continue;
                const full = fullNode.text.replace(/^\\/, '');
                const aliasMatch = clause.text.match(/\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
                const alias = aliasMatch?.[1] ?? full.slice(full.lastIndexOf('\\') + 1);
                if (alias) useAliases.set(alias, full);
            }
            return;
        }
        for (const child of node.children) walk(child);
    };
    walk(rootNode);
    return { useAliases, namespace };
}

export function resolveTypeHintToFqcn(typeHint: string, scope: PhpFileScope): string | null {
    if (!typeHint) return null;
    const cleaned = typeHint.replace(/^[?]/, '').trim();
    if (!cleaned) return null;
    // Already FQCN (leading backslash) — strip and return canonical form.
    if (cleaned.startsWith('\\')) return cleaned.slice(1);
    // Multi-segment qualified name (e.g. `Some\Sub\Class`) — also FQCN-like.
    if (cleaned.includes('\\')) {
        const head = cleaned.split('\\')[0];
        const aliasResolved = scope.useAliases.get(head);
        if (aliasResolved) {
            const tail = cleaned.slice(head.length);
            return `${aliasResolved}${tail}`;
        }
        // Otherwise treat as a sub-namespace of the current namespace.
        return scope.namespace ? `${scope.namespace}\\${cleaned}` : cleaned;
    }
    // Bare class name — must be in `use` map or relative to current namespace.
    const aliased = scope.useAliases.get(cleaned);
    if (aliased) return aliased;
    if (scope.namespace) return `${scope.namespace}\\${cleaned}`;
    return cleaned;
}

interface DiBinding {
    serviceId: string;
    source: 'autowire' | 'typehint';
    confidence: number;
}

/**
 * Build a `propertyName → DiBinding` map for the given class node by walking
 * its constructor's promoted-property parameters. Two binding sources, in
 * order of priority:
 *
 *   1. `#[Autowire(service: 'x')]` attribute — explicit service ID, used when
 *      the developer needs to disambiguate multiple implementations.
 *   2. Type-hint FQCN — Symfony's default autowire-by-type behaviour
 *      (Symfony >= 4.3). The FQCN is the service ID under `services.yaml`
 *      with `autowire: true`.
 *
 * Returns an empty map when the class has no constructor or no promoted
 * properties.
 */
function buildClassDiBindings(
    classNode: Parser.SyntaxNode,
    scope: PhpFileScope,
): Map<string, DiBinding> {
    const bindings = new Map<string, DiBinding>();
    // Find the constructor method declaration inside the class body.
    const body = classNode.children.find(c => c.type === 'declaration_list' || c.type === 'class_body');
    if (!body) return bindings;

    let ctor: Parser.SyntaxNode | null = null;
    for (const member of body.children) {
        if (member.type !== 'method_declaration') continue;
        if (member.childForFieldName('name')?.text === '__construct') { ctor = member; break; }
    }
    if (!ctor) return bindings;

    const parameters = ctor.childForFieldName('parameters')
        ?? ctor.children.find(c => c.type === 'formal_parameters');
    if (!parameters) return bindings;

    for (const param of parameters.children) {
        if (param.type !== 'property_promotion_parameter' && param.type !== 'simple_parameter') continue;
        const hasVisibility = param.children.some(c => c.type === 'visibility_modifier');
        if (!hasVisibility) continue; // not a promoted property

        const variableNode = param.children.find(c => c.type === 'variable_name');
        if (!variableNode) continue;
        const propName = variableNode.text.replace(/^\$/, '');

        // Priority 1: explicit Autowire attribute
        const autowireId = extractAutowireServiceId(param);
        if (autowireId) {
            bindings.set(propName, { serviceId: autowireId, source: 'autowire', confidence: isLikelyChannelServiceId(autowireId) ? 0.97 : 0.82 });
            continue;
        }

        // Priority 2: type-hint FQCN fallback (Symfony default)
        const typeNode = param.children.find(c =>
            c.type === 'named_type'
            || c.type === 'optional_type'
            || c.type === 'union_type'
            || c.type === 'intersection_type'
            || c.type === 'primitive_type'
            || c.type === 'type_list',
        );
        if (!typeNode) continue;
        const rawType = typeNode.text;
        // Pick the first class-typed component for union/intersection.
        const candidate = rawType.split(/\s*[|&]\s*/).find(t => t && !isScalarPhpType(t)) ?? '';
        if (!candidate || isScalarPhpType(candidate)) continue;

        const fqcn = resolveTypeHintToFqcn(candidate, scope);
        if (!fqcn || isScalarPhpType(fqcn)) continue;
        bindings.set(propName, { serviceId: fqcn, source: 'typehint', confidence: 0.78 });
    }
    return bindings;
}

/** Extract the property name from `$this->propName` AST. */
function thisPropertyName(receiver: Parser.SyntaxNode): string | null {
    const value = unwrapPhpNode(receiver);
    if (value.type !== 'member_access_expression') return null;
    const obj = value.childForFieldName('object') ?? value.children.find(c => c.type === 'variable_name');
    if (!obj || obj.text !== '$this') return null;
    const nameNode = value.childForFieldName('name')
        ?? value.children.find(c => c.type === 'name' || c.type === 'member_name');
    return nameNode?.text ?? null;
}

function canonicalizePhpReference(node: Parser.SyntaxNode, className: string | null): PhpReference | null {
    const value = unwrapPhpNode(node);

    if (value.type === 'variable_name') {
        return { key: value.text.replace(/^\$/, ''), confidence: 0.95 };
    }

    if (value.type === 'member_access_expression') {
        const receiver = value.children[0];
        const property = [...value.children].reverse().find(child => child.type === 'name');
        if (!receiver || !property) return null;
        const receiverRef = canonicalizePhpReference(receiver, className);
        if (!receiverRef) return null;
        return {
            key: `${receiverRef.key}.${property.text}`,
            confidence: receiverRef.confidence,
        };
    }

    if (value.type === 'subscript_expression') {
        return canonicalizePhpSubscriptExpression(value, className);
    }

    if (value.type === 'class_constant_access_expression') {
        const constant = [...value.children].reverse().find(child => child.type === 'name');
        if (!constant) return null;
        const scope = value.children.find(child =>
            child.type === 'relative_scope'
            || child.type === 'name'
            || child.type === 'qualified_name',
        );
        if (!scope) return null;
        if (scope.text === 'self') {
            return className ? { key: `${className}.${constant.text}`, confidence: 0.98 } : null;
        }
        if (scope.text === 'static') {
            return className ? { key: `${className}.${constant.text}`, confidence: 0.74 } : null;
        }
        if (scope.text === 'parent') return null;
        return {
            key: `${shortPhpName(scope.text)}.${constant.text}`,
            confidence: 0.95,
        };
    }

    if (value.type === 'name' || value.type === 'qualified_name') {
        return { key: shortPhpName(value.text), confidence: 0.9 };
    }

    return null;
}

function canonicalizePhpSubscriptExpression(node: Parser.SyntaxNode, className: string | null): PhpReference | null {
    const parts: string[] = [];
    let current: Parser.SyntaxNode | null = node;

    while (current?.type === 'subscript_expression') {
        const objectNode: Parser.SyntaxNode | undefined = current.children[0];
        const indexNode = current.children.find((child, index) =>
            index > 0
            && child.text !== '['
            && child.text !== ']',
        );
        const index = indexNode ? phpArrayKeyValue(indexNode) : null;
        if (!objectNode || !index) return null;
        parts.unshift(index);
        current = objectNode;
    }

    if (!current) return null;
    const base = canonicalizePhpReference(current, className);
    if (!base) return null;
    return {
        key: `${base.key}.${parts.join('.')}`,
        confidence: base.confidence,
    };
}

function extractPhpEnvDefault(node: Parser.SyntaxNode): { envKey: string; fallbackValue: string } | null {
    if (node.type !== 'function_call_expression') return null;
    const name = phpFunctionName(node);
    if (name !== 'env') return null;
    const args = phpCallArguments(node);
    const envKey = args[0] ? phpLiteralValue(args[0]) : undefined;
    const fallbackValue = args[1] ? phpLiteralValue(args[1]) : undefined;
    if (!envKey || fallbackValue === undefined) return null;
    return { envKey, fallbackValue };
}

function extractPhpFallback(node: Parser.SyntaxNode): { envKey?: string; fallbackValue: string; confidence: number } | null {
    if (node.type === 'binary_expression') {
        const opIndex = node.children.findIndex(child => child.text === '??' || child.text === '||');
        if (opIndex > 0 && opIndex < node.children.length - 1) {
            const left = node.children[opIndex - 1];
            const right = unwrapPhpNode(node.children[opIndex + 1]);
            const fallbackValue = phpLiteralValue(right);
            if (fallbackValue !== undefined) {
                return {
                    envKey: left ? phpEnvKey(left) : undefined,
                    fallbackValue,
                    confidence: phpEnvKey(left) ? 0.95 : 0.9,
                };
            }
        }
    }

    if (node.type === 'conditional_expression') {
        const literal = [...node.children].reverse()
            .map(child => phpLiteralValue(unwrapPhpNode(child)))
            .find(value => value !== undefined);
        if (literal !== undefined) {
            return {
                envKey: phpEnvKey(node.children[0]),
                fallbackValue: literal,
                confidence: phpEnvKey(node.children[0]) ? 0.95 : 0.9,
            };
        }
    }

    const regexFallback = node.text.match(/(?:\?\?|\|\||\?:)\s*(['"])([^'"]*)\1\s*$/);
    if (regexFallback && !regexFallback[2].includes('${')) {
        return {
            envKey: extractEnvKey(node.text),
            fallbackValue: regexFallback[2],
            confidence: extractEnvKey(node.text) ? 0.95 : 0.9,
        };
    }

    return null;
}

function phpEnvKey(node: Parser.SyntaxNode | undefined): string | undefined {
    if (!node) return undefined;
    const value = unwrapPhpNode(node);

    if (value.type === 'function_call_expression') {
        const name = phpFunctionName(value);
        if (name === 'getenv' || name === 'env') {
            const first = phpCallArguments(value)[0];
            return first ? phpLiteralValue(first) : undefined;
        }
    }

    if (value.type === 'subscript_expression') {
        const base = value.children[0];
        const keyNode = value.children.find((child, index) =>
            index > 0
            && child.text !== '['
            && child.text !== ']',
        );
        if ((base?.text === '$_ENV' || base?.text === '$_SERVER') && keyNode) {
            return phpArrayKeyValue(keyNode) ?? undefined;
        }
    }

    const literal = phpLiteralValue(value);
    const symfonyEnv = literal?.match(/^%env\((?:[a-z_]+:)?([A-Z][A-Z0-9_]*)\)%$/i);
    if (symfonyEnv) return symfonyEnv[1];

    return extractEnvKey(value.text);
}

function phpLiteralValue(node: Parser.SyntaxNode): string | undefined {
    const value = unwrapPhpNode(node);
    if (value.type === 'string' || value.type === 'encapsed_string') {
        if (value.children.some(child => child.type === 'variable_name')) return undefined;
        const raw = extractStringLiteralValueRaw(value.text);
        if (raw === null || raw.includes('${')) return undefined;
        if (/^%env\((?:[a-z_]+:)?[A-Z][A-Z0-9_]*\)%$/i.test(raw)) return undefined;
        return raw;
    }
    if (value.type === 'integer' || value.type === 'float') return value.text;
    return undefined;
}

function phpArrayKeyValue(node: Parser.SyntaxNode): string | null {
    const value = unwrapPhpNode(node);
    if (value.type === 'string' || value.type === 'encapsed_string') {
        return phpLiteralValue(value) ?? null;
    }
    if (value.type === 'integer' || value.type === 'name') return value.text;
    return null;
}

function phpCallArguments(callNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const argsNode = callNode.childForFieldName('arguments')
        ?? callNode.children.find(child => child.type === 'arguments');
    if (!argsNode) return [];

    const args: Parser.SyntaxNode[] = [];
    for (const child of argsNode.children) {
        if (child.type !== 'argument') continue;
        const value = argumentValueNode(child);
        if (value) args.push(value);
    }
    return args;
}

function argumentValueNode(arg: Parser.SyntaxNode): Parser.SyntaxNode | null {
    const colonIndex = arg.children.findIndex(child => child.text === ':');
    if (colonIndex >= 0) {
        return arg.children.slice(colonIndex + 1).find(isMeaningfulNode) ?? null;
    }
    return arg.children.find(isMeaningfulNode) ?? null;
}

function phpFunctionName(node: Parser.SyntaxNode): string | null {
    return node.children.find(child =>
        child.type === 'name'
        || child.type === 'qualified_name',
    )?.text ?? null;
}

function phpMemberMethodName(node: Parser.SyntaxNode): string | null {
    const args = node.children.find(child => child.type === 'arguments');
    const beforeArgs = args ? node.children.slice(0, node.children.indexOf(args)) : node.children;
    return [...beforeArgs].reverse().find(child => child.type === 'name')?.text ?? null;
}

function phpMemberReceiver(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    const arrowIndex = node.children.findIndex(child => child.text === '->');
    if (arrowIndex <= 0) return null;
    return node.children[arrowIndex - 1] ?? null;
}

function phpScopedCallParts(node: Parser.SyntaxNode): { className?: string; methodName?: string } {
    const names = node.children.filter(child =>
        child.type === 'name'
        || child.type === 'qualified_name',
    );
    return {
        className: names[0]?.text,
        methodName: names[names.length - 1]?.text,
    };
}

function objectCreationClassName(node: Parser.SyntaxNode): string | null {
    const value = unwrapPhpNode(node);
    if (value.type !== 'object_creation_expression') return null;
    const name = value.children.find(child =>
        child.type === 'name'
        || child.type === 'qualified_name',
    );
    return name ? shortPhpName(name.text) : null;
}

function unwrapPhpNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
    if (node.type === 'argument') {
        const value = argumentValueNode(node);
        return value ? unwrapPhpNode(value) : node;
    }
    if (node.type === 'parenthesized_expression') {
        const inner = node.children.find(isMeaningfulNode);
        return inner ? unwrapPhpNode(inner) : node;
    }
    return node;
}

function valueAfterEquals(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    const eqIndex = node.children.findIndex(child => child.text === '=');
    if (eqIndex < 0) return null;
    return node.children.slice(eqIndex + 1).find(isMeaningfulNode) ?? null;
}

function isMeaningfulNode(node: Parser.SyntaxNode): boolean {
    return ![
        '(',
        ')',
        '[',
        ']',
        ',',
        ';',
        ':',
        '=',
        '=>',
        'return',
        'array',
        'new',
    ].includes(node.text) && ![
        '(',
        ')',
        '[',
        ']',
        ',',
        ';',
    ].includes(node.type);
}

function extractAutowireServiceId(node: Parser.SyntaxNode): string | null {
    return node.text.match(/\bAutowire\s*\(\s*service\s*:\s*['"]([^'"]+)['"]/i)?.[1] ?? null;
}

function isLikelyChannelServiceId(value: string): boolean {
    return /(?:^|[._-])(topics?|queues?|subscriptions?|exchanges?)(?:[._-]|$)|rabbit|kafka|pubsub|sns|sqs|nats/i.test(value);
}

function isLikelyResourceExpression(node: Parser.SyntaxNode): boolean {
    const text = node.text;
    if (node.type === 'class_constant_access_expression') return true;
    if (phpLiteralValue(node) !== undefined) return true;
    return /\b(topic|queue|channel|exchange|routing|subscription|stream|bus)\b/i.test(text)
        || /\$(topic|queue|channel|exchange|routingKey|subscription)\b/i.test(text);
}

/**
 * Heuristic: does the first argument of a `->get/post/put/patch/delete()` call
 * carry the static evidence of being a URL/HTTP path?
 *
 * Positive cases (string literals):
 *   - contains `://` (scheme + authority)
 *   - starts with `/` (absolute path)
 *   - contains `?` (query string)
 *   - equals a URL-shaped templated path with `{var}` placeholders or
 *     percent-encoding in the literal (`/users/{id}`, `/users/%s`)
 *
 * Positive cases (variables): the variable's identifier hints at a URL-typed
 * value (`$url`, `$uri`, `$endpoint`, `$path`, `$route`, `$webhook`).
 *
 * Negative cases (rejected — common false-positive sources):
 *   - bare ID variables (`$id`, `$key`), numeric literals, short identifiers
 *   - `Doctrine\Common\Collections\ArrayCollection::get($key)`
 *   - `EntityRepository::get($id)`, repository accessors
 *   - DTO field getters (`$user->orders->get($id)`)
 *
 * The LLM path still recovers genuine HTTP calls whose receiver looks unusual.
 */
function looksLikeHttpUrlArg(node: Parser.SyntaxNode): boolean {
    const literal = phpLiteralValue(node);
    if (literal !== undefined) {
        if (literal.includes('://')) return true;
        if (literal.startsWith('/')) return true;
        if (literal.includes('?')) return true;
        // Templated path (e.g. `/users/{id}` after stripping leading slash, or
        // route definitions like `users/{id}` used by some RPC clients).
        if (/\{[A-Za-z_][\w-]*\}/.test(literal)) return true;
        return false;
    }
    // Non-literal argument: gate on a URL-suggestive variable name.
    const text = node.text;
    if (/^\$(?:url|uri|endpoint|path|route|webhook|target|address|host)\b/i.test(text)) return true;
    return false;
}

function inferMessageRole(text: string): string {
    if (/routing/i.test(text)) return 'routingKey';
    if (/exchange/i.test(text)) return 'exchange';
    if (/queue/i.test(text)) return 'queue';
    if (/subscription/i.test(text)) return 'subscription';
    return 'topic';
}

function databaseOperationForPhp(method: string, expression: string): ResolvedOperation {
    if (/^\s*['"]\s*(?:select|show|with)\b/i.test(expression)) return 'READS';
    if (['from'].includes(method)) return 'READS';
    return 'WRITES';
}

// ─── Dynamic-table prefix resolution (deterministic) ────────────────────────
// A PHP function frequently builds a table name from a literal prefix and a
// runtime variable, then interpolates it into the SQL:
//
//   $table = 'shipment_log_' . $carrierType;
//   $db->prepare("INSERT INTO {$table} ...");
//
// The static SQL-table extractor cannot parse `{$table}`, so it abstains and
// the function falls through to the LLM, which emits the opaque `<DYNAMIC>`
// sentinel (dropped by the sanitizer) — the dynamic write is lost. But the
// literal prefix is right there in the AST: we resolve `$table` to the stub
// `shipment_log_{carrierType}` and splice it back into the SQL so the extractor
// yields the rewireable `shipment_log_` prefix. The DataEntityPostProcessor
// then expands it to the concrete sibling tables.

/** Walk up to the function/method/closure that lexically encloses `node`. */
function findEnclosingPhpFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    for (let cur = node.parent; cur; cur = cur.parent) {
        if (cur.type === 'method_declaration'
            || cur.type === 'function_definition'
            || cur.type === 'anonymous_function_creation_expression'
            || cur.type === 'arrow_function') {
            return cur;
        }
    }
    return null;
}

/**
 * Render a value expression as a dynamic-table stub: string literals keep their
 * text, variables become `{name}` placeholders, concatenations join their
 * parts. Returns null for shapes that cannot form a stable prefix (member
 * accesses, calls, subscripts), so we never invent a table name.
 */
function phpExprToTableStub(node: Parser.SyntaxNode): string | null {
    const n = unwrapPhpNode(node);
    if (n.type === 'string') {
        const content = n.children.find(child => child.type === 'string_content');
        return content ? content.text : (extractStringLiteralValueRaw(n.text) ?? '');
    }
    if (n.type === 'variable_name') {
        const name = n.children.find(child => child.type === 'name')?.text;
        return name ? `{${name}}` : null;
    }
    if (n.type === 'binary_expression') {
        if (!n.children.some(child => child.type === '.')) return null; // not concatenation
        const parts: string[] = [];
        for (const child of n.children) {
            if (child.type === '.' || !isMeaningfulNode(child)) continue;
            const part = phpExprToTableStub(child);
            if (part === null) return null;
            parts.push(part);
        }
        return parts.join('');
    }
    if (n.type === 'encapsed_string') {
        const parts: string[] = [];
        for (const child of n.children) {
            if (child.type === '"' || child.type === "'" || child.type === '{' || child.type === '}') continue;
            if (child.type === 'string_content') { parts.push(child.text); continue; }
            if (child.type === 'variable_name') {
                const name = child.children.find(ch => ch.type === 'name')?.text;
                if (!name) return null;
                parts.push(`{${name}}`);
                continue;
            }
            if (isMeaningfulNode(child)) return null; // escape sequences / complex interpolation
        }
        return parts.join('');
    }
    return null;
}

/**
 * Collect `$var -> stub` mappings for local assignments in the enclosing
 * function whose resolved value is a genuine dynamic stub (carries a literal
 * prefix AND a `{var}` placeholder). Pure-literal assignments are intentionally
 * excluded — those are not the dynamic-table case this resolver targets.
 */
function buildLocalTableStubMap(callNode: Parser.SyntaxNode): Map<string, string> {
    const map = new Map<string, string>();
    const fn = findEnclosingPhpFunction(callNode);
    if (!fn) return map;
    const walk = (n: Parser.SyntaxNode): void => {
        if (n.type === 'assignment_expression') {
            const left = n.children.find(isMeaningfulNode);
            if (left?.type === 'variable_name') {
                const name = left.children.find(child => child.type === 'name')?.text;
                const rhs = valueAfterEquals(n);
                if (name && rhs) {
                    const stub = phpExprToTableStub(rhs);
                    // Require a static prefix (not starting with a placeholder) and
                    // at least one `{var}` so this only fires on dynamic tables.
                    if (stub && /^[A-Za-z0-9_]/.test(stub) && stub.includes('{')) {
                        map.set(name, stub);
                    }
                }
            }
        }
        for (const child of n.children) walk(child);
    };
    walk(fn);
    return map;
}

/**
 * Substitute interpolated local table variables (`{$table}` / `$table`) in a
 * SQL string literal with their resolved prefix stubs. No-op when the SQL has
 * no interpolation or no resolvable local assignment.
 */
function resolvePhpDynamicTableSql(callNode: Parser.SyntaxNode, sqlText: string): string {
    if (!sqlText.includes('$')) return sqlText;
    const map = buildLocalTableStubMap(callNode);
    if (map.size === 0) return sqlText;
    let out = sqlText;
    for (const [name, stub] of map) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`\\{\\$${escaped}\\}|\\$${escaped}(?![A-Za-z0-9_])`, 'g'), stub);
    }
    return out;
}

/** Neutral placeholder for a dynamic name segment. Deliberately NOT the source
 *  variable name: the same collection (`sprintf('quote_%s', $tipo)` in one
 *  call site, `sprintf('quote_%s', getTypes($q->getType()))` in another) must
 *  collapse to ONE node, not split by the incidental local-var name. */
const DYNAMIC_NAME_SEGMENT = '{var}';

/**
 * Resolve an inline dynamic string expression used as a resource NAME to a
 * prefix stub, so a dynamic Mongo collection keeps a meaningful named node:
 *   sprintf('quote_%s', $tipo)             → 'quote_{var}'
 *   sprintf('quote_%s', getTypes($x))      → 'quote_{var}'   (same node)
 *   'quote_' . $tipo                       → 'quote_{var}'
 * Returns null when no literal prefix + dynamic segment is recoverable (the
 * caller then falls back to the verbatim arg / the <DYNAMIC> placeholder).
 * Mirrors the SQL dynamic-table stub (`'res_quote_arch_' . $kind`).
 */
function phpDynamicCollectionStub(node: Parser.SyntaxNode): string | null {
    const v = unwrapPhpNode(node);
    if (v.type === 'function_call_expression' && phpFunctionName(v)?.toLowerCase() === 'sprintf') {
        const callArgs = phpCallArguments(v);
        const fmt = callArgs[0] ? phpLiteralValue(callArgs[0]) : undefined;
        if (fmt === undefined) return null;
        const out = fmt.replace(/%[0-9.\-+ ]*[a-zA-Z]/g, DYNAMIC_NAME_SEGMENT);
        return out !== fmt ? out : null;
    }
    if (v.type === 'binary_expression') {
        const dotIdx = v.children.findIndex(c => c.text === '.');
        if (dotIdx <= 0 || dotIdx >= v.children.length - 1) return null;
        const lit = phpLiteralValue(unwrapPhpNode(v.children[dotIdx - 1]));
        const rightIsDynamic = phpLiteralValue(unwrapPhpNode(v.children[dotIdx + 1])) === undefined;
        if (lit !== undefined && lit.length >= 2 && rightIsDynamic) return `${lit}${DYNAMIC_NAME_SEGMENT}`;
    }
    return null;
}

function shortPhpName(name: string): string {
    const withoutLeading = name.replace(/^\\+/, '');
    return withoutLeading.includes('\\')
        ? withoutLeading.slice(withoutLeading.lastIndexOf('\\') + 1)
        : withoutLeading;
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
