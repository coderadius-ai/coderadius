import { Module } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver } from '@nestjs/apollo';
import { OrderResolver } from './Order.resolver';

@Module({
    imports: [
        GraphQLModule.forRoot({
            driver: ApolloDriver,
            autoSchemaFile: 'schema.gql',
        }),
    ],
    providers: [OrderResolver],
})
export class AppModule {}
