import { describe, expect, it } from 'vitest';
import { inferGraphQLDocumentNameFromSource } from '../../../../src/ingestion/processors/code-pipeline/interpret/api-calls.js';

describe('graph-writer GraphQL outbound fallback', () => {
    it('infers document name from inline gql query with aliased root field', () => {
        const source = `
class OrderApiClient {
    async fetchMyOrder(id: string): Promise<unknown> {
        return this.client.query({
            query: gql\`
                query GetMyOrder($id: ID!) {
                    myOrder: order(id: $id) {
                        id
                        status
                    }
                }
            \`,
            variables: { id },
        });
    }
}
`;

        expect(inferGraphQLDocumentNameFromSource(source, 'QUERY', 'order')).toBe('GetMyOrder');
    });

    it('returns undefined when root field does not match requested endpoint', () => {
        const source = `
const doc = gql\`
    query GetOrderById($id: ID!) {
        order(id: $id) {
            id
        }
    }
\`;
`;

        expect(inferGraphQLDocumentNameFromSource(source, 'QUERY', 'customer')).toBeUndefined();
    });
});
