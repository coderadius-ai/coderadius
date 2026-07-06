/**
 * PHP static supplements — deterministic ClientBinding emission for
 * `coderadius.yaml`-declared `graphql-client` decorators.
 *
 * No customer-specific patterns live here. The matcher consults the shared
 * `graphql-client-registry`; whatever the customer declared in their YAML
 * (`name: "My\\NS\\Cls::method"`) is what gets matched. Adding new wrappers
 * does NOT require touching the engine.
 *
 * Match strategy (chunk-local, AST + scope-resolved, fail-closed on ambiguity):
 *
 *   1. Walk the chunk's portion of the AST looking for `member_call_expression`
 *      (`$x->method(...)`) and `scoped_call_expression` (`X::method(...)`)
 *      whose method name equals a registered decorator's method.
 *
 *   2. Resolve the receiver to a fully-qualified class name (FQCN) using the
 *      file's scope (`namespace` + `use` aliases) and per-class property type
 *      aliases. Supported receiver shapes:
 *        - `$this->prop->method(...)`     → property type lookup
 *        - `$param->method(...)`          → enclosing function parameter type
 *        - `(new X(...))->method(...)`    → inline class
 *        - `X::method(...)`               → static call
 *
 *   3. Match the resolved FQCN against the registry. The registry already
 *      handles bare-classname / FQCN-suffix / exact-FQCN equivalences.
 *
 * Known limitations (intentional fail-closed cases):
 *   - Inherited / trait properties: a property declared on a parent class
 *     or pulled in via a `use SomeTrait;` is NOT visible in this file's
 *     `class_declaration` walk. Matcher returns null for that chunk; Phase
 *     B / Phase C carry the floor.
 *   - Local variable assignments: `$x = new C(); $x->method();` resolves
 *     only via the inline `(new C())->method()` shape. We deliberately do
 *     NOT walk back through previous statements to recover the assignment
 *     — that's a value-resolution / data-flow concern, out of scope here.
 *   - Factory-returned receivers: `$x = $f->createClient(); $x->method();`
 *     fail-closes for the same reason.
 *
 * False negatives are acceptable — Phase B (gql operation index) and Phase C
 * (sanitizer body-shape rule) carry the floor when this matcher abstains.
 *
 * No regex matching against class names anywhere — the previous text-based
 * heuristic missed the same-namespace case (caller and wrapper share a PHP
 * namespace, no `use` statement needed). See same-namespace regression 2026-05-07.
 */
import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../../graph/types.js';
import type { ClientBinding, StaticSupplementalResult } from '../types.js';
import {
    extractPhpFileScope,
    resolveTypeHintToFqcn,
    type PhpFileScope,
} from './value-resolution.js';
import {
    canonicaliseClassRef,
    isRegisteredGraphQLClientClass,
    listGraphQLClientDecorators,
    matchGraphQLClientDecorator,
    type GraphQLClientDecorator,
} from '../../graphql-client-registry.js';
import {
    isRegisteredHttpClientClass,
    listHttpClientDecorators,
    matchHttpClientDecorator,
} from '../../http-client-registry.js';

/**
 * PSR-18 (HTTP Client) + PSR-17 (Request/Stream Factories) + PSR-7 (Message
 * interfaces) — the de-facto PHP HTTP standard. Recognising these AST-level
 * here gives the static-analyzer-task-builder a Gate 6 (Supplemental) signal
 * for any wrapper class that holds a `Psr\Http\Client\ClientInterface` and
 * calls `->sendRequest(...)` on it. Without this, the wrapper method that
 * actually issues the HTTP I/O fails all heuristic-filter gates (the type
 * symbol `ClientInterface` lives in vendor code, never seeds taint), and
 * the LLM ends up hallucinating endpoint paths from class/method names on
 * thin delegation adapters higher up the chain.
 *
 * PSR-18 is a public standard, not a customer-specific SDK. Hardcoding the
 * FQCN ↔ method pairs here is allowed; the memory rule "no AST hardcoding
 * for customer SDK wrappers" applies only to opaque proprietary wrappers
 * (those still must go through `coderadius.yaml` decorators).
 */
