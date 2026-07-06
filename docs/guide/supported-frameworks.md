# Supported Frameworks

CodeRadius builds a knowledge graph of a codebase's architecture: services, APIs, databases, and message channels. It combines three extraction methods: tree-sitter AST parsing for deterministic signals (decorators, route registrations, ORM annotations), regex-based entrypoint/connection-string detection, and LLM analysis for anything a parser can't resolve statically. This page lists what's detected for each language, framework, protocol, and infrastructure component, and by which method.

> **Note:** Missing a framework or protocol? [`coderadius.yaml`](./coderadius-yaml.md) lets you declare any pattern static analysis can't infer automatically.

---

| Status | Meaning |
|--------|---------|
| ✅ Full | Deterministic AST-level extraction with high precision. Rows marked *(eval-verified)* are pinned by committed extraction fixtures in `tests/eval/extraction/`; unmarked ✅ rows are deterministic but not yet pinned to a fixture. |
| 🟡 Partial | Core patterns supported deterministically, or detection is LLM-driven with deterministic post-validation. Advanced or dynamic patterns may need [`coderadius.yaml`](./coderadius-yaml.md) hints. |
| 📋 Planned | Not implemented. |

---

## TypeScript / JavaScript

AST-level parsing with decorator-based and convention-based (file-path) routing extraction.

| Framework | Status | Notes |
|-----------|--------|-------|
| **NestJS** | ✅ Full | Controllers, Resolvers (`@Resolver`/`@Query`/`@Mutation`/`@Subscription`), Guards (`@UseGuards`), `@MessagePattern`, `@EventPattern`, cache interceptors (`@UseInterceptors(CacheInterceptor)`) (eval-verified) |
| **Express** | ✅ Full | Route registration on apps and Routers (eval-verified). Middleware in the handler chain is tolerated, not modeled. Prefix-mounted routers (`app.use('/api', router)`) resolve without the mount prefix. |
| **Fastify** | ✅ Full | Route registration via shorthand and `app.route({method, url})` object form (eval-verified). The `schema` option is not read. |
| **Hono** | ✅ Full | Route registration (eval-verified). Route-group mounting (`app.route('/prefix', subApp)`) not yet prefix-resolved. |
| **Koa** | ✅ Full | Router-based route registration (eval-verified) |
| **Next.js** | 🟡 Partial | App Router (`app/**/route.ts`) and Pages Router (`pages/api/**`) file-convention routes; server actions extracted as routes. Page-level data fetching not traced. |
| **SvelteKit** | 🟡 Partial | File-convention routes (`src/routes/**/+server.ts`) |
| **Nuxt** | 🟡 Partial | File-convention routes (`server/routes/**`) |
| **Apollo Server** | 🟡 Partial | `@Resolver`, `@Query`, `@Mutation`, `@Subscription`. Client-side operations traced as outbound dependencies. |
| **routing-controllers / tsoa / inversify-express-utils / Ts.ED / type-graphql** | 🟡 Partial | Decorator routing recognized by the same signal extractor as NestJS (`@JsonController`, `@Route`, etc.) |

**Also detected:** TypeORM `@Entity`/`EntitySchema` (eval-verified), MikroORM, sequelize-typescript, Mongoose/Typegoose/`@nestjs/mongoose`, Drizzle `pgTable`/`mysqlTable`/`sqliteTable` entities; Bull/BullMQ `@Processor`/`@Process` queue consumers, CQRS handlers, `@Cron`/`@Interval`/`@Timeout` scheduled jobs, nest-commander CLI entrypoints; capability decorators for auth, rate-limit, cache, and transactional boundaries; typed API clients via Zodios and urql.

---

## PHP

AST-level parsing with support for PHP 8 attributes, legacy DocBlock annotations, and convention-based routing.

