# Graph URN Taxonomy

This page defines the canonical URN templates used by the CodeRadius graph.

It started as a DataContainer scoping note, but the current architecture is broader: the graph is keyed by URN, so the URN taxonomy is part of the product model, not just an ingestion detail.

If two resources should converge to the same node, they must produce the same URN.
If two resources should stay isolated, they must produce different URNs.

## Core Rule

All graph identifiers use the `cr:` scheme:

```text
cr:{type}:{segment1}:{segment2}:...
```

URNs are built by [`buildUrn()`](../../src/graph/urn.ts).

Important constraints:

- URNs are forward-only identifiers.
- They must not be parsed with naive `split(':')` logic.
- Some resource types are lowercased by the builder because their identity is case-insensitive.
- File paths, HTTP paths, PHP `Class::method` signatures, and scoped package names are stored verbatim.

See [`src/graph/urn.ts`](../../src/graph/urn.ts) for the normalization and non-reversibility contract.

## Namespace Terms

The templates below use these placeholder names:

| Placeholder | Meaning |
|---|---|
| `{qualifiedRepo}` | Fully qualified repository name from `getQualifiedRepoName()`, usually `{org}/{repo}` or `local/{repo}` |
| `{scope}` | DataContainer namespace chosen by `databases[].tables`, otherwise `{qualifiedRepo}` |
| `{namespace}` | Datastore namespace: `shared` or `{qualifiedRepo}` |
| `{logicalId}` | Stable datastore identifier from `coderadius.yaml` `databases[].id`, or `auto-{technology}` in fallback mode |
| `{signature}` | Stable function signature, e.g. `App\\Service\\OrderService::create` or `src/lib/http/client::request` |
| `{specPath}` | OpenAPI file path relative to the repository root |

## Canonical URN Templates

| Node Type | URN Template | Example |
|---|---|---|
| `Repository` | `cr:repository:{qualifiedRepo}` | `cr:repository:acme/orders` |
| `Service` | `cr:service:{qualifiedRepo}:{serviceName}` | `cr:service:acme/orders:loyalty-service` |
| `Function` | `cr:function:{qualifiedRepo}:{language}:{signature}` | `cr:function:acme/orders:php:App\\Service\\OrderService::create` |
| `SourceFile` | `cr:sourcefile:{qualifiedRepo}:{relativePath}` | `cr:sourcefile:acme/orders:src/Service/OrderService.php` |
| `StructuralFile` | `cr:structuralfile:{qualifiedRepo}:{relativePath}` | `cr:structuralfile:acme/orders:openapi.yaml` |
| `ProjectDirectory` | `cr:directory:{qualifiedRepo}:{relativePath}` | `cr:directory:acme/orders:src/Service` |
| `ConfigSymbol` | `cr:configsymbol:{qualifiedRepo}:{key}` | `cr:configsymbol:acme/orders:database.default` |
| `EnvVar` | `cr:envvar:{envVarName}` | `cr:envvar:POSTGRES_HOST` |
| `DataContainer` | `cr:datacontainer:{scope}:{tableName}` | `cr:datacontainer:shared-orders-db:orders` |
| `Datastore` | `cr:datastore:{namespace}:{logicalId}` | `cr:datastore:acme/orders:main-mysql` |
| `MessageChannel` | `cr:channel:{physicalName}` | `cr:channel:auto.acme.order.created` |
| `SystemProcess` | `cr:systemprocess:{processName}` | `cr:systemprocess:nightly-restock-job` |
| `APIInterface` (code-inferred) | `cr:api:code-inferred:{qualifiedRepo}:{serviceName}` | `cr:api:code-inferred:acme/orders:loyalty-service` |
| `APIInterface` (OpenAPI) | `cr:api:{qualifiedRepo}:{serviceName}:{specPath}` | `cr:api:acme/orders:loyalty-service:openapi.yaml` |
| `APIEndpoint` (code) | `cr:endpoint:code:{METHOD}:{path}` | `cr:endpoint:code:POST:/api/v1/orders` |
| `APIEndpoint` (emergent) | `cr:endpoint:emergent:{METHOD}:{path}` | `cr:endpoint:emergent:POST:/api/payments` |
| `APIEndpoint` (OpenAPI) | `cr:endpoint:{qualifiedRepo}:{specPath}:{METHOD}:{path}` | `cr:endpoint:acme/orders:openapi.yaml:POST:/api/v1/orders` |
| `URL` | `cr:url:{url}` | `cr:url:https://api.example.com` |
| `Schema` | `cr:schema:{schemaType}:{schemaName}` | `cr:schema:message_payload:order_created` |
| `SchemaField` | `cr:schema:{schemaType}:{schemaName}:field:{fieldName}` | `cr:schema:message_payload:order_created:field:customerId` |
| `Package` | `cr:package:{ecosystem}:{packageName}` | `cr:package:npm:axios` |
| `Release` | `cr:release:{ecosystem}:{packageName}:{version}` | `cr:release:npm:axios:1.9.0` |
| `Library` | `cr:library:{libraryName}` | `cr:library:shared-utils` |
| `System` | `cr:system:{systemName}` | `cr:system:orders-platform` |
| `Domain` | `cr:domain:{domainName}` | `cr:domain:pricing` |
| `Team` | `cr:team:{teamName}` | `cr:team:pricing-platform` |
| `TeamAlias` | `cr:teamalias:{aliasName}` | `cr:teamalias:pricing-core-team` |
| `DockerImage` | `cr:dockerimage:{imageName}:{tag}` | `cr:dockerimage:php-fpm:8.3` |
| `Task` | `cr:task:{qualifiedRepo}:{target}` | `cr:task:acme/orders:test` |
| `ToolConfig` | `cr:toolconfig:{toolName}:{qualifiedRepo}:{relativePath}` | `cr:toolconfig:TypeScript:acme/orders:tsconfig.json` |
| `AgenticConfig` | `cr:agenticconfig:{qualifiedRepo}:{tool}:{relativePath}` | `cr:agenticconfig:acme/orders:cursor:.cursor/rules/pricing.mdc` |

