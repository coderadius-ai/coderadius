// ═══════════════════════════════════════════════════════════════════════════════
// PHP chainedMethod enricher
//
// Plan v10 §C. Two AST patterns populate `CriticalInvocationFact.chainedMethod`
// on already-emitted `serviceId` invocations. Without this enrichment the
// DiIoPropagator's `resolveDi(key, file, method)` returns null and the DI
// bypass never engages.
//
//   Pattern A (local-var taint):
//     $svc = $container->get('id');
//     $svc->publish(...)
//
//   Pattern B (property-fetch from constructor injection):
//     $this->publisher->publish(...)
//       where `$publisher` is a ctor parameter typed `PublisherInterface`.
//
// Operation names are lowercased (PHP is case-insensitive on method calls).
// The enricher works in two passes:
//
//   1. Walk the AST collecting:
//        - per method body, a `localAliases: Map<varName, serviceId>` built
//          from `$var = $container->get('id')` assignments.
//        - per class, a property→requiredType map built from constructor
//          parameters (Pattern B).
//   2. For each `member_call_expression` whose object is either a property
//      access `$this->prop` or a local variable `$var`, look up the alias
//      and stamp `chainedMethod` on the matching `serviceId` fact emitted
//      earlier.
// ═══════════════════════════════════════════════════════════════════════════════

import type Parser from 'tree-sitter';
import type { CriticalInvocationFact } from '../../value-resolution/types.js';
import { extractPhpFileScope, resolveTypeHintToFqcn, type PhpFileScope } from './value-resolution.js';

const CONTAINER_GET_NAMES = new Set(['get', 'resolve', 'make']);

interface FactKey {
    startLine: number;
    resourceExpression: string;
}

/**
 * Mutates `invocations` IN PLACE: stamps `chainedMethod` on existing
 * `serviceId` facts (Pattern A) AND appends new `serviceId` facts for
 * property-fetch ctor-injection patterns the upstream extractor misses
 * (Pattern B). The latter requires a write path because the value-
 * resolution extractor does not emit a fact for plain `$this->prop->method()`.
 */
export function enrichPhpChainedMethods(
    rootNode: Parser.SyntaxNode,
    invocations: CriticalInvocationFact[],
    filepath?: string,
): void {
    // Index existing invocations by (startLine, resourceExpression) for
    // O(1) Pattern-A lookup when resolving a chained call to its serviceId fact.
    const factIndex = new Map<string, CriticalInvocationFact>();
    for (const inv of invocations) {
        if (inv.resourceRole !== 'serviceId') continue;
        if (inv.chainedMethod) continue;  // don't overwrite
        const key = factKey({ startLine: inv.startLine, resourceExpression: inv.resourceExpression });
        factIndex.set(key, inv);
    }

    // File-level scope for FQCN normalization (Pattern C).
    const fileScope = extractPhpFileScope(rootNode);

    // Walk for Pattern A (stamp existing facts), Pattern B (emit new facts),
    // and Pattern C (normalize chained `->get(X::class)->method()`).
    walk(rootNode, factIndex, /* classCtorProps */ null, invocations, filepath, fileScope);
}

function walk(
    node: Parser.SyntaxNode,
    factIndex: Map<string, CriticalInvocationFact>,
    classCtorProps: Map<string, string> | null,
    invocations: CriticalInvocationFact[],
    filepath: string | undefined,
    fileScope: PhpFileScope,
): void {
    if (node.type === 'class_declaration') {
        const ctorProps = buildClassCtorProps(node, fileScope);
        for (const child of node.children) {
            walk(child, factIndex, ctorProps, invocations, filepath, fileScope);
        }
        return;
    }

    if (node.type === 'method_declaration' || node.type === 'function_definition') {
        const localAliases = buildLocalAliases(node);
        enrichInFunction(node, factIndex, classCtorProps, localAliases, invocations, filepath, fileScope);
        enrichContainerGetChain(node, invocations, fileScope);
        for (const child of node.children) {
            walk(child, factIndex, classCtorProps, invocations, filepath, fileScope);
        }
        return;
    }

    for (const child of node.children) {
        walk(child, factIndex, classCtorProps, invocations, filepath, fileScope);
    }
}

