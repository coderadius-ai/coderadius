import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { extractTypeScriptClassPropertyAliases } from '../../../../../src/ingestion/core/languages/typescript/imports.js';

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

function parse(code: string) {
    return tsParser.parse(code).rootNode;
}

describe('Gate 5 alias filter: @Inject token with primitive type', () => {
    it('includes inject token when param type is a class', () => {
        const root = parse(`
class QuoteService {
    constructor(
        @Inject('QUOTE_REPO') private quoteRepo: IQuoteRepository,
    ) {}
}
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        const tokenAlias = aliases.find(a => a.typeName === 'QUOTE_REPO');
        expect(tokenAlias).toBeDefined();
    });

    it('excludes inject token when param type is string', () => {
        const root = parse(`
class FormService {
    constructor(
        @Inject('VEHICLE_TYPE_PATH') private vehicleTypePath: string,
    ) {}
}
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        const tokenAlias = aliases.find(a => a.typeName === 'VEHICLE_TYPE_PATH');
        expect(tokenAlias).toBeUndefined();
    });

    it('excludes inject token when param type is number', () => {
        const root = parse(`
class ConfigService {
    constructor(
        @Inject('MAX_RETRIES') private maxRetries: number,
    ) {}
}
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        const tokenAlias = aliases.find(a => a.typeName === 'MAX_RETRIES');
        expect(tokenAlias).toBeUndefined();
    });

    it('excludes inject token when param type is boolean', () => {
        const root = parse(`
class FeatureService {
    constructor(
        @Inject('FEATURE_FLAG') private enabled: boolean,
    ) {}
}
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        const tokenAlias = aliases.find(a => a.typeName === 'FEATURE_FLAG');
        expect(tokenAlias).toBeUndefined();
    });

    it('excludes inject token when param type is string[]', () => {
        const root = parse(`
class PathService {
    constructor(
        @Inject('ALLOWED_PATHS') private paths: string[],
    ) {}
}
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        const tokenAlias = aliases.find(a => a.typeName === 'ALLOWED_PATHS');
        expect(tokenAlias).toBeUndefined();
    });

    it('keeps direct type annotation (non-inject) even for interfaces', () => {
        const root = parse(`
class QuoteService {
    constructor(
        private quoteRepo: IQuoteRepository,
    ) {}
}
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        expect(aliases.find(a => a.typeName === 'IQuoteRepository')).toBeDefined();
    });

    it('includes inject token when param has no type annotation', () => {
        const root = parse(`
class QuoteService {
    constructor(
        @Inject('REPO') private repo,
    ) {}
}
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        const tokenAlias = aliases.find(a => a.typeName === 'REPO');
        expect(tokenAlias).toBeDefined();
    });

    it('includes inject token when param type is any (conservative)', () => {
        const root = parse(`
class QuoteService {
    constructor(
        @Inject('DYNAMIC') private svc: any,
    ) {}
}
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        const tokenAlias = aliases.find(a => a.typeName === 'DYNAMIC');
        expect(tokenAlias).toBeDefined();
    });
});
