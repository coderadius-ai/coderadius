import type Parser from 'tree-sitter';
import type { DataStructureDefinition, FunctionPayloadHints, TypeRef } from '../types.js';

export const PHP_PRIMITIVES = new Set([
    'string', 'int', 'integer', 'float', 'double', 'bool', 'boolean',
    'array', 'object', 'callable', 'iterable', 'void', 'null', 'mixed',
    'never', 'self', 'static', 'parent', 'true', 'false',
]);

/**
 * Standard-library classes that should NOT generate payload candidates.
 * Adding `new DateTime()`, `new Exception()`, `new stdClass()` as produced
 * payloads is pure noise.
 */
export const PHP_BUILTIN_CLASSES = new Set([
    'DateTime', 'DateTimeImmutable', 'DateInterval', 'DateTimeZone', 'DatePeriod',
    'Exception', 'RuntimeException', 'LogicException', 'InvalidArgumentException',
    'OutOfBoundsException', 'OutOfRangeException', 'TypeError', 'ValueError',
    'Throwable', 'Error',
    'stdClass', 'ArrayObject', 'ArrayIterator', 'SplStack', 'SplQueue',
    'SplObjectStorage', 'SplDoublyLinkedList', 'SplFixedArray', 'SplPriorityQueue',
    'Closure', 'Generator',
    'Iterator', 'IteratorAggregate', 'Traversable', 'Countable', 'ArrayAccess',
    'JsonSerializable', 'Stringable',
]);

function normalizePhpTypeText(typeText: string): string {
    const trimmed = typeText.trim().replace(/^\?/, '');
    return trimmed.includes('\\')
        ? trimmed.slice(trimmed.lastIndexOf('\\') + 1)
        : trimmed;
}

export function extractPhpTypeNameFromNode(node: Parser.SyntaxNode): string | null {
    if (node.type === 'named_type' || node.type === 'type_name' || node.type === 'primitive_type') {
        return normalizePhpTypeText(node.text);
    }

    if (node.type === 'optional_type') {
        const nested = node.children.find(child =>
            child.type === 'named_type'
            || child.type === 'type_name'
            || child.type === 'primitive_type',
        );
        return nested ? extractPhpTypeNameFromNode(nested) : normalizePhpTypeText(node.text);
    }

    return null;
}

function isPrimitivePhpType(typeName: string): boolean {
    return PHP_PRIMITIVES.has(typeName.toLowerCase());
}

export function extractPhpTypeDefinitions(rootNode: Parser.SyntaxNode): Map<string, DataStructureDefinition> {
    const definitions = new Map<string, DataStructureDefinition>();

    const walkClasses = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration') {
            const nameNode = node.childForFieldName('name');
            const body = node.childForFieldName('body');
            if (nameNode && body) {
                const properties: Array<{ name: string; type: string }> = [];

                for (const member of body.children) {
                    if (member.type === 'property_declaration') {
                        let typeName: string | null = null;
                        let propertyName: string | null = null;

                        for (const child of member.children) {
                            const extractedType = extractPhpTypeNameFromNode(child);
                            if (extractedType) {
                                typeName = extractedType;
                            }

                            if (child.type === 'property_element') {
                                const varNode = child.childForFieldName('name');
                                if (varNode) {
                                    propertyName = varNode.text.replace('$', '');
                                }
                            }
                        }

                        if (propertyName && typeName) {
                            properties.push({ name: propertyName, type: typeName });
                        } else if (propertyName) {
                            properties.push({ name: propertyName, type: 'mixed' });
                        }
                    }

                    if (member.type === 'method_declaration') {
                        const methodName = member.childForFieldName('name');
                        if (methodName?.text !== '__construct') continue;

                        const parameters = member.childForFieldName('parameters')!;

                        for (const param of parameters.children) {
                            if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter') continue;
                            const hasVisibility = param.children.some(child => child.type === 'visibility_modifier');
                            if (!hasVisibility) continue;

                            let typeName: string | null = null;
                            let propertyName: string | null = null;

                            for (const child of param.children) {
                                const extractedType = extractPhpTypeNameFromNode(child);
                                if (extractedType) {
                                    typeName = extractedType;
                                }
                                if (child.type === 'variable_name') {
                                    propertyName = child.text.replace('$', '');
                                }
                            }

                            if (propertyName && typeName) {
                                properties.push({ name: propertyName, type: typeName });
                            } else if (propertyName) {
                                properties.push({ name: propertyName, type: 'mixed' });
                            }
                        }
                    }
                }

                if (properties.length > 0) {
                    definitions.set(nameNode.text, { name: nameNode.text, kind: 'class', properties });
                }
            }
        }

        // PHP interface_declaration extraction (Phase 1B-PHP follow-up).
        // PHP < 8.4 interfaces are method-only (no property declarations
        // allowed), so they are ALWAYS service-interfaces. PHP 8.4 allows
        // interface property hooks but is exceedingly rare in production
        // code today; we still classify by hasMethodSignature for
        // forward-compat. Interface presence in typeDefIndex enables the
        // sanitizer's service-interface payload filter on PHP code.
        if (node.type === 'interface_declaration') {
            const nameNode = node.childForFieldName('name');
            const body = node.childForFieldName('body');
            if (nameNode && body) {
                const properties: Array<{ name: string; type: string }> = [];
                let hasMethodSignature = false;
                for (const member of body.children) {
                    if (member.type === 'method_declaration') {
                        hasMethodSignature = true;
                    } else if (member.type === 'property_declaration') {
                        // PHP 8.4+ — rare, but extract for completeness.
                        let typeName: string | null = null;
                        let propertyName: string | null = null;
                        for (const child of member.children) {
                            const extractedType = extractPhpTypeNameFromNode(child);
                            if (extractedType) typeName = extractedType;
                            if (child.type === 'property_element') {
                                const varNode = child.childForFieldName('name');
                                if (varNode) propertyName = varNode.text.replace('$', '');
                            }
                        }
                        if (propertyName) {
                            properties.push({ name: propertyName, type: typeName ?? 'mixed' });
                        }
                    }
                }
                if (properties.length > 0 || hasMethodSignature) {
                    const interfaceRole: 'service' | 'data' = hasMethodSignature ? 'service' : 'data';
                    definitions.set(nameNode.text, {
                        name: nameNode.text,
                        kind: 'interface',
                        properties,
                        interfaceRole,
                    });
                }
            }
        }

        for (const child of node.children) {
            walkClasses(child);
        }
    };

    walkClasses(rootNode);
    return definitions;
}

