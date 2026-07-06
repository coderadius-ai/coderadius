/**
 * Phase 3 (Fix #2) — TS plugin owns parsing of `DataField.type` strings.
 *
 * Whitelist patterns: `Array<X>`, `X[]`, `Promise<X>`, `Map<K, V>`, `X | Y`.
 * Hard abort (`[]`): inline object `{...}` and TS utility types
 * (`Partial`, `Omit`, `Pick`, `Record`, ...).
 * Filters: `TS_PRIMITIVES`, `TS_BUILTIN_CLASSES`.
 */
import { describe, it, expect } from 'vitest';
import { extractTsBaseTypesFromString } from '../../../../../src/ingestion/core/languages/typescript/type-extraction.js';

describe('extractTsBaseTypesFromString — whitelist', () => {
    it('parses Array<X>', () => {
        expect(extractTsBaseTypesFromString('Array<ShipmentProposal>')).toEqual(['ShipmentProposal']);
    });
    it('parses X[]', () => {
        expect(extractTsBaseTypesFromString('User[]')).toEqual(['User']);
    });
    it('parses Promise<X>', () => {
        expect(extractTsBaseTypesFromString('Promise<User>')).toEqual(['User']);
    });
    it('parses Map<K, V> (skipping primitive K)', () => {
        expect(extractTsBaseTypesFromString('Map<string, Foo>')).toEqual(['Foo']);
    });
    it('parses union types', () => {
        expect(extractTsBaseTypesFromString('Foo | Bar')).toEqual(['Foo', 'Bar']);
    });
});

describe('extractTsBaseTypesFromString — utility types abort hard', () => {
    it('aborts on Partial<X>', () => {
        expect(extractTsBaseTypesFromString('Partial<User>')).toEqual([]);
    });
    it('aborts on Omit<X, K>', () => {
        expect(extractTsBaseTypesFromString("Omit<User, 'id'>")).toEqual([]);
    });
    it('aborts on Pick<X, K>', () => {
        expect(extractTsBaseTypesFromString("Pick<User, 'name'>")).toEqual([]);
    });
    it('aborts on Record<K, V>', () => {
        expect(extractTsBaseTypesFromString('Record<string, Foo>')).toEqual([]);
    });
    it('aborts on Required<X>', () => {
        expect(extractTsBaseTypesFromString('Required<UserInput>')).toEqual([]);
    });
    it('aborts on ReturnType<typeof fn>', () => {
        expect(extractTsBaseTypesFromString('ReturnType<typeof fn>')).toEqual([]);
    });
});

describe('extractTsBaseTypesFromString — inline object abort hard', () => {
    it('aborts on inline object type', () => {
        expect(extractTsBaseTypesFromString('{ user: User }')).toEqual([]);
    });
    it('aborts on Array<{...}>', () => {
        expect(extractTsBaseTypesFromString('Array<{ id: string }>')).toEqual([]);
    });
});

describe('extractTsBaseTypesFromString — primitive/builtin skip', () => {
    it('drops TS primitives', () => {
        expect(extractTsBaseTypesFromString('string')).toEqual([]);
        expect(extractTsBaseTypesFromString('number')).toEqual([]);
        expect(extractTsBaseTypesFromString('boolean | undefined')).toEqual([]);
    });
    it('drops TS builtin classes', () => {
        expect(extractTsBaseTypesFromString('Date')).toEqual([]);
        expect(extractTsBaseTypesFromString('Map<string, string>')).toEqual([]);
        expect(extractTsBaseTypesFromString('Promise<Date>')).toEqual([]);
        expect(extractTsBaseTypesFromString('Set<number>')).toEqual([]);
    });
    it('keeps user types nested inside a builtin container', () => {
        // Promise<User> → User survives (Promise is the container).
        expect(extractTsBaseTypesFromString('Promise<User>')).toEqual(['User']);
    });
});