const PSR18_PATTERNS: ReadonlyArray<{ method: string; fqcn: string }> = [
    { method: 'sendRequest', fqcn: 'Psr\\Http\\Client\\ClientInterface' },
    { method: 'createRequest', fqcn: 'Psr\\Http\\Message\\RequestFactoryInterface' },
];

function matchPsr18Pattern(receiverFqcn: string, methodName: string): { method: string; fqcn: string } | null {
    const normalised = receiverFqcn.replace(/^\\+/, '');
    for (const p of PSR18_PATTERNS) {
        if (p.method !== methodName) continue;
        if (normalised === p.fqcn) return p;
    }
    return null;
}

export function extractPhpStaticSupplements(
    rootNode: Parser.SyntaxNode,
    source: string,
    filepath: string,
    chunk: CodeChunk,
): StaticSupplementalResult | null {
    const gqlDecorators = listGraphQLClientDecorators();
    const httpDecorators = listHttpClientDecorators();
    // PSR-18 patterns always run, regardless of coderadius.yaml decorators.

    if (!chunk.sourceCode) return null;

    // Wrapper-implementation suppression: when the chunk's enclosing class IS
    // a decorator-registered client wrapper, its method bodies are the inside
    // of the SDK boundary CodeRadius already models via the decorator. The
    // wrapper's own HTTP plumbing (PSR-18 sendRequest/createRequest on its
    // injected Psr\Http\* properties) must not emit ClientBindings on itself.
    const enclosingClass = chunk.parentClassName ? canonicaliseClassRef(chunk.parentClassName) : null;
    if (enclosingClass
        && (isRegisteredGraphQLClientClass(enclosingClass) || isRegisteredHttpClientClass(enclosingClass))) {
        return null;
    }

    const scope = extractPhpFileScope(rootNode);
    const propertyTypes = buildPropertyTypeMap(rootNode);

    const chunkNode = findChunkNode(rootNode, chunk);
    if (!chunkNode) return null;

    const seenTokens = new Set<string>();
    const bindings: ClientBinding[] = [];

    const visit = (node: Parser.SyntaxNode): void => {
        if (node.type === 'member_call_expression' || node.type === 'scoped_call_expression') {
            const methodName = (node.childForFieldName('name') ?? node.children.find(c => c.type === 'name'))?.text;
            if (methodName) {
                const gqlDec = gqlDecorators.find(d => d.methodName === methodName);
                if (gqlDec) {
                    const receiverFqcn = resolveCallReceiverFqcn(node, scope, propertyTypes);
                    if (receiverFqcn && matchGraphQLClientDecorator(receiverFqcn, methodName)) {
                        const token = receiverFqcn;
                        if (!seenTokens.has(token)) {
                            seenTokens.add(token);
                            bindings.push({
                                token,
                                clientKind: 'sdk',
                                protocol: 'graphql',
                                evidence: 'coderadius.yaml:graphql-client',
                                typeName: token,
                                baseUrlHint: inferBaseUrlHintFromConstructorSource(source, shortNameOf(token)),
                            });
                        }
                    }
                }

                const httpDec = httpDecorators.find(d => d.methodName === methodName);
                if (httpDec) {
                    const receiverFqcn = resolveCallReceiverFqcn(node, scope, propertyTypes);
                    if (receiverFqcn && matchHttpClientDecorator(receiverFqcn, methodName)) {
                        const token = receiverFqcn;
                        if (!seenTokens.has(token)) {
                            seenTokens.add(token);
                            bindings.push({
                                token,
                                clientKind: 'sdk',
                                protocol: 'http',
                                evidence: 'coderadius.yaml:http-client',
                                typeName: token,
                                baseUrlHint: inferBaseUrlHintFromConstructorSource(source, shortNameOf(token)),
                            });
                        }
                    }
                }

                // PSR-18 AST detection — deterministic, no decorator declaration needed.
                if (PSR18_PATTERNS.some(p => p.method === methodName)) {
                    const receiverFqcn = resolveCallReceiverFqcn(node, scope, propertyTypes);
                    if (receiverFqcn && matchPsr18Pattern(receiverFqcn, methodName)) {
                        const token = receiverFqcn.replace(/^\\+/, '');
                        if (!seenTokens.has(token)) {
                            seenTokens.add(token);
                            bindings.push({
                                token,
                                clientKind: 'http',
                                protocol: 'http',
                                evidence: 'psr18-ast',
                                typeName: token,
                            });
                        }
                    }
                }
            }
        }
        for (const child of node.children) visit(child);
    };
    visit(chunkNode);

    if (bindings.length === 0) return null;
    return { clientBindings: bindings };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the AST node whose source range matches the chunk. We compare on the
 * (row, column) of the start position because tree-sitter uses 0-based
 * positions while CodeChunk.startLine is 1-based, but column conventions
 * match. The chunk spans a single function/method declaration.
 */
function findChunkNode(rootNode: Parser.SyntaxNode, chunk: CodeChunk): Parser.SyntaxNode | null {
    const targetRow = chunk.startLine - 1;
    const targetCol = chunk.startColumn - 1;
    let result: Parser.SyntaxNode | null = null;

    const visit = (node: Parser.SyntaxNode): boolean => {
        if (node.type === 'method_declaration' || node.type === 'function_definition') {
            if (node.startPosition.row === targetRow && node.startPosition.column === targetCol) {
                result = node;
                return true;
            }
        }
        for (const child of node.children) {
            if (visit(child)) return true;
        }
        return false;
    };
    visit(rootNode);
    return result;
}

/**
 * Walk the AST collecting `propertyName → typeHint` for every class property
 * declaration and constructor-promoted property in the file. We extract the
 * raw type-hint text (preserving FQCN-ness like `\Foo\Bar\X`) so that the
 * downstream `resolveTypeHintToFqcn` call can decide between alias-resolution,
 * namespace-prefix, or already-FQCN cases.
 *
 * NOTE: `extractPhpClassPropertyAliases` in `imports.ts` is intentionally
 * lossy — it normalises types to bare class names for entity-extraction
 * purposes. We can't reuse it here without losing leading-backslash FQCN
 * information.
 */
function buildPropertyTypeMap(rootNode: Parser.SyntaxNode): Map<string, string> {
    const map = new Map<string, string>();

    const visitClass = (classNode: Parser.SyntaxNode): void => {
        const body = classNode.childForFieldName('body')
            ?? classNode.children.find(c => c.type === 'declaration_list' || c.type === 'class_body');
        if (!body) return;

        for (const member of body.children) {
            if (member.type === 'property_declaration') {
                const typeNode = member.children.find(c => c.type === 'named_type' || c.type === 'type_name' || c.type === 'primitive_type');
                const propEl = member.children.find(c => c.type === 'property_element');
                const varNode = propEl?.childForFieldName('name') ?? propEl?.children.find(c => c.type === 'variable_name');
                if (typeNode && varNode) {
                    const propName = varNode.text.replace(/^\$/, '');
                    map.set(propName, typeNode.text);
                }
            }
            if (member.type === 'method_declaration' && member.childForFieldName('name')?.text === '__construct') {
                const params = member.childForFieldName('parameters');
                if (!params) continue;
                for (const param of params.children) {
                    if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter') continue;
                    const hasVisibility = param.children.some(c => c.type === 'visibility_modifier');
                    if (!hasVisibility) continue;
                    const typeNode = param.children.find(c => c.type === 'named_type' || c.type === 'type_name' || c.type === 'primitive_type');
                    const varNode = param.children.find(c => c.type === 'variable_name');
                    if (typeNode && varNode) {
                        const propName = varNode.text.replace(/^\$/, '');
                        map.set(propName, typeNode.text);
                    }
                }
            }
        }
    };

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration') {
            visitClass(node);
        }
        for (const child of node.children) walk(child);
    };
    walk(rootNode);
    return map;
}

