import type Parser from 'tree-sitter';

export function extractPrecedingComments(node: Parser.SyntaxNode): string {
    let comments = '';
    let curr = node.previousSibling;
    while (curr && (curr.type === 'comment' || curr.type === 'line_comment' || curr.type === 'block_comment')) {
        comments = curr.text + '\n' + comments;
        curr = curr.previousSibling;
    }
    return comments;
}

export function extractStringLiteralValue(node: Parser.SyntaxNode): string | null {
    return extractStringLiteralValueRaw(node.text);
}

export function extractStringLiteralValueRaw(raw: string): string | null {
    if (!raw || raw.length < 2) return null;
    const trimmed = raw.trim();
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
        return trimmed.slice(1, -1);
    }
    return null;
}

export function extractPhpEnvVars(node: Parser.SyntaxNode): string[] {
    const names = new Set<string>();

    const walk = (current: Parser.SyntaxNode): void => {
        if (current.type === 'function_call_expression') {
            const funcNode = current.childForFieldName('function');
            const argsNode = current.childForFieldName('arguments');
            if (funcNode?.text === 'getenv' && argsNode) {
                const firstArg = argsNode.children
                    .find(child => child.type === 'argument')
                    ?.children.find(child => child.type === 'string' || child.type === 'encapsed_string')
                    ?? argsNode.children.find(child => child.type === 'string' || child.type === 'encapsed_string');
                if (firstArg) {
                    const raw = extractStringLiteralValue(firstArg);
                    if (raw) names.add(raw);
                }
            }
        }

        if (current.type === 'subscript_expression') {
            const varNode = current.children.find(child => child.type === 'variable_name');
            const indexNode = current.children.find(child => child.type === 'string' || child.type === 'encapsed_string');
            if (varNode && (varNode.text === '$_ENV' || varNode.text === '$_SERVER') && indexNode) {
                const raw = extractStringLiteralValue(indexNode);
                if (raw) names.add(raw);
            }
        }

        for (const child of current.children) {
            walk(child);
        }
    };

    walk(node);
    return [...names];
}
