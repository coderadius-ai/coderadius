import type Parser from 'tree-sitter';

export function extractTypeScriptEnvVars(node: Parser.SyntaxNode): string[] {
    const names = new Set<string>();

    const walk = (current: Parser.SyntaxNode): void => {
        if (current.type === 'member_expression') {
            const propNode = current.childForFieldName('property');
            const objNode = current.childForFieldName('object');

            if (propNode && objNode && objNode.type === 'member_expression') {
                const innerObj = objNode.childForFieldName('object');
                const innerProp = objNode.childForFieldName('property');

                if (
                    innerObj?.type === 'identifier' && innerObj.text === 'process' &&
                    innerProp?.text === 'env' &&
                    propNode.text.length > 0
                ) {
                    names.add(propNode.text);
                }
            }
        }

        for (const child of current.children) walk(child);
    };

    walk(node);

    const source = node.text;
    for (const match of source.matchAll(/\bprocess\.env\[\s*(['"`])([A-Z][A-Z0-9_]*)\1\s*\]/g)) {
        names.add(match[2]);
    }
    for (const match of source.matchAll(/\b(?:this\.)?(?:cfg|config|[A-Za-z_$][A-Za-z0-9_$]*config[A-Za-z0-9_$]*)(?:\??\.)get(?:OrThrow)?(?:<[^>]+>)?\(\s*(['"`])([A-Z][A-Z0-9_]*)\1/g)) {
        names.add(match[2]);
    }

    return [...names];
}
