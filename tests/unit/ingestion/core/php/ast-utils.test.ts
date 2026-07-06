import { describe, expect, it } from 'vitest';
import {
    extractPrecedingComments,
    extractStringLiteralValue,
    extractStringLiteralValueRaw,
} from '../../../../../src/ingestion/core/languages/php/shared/ast-utils.js';

describe('PHP AST utils', () => {
    it('collects line and block comments from synthetic sibling chains', () => {
        const node = {
            previousSibling: {
                type: 'line_comment',
                text: '// latest',
                previousSibling: {
                    type: 'block_comment',
                    text: '/* oldest */',
                    previousSibling: null,
                },
            },
        } as any;

        expect(extractPrecedingComments(node)).toBe('/* oldest */\n// latest\n');
    });

    it('extracts quoted string values and returns null for non-literals', () => {
        expect(extractStringLiteralValueRaw('')).toBeNull();
        expect(extractStringLiteralValueRaw("'value'")).toBe('value');
        expect(extractStringLiteralValueRaw('"value"')).toBe('value');
        expect(extractStringLiteralValueRaw('value')).toBeNull();
        expect(extractStringLiteralValue({ text: '"hello"' } as any)).toBe('hello');
    });
});