/** Strip a PHP FQCN to its basename: `Acme\Orders\Foo` → `Foo`. */
function phpBasename(fqcn: string): string {
    const trimmed = fqcn.replace(/^\\+/, '');
    const idx = trimmed.lastIndexOf('\\');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function readPhpFqcn(node: Parser.SyntaxNode): string | null {
    if (node.type === 'optional_type') {
        for (const child of node.children) {
            const inner = readPhpFqcn(child);
            if (inner) return inner;
        }
        return null;
    }
    if (node.type === 'primitive_type') return null;
    if (node.type === 'named_type' || node.type === 'type_name' || node.type === 'qualified_name' || node.type === 'name') {
        return node.text.replace(/^\\+/, '');
    }
    return null;
}

function shouldEmitPayloadType(basename: string): boolean {
    if (PHP_PRIMITIVES.has(basename.toLowerCase())) return false;
    if (PHP_BUILTIN_CLASSES.has(basename)) return false;
    return true;
}

/**
 * Phase 1 (AST-first payload extraction). Per-function emit `{ consumed,
 * produced }` lists of `TypeRef`. PHP plugin computes `basename` natively
 * via FQCN strip.
 */
export function extractPhpFunctionPayloadHints(rootNode: Parser.SyntaxNode): Map<string, FunctionPayloadHints> {
    const result = new Map<string, FunctionPayloadHints>();
    const functionTypes = new Set(['function_definition', 'method_declaration']);

    const walk = (node: Parser.SyntaxNode, parentName?: string): void => {
        if (functionTypes.has(node.type)) {
            const ownNode = node.childForFieldName('name');
            if (!ownNode) {
                for (const child of node.children) walk(child, parentName);
                return;
            }
            const functionName = parentName ? `${parentName}.${ownNode.text}` : ownNode.text;
            const consumed: TypeRef[] = [];
            const produced: TypeRef[] = [];

            // parameters → consumed
            const parameters = node.childForFieldName('parameters');
            if (parameters) {
                for (const param of parameters.children) {
                    if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter') continue;
                    for (const child of param.children) {
                        const fqcn = readPhpFqcn(child);
                        if (!fqcn) continue;
                        const basename = phpBasename(fqcn);
                        if (!shouldEmitPayloadType(basename)) continue;
                        consumed.push({ fqcn, basename, origin: 'parameter' });
                    }
                }
            }

            // return type → produced (do not descend into matched type nodes
            // so qualified_name segments don't yield separate refs).
            const returnType = node.childForFieldName('return_type');
            const returnBasenames = new Set<string>();
            const walkReturnType = (current: Parser.SyntaxNode): void => {
                const fqcn = readPhpFqcn(current);
                if (fqcn) {
                    const basename = phpBasename(fqcn);
                    if (shouldEmitPayloadType(basename) && !returnBasenames.has(basename)) {
                        returnBasenames.add(basename);
                        produced.push({ fqcn, basename, origin: 'return-type' });
                    }
                    return;
                }
                for (const child of current.children) walkReturnType(child);
            };
            if (returnType) walkReturnType(returnType);

            // new-expression → produced (when not already in return)
            const walkNew = (current: Parser.SyntaxNode): void => {
                if (current.type === 'object_creation_expression') {
                    const classNode = current.children.find(child => child.type === 'name' || child.type === 'qualified_name');
                    if (classNode) {
                        const fqcn = classNode.text.replace(/^\\+/, '');
                        const basename = phpBasename(fqcn);
                        if (shouldEmitPayloadType(basename) && !returnBasenames.has(basename)) {
                            const already = produced.some(t => t.basename === basename && t.origin === 'new-expression');
                            if (!already) {
                                produced.push({ fqcn, basename, origin: 'new-expression' });
                            }
                        }
                    }
                }
                for (const child of current.children) walkNew(child);
            };
            walkNew(node);

            if (consumed.length > 0 || produced.length > 0) {
                result.set(functionName, { consumed, produced });
            }
        }

        let className: string | undefined;
        if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'trait_declaration') {
            className = node.childForFieldName('name')?.text;
        }
        for (const child of node.children) walk(child, className ?? parentName);
    };

    walk(rootNode);
    return result;
}

