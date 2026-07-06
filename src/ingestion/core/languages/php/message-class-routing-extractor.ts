/**
 * Extract a generic message-class -> routing-string map from a PHP file.
 *
 * Pattern (language-neutral, not Symfony Messenger-specific):
 *
 *   return [
 *       <CQRSClassName>::class => '<route.string>',
 *       <CQRSClassName>::class => [ <anyKey> => '<route.string>', ... ],
 *       ...
 *   ];
 *
 * Where:
 *   - <CQRSClassName> is any class whose name ends in Message|Event|Command|Query
 *   - <route.string> is a dot-separated literal (or concatenation with env vars
 *     normalised to `{varName}` placeholders) that doesn't look like a PHP FQCN
 *
 * The extractor does NOT care about the enclosing method name (e.g. getMessageMap,
 * buildRoutes, anything) or the inner array key name (e.g. routing_key, queue_name,
 * topic). Customers free-name those — what's universal is the
 * (CQRSClass -> topic) pairing.
 *
 * Returns `Map<MessageClassShortName, routingKeyTemplate>`. Dynamic variables in
 * concatenation chains are normalised to `{varName}` placeholders (e.g.
 * `'acme.foo' . $envSuffix . '.X.Y'` -> `'acme.foo{envSuffix}.X.Y'`).
 *
 * Tree-sitter walk only — never regex over PHP syntax, per CLAUDE.md plugin rules.
 */

import type Parser from 'tree-sitter';
import { extractStringLiteralValue } from './shared/ast-utils.js';

const CQRS_CLASS_SUFFIX = /(?:Message|Event|Command|Query)$/;

export function extractMessageClassRoutingTable(rootNode: Parser.SyntaxNode): Map<string, string> {
    const result = new Map<string, string>();

    const visit = (node: Parser.SyntaxNode): void => {
        if (node.type === 'return_statement') {
            const arr = findChildOfType(node, 'array_creation_expression');
            if (arr) extractFromOuterArray(arr, result);
        }
        for (const child of node.children) visit(child);
    };
    visit(rootNode);

    return result;
}

function extractFromOuterArray(arrayNode: Parser.SyntaxNode, out: Map<string, string>): void {
    for (const element of arrayNode.children) {
        if (element.type !== 'array_element_initializer') continue;
        const className = extractClassClassKey(element);
        if (!className) continue;
        if (!CQRS_CLASS_SUFFIX.test(className)) continue;

        const valueNode = element.children[element.children.length - 1];
        if (!valueNode) continue;

        const routingKey = extractRoutingKey(valueNode);
        if (routingKey !== null) out.set(className, routingKey);
    }
}

function extractClassClassKey(elementNode: Parser.SyntaxNode): string | null {
    for (const child of elementNode.children) {
        if (child.text === '=>' || child.text === ',') break;
        if (child.type === 'class_constant_access_expression'
            || child.type === 'scoped_call_expression'
            || child.type === 'scoped_property_access_expression') {
            const idx = child.text.lastIndexOf('::');
            if (idx <= 0) continue;
            const constName = child.text.slice(idx + 2).trim().toLowerCase();
            if (constName !== 'class') continue;
            const className = child.text.slice(0, idx).trim();
            const stripped = className.replace(/^\\+/, '');
            const lastSegment = stripped.split('\\').pop() ?? stripped;
            return lastSegment.length > 0 ? lastSegment : null;
        }
    }
    return null;
}

/**
 * Extract a topic-shaped routing key from a value node.
 *   - If the value is a literal/concatenation: resolve to a string and accept
 *     it if it contains a dot AND no namespace backslash (then it's a topic).
 *   - If the value is itself an inner array: scan its element values for the
 *     FIRST topic-shaped string. The inner key name does NOT matter (could be
 *     `routing_key`, `queue_name`, `topic`, anything).
 *   - Skip values that ARE class references (DI handler maps).
 */
