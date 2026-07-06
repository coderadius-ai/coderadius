/**
 * Phase 3 (Fix #2) — PHP plugin owns parsing of `DataField.type` strings
 * into a list of base type names that may refer to a DataStructure.
 *
 * Skips: PHP_PRIMITIVES, PHP_BUILTIN_CLASSES. Strip namespace segments.
 */
import { describe, it, expect } from 'vitest';
import { extractPhpBaseTypesFromString } from '../../../../../src/ingestion/core/languages/php/type-extraction.js';

describe('extractPhpBaseTypesFromString', () => {
    it('parses PHP unions: `Foo|Bar`', () => {
        expect(extractPhpBaseTypesFromString('Foo|Bar')).toEqual(['Foo', 'Bar']);
    });

    it('strips nullable PHP `?Foo`', () => {
        expect(extractPhpBaseTypesFromString('?User')).toEqual(['User']);
    });

    it('parses generic-like `array<User>` and `array<string, User>`', () => {
        expect(extractPhpBaseTypesFromString('array<User>')).toEqual(['User']);
        expect(extractPhpBaseTypesFromString('array<string, User>')).toEqual(['User']);
    });

    it('parses C-style array `Foo[]`', () => {
        expect(extractPhpBaseTypesFromString('Foo[]')).toEqual(['Foo']);
    });

    it('strips namespace segments', () => {
        expect(extractPhpBaseTypesFromString('\\Acme\\Foo')).toEqual(['Foo']);
        expect(extractPhpBaseTypesFromString('Acme\\Orders\\Foo')).toEqual(['Foo']);
    });

    it('skips PHP primitives (int, string, bool, mixed, void)', () => {
        expect(extractPhpBaseTypesFromString('int|string')).toEqual([]);
        expect(extractPhpBaseTypesFromString('mixed')).toEqual([]);
        expect(extractPhpBaseTypesFromString('void')).toEqual([]);
    });

    it('skips PHP builtin classes', () => {
        expect(extractPhpBaseTypesFromString('\\DateTime')).toEqual([]);
        expect(extractPhpBaseTypesFromString('?Exception')).toEqual([]);
        expect(extractPhpBaseTypesFromString('\\stdClass')).toEqual([]);
    });

    it('mixes primitive and custom type in a union', () => {
        expect(extractPhpBaseTypesFromString('?User|null')).toEqual(['User']);
        expect(extractPhpBaseTypesFromString('string|UserInput')).toEqual(['UserInput']);
    });

    it('handles empty / null / whitespace inputs', () => {
        expect(extractPhpBaseTypesFromString('')).toEqual([]);
        expect(extractPhpBaseTypesFromString('   ')).toEqual([]);
    });
});
