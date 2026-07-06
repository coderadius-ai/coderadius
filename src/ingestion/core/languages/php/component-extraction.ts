// ═══════════════════════════════════════════════════════════════════════════════
// PHP Component & Dependency Extractor
//
// Powers `LanguagePlugin.extractComponentDefinitions` and
// `LanguagePlugin.extractDependencyRequirements` for the DI binding registry
// Lives in the PHP language plugin so the core stays
// language-agnostic; the resolver consumes `ComponentDefinition` and
// `DependencyRequirement` shapes without knowing they came from PHP.
//
// Coverage:
//   - Classes (`class_declaration`), interfaces (`interface_declaration`),
//     traits (`trait_declaration`). All flatten to `ComponentDefinition`.
//   - Operations: `method_declaration`. Names are lowercased (PHP is
//     case-insensitive on method calls; lowercase prevents silent recall
//     loss when source uses `$obj->PUBLISH()`).
//   - `declaredInterfaces`: from `class_interface_clause` (PHP `implements`)
//     and `base_clause` (PHP `extends` for interfaces).
//   - Dependency requirements: constructor (`__construct`) parameters with
//     a declared type. `isAbstractType` is conservative `true` unless we can
//     prove the type is a known concrete (heuristic: ends with `Interface`,
//     `Contract`, `Abstract*`, or PHP-builtin types are concrete).
// ═══════════════════════════════════════════════════════════════════════════════

import type Parser from 'tree-sitter';
import type { ComponentDefinition, DependencyRequirement } from '../types.js';
import { extractPhpFileScope, resolveTypeHintToFqcn, type PhpFileScope } from './value-resolution.js';

const PHP_PRIMITIVE_TYPES = new Set([
    'string', 'int', 'integer', 'float', 'bool', 'boolean', 'array', 'object',
    'void', 'null', 'mixed', 'iterable', 'callable', 'self', 'static',
    'parent', 'never', 'true', 'false',
]);

/**
 * Extract every component (class/interface/trait) declared in the file.
 *
 * Each entry carries:
 *   - fqcn: <namespace>\<ClassName> (or just <ClassName> in the global ns)
 *   - file: passed through from the caller
 *   - operations: method_declaration nodes inside the body. Names lowercased.
 *   - declaredInterfaces: implements + extends (interfaces).
 */
export function extractPhpComponentDefinitions(
    rootNode: Parser.SyntaxNode,
    filepath: string,
): ComponentDefinition[] {
    const out: ComponentDefinition[] = [];

    const scope = extractPhpFileScope(rootNode);
    const ns = scope.namespace || null;

    const walk = (node: Parser.SyntaxNode): void => {
        if (
            node.type === 'class_declaration'
            || node.type === 'interface_declaration'
            || node.type === 'trait_declaration'
        ) {
            const def = buildDefinition(node, ns, filepath, scope);
            if (def) out.push(def);
        } else {
            for (const child of node.children) walk(child);
        }
    };
    walk(rootNode);

    return out;
}

/**
 * Extract dependency requirements from constructor injection.
 *
 * One entry per typed constructor parameter on each component in the file:
 *   `__construct(LoggerInterface $logger, ConnectionPool $pool)` →
 *     [{ ownerComponent, parameterName: 'logger', requiredType: 'LoggerInterface', isAbstractType: true },
 *      { ownerComponent, parameterName: 'pool',   requiredType: 'ConnectionPool',  isAbstractType: false }]
 *
 * Type resolution:
 *   - Bare type names without a namespace prefix get qualified to the file's
 *     namespace (`<namespace>\<TypeName>`), mirroring PHP's lexical scope.
 *   - PHP primitives (string, int, ...) are skipped — not injectable.
 *
 * `isAbstractType` heuristic (kept conservative to maximize Phase-4 lookups):
 *   - PHP primitive → false
 *   - Name ends with `Interface`, `Contract`, or starts with `Abstract` → true
 *   - Else → false (concrete class)
 *
 * The DiBindingResolver Phase 4 will additionally check that exactly one
 * implementer of an `isAbstractType=true` requirement exists before promoting
 * the binding (ambiguity guard).
 */
