import { describe, expect, it } from 'vitest';
import { hasZodiosCallsInChunk } from '../../../../../src/ingestion/processors/code-pipeline/zodios-context-builder.js';
import type { FileImportMap } from '../../../../../src/ingestion/core/import-graph.js';
import type { ZodiosIndex, ZodiosTypeIndex } from '../../../../../src/ingestion/processors/code-pipeline/zodios-context-builder.js';

function makeFileImportMap(filePath: string, imports: Array<{ source: string; specifiers: string[] }>): FileImportMap {
    return {
        filePath,
        imports: imports.map(i => ({
            source: i.source,
            specifiers: i.specifiers,
            isExternal: false,
        })),
        exportedSymbols: [],
    };
}

function makeZodiosFixtures() {
    const zodiosFilePath = 'libs/api-client/src/zodios.ts';

    const aliasMap = new Map([
        ['getQuote', { method: 'GET', path: '/api/quotes/:id' }],
        ['createQuote', { method: 'POST', path: '/api/quotes' }],
        ['updateSave', { method: 'PUT', path: '/api/saves/:id' }],
    ]);

    const zodiosIndex: ZodiosIndex = new Map([[zodiosFilePath, aliasMap]]);
    const zodiosTypeIndex: ZodiosTypeIndex = new Map([['IQuoteRepository', zodiosFilePath]]);
    const allFilePaths = new Set(['src/service.ts', zodiosFilePath]);

    return { zodiosIndex, zodiosTypeIndex, allFilePaths };
}

describe('hasZodiosCallsInChunk (Gate 7 receiver check)', () => {
    const { zodiosIndex, zodiosTypeIndex, allFilePaths } = makeZodiosFixtures();

    const importMap = makeFileImportMap('src/service.ts', [
        { source: '../libs/api-client/src/zodios', specifiers: ['IQuoteRepository'] },
    ]);

    it('detects a generated endpoint call in chunk source', () => {
        const chunkSource = `
            async handle() {
                const result = await this.quoteRepo.getQuote({ params: { id } });
                return result;
            }
        `;

        expect(hasZodiosCallsInChunk(
            chunkSource, '', importMap, allFilePaths, zodiosIndex, zodiosTypeIndex,
        )).toBe(true);
    });

    it('detects a generated endpoint call in constructor source', () => {
        const chunkSource = 'doSomething() { return null; }';
        const constructorSource = `
            constructor(private quoteRepo: IQuoteRepository) {
                this.quoteRepo.createQuote({ body: {} });
            }
        `;

        expect(hasZodiosCallsInChunk(
            chunkSource, constructorSource, importMap, allFilePaths, zodiosIndex, zodiosTypeIndex,
        )).toBe(true);
    });

    it('rejects a function that only reads properties (no call parens)', () => {
        const chunkSource = `
            getBaseUrl() {
                return this.quoteRepo.baseURL;
            }
        `;

        expect(hasZodiosCallsInChunk(
            chunkSource, '', importMap, allFilePaths, zodiosIndex, zodiosTypeIndex,
        )).toBe(false);
    });

    it('rejects a helper function with no Zodios references', () => {
        const chunkSource = `
            formatDate(date: Date) {
                return date.toISOString();
            }
        `;

        expect(hasZodiosCallsInChunk(
            chunkSource, '', importMap, allFilePaths, zodiosIndex, zodiosTypeIndex,
        )).toBe(false);
    });

    it('rejects when file has no Zodios imports', () => {
        const noImportMap = makeFileImportMap('src/other.ts', [
            { source: '../utils', specifiers: ['formatDate'] },
        ]);

        expect(hasZodiosCallsInChunk(
            'this.quoteRepo.getQuote()', '', noImportMap, allFilePaths, zodiosIndex, zodiosTypeIndex,
        )).toBe(false);
    });

    it('rejects type-only references (typeof, type annotation)', () => {
        const chunkSource = `
            type Repo = typeof IQuoteRepository;
            function getType(): IQuoteRepository { throw new Error(); }
        `;

        expect(hasZodiosCallsInChunk(
            chunkSource, '', importMap, allFilePaths, zodiosIndex, zodiosTypeIndex,
        )).toBe(false);
    });

    it('detects bracket-notation alias call', () => {
        const chunkSource = `
            async handle() {
                const result = await this.quoteRepo['getQuote']({ params: { id } });
                return result;
            }
        `;

        expect(hasZodiosCallsInChunk(
            chunkSource, '', importMap, allFilePaths, zodiosIndex, zodiosTypeIndex,
        )).toBe(true);
    });

    it('accepts createQuote (generated method, not factory)', () => {
        const chunkSource = `
            async handle() {
                return this.quoteRepo.createQuote({ body: data });
            }
        `;

        expect(hasZodiosCallsInChunk(
            chunkSource, '', importMap, allFilePaths, zodiosIndex, zodiosTypeIndex,
        )).toBe(true);
    });

    it('returns false when zodiosIndex is empty', () => {
        const emptyIndex: ZodiosIndex = new Map();

        expect(hasZodiosCallsInChunk(
            'this.repo.getQuote()', '', importMap, allFilePaths, emptyIndex, zodiosTypeIndex,
        )).toBe(false);
    });
});
