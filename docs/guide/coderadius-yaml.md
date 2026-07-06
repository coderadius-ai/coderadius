# `coderadius.yaml`

`coderadius.yaml` is a per-repository config file that tells CodeRadius things static analysis can't figure out on its own: what your internal SDKs do, which physical database a table belongs to, which broker a DSN points to. It's optional. Without it, CodeRadius still analyzes your repo using built-in heuristics. You add the file only where those heuristics guess wrong.

```
your-repo/
├── src/
├── coderadius.yaml
└── package.json
```

The file is loaded once per repo, at the root, next to `.crignore`.

---

## Mental model

Every key in `coderadius.yaml` feeds exactly one of four engines:

| Engine | Deterministic? | What it changes |
|---|---|---|
| Taint propagation (AST) | yes | which functions get analyzed at all |
| Decorator extraction (tree-sitter) | yes | which functions become graph nodes without an LLM call |
| Structural / graph binding | yes | node identity: URN scope, database routing, broker identity |
| LLM semantic extraction | no | how the model interprets ambiguous code |

If a key feeds a deterministic engine, getting it right removes ambiguity permanently. If it feeds the LLM (`hints`), it's context, not a rule. The model can still misread it.

**Loading is lenient, validation is strict.** At analysis time, an invalid `coderadius.yaml` degrades to defaults with a one-line warning. A bad file never blocks `cr analyze code`. When that happens you'll see:

```
coderadius.yaml ignored (<reason>) - run 'cr validate --repo <path>'
```

