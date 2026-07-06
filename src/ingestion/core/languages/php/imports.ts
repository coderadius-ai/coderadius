import path from 'node:path';
import type Parser from 'tree-sitter';
import type { ClassPropertyAlias, ImportRef } from '../../import-graph.js';
import type { ImportContext } from '../types.js';
import { extractStringLiteralValueRaw } from './shared/ast-utils.js';

const PHP_PRIMITIVE_TYPES = new Set([
    'string', 'int', 'integer', 'float', 'double', 'bool', 'boolean',
    'array', 'object', 'callable', 'iterable', 'void', 'null', 'mixed',
    'never', 'self', 'static', 'parent', 'true', 'false',
]);

export function normalizePhpType(typeName: string): string | null {
    const baseName = typeName.includes('\\')
        ? typeName.slice(typeName.lastIndexOf('\\') + 1)
        : typeName;
    if (PHP_PRIMITIVE_TYPES.has(baseName.toLowerCase())) return null;
    return baseName;
}

export function extractPhpImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
    return [
        ...extractPhpNamespaceUseImports(rootNode, context),
        ...extractPhpRequireIncludeImports(rootNode, context),
        ...extractLaravelConfigImports(rootNode, context),
        ...extractPhpSameNamespaceImplicitImports(rootNode, context),
    ];
}

/**
 * Resolve the file paths of parent classes / implemented interfaces declared
 * by this file's classes via PSR-4 lookup. Returns the relative-path strings
 * for files that exist in `allFilePaths`. Cross-namespace `extends/implements`
 * (with explicit `\\Foo\\Bar` references) are also resolved when the FQCN
 * matches a registered prefix.
 */
export function extractPhpImplementsFiles(rootNode: Parser.SyntaxNode, context: ImportContext): string[] {
    const out = new Set<string>();

    let currentNamespace: string | null = null;
    const findNs = (node: Parser.SyntaxNode): void => {
        if (node.type === 'namespace_definition') {
            const nameNode = node.children.find(c => c.type === 'namespace_name' || c.type === 'qualified_name' || c.type === 'name');
            if (nameNode) currentNamespace = nameNode.text;
            return;
        }
        for (const child of node.children) findNs(child);
    };
    findNs(rootNode);
    if (!currentNamespace) return [];

    const collectFromTypeNode = (typeNode: Parser.SyntaxNode | null | undefined): void => {
        if (!typeNode) return;
        if (typeNode.type === 'name' || typeNode.type === 'qualified_name' || typeNode.type === 'named_type') {
            const text = typeNode.text.trim();
            if (!text) return;
            const fqcn = text.includes('\\')
                ? text.replace(/^\\+/, '')
                : `${currentNamespace}\\${text}`;
            const resolved = resolvePhpNamespaceToPsr4(fqcn, context);
            if (resolved) out.add(resolved);
            return;
        }
    };

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
            for (const child of node.children) {
                if (child.type === 'base_clause' || child.type === 'class_interface_clause') {
                    for (const sub of child.children) collectFromTypeNode(sub);
                }
            }
        }
        for (const child of node.children) walk(child);
    };
    walk(rootNode);

    return [...out];
}

/**
 * Emit implicit imports for type names referenced without a `use` statement
 * in the same namespace (PHP resolves them lexically). Critical for taint
 * propagation: in `namespace Foo\Bar; class Service { __construct(BarHttpClient $c) }`
 * the `BarHttpClient` type IS imported (logically) from `Foo\Bar\BarHttpClient`,
 * but no `use` declaration exists in the AST. Without this pass, taint
 * cannot follow type-hint dependencies across co-located classes in PHP.
 *
 * The implicit imports cover:
 *   - constructor / method parameter type hints
 *   - property type hints (typed properties and constructor-promoted)
 *   - extends / implements clauses
 *
 * Resolution is PSR-4 only: a bare type name X is qualified as
 * `<currentNamespace>\X` and resolved against the dependency mapping. If the
 * target file exists in `allFilePaths`, we emit an `ImportRef` with
 * `source = resolvedFilepath`, `isExternal = false`. Otherwise the name is
 * skipped (it might be a vendor class or an unresolved scope).
 */
export function extractPhpSameNamespaceImplicitImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
    const imports: ImportRef[] = [];
    const seenLocal = new Set<string>(); // dedup per-resolved-path

    // Step 1: discover the file's namespace.
    let currentNamespace: string | null = null;
    const findNs = (node: Parser.SyntaxNode): void => {
        if (node.type === 'namespace_definition') {
            const nameNode = node.children.find(c => c.type === 'namespace_name' || c.type === 'qualified_name' || c.type === 'name');
            if (nameNode) currentNamespace = nameNode.text;
            return;
        }
        for (const child of node.children) findNs(child);
    };
    findNs(rootNode);
    if (!currentNamespace) return imports;

    // Step 2: collect bare type names referenced as type hints, extends, implements.
    const bareTypeNames = new Set<string>();
    const collectFromTypeNode = (typeNode: Parser.SyntaxNode | null | undefined): void => {
        if (!typeNode) return;
        if (typeNode.type === 'named_type' || typeNode.type === 'name') {
            const text = typeNode.text.trim();
            // Skip fully-qualified names (with backslash) — they're handled by
            // `use` statements or by the FQCN path. Skip primitives.
            if (!text || text.includes('\\')) return;
            const lower = text.toLowerCase();
            if (PHP_PRIMITIVE_TYPES.has(lower)) return;
            bareTypeNames.add(text);
            return;
        }
        if (typeNode.type === 'union_type' || typeNode.type === 'intersection_type' || typeNode.type === 'nullable_type') {
            for (const child of typeNode.children) collectFromTypeNode(child);
            return;
        }
    };

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'trait_declaration') {
            // extends / implements clauses
            for (const child of node.children) {
                if (child.type === 'base_clause' || child.type === 'class_interface_clause') {
                    for (const sub of child.children) collectFromTypeNode(sub);
                }
            }
        }
        if (node.type === 'simple_parameter' || node.type === 'variadic_parameter' || node.type === 'property_promotion_parameter') {
            const typeNode = node.childForFieldName('type') ?? node.children.find(c => c.type === 'named_type' || c.type === 'union_type' || c.type === 'intersection_type' || c.type === 'nullable_type');
            collectFromTypeNode(typeNode);
        }
        if (node.type === 'property_declaration') {
            const typeNode = node.children.find(c => c.type === 'named_type' || c.type === 'union_type' || c.type === 'intersection_type' || c.type === 'nullable_type');
            collectFromTypeNode(typeNode);
        }
        for (const child of node.children) walk(child);
    };
    walk(rootNode);

    if (bareTypeNames.size === 0) return imports;

    // Step 3: qualify each bare name with the current namespace and PSR-4 resolve.
    for (const bareName of bareTypeNames) {
        const fqcn = `${currentNamespace}\\${bareName}`;
        const resolved = resolvePhpNamespaceToPsr4(fqcn, context);
        if (!resolved) continue;
        if (seenLocal.has(resolved)) continue;
        seenLocal.add(resolved);
        imports.push({
            source: resolved,
            specifiers: [bareName],
            isExternal: false,
            specifierBindings: [{
                imported: bareName,
                local: bareName,
                kind: 'named',
            }],
        });
    }

    return imports;
}

export function extractPhpNamespaceUseImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
    const imports: ImportRef[] = [];

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'namespace_use_declaration') {
            for (const clause of node.children) {
                if (clause.type !== 'namespace_use_clause') continue;

                const fullName = clause.children.find(child => child.type === 'qualified_name' || child.type === 'name')!.text;
                const aliasName = clause.text.match(/\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i)?.[1];
                const specifier = aliasName ?? fullName.slice(fullName.lastIndexOf('\\') + 1);

                const resolved = resolvePhpNamespaceToPsr4(fullName, context);
                imports.push({
                    source: resolved ?? fullName,
                    specifiers: [specifier],
                    isExternal: resolved === null,
                    specifierBindings: [{
                        imported: fullName.slice(fullName.lastIndexOf('\\') + 1),
                        local: specifier,
                        kind: 'named',
                    }],
                });
            }
        }

        for (const child of node.children) {
            walk(child);
        }
    };

    walk(rootNode);
    return imports;
}

export function extractPhpRequireIncludeImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
    const imports: ImportRef[] = [];
    const requireTypes = new Set([
        'require_expression',
        'require_once_expression',
        'include_expression',
        'include_once_expression',
    ]);

    const walk = (node: Parser.SyntaxNode): void => {
        if (requireTypes.has(node.type)) {
            const resolved = resolvePhpRequireArg(node, context);
            if (resolved) {
                const localDefault = assignedRequireLocalName(node);
                imports.push({
                    source: resolved,
                    specifiers: localDefault ? ['default'] : ['*'],
                    isExternal: false,
                    ...(localDefault ? {
                        specifierBindings: [{
                            imported: 'default',
                            local: localDefault,
                            kind: 'default' as const,
                        }],
                    } : {}),
                });
            }
        }

        for (const child of node.children) {
            walk(child);
        }
    };

    walk(rootNode);
    return imports;
}

export function extractLaravelConfigImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
    const importsByBinding = new Map<string, ImportRef>();

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'function_call_expression' && phpFunctionName(node) === 'config') {
            const key = firstLiteralArgument(node);
            if (key) {
                const moduleName = key.split('.')[0];
                const source = resolveLaravelConfigFile(moduleName, context);
                if (source) {
                    const local = `__laravel_config_${moduleName}`;
                    const signature = `${source}:${local}`;
                    if (!importsByBinding.has(signature)) {
                        importsByBinding.set(signature, {
                            source,
                            specifiers: ['default'],
                            isExternal: false,
                            specifierBindings: [{
                                imported: 'default',
                                local,
                                kind: 'default',
                            }],
                        });
                    }
                }
            }
        }

        for (const child of node.children) {
            walk(child);
        }
    };

    walk(rootNode);
    return [...importsByBinding.values()];
}

function assignedRequireLocalName(node: Parser.SyntaxNode): string | null {
    const parent = node.parent;
    if (parent?.type !== 'assignment_expression') return null;
    const eqIndex = parent.children.findIndex(child => child.text === '=');
    if (eqIndex <= 0) return null;
    const left = parent.children[eqIndex - 1];
    return left?.type === 'variable_name' ? left.text.replace(/^\$/, '') : null;
}

function resolveLaravelConfigFile(moduleName: string, context: ImportContext): string | null {
    if (!/^[A-Za-z0-9_.-]+$/.test(moduleName)) return null;

    const direct = path.posix.normalize(`config/${moduleName}.php`);
    if (context.allFilePaths.has(direct)) return direct;

    const currentDir = path.posix.dirname(context.filePath);
    const ancestorCandidates: string[] = [];
    for (let dir = currentDir; dir && dir !== '.'; dir = path.posix.dirname(dir)) {
        ancestorCandidates.push(path.posix.normalize(path.posix.join(dir, 'config', `${moduleName}.php`)));
        if (path.posix.dirname(dir) === dir) break;
    }
    for (const candidate of ancestorCandidates) {
        if (context.allFilePaths.has(candidate)) return candidate;
    }

    const suffix = `/config/${moduleName}.php`;
    const monorepoMatches = [...context.allFilePaths]
        .filter(filePath => filePath === direct || filePath.endsWith(suffix))
        .map(filePath => ({
            filePath,
            score: commonPathPrefixLength(filePath, context.filePath),
        }))
        .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

    if (monorepoMatches.length === 0) return null;
    if (monorepoMatches.length > 1 && monorepoMatches[0].score === monorepoMatches[1].score) return null;
    return monorepoMatches[0].filePath;
}

function commonPathPrefixLength(left: string, right: string): number {
    const leftParts = left.split('/');
    const rightParts = right.split('/');
    let score = 0;
    while (score < leftParts.length && score < rightParts.length && leftParts[score] === rightParts[score]) {
        score++;
    }
    return score;
}