| Framework | Status | Notes |
|-----------|--------|-------|
| **Symfony** | ✅ Full | `#[Route]` attributes and legacy `@Route` annotations (class prefix + method), Messenger handlers (`#[AsMessageHandler]` and legacy `__invoke(TypedMessage)`), Doctrine ORM entities (eval-verified) |
| **Slim** | ✅ Full | Route registration via `$app`, route groups with prefix concatenation (eval-verified) |
| **Laravel** | ✅ Full | `Route::get/post/...`, `Route::resource`, `Route::apiResource`, `Route::match`, `Route::any`, Eloquent models (eval-verified). Complex facade-based calls may benefit from `coderadius.yaml` hints. |
| **API Platform** | 🟡 Partial | `#[ApiResource]` default REST surface (collection + item CRUD) derived from the class name. Custom `operations`/`uriTemplate` not parsed. GraphQL operations surfaced via an LLM hint only. |
| **Lumen** | 🟡 Partial | Route registration via `$router`. Shares Laravel's facade-resolution limitations. |
| **CodeIgniter 4** | 🟡 Partial | Route registration |
| **WordPress** | 🟡 Partial | REST routes (`register_rest_route` → `/wp-json/...`), AJAX hooks (`wp_ajax_*`) |
| **Hyperf / Swoole** | 🟡 Partial | `#[GetMapping]`, `#[Controller]` attributes |
| **Phalcon** | 🟡 Partial | `#[Get]` attributes, action-method convention |
| **Yii 2** | 🟡 Partial | `actionXxx()` method convention |
| **Legacy filesystem routing** | 🟡 Partial | Plain PHP files under a web root treated as implicit routes |

---

## Python

