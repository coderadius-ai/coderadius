# Messaging Domain Model

> Three-layer ontology for broker topology. Designed to scale from a single-cluster deployment to a multi-region, multi-tenant enterprise without losing correctness.

## 1. Why three layers

Earlier the graph collapsed three distinct concepts into a single `MessageChannel` node identified by `cr:channel:{kind}:{name}`. That URN ignored the broker and the tenant boundary, which caused two silent failures on enterprise deployments:

1. **Cross-cluster collisions**: two services that publish to a channel named `orders` on two different RabbitMQ clusters fused into one node. Blast-radius reported false coupling.
2. **Lost routing topology**: a publisher that invoked `basic_publish(exchange='X', routing_key='Y')` produced a single `PUBLISHES_TO` edge without the routing key. Pattern bindings (`*.save.#`) were impossible to evaluate at query time.

The fix is an ontological split that keeps semantic clarity at every level of resolution.

## 2. The three layers

| Layer | Node | Identity rule | Owner |
|---|---|---|---|
| **Broker** | `MessageBroker` | `sha256_trunc8(provider:host:port:vhost)` + optional user override | Physical infrastructure |
| **Channel** | `MessageChannel{scope}` | URN with optional `@brokerFp8` suffix when bound | Routing topology |
| **Contract** | `DataStructure{type:'message_payload'}` | URN over (`namespace`, `name`, version) | Payload schema |

The channel layer further subdivides by `scope`:

| scope | Represents | Example |
|---|---|---|
| `logical` | Business event, independent of the wire | `OrderCreated` (matches the dispatched MessageClass) |
| `physical` | Broker address, exists only on a specific broker | exchange `acme.orders` on `cr:broker:rabbitmq:abc12345:prod` |
| `transport` | Meta-broker wrapper around a physical channel | Symfony Messenger transport `inventory` |

## 3. URN strategy

Backward-compatible additive scheme:

```
MessageBroker:   cr:broker:{provider}:{fingerprint}[:{vhost-slug}]
MessageChannel (logical, default for code-analysis):
                 cr:channel:{kind}:{name}
MessageChannel (physical, broker-bound):
                 cr:channel:{kind}:{name}@{brokerFp8}
MessageChannel (transport, Symfony Messenger):
                 cr:channel:transport:{transportName}
```

`{kind}` maps `topic|exchange|queue` verbatim; `subscription` is abbreviated to `sub` (legacy convention preserved). Two channels with the same `(name, kind)` on different brokers are guaranteed-distinct nodes.

## 4. Edge inventory

```
(Function)-[:PUBLISHES_TO {routingKey?, partitionKey?, headers?, confidence?}]->(MessageChannel)
(Function)-[:LISTENS_TO {consumerGroup?, ackMode?, filterExpression?, confidence?}]->(MessageChannel)
(MessageChannel)-[:ROUTES_TO {
    bindingKey, isPattern, patternSyntax, patternRegex,
    filterExpression?, filterSyntax?, headerMatch?, headerMatchMode?
}]->(MessageChannel)
(MessageChannel)-[:HOSTED_ON]->(MessageBroker)
(MessageChannel{scope:'logical'})-[:MANIFESTS_AS {declaredVia, confidence}]->(MessageChannel{scope:'physical'})
(MessageChannel{scope:'transport'})-[:BACKED_BY {declaredVia}]->(MessageChannel{scope:'physical'})
(MessageChannel)-[:DEAD_LETTERS_TO {retryLimit?, ttl?}]->(MessageChannel)
(DataStructure)-[:CARRIED_BY]->(MessageChannel)
(MessageChannel)-[:HAS_SCHEMA]->(DataStructure)
```

### Why `routingKey` lives on the edge

When the same publisher Function fires `publish(exchange='X', routing_key='order.created')` and `publish(exchange='X', routing_key='order.cancelled')`, the wire-level effect is two distinct events. Memgraph's `MERGE` on `(f)-[r:PUBLISHES_TO]->(ch)` collapses them by default. We use property-pattern matching:

```cypher
MERGE (f)-[r:PUBLISHES_TO {routingKey: $rk}]->(ch)
```

so the `routingKey` participates in the edge identity. Two routing keys → two edges, both queryable independently.

### Why `bindingKey` lives on `ROUTES_TO`

A topic exchange routes by *pattern*. The binding declares the pattern (`acme.order.#`), the publisher emits a concrete key (`acme.order.created`). The cross-service query expands as:

```cypher
MATCH (sa:Service)-[:CONTAINS*1..3]->(:Function)-[p:PUBLISHES_TO]->(src:MessageChannel),
      (src)-[r:ROUTES_TO]->(tgt:MessageChannel)<-[:LISTENS_TO]-(:Function)<-[:CONTAINS*1..3]-(sb:Service)
WHERE (r.isPattern = false AND r.bindingKey = p.routingKey)
   OR (r.isPattern = true  AND p.routingKey =~ r.patternRegex)
RETURN sa.name, sb.name, src.name, tgt.name, r.bindingKey
```

