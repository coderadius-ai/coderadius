import Parser from 'tree-sitter';

/**
 * Ensures compatibility with JavaScriptCore (Bun/Safari engine).
 *
 * tree-sitter dynamically creates AST node subclasses and assigns
 * `nodeSubclass.prototype.type = typeName`. In JSC, this throws because
 * `SyntaxNode.prototype.type` is exposed as a getter-only property.
 *
 * We patch the prototype once by adding a setter that materializes an own
 * writable `type` property on the generated subclass prototype. This keeps
 * tree-sitter's normal subclass generation intact.
 */
let didPatchSyntaxNodeType = false;

export function ensureTreeSitterJscCompat(): void {
    if (didPatchSyntaxNodeType) return;

    const syntaxNodeProto = (Parser as any).SyntaxNode?.prototype;
    if (!syntaxNodeProto) return;

    const typeDescriptor = Object.getOwnPropertyDescriptor(syntaxNodeProto, 'type');
    if (typeDescriptor?.get && !typeDescriptor.set) {
        Object.defineProperty(syntaxNodeProto, 'type', {
            get: typeDescriptor.get,
            set(value: string) {
                Object.defineProperty(this, 'type', {
                    value,
                    writable: true,
                    configurable: true,
                });
            },
            configurable: true,
        });
    }

    didPatchSyntaxNodeType = true;
}

export function patchLanguage(language: unknown): Parser.Language {
    ensureTreeSitterJscCompat();
    return language as Parser.Language;
}