/**
 * Pattern C: `$container->get(\Acme\Foo::class)->doWork()` (or any
 * chained `->get(Class::class)->method()`). The PHP value-resolution
 * extractor emits a serviceId fact for the inner `->get(X::class)` call
 * with `resourceExpression='X.class'` (bare class name + `.class` suffix,
 * see canonicalizePhpReference in value-resolution.ts). Without
 * normalization the registry lookup misses (registry keys are
 * fully-qualified). Pattern C scans for these chains, finds the matching
 * serviceId fact at the inner call's line, and:
 *   1. Rewrites `resourceExpression` to the FQCN resolved via use imports.
 *   2. Stamps `chainedMethod` with the outer method name (lowercased).
 *
 * This unlocks the DI bypass for the dominant acme-monolith pattern:
 *     getGlobal()->getContainer()->get(CitiesRepository::class)->getInfoComune(...)
 */
function enrichContainerGetChain(
    funcNode: Parser.SyntaxNode,
    invocations: CriticalInvocationFact[],
    fileScope: PhpFileScope,
): void {
    const visit = (node: Parser.SyntaxNode): void => {
        if (node.type === 'member_call_expression') {
            const outerMethod = methodNameOf(node);
            if (outerMethod) {
                const object = node.children[0];
                if (object && object.type === 'member_call_expression') {
                    const innerMethod = methodNameOf(object);
                    if (innerMethod && CONTAINER_GET_NAMES.has(innerMethod.toLowerCase())) {
                        const classArg = extractClassConstArg(object);
                        if (classArg) {
                            const fqcn = (resolveTypeHintToFqcn(classArg, fileScope) ?? classArg)
                                .replace(/^\\+/, '');
                            const innerCallLine = object.startPosition.row + 1;
                            // Find serviceId fact at the inner call's line and
                            // normalize resourceExpression + stamp chainedMethod.
                            let stampedFact: CriticalInvocationFact | null = null;
                            for (const inv of invocations) {
                                if (inv.startLine !== innerCallLine) continue;
                                if (inv.resourceRole !== 'serviceId') continue;
                                if (inv.chainedMethod) continue;
                                inv.chainedMethod = outerMethod.toLowerCase();
                                // Strip outer JSON-stringify quotes if present
                                // (canonicalizePhpReference may JSON.stringify
                                // simple string literals; we want bare FQCN
                                // for the registry match).
                                inv.resourceExpression = fqcn;
                                stampedFact = inv;
                                break;
                            }
                            // Dedup sibling serviceId facts at the same line:
                            // the upstream extractor emits one fact for each
                            // member_call_expression in the chain, so a
                            // `$c->get(X::class)->publish(...)` produces both
                            // a `publish`-handler fact (resourceExpression=
                            // 'X.class') and a `get`-handler fact (likewise).
                            // After Pattern C rewrites ONE into the FQCN form,
                            // the remaining sibling fact (still 'X.class')
                            // is informationally a duplicate and would
                            // otherwise block the DI bypass invariant
                            // (serviceId without diBinding+ioTags → null).
                            if (stampedFact) {
                                for (let i = invocations.length - 1; i >= 0; i--) {
                                    const sibling = invocations[i];
                                    if (sibling === stampedFact) continue;
                                    if (sibling.startLine !== innerCallLine) continue;
                                    if (sibling.resourceRole !== 'serviceId') continue;
                                    if (sibling.chainedMethod) continue;
                                    if (!isSameClassRef(sibling.resourceExpression, classArg, fqcn)) continue;
                                    invocations.splice(i, 1);
                                }
                            }
                        }
                    }
                }
            }
        }
        for (const child of node.children) visit(child);
    };
    visit(funcNode);
}

/**
 * True when `expr` references the same class as either the bare-name
 * `classArg` (e.g. `NotificationPublisher.class`) or the resolved `fqcn`
 * (e.g. `Acme\Inventory\Notification\NotificationPublisher`).
 *
 * Strips JSON quotes, `.class` suffix, and leading backslashes so callers
 * can compare canonicalised forms.
 */
