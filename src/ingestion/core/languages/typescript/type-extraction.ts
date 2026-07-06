import type Parser from 'tree-sitter';
import type { DataStructureDefinition, FunctionPayloadHints, TypeRef } from '../types.js';

/** TS primitive / pseudo-primitive type names — filtered from payload candidates. */
export const TS_PRIMITIVES = new Set([
    'string', 'number', 'boolean', 'void', 'undefined', 'null',
    'never', 'any', 'unknown', 'object', 'bigint', 'symbol',
]);

/** TS / browser / Node built-in classes — filtered from payload candidates. */
export const TS_BUILTIN_CLASSES = new Set([
    'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
    'EvalError', 'ReferenceError', 'URIError',
    'Promise', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
    'Object', 'Number', 'String', 'Boolean', 'Function', 'Symbol',
    'BigInt', 'Math', 'JSON',
    'URL', 'URLSearchParams',
    'Buffer', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array',
    'AbortController', 'AbortSignal',
    'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
    'ReadableStream', 'WritableStream', 'TransformStream',
]);

export function extractTypeScriptTypeDefinitions(rootNode: Parser.SyntaxNode): Map<string, DataStructureDefinition> {
    const defs = new Map<string, DataStructureDefinition>();

    const walk = (node: Parser.SyntaxNode) => {
        if (node.type === 'class_declaration' || node.type === 'class') {
            const nameNode = node.childForFieldName('name');
            const body = node.childForFieldName('body');
            if (nameNode && body) {
                const properties: Array<{ name: string; type: string }> = [];
                for (const member of body.children) {
                    if (member.type === 'public_field_definition') {
                        const propName = member.childForFieldName('name');
                        const typeAnnotation = member.childForFieldName('type');
                        if (propName) {
                            const typeName = typeAnnotation ? extractTypeText(typeAnnotation) : 'any';
                            properties.push({ name: propName.text, type: typeName });
                        }
                    }
                }

                for (const member of body.children) {
                    if (member.type !== 'method_definition') continue;
                    const methodName = member.childForFieldName('name');
                    if (methodName?.text !== 'constructor') continue;
                    const params = member.childForFieldName('parameters');
                    if (!params) continue;

                    for (const param of params.children) {
                        if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') continue;
                        const hasAccessMod = param.children.some(child => child.type === 'accessibility_modifier');
                        if (!hasAccessMod) continue;

                        const paramName = param.childForFieldName('pattern');
                        const paramType = param.childForFieldName('type');
                        if (paramName) {
                            const typeName = paramType ? extractTypeText(paramType) : 'any';
                            properties.push({ name: paramName.text, type: typeName });
                        }
                    }
                }

                if (properties.length > 0) {
                    defs.set(nameNode.text, { name: nameNode.text, kind: 'class', properties });
                }
            }
        }

        if (node.type === 'interface_declaration') {
            const nameNode = node.childForFieldName('name');
            const body = node.childForFieldName('body');
            if (nameNode && body) {
                const properties: Array<{ name: string; type: string }> = [];
                let hasMethodSignature = false;
                for (const member of body.children) {
                    if (member.type === 'property_signature') {
                        const propName = member.childForFieldName('name');
                        const typeAnnotation = member.childForFieldName('type');
                        if (propName) {
                            const typeName = typeAnnotation ? extractTypeText(typeAnnotation) : 'any';
                            properties.push({ name: propName.text, type: typeName });
                        }
                    } else if (member.type === 'method_signature') {
                        hasMethodSignature = true;
                    }
                }
                // Emit also when properties=[] but hasMethodSignature=true: service
                // interfaces (e.g. `interface UserRepository { getUser(): Promise<User> }`)
                // must be present in typeDefIndex so the sanitizer's knownServiceInterfaces
                // filter can drop them from produced/consumed_payloads.
                if (properties.length > 0 || hasMethodSignature) {
                    const interfaceRole: 'service' | 'data' = hasMethodSignature ? 'service' : 'data';
                    defs.set(nameNode.text, {
                        name: nameNode.text,
                        kind: 'interface',
                        properties,
                        interfaceRole,
                    });
                }
            }
        }

        if (node.type === 'type_alias_declaration') {
            const nameNode = node.childForFieldName('name');
            const valueNode = node.childForFieldName('value');
            if (nameNode && valueNode && valueNode.type === 'object_type') {
                const properties: Array<{ name: string; type: string }> = [];
                for (const member of valueNode.children) {
                    if (member.type !== 'property_signature') continue;
                    const propName = member.childForFieldName('name');
                    const typeAnnotation = member.childForFieldName('type');
                    if (propName) {
                        const typeName = typeAnnotation ? extractTypeText(typeAnnotation) : 'any';
                        properties.push({ name: propName.text, type: typeName });
                    }
                }
                if (properties.length > 0) {
                    defs.set(nameNode.text, { name: nameNode.text, kind: 'type', properties });
                }
            }
        }

        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    return defs;
}

export function extractTypeScriptReferencedTypes(rootNode: Parser.SyntaxNode): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const functionTypes = new Set(['function_declaration', 'method_definition', 'arrow_function', 'function']);

    const walk = (node: Parser.SyntaxNode, parentName?: string) => {
        if (functionTypes.has(node.type)) {
            const nameNode = node.childForFieldName('name');
            if (!nameNode) return;
            let functionName = nameNode.text;
            if (parentName) functionName = `${parentName}.${functionName}`;

            const types = new Set<string>();

            const params = node.childForFieldName('parameters');
            if (params) {
                for (const param of params.children) {
                    if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') continue;
                    const typeAnnotation = param.childForFieldName('type');
                    if (!typeAnnotation) continue;
                    const typeName = extractSimpleTypeName(typeAnnotation);
                    if (typeName) types.add(typeName);
                }
            }

            const returnType = node.childForFieldName('return_type');
            if (returnType) {
                const typeName = extractSimpleTypeName(returnType);
                if (typeName) types.add(typeName);
            }

            const walkNew = (current: Parser.SyntaxNode) => {
                if (current.type === 'new_expression') {
                    const ctorNode = current.childForFieldName('constructor');
                    if (ctorNode?.type === 'identifier') {
                        const typeName = ctorNode.text;
                        if (!TS_BUILTINS.has(typeName)) types.add(typeName);
                    }
                }
                for (const child of current.children) walkNew(child);
            };

            walkNew(node);

            if (types.size > 0) result.set(functionName, [...types]);
        }

        let className: string | undefined;
        if (node.type === 'class_declaration' || node.type === 'class') {
            const classNameNode = node.childForFieldName('name');
            if (classNameNode) className = classNameNode.text;
        }

        for (const child of node.children) walk(child, className ?? parentName);
    };

    walk(rootNode);
    return result;
}

