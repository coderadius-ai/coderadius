/**
 * Phase 1 (AST-first payload extraction) — TypeScript plugin emits
 * `extractTsFunctionPayloadHints` returning `{ fqcn, basename, origin }`.
 *
 * TS has no native namespace separator, so `fqcn === basename` always.
 * Built-in classes (`Date`, `Promise`, `Map`, `Set`, ...) are skipped in
 * the `new`-expression branch as noise.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { extractTsFunctionPayloadHints } from '../../../../../src/ingestion/core/languages/typescript/type-extraction.js';

function parse(source: string): Parser.SyntaxNode {
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript);
    return parser.parse(source).rootNode;
}

describe('extractTsFunctionPayloadHints', () => {
    it('emits parameter type as consumed, return type as produced', () => {
        const src = `
            class RenewalHandler {
                handle(r: RenewalRequest): ShipmentProposal {
                    return new ShipmentProposal();
                }
            }
        `;
        const hints = extractTsFunctionPayloadHints(parse(src));
        const handle = hints.get('RenewalHandler.handle');
        expect(handle).toBeDefined();
        expect(handle!.consumed).toEqual([
            { fqcn: 'RenewalRequest', basename: 'RenewalRequest', origin: 'parameter' },
        ]);
        const producedBasenames = handle!.produced.map(t => t.basename).sort();
        expect(producedBasenames).toEqual(['ShipmentProposal']);
    });

    it('emits new-expression as produced when return type is missing', () => {
        const src = `
            class Builder {
                make() {
                    return new ShipmentProposal();
                }
            }
        `;
        const hints = extractTsFunctionPayloadHints(parse(src));
        const make = hints.get('Builder.make');
        expect(make?.produced).toEqual([
            { fqcn: 'ShipmentProposal', basename: 'ShipmentProposal', origin: 'new-expression' },
        ]);
    });

    it('skips TS primitives (string, number, boolean, void, any)', () => {
        const src = `
            class Util {
                add(a: number, b: string, c: boolean): void {}
            }
        `;
        const hints = extractTsFunctionPayloadHints(parse(src));
        const add = hints.get('Util.add');
        expect(add?.consumed ?? []).toEqual([]);
        expect(add?.produced ?? []).toEqual([]);
    });

    it('skips built-in classes in new-expression (Date, Map, Promise, Set)', () => {
        const src = `
            class Service {
                build(): void {
                    const d = new Date();
                    const m = new Map<string, string>();
                    const p = new Promise<void>(() => {});
                    const s = new Set<number>();
                }
            }
        `;
        const hints = extractTsFunctionPayloadHints(parse(src));
        const build = hints.get('Service.build');
        expect(build?.produced ?? []).toEqual([]);
    });

    it('fqcn equals basename for TS (no namespace separator)', () => {
        const src = `
            interface User { id: string }
            function fetchUser(input: UserInput): User {
                return { id: '1' } as User;
            }
        `;
        const hints = extractTsFunctionPayloadHints(parse(src));
        const fn = hints.get('fetchUser');
        expect(fn).toBeDefined();
        expect(fn!.consumed[0].fqcn).toBe(fn!.consumed[0].basename);
        expect(fn!.produced[0].fqcn).toBe(fn!.produced[0].basename);
    });

    it('returns an empty map when no functions have type-hinted signatures', () => {
        const src = `
            class Empty1 {}
            function noTypes() { return; }
        `;
        const hints = extractTsFunctionPayloadHints(parse(src));
        expect(hints.size).toBe(0);
    });
});
