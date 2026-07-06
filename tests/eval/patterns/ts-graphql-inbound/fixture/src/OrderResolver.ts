import { Resolver, Query, Mutation, Subscription, Args } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';

const pubSub = new PubSub();

/**
 * NestJS GraphQL resolver covering all three operation types.
 * Post Phase-1B fix: each method chunk includes its preceding @Query/@Mutation/@Subscription
 * decorator, making the operation type visible to the LLM extractor.
 */
@Resolver()
export class OrderResolver {
    @Query(() => Object)
    async order(@Args('id') id: string): Promise<Record<string, unknown>> {
        // Simulated DB: SELECT * FROM orders WHERE id = $1
        return { id, status: 'pending', items: [] };
    }

    @Mutation(() => Object)
    async createOrder(@Args('input') input: Record<string, unknown>): Promise<Record<string, unknown>> {
        // Simulated DB: INSERT INTO orders (status) VALUES ($1) RETURNING *
        const order = { id: crypto.randomUUID(), status: 'pending', ...input };
        await pubSub.publish('order.updated', { orderUpdated: order });
        return order;
    }

    @Subscription(() => Object)
    orderUpdated(): AsyncIterator<unknown> {
        return pubSub.asyncIterator('order.updated');
    }
}
