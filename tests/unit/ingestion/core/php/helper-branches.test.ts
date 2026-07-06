import { describe, expect, it } from 'vitest';
import type Parser from 'tree-sitter';
import { PHPPlugin } from '../../../../../src/ingestion/core/languages/php.js';
import {
    extractPhpClassPropertyAliases,
    extractPhpNamespaceUseImports,
    normalizePhpType,
    resolvePhpNamespaceToPsr4,
    resolvePhpRequireArg,
} from '../../../../../src/ingestion/core/languages/php/imports.js';
import {
    detectOrmEntity,
    extractClassNameFromChunkName,
    extractPhpStaticInfra,
} from '../../../../../src/ingestion/core/languages/php/orm-static.js';
import { extractPhpTypeNameFromNode } from '../../../../../src/ingestion/core/languages/php/type-extraction.js';
import type { ImportContext } from '../../../../../src/ingestion/core/languages/types.js';

const plugin = new PHPPlugin();
const parser = plugin.createParser();

function parseRoot(source: string): Parser.SyntaxNode {
    return parser.parse(source).rootNode;
}

function context(
    filePath: string,
    allFilePaths: string[],
    dependencyMappings: Array<{ prefix: string; directory: string }> = [],
): ImportContext {
    return {
        filePath,
        allFilePaths: new Set(allFilePaths),
        dependencyMappings,
    };
}

describe('PHP helper branch coverage', () => {
    it('covers resolvePhpRequireArg edge branches', () => {
        const ctx = context('src/bootstrap.php', ['src/runtime.php']);

        expect(resolvePhpRequireArg({
            children: [{ type: 'require_once' }],
        } as any, ctx)).toBeNull();

        expect(resolvePhpRequireArg({
            children: [
                { type: 'require_once' },
                {
                    type: 'binary_expression',
                    child(index: number) {
                        if (index === 0) return { type: 'variable_name', text: '$base' };
                        if (index === 2) return { type: 'string', text: "'runtime.php'" };
                        return null;
                    },
                },
            ],
        } as any, ctx)).toBeNull();

        expect(resolvePhpRequireArg({
            children: [
                { type: 'require_once' },
                { type: 'string', text: 'dynamic' },
            ],
        } as any, ctx)).toBeNull();

        expect(resolvePhpRequireArg({
            children: [
                { type: 'require_once' },
                { type: 'string', text: "'vendorBundle.php'" },
            ],
        } as any, ctx)).toBeNull();
    });

    it('covers PSR-4 resolution for trailing-slash and no-slash prefixes', () => {
        const trailingSlash = context('src/Foo.php', ['src/HttpClient.php'], [{ prefix: 'App\\', directory: 'src' }]);
        expect(resolvePhpNamespaceToPsr4('App\\HttpClient', trailingSlash)).toBe('src/HttpClient.php');
        expect(resolvePhpNamespaceToPsr4('App\\Missing', trailingSlash)).toBeNull();

        const noSlash = context('src/Foo.php', ['src/Domain/User.php'], [{ prefix: 'Domain', directory: 'src/Domain' }]);
        expect(resolvePhpNamespaceToPsr4('Domain\\User', noSlash)).toBe('src/Domain/User.php');
    });

    it('covers namespace use clauses with simple non-qualified names', () => {
        const root = parseRoot(`<?php
use HttpClient;
`);

        expect(extractPhpNamespaceUseImports(root, context('index.php', []))).toEqual([
            expect.objectContaining({ source: 'HttpClient', specifiers: ['HttpClient'], isExternal: true }),
        ]);
    });

    it('covers normalizePhpType for primitive, qualified, and simple names', () => {
        expect(normalizePhpType('\\App\\Services\\Transport')).toBe('Transport');
        expect(normalizePhpType('LoggerInterface')).toBe('LoggerInterface');
        expect(normalizePhpType('bool')).toBeNull();
    });

    it('covers alias extraction when non-constructor methods are present', () => {
        const root = parseRoot(`<?php
class Handler {
    private \\App\\Services\\Transport $transport;

    public function handle() {}

    public function __construct(private \\App\\Contracts\\Logger $logger) {}
}`);

        expect(extractPhpClassPropertyAliases(root)).toEqual([
            { propertyAccess: 'this->transport', typeName: 'Transport' },
            { propertyAccess: 'this->logger', typeName: 'Logger' },
        ]);
    });

    it('covers ORM helper fallback branches and unresolved metadata passthrough', () => {
        const fakeClassNode = {
            previousSibling: null,
            children: [
                {
                    type: 'attribute_list',
                    children: [
                        { type: '#[' },
                        {
                            type: 'attribute_group',
                            children: [
                                {
                                    type: 'attribute',
                                    children: [{ type: 'name', text: 'ApiResource' }],
                                },
                            ],
                        },
                    ],
                },
            ],
        } as any;

        expect(detectOrmEntity(fakeClassNode)).toBe(true);
        expect(extractClassNameFromChunkName('App\\Entity\\Record::__class_metadata')).toBe('Record');
        expect(extractClassNameFromChunkName('::__class_metadata')).toBeNull();
        expect(extractClassNameFromChunkName('App\\Entity\\Record')).toBeNull();
        expect(extractPhpStaticInfra({
            name: 'Weird::__class_metadata',
            filepath: 'weird.php',
            sourceCode: '// ORM entity\nclass Weird',
            language: 'php',
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
        })).toBeNull();
    });

    it('covers optional type nodes without nested typed children', () => {
        expect(extractPhpTypeNameFromNode({
            type: 'optional_type',
            text: '?FooResult',
            children: [],
        } as any)).toBe('FooResult');
    });
});