function isSameClassRef(expr: string, classArg: string, fqcn: string): boolean {
    const norm = (s: string): string =>
        s.replace(/^['"`]|['"`]$/g, '')
            .replace(/\.class$/, '')
            .replace(/^\\+/, '');
    const a = norm(expr);
    return a === norm(classArg) || a === norm(fqcn);
}

/**
 * Extract the bare class name from `->get(\Acme\Foo::class)` arguments.
 * Returns null when the argument isn't a `Class::class` form.
 */
function extractClassConstArg(callNode: Parser.SyntaxNode): string | null {
    const args = callNode.children.find(c => c.type === 'arguments');
    if (!args) return null;
    const firstArg = args.children.find(c => c.type === 'argument');
    if (!firstArg) return null;
    const inner = firstArg.children[0];
    if (!inner || inner.type !== 'class_constant_access_expression') return null;
    const constName = [...inner.children].reverse().find(c => c.type === 'name');
    if (!constName || constName.text !== 'class') return null;
    const scope = inner.children.find(c =>
        c.type === 'name' || c.type === 'qualified_name',
    );
    return scope ? scope.text.replace(/^\\+/, '') : null;
}

/**
 * Build prop→requiredType from a class's __construct parameters. Property
 * Pattern B uses this to identify which `$this->prop` references are
 * DI-injected and what their requiredType (= service key) is.
 *
 * Returns null when the class has no constructor.
 */
function buildClassCtorProps(classNode: Parser.SyntaxNode, fileScope: PhpFileScope): Map<string, string> | null {
    const body = classNode.children.find(c => c.type === 'declaration_list');
    if (!body) return null;
    const ctor = body.children.find(c =>
        c.type === 'method_declaration' && nameOf(c)?.toLowerCase() === '__construct',
    );
    if (!ctor) return null;

    const formal = ctor.children.find(c => c.type === 'formal_parameters');
    if (!formal) return null;

    const out = new Map<string, string>();
    for (const param of formal.children) {
        if (
            param.type !== 'simple_parameter'
            && param.type !== 'property_promotion_parameter'
        ) continue;

        // Type comes first
        const typeNode = param.children.find(c =>
            c.type === 'name' || c.type === 'qualified_name' || c.type === 'named_type'
            || c.type === 'union_type' || c.type === 'intersection_type' || c.type === 'nullable_type',
        );
        if (!typeNode) continue;
        const typeText = firstTypeName(typeNode);
        if (!typeText) continue;

        const varNode = param.children.find(c => c.type === 'variable_name');
        if (!varNode) continue;
        const propName = varNode.text.replace(/^\$/, '').trim();
        if (!propName) continue;

        // Resolve bare type names to FQCN via use-aliases + namespace so the
        // DI registry lookup (keyed by FQCN) matches what Pattern B emits.
        // Falls back to the bare text when no resolution rule applies.
        const resolved = resolveTypeHintToFqcn(typeText, fileScope) ?? typeText;
        out.set(propName, resolved.replace(/^\\+/, ''));
    }
    return out.size > 0 ? out : null;
}

/**
 * Per-function local alias scan. Find `$var = $container->get('id')` (or any
 * single-arg method named like a DI accessor) and record `var → 'id'`.
 */
function buildLocalAliases(funcNode: Parser.SyntaxNode): Map<string, string> {
    const aliases = new Map<string, string>();
    const visit = (node: Parser.SyntaxNode): void => {
        if (node.type === 'assignment_expression') {
            const lhs = node.children[0];
            const rhs = node.children[node.children.length - 1];
            if (lhs && lhs.type === 'variable_name' && rhs && rhs.type === 'member_call_expression') {
                const calleeName = methodNameOf(rhs);
                if (calleeName && CONTAINER_GET_NAMES.has(calleeName.toLowerCase())) {
                    // Accept both string args (`'acme.foo'`) and class
                    // constants (`Foo::class`). The latter is canonicalised
                    // to `Foo.class` upstream — keep the canonical form so
                    // the alias key matches the stored fact verbatim.
                    const arg = firstStringArg(rhs) ?? firstClassConstantArg(rhs);
                    if (arg) {
                        const varName = lhs.text.replace(/^\$/, '');
                        aliases.set(varName, arg);
                    }
                }
            }
        }
        for (const child of node.children) visit(child);
    };
    visit(funcNode);
    return aliases;
}

/**
 * Extract the bare class name from `->get(\Acme\Foo::class)` arguments and
 * return it in the canonicalised form `Foo.class` (matching the upstream
 * value-resolution canonicaliser). Returns null when the argument isn't a
 * `Class::class` form.
 */
function firstClassConstantArg(callNode: Parser.SyntaxNode): string | null {
    const arg = extractClassConstArg(callNode);
    if (!arg) return null;
    const bareName = arg.split('\\').pop()!;
    return `${bareName}.class`;
}

/**
 * For every member_call inside the function body, stamp chainedMethod on
 * the matching serviceId fact when the receiver is either:
 *   - `$this->prop` and `prop` is in `classCtorProps`
 *   - `$var` and `var` is in `localAliases`
 *
 * The fact lookup uses the serviceId resourceExpression as it appears in
 * the original invocation (the value-resolution extractor stores the
 * literal text passed to container->get(), e.g. `'message_bus.sender'`).
 */
function enrichInFunction(
    funcNode: Parser.SyntaxNode,
    factIndex: Map<string, CriticalInvocationFact>,
    classCtorProps: Map<string, string> | null,
    localAliases: Map<string, string>,
    invocations: CriticalInvocationFact[],
    filepath: string | undefined,
    fileScope: PhpFileScope,
): void {
    const visit = (node: Parser.SyntaxNode): void => {
        if (node.type === 'member_call_expression') {
            const resolution = resolveReceiverServiceId(node, classCtorProps, localAliases);
            const methodName = methodNameOf(node);
            if (resolution && methodName) {
                const methodLower = methodName.toLowerCase();
                const callLine = node.startPosition.row + 1;

                // 1. Try to stamp via the factIndex (Pattern A: serviceId
                //    fact lives a few lines above on the $container->get
                //    call site).
                let stamped = stampChainedMethod(
                    factIndex,
                    node,
                    resolution.serviceId,
                    methodLower,
                    resolution.kind === 'local-var' ? fileScope : null,
                );

                // After Pattern A stamps the upstream serviceId fact at the
                // get-call line, any sibling fact emitted by the publish/
                // dispatch handler for the SAME call site (`$var->publish(
                // $msg)`) is informationally a duplicate — it carries a
                // `message` resource role with `$msg` as the unresolved
                // expression, which would otherwise trip the
                // "unresolved MessageChannel" fail-closed guard in the
                // static-bypass builder. Drop those siblings.
                if (stamped && resolution.kind === 'local-var') {
                    for (let i = invocations.length - 1; i >= 0; i--) {
                        const sibling = invocations[i];
                        if (sibling.startLine !== callLine) continue;
                        if (sibling.resourceType !== 'MessageChannel') continue;
                        if (sibling.resourceRole !== 'message' && sibling.resourceRole !== 'messageClass') continue;
                        invocations.splice(i, 1);
                    }
                }

                // 2. If not stamped AND a serviceId fact AT THIS LINE whose
                //    `resourceExpression` matches the resolved serviceId
                //    exists, stamp it (Pattern B: the PHP plugin's
                //    `buildClassDiBindings` already emitted a serviceId
                //    fact for `$this->prop->method()` with the FQCN
                //    qualified, just without chainedMethod). Enriching
                //    avoids emitting a duplicate fact.
                //
                //    The match guard is critical: when the call site is
                //    `$this->container->get(X::class)->publish(...)`, the
                //    inner `->get()` is itself a serviceId emission for a
                //    *different* binding (the X FQCN). Without the match
                //    guard, the inner `get` enricher visit would stamp
                //    chainedMethod='get' onto the outer publish fact and
                //    break the DI bypass (the registry has no
                //    `X.class → ioTags(get)` mapping).
                if (!stamped) {
                    const existing = invocations.find(inv =>
                        inv.startLine === callLine
                        && inv.resourceRole === 'serviceId'
                        && !inv.chainedMethod
                        && resourceExpressionMatchesServiceId(inv.resourceExpression, resolution.serviceId),
                    );
                    if (existing) {
                        existing.chainedMethod = methodLower;
                        stamped = true;
                    }
                }

                // 3. Pattern B previously emitted a NEW serviceId fact for
                //    bare `$this->prop->method()` sites the upstream PHP
                //    plugin's `buildClassDiBindings` didn't recognise. That
                //    emission turned out to be a strict recall regression in
                //    real codebases: only ~10% of bound components have
                //    extractable ioTags, so the emitted serviceId facts
                //    promoted the consumer through Gate 5 (DI) without ever
                //    producing a bypass, inflating LLM SEND by ~30% on the
                //    acme-monolith fixture (439 vs 341 baseline).
                //
                //    The Pattern B coverage now lives in step 2 above: when
                //    the publish handler / DI binding fallback in
                //    `value-resolution.ts` has already emitted a serviceId
                //    fact (the common case when the property is bound via
                //    `#[Autowire]` or recognised type-hint), step 2 stamps
                //    chainedMethod on it. Pure ctor-injection without
                //    DI registration falls back to LLM — the correct
                //    behaviour given that the DI registry has no
                //    actionable resolution for those keys anyway.
                void node; void resolution; void methodLower; void callLine; void filepath;
            }
        }
        for (const child of node.children) visit(child);
    };
    visit(funcNode);
}

type ReceiverResolution = {
    serviceId: string;
    kind: 'property-fetch' | 'local-var';
};

function resolveReceiverServiceId(
    callNode: Parser.SyntaxNode,
    classCtorProps: Map<string, string> | null,
    localAliases: Map<string, string>,
): ReceiverResolution | null {
    const object = callNode.children[0];
    if (!object) return null;

    // Pattern B: $this->prop->method() — object is member_access_expression
    if (object.type === 'member_access_expression') {
        const accessReceiver = object.children[0];
        // PHP AST: property name is `name` (NOT variable_name — `variable_name`
        // would be the `$this` receiver). The bug we fixed: `.find` was
        // returning the receiver `$this` itself.
        const accessName = object.children.find(c => c.type === 'name');
        if (
            accessReceiver
            && accessReceiver.type === 'variable_name'
            && accessReceiver.text === '$this'
            && accessName
            && classCtorProps
        ) {
            const propName = accessName.text.replace(/^\$/, '');
            const requiredType = classCtorProps.get(propName);
            if (requiredType) return { serviceId: requiredType, kind: 'property-fetch' };
        }
    }

    // Pattern A: $var->method() — object is variable_name
    if (object.type === 'variable_name') {
        const varName = object.text.replace(/^\$/, '');
        const aliased = localAliases.get(varName);
        if (aliased) return { serviceId: aliased, kind: 'local-var' };
    }

    return null;
}

/**
 * Try to stamp `chainedMethod` on an EXISTING serviceId fact. Returns true
 * if a fact was stamped, false otherwise (allows the caller to decide
 * whether to emit a new fact for Pattern B).
 */
function stampChainedMethod(
    factIndex: Map<string, CriticalInvocationFact>,
    callNode: Parser.SyntaxNode,
    serviceId: string,
    methodName: string,
    /** When set, rewrite a matched fact's `resourceExpression` from
     *  `<BareName>.class` to its fully-qualified form so the DI registry
     *  lookup (keyed by FQCN) succeeds. Only Pattern A passes a scope. */
    fqcnRewriteScope: PhpFileScope | null,
): boolean {
    // The serviceId fact was emitted at the position of the inner
    // `$container->get(...)` call (Pattern A) or at the property fetch
    // location (Pattern B). For Pattern B the serviceId is the requiredType
    // FQCN; the value-resolution extractor doesn't emit a fact for plain
    // property access. In that case we attach chainedMethod via the
    // member_call_expression's own line.
    const callStart = callNode.startPosition.row + 1;

    // Try multiple keys:
    //   - (callLine, serviceId) — common case
    //   - (anyLine where startLine <= callLine, serviceId) — local-var alias
    //     where the serviceId fact lives a few lines above
    const direct = factIndex.get(factKey({ startLine: callStart, resourceExpression: quoteLiteral(serviceId) }));
    if (direct) {
        if (!direct.chainedMethod) direct.chainedMethod = methodName;
        maybeRewriteToFqcn(direct, fqcnRewriteScope);
        return true;
    }

    // Scan up to 30 lines back for a serviceId fact matching this id
    for (const [, fact] of factIndex) {
        if (fact.startLine > callStart) continue;
        if (callStart - fact.startLine > 30) continue;
        if (fact.chainedMethod) continue;
        // Strip optional quotes from the stored expression
        const storedId = fact.resourceExpression.replace(/^['"`]|['"`]$/g, '');
        if (storedId === serviceId) {
            fact.chainedMethod = methodName;
            maybeRewriteToFqcn(fact, fqcnRewriteScope);
            return true;
        }
    }
    return false;
}

/**
 * When a Pattern A local-var alias was sourced from `Class::class`, the
 * matched fact's `resourceExpression` is the bare `BareName.class` form.
 * Rewrite it to the FQCN so that the DI registry lookup (keyed by FQCN)
 * matches. No-op when the expression is already FQCN-like or when no
 * scope is provided.
 */
function maybeRewriteToFqcn(fact: CriticalInvocationFact, scope: PhpFileScope | null): void {
    if (!scope) return;
    if (!/\.class$/.test(fact.resourceExpression)) return;
    const bareName = fact.resourceExpression.replace(/\.class$/, '').replace(/^\\+/, '');
    if (!bareName) return;
    const fqcn = resolveTypeHintToFqcn(bareName, scope);
    if (!fqcn) return;
    fact.resourceExpression = fqcn.replace(/^\\+/, '');
}

// ─── AST helpers ────────────────────────────────────────────────────────────

function nameOf(node: Parser.SyntaxNode): string | null {
    const name = node.children.find(c => c.type === 'name');
    return name ? name.text.trim() : null;
}

function methodNameOf(callNode: Parser.SyntaxNode): string | null {
    // member_call_expression children layout (varies by tree-sitter-php
    // version): [receiver, '->', methodName, args]. We look for the first
    // `name` child that follows the `->` arrow.
    let sawArrow = false;
    for (const child of callNode.children) {
        if (child.text === '->') { sawArrow = true; continue; }
        if (sawArrow && child.type === 'name') return child.text.trim();
    }
    return null;
}

function firstStringArg(callNode: Parser.SyntaxNode): string | null {
    const args = callNode.children.find(c => c.type === 'arguments');
    if (!args) return null;
    const firstArg = args.children.find(c => c.type === 'argument');
    if (!firstArg) return null;
    const exp = firstArg.children[0];
    if (!exp) return null;
    if (exp.type === 'string') {
        // tree-sitter-php string node contains string_value child
        const inner = exp.children.find(c => c.type === 'string_value' || c.type === 'string_content');
        return inner ? inner.text : exp.text.replace(/^['"`]|['"`]$/g, '');
    }
    if (exp.type === 'encapsed_string') {
        return exp.text.replace(/^['"`]|['"`]$/g, '');
    }
    return null;
}

function firstTypeName(typeNode: Parser.SyntaxNode): string | null {
    if (typeNode.type === 'name' || typeNode.type === 'qualified_name' || typeNode.type === 'named_type') {
        return typeNode.text.trim();
    }
    if (typeNode.type === 'union_type' || typeNode.type === 'intersection_type' || typeNode.type === 'nullable_type') {
        for (const child of typeNode.children) {
            const out = firstTypeName(child);
            if (out) return out;
        }
    }
    return null;
}

function factKey(k: FactKey): string {
    return `${k.startLine}\0${k.resourceExpression}`;
}

function quoteLiteral(s: string): string {
    return `'${s}'`;
}

/**
 * Conservative match between a CriticalInvocationFact.resourceExpression
 * and a serviceId resolved from Pattern A/B receiver analysis.
 *
 * The expression in a stored fact may carry:
 *   - surrounding quotes (JSON-stringified DI keys / FQCNs);
 *   - a leading backslash (FQCN-as-class-constant);
 *   - the `.class` suffix that `canonicalizePhpReference` appends.
 *
 * The serviceId from the receiver may be a bare type name (`UseCaseInterface`)
 * OR an FQCN (`Acme\UseCaseInterface`). Match either direction by accepting
 * `endsWith('\BareName')` when one side is namespaced and the other isn't.
 */
function resourceExpressionMatchesServiceId(expr: string, serviceId: string): boolean {
    const norm = (s: string): string => {
        const stripped = s.replace(/^['"`]|['"`]$/g, '');
        // The value-resolution extractor JSON.stringifies serviceId values
        // before storing them; that doubles every backslash. Collapse
        // multiple backslashes down to single so PHP namespace separators
        // compare faithfully (Acme\\Foo == Acme\Foo).
        return stripped
            .replace(/\\+/g, '\\')
            .replace(/\.class$/, '')
            .replace(/^\\/, '');
    };
    const a = norm(expr);
    const b = norm(serviceId);
    if (a === b) return true;
    if (a.endsWith('\\' + b)) return true;
    if (b.endsWith('\\' + a)) return true;
    return false;
}
