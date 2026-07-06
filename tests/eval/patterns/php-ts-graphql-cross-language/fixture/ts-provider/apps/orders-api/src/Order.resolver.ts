import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';

class Order {
    id!: string;
    status!: string;
}

@Resolver(() => Order)
export class OrderResolver {
    @Query(() => Order, { nullable: true })
    async order(@Args('id') id: string): Promise<Order | null> {
        return null;
    }

    @Mutation(() => Order)
    async initOrder(@Args('sku') sku: string, @Args('quantity') quantity: number): Promise<Order> {
        return { id: 'ord-1', status: 'OPEN' };
    }
}
