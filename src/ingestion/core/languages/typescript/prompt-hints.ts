export const TYPESCRIPT_PROMPT_HINTS = `<typescript_rules>
PROCESS vs MODULE: dynamic import() is module loading, NOT exec/spawn. Only child_process (exec, spawn, fork) = Process.

FRONTEND vs BACKEND: in .tsx/.jsx, browser APIs (document.cookie, localStorage, history.pushState, window/navigator) = client-side, has_io=false. fetch() in .tsx IS network I/O.

NESTJS/GRAPHQL BACKEND (INBOUND):
@Query(() => Type) → GRAPHQL QUERY {methodName}, direction=INBOUND, method=null.
@Mutation(() => Type) → GRAPHQL MUTATION {methodName}. @Subscription → GRAPHQL SUBSCRIPTION, method=null.
@ResolveField = nested resolver, NOT a root operation. @ObjectType/@InputType/@Field = SDL definitions, no endpoint.

GRAPHQL OTHER FRAMEWORKS (INBOUND):
Apollo/Yoga resolvers.Query.user → GRAPHQL QUERY user. GraphQL.js new GraphQLObjectType fields → GRAPHQL QUERY per field.

GRAPHQL CLIENT (OUTBOUND):
gql template → method=POST, path=GRAPHQL QUERY/MUTATION rootField. Use ROOT FIELD name, not document op name.
Alias "me: user" → emit "user". Anonymous/multi-root → skip. Introspection → skip.

DI: class properties (private api: ApiGateway) = DI services. Resolve via constructor context, not property name.

ORM/ODM:
Prisma: prisma.userProfile.findMany() → "userProfile". Drizzle: pgTable('products') → "products".
Mongoose: model('User') → "users". MongoDB: .collection('users') → "users".
TypeORM: @Entity('orders') → "orders".

MESSAGE BROKERS:
NestJS @MessagePattern('event')/@EventPattern('event') → MessageChannel. ClientProxy .send()/.emit() = producer.
BullMQ: new Queue('name') → broker name. Never use configService.get() as broker name unless literal visible.

FILE-BASED ROUTING: never emit endpoint for page.tsx/layout.tsx/loading.tsx/error.tsx. For pages/api/ and server routes, path = file path with [brackets] → {param}.

SERVER ACTIONS: 'use server' file + function → POST /_action/{functionName}, INBOUND.

tRPC: router.procedure.query → GET TRPC QUERY {name}. .mutation → POST TRPC MUTATION {name}. .subscription → SKIP.
</typescript_rules>`;