No static route extractor. AST parsing covers functions, imports, and env vars. Routes and ORM models are detected via LLM analysis; a deterministic path validator (`validateInboundPath`) checks the result and accommodates framework-specific path styles (e.g. Django's optional leading slash).

| Framework | Status | Notes |
|-----------|--------|-------|
| **FastAPI** | 🟡 Partial | Route decorators (`@app.get/post`) detected via LLM analysis with deterministic path validation. App entrypoint detection (`FastAPI(`, `uvicorn.run(`) is regex-based. Committed `openapi.yaml` specs cross-referenced like any other repo. |
| **Flask** | 🟡 Partial | Route decorators (`@app.route`) detected via LLM analysis with deterministic path validation. `Flask(` entrypoint detection is regex-based. Blueprints and `url_for` are not specifically modeled. |
| **Django** | 🟡 Partial | Service/entrypoint detection via `DJANGO_SETTINGS_MODULE` / `django.core.` regexes. Routes and ORM models extracted via LLM (Django's path style is accommodated in validation). No deterministic `urls.py` parsing, no class-based-view handling. |
| **Celery** | 🟡 Partial | `task.delay()` / `apply_async()` / `send_task()` recognized as MessageChannel publishes; `@app.task` / `@shared_task` / `@celery.task` consumers detected via LLM prompt contract |

---

## Go

No static route extractor. Framework recognition is an entrypoint regex (for service classification) plus LLM-driven handler and path detection, checked by the same deterministic path validator used for Python.

| Framework | Status | Notes |
|-----------|--------|-------|
| **Gin** | 🟡 Partial | Handler detection via LLM analysis + deterministic path validation. `gin.Default(`/`gin.New(` is the service-classification entrypoint signal. |
| **Fiber** | 🟡 Partial | Same mechanism. `fiber.New(` is the entrypoint signal. |
| **`net/http`** | 🟡 Partial | Same mechanism. `http.ListenAndServe(` is the entrypoint signal. |

Path validation also accommodates Echo, gorilla/mux, and chi route styles; these frameworks have no dedicated entrypoint signal yet. Route groups and middleware are not modeled for any Go router.

---

## Java

Deterministic route extraction from annotations. No cross-file value resolution, DI/bean tracing, or critical-invocation extraction yet. The plugin is a route-extraction bootstrap, not a full semantic layer.

| Framework | Status | Notes |
|-----------|--------|-------|
| **Spring Boot** | ✅ Full | `@RestController`/`@Controller` classes, `@RequestMapping` class-level prefixes, `@GetMapping`-family + `@RequestMapping(method=...)` method routes, `@Value("${...}")` env-key extraction (eval-verified). Route extraction is deterministic; deeper semantic hooks are not yet implemented. |
| **JAX-RS / Quarkus / Jakarta REST** | ✅ Full | `@Path` class prefix + `@GET/@POST/@PUT/@PATCH/@DELETE` + method-level `@Path` (including `{id:\d+}` regex constraint stripping). Annotations are matched by simple name regardless of package, so Quarkus and Jakarta REST work without extra code. Not yet eval-pinned. |

---

## In Development

No language plugin exists yet for these (`core/languages/registry.ts` currently registers TypeScript, PHP, Python, Go, Java). No route, ORM, or infra extraction until a plugin lands.

| Language | Framework | Status |
|----------|-----------|--------|
| **C#** | ASP.NET Core | 📋 Planned |
| **Ruby** | Rails | 📋 Planned |

---

## API Patterns & Protocols

| Protocol | Status | Notes |
|----------|--------|-------|
| **REST APIs** | ✅ Full | Auto-discovered from framework decorators, route registrations, and OpenAPI specs |
| **OpenAPI / Swagger** | ✅ Full | `openapi.yaml`, `swagger.json` files parsed and cross-referenced with code |
| **GraphQL** | ✅ Full | Server-side schema extraction (`.graphql`/`.gql` SDL, resolvers). Client-side operations traced as outbound dependencies. |
| **Avro** | ✅ Full | `.avsc` schema files parsed into `DataStructure`/`DataField` nodes |
| **gRPC** | 🟡 Partial | `@grpc/grpc-js`/`grpc` are recognized I/O packages; `grpc.NewServer(` is a Go service-entrypoint signal; Go prompt hints extract client calls as ExternalAPI and server methods as emergent endpoints. `.proto` file parsing not yet implemented. |

---

## Databases

CodeRadius detects which databases a service communicates with via ORM configurations, table/collection names extracted from SQL and ORM call sites, and connection endpoint detection in environment files. Credentials are never read or stored. Connection strings are parsed but the user/password fields are deliberately discarded.

| Database | Status | Notes |
|----------|--------|-------|
| **PostgreSQL** | ✅ Full | ORM configs including TypeORM `ormconfig.{ts,js,json}` and Doctrine `doctrine.yaml` via dedicated config-aware plugins. Prisma/SQLAlchemy connection strings are picked up by the generic env-var/DSN scanner, not by ORM-config parsing. Table names extracted from SQL/ORM literals via LLM analysis. |
| **MySQL / MariaDB** | ✅ Full | Same detection path as PostgreSQL |
| **MongoDB** | 🟡 Partial | Collection names from `model()` and `.collection()` calls (Mongoose, native driver). Endpoint detection via env files. |
| **SQLite** | 🟡 Partial | ORM-based detection (Drizzle `sqliteTable`); `sqlite3`/`better-sqlite3` imports gate files into analysis. Limited raw query tracing. |
| **Redis** | 🟡 Partial | `redis`/`ioredis`/`memcached` clients classified as Cache; usage patterns surfaced via LLM analysis. Key-level tracing not supported. |
| **Neo4j** | 🟡 Partial | `neo4j-driver` import recognized as datastore I/O |
| **Cassandra** | 🟡 Partial | `cassandra-driver` import recognized as datastore I/O |
| **Couchbase** | 🟡 Partial | `couchbase` import recognized as datastore I/O |
| **Elasticsearch / OpenSearch** | 🟡 Partial | `@elastic/elasticsearch`, `@opensearch-project/opensearch` recognized as datastore I/O |
| **InfluxDB** | 🟡 Partial | `@influxdata/influxdb-client`, `influx` recognized as datastore I/O |
| **Vector databases** (Pinecone, Chroma, Qdrant, Weaviate, Milvus) | 🟡 Partial | Client imports recognized as datastore I/O |
| **Supabase / libSQL** | 🟡 Partial | `@supabase/supabase-js`, `@libsql/client` recognized as datastore I/O |
| **Query builders / ORMs** (knex, kysely, slonik, sequelize, mikro-orm) | 🟡 Partial | Recognized as datastore I/O imports; routed to whichever database they're configured against |

---

## Message Brokers

CodeRadius models messaging across **three ontological layers** so blast radius, governance, and lineage stay correct even on multi-cluster deployments:

- **MessageBroker**: physical broker instance (cluster, host, vhost, region, env). Identity is fingerprinted on `(provider:host:port:vhost)` so two clusters with the same nominal name stay distinct.
- **MessageChannel** with `scope ∈ {logical, physical, transport}`: `logical` is the business event (e.g. `OrderCreated`), `physical` is the broker address (e.g. exchange `acme.orders` on `rmq-prod-eu`), and `transport` is the Symfony Messenger / Mass Transit / Spring-Cloud wrapper around an underlying physical channel.
- **Edges**: `(LogicalChannel)-[:MANIFESTS_AS]->(PhysicalChannel)`, `(TransportChannel)-[:BACKED_BY]->(PhysicalChannel)`, `(MessageChannel)-[:HOSTED_ON]->(MessageBroker)`, `(MessageChannel)-[:ROUTES_TO {bindingKey, isPattern, patternRegex}]->(MessageChannel)`, and `(MessageChannel)-[:DEAD_LETTERS_TO]->(MessageChannel)`.

Two safety rules are non-negotiable: **strict broker isolation** (channels on different brokers are never merged, or "welded", heuristically) and **user-declared mirrors only** (Shovel / Federation / MirrorMaker convergence requires an explicit `message_channels.mirrors[]` block in `coderadius.yaml`).

### Provider matrix

| Broker | Status | Discovery | Notes |
|--------|--------|-----------|-------|
| **RabbitMQ (AMQP)** | ✅ Full | structural + code | `rabbitmq-definitions.json` parsed for exchanges/queues/bindings, with topic-pattern regex compilation for `*`/`#`. `rabbitmq.conf` presence registers the broker instance only; its contents aren't parsed. Publisher/consumer call sites extracted via LLM. |
| **Symfony Messenger** | ✅ Full | structural + code | `config/packages/messenger.yaml` parsed for transports + routing. Emits a meta-broker plus `MANIFESTS_AS` edges from each `MessageClass` to its routed transport(s), and `BACKED_BY` to the underlying AMQP/Doctrine/Redis/SQS channel. Modern `#[AsMessageHandler]` and legacy `__invoke` patterns both supported. |
| **Google Cloud Pub/Sub** | ✅ Full | structural + code | Topic/subscription declarations via configurable Crossplane CRD kinds. Subscription filters, when extracted from consumer code, are stored on the consumer's `LISTENS_TO` edge. The structural subscription→topic `ROUTES_TO` edge does not carry the filter. |
| **Kafka** | 🟡 Partial | code | Code-level publisher/consumer detection via `kafkajs`, `@upstash/kafka`, client libraries like `node-rdkafka`/`confluent-kafka-python` (tech-inference regex). Structural extraction from `server.properties` / AsyncAPI is planned. |
| **AWS SQS / SNS** | 🟡 Partial | code | Code-level detection via `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, `sqs-consumer`. CloudFormation/Terraform topology parsing is planned. |
| **Azure Service Bus** | 🟡 Partial | code | Code-level detection via `@azure/service-bus`. ARM/Bicep parsing planned. |
| **NATS** | 🟡 Partial | code | Code-level detection via the `nats` import (TS) and PHP NATS client markers. Config parsing planned. |
| **Bull / BullMQ** | 🟡 Partial | code | Redis-backed queues classified as MessageChannels from `bull`/`bullmq` imports |
| **Apache Pulsar** | 🟡 Partial | code | Endpoint detection via `PULSAR_URL` env var / `pulsar://` connection strings. No client-SDK call-site detection yet. |
| **STOMP** | 🟡 Partial | code | `stompjs` recognized as a messaging I/O import |
| **Temporal** | 🟡 Partial | code | `@temporalio/client` recognized as a messaging I/O import |
| **AWS EventBridge** | 🟡 Partial | code | `@aws-sdk/client-eventbridge` recognized as a messaging I/O import |
| **Redis Streams** | 🟡 Partial | code | `redis`/`ioredis` imports gate files into LLM analysis, which may surface stream usage. No deterministic stream-command detection. |
| **MQTT / Mosquitto** | 🟡 Partial | code | `mqtt` client import gates files into LLM analysis for topic-level pub/sub. Broker config (`mosquitto.conf`) parsing planned. |
| **Laminas** | 🟡 Partial | structural | Laminas Messenger config parsed for message routing; Laminas RabbitMQ config parsed for exchanges/queues |
| **ZeroMQ** | 📋 Planned | none | Declarable as a broker provider via `coderadius.yaml` only. No code-level socket detection exists. |

Brokers not auto-detected can also be declared explicitly in `coderadius.yaml` under `messageBrokers`, with an optional fingerprint override for cases where host/port/vhost can't be inferred from config.

### Custom decorator support

NestJS broker decorators (`@MessagePattern`, `@EventPattern`, `@RabbitSubscribe`, `@RabbitRPC`, `@SqsMessageHandler`, `@SqsConsumerEventHandler`, `@Process`, `@Processor`) are recognized natively. Custom consumer decorators, configurable per repository, plug in via `coderadius.yaml`:

```yaml
decorators:
  - name: AcmeBusConsumer
    kind: message-consumer
    args: [queueName, routingKey, queue, name, topic]
```

The framework-signal extractor consults the registered decorator name (case-insensitive) and emits a `LISTENS_TO` edge with the resolved channel name (from the named arg or the first string literal). See [Custom decorator registration](./coderadius-yaml.md#decorators) and [Messaging domain model](../architecture/messaging-domain-model.md) for the full architecture.

---

## CI/CD Platforms

`cr blast` integrates with any CI system via exit codes and structured output. The table below refers to **native pipeline integration**: pre-built job templates that run the impact check and post results as a PR/MR comment automatically, without custom scripting.

| Platform | Status | Notes |
|----------|--------|-------|
| **GitHub Actions** | 🟡 Partial | Pre-built workflow template available. Impact report posted as PR comment via `--format markdown`. |
| **GitLab CI/CD** | 🟡 Partial | Pre-built pipeline template available. Impact report posted as MR note via `--format markdown`. |
| **Bitbucket Pipelines** | 🟡 Partial | Pre-built pipeline template available. Manual comment posting required. |
| **Jenkins** | 📋 Planned | Jenkinsfile integration |

---

## Configuration File Detection

CodeRadius automatically detects and extracts architectural information from configuration and build files.

| File / Pattern | Status | What is extracted |
|----------------|--------|-------------------|
| `docker-compose.yml` | ✅ Detected | Database/broker instances from known service images + env blocks (`POSTGRES_DB`, `MYSQL_DATABASE`, `MONGO_INITDB_DATABASE`); container images (`USES_IMAGE`). Network links, volume mounts, and `depends_on` topology are not extracted. |
| `Dockerfile` | ✅ Detected | Base image (including registry-qualified refs), multi-stage build stages (`FROM ... AS alias`, `--platform`) |
| `Makefile`, `GNUmakefile` | ✅ Detected | Build targets exposed as `Task` nodes |
| `package.json` | ✅ Detected | `scripts` block with task commands and precise runner detection (npm/pnpm/yarn/bun) |
| `composer.json` | ✅ Detected | `scripts` block with Composer task commands |
| `openapi.yaml`, `swagger.json` | ✅ Detected | Full endpoint and schema extraction |
| `ormconfig.{ts,js,json}`, `doctrine.yaml` | ✅ Detected | ORM datasource configuration |
| `prisma/schema.prisma` | ✅ Detected | File detected and routed to schema extraction. Model→table mapping depth depends on the LLM extraction pass. |
| `database.php`, `knexfile.*`, and other `datasource`/`orm`/`persistence`-named config files | 🟡 Partial | File presence detected and routed to schema/config extraction |
| Doctrine Migrations (`migrations/Version*.php`) | ✅ Detected | `CREATE TABLE`/`ALTER TABLE`/`RENAME ... TO` SQL statements parsed into table facts. Catches tables no live code path touches. |
| `renovate.json`, `.renovaterc` | ✅ Detected | Dependency update policy (extends, automerge, schedule) |
| `.github/dependabot.yml` | ✅ Detected | Dependency-update tool presence |
| `catalog-info.yaml` (Backstage) | ✅ Detected | Component, system, team ownership |
| `cortex.yaml` (Cortex) | ✅ Detected | Component, system, ownership (OpenAPI 3.0 + `x-cortex-*` extensions). When both a Backstage and a Cortex catalog are present, a configurable `catalogPriority` decides which one wins for a given entity. |
| `CODEOWNERS` | ✅ Detected | Ownership mapping |
| `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `prettier.config.*`, `jest.config.*`, `vitest.config.*` | ✅ Detected | Tool presence, exposed as `ToolConfig` nodes |
| `.github/workflows/*`, `.gitlab-ci.yml`, generic CI config | ✅ Detected | CI pipeline presence |
| Helm values, Kubernetes ConfigMaps | ✅ Detected | Database definitions; container images (`USES_IMAGE`) |
| Crossplane claim CRDs | ✅ Detected | GCP Pub/Sub topic/subscription declarations (CRD kinds configurable per repo) |
| `.devcontainer/devcontainer.json` | ✅ Detected | Dev environment standardization signal |
| Lockfiles (`package-lock.json`, `yarn.lock`, `composer.lock`, etc.) | ✅ Detected | Full dependency extraction into `Library` nodes, not just package-manager identification |
| `*.avsc` (Avro) | ✅ Detected | Schema extraction into `DataStructure`/`DataField` nodes |
| `*.proto` | 📋 Planned | gRPC service definitions |

---

## Package Manager Detection

CodeRadius detects the specific package manager used per project, not just the ecosystem. This is exposed as `ToolConfig` nodes in the graph and visible in the System Registry dashboard.

### JavaScript / TypeScript

Detection priority:
1. **`packageManager` field** in `package.json` (Corepack standard, e.g. `"packageManager": "pnpm@9.15.0"`)
2. **Lockfile presence** checked in the same directory, then walking up to the repo root (monorepo-aware)
3. **Fallback** to `npm`

| Lockfile / marker | Detected Package Manager |
|--------------------|--------------------------|
| `pnpm-lock.yaml`, `pnpm-workspace.yaml` | ✅ Detected pnpm |
| `yarn.lock`, `.yarnrc.yml` | ✅ Detected yarn |
| `bun.lock` / `bun.lockb` | ✅ Detected bun |
| `package-lock.json` | ✅ Detected npm |

### PHP

| Lockfile | Detected Package Manager |
|----------|--------------------------|
| `composer.lock` | ✅ Detected Composer |

### Python

| Lockfile | Detected Package Manager |
|----------|--------------------------|
| `poetry.lock` | ✅ Detected Poetry |
| `Pipfile.lock` | ✅ Detected Pipenv |
| `uv.lock` | ✅ Detected uv |
| `pdm.lock` | ✅ Detected PDM |

### Go

| Lockfile | Detected Package Manager |
|----------|--------------------------|
| `go.sum` | ✅ Detected Go Modules |

### Other manifests

`pyproject.toml` / `requirements.txt` (Python) and `pom.xml` / `build.gradle` / `build.gradle.kts` (Java) drive language and manifest detection, not package-manager identification. Python and Java don't have a single-lockfile convention the way JS/PHP/Go do.
