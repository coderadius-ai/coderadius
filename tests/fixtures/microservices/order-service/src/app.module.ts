import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { OrderResolver } from './graphql/OrderResolver.js';

@Module({
    imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
            driver: ApolloDriver,
            typePaths: ['./schema/orders.graphql'],
            playground: false,
        }),
    ],
    providers: [OrderResolver],
})
export class AppModule {}