export function extractPhpDependencyRequirements(
    rootNode: Parser.SyntaxNode,
    _filepath: string,
): DependencyRequirement[] {
    const out: DependencyRequirement[] = [];
    const scope = extractPhpFileScope(rootNode);
    const ns = scope.namespace || null;

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration' || node.type === 'trait_declaration') {
            const className = nameOf(node);
            if (className) {
                const ownerComponent = ns ? `${ns}\\${className}` : className;
                const body = findChild(node, 'declaration_list');
                if (body) {
                    const constructor = findConstructor(body);
                    if (constructor) {
                        collectParameters(constructor, ownerComponent, scope, out);
                    }
                }
            }
        }
        for (const child of node.children) walk(child);
    };
    walk(rootNode);

    return out;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function buildDefinition(
    node: Parser.SyntaxNode,
    namespace: string | null,
    filepath: string,
    scope: PhpFileScope,
): ComponentDefinition | null {
    const className = nameOf(node);
    if (!className) return null;

    const fqcn = namespace ? `${namespace}\\${className}` : className;

    const operations: ComponentDefinition['operations'] = [];
    const body = findChild(node, 'declaration_list');
    if (body) {
        for (const member of body.children) {
            if (member.type !== 'method_declaration') continue;
            const methodName = nameOf(member);
            if (!methodName) continue;
            operations.push({
                name: methodName.toLowerCase(),  // PHP is case-insensitive on methods
                range: {
                    startLine: member.startPosition.row + 1,
                    endLine: member.endPosition.row + 1,
                },
            });
        }
    }

    const declaredInterfaces: string[] = [];
    for (const child of node.children) {
        if (child.type === 'class_interface_clause' || child.type === 'base_clause') {
            for (const sub of child.children) {
                if (sub.type === 'name' || sub.type === 'qualified_name' || sub.type === 'named_type') {
                    const text = sub.text.trim();
                    if (!text) continue;
                    // Resolve via use-aliases + namespace (real Symfony code
                    // declares `implements LoggerInterface` with
                    // `use Psr\Log\LoggerInterface;` — bare-name qualification
                    // to the current namespace was wrong).
                    const resolved = resolveTypeHintToFqcn(text, scope) ?? text;
                    declaredInterfaces.push(resolved.replace(/^\\+/, ''));
                }
            }
        }
    }

    const ctorParams = body ? collectConstructorParameterNames(body) : [];

    return {
        fqcn,
        file: filepath,
        operations,
        declaredInterfaces,
        constructorParameterNames: ctorParams.length > 0 ? ctorParams : undefined,
    };
}

// Ordered constructor parameter names (ALL params, including scalars). The
// DI resolver maps a positional ctor scalar (arg index N) to the param it
// fills via this list, then resolves the wrapper property assigned from it.
function collectConstructorParameterNames(body: Parser.SyntaxNode): string[] {
    const constructor = findConstructor(body);
    if (!constructor) return [];
    const formalParams = findChild(constructor, 'formal_parameters');
    if (!formalParams) return [];

    const names: string[] = [];
    for (const param of formalParams.children) {
        if (
            param.type !== 'simple_parameter'
            && param.type !== 'property_promotion_parameter'
            && param.type !== 'variadic_parameter'
        ) continue;
        const varNode = param.children.find(c => c.type === 'variable_name');
        if (!varNode) continue;
        const name = varNode.text.replace(/^\$/, '').trim();
        if (name) names.push(name);
    }
    return names;
}

function nameOf(node: Parser.SyntaxNode): string | null {
    const nameChild = node.children.find(c => c.type === 'name');
    return nameChild ? nameChild.text.trim() : null;
}

function findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    return node.children.find(c => c.type === type) ?? null;
}

function findConstructor(body: Parser.SyntaxNode): Parser.SyntaxNode | null {
    for (const member of body.children) {
        if (member.type !== 'method_declaration') continue;
        const name = nameOf(member);
        if (name && name.toLowerCase() === '__construct') return member;
    }
    return null;
}

function collectParameters(
    constructor: Parser.SyntaxNode,
    ownerComponent: string,
    scope: PhpFileScope,
    out: DependencyRequirement[],
): void {
    const formalParams = findChild(constructor, 'formal_parameters');
    if (!formalParams) return;

    for (const param of formalParams.children) {
        if (
            param.type !== 'simple_parameter'
            && param.type !== 'property_promotion_parameter'
            && param.type !== 'variadic_parameter'
        ) continue;

        const typeNode = param.children.find(c =>
            c.type === 'named_type' || c.type === 'name' || c.type === 'qualified_name'
            || c.type === 'union_type' || c.type === 'intersection_type' || c.type === 'nullable_type',
        );
        if (!typeNode) continue;

        const typeStrings = collectTypeNames(typeNode);
        if (typeStrings.length === 0) continue;

        const varNode = param.children.find(c => c.type === 'variable_name');
        if (!varNode) continue;
        const parameterName = varNode.text.replace(/^\$/, '').trim();
        if (!parameterName) continue;

        for (const typeName of typeStrings) {
            if (PHP_PRIMITIVE_TYPES.has(typeName.toLowerCase())) continue;
            // Resolve via use-aliases + namespace.
            const resolved = resolveTypeHintToFqcn(typeName, scope) ?? typeName;
            const fq = resolved.replace(/^\\+/, '');
            out.push({
                ownerComponent,
                parameterName,
                requiredType: fq,
                isAbstractType: isLikelyAbstractType(fq),
            });
        }
    }
}

function collectTypeNames(typeNode: Parser.SyntaxNode): string[] {
    if (typeNode.type === 'name' || typeNode.type === 'qualified_name' || typeNode.type === 'named_type') {
        const text = typeNode.text.trim();
        return text ? [text] : [];
    }
    if (typeNode.type === 'union_type' || typeNode.type === 'intersection_type' || typeNode.type === 'nullable_type') {
        const out: string[] = [];
        for (const child of typeNode.children) {
            out.push(...collectTypeNames(child));
        }
        return out;
    }
    return [];
}

function isLikelyAbstractType(fqcn: string): boolean {
    const last = fqcn.split('\\').pop() ?? fqcn;
    if (last.endsWith('Interface')) return true;
    if (last.endsWith('Contract')) return true;
    if (/^Abstract[A-Z]/.test(last)) return true;
    return false;
}