function extractRoutingKey(valueNode: Parser.SyntaxNode): string | null {
    // Top-level skip: only `::class` is a FQCN (not a routing key). Other
    // class_constant_access (`self::CONST`, `static::CONST`, `Foo::BAR`)
    // may resolve to a literal via resolveClassMemberLiteral.
    if (valueNode.type === 'class_constant_access_expression' && isClassClassAccess(valueNode)) {
        return null;
    }
    if (valueNode.type === 'scoped_property_access_expression') {
        return null;
    }

    if (valueNode.type === 'array_creation_expression') {
        for (const element of valueNode.children) {
            if (element.type !== 'array_element_initializer') continue;
            const innerValue = element.children[element.children.length - 1];
            if (!innerValue) continue;
            // Inner skip: same restriction as top-level (v5+v8 reviewer P0).
            if (innerValue.type === 'class_constant_access_expression' && isClassClassAccess(innerValue)) continue;
            if (innerValue.type === 'scoped_property_access_expression') continue;
            const candidate = resolveRoutingKeyExpression(innerValue);
            if (isTopicShaped(candidate)) return candidate;
        }
        return null;
    }

    const direct = resolveRoutingKeyExpression(valueNode);
    return isTopicShaped(direct) ? direct : null;
}

/** True when the `class_constant_access_expression` is the FQCN form `SomeClass::class`. */
function isClassClassAccess(node: Parser.SyntaxNode): boolean {
    const idx = node.text.lastIndexOf('::');
    if (idx <= 0) return false;
    return node.text.slice(idx + 2).trim().toLowerCase() === 'class';
}

function isTopicShaped(value: string | null): value is string {
    if (value === null) return false;
    return value.includes('.') && !value.includes('\\');
}

function resolveRoutingKeyExpression(node: Parser.SyntaxNode): string | null {
    if (node.type === 'string' || node.type === 'encapsed_string') {
        const v = extractStringLiteralValue(node);
        return typeof v === 'string' ? v : null;
    }

    if (node.type === 'binary_expression') {
        const segments = collectConcatSegments(node);
        if (segments === null) return null;
        return segments.join('');
    }

    if (node.type === 'parenthesized_expression') {
        const inner = node.children.find(c => c.type !== '(' && c.type !== ')');
        return inner ? resolveRoutingKeyExpression(inner) : null;
    }

    // Fallback (v7 P0-1): direct `self::CONST` or `$this->prop` as routing
    // key value. Without this, `'routing_key' => self::ORDER_PLACED` (no
    // concatenation) falls through to the `return null` below even after
    // resolveLeafSegment knows how to resolve those tokens.
    const segs = resolveLeafSegment(node);
    return segs ? segs.join('') : null;
}

function collectConcatSegments(node: Parser.SyntaxNode): string[] | null {
    if (node.type === 'binary_expression') {
        const left = node.childForFieldName('left') ?? node.children[0];
        const right = node.childForFieldName('right') ?? node.children[node.children.length - 1];
        const op = node.children.find(c =>
            c.type === '.' || c.text === '.',
        );
        if (!op || !left || !right) return null;
        const leftSegs = resolveLeafSegment(left);
        const rightSegs = resolveLeafSegment(right);
        if (leftSegs === null || rightSegs === null) return null;
        return [...leftSegs, ...rightSegs];
    }
    return resolveLeafSegment(node);
}

function resolveLeafSegment(node: Parser.SyntaxNode): string[] | null {
    if (node.type === 'binary_expression') {
        return collectConcatSegments(node);
    }
    if (node.type === 'string' || node.type === 'encapsed_string') {
        const v = extractStringLiteralValue(node);
        return typeof v === 'string' ? [v] : null;
    }
    if (node.type === 'variable_name') {
        const name = node.text.replace(/^\$+/, '');
        return [`{${name}}`];
    }
    // self::CONST or static::CONST — resolved to literal if declared in same class.
    if (node.type === 'class_constant_access_expression') {
        const left = node.children[0]?.text ?? '';
        if (left === 'self' || left === 'static') {
            const literal = resolveClassMemberLiteral(node);
            return literal !== null ? [literal] : null;
        }
        return null;
    }
    // $this->prop — resolved to literal if declared with default literal.
    if (node.type === 'member_access_expression') {
        const obj = node.children[0]?.text ?? '';
        if (obj === '$this') {
            const literal = resolveClassMemberLiteral(node);
            return literal !== null ? [literal] : null;
        }
        return null;
    }
    if (node.type === 'subscript_expression') {
        return null;
    }
    if (node.type === 'parenthesized_expression') {
        const inner = node.children.find(c => c.type !== '(' && c.type !== ')');
        return inner ? resolveLeafSegment(inner) : null;
    }
    return null;
}

