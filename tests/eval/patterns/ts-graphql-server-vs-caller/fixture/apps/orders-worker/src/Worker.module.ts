import { Module } from '@nestjs/core';
// IMPORTANT: worker imports the resolver lib only for typings (no GraphQLModule.forRoot).
// This is the EXPOSES_API leak case Fix #2 guards against.
import { OrderResolver } from '@acme/orders-resolvers';

@Module({
    providers: [OrderResolver],
})
export class WorkerModule {}