/**
 * Resolve the receiver of a call expression to its FQCN.
 * Returns null when the receiver type cannot be statically determined.
 */
function resolveCallReceiverFqcn(
    callNode: Parser.SyntaxNode,
    scope: PhpFileScope,
    propertyTypes: Map<string, string>,
): string | null {
    if (callNode.type === 'scoped_call_expression') {
        // `X::method(...)` — the scope is the class name.
        const scopeNode = callNode.childForFieldName('scope') ?? callNode.children[0];
        if (!scopeNode) return null;
        return resolveTypeHintToFqcn(scopeNode.text, scope);
    }

    if (callNode.type !== 'member_call_expression') return null;

    const objectNode = callNode.childForFieldName('object') ?? callNode.children[0];
    if (!objectNode) return null;
    return resolveObjectExpression(objectNode, callNode, scope, propertyTypes);
}

function resolveObjectExpression(
    objectNode: Parser.SyntaxNode,
    callNode: Parser.SyntaxNode,
    scope: PhpFileScope,
    propertyTypes: Map<string, string>,
): string | null {
    // Unwrap `(expr)` parentheses.
    if (objectNode.type === 'parenthesized_expression') {
        const inner = objectNode.children.find(c => c.type !== '(' && c.type !== ')');
        return inner ? resolveObjectExpression(inner, callNode, scope, propertyTypes) : null;
    }

    // `new X(...)` — inline construction.
    if (objectNode.type === 'object_creation_expression') {
        const className = (objectNode.childForFieldName('name')
            ?? objectNode.children.find(c => c.type === 'qualified_name' || c.type === 'name'))?.text;
        return className ? resolveTypeHintToFqcn(className, scope) : null;
    }

    // `$this->prop` — member access, look up property type.
    if (objectNode.type === 'member_access_expression') {
        const obj = objectNode.childForFieldName('object') ?? objectNode.children[0];
        const name = objectNode.childForFieldName('name') ?? objectNode.children.find(c => c.type === 'name');
        if (obj?.text === '$this' && name?.text) {
            const typeHint = propertyTypes.get(name.text);
            if (typeHint) return resolveTypeHintToFqcn(typeHint, scope);
        }
        return null;
    }

    // `$var` — variable, look up parameter type in enclosing function.
    if (objectNode.type === 'variable_name') {
        const varName = objectNode.text.replace(/^\$/, '');
        const paramType = lookupParameterType(callNode, varName);
        return paramType ? resolveTypeHintToFqcn(paramType, scope) : null;
    }

    return null;
}

