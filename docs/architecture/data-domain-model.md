# Data Domain Model

> Logical/physical split for datastore topology. The data-layer sibling of [messaging-domain-model.md](./messaging-domain-model.md): one logical identity, N physical surfaces, one per deployment environment.

## 1. Why the split

Earlier the graph modelled a database as a single `:Datastore` node that tried to carry both the business identity AND the physical connection facts. Multi-environment metadata (the same logical DB on a prod host and a dev host) was stuffed into a serialised `environments` JSON string on that node (paradigm B). That cemented two problems on enterprise graphs:

1. **`host: null` on Datastore.** The logical node has no single host (a DB has one per environment), so the inspector showed `null`. Host/port genuinely belong to a *physical* surface, not the logical identity.
2. **JSON-blob queries.** "Which production databases are a single point of failure" required `UNWIND`-ing a JSON string instead of matching nodes. Cross-environment facts were invisible to Cypher.

The fix is the same ontological move already proven for messaging: split the **logical** identity from the **physical** surfaces. This is *paradigm A*, and it now applies uniformly to `:Datastore`/`:DatabaseEndpoint`, `:MessageBroker`/`:MessageChannel`, and `:APIInterface`/`:APIDeployment`.

## 2. The two layers

| Layer | Node | Identity rule | Owner |
|---|---|---|---|
| **Logical** | `:Datastore` | `cr:datastore:{namespace}:{logicalId}` | Business identity (name + technology) |
| **Physical** | `:DatabaseEndpoint` | `cr:dbendpoint:{endpointKey}:{environment}` | One deployment surface (host:port/db in one env) |

- `:Datastore` carries **only** `name`, `technology`, `namespace`. No `host`, no `port`, no `environments` blob.
- `:DatabaseEndpoint` carries `endpointKey`, `environment`, `dbName`, `technology`, and (privacy-gated) `host`/`port`. It is the node you query for physical facts.
- `namespace` is `shared` (cross-repo convergence for declared datastores) or the qualified repo name (auto-discovered, repo-scoped).

## 3. URN strategy

```
Datastore:        cr:datastore:{namespace}:{logicalId}
DatabaseEndpoint: cr:dbendpoint:{endpointKey}:{environment}
                  endpointKey = sha256_trunc8(host:port/dbName)   (computeEndpointKey)
                  environment ∈ production | staging | development | test | unknown
```

The `endpointKey` is the **stable physical fingerprint**: case-insensitive on host and dbName, credential-free, identical across repos that point at the same endpoint (cross-repo SPOF detection). The explicit `environment` segment keeps the *same* physical endpoint observed in two environments as two distinct nodes, so a misconfiguration that reuses one host across prod and staging never collapses dev↔prod silently.

`buildDatabaseEndpointUrn(endpointKey, environment)` is the single constructor; `computeEndpointKey(host, port, dbName)` is the single fingerprint function (`src/ingestion/processors/db-scope-resolver.ts`). No call site builds the URN ad hoc.

## 4. Edge inventory

```
(Function)-[:CONNECTS_TO]->(Datastore)            function touches this logical DB (conservative, blast-radius)
(DataContainer)-[:STORED_IN {bindingReason}]->(Datastore)   a table/collection lives in this logical DB
(Datastore)-[:SERVED_BY]->(DatabaseEndpoint)      logical DB is served by this physical surface (one per env)
(Datastore)-[:CONFIGURED_VIA]->(EnvVar)           which env var configures this DB (resource declarations)
```

`SERVED_BY` is the load-bearing new edge: a `:Datastore` with three `SERVED_BY` endpoints is a DB deployed to three environments. "All production endpoints" is `MATCH (:Datastore)-[:SERVED_BY]->(ep:DatabaseEndpoint {environment:'production'})`.

## 5. Environment classification and identity collapse

Per-environment surfaces are discovered as `PhysicalEndpointHint`s, then collapsed into `DatastoreIdentity`s by `canonicalizeDatastoreIdentities` (`connection-extractors/canonicalizer.ts`):