function shouldEmitTsPayloadType(name: string): boolean {
    if (TS_PRIMITIVES.has(name)) return false;
    if (TS_BUILTIN_CLASSES.has(name)) return false;
    return true;
}

/**
 * Phase 1 (AST-first payload extraction). TS has no native namespace
 * separator, so `fqcn === basename`. Built-ins skipped in new-expression.
 */
export function extractTsFunctionPayloadHints(rootNode: Parser.SyntaxNode): Map<string, FunctionPayloadHints> {
    const result = new Map<string, FunctionPayloadHints>();
    const functionTypes = new Set(['function_declaration', 'method_definition', 'arrow_function', 'function']);

    const walk = (node: Parser.SyntaxNode, parentName?: string): void => {
        if (functionTypes.has(node.type)) {
            const nameNode = node.childForFieldName('name');
            if (!nameNode) {
                for (const child of node.children) walk(child, parentName);
                return;
            }
            const functionName = parentName ? `${parentName}.${nameNode.text}` : nameNode.text;
            const consumed: TypeRef[] = [];
            const produced: TypeRef[] = [];

            const params = node.childForFieldName('parameters');
            if (params) {
                for (const param of params.children) {
                    if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') continue;
                    const typeAnnotation = param.childForFieldName('type');
                    if (!typeAnnotation) continue;
                    const name = extractSimpleTypeName(typeAnnotation);
                    if (!name) continue;
                    if (!shouldEmitTsPayloadType(name)) continue;
                    consumed.push({ fqcn: name, basename: name, origin: 'parameter' });
                }
            }

            const returnBasenames = new Set<string>();
            const returnType = node.childForFieldName('return_type');
            if (returnType) {
                const name = extractSimpleTypeName(returnType);
                if (name && shouldEmitTsPayloadType(name)) {
                    returnBasenames.add(name);
                    produced.push({ fqcn: name, basename: name, origin: 'return-type' });
                }
            }

            const walkNew = (current: Parser.SyntaxNode): void => {
                if (current.type === 'new_expression') {
                    const ctorNode = current.childForFieldName('constructor');
                    if (ctorNode?.type === 'identifier') {
                        const name = ctorNode.text;
                        if (shouldEmitTsPayloadType(name) && !returnBasenames.has(name)) {
                            const already = produced.some(t => t.basename === name && t.origin === 'new-expression');
                            if (!already) produced.push({ fqcn: name, basename: name, origin: 'new-expression' });
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
        if (node.type === 'class_declaration' || node.type === 'class') {
            const classNameNode = node.childForFieldName('name');
            if (classNameNode) className = classNameNode.text;
        }
        for (const child of node.children) walk(child, className ?? parentName);
    };

    walk(rootNode);
    return result;
}

const TS_UTILITY_TYPES = /\b(Partial|Omit|Pick|Record|Required|Readonly|Exclude|Extract|NonNullable|ReturnType|Parameters|Awaited|InstanceType|ConstructorParameters)\b/;

/**
 * Phase 3 (Fix #2). Whitelist parser: `Array<X>`, `X[]`, `Promise<X>`,
 * `Map<K, V>`, `X | Y`. Aborts hard on inline objects (`{...}`) and TS
 * utility types. Filters out primitives + builtin classes.
 */
export function extractTsBaseTypesFromString(typeString: string): string[] {
    if (!typeString || typeString.trim().length === 0) return [];
    const s = typeString.trim();
    if (s.includes('{')) return [];
    if (TS_UTILITY_TYPES.test(s)) return [];

    let inner = s;
    while (true) {
        const generic = inner.match(/^([A-Za-z_][\w]*)<\s*(.+)\s*>$/);
        if (!generic) break;
        inner = generic[2];
    }
    inner = inner.replace(/(\[\])+$/g, '');

    const segments = inner.split(/[|,]/).map(seg => seg.trim()).filter(seg => seg.length > 0);
    const result: string[] = [];
    const seen = new Set<string>();
    for (const seg of segments) {
        const cleaned = seg.replace(/(\[\])+$/g, '').trim();
        const nested = cleaned.match(/^[A-Za-z_][\w]*<.+>$/);
        if (nested) {
            for (const name of extractTsBaseTypesFromString(cleaned)) {
                if (!seen.has(name)) {
                    seen.add(name);
                    result.push(name);
                }
            }
            continue;
        }
        if (TS_PRIMITIVES.has(cleaned)) continue;
        if (TS_BUILTIN_CLASSES.has(cleaned)) continue;
        if (!/^[A-Za-z_][\w]*$/.test(cleaned)) continue;
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        result.push(cleaned);
    }
    return result;
}

export function extractSimpleTypeName(typeNode: Parser.SyntaxNode): string | null {
    for (const child of typeNode.children) {
        if (child.type === 'type_identifier' || child.type === 'identifier') {
            const text = child.text;
            if (['string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'null', 'undefined'].includes(text)) {
                return null;
            }
            return text;
        }
        if (child.type === 'generic_type') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) return nameNode.text;
        }
    }
    return null;
}

export function extractTypeText(typeNode: Parser.SyntaxNode): string {
    for (const child of typeNode.children) {
        if (child.type !== ':' && child.type !== 'comment') {
            return child.text;
        }
    }
    return typeNode.text;
}

const TS_BUILTINS = new Set([
    'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
    'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
    'Buffer', 'URL', 'URLSearchParams',
    'Object', 'Number', 'String', 'Boolean',
    'Int8Array', 'Uint8Array', 'Float32Array', 'Float64Array',
    'AbortController', 'Headers', 'Request', 'Response',
    'FormData', 'Blob', 'File', 'ReadableStream', 'WritableStream',
]);