`cr validate` is where errors are loud (see [Validation](#validation) below). Use it in CI; don't rely on the analyze-time warning to catch typos.

File lookup order: `coderadius.yaml`, then `coderadius.yml`. First one found wins.

---

## Section index

Eleven top-level sections, all optional:

| Section | Engine | Solves |
|---|---|---|
| [`packages`](#packages) | Taint (AST) | Force-analyze or ignore specific packages; teach the LLM about typed SDKs |
| [`decorators`](#decorators) | AST | Recognize custom framework decorators without an LLM call |
| [`databases`](#databases) | Graph | Declare database identity and table ownership |
| [`hints`](#hints) | LLM | Natural-language context for proprietary wrappers |
| [`messageBrokers`](#messagebrokers) | Structural | Anchor broker identity so DSN env-vars don't fragment it |
| [`message_channels`](#message_channels) | Graph | Alias DI names to physical channels; mirror channels across brokers; override CQRS class routing |
| [`crossplane`](#crossplane) | Structural | Map Crossplane claim CRDs to MessageChannel nodes |
| [`envAccessors`](#envaccessors) | Env scanner | See through custom env-var wrapper functions |
| [`sink_classifier`](#sink_classifier) | LLM (Layer 4 of taint) | Tune the LLM fallback sink classifier: cost, privacy, cache |
| [`services`](#services) | Graph | Control monolith vs. monorepo topology mapping |
| [`ingestion`](#ingestion) | Graph | Cap edge cardinality on wide schemas |

---

## `packages`

Controls the taint engine: which packages force analysis, which are excluded, and which typed SDKs get an auto-generated LLM hint.

### `packages.analyze`

- **Type**: array of `string | SdkPackageEntry`
- **Default**: `[]`
- **Why**: force-analyze files that import an internal I/O library the built-in heuristics don't recognize.

Entries are either a plain string (taint sink, no LLM context) or a typed object (taint sink + auto-generated hint):

```yaml
packages:
  analyze:
    # Plain string: marks as a taint sink, nothing else
    - "@acme/internal-http-client"

    # Typed entry: taint sink + auto-generated LLM hint
    - name: "@acme/notification-client"
      kind: http-client
      label: "Notification API"
      baseUrl: "https://api.notify.acme.com"

    # Broker SDK with a declared provider. Also feeds deterministic
    # broker discovery: if a file imports this package alongside a typed
    # config object, the config's host/port/vhost fields become
    # MessageBroker connection candidates regardless of variable naming.
    - name: "@acme/wire"
      kind: broker-client
      provider: rabbitmq
```

Typed entry fields:

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | (required) | required, package name |
| `kind` | `http-client \| broker-client \| db-client` | (required) | required |
| `label` | string | (optional) | optional, becomes the node name in the graph |
| `baseUrl` | string | (optional) | optional, `http-client` only |
| `provider` | `rabbitmq \| kafka \| pubsub \| sqs \| sns \| azure-service-bus \| nats \| redis-streams \| pulsar` | (optional) | optional, `broker-client` only |

`kind` semantics:

| `kind` | Tells the LLM | Emits |
|---|---|---|
| `http-client` | method calls are outbound HTTP requests | `APIEndpoint` (OUTBOUND) |
| `broker-client` | publish/emit calls are message writes | `MessageChannel` (WRITES) |
| `db-client` | read/write calls are data I/O | `DataContainer` |

A typed entry auto-generates its LLM hint from `kind`/`label`/`baseUrl`. You don't need a matching `hints` entry for the same SDK.

### `packages.ignore`

- **Type**: `string[]`
- **Default**: `[]`
- **Why**: exclude observability/logging packages that create taint false positives.

```yaml
packages:
  ignore:
    - "@datadog/browser-logs"
    - "@sentry/node"
    - "pino"
```

---

## `decorators`

- **Type**: array of decorator declarations
- **Default**: `[]`
- **Why**: recognize a custom framework decorator via tree-sitter pattern matching. No LLM call, no ambiguity.

Five `kind` values are accepted by the schema; only three do anything at ingestion time:

| `kind` | Works | Language | Emits |
|---|---|---|---|
| `message-consumer` | yes | TypeScript only | `MessageChannel` + `LISTENS_TO` |
| `graphql-client` | yes | TS + PHP | GraphQL operation node |
| `http-client` | yes | TS + PHP | `APIEndpoint` (OUTBOUND) |
| `http-route` | no-op | N/A | validates, registers nothing |
| `scheduled-job` | no-op | N/A | validates, registers nothing |

`http-route` and `scheduled-job` pass schema validation and `cr validate`, but nothing in the ingestion workflow registers them. They silently do nothing. Don't use them; there's no substitute today for custom route/cron decorators.

`message-consumer` is TypeScript-only: the decorator registry it uses lives in the TS language plugin and is never consulted by the PHP plugin. If you're on PHP/Symfony, use `graphql-client` or `http-client` instead, or reach for [`hints`](#hints).

### `message-consumer`

```yaml
decorators:
  - name: MessageConsumer
    kind: message-consumer
    args: [routingKey, queue]   # default: [routingKey, queue, name, topic]
```

Name matching is case-insensitive. Given:

```typescript
@MessageConsumer({ routingKey: 'order.created', queue: 'order-events' })
handleOrderCreated(data: OrderEvent) { ... }
```

CodeRadius creates a `MessageChannel` named `order.created` and links the function to it with `LISTENS_TO` deterministically, with no LLM call.

### `graphql-client` / `http-client`

For opaque transport wrappers where a method call hides an HTTP or GraphQL call. `name` here is a `<Class>::<method>` selector, not a decorator name:

```yaml
decorators:
  - name: "App\\Infrastructure\\Http\\InternalGateway::send"
    kind: http-client
    pathArgIndex: 0     # default 0, arg index carrying the path suffix
    httpMethod: POST    # default POST

  - name: "App\\Infrastructure\\GraphQL\\Client::query"
    kind: graphql-client
    args: [query, variables]   # default [query, variables]
```

`args` defaults to `[routingKey, queue, name, topic]` for `message-consumer`; for `graphql-client` it defaults to `[query, variables]` (the operation document arg, then the variables arg).

**Multi-repo isolation**: decorator registrations are cleared between repos in a batch run. A decorator registered while processing repo A never leaks into repo B.

---

## `databases`

- **Type**: array of database declarations
- **Default**: `[]`
- **Why**: give a `DataContainer` node a stable identity and physical technology, so two services hitting the same physical database resolve to the same node instead of two repo-scoped ones.

### The problem it solves

When CodeRadius sees `SELECT * FROM orders` with no configuration, it creates:

```
cr:datacontainer:acme/payment-service:orders
```

Scoped to the repo. Safe, but if `inventory-service` also queries `orders` against the same physical MySQL instance, you get two disconnected nodes. CodeRadius has no way to know it's one database.

```yaml
databases:
  - id: main-mysql
    technology: mysql
    tables:
      - "orders"
      - "users"
      - "wp_*"        # prefix glob
      - "*_logs"       # suffix glob

  - id: shared-pg
    technology: postgres
    shared: true       # cross-repo convergence
    tables:
      - "metrics_*"

  - id: shared-redis
    technology: redis
    # no tables → binds all Cache infrastructure regardless of table name
```

### Field reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | (required) | required, stable, becomes a URN segment, unique within the repo |
| `technology` | string | (required) | required, e.g. `mysql`, `postgres`, `mongodb`, `redis`, `s3` |
| `shared` | boolean | `false` | if `true`, the node uses the `shared` namespace instead of the repo namespace, so other repos declaring the same `id` converge onto it |
| `tables` | `string[]` | `[]` | patterns for routing tables to this database; a Redis/S3-style entry with no `tables` still binds all Cache infrastructure by technology |

### Table pattern matching

| Pattern | Matches |
|---|---|
| `orders` | exactly `orders` |
| `wp_*` | `wp_posts`, `wp_options`, … (prefix) |
| `*_logs` | `audit_logs`, `event_logs`, … (suffix) |
| `*` | everything (escape hatch) |

Case-insensitive. A table matched by no pattern falls back to the repository name as its scope. It doesn't get silently dropped, it just stays repo-local.

---

## `hints`

- **Type**: array of `{ patterns, description }`
- **Default**: `[]`
- **Why**: natural-language context for the LLM about a proprietary wrapper whose semantics can't be inferred from an import name alone.

```yaml
hints:
  - patterns: [MessageEmitterService, emitEvent]
    description: >
      Internal RabbitMQ wrapper. emit*() methods publish messages.
      Treat as WRITES to a MessageChannel.

  - patterns: [EventBusClient, publishEvent, subscribe]
    description: >
      Pub/Sub wrapper. publishEvent() first arg is the topic name.
      subscribe() first arg is the subscription name.
```

### How it actually works

`patterns` is **not a matching gate**. Every hint in the file is rendered into a single "Custom Domain Knowledge" block, built once per repo, and attached to the prompt for **every** function the LLM analyzes in that repo, regardless of whether the file imports anything matching `patterns`. Think of `patterns` as a label that helps the LLM recognize when a hint applies, not a filter that controls whether the hint is present.

The block lands in the **analysis prompt** (not a system-prompt-only guardrail section) and is truncated at 8,000 characters. It's real context injected into every call, not sandboxed instruction the model is guaranteed to obey. Keep it factual and short.

### When to use `hints` vs. other sections

| Signal | Use |
|---|---|
| Custom decorator pattern (message consumer, HTTP/GraphQL wrapper) | [`decorators`](#decorators), deterministic, no LLM |
| Package needs to be analyzed but has no special semantics | `packages.analyze` (plain string) |
| Typed SDK (HTTP/broker/DB client) with clear kind | `packages.analyze` (typed entry), deterministic hint generation |
| Proprietary wrapper with semantics too fuzzy for the above | `hints`, LLM-assisted, not guaranteed |

---

## `messageBrokers`

- **Type**: array of broker declarations
- **Default**: `[]`
- **Why**: anchor a physical broker's identity so DSN env-vars with unresolved placeholders don't fragment it across regions/environments.

CodeRadius normally infers a broker from DSN strings in config files (`messenger.yaml`, `rabbitmq-definitions.json`). When the DSN has an unresolved placeholder (`%env(RABBITMQ_URL)%`), the inferred broker gets `declaredVia: 'inferred'` and `confidence: 0.3` (good enough to exist, not enough to trust across environments). Declaring it makes it authoritative (`declaredVia: 'coderadius.yaml'`, `confidence: 1.0`).

```yaml
messageBrokers:
  - id: rmq-prod-eu
    provider: rabbitmq
    host: rabbitmq.eu-west-1.internal
    port: 5672
    vhost: /prod
    env: prod
    region: eu-west-1
    cluster: rmq-cluster-1

  - id: rmq-prod-us
    provider: rabbitmq
    host: rabbitmq.us-east-1.internal
    port: 5672
    vhost: /prod
    env: prod
    region: us-east-1
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `id` | yes | referenced from `message_channels.mirrors[].physical[].broker` |
| `provider` | yes | one of `rabbitmq`, `kafka`, `pubsub`, `sqs`, `sns`, `azure-service-bus`, `nats`, `pulsar`, `redis-streams`, `mqtt`, `mosquitto`, `zeromq`, `symfony-messenger` |
| `host` | no | hostname or IP |
| `port` | no | TCP port |
| `vhost` | no | RabbitMQ vhost or Pulsar namespace; root `/` is omitted from the URN, named vhosts are slugified |
| `region` | no | cloud region tag, surfaced on the graph |
| `env` | no | free-form label (`dev`, `staging`, `prod`) |
| `cluster` | no | logical cluster name for multiple hosts backing one cluster |
| `fingerprint` | no | overrides the computed `sha256_trunc8(provider:host:port:vhost)` identity. Only needed when two functionally distinct brokers share host+port+vhost |

### Strict broker isolation

Welding is the post-ingestion step that merges nodes discovered by different extractors when they describe the same real-world thing. Two `MessageChannel` nodes with the same name on different `brokerUrn`s are **never** welded automatically. Not by the suffix welder, not by the cross-kind welder. The only way to converge them into one logical event is an explicit `message_channels.mirrors[]` entry.

---

## `message_channels`

### `aliases`

- **Type**: array of `{ from, name, channelKind, technology?, schemaPath?, schemaFormat?, topic?, tags? }`
- **Default**: `[]`
- **Why**: map a DI/runtime logical key to the physical channel name when they differ.

```yaml
message_channels:
  aliases:
    - from: messaging.topics.order_events
      name: Acme-OrderEvents
      channelKind: topic
      technology: pubsub
```

| Field | Type | Notes |
|---|---|---|
| `from` | string | logical name as seen in code/DI |
| `name` | string | physical channel name on the broker |
| `channelKind` | `topic \| subscription \| queue \| exchange` | |
| `technology` | string | optional, broker technology |
| `schemaPath` | string | optional, local payload schema file |
| `schemaFormat` | `avro \| json-schema \| protobuf` | optional |
| `topic` | string | optional, for subscriptions: the topic they point to |
| `tags` | `string[]` | optional, free-form SDK/framework tags, default `[]` |

### `mirrors`

- **Type**: array of `{ logical, kind?, physical[] }`
- **Default**: `[]`
- **Why**: declare that one logical event manifests on multiple physical channels across brokers (RabbitMQ Shovel/Federation, Kafka MirrorMaker, SNS cross-region replication).

```yaml
message_channels:
  mirrors:
    - logical: OrderCreated
      kind: topic
      physical:
        - { broker: rmq-prod-eu, channel: acme.orders, kind: topic }
        - { broker: rmq-prod-us, channel: acme.orders, kind: topic }
```

`physical` requires at least one entry; `broker` must reference a `messageBrokers[].id`. Each mirror materializes one logical `MessageChannel{scope:'logical'}` node with a `MANIFESTS_AS` edge to every physical channel. The physical channels stay distinct nodes with distinct URNs. The logical node sits above them so a blast-radius query can answer "who consumes `OrderCreated` regardless of region?" in one hop.

Mirroring is opt-in. Without a declaration, same-name channels on different brokers stay unrelated. An `orders` test queue on a shared cluster is never confused with prod.

### `class_routes`

- **Type**: array of `{ class, routing_key }`
- **Default**: `[]`
- **Why**: override CQRS class → routing-key resolution when the PHP extractor can't statically resolve it (cross-class constants, dynamic loaders, runtime config services), leaving an LLM-emitted placeholder channel named after the class.

```yaml
message_channels:
  class_routes:
    - class: OrderPlacedEvent
      routing_key: acme.inventory.order.placed
```

Applied after PHP extraction; the YAML value always wins over what the extractor inferred.

---

## `crossplane`

- **Type**: `{ crds: CrossplaneCrd[] }`
- **Default**: `crds: []`
- **Why**: map a Crossplane claim CRD kind to the `MessageChannel` it provisions. The structural plugin ships neutral defaults for a generic pub/sub topic claim; declare your own claim kinds here to extend or override them.

```yaml
crossplane:
  crds:
    - kind: AcmeKafkaTopicClaim
      channelKind: topic
      nameField: spec.topicName
      technology: kafka

    - kind: AcmeKafkaSubscriptionClaim
      channelKind: subscription
      nameField: spec.subscriptionName
      topicField: spec.topicRef
      technology: kafka
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `kind` | string | (required) | required, exact CRD kind, must end in `Claim` |
| `channelKind` | `topic \| subscription` | (required) | required |
| `nameField` | string | (required) | required, dot-path to the channel name in the manifest |
| `topicField` | string | (optional) | for subscriptions: dot-path to the linked topic name |
| `technology` | string | `pubsub` | broker technology identifier |

A declared entry with the same `kind` as a built-in default overrides that default.

---

## `envAccessors`

- **Type**: array of `{ callee, keyArg?, defaultArg? }`
- **Default**: `[]`
- **Why**: see through a custom env-var wrapper (a docker-secrets style helper that reads `KEY_FILE` first, then falls back to `getenv(KEY)`). The lexical env scanner can't see through it because the inner `getenv` argument is dynamic. So every key read this way is invisible, and with it every database, cache, and broker your deploy manifests declare.

```yaml
envAccessors:
  - callee: 'Acme\Platform\EnvVault::fetch'
    keyArg: 0        # default 0, arg index of the env key literal
    defaultArg: 1    # optional, arg index of a literal default value
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `callee` | string | (required) | required, FQN or short name, e.g. `Acme\Platform\EnvVault::fetch` |
| `keyArg` | number | `0` | zero-based arg index holding the env key string literal |
| `defaultArg` | number | (optional) | optional, zero-based arg index holding a literal default to harvest |

What this does:

1. Every `EnvVault::fetch('SOME_KEY', ...)` call site marks `SOME_KEY` as code-referenced, so values from `.env`, docker-compose, or Helm charts survive the relevance filter.
2. When `defaultArg` is set and the argument is a string literal, the value is harvested as a lowest-priority env source at `confidence: low`. Any file-based source wins over it.

Matching is on the callee's trailing segment, so it works against both the fully-qualified form and the import-shortened form (`EnvVault::fetch(...)` after `use Acme\Platform\EnvVault;`). Member-style accessors work too. Declare `envVault.fetch` for TypeScript.

Run `cr validate --repo <path>` to see how many keys and defaults each declared accessor harvests. Defaults are masked in the output.

---

## `sink_classifier`

- **Type**: object, all fields optional with defaults
- **Default**: see below
- **Why**: tune the LLM fallback sink classifier (Layer 4 of taint analysis, the last-resort classifier for packages the deterministic layers can't place) for cost, privacy, and cache behavior.

```yaml
sink_classifier:
  mode: enabled                 # disabled | enabled | force-refresh
  bootstrap_mode: nonblocking   # blocking | nonblocking
  confidence_threshold: 0.7
  max_packages_per_batch: 200
  timeout_ms: 60000
  cache:
    backend: file
    ttl_days: 90
  budget:
    max_llm_tokens_per_run: 200000
    max_usd_per_run: 0.50
    concurrency: 2
  privacy:
    deny_patterns: ["@acme/legacy-*"]
    allow_patterns: []
    on_denied: classify_as_sink
  drift:
    alert_on_disagreement: false
    alert_threshold: 5
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `disabled \| enabled \| force-refresh` | `enabled` | two cache layers keep warm-run cost near zero: a per-repo snapshot skips classification when the dependency set hasn't changed, a per-package cross-tenant cache skips packages already classified anywhere |
| `bootstrap_mode` | `blocking \| nonblocking` | `nonblocking` | when no snapshot exists yet: `blocking` waits for the first classification, `nonblocking` proceeds with the hardcoded fallback |
| `confidence_threshold` | number (0-1) | `0.7` | |
| `max_packages_per_batch` | number | `200` | |
| `timeout_ms` | number | `60000` | |
| `cache.backend` | `file` | `file` | |
| `cache.ttl_days` | number | `90` | |
| `budget.max_llm_tokens_per_run` | number | `200000` | |
| `budget.max_usd_per_run` | number | `0.50` | |
| `budget.concurrency` | number | `2` | |
| `privacy.deny_patterns` | `string[]` | `[]` | glob patterns; matching packages never reach the LLM (the LLM only sees package names, so use this for anything proprietary or ambiguous) |
| `privacy.allow_patterns` | `string[]` | `[]` | if non-empty, only matching packages reach the LLM (most restrictive; for air-gapped/regulated tenants) |
| `privacy.on_denied` | `classify_as_sink \| classify_as_ignore \| hardcoded_only` | `classify_as_sink` | fate for a denied package |
| `drift.alert_on_disagreement` | boolean | `false` | |
| `drift.alert_threshold` | number | `5` | |

There is no model-override field. `sink_classifier` tunes budget, privacy, and cache behavior, not which LLM runs.

A repo-local kill switch also exists as an environment variable: `CODERADIUS_SINK_CLASSIFIER_MODE=disabled|enabled|force-refresh` overrides the file's `mode` without editing it.

---

## `services`

- **Type**: `{ topology?, nameOverrides?, overrides? }`
- **Default**: `topology: auto`, `nameOverrides: {}`, `overrides: {}`
- **Why**: control how catalog-discovered components (Backstage, Cortex, or autodiscovery) map to graph nodes (as one monolith `Service` with `DeploymentUnit` facets, or as independent `Service` nodes).

```yaml
services:
  topology: monolith
  nameOverrides:
    legacy-checkout: payment-service
  overrides:
    admin-worker:
      role: deployment-facet
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `topology` | `monolith \| monorepo \| auto` | `auto` | `monolith`: all components collapse into one `Service` + N `DeploymentUnit`s; `monorepo`: each component is an independent `Service`; `auto`: heuristic (components sharing a directory are treated as a monolith, otherwise as a monorepo) |
| `nameOverrides` | `Record<string,string>` | `{}` | catalog name → desired graph name; use when identity welding can't derive a good name from a root-level catalog file or a generic directory name |
| `overrides` | `Record<string,{role}>` | `{}` | per-component `role: deployment-facet \| independent-service`, keyed by component name |

---

## `ingestion`

- **Type**: `{ maxFieldsPerPayload? }`
- **Default**: `maxFieldsPerPayload: 50`
- **Why**: cap the number of `PRODUCES_FIELD` / `CONSUMES_FIELD` edges materialized per Function to DataStructure pair. Without a cap, a 500+ field monolith schema ("save" god-objects) produces unbounded edge counts.

```yaml
ingestion:
  maxFieldsPerPayload: 50
```

When a schema has more fields than the cap, the first N are linked field-by-field and `PRODUCES.fieldsCapped=true` is stamped on the edge so downstream lineage queries know to fall back to `HAS_FIELD` for the rest. Leave the default unless a specific schema is hitting the cap and you need full field-level lineage on it.

---

## Validation

`cr validate --repo <path>` runs two checks with no graph and no LLM:

1. **Strict schema**: unknown top-level keys (typos like `decoratorss:`) are errors, not silently ignored like at analysis time.
2. **Semantic dry-run**: flags declared sections that match nothing in the repo (e.g. a `databases[].tables` pattern that matches no `SELECT`).

Reports keys and literal defaults harvested per `envAccessors` entry; default values are masked in the output.

Exit codes: `0` clean (dry-run warnings are still allowed through), `1` schema-invalid. Use `--json` for CI:

```bash
cr validate --repo . --json
```

---

## Editor support

The repo ships a generated JSON Schema (`schemas/coderadius.schema.json`, regenerated via `bun run gen:schema`). Point your editor's YAML language server at it with a modeline as the first line of the file:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/coderadius-ai/coderadius/main/schemas/coderadius.schema.json
```

You get completion, hover docs, and unknown-key warnings as you type. `cr validate` runs the same strict check plus the semantic dry-run, for CI and pre-commit.

---

## Complete examples

### TypeScript / Node.js

```yaml
# coderadius.yaml (TypeScript monorepo)

packages:
  analyze:
    - "@acme/internal-http"
    - name: "@acme/notification-client"
      kind: http-client
      label: "Notification API"
      baseUrl: "https://notifications.acme.com"
  ignore:
    - "@datadog/browser-logs"
    - "pino"

decorators:
  - name: MessageConsumer
    kind: message-consumer
    args: [routingKey, queue]

databases:
  - id: main-mysql
    technology: mysql
    tables:
      - "orders_*"
      - "shipping_carts"
  - id: shared-redis
    technology: redis
    shared: true

hints:
  - patterns: [MessageEmitterService, emitEvent]
    description: >
      Internal RabbitMQ wrapper. emit*() methods publish messages.
      Treat as WRITES to a MessageChannel.
```

### PHP / Symfony

```yaml
# coderadius.yaml (PHP monolith)

packages:
  analyze:
    - "App\\Infrastructure\\Http\\InternalApiGateway"
  ignore:
    - "App\\Infrastructure\\Logging\\Logger"

decorators:
  # message-consumer is TS-only; use http-client/graphql-client selectors for PHP
  - name: "App\\Infrastructure\\Http\\InternalApiGateway::send"
    kind: http-client
    pathArgIndex: 0
    httpMethod: POST

databases:
  - id: legacy-mysql
    technology: mysql
    tables:
      - "*"
  - id: shared-redis
    technology: redis
    shared: true

hints:
  - patterns: [EntityManager, persist, flush, remove]
    description: >
      Doctrine ORM. persist()/flush() is a WRITE, find()/findBy() is a READ.
      EntityManager::remove() is a DELETE. Table name is the entity class
      in snake_case (e.g. InvoiceEntity → invoice).
```

---

## Finding shared databases

Once `databases` is declared consistently across repos, two `DataContainer` nodes with the same `scope` but different `sourceRepo` mean two services are hitting the same physical table. Query it directly in Memgraph Lab:

```cypher
MATCH (dc1:DataContainer), (dc2:DataContainer)
WHERE dc1.name = dc2.name
  AND dc1.id <> dc2.id
  AND dc1.scope IS NOT NULL
  AND dc1.scope = dc2.scope
  AND dc1.sourceRepo <> dc2.sourceRepo
RETURN dc1.name AS table,
       dc1.scope AS sharedScope,
       dc1.sourceRepo AS repo1,
       dc2.sourceRepo AS repo2
ORDER BY sharedScope, table
```

There's no dedicated governance alert for this today. The closest shipped feature is Data Gravity's "Top Data Monoliths" ranking. Run `cr ui` and open the [SPOFs & Data Gravity](./explore/data-gravity.md) panel, or call the `analyze_architecture_gravity` MCP tool, which ranks shared `DataContainer`/`MessageChannel` nodes by SPOF score.

---

## Further reading

- [CLI Reference](./cli-commands.md): `cr analyze code`, `cr validate`, and other commands that interact with this configuration
