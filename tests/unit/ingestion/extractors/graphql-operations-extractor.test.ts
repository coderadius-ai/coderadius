import { describe, it, expect } from 'vitest';
import {
    parseGraphQLOperationsFile,
    resolveGqlLiteralReference,
    findGqlLiteralReferencesInSource,
    formatGqlOperationContext,
    type GraphQLOperationsIndex,
} from '../../../../src/ingestion/extractors/graphql-operations-extractor.js';

describe('parseGraphQLOperationsFile', () => {
    it('extracts a single named mutation', () => {
        const sdl = /* graphql */ `
            mutation CreateOrder($input: OrderInput!) {
                createOrder(input: $input) { id status }
            }
        `;
        const ops = parseGraphQLOperationsFile(sdl, 'src/Mutation/CreateOrder.gql');
        expect(ops).toEqual([
            { operationType: 'MUTATION', operationName: 'CreateOrder', rootField: 'createOrder' },
        ]);
    });

    it('extracts queries and subscriptions', () => {
        const sdl = /* graphql */ `
            query GetOrder($id: ID!) { order(id: $id) { id } }
            subscription OrderUpdates { orderUpdated { id } }
        `;
        const ops = parseGraphQLOperationsFile(sdl, 'a.gql');
        expect(ops).toHaveLength(2);
        expect(ops[0]).toMatchObject({ operationType: 'QUERY', operationName: 'GetOrder', rootField: 'order' });
        expect(ops[1]).toMatchObject({ operationType: 'SUBSCRIPTION', operationName: 'OrderUpdates', rootField: 'orderUpdated' });
    });

    it('skips anonymous operations (no name to address)', () => {
        const sdl = `mutation { createOrder(input: {}) { id } }`;
        expect(parseGraphQLOperationsFile(sdl, 'a.gql')).toEqual([]);
    });

    it('skips files containing only type definitions (pure SDL)', () => {
        const sdl = `type Query { ping: Boolean } type Mutation { noop: Boolean }`;
        expect(parseGraphQLOperationsFile(sdl, 'a.gql')).toEqual([]);
    });

    it('skips introspection root fields', () => {
        const sdl = `query Probe { __schema { types { name } } }`;
        const ops = parseGraphQLOperationsFile(sdl, 'a.gql');
        expect(ops).toEqual([]);
    });

    it('returns empty on malformed input rather than throwing', () => {
        const ops = parseGraphQLOperationsFile('mutation { not closed', 'a.gql');
        expect(ops).toEqual([]);
    });
});

function indexOf(entries: Record<string, ReturnType<typeof parseGraphQLOperationsFile>>): GraphQLOperationsIndex {
    const idx: GraphQLOperationsIndex = {
        byAbsolutePath: new Map(),
        byRelativePath: new Map(),
        byBasename: new Map(),
    };
    for (const [path, ops] of Object.entries(entries)) {
        idx.byAbsolutePath.set(path, ops);
        idx.byRelativePath.set(path, ops);
        const base = path.split('/').pop()!;
        if (idx.byBasename.has(base)) {
            // Simulate collision: drop the basename so the resolver can't use it.
            idx.byBasename.delete(base);
        } else {
            idx.byBasename.set(base, ops);
        }
    }
    return idx;
}

describe('resolveGqlLiteralReference', () => {
    const ops = parseGraphQLOperationsFile(`mutation CreateOrder($i:OrderInput!) { createOrder(input:$i) { id } }`, 'foo');
    const idx = indexOf({ 'src/Mutation/CreateOrder.gql': ops });

    it('matches by exact relative path', () => {
        expect(resolveGqlLiteralReference('src/Mutation/CreateOrder.gql', idx)).toMatchObject({ operationName: 'CreateOrder' });
    });

    it('matches by leading-slash-stripped relative path', () => {
        expect(resolveGqlLiteralReference('./src/Mutation/CreateOrder.gql', idx)).toMatchObject({ operationName: 'CreateOrder' });
    });

    it('matches by basename when unique', () => {
        expect(resolveGqlLiteralReference('CreateOrder.gql', idx)).toMatchObject({ operationName: 'CreateOrder' });
    });

    it('returns null for unknown file', () => {
        expect(resolveGqlLiteralReference('NotPresent.gql', idx)).toBeNull();
    });

    it('returns null for non-gql extensions', () => {
        expect(resolveGqlLiteralReference('something.json', idx)).toBeNull();
    });

    it('does not match basename when collisions exist', () => {
        const ops2 = parseGraphQLOperationsFile(`mutation CreateOrder($i:OrderInput!) { createOrder(input:$i){id} }`, 'foo');
        // both paths have same basename → resolver must fall back to path-only matches
        const collisionIdx = indexOf({
            'a/CreateOrder.gql': ops2,
            'b/CreateOrder.gql': ops2,
        });
        expect(resolveGqlLiteralReference('CreateOrder.gql', collisionIdx)).toBeNull();
        expect(resolveGqlLiteralReference('a/CreateOrder.gql', collisionIdx)).toMatchObject({ operationName: 'CreateOrder' });
    });
});

describe('findGqlLiteralReferencesInSource', () => {
    const ops = parseGraphQLOperationsFile(`mutation InitSave($i:Input!) { initSave(input:$i){id} }`, 'foo');
    const idx = indexOf({ 'src/Mutation/InitSave.gql': ops });

    it('finds a literal embedded in a PHP file_get_contents call', () => {
        const src = `$query = file_get_contents(__DIR__ . '/Mutation/InitSave.gql');`;
        const found = findGqlLiteralReferencesInSource(src, idx);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ operationName: 'InitSave' });
    });

    it('finds a literal in a TS import-like string', () => {
        const src = "import schema from './InitSave.gql';";
        const found = findGqlLiteralReferencesInSource(src, idx);
        expect(found).toHaveLength(1);
    });

    it('deduplicates repeated references', () => {
        const src = `'./InitSave.gql'; another('./InitSave.gql');`;
        expect(findGqlLiteralReferencesInSource(src, idx)).toHaveLength(1);
    });

    it('ignores quoted strings without a .gql extension', () => {
        const src = `'/api/v1/users'; "InitSaveSomething"; "init.json";`;
        expect(findGqlLiteralReferencesInSource(src, idx)).toEqual([]);
    });
});

describe('formatGqlOperationContext', () => {
    it('returns undefined for empty input (so no prompt block is added)', () => {
        expect(formatGqlOperationContext([])).toBeUndefined();
    });

    it('formats a single entry as a labelled block', () => {
        const out = formatGqlOperationContext([
            { operationType: 'MUTATION', operationName: 'InitSave', rootField: 'initSave' },
        ]);
        expect(out).toMatch(/Loaded GraphQL Operation Files/);
        expect(out).toMatch(/InitSave -> GRAPHQL MUTATION initSave/);
    });
});
