import { describe, expect, it } from 'vitest';
import { TypeScriptPlugin } from '../../../../../src/ingestion/core/languages/typescript.js';
import { extractTypeScriptClassPropertyAliases } from '../../../../../src/ingestion/core/languages/typescript/imports.js';

const plugin = new TypeScriptPlugin();
const parser = plugin.createParser();

function parseRoot(source: string) {
    return parser.parse(source).rootNode;
}

describe('extractTypeScriptClassPropertyAliases — @Inject string token', () => {
    it('emits one alias for a plain constructor param with access modifier', () => {
        const root = parseRoot(`
            class Foo {
                constructor(private readonly bar: BarType) {}
            }
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        expect(aliases).toEqual([
            { propertyAccess: 'this.bar', typeName: 'BarType' },
        ]);
    });

    it('emits TWO aliases when @Inject("STRING_TOKEN") decorates the param: one for the token, one for the type annotation', () => {
        const root = parseRoot(`
            class Foo {
                constructor(@Inject('CLIENT_CLIENT') private readonly client: ClientClient) {}
            }
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        // Order: type annotation first, token second OR vice versa — assert by set membership.
        expect(aliases).toEqual(expect.arrayContaining([
            { propertyAccess: 'this.client', typeName: 'ClientClient' },
            { propertyAccess: 'this.client', typeName: 'CLIENT_CLIENT' },
        ]));
        expect(aliases).toHaveLength(2);
    });

    it('emits TWO aliases for @Inject(IDENTIFIER_TOKEN) with non-quoted identifier too', () => {
        const root = parseRoot(`
            class Foo {
                constructor(@Inject(CLIENT_CLIENT) private readonly client: ClientClient) {}
            }
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        expect(aliases).toEqual(expect.arrayContaining([
            { propertyAccess: 'this.client', typeName: 'ClientClient' },
            { propertyAccess: 'this.client', typeName: 'CLIENT_CLIENT' },
        ]));
        expect(aliases).toHaveLength(2);
    });

    it('does not emit a token alias when @Inject is absent', () => {
        const root = parseRoot(`
            class Foo {
                constructor(private readonly client: ClientClient) {}
            }
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        expect(aliases).toEqual([
            { propertyAccess: 'this.client', typeName: 'ClientClient' },
        ]);
    });

    it('handles dotted DI tokens like @Inject("CLIENT.PROVIDER")', () => {
        const root = parseRoot(`
            class Foo {
                constructor(@Inject('CLIENT.PROVIDER') private readonly client: ClientType) {}
            }
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        expect(aliases).toEqual(expect.arrayContaining([
            { propertyAccess: 'this.client', typeName: 'ClientType' },
            { propertyAccess: 'this.client', typeName: 'CLIENT.PROVIDER' },
        ]));
    });

    it('does not emit duplicate aliases when @Inject token equals type name', () => {
        // Edge case: @Inject(ClientClient) private client: ClientClient
        const root = parseRoot(`
            class Foo {
                constructor(@Inject(ClientClient) private readonly client: ClientClient) {}
            }
        `);
        const aliases = extractTypeScriptClassPropertyAliases(root);
        // Both produce the same alias — dedupe to 1.
        expect(aliases).toEqual([
            { propertyAccess: 'this.client', typeName: 'ClientClient' },
        ]);
    });
});
