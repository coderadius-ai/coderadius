# order-service

Manages order lifecycle including creation, status tracking, and payment notifications.

## Architecture

- **Framework**: NestJS
- **Language**: TypeScript
- **Database**: PostgreSQL (TypeORM)
- **Messaging**: RabbitMQ (via `@MessageConsumer` decorator)

## Development Commands

```bash
# Install dependencies
npm install

# Start dev server with hot reload
npm run start:dev

# Run unit tests
npm test

# Run e2e tests
npm run test:e2e

# Lint
npm run lint
```

## Testing

All new code must include unit tests with >80% coverage.
Run `npm test -- --coverage` before opening a PR.

## Conventions

- Use `@MessageConsumer` for all RabbitMQ subscriptions — never raw `amqplib`
- DTOs must have full Zod validation
- All endpoints must be documented in `openapi.yaml`
- Database migrations via TypeORM — never `synchronize: true` in production

## Devin-specific Instructions

- Before modifying any RabbitMQ consumer, run `npm run test:integration` to verify queue contracts
- Do not change the `package.json` `name` field — it is used as the service URN in CodeRadius
- The `catalog-info.yaml` in the root is authoritative — update it if you add new dependencies