The structural plugin pre-compiles `patternRegex` at ingestion so query-time evaluation is a single regex match instead of an AMQP DSL interpreter.

## 5. Strict broker isolation

Welding rule: **never merge channels on different brokers heuristically.** Implementation in `processors/dynamic-infra-resolver.ts`:

```cypher
MATCH (short:MessageChannel), (long:MessageChannel)
WHERE coalesce(short.brokerUrn, '') = coalesce(long.brokerUrn, '')
  AND (coalesce(short.scope,'') = coalesce(long.scope,'') OR ...)
  ... // rest of suffix-dedup rules
```

Two channels with the same name but different `brokerUrn` are not candidates. Two channels with `scope='physical'` and `scope='logical'` never merge across that boundary.

### Why this is non-negotiable

Permissive cross-broker welding produces two failure modes that are far harder to remove than the welding itself:

1. **Shadow topology**: a staging cluster's `orders` queue silently merges with prod's. Blast-radius shows false coupling.
2. **Chimera nodes**: the merge has to reconcile divergent properties (retention, DLX, ack policy). The resulting node represents no real infrastructure.

The strict default + user-declared opt-in (see §6) gives the maximum precision at the cost of a few yaml lines for the legitimate mirror cases.

## 6. User-declared mirroring

Real systems still need to express "this event is replicated across regions". The only path that creates cross-broker convergence is `coderadius.yaml.message_channels.mirrors[]`:

```yaml
message_channels:
  mirrors:
    - logical: OrderCreated
      kind: topic
      physical:
        - { broker: rmq-prod-eu, channel: acme.orders, kind: topic }
        - { broker: rmq-prod-us, channel: acme.orders, kind: topic }
```

The welder `channel-alias-welder.ts`:

1. Materializes `MessageChannel{scope:'logical', name:'OrderCreated'}`.
2. For each physical descriptor, resolves the broker via the registry, ensures the physical channel node exists, and creates a `MANIFESTS_AS` edge.
3. The two physical channels keep distinct URNs (strict isolation). The logical channel sits above them.

A consumer query asking "who reacts to OrderCreated regardless of region?" is then a single MATCH across `MANIFESTS_AS`:

```cypher
MATCH (l:MessageChannel {name: 'OrderCreated', scope: 'logical'})-[:MANIFESTS_AS]->(p)<-[:LISTENS_TO]-(f:Function)<-[:CONTAINS*1..3]-(svc:Service)
RETURN DISTINCT svc.name
```

## 7. Discovery & confidence

Every node carries `discoverySource` (already existed) and channels/brokers carry `declaredVia` + `confidence`:

| Source | declaredVia | confidence | Authority |
|---|---|---|---|
| `coderadius.yaml` (user-declared) | `coderadius.yaml` | 1.0 | Highest |
| Config file with literal DSN (`messenger.yaml`, `definitions.json`) | `config` | 0.9 | High |
| Code analysis (LLM-extracted) | (no dedicated `declaredVia` tag; falls under `inferred`) | 0.3-0.8 | Medium |
| DSN with unresolved env-vars | `inferred` | 0.3 | Low |
| Backstage / Crossplane CRD | `backstage` / `crossplane` | 1.0 | High |

Resolution priority when two sources disagree: declaration beats config, config beats code, code beats convention. The welder respects the priority: a code-extracted channel is welded into the config-declared one, not vice-versa.

## 8. Symfony Messenger as meta-broker

Symfony Messenger does not own a wire format; it wraps AMQP / Doctrine / Redis / SQS / async PHP. The model treats it as a `provider: 'symfony-messenger'` meta-broker whose channels (one per `transport:` entry) are `scope:'transport'` and carry a `BACKED_BY` edge to the underlying physical channel.

```
(:LogicalChannel{name: 'OrderCreated'})
  -[:MANIFESTS_AS]->(:TransportChannel{name: 'inventory'})
  -[:BACKED_BY]->(:PhysicalChannel{name: 'inventory', brokerUrn: 'cr:broker:rabbitmq:abc12345:prod'})
```

The `routing:` block of `messenger.yaml` produces the `MANIFESTS_AS` set, the `transports:` block produces the `BACKED_BY` set. A single MessageClass routed to N transports yields N `MANIFESTS_AS` edges. This is the canonical CQRS "one event, many transports" shape.

## 9. Provider coverage matrix

`MessageBroker.provider` is an enum of 13 supported values. Coverage is split into two complementary layers:

| Provider | Code analysis (LLM) | Structural extraction |
|---|---|---|
| RabbitMQ | ✓ | ✓ (`rabbitmq-config.plugin.ts`) |
| Symfony Messenger | ✓ | ✓ (`symfony-messenger.plugin.ts`) |
| Google Pub/Sub | ✓ | ✓ (`crossplane-pubsub.plugin.ts`) |
| Kafka | ✓ | planned |
| AWS SQS | ✓ | planned |
| AWS SNS | ✓ | planned |
| Azure Service Bus | ✓ | planned |
| NATS | ✓ | planned |
| Apache Pulsar | ✓ | planned |
| Redis Streams | ✓ | planned |
| MQTT | ✓ | planned |
| Mosquitto | ✓ | planned |
| ZeroMQ | ✓ | n/a (no broker config file) |

Adding a structural plugin for a new provider means writing a single file under `src/ingestion/structural/plugins/messaging/` that reuses `messaging-helpers.ts` for DSN parsing + broker resolution + URN construction.

## 10. Backward compatibility

All new schema fields on `MessageChannel` and `MessageBroker` are optional. Channels emitted by the legacy code pipeline (no scope, no brokerUrn) keep working. The welders treat null `brokerUrn` as "any" so the strict-isolation guard remains permissive for pre-existing data. A re-sync upgrades the channels to scoped form gradually.

## 11. Persistence safety properties

Three invariants are enforced at the mutation layer so the graph stays correct under re-syncs and adversarial input code:

### 11.1 Identity-aware MERGE on routing edges

`mergeStructuralEdge` embeds the binding-key in the relationship pattern of the MERGE clause:

```cypher
MERGE (src)-[r:ROUTES_TO {bindingKey: $identityKey}]->(tgt)
```

`identityKey` is `bindingKey ?? routing_key ?? ''`. Without this, two parallel bindings with the same `(source, destination)` but different routing keys collapse on the first edge Memgraph encounters and the `ON MATCH SET` overwrites the second binding's metadata. AMQP and SNS routinely produce this shape (one exchange/topic, multiple binding rules to the same queue).

### 11.2 Decorator-secret scrubbing before LLM prompt

`formatFrameworkSignalContext` runs `scrubDecoratorSecrets` on the raw decorator text **before** the 200-char truncation. Sensitive keys (`password`, `secret`, `token`, `api_key`, `bearer`, `client_secret`, …) are word-boundary-matched and the assigned value is replaced with `[REDACTED]`. The 200-char cap alone is insufficient: a credential at the start of the decorator argument list would otherwise slip through.

### 11.3 Mark-and-sweep on user-declared MANIFESTS_AS

`weldChannelAliases` records every `(logicalUrn, physicalUrn)` pair it materializes from `coderadius.yaml.message_channels.mirrors[]` in a `keptPairs` list, then issues a sweep query that tombstones any `MANIFESTS_AS` edge with `declaredVia='coderadius.yaml'` NOT in the kept set. Without this, removing a mirror from `coderadius.yaml` would leave a "zombie" alias edge live forever (the `manifestChannelAs` mutation only touches the edges it's explicitly called for). LLM-inferred `MANIFESTS_AS` edges have a different `declaredVia` and are out of scope.

## 12. Test surfaces

| Tier | What it pins |
|---|---|
| `tests/unit/graph/messaging-domain.test.ts` | Zod schema, URN builders, AMQP pattern compilation |
| `tests/unit/ingestion/core/messaging/broker-registry.test.ts` | User-declared broker fingerprinting, mirror registration |
| `tests/unit/ingestion/structural/messaging-helpers.test.ts` | DSN parsing, declared-broker matching, physical channel URN |
| `tests/unit/ingestion/structural/rabbitmq-config-plugin.test.ts` | exchanges + queues + bindings + ROUTES_TO with `isPattern` |
| `tests/unit/ingestion/structural/symfony-messenger-plugin.test.ts` | Meta-broker + transports + logical/transport/physical edge chain |
| `tests/eval/patterns/rabbitmq-messenger-routing/` | End-to-end deterministic broker topology extraction |
| `tests/eval/patterns/multi-broker-mirroring/` | Strict isolation + user-declared cross-broker mirror |
| `tests/unit/config/repo-hints-messaging.test.ts` | `coderadius.yaml.messageBrokers[]` + `message_channels.mirrors[]` schema |

## 13. Further reading

- [Contrib Plugin System](./contrib-plugins.md): Plugin contract and Crossplane, RabbitMQ, and Symfony Messenger plugin internals
- [Service Topology](./service-topology.md): How Service ↔ Repository ↔ Channel relationships are reconciled
- [coderadius.yaml reference](../guide/coderadius-yaml.md): User-facing yaml schema for `messageBrokers` and `mirrors`
- [Supported Frameworks](../guide/supported-frameworks.md): Public-facing provider matrix
