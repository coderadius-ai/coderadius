const INIT_ORDER_MUTATION = `
    mutation InitOrder($sku: String!, $quantity: Int!) {
        initOrder(sku: $sku, quantity: $quantity) {
            id
            status
        }
    }
`;

export async function initOrder(input: { sku: string; quantity: number }): Promise<void> {
    await fetch(process.env.ORDERS_API_URL + '/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: INIT_ORDER_MUTATION, variables: input }),
    });
}
