/**
 * Phase 1 (AST-first payload extraction) — PHP plugin emits
 * `extractPhpFunctionPayloadHints` returning `{ fqcn, basename, origin }`
 * triples for parameter, return-type, and new-expression sites.
 *
 * Critical contract:
 *   - PHP FQCN like `\Acme\Orders\RenewalRequest` is stripped to basename
 *     `RenewalRequest` BY THE PLUGIN, so downstream matchers never have to
 *     normalize. `fqcn` keeps the original for debug/inspection.
 *   - Built-in classes (`DateTime`, `Exception`, `stdClass`, ...) are
 *     skipped in the `new-expression` branch as noise.
 *   - PHP_PRIMITIVES are filtered out (no `int`, `string`, etc.).
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { extractPhpFunctionPayloadHints } from '../../../../../src/ingestion/core/languages/php/type-extraction.js';

function parse(source: string): Parser.SyntaxNode {
    const parser = new Parser();
    parser.setLanguage(PHP.php);
    return parser.parse(source).rootNode;
}

describe('extractPhpFunctionPayloadHints', () => {
    it('emits consumed parameter and produced return-type with basename === short name', () => {
        const src = `<?php
            namespace Acme\\Orders;
            class RenewalHandler {
                public function handle(RenewalRequest $r): ShipmentProposal {
                    return new ShipmentProposal();
                }
            }
        `;
        const hints = extractPhpFunctionPayloadHints(parse(src));
        const handle = hints.get('RenewalHandler.handle');
        expect(handle).toBeDefined();

        expect(handle!.consumed).toEqual([
            { fqcn: 'RenewalRequest', basename: 'RenewalRequest', origin: 'parameter' },
        ]);
        // Return-type covers ShipmentProposal; `new ShipmentProposal()` also
        // produces it, but the plugin dedupes (same basename + same direction).
        const producedNames = handle!.produced.map(t => t.basename).sort();
        expect(producedNames).toEqual(['ShipmentProposal']);
        expect(handle!.produced[0].origin).toBeOneOf(['return-type', 'new-expression']);
    });

    it('strips PHP namespace separator from FQCN parameters', () => {
        const src = `<?php
            class Dispatcher {
                public function dispatch(\\Acme\\Orders\\RenewalRequest $r): \\Acme\\Orders\\ShipmentProposal {
                    return new \\Acme\\Orders\\ShipmentProposal();
                }
            }
        `;
        const hints = extractPhpFunctionPayloadHints(parse(src));
        const dispatch = hints.get('Dispatcher.dispatch');
        expect(dispatch).toBeDefined();

        expect(dispatch!.consumed).toEqual([
            {
                fqcn: 'Acme\\Orders\\RenewalRequest',
                basename: 'RenewalRequest',
                origin: 'parameter',
            },
        ]);
        const producedBasenames = dispatch!.produced.map(t => t.basename).sort();
        expect(producedBasenames).toEqual(['ShipmentProposal']);
        // FQCN is preserved with original namespace.
        const proposalFqcn = dispatch!.produced[0].fqcn;
        expect(proposalFqcn).toContain('Acme\\Orders\\ShipmentProposal');
    });

    it('skips primitive parameters (int, string, bool, mixed, void)', () => {
        const src = `<?php
            class Util {
                public function add(int $a, string $b, bool $c): void {}
            }
        `;
        const hints = extractPhpFunctionPayloadHints(parse(src));
        const add = hints.get('Util.add');
        expect(add?.consumed ?? []).toEqual([]);
        expect(add?.produced ?? []).toEqual([]);
    });

    it('skips built-in classes in new-expression (DateTime, Exception, stdClass)', () => {
        const src = `<?php
            class Service {
                public function build(): void {
                    $d = new \\DateTime();
                    $e = new Exception('x');
                    $s = new stdClass();
                }
            }
        `;
        const hints = extractPhpFunctionPayloadHints(parse(src));
        const build = hints.get('Service.build');
        // Return type is void → no produced from return. New-expressions
        // all targeting built-ins → no produced from new-expression.
        expect(build?.produced ?? []).toEqual([]);
    });

    it('emits new-expression as produced when return type is missing', () => {
        const src = `<?php
            class Builder {
                public function make() {
                    return new ShipmentProposal();
                }
            }
        `;
        const hints = extractPhpFunctionPayloadHints(parse(src));
        const make = hints.get('Builder.make');
        expect(make?.produced ?? []).toEqual([
            { fqcn: 'ShipmentProposal', basename: 'ShipmentProposal', origin: 'new-expression' },
        ]);
    });

    it('returns an empty map when no functions have type-hinted signatures', () => {
        const src = `<?php
            class Empty1 {}
            function noTypes() { return; }
        `;
        const hints = extractPhpFunctionPayloadHints(parse(src));
        expect(hints.size).toBe(0);
    });
});
