// Pure handler that consumes types from the resolver lib but never bootstraps a GraphQL server.
import type { Order } from '@acme/orders-resolvers';

export async function syncOrder(order: Order): Promise<void> {
    // ... outbound side-effect that has nothing to do with GraphQL
}