Note: the URN type-token doesn't always match the node label. `ProjectDirectory` is the one exception in this table (URN prefix stays `directory`).

## The Four Most Important Templates

For the current taxonomy work, these are the key identities:

```text
cr:function:{qualifiedRepo}:{language}:{signature}
cr:datacontainer:{scope}:{tableName}
cr:datastore:{namespace}:{logicalId}
cr:endpoint:{qualifiedRepo}:{specPath}:{METHOD}:{path}
```

These four URNs drive most of the blast-radius and cross-service topology correctness issues.

## DataContainer Identity

`DataContainer` nodes represent logical database tables:

```text
cr:datacontainer:{scope}:{tableName}
```

Scope resolution is intentionally simple pre-1.0:

1. `databases[].tables` in `coderadius.yaml` wins.
2. Otherwise, fall back to `{qualifiedRepo}`.

That means:

- private tables remain repo-scoped by default;
- shared tables converge only when explicitly declared;
- there is no automatic cross-repo convergence based on inferred DB connection labels.

Examples:

```text
cr:datacontainer:acme/orders:orders
cr:datacontainer:shared-orders-db:orders
```

The DataContainer node also stores explicit metadata such as `scope`, `scopeSource`, and `sourceRepo`. Query-side code must use those properties rather than trying to reverse-parse the URN.

## Datastore Identity

`Datastore` nodes represent physical or logical backing stores:

```text
cr:datastore:{namespace}:{logicalId}
```

Examples:

```text
cr:datastore:acme/orders:main-mysql
cr:datastore:acme/orders:redis-cache
cr:datastore:shared:kafka-cluster
```

Rules:

- `{logicalId}` comes from `coderadius.yaml` `databases[].id`.
- `{namespace}` is `{qualifiedRepo}` by default.
- Shared infrastructure uses `shared`.
- In fallback mode, the logical ID may be `auto-{technology}`.

In the graph model:

- `DataContainer` and `Datastore` are different layers.
- `databases[].tables` controls both the `DataContainer` URN scope and `[:STORED_IN]` linkage.
- The unified `databases` array replaces the former `database_scope` and `datastores` keys.

That separation allows a shared logical table scope and a repo-local physical datastore to coexist when that reflects reality.

## API Identity

CodeRadius models three distinct API identities:

### API Interface

```text
cr:api:code-inferred:{qualifiedRepo}:{serviceName}
cr:api:{qualifiedRepo}:{serviceName}:{specPath}
```

The first form is produced from code analysis.
The second form is produced from OpenAPI documents.

### API Endpoint

```text
cr:endpoint:code:{METHOD}:{path}
cr:endpoint:emergent:{METHOD}:{path}
cr:endpoint:{qualifiedRepo}:{specPath}:{METHOD}:{path}
```

The OpenAPI endpoint form is deliberately repo- and spec-scoped to avoid the old double-prefix and cross-repo collision problems.

## Function Identity

`Function` nodes are globally unique only if they include the qualified repository:

```text
cr:function:{qualifiedRepo}:{language}:{signature}
```

Examples:

```text
cr:function:acme/orders:php:App\\Repository\\OrderRepository::findById
cr:function:acme/orders:typescript:src/lib/http/client::request
```

Using only the short repo basename is not sufficient in enterprise or monorepo-heavy environments.

## Case Normalization

The URN builder lowercases all segments for these types:

- `datacontainer`
- `datastore`
- `systemprocess`
- `domain`
- `system`
- `team`
- `tenant`
- `deploymentunit`
- `technology`

Everything else is preserved verbatim.

This behavior is defined in [`src/graph/urn.ts`](../../src/graph/urn.ts).

## Configuration Inputs

Two config surfaces are relevant to this taxonomy:

### `databases`

Used to decide both the `DataContainer` namespace and which `Datastore` node receives `[:STORED_IN]` links:

```yaml
databases:
  - id: shared-orders-db
    technology: mysql
    shared: true
    tables:
      - orders
      - shipments
  - id: redis-cache
    technology: redis
```

This produces:

```text
cr:datacontainer:shared-orders-db:orders
cr:datacontainer:shared-orders-db:shipments
cr:datastore:shared:shared-orders-db
cr:datastore:acme/orders:redis-cache
```

Reference: [coderadius.yaml Reference](../guide/coderadius-yaml.md#databases)

## Pre-1.0 Policy

This taxonomy is defined for a pre-1.0 / greenfield graph:

- no backward compatibility is guaranteed;
- breaking URN changes require a fresh ingest;
- correctness of identity is preferred over migration convenience.

In practice, when a breaking URN change lands, use:

```bash
cr analyze code --force
```

## Related Docs

- [coderadius.yaml Reference](../guide/coderadius-yaml.md)
- [Ingestion Pipeline](./ingestion-pipeline.md)