function firstLiteralArgument(callNode: Parser.SyntaxNode): string | null {
    const args = callNode.childForFieldName('arguments')
        ?? callNode.children.find(child => child.type === 'arguments');
    if (!args) return null;

    const firstArg = args.children.find(child => child.type === 'argument');
    const value = firstArg
        ? firstArg.children.find(child => !['(', ')', ',', ':'].includes(child.text))
        : null;
    if (!value) return null;
    if (value.type !== 'string' && value.type !== 'encapsed_string') return null;
    if (value.children.some(child => child.type === 'variable_name' || child.type === 'encapsed_string_part')) return null;

    const raw = extractStringLiteralValueRaw(value.text);
    if (!raw || raw.includes('${')) return null;
    return raw;
}

function phpFunctionName(node: Parser.SyntaxNode): string | null {
    return node.children.find(child =>
        child.type === 'name'
        || child.type === 'qualified_name'
    )?.text ?? null;
}

export function resolvePhpRequireArg(node: Parser.SyntaxNode, context: ImportContext): string | null {
    const arg = node.children.find(child =>
        child.type !== 'comment'
        && child.type !== 'require_once'
        && child.type !== 'require'
        && child.type !== 'include_once'
        && child.type !== 'include',
    );
    if (!arg) return null;

    if (arg.type === 'binary_expression') {
        const left = arg.child(0);
        const right = arg.child(2);
        const isDirContext = left?.text === '__DIR__'
            || (left?.type === 'function_call_expression' && left.text.startsWith('dirname('));

        if (!isDirContext || !right) return null;

        const relativePart = extractStringLiteralValueRaw(right.text);
        if (!relativePart) return null;

        const fileDir = path.dirname(context.filePath);
        const normalized = path.posix.normalize(path.posix.join(fileDir, relativePart));
        return context.allFilePaths.has(normalized) ? normalized : null;
    }

    if (arg.type === 'string' || arg.type === 'encapsed_string') {
        const raw = extractStringLiteralValueRaw(arg.text);
        if (!raw) return null;
        if (/^vendor(?:\/|)/.test(raw)) return null;

        const fileDir = path.dirname(context.filePath);
        const normalized = path.posix.normalize(path.posix.join(fileDir, raw));
        return context.allFilePaths.has(normalized) ? normalized : null;
    }

    return null;
}

export function resolvePhpNamespaceToPsr4(namespace: string, context: ImportContext): string | null {
    for (const mapping of context.dependencyMappings) {
        const prefix = mapping.prefix.replace(/\\?$/, '\\');

        if (!namespace.startsWith(prefix)) continue;

        const relative = namespace.slice(prefix.length).replace(/\\/g, '/');
        const candidate = path.posix.normalize(
            path.posix.join(mapping.directory, `${relative}.php`),
        );
        if (context.allFilePaths.has(candidate)) {
            return candidate;
        }
    }

    return null;
}

export function extractPhpExports(rootNode: Parser.SyntaxNode): string[] {
    const exports: string[] = [];

    const walk = (node: Parser.SyntaxNode, className: string | null = null): void => {
        if (node.type === 'class_declaration'
            || node.type === 'interface_declaration'
            || node.type === 'trait_declaration'
            || node.type === 'enum_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push(nameNode.text);
                for (const child of node.children) {
                    walk(child, nameNode.text);
                }
                return;
            }
        }

        if (node.type === 'function_definition') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push(nameNode.text);
            }
        }

        if (node.type === 'const_declaration') {
            for (const element of node.children) {
                if (element.type !== 'const_element') continue;
                const nameNode = element.children.find(child => child.type === 'name');
                if (!nameNode) continue;
                exports.push(className ? `${className}.${nameNode.text}` : nameNode.text);
            }
        }

        if (node.type === 'function_call_expression') {
            const nameNode = node.children.find(child => child.type === 'name');
            if (nameNode?.text === 'define') {
                const args = node.childForFieldName('arguments')
                    ?? node.children.find(child => child.type === 'arguments');
                const firstArg = args?.children
                    .find(child => child.type === 'argument')
                    ?.children.find(child => child.type === 'string' || child.type === 'encapsed_string');
                const value = firstArg ? extractStringLiteralValueRaw(firstArg.text) : null;
                if (value) exports.push(value);
            }
        }

        for (const child of node.children) {
            walk(child, className);
        }
    };

    walk(rootNode);
    return [...new Set(exports)];
}

