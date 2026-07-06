import type Parser from 'tree-sitter';
import { extractStringLiteralValue } from './shared/ast-utils.js';

export type PhpFileConstant = { scope: string; name: string; value: string };

function isSafeLiteralPhp(node: Parser.SyntaxNode): boolean {
    if (node.type === 'string' || node.type === 'integer' || node.type === 'float') {
        return true;
    }

    if (node.type === 'encapsed_string') {
        return !/\$\{/.test(node.text)
            && !node.children.some(child => child.type === 'variable_name');
    }

    return false;
}

function formatPhpValue(node: Parser.SyntaxNode): string {
    if (node.type === 'string' || node.type === 'encapsed_string') {
        return JSON.stringify(extractStringLiteralValue(node) as string);
    }
    return node.text;
}

function normalizeArrayKey(node: Parser.SyntaxNode): string | null {
    if (node.type === 'string' || node.type === 'encapsed_string') {
        const value = extractStringLiteralValue(node);
        return typeof value === 'string' ? value : null;
    }
    if (node.type === 'integer' || node.type === 'name') return node.text;
    return null;
}

function unwrapExpression(node: Parser.SyntaxNode): Parser.SyntaxNode {
    if (node.type === 'parenthesized_expression') {
        const inner = node.children.find(child => child.type !== '(' && child.type !== ')');
        return inner ? unwrapExpression(inner) : node;
    }
    return node;
}

function extractFallbackLiteralPhp(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    node = unwrapExpression(node);

    if (node.type === 'binary_expression') {
        const hasFallbackOperator = node.children.some(child => child.text === '??' || child.text === '||');
        if (!hasFallbackOperator) return null;

        const right = node.childForFieldName('right')
            ?? [...node.children].reverse().find(child => child.text !== '??' && child.text !== '||');
        if (!right) return null;

        const unwrappedRight = unwrapExpression(right);
        if (isSafeLiteralPhp(unwrappedRight)) return unwrappedRight;
        return extractFallbackLiteralPhp(unwrappedRight);
    }

    if (node.type === 'conditional_expression') {
        const hasElvis = node.children.some(child => child.text === '?')
            && node.children.some(child => child.text === ':');
        if (!hasElvis) return null;

        const right = [...node.children].reverse().find(child =>
            child.text !== ':' && child.text !== '?' && child.text !== '?:',
        );
        if (!right) return null;

        const unwrappedRight = unwrapExpression(right);
        if (isSafeLiteralPhp(unwrappedRight)) return unwrappedRight;
        return extractFallbackLiteralPhp(unwrappedRight);
    }

    return null;
}

function extractArrayConstantElements(
    arrayNode: Parser.SyntaxNode,
    scope: string,
    results: PhpFileConstant[],
): void {
    for (const element of arrayNode.children) {
        if (element.type !== 'array_element_initializer') continue;
        const keyNode = element.children[0];
        const valueNode = element.children[element.children.length - 1];
        if (!keyNode || !valueNode || keyNode === valueNode) continue;

        const key = normalizeArrayKey(keyNode);
        if (!key) continue;

        const value = unwrapExpression(valueNode);
        if (isSafeLiteralPhp(value)) {
            results.push({ scope, name: key, value: formatPhpValue(value) });
            continue;
        }

        const fallback = extractFallbackLiteralPhp(value);
        if (fallback) {
            results.push({ scope, name: key, value: formatPhpValue(fallback) });
        }
    }
}

function extractConstElements(
    declaration: Parser.SyntaxNode,
    scope: string,
    results: PhpFileConstant[],
): void {
    for (const element of declaration.children) {
        if (element.type !== 'const_element') continue;

        const nameNode = element.children.find(child => child.type === 'name');
        const valueNode = element.childForFieldName('value') ?? element.children.find(child =>
            child.type !== 'name' && child.type !== '=',
        );

        if (!nameNode || !valueNode) continue;

        const value = unwrapExpression(valueNode);
        if (isSafeLiteralPhp(value)) {
            results.push({ scope, name: nameNode.text, value: formatPhpValue(value) });
            continue;
        }

        if (value.type === 'array_creation_expression') {
            const arrayScope = scope ? `${scope}.${nameNode.text}` : nameNode.text;
            extractArrayConstantElements(value, arrayScope, results);
        }
    }
}

export function extractPhpFileConstants(rootNode: Parser.SyntaxNode): PhpFileConstant[] {
    const results: PhpFileConstant[] = [];

    for (const child of rootNode.children) {
        if (child.type === 'const_declaration') {
            extractConstElements(child, '', results);
        }
    }

    const walkClasses = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration') {
            const classNameNode = node.childForFieldName('name');
            const body = node.childForFieldName('body');
            if (classNameNode && body) {
                for (const member of body.children) {
                    if (member.type === 'const_declaration') {
                        extractConstElements(member, classNameNode.text, results);
                    }
                }
            }
        }

        for (const child of node.children) {
            walkClasses(child);
        }
    };

    walkClasses(rootNode);
    return results;
}
