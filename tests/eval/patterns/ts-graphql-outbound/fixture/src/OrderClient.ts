import { ApolloClient, gql } from '@apollo/client';

/**
 * GraphQL client fixture — gql documents are inline in each function body.
 *
 * Constraint: the LLM sees only the function body. File-scope `const GET_X = gql\`...\``
 * would NOT be in scope (imports array contains only `import` statements, not const declarations).
 * All gql templates must therefore be inline.
 *
 * Test cases:
 *   fetchOrder     — simple OUTBOUND query,   root field = "order"
 *   fetchMyOrder   — alias ("myOrder: order"), must emit "order" NOT "myOrder"
 *   submitOrder    — mutation,                 root field = "createOrder"
 */
export class OrderApiClient {
    constructor(private readonly client: ApolloClient<unknown>) {}

    /** Simple OUTBOUND query — document_operation_name = "GetOrderById", root field = "order" */
    async fetchOrder(id: string): Promise<unknown> {
        return this.client.query({
            query: gql`
                query GetOrderById($id: ID!) {
                    order(id: $id) {
                        id
                        status
                    }
                }
            `,
            variables: { id },
        });
    }

    /**
     * Alias test: "myOrder" is an alias for root field "order".
     * LLM must emit path="GRAPHQL QUERY order", NOT "GRAPHQL QUERY myOrder".
     * document_operation_name = "GetMyOrder"
     */
    async fetchMyOrder(id: string): Promise<unknown> {
        return this.client.query({
            query: gql`
                query GetMyOrder($id: ID!) {
                    myOrder: order(id: $id) {
                        id
                        status
                    }
                }
            `,
            variables: { id },
        });
    }

    /** Mutation OUTBOUND — document_operation_name = "CreateNewOrder", root field = "createOrder" */
    async submitOrder(input: Record<string, unknown>): Promise<unknown> {
        return this.client.mutate({
            mutation: gql`
                mutation CreateNewOrder($input: CreateOrderInput!) {
                    createOrder(input: $input) {
                        id
                        status
                    }
                }
            `,
            variables: { input },
        });
    }
}
