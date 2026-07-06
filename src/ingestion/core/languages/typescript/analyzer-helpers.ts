import type Parser from 'tree-sitter';

export function extractTypeScriptImportStatements(rootNode: Parser.SyntaxNode): string[] {
    const statements: string[] = [];
    for (const child of rootNode.children) {
        if (child.type === 'import_statement') {
            statements.push(child.text.trim());
        }
    }
    return statements;
}

export function extractTypeScriptConstructorSources(rootNode: Parser.SyntaxNode): Map<string, string> {
    const result = new Map<string, string>();

    const walk = (node: Parser.SyntaxNode) => {
        if (node.type === 'class_declaration' || node.type === 'class') {
            const nameNode = node.childForFieldName('name');
            const body = node.childForFieldName('body');
            if (nameNode && body) {
                for (const member of body.children) {
                    if (member.type !== 'method_definition') continue;
                    const memberName = member.childForFieldName('name');
                    if (memberName?.text === 'constructor') {
                        result.set(nameNode.text, member.text.trim());
                    }
                }
            }
        }

        for (const child of node.children) walk(child);
    };

    walk(rootNode);
    return result;
}

export function extractTypeScriptFileConstants(rootNode: Parser.SyntaxNode): Array<{ scope: string; name: string; value: string }> {
    const results: Array<{ scope: string; name: string; value: string }> = [];

    const unwrapExpression = (node: Parser.SyntaxNode): Parser.SyntaxNode => {
        if (node.type === 'parenthesized_expression') {
            const inner = node.children.find(child => child.type !== '(' && child.type !== ')');
            return inner ? unwrapExpression(inner) : node;
        }
        return node;
    };

    const isSafeLiteral = (node: Parser.SyntaxNode): boolean => {
        node = unwrapExpression(node);
        if (node.type === 'string' || node.type === 'number') return true;
        if (node.type === 'template_string') {
            return !node.children.some(child => child.type === 'template_substitution');
        }
        return false;
    };

    const formatValue = (node: Parser.SyntaxNode): string => {
        node = unwrapExpression(node);
        if (node.type === 'string' || node.type === 'template_string') {
            const raw = node.text.replace(/^[`"']|[`"']$/g, '');
            return JSON.stringify(raw);
        }
        return node.text;
    };

    const normalizeObjectKey = (node: Parser.SyntaxNode): string | null => {
        if (
            node.type === 'property_identifier' ||
            node.type === 'identifier' ||
            node.type === 'number'
        ) {
            return node.text;
        }
        if (node.type === 'string') {
            return node.text.replace(/^[`"']|[`"']$/g, '');
        }
        return null;
    };

    const extractFallbackLiteral = (node: Parser.SyntaxNode): Parser.SyntaxNode | null => {
        node = unwrapExpression(node);
        if (node.type !== 'binary_expression') return null;

        const operator = node.children.find(child => child.text === '||' || child.text === '??');
        if (!operator) return null;

        const right = node.childForFieldName('right');
        if (!right) return null;
        const unwrappedRight = unwrapExpression(right);
        if (isSafeLiteral(unwrappedRight)) return unwrappedRight;
        return extractFallbackLiteral(unwrappedRight);
    };

    const extractObjectProperties = (objectNode: Parser.SyntaxNode, scope: string): void => {
        for (const prop of objectNode.children) {
            if (prop.type !== 'pair') continue;
            const keyNode = prop.childForFieldName('key');
            const valueNode = prop.childForFieldName('value');
            if (!keyNode || !valueNode) continue;

            const propName = normalizeObjectKey(keyNode);
            if (!propName) continue;

            const unwrappedValue = unwrapExpression(valueNode);
            if (isSafeLiteral(unwrappedValue)) {
                results.push({ scope, name: propName, value: formatValue(unwrappedValue) });
                continue;
            }

            const fallback = extractFallbackLiteral(unwrappedValue);
            if (fallback) {
                results.push({ scope, name: propName, value: formatValue(fallback) });
            }
        }
    };

    const visitLexicalDeclaration = (node: Parser.SyntaxNode): void => {
        const kindNode = node.children.find(candidate => candidate.type === 'const' || candidate.text === 'const');
        if (!kindNode) return;

        for (const declarator of node.children) {
            if (declarator.type !== 'variable_declarator') continue;
            const nameNode = declarator.childForFieldName('name');
            const valueNode = declarator.childForFieldName('value');
            if (!nameNode || !valueNode) continue;

            const unwrappedValue = unwrapExpression(valueNode);
            if (isSafeLiteral(unwrappedValue)) {
                results.push({ scope: '', name: nameNode.text, value: formatValue(unwrappedValue) });
                continue;
            }

            if (unwrappedValue.type === 'object') {
                extractObjectProperties(unwrappedValue, nameNode.text);
            }
        }
    };

    /**
     * Handles factory-pattern config exports:
     *   export default registerAs('scopeName', () => ({ key: value }))
     *   export default defineConfig(() => ({ key: value }))
     *
     * Extracts the object literal from the arrow function body and uses
     * the first string argument (if any) as the scope name; otherwise
     * falls back to the factory function name itself.
     */
    const visitFactoryCallExpression = (callNode: Parser.SyntaxNode, fallbackScope?: string): void => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return;

        // Find scope name from the first string argument (e.g. 'messageBus')
        let scope = fallbackScope ?? '';
        const funcNode = callNode.childForFieldName('function');
        if (funcNode) scope = scope || funcNode.text;

        for (const arg of argsNode.children) {
            if (isSafeLiteral(arg)) {
                scope = arg.text.replace(/^['"`]|['"`]$/g, '');
                break;
            }
        }

        // Find the arrow function argument and extract its object return
        for (const arg of argsNode.children) {
            if (arg.type !== 'arrow_function') continue;
            const body = arg.childForFieldName('body');
            if (!body) continue;

            // Arrow with parenthesized expression body: () => ({ key: val })
            const unwrappedBody = unwrapExpression(body);
            if (unwrappedBody.type === 'object') {
                extractObjectProperties(unwrappedBody, scope);
                return;
            }

            // Arrow with block body: () => { return { key: val }; }
            if (body.type === 'statement_block') {
                for (const stmt of body.children) {
                    if (stmt.type !== 'return_statement') continue;
                    const retVal = stmt.children.find(c => c.type === 'object' || c.type === 'parenthesized_expression');
                    if (retVal) {
                        const unwrapped = unwrapExpression(retVal);
                        if (unwrapped.type === 'object') {
                            extractObjectProperties(unwrapped, scope);
                            return;
                        }
                    }
                }
            }
        }
    };

    for (const child of rootNode.children) {
        if (child.type === 'lexical_declaration') {
            visitLexicalDeclaration(child);
            continue;
        }
        if (child.type === 'export_statement') {
            const declaration = child.children.find(candidate => candidate.type === 'lexical_declaration');
            if (declaration) {
                visitLexicalDeclaration(declaration);
                continue;
            }

            // Handle: export default registerAs('scope', () => ({...}))
            // Handle: export default defineConfig(() => ({...}))
            const hasDefault = child.children.some(c => c.type === 'default');
            if (hasDefault) {
                const callExpr = child.children.find(c => c.type === 'call_expression');
                if (callExpr) visitFactoryCallExpression(callExpr);
            }
        }
    }

    const walkClasses = (node: Parser.SyntaxNode) => {
        if (node.type === 'class_declaration' || node.type === 'class') {
            const classNameNode = node.childForFieldName('name');
            const body = node.childForFieldName('body');
            if (classNameNode && body) {
                const className = classNameNode.text;
                for (const member of body.children) {
                    if (member.type !== 'public_field_definition') continue;

                    const hasReadonly = member.children.some(child => child.type === 'readonly');
                    const hasPrivate = member.children.some(child =>
                        child.type === 'accessibility_modifier' && child.text === 'private',
                    );
                    if (!hasReadonly && !hasPrivate) continue;

                    const nameNode = member.childForFieldName('name');
                    const valueNode = member.childForFieldName('value');
                    if (!nameNode || !valueNode || !isSafeLiteral(valueNode)) continue;
                    results.push({ scope: className, name: nameNode.text, value: formatValue(valueNode) });
                }
            }
        }

        for (const child of node.children) walkClasses(child);
    };

    walkClasses(rootNode);
    return results;
}