- **Identity key** = `stripEnvSuffix(dbName).toLowerCase()`. `orders` (helm-prod) and `orders-dev` (compose) collapse to identity `orders`; genuinely distinct DBs (`orders` vs `payments`) stay separate.
- **Environment class** = `inferEnvironment(dbName, sourceFile)`: matches `prod|production`, `staging|stage`, `dev|development` (or `docker-compose`), `test|qa|uat`, else `unknown`.
- Each identity exposes `environments: EnvironmentVariant[]` (one per surface). `resolveDatastoreBinding` carries these through to the graph-writer, which emits one `:DatabaseEndpoint` per variant via `emitDatabaseEndpointsForBinding`.

### Caveat: the env-map collapse

`buildRepoEnvMap` is **first-writer-wins per key**: the same env-var key (`DATABASE_URL`) present in `.env.production` and `docker-compose.yml` keeps only one winner. Multi-environment identities therefore arise from:
- distinct DSN keys (`PROD_DATABASE_URL`, `STAGING_DATABASE_URL`, ...), or
- file-based connection extractors (Doctrine/TypeORM configs) that the orchestrator reads per file (no env-map collapse).

A repeated single key across files is **not** a reliable multi-env signal. This is why the deterministic fixtures use distinct DSN keys.

## 6. Cleanup

`deleteOrphanDatabaseEndpoints()` (invoked post-pipeline in `orchestrator.ts`) hard-deletes any `:DatabaseEndpoint` with no live `SERVED_BY` from a live `:Datastore`. This reaps endpoints whose Datastore was removed.

**Known limitation (accepted, pre-1.0):** an incremental run that *removes* one environment (e.g. a deleted `STAGING_DATABASE_URL`) does not tombstone the now-stale endpoint, because its `SERVED_BY` edge is not re-walked when the owning file is Merkle-cached. A fresh re-sync regenerates the correct set. A commit-freshness `pruneStaleDatabaseEndpoints` is deferred follow-up work (analogous to the messaging mark-and-sweep).

## 7. Migration and cache

This is a graph-persistence-shape change only (no AST, prompt, taint, or heuristic-filter change), so it does **not** affect the incremental-cache salt (see [incremental-cache-versioning.md](./incremental-cache-versioning.md)). The real salt today is just the `--taint-depth` value, which this change doesn't touch. Bumping it would force an expensive global LLM re-run for a change that only affects how nodes are written.

Per the pre-1.0 no-migration policy, the transition path is a **fresh re-sync** (`rm -rf ~/.coderadius/cache && cr analyze code <repo>`): a cold run regenerates the graph under the new schema. On an incremental run, pre-existing `:Datastore` nodes retain a vestigial `environments` property (no reader consumes it) until the next cold rebuild; this is harmless.

## 8. Test surfaces

| Tier | File | Pins |
|---|---|---|
| Unit | `tests/unit/graph/mutations/database-endpoint-urn.test.ts` | `computeEndpointKey` fingerprint + `buildDatabaseEndpointUrn` env segment / anti-collision |
| Eval (pattern) | `tests/eval/patterns/ts-datastore-multi-env/` | files → hints → canonicalize → binding produces 1 identity + 3 environments, distinct endpointKeys |
| Eval (pattern) | `tests/eval/patterns/ts-datastore-single-env/` | regression: the common single-env case emits exactly one endpoint |
| Integration | `tests/integration/datastore-multi-env-endpoints.test.ts` | mutations: 1 `:Datastore` + N `:DatabaseEndpoint{environment}` `SERVED_BY`, anti-collision, idempotency |

## 9. Further reading

- [messaging-domain-model.md](./messaging-domain-model.md): the sibling paradigm-A split for brokers/channels.
- [api-endpoint-dedup.md](./api-endpoint-dedup.md): `:APIInterface`/`:APIDeployment`, the paradigm-A split for API surfaces (also carries `environment` on the physical layer).
- [service-topology.md](./service-topology.md): cross-repo dependency resolution and namespace scoping.