/**
 * Walk up from a call node to its enclosing function/method declaration and
 * return the declared type-hint of the named parameter, if any.
 */
function lookupParameterType(callNode: Parser.SyntaxNode, varName: string): string | null {
    let cursor: Parser.SyntaxNode | null = callNode.parent;
    while (cursor) {
        if (cursor.type === 'method_declaration' || cursor.type === 'function_definition') {
            const params = cursor.childForFieldName('parameters');
            if (!params) return null;
            for (const param of params.children) {
                if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter') continue;
                const nameNode = param.children.find(c => c.type === 'variable_name');
                if (!nameNode) continue;
                if (nameNode.text.replace(/^\$/, '') !== varName) continue;
                const typeNode = param.children.find(c => c.type === 'named_type' || c.type === 'type_name' || c.type === 'primitive_type');
                return typeNode?.text ?? null;
            }
            return null;
        }
        cursor = cursor.parent;
    }
    return null;
}

function shortNameOf(fqcn: string): string {
    const idx = fqcn.lastIndexOf('\\');
    return idx >= 0 ? fqcn.slice(idx + 1) : fqcn;
}

/**
 * Heuristic: if the file's constructor / property declarations bind the
 * matched class to an env-keyed base URL (e.g. via #[Autowire] or a string
 * literal next to the type hint), surface that hint. Best-effort only — a
 * miss is fine.
 */
function inferBaseUrlHintFromConstructorSource(fileSource: string, shortName: string): string | undefined {
    const ENV_RE = /(?:getenv|env|getEnv)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g;
    const idx = fileSource.indexOf(shortName);
    if (idx < 0) return undefined;
    const window = fileSource.slice(Math.max(0, idx - 400), Math.min(fileSource.length, idx + 800));
    const m = ENV_RE.exec(window);
    return m ? m[1] : undefined;
}

// `GraphQLClientDecorator` is intentionally re-exported via type-only import
// to keep the public surface aligned with the registry's exported shape.
export type { GraphQLClientDecorator };
