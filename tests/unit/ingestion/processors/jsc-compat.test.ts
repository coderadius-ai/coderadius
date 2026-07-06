import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import { patchLanguage } from '../../../../src/ingestion/processors/parser/jsc-compat.js';

describe('tree-sitter JSC compatibility', () => {
    it('allows generated node subclasses to assign their type in Bun', () => {
        patchLanguage(ts.typescript);

        class DummyNode extends (Parser.SyntaxNode as typeof Parser.SyntaxNode) {}

        expect(() => {
            (DummyNode.prototype as Parser.SyntaxNode & { type: string }).type = 'dummy';
        }).not.toThrow();

        expect(Object.getOwnPropertyDescriptor(DummyNode.prototype, 'type')?.value).toBe('dummy');
    });

    it('preserves the original language object', () => {
        expect(patchLanguage(ts.typescript)).toBe(ts.typescript);
    });
});
