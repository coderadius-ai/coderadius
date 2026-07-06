import { describe, it, expect } from 'vitest';
import {
    extractZodiosAliases,
    hasZodiosDefinition,
    hasZodiosClientFactory,
    extractZodiosExportedTypes,
} from '../../src/ingestion/extractors/zodios-extractor.js';

describe('zodios-extractor', () => {
    // ─── Detection Gates ─────────────────────────────────────────────────────

    describe('hasZodiosDefinition', () => {
        it('returns true for files importing from @zodios/core with makeApi', () => {
            const source = `
import { makeApi, Zodios } from '@zodios/core'
const endpoints = makeApi([]);
`;
            expect(hasZodiosDefinition(source)).toBe(true);
        });

        it('returns false for files without makeApi', () => {
            expect(hasZodiosDefinition('import { Zodios } from "@zodios/core"')).toBe(false);
        });

        it('returns false for files with makeApi but no zodios import', () => {
            expect(hasZodiosDefinition('const x = makeApi([])')).toBe(false);
        });
    });

    describe('hasZodiosClientFactory', () => {
        it('detects createApiClient + new Zodios', () => {
            const source = `
export function createApiClient(baseUrl: string) {
    return new Zodios(baseUrl, endpoints);
}`;
            expect(hasZodiosClientFactory(source)).toBe(true);
        });

        it('returns false without both markers', () => {
            expect(hasZodiosClientFactory('const x = new Zodios()')).toBe(false);
            expect(hasZodiosClientFactory('function createApiClient() {}')).toBe(false);
        });
    });

    // ─── Alias Extraction ────────────────────────────────────────────────────

    describe('extractZodiosAliases', () => {
        it('extracts aliases from a standard Zodios definition file', () => {
            const source = `
import { makeApi, Zodios, type ZodiosOptions } from '@zodios/core'
import { z } from 'zod'

const execQuote_Body = z.object({ idOrder: z.number() }).passthrough()

const endpoints = makeApi([
    {
        method: 'post',
        path: '/api/shop/checkout/companyQuote',
        alias: 'execCompanyQuote',
        description: 'Company quote',
        requestFormat: 'text',
        parameters: [{ name: 'body', type: 'Body', schema: execQuote_Body }],
        response: z.array(z.any()),
        errors: [{ status: 400, schema: z.object({ error: z.string() }) }],
    },
    {
        method: 'post',
        path: '/api/shop/checkout/markCompanyQuote',
        alias: 'execMarkCompanyQuote',
        description: 'Mark company quote',
        requestFormat: 'text',
        parameters: [],
        response: z.array(z.any()),
    },
    {
        method: 'post',
        path: '/api/shop/checkout/quote',
        alias: 'execQuote',
        description: 'Execute quote',
        requestFormat: 'text',
        parameters: [],
        response: z.array(z.any()),
    },
    {
        method: 'patch',
        path: '/api/shop/checkout/save/:saveId',
        alias: 'execUpdateSave',
        description: 'Update save',
        requestFormat: 'json',
        parameters: [{ name: 'saveId', type: 'Path', schema: z.number() }],
        response: z.void(),
    },
])

export const api = new Zodios(endpoints)
export function createApiClient(baseUrl: string, options?: ZodiosOptions) {
    return new Zodios(baseUrl, endpoints, options)
}
`;
            const map = extractZodiosAliases(source, 'AcmeShop.repository.ts');

            expect(map.size).toBe(4);
            expect(map.get('execCompanyQuote')).toEqual({
                method: 'POST',
                path: '/api/shop/checkout/companyQuote',
            });
            expect(map.get('execMarkCompanyQuote')).toEqual({
                method: 'POST',
                path: '/api/shop/checkout/markCompanyQuote',
            });
            expect(map.get('execQuote')).toEqual({
                method: 'POST',
                path: '/api/shop/checkout/quote',
            });
            expect(map.get('execUpdateSave')).toEqual({
                method: 'PATCH',
                path: '/api/shop/checkout/save/:saveId',
            });
        });

        it('returns empty map for non-Zodios files', () => {
            const map = extractZodiosAliases(
                'export class UserService { async getUser() {} }',
                'user.service.ts',
            );
            expect(map.size).toBe(0);
        });

        it('handles makeApi with empty array', () => {
            const source = `
import { makeApi } from '@zodios/core'
const endpoints = makeApi([])
`;
            const map = extractZodiosAliases(source, 'empty.ts');
            expect(map.size).toBe(0);
        });

        it('handles single-quoted and double-quoted strings', () => {
            const source = `
import { makeApi } from '@zodios/core'
const endpoints = makeApi([
    {
        method: "get",
        path: "/api/users",
        alias: "getUsers",
        response: z.any(),
    },
])
`;
            const map = extractZodiosAliases(source, 'test.ts');
            expect(map.size).toBe(1);
            expect(map.get('getUsers')).toEqual({ method: 'GET', path: '/api/users' });
        });

        it('uppercases HTTP methods', () => {
            const source = `
import { makeApi } from '@zodios/core'
const endpoints = makeApi([
    { method: 'delete', path: '/api/items/:id', alias: 'deleteItem', response: z.void() },
])
`;
            const map = extractZodiosAliases(source, 'test.ts');
            expect(map.get('deleteItem')?.method).toBe('DELETE');
        });

        it('handles nested schemas inside parameter objects', () => {
            const source = `
import { makeApi } from '@zodios/core'
const endpoints = makeApi([
    {
        method: 'post',
        path: '/api/complex',
        alias: 'complexOp',
        parameters: [{
            name: 'body',
            type: 'Body',
            schema: z.object({
                nested: z.object({ deep: z.string() }),
                array: z.array(z.object({ id: z.number() })),
            }),
        }],
        response: z.object({ result: z.string() }),
        errors: [{
            status: 400,
            schema: z.object({ error: z.string() }),
        }],
    },
])
`;
            const map = extractZodiosAliases(source, 'complex.ts');
            expect(map.size).toBe(1);
            expect(map.get('complexOp')).toEqual({ method: 'POST', path: '/api/complex' });
        });
    });

    // ─── Type Exports ────────────────────────────────────────────────────────

    describe('extractZodiosExportedTypes', () => {
        it('extracts exported const Zodios client', () => {
            const source = `export const api = new Zodios(endpoints)`;
            expect(extractZodiosExportedTypes(source)).toContain('api');
        });

        it('extracts typeof type aliases', () => {
            const source = `
export const api = new Zodios(endpoints)
export type IAcmeShopRepository = typeof api
`;
            const types = extractZodiosExportedTypes(source);
            expect(types).toContain('api');
            expect(types).toContain('IAcmeShopRepository');
        });

        it('returns empty for non-Zodios files', () => {
            expect(extractZodiosExportedTypes('const x = 1')).toEqual([]);
        });
    });
});