/**
 * Phase 3 (Fix #2). Parses PHP type strings into base names that may refer
 * to a DataStructure. Skips primitives + builtin classes. Strips namespace.
 */
export function extractPhpBaseTypesFromString(typeString: string): string[] {
    if (!typeString || typeString.trim().length === 0) return [];
    const result: string[] = [];
    const seen = new Set<string>();

    let s = typeString.trim().replace(/^\?+/, '');
    s = s.replace(/(\[\])+$/g, '');
    const arrayMatch = s.match(/^array<\s*(.+?)\s*>$/i);
    if (arrayMatch) s = arrayMatch[1];

    const segments = s.split(/[|&,]/).map(seg => seg.trim()).filter(seg => seg.length > 0);
    for (const seg of segments) {
        const basename = phpBasename(seg);
        if (!basename) continue;
        if (PHP_PRIMITIVES.has(basename.toLowerCase())) continue;
        if (PHP_BUILTIN_CLASSES.has(basename)) continue;
        if (seen.has(basename)) continue;
        seen.add(basename);
        result.push(basename);
    }
    return result;
}

export function extractPhpReferencedTypes(rootNode: Parser.SyntaxNode): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const functionTypes = new Set(['function_definition', 'method_declaration']);

    const walk = (node: Parser.SyntaxNode, parentName?: string): void => {
        if (functionTypes.has(node.type)) {
            const ownName = node.childForFieldName('name')!.text;
            const functionName = parentName ? `${parentName}.${ownName}` : ownName;
            const types = new Set<string>();

            const parameters = node.childForFieldName('parameters');
            if (parameters) {
                for (const param of parameters.children) {
                    if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter') continue;
                    for (const child of param.children) {
                        const typeName = extractPhpTypeNameFromNode(child);
                        if (typeName && !isPrimitivePhpType(typeName)) {
                            types.add(typeName);
                        }
                    }
                }
            }

            const returnType = node.childForFieldName('return_type');
            if (returnType) {
                const stack = [...returnType.children];
                while (stack.length > 0) {
                    const current = stack.pop()!;
                    const typeName = extractPhpTypeNameFromNode(current);
                    if (typeName && !isPrimitivePhpType(typeName)) {
                        types.add(typeName);
                    }
                    stack.push(...current.children);
                }
            }

            const walkNewExpressions = (current: Parser.SyntaxNode): void => {
                if (current.type === 'object_creation_expression') {
                    const classNode = current.children.find(child => child.type === 'name' || child.type === 'qualified_name');
                    if (classNode) {
                        const typeName = normalizePhpTypeText(classNode.text);
                        if (!isPrimitivePhpType(typeName)) {
                            types.add(typeName);
                        }
                    }
                }
                for (const child of current.children) {
                    walkNewExpressions(child);
                }
            };

            walkNewExpressions(node);

            if (types.size > 0) {
                result.set(functionName, [...types]);
            }
        }

        let className: string | undefined;
        if (node.type === 'class_declaration') {
            className = node.childForFieldName('name')?.text;
        }

        for (const child of node.children) {
            walk(child, className ?? parentName);
        }
    };

    walk(rootNode);
    return result;
}