export function extractPhpClassPropertyAliases(rootNode: Parser.SyntaxNode): ClassPropertyAlias[] {
    const aliases: ClassPropertyAlias[] = [];

    const walkClasses = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration') {
            const body = node.childForFieldName('body');
            if (body) {
                for (const member of body.children) {
                    if (member.type !== 'property_declaration') continue;

                    let typeName: string | null = null;
                    let propName: string | null = null;

                    for (const child of member.children) {
                        if (child.type === 'named_type' || child.type === 'type_name') {
                            typeName = normalizePhpType(child.text);
                        }
                        if (child.type === 'property_element') {
                            const varNode = child.childForFieldName('name');
                            if (varNode) {
                                propName = varNode.text.replace('$', '');
                            }
                        }
                    }

                    if (typeName && propName) {
                        aliases.push({ propertyAccess: `this->${propName}`, typeName });
                    }
                }

                for (const member of body.children) {
                    if (member.type !== 'method_declaration') continue;
                    const nameNode = member.childForFieldName('name');
                    if (nameNode?.text !== '__construct') continue;

                    const parameters = member.childForFieldName('parameters')!;

                    // Promoted-property pattern (PHP 8+): the parameter has a
                    // visibility modifier so the property name == param name.
                    // Legacy pattern (PHP 5/7): the parameter has only a type,
                    // and the property is bound via `$this->X = $X;` in the
                    // constructor body. We collect both — the legacy case
                    // requires scanning the body for the assignment binding.
                    const ctorBody = member.childForFieldName('body');
                    const ctorBodyText = ctorBody?.text ?? '';

                    for (const param of parameters.children) {
                        if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter') continue;
                        const hasVisibility = param.children.some(child => child.type === 'visibility_modifier');

                        let typeName: string | null = null;
                        let paramName: string | null = null;

                        for (const child of param.children) {
                            if (child.type === 'named_type' || child.type === 'type_name') {
                                typeName = normalizePhpType(child.text);
                            }
                            if (child.type === 'variable_name') {
                                paramName = child.text.replace('$', '');
                            }
                        }

                        if (!typeName || !paramName) continue;

                        if (hasVisibility) {
                            // Promoted property: the param IS the property.
                            aliases.push({ propertyAccess: `this->${paramName}`, typeName });
                            continue;
                        }

                        // Legacy: scan the ctor body for an assignment that
                        // binds this parameter to a class property. The pattern
                        // is `$this->propName = $paramName` (single-step copy).
                        // Anchored regex: only matches when the LHS is `$this->`
                        // and the RHS is the exact parameter `$paramName` we
                        // are processing, optionally followed by `??` default.
                        const assignRegex = new RegExp(
                            String.raw`\$this->([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$` + paramName + String.raw`\b`,
                        );
                        const match = assignRegex.exec(ctorBodyText);
                        if (match) {
                            aliases.push({ propertyAccess: `this->${match[1]}`, typeName });
                        }
                    }
                }
            }
        }

        for (const child of node.children) {
            walkClasses(child);
        }
    };

    walkClasses(rootNode);
    return aliases;
}

export function extractPhpImportStatements(rootNode: Parser.SyntaxNode): string[] {
    const statements: string[] = [];

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'namespace_use_declaration') {
            statements.push(node.text.trim());
        }
        for (const child of node.children) {
            walk(child);
        }
    };

    walk(rootNode);
    return statements;
}

export function extractPhpConstructorSources(rootNode: Parser.SyntaxNode): Map<string, string> {
    const result = new Map<string, string>();

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration') {
            const nameNode = node.childForFieldName('name');
            const body = node.childForFieldName('body');
            if (nameNode && body) {
                for (const member of body.children) {
                    if (member.type !== 'method_declaration') continue;
                    const memberName = member.childForFieldName('name');
                    if (memberName?.text === '__construct') {
                        result.set(nameNode.text, member.text.trim());
                    }
                }
            }
        }

        for (const child of node.children) {
            walk(child);
        }
    };

    walk(rootNode);
    return result;
}
