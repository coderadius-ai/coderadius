import { describe, it, expect } from 'vitest';
import {
    interpretApiCalls,
    payloadFieldFingerprint,
    inferGraphQLDocumentNameFromSource,
    type ApiCallsInterpretContext,
    type EmergentApiCallItem,
} from '../../../src/ingestion/processors/code-pipeline/interpret/api-calls.js';

// interpretApiCalls pins the DECISION logic of persistFunction's
// emergent-API block (GraphQL/HTTP fork, gating, payload naming,
// fingerprints). It returns typed write INTENTS executed by graph-writer
// against the bespoke API mutations — the APIEndpoint dedup/welding contract
// stays on the proven write path.

function ctx(over: Partial<ApiCallsInterpretContext> = {}): ApiCallsInterpretContext {
    return {
        functionId: 'acme/inventory:src/orders.ts:createOrder',
        sourceCode: 'export async function createOrder() {}',
        isDeepScan: false,
        serviceName: 'orders-service',
        callerServiceUrn: 'cr:service:acme/inventory:orders-service',
        graphqlServerRole: true,
        ...over,
    };
}

function call(over: Partial<EmergentApiCallItem> = {}): EmergentApiCallItem {
    return { path: '/api/orders', direction: 'OUTBOUND', method: 'POST', ...over };
}

describe('interpretApiCalls — filtering', () => {
    it('drops noisy endpoints silently and dynamic paths with a DROP trace', () => {
        const { intents, traces } = interpretApiCalls(
            [call({ path: '{url}' }), call({ path: '{baseUrl}/{id}' })],
            ctx(),
        );
        expect(intents).toEqual([]);
        expect(traces.filter(t => t.action === 'DROP' && t.reason === 'dynamic API path')).toHaveLength(1);
    });
});

describe('interpretApiCalls — HTTP', () => {
    it('OUTBOUND: emits the intent with lossless-normalized + raw path', () => {
        const { intents } = interpretApiCalls(
            [call({ path: 'https://api.acme.com/v1/orders/:orderId?page=1' })],
            ctx(),
        );
        expect(intents).toEqual([{
            kind: 'http-outbound',
            method: 'POST',
            normalizedPath: '/v1/orders/{orderId}',
            rawPath: 'https://api.acme.com/v1/orders/:orderId?page=1',
            schemas: [],
        }]);
    });

    it('INBOUND: emits the intent with the resolved service; skips without service context', () => {
        const { intents } = interpretApiCalls([call({ direction: 'INBOUND', method: 'GET' })], ctx());
        expect(intents[0]).toMatchObject({ kind: 'http-inbound', method: 'GET', path: '/api/orders', serviceName: 'orders-service' });

        const skipped = interpretApiCalls([call({ direction: 'INBOUND' })], ctx({ serviceName: null }));
        expect(skipped.intents).toEqual([]);
        expect(skipped.logs.some(l => l.message.includes('no service context'))).toBe(true);
    });

    it('method defaults to POST', () => {
        const { intents } = interpretApiCalls([call({ method: undefined })], ctx());
        expect(intents[0]).toMatchObject({ method: 'POST' });
    });

    it('OUTBOUND payloads: request→produces, response→consumes, with fingerprints', () => {
        const payload = [{ name: 'orderId', type: 'string' }, { name: 'amount', type: 'number' }];
        const response = [{ name: 'status', type: 'string' }];
        const { intents, requestBodyFingerprints } = interpretApiCalls(
            [call({ payload_schema: payload, response_schema: response })],
            ctx(),
        );
        const schemas = (intents[0] as { schemas: Array<Record<string, unknown>> }).schemas;
        expect(schemas).toEqual([
            { schemaName: 'POST__api_orders_RequestBody', fields: [], link: 'produces', fingerprint: 'amount|orderId' },
            { schemaName: 'POST__api_orders_ResponseBody', fields: [], link: 'consumes', fingerprint: 'status' },
        ]);
        expect(requestBodyFingerprints).toEqual(['amount|orderId', 'status']);
    });

    it('INBOUND payloads invert the link direction: request→consumes, response→produces', () => {
        const { intents } = interpretApiCalls(
            [call({ direction: 'INBOUND', payload_schema: [{ name: 'a', type: 's' }], response_schema: [{ name: 'b', type: 's' }] })],
            ctx(),
        );
        const schemas = (intents[0] as { schemas: Array<{ link: string }> }).schemas;
        expect(schemas.map(s => s.link)).toEqual(['consumes', 'produces']);
    });

    it('deep scan materialises typed required fields; fast scan leaves them empty', () => {
        const payload = [{ name: 'orderId', type: 'string' }];
        const deep = interpretApiCalls([call({ payload_schema: payload })], ctx({ isDeepScan: true }));
        const deepSchemas = (deep.intents[0] as { schemas: Array<{ fields: unknown }> }).schemas;
        expect(deepSchemas[0].fields).toEqual([{ name: 'orderId', type: 'string', required: true }]);
    });
});

describe('interpretApiCalls — GraphQL fork', () => {
    it('INBOUND resolver behind a graphql-server role emits the gql-inbound intent', () => {
        const { intents } = interpretApiCalls(
            [call({ path: 'GRAPHQL QUERY getOrders', direction: 'INBOUND', framework: 'apollo' })],
            ctx(),
        );
        expect(intents).toEqual([{
            kind: 'gql-inbound',
            operation: 'QUERY',
            operationName: 'getOrders',
            serviceName: 'orders-service',
            framework: 'apollo',
        }]);
    });

    it('INBOUND without the graphql-server role is dropped with a DROP trace (phantom-endpoint gate)', () => {
        const { intents, traces } = interpretApiCalls(
            [call({ path: 'GRAPHQL QUERY getOrders', direction: 'INBOUND' })],
            ctx({ graphqlServerRole: false }),
        );
        expect(intents).toEqual([]);
        expect(traces.some(t => t.action === 'DROP' && t.reason.includes('no graphql-server bootstrap'))).toBe(true);
    });

    it('OUTBOUND prefers the explicit document name, else infers it from the gql template literal', () => {
        const explicit = interpretApiCalls(
            [call({ path: 'GRAPHQL MUTATION createOrder', document_operation_name: ' CreateOrderDoc ' })],
            ctx(),
        );
        expect(explicit.intents[0]).toMatchObject({ kind: 'gql-outbound', documentName: 'CreateOrderDoc' });

        const source = 'const doc = gql`mutation SubmitOrder { createOrder(input: $input) { id } }`;';
        const inferred = interpretApiCalls(
            [call({ path: 'GRAPHQL MUTATION createOrder' })],
            ctx({ sourceCode: source }),
        );
        expect(inferred.intents[0]).toMatchObject({
            kind: 'gql-outbound',
            documentName: 'SubmitOrder',
            callerServiceUrn: 'cr:service:acme/inventory:orders-service',
        });
    });
});

describe('helpers moved from graph-writer', () => {
    it('payloadFieldFingerprint sorts field names', () => {
        expect(payloadFieldFingerprint([{ name: 'b' }, { name: 'a' }])).toBe('a|b');
        expect(payloadFieldFingerprint(undefined)).toBe('');
    });

    it('inferGraphQLDocumentNameFromSource matches operation type and root field', () => {
        const source = 'const q = gql`query GetMyOrder { order(id: $id) { id } }`;';
        expect(inferGraphQLDocumentNameFromSource(source, 'QUERY', 'order')).toBe('GetMyOrder');
        expect(inferGraphQLDocumentNameFromSource(source, 'MUTATION', 'order')).toBeUndefined();
    });
});
