import type Parser from 'tree-sitter';
import type { ClassPropertyAlias, DependencyBinding, ImportRef } from '../../import-graph.js';
import type { ImportContext } from '../types.js';
import { extractSimpleTypeName, extractTypeText } from './type-extraction.js';

const PRIMITIVE_TYPE_PATTERN = /^(?:string|number|boolean|bigint|symbol|void|undefined|null|never)(?:\s*\[\s*\])?$/;

export function extractTypeScriptImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
    const imports: ImportRef[] = [];

    const walk = (node: Parser.SyntaxNode) => {
        if (node.type === 'import_statement') {
            const sourceNode = node.childForFieldName('source');
            if (!sourceNode) {
                for (const child of node.children) walk(child);
                return;
            }

            let source = sourceNode.text.replace(/['"]/g, '');
            let isExternal = !source.startsWith('.') && !source.startsWith('/');

            if (isExternal && source.startsWith('@') && source.split('/').length >= 3) {
                const stripped = source.slice(1);
                const EXTS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
                for (const ext of EXTS) {
                    if (context.allFilePaths.has(stripped + ext)) {
                        source = stripped + ext;
                        isExternal = false;
                        break;
                    }
                }
                if (isExternal) {
                    const segs = stripped.split('/');
                    if (segs.length >= 3) {
                        const withSrc = `${segs[0]}/${segs[1]}/src/${segs.slice(2).join('/')}`;
                        for (const ext of EXTS) {
                            if (context.allFilePaths.has(withSrc + ext)) {
                                source = withSrc + ext;
                                isExternal = false;
                                break;
                            }
                        }
                    }
                }
            }
            const specifiers: string[] = [];
            const specifierBindings: ImportRef['specifierBindings'] = [];

            for (const child of node.children) {
                if (child.type !== 'import_clause') continue;

                const defaultNode = child.children.find(candidate => candidate.type === 'identifier');
                if (defaultNode) {
                    specifiers.push(defaultNode.text);
                    specifierBindings.push({ imported: 'default', local: defaultNode.text, kind: 'default' });
                }

                const named = child.children.find(candidate => candidate.type === 'named_imports');
                if (named) {
                    for (const specifier of named.children) {
                        if (specifier.type !== 'import_specifier') continue;
                        const nameNode = specifier.childForFieldName('name');
                        if (!nameNode) continue;
                        const aliasNode = specifier.childForFieldName('alias');
                        const localName = aliasNode?.text ?? nameNode.text;
                        specifiers.push(nameNode.text);
                        specifierBindings.push({ imported: nameNode.text, local: localName, kind: 'named' });
                    }
                }

                const namespaceImport = child.children.find(candidate => candidate.type === 'namespace_import');
                if (namespaceImport) {
                    const localNode = namespaceImport.children.find(candidate => candidate.type === 'identifier');
                    const localName = localNode?.text ?? '*';
                    specifiers.push('*');
                    specifierBindings.push({ imported: '*', local: localName, kind: 'namespace' });
                }
            }

            if (specifiers.length === 0) specifiers.push('default');
            imports.push({
                source,
                specifiers,
                isExternal,
                ...(specifierBindings.length > 0 ? { specifierBindings } : {}),
            });
        }

        if (node.type === 'call_expression') {
            const fn = node.childForFieldName('function');
            const args = node.childForFieldName('arguments');
            if (fn?.text === 'require' && args) {
                const firstArg = args.children.find(child => child.type === 'string');
                if (firstArg) {
                    let source = firstArg.text.replace(/['"]/g, '');
                    let isExternal = !source.startsWith('.') && !source.startsWith('/');

                    if (isExternal && source.startsWith('@') && source.split('/').length >= 3) {
                        const stripped = source.slice(1);
                        const EXTS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
                        for (const ext of EXTS) {
                            if (context.allFilePaths.has(stripped + ext)) {
                                source = stripped + ext;
                                isExternal = false;
                                break;
                            }
                        }
                        if (isExternal) {
                            const segs = stripped.split('/');
                            if (segs.length >= 3) {
                                const withSrc = `${segs[0]}/${segs[1]}/src/${segs.slice(2).join('/')}`;
                                for (const ext of EXTS) {
                                    if (context.allFilePaths.has(withSrc + ext)) {
                                        source = withSrc + ext;
                                        isExternal = false;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    imports.push({ source, specifiers: ['default'], isExternal });
                }
            }
        }

        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    return imports;
}

export function extractTypeScriptExports(rootNode: Parser.SyntaxNode): string[] {
    const exports: string[] = [];

    const walk = (node: Parser.SyntaxNode) => {
        if (node.type === 'export_statement') {
            for (const child of node.children) {
                if (
                    child.type === 'class_declaration' ||
                    child.type === 'function_declaration' ||
                    child.type === 'interface_declaration' ||
                    child.type === 'type_alias_declaration'
                ) {
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) exports.push(nameNode.text);
                }

                if (child.type === 'export_clause') {
                    for (const specifier of child.children) {
                        if (specifier.type !== 'export_specifier') continue;
                        const nameNode = specifier.childForFieldName('name');
                        if (nameNode) exports.push(nameNode.text);
                    }
                }
            }
        }

        if (node.type === 'class_declaration' || node.type === 'function_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) exports.push(nameNode.text);
        }

        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    return [...new Set(exports)];
}

export function extractTypeScriptClassPropertyAliases(rootNode: Parser.SyntaxNode): ClassPropertyAlias[] {
    const aliases: ClassPropertyAlias[] = [];

    const walkClasses = (node: Parser.SyntaxNode) => {
        if (node.type === 'class_declaration' || node.type === 'class') {
            const body = node.childForFieldName('body');
            if (body) {
                for (const member of body.children) {
                    if (member.type === 'public_field_definition') {
                        const propName = member.childForFieldName('name');
                        const typeAnnotation = member.childForFieldName('type');
                        if (propName && typeAnnotation) {
                            const typeName = extractSimpleTypeName(typeAnnotation);
                            if (typeName) aliases.push({ propertyAccess: `this.${propName.text}`, typeName });
                        }
                    }

                    if (member.type === 'method_definition') {
                        const nameNode = member.childForFieldName('name');
                        if (nameNode?.text !== 'constructor') continue;
                        const params = member.childForFieldName('parameters');
                        if (!params) continue;

                        for (const param of params.children) {
                            if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') continue;
                            const hasAccessModifier = param.children.some(child => child.type === 'accessibility_modifier');
                            if (!hasAccessModifier) continue;
                            const paramName = param.childForFieldName('pattern');
                            const paramType = param.childForFieldName('type');
                            if (!paramName) continue;
                            const propertyAccess = `this.${paramName.text}`;

                            const seenTypes = new Set<string>();
                            if (paramType) {
                                const typeName = extractSimpleTypeName(paramType);
                                if (typeName) {
                                    aliases.push({ propertyAccess, typeName });
                                    seenTypes.add(typeName);
                                }
                            }

                            // DI token alias: when @Inject('TOKEN') or @Inject(TOKEN)
                            // decorates the param, the token name is the canonical
                            // identifier that DI modules use in {provide: 'TOKEN',
                            // useClass: ConcreteImpl}. Without this alias the taint
                            // chain breaks: the consumer's `this.x` type is the
                            // interface, but the binding propagates via the token.
                            //
                            // Gate 5 filter: skip inject tokens when the parameter's
                            // actual type is primitive (string, number, boolean, etc.).
                            // These are config/value injections, not service instances.
                            const injectToken = extractInjectTokenFromParam(param);
                            if (injectToken && !seenTypes.has(injectToken)) {
                                const actualType = paramType ? extractTypeText(paramType).trim() : '';
                                if (!PRIMITIVE_TYPE_PATTERN.test(actualType)) {
                                    aliases.push({ propertyAccess, typeName: injectToken });
                                }
                            }
                        }
                    }
                }
            }
        }

        for (const child of node.children) walkClasses(child);
    };

    walkClasses(rootNode);
    return aliases;
}

export function extractTypeScriptDependencyBindings(rootNode: Parser.SyntaxNode, filePath: string): DependencyBinding[] {
    const bindings: DependencyBinding[] = [];

    const walk = (node: Parser.SyntaxNode) => {
        if (node.type === 'object') {
            const pairs = new Map<string, Parser.SyntaxNode>();
            for (const child of node.children) {
                if (child.type !== 'pair') continue;
                const keyNode = child.childForFieldName('key');
                const valueNode = child.childForFieldName('value');
                if (!keyNode || !valueNode) continue;
                pairs.set(normalizeObjectKey(keyNode.text), valueNode);
            }

            const provideNode = pairs.get('provide');
            const useClassNode = pairs.get('useClass');
            const useExistingNode = pairs.get('useExisting');

            if (provideNode && useClassNode) {
                const provide = extractBindingToken(provideNode);
                const target = extractBindingToken(useClassNode);
                if (provide && target) {
                    bindings.push({ provide, target, filePath, bindingType: 'useClass' });
                }
            }

            if (provideNode && useExistingNode) {
                const provide = extractBindingToken(provideNode);
                const target = extractBindingToken(useExistingNode);
                if (provide && target) {
                    bindings.push({ provide, target, filePath, bindingType: 'useExisting' });
                }
            }
        }

        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    return dedupeBindings(bindings);
}

function normalizeObjectKey(raw: string): string {
    return raw.replace(/['"`]/g, '');
}

function extractBindingToken(node: Parser.SyntaxNode): string | null {
    if (node.type === 'identifier' || node.type === 'type_identifier') {
        return node.text;
    }
    if (node.type === 'member_expression') {
        return node.text;
    }
    if (node.type === 'string') {
        return node.text.replace(/['"]/g, '');
    }
    return null;
}

/**
 * Extract the DI token from a constructor parameter decorated with
 * `@Inject('TOKEN')` or `@Inject(IDENTIFIER_TOKEN)`. The token is the
 * canonical name DI modules use in `{provide: 'TOKEN', useClass: ...}`,
 * which is otherwise invisible to the type-annotation path.
 */
function extractInjectTokenFromParam(param: Parser.SyntaxNode): string | null {
    for (const child of param.children) {
        if (child.type !== 'decorator') continue;
        const callExpr = child.children.find(c => c.type === 'call_expression');
        if (!callExpr) continue;
        const fnNode = callExpr.childForFieldName('function');
        if (fnNode?.text !== 'Inject') continue;
        const argsNode = callExpr.childForFieldName('arguments');
        if (!argsNode) continue;
        const firstArg = argsNode.children.find(
            c => c.type !== '(' && c.type !== ')' && c.type !== ',',
        );
        if (!firstArg) continue;
        return extractBindingToken(firstArg);
    }
    return null;
}

function dedupeBindings(bindings: DependencyBinding[]): DependencyBinding[] {
    const seen = new Set<string>();
    const deduped: DependencyBinding[] = [];

    for (const binding of bindings) {
        const key = `${binding.filePath}:${binding.bindingType}:${binding.provide}:${binding.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(binding);
    }

    return deduped;
}