/**
 * Walk parent chain to find the nearest enclosing class_declaration, then
 * search that class's body for a const/property declaration whose name
 * matches the member referenced by `node`. Returns the literal default
 * value if any, else null.
 *
 * Scope: same class only (v5+v8 reviewer P1-5). Cross-class/static external
 * references are out of scope. Uses a per-class WeakMap cache so a file with
 * many references to the same member doesn't re-walk the class body.
 */
const _classMemberCache = new WeakMap<Parser.SyntaxNode, Map<string, string | null>>();

function resolveClassMemberLiteral(node: Parser.SyntaxNode): string | null {
    const memberName = extractMemberName(node);
    if (!memberName) return null;

    const classNode = findEnclosingClass(node);
    if (!classNode) return null;

    let cache = _classMemberCache.get(classNode);
    if (!cache) {
        cache = new Map<string, string | null>();
        _classMemberCache.set(classNode, cache);
    }
    if (cache.has(memberName)) return cache.get(memberName)!;

    const literal = lookupClassMemberLiteral(classNode, memberName);
    cache.set(memberName, literal);
    return literal;
}

function extractMemberName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'class_constant_access_expression') {
        const idx = node.text.lastIndexOf('::');
        if (idx <= 0) return null;
        return node.text.slice(idx + 2).trim();
    }
    if (node.type === 'member_access_expression') {
        const idx = node.text.lastIndexOf('->');
        if (idx <= 0) return null;
        return node.text.slice(idx + 2).trim();
    }
    return null;
}

function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'class_declaration') return current;
        current = current.parent;
    }
    return null;
}

function lookupClassMemberLiteral(classNode: Parser.SyntaxNode, memberName: string): string | null {
    // Search class body for const_declaration or property_declaration with
    // matching name + literal default value.
    const body = classNode.children.find(c => c.type === 'declaration_list')
        ?? classNode.children.find(c => c.type === 'class_body');
    if (!body) return null;

    for (const decl of body.children) {
        // PHP class constants: `const NAME = 'literal';` or with visibility modifiers.
        if (decl.type === 'const_declaration') {
            const value = findConstValueByName(decl, memberName);
            if (value !== null) return value;
        }
        // PHP class properties: `private string $name = 'literal';`
        if (decl.type === 'property_declaration') {
            const value = findPropertyValueByName(decl, memberName);
            if (value !== null) return value;
        }
    }
    return null;
}

function findConstValueByName(constDecl: Parser.SyntaxNode, memberName: string): string | null {
    for (const elem of constDecl.children) {
        if (elem.type !== 'const_element') continue;
        const nameNode = elem.children[0];
        const valueNode = elem.children[elem.children.length - 1];
        if (!nameNode || !valueNode || nameNode.text !== memberName) continue;
        if (valueNode.type === 'string' || valueNode.type === 'encapsed_string') {
            const v = extractStringLiteralValue(valueNode);
            return typeof v === 'string' ? v : null;
        }
    }
    return null;
}

function findPropertyValueByName(propDecl: Parser.SyntaxNode, memberName: string): string | null {
    for (const elem of propDecl.children) {
        if (elem.type !== 'property_element') continue;
        // property_element is typically: variable_name ('=' default_value)?
        const varNode = elem.children.find(c => c.type === 'variable_name');
        if (!varNode) continue;
        const propName = varNode.text.replace(/^\$+/, '');
        if (propName !== memberName) continue;
        // Find the literal value after '='.
        for (let i = 0; i < elem.children.length; i++) {
            if (elem.children[i].type !== '=' && elem.children[i].text !== '=') continue;
            const valueNode = elem.children[i + 1];
            if (!valueNode) return null;
            if (valueNode.type === 'string' || valueNode.type === 'encapsed_string') {
                const v = extractStringLiteralValue(valueNode);
                return typeof v === 'string' ? v : null;
            }
        }
    }
    return null;
}

function findChildOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    for (const child of node.children) {
        if (child.type === type) return child;
    }
    return null;
}
