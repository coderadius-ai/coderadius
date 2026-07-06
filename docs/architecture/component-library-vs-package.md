# Library vs Package: Component Ontology

> Internal reference for the CodeRadius graph domain. Disambiguates two
> overlapping concepts that frequently confuse contributors during graph
> exploration: workspace-internal code (`:Library`) and declared dependencies
> (`:Package`).

## 1. Why the distinction matters

The graph models two structurally different facts under names that look similar:

1. **Your own code, organised into reusable workspaces** (e.g. `libs/health/`)
   in a NestJS monorepo. CodeRadius parses its source, indexes its functions,
   and follows the call graph through it.
2. **External or distributed dependencies declared in a manifest** (e.g.
   `lodash` in a `package.json`, `doctrine/orm` in a `composer.json`). CodeRadius
   never parses their source; it tracks the dependency edge and version metadata.

Collapsing both into a single node type would force ambiguous queries (`"is this
the workspace I authored or a third-party dependency?"`), erase ownership
distinctions, and break blast-radius analysis across package-publication
boundaries. The schema separates them as `:Library` and `:Package`, with
distinct URN namespaces, properties, and edge contracts.

---

## 2. The two node types at a glance

| | `:Library` | `:Package` |
|---|---|---|
| **What it represents** | A workspace of your own source code that is not a runtime entry-point | A dependency declared in a manifest (npm / Composer) |
| **URN** | `cr:library:{name}` | `cr:package:{ecosystem}:{name}` |
| **Contains source code in the graph?** | Yes: `Function`, `Class`, `SourceFile` | No: opaque reference |
| **Has a `:CONTAINS` edge to Function?** | Yes | No |
| **Has a version property?** | No (lives at HEAD of the repo) | Yes: `latestKnownVersion`, plus per-edge `requiredVersion` |
| **Has an ecosystem property?** | No (language-agnostic) | Yes: `npm` or `composer` |
| **Stored-in relationship** | `:Library -[:STORED_IN]-> :Repository` (single repo) | None: globally shared across repos |
| **Producer module** | `topology-resolver.ts` + `graph-writer.ts` | `packages.ts` mutations |
| **Origin signal** | Autodiscovery of a workspace manifest (no runtime bootstrap) | Parsing `dependencies` / `devDependencies` entries |

---

## 3. URN schemas

```
:Library          cr:library:{name}
:Package          cr:package:{ecosystem}:{name}
```

Notes:

- **Library URN** is scoped only by name, not by repo. Two repositories that both
  publish a workspace called `health` would collide. The intentional consequence
  is that a Library node represents a single canonical workspace identity across
  the entire knowledge graph. Cross-repo welding is automatic for monorepos and
  desired (a published lib should be the same node wherever its source is found).
  If you need per-repo scoping, the `:STORED_IN` edge carries the repository.

- **Package URN** is scoped by `(ecosystem, name)` to keep `npm:foo` and
  `composer:foo` distinct. This matches how registries work.

---

## 4. Edge models

### 4.1 Library edges

```
:Repository -[:CONTAINS]-> :SourceFile                     (file lives in repo)
:Library    -[:STORED_IN]-> :Repository                    (workspace is hosted here)
:Library    -[:CONTAINS]-> :Function                       (function belongs to lib)
:Library    -[:DEPENDS_ON {requiredVersion, isDev}]-> :Package (lib's manifest declares dep)
:Service    -[:DEPENDS_ON]-> :Library                      (cross-workspace consumption inside a monorepo)
```

### 4.2 Package edges

```
:Service    -[:DEPENDS_ON {requiredVersion, isDev}]-> :Package
:Library    -[:DEPENDS_ON {requiredVersion, isDev}]-> :Package
:Repository -[:DEPENDS_ON {requiredVersion, isDev}]-> :Package
:Repository -[:PUBLISHES]-> :Package                       (repo publishes this package)
:Package    -[:HAS_RELEASE]-> :Release                     (publication timeline)
```

The same `:Package` node is shared by every Service / Library / Repository in
the graph that declares it. Edge properties carry per-consumer metadata
(`requiredVersion`, `isDev`); the node itself carries publisher-side metadata
(`latestKnownVersion`, `publishRegistry`, `sourceRepoName`).

---

## 5. Where Library nodes come from

Two producers, deterministic and complementary:

### 5.1 Monorepo file routing (per-file)

`src/ingestion/processors/code-pipeline/file-discovery.ts:getMonorepoRouting`
classifies each source file based on its path:

| Path prefix | Routing | Effect |
|---|---|---|
| `apps/{name}/...` | `{ type: 'service', name }` | File rolls up into a `:Service` |
| `packages/{name}/...` | `{ type: 'library', name }` | File rolls up into a `:Library` |
| `libs/{name}/...` | `{ type: 'library', name }` | File rolls up into a `:Library` |
| anything else | `{ type: 'repository', name: repoName }` | File belongs to the repo root |

When `routing.type === 'library'`, `graph-writer.ts` calls `mergeLibrary(name)`
+ `linkLibraryStoredIn(name, repo, ...)` once per file (idempotent merge).

### 5.2 Topology resolver (per-workspace)

`src/ingestion/topology-resolver.ts` runs after autodiscovery + catalog welding
and classifies every discovered component into one of:

| Component class | Outcome |
|---|---|
| `services[]` | `mergeService` → `:Service` |
| `libraries[]` | `mergeLibrary` → `:Library` |
| `pendingTriage[]` | `mergeLibrary` → `:Library` with `needsReview=true` |

The decision tree for a workspace lacking a catalog declaration lives in
`extractors/autodiscovery.ts:187-203`:

```
plugin.classifyServiceRole(dir) === 'runtime'
  ├─ true  → inferredType = 'service'                  → :Service
  └─ false
      plugin.runtimeServiceSignals declared?
        ├─ true  → inferredType = 'library'            → :Library  (confident)
        └─ false → inferredType = undefined            → pendingTriage → :Library  (default, flagged)
```

The "no decisive runtime signal" branch deliberately picks `:Library` over
`:Service` because libraries are the safer default for the dashboard rollups
(no false runtime topology, no phantom HTTP exposures) and trigger a review
queue rather than silently producing incorrect Service identity.

### 5.3 Worked example: NestJS `libs/health/`

Real fragment from a NestJS monorepo (`acme-platform/libs/health/`):

```
libs/health/
├── package.json              # "name": "@lib/health", private: true
├── nest-cli.json
├── src/
│   ├── index.ts              # barrel
│   ├── Health.controller.ts  # @Controller() class with @Get() health()
│   └── Health.module.ts      # NestModule binding
```

The TypeScript plugin declares `runtimeServiceSignals` (it looks for
`NestFactory.create` / `bootstrap()` in `main.ts`). `libs/health/` contains
neither, so the signals fire-zero ⇒ `inferredType = 'library'`. Topology
resolver writes:

```cypher
(:Library {id: 'cr:library:health', name: 'health'})
(:Library {id: 'cr:library:health'}) -[:STORED_IN]-> (:Repository {name: 'acme-platform'})
(:Library {id: 'cr:library:health'}) -[:CONTAINS]-> (:Function {id: 'cr:function:acme-platform:typescript:libs/health/src/Health.controller::HealthController.health'})
```

The `@Get()` decorator on `HealthController.health` produces an
`:APIEndpoint{path: '/health', method: 'GET'}` via the NestJS decorator
extractor, edged from the Function. Visiting the Library in the blast-radius
explorer therefore shows the endpoint as the one observable hop downstream.

The runtime consumer (the `apps/api/` Service that imports `HealthModule`)
appears as the reverse edge `:Service -[:DEPENDS_ON]-> :Library`.

---

## 6. Where Package nodes come from

Single producer, single shape:

`src/graph/mutations/packages.ts:mergePackage(ecosystem, name, isInternal, commitHash)`

Called by `graph-writer.ts` during the manifest-ingestion pass. Each entry in a
`dependencies` / `devDependencies` block produces one `:Package` node and one
`:DEPENDS_ON` edge from the declaring component (Service / Library / Repository).

```cypher
MERGE (p:Package {id: 'cr:package:npm:lodash'})
  ON CREATE SET p.valid_from_commit = $commitHash
  SET p.name = 'lodash',
      p.ecosystem = 'npm',
      p.isInternal = false
```

The `isInternal` flag is monotonic: once any consumer of the same package
declares it internal (`true`), the value sticks. This handles the case where a
monorepo first sees `@lib/health` as an external string in a consumer's
`package.json` (`isInternal: false`) and later sees its own published workspace
(`isInternal: true`); the truer answer wins idempotently.

---

## 7. When a Library is also a Package

This is the most subtle case. A workspace you author (a `:Library` node) can
*also* be published to a registry and consumed by other repositories that
declare it in their manifest (producing a `:Package` node).

In the graph they remain **two separate nodes**:

| | `:Library` | `:Package` |
|---|---|---|
| URN | `cr:library:health` | `cr:package:npm:@lib/health` |
| Source | autodiscovery of `libs/health/` | parsing of `dependencies` in some consumer's `package.json` |
| What it knows | source files, functions, controllers, modules | name, ecosystem, latest known version |
| What it doesn't know | publish version, registry | source code, function-level edges |

The welding link is two-step, going through the Repository node:

1. `:Library -[:STORED_IN]-> :Repository` records the workspace's host repo.
2. `:Repository -[:PUBLISHES]-> :Package` records that this repo publishes the
   package (set by the package-release extractor when it matches a workspace's
   `package.json` name to a `:Package` URN).

The `:Package.isInternal === true` flag is the predicate to filter
"published-by-us" dependencies. The `:Package.sourceRepoName` property carries
the qualified repo name for fast traversal without the join.

Cross-repo query pattern to follow a consumer's dependency all the way to the
producing source code:

```cypher
MATCH (consumer:Service)-[:DEPENDS_ON]->(p:Package {isInternal: true})
MATCH (repo:Repository)-[:PUBLISHES]->(p)
MATCH (lib:Library)-[:STORED_IN]->(repo)
WHERE lib.name = p.name
RETURN consumer.name, repo.name, lib.name, p.publishRegistry
```

The two-node design is intentional: the consumer cares about a declared
dependency contract (`requiredVersion`, `isDev`), independent of whether the
producing source has been ingested yet. The producer cares about the source
graph it owns. The Repository is the welding point. Publication is a
repo-level act (a `package.json` lives in a repo), not a workspace-level one.

---

## 8. Common questions

### Q. Why does my NestJS controller appear under `:Library` instead of `:Service`?

Because the workspace it lives in (`libs/{name}/`) declares no `NestFactory.create`
/ `bootstrap()` call. The TypeScript plugin's `runtimeServiceSignals` did not
fire ⇒ topology defaulted to `:Library` (the safer choice). The HTTP endpoint
is correctly extracted via the `@Get()` decorator and edged from the Function;
the runtime consumer is `apps/api/` (the `:Service` that imports the module).

To override:

```yaml
# coderadius.yaml
components:
  - name: health
    type: service
```

Catalog-declared `type: 'service'` wins over the autodiscovery inference.

### Q. I see `:Package {isInternal: true}` AND `:Library` with the same name. Bug?

No. They model two different facts:

- `:Library` = your source-of-truth workspace
- `:Package {isInternal: true}` = the dependency-graph appearance of the published artifact

The two are welded indirectly through the publishing repository
(`:Library -STORED_IN-> :Repository -PUBLISHES-> :Package`); see §7 for the
query pattern.

### Q. Why is the Library URN not scoped by repository?

By design: a published library should map to a single canonical identity in the
knowledge graph regardless of which repo's clone we ingested. If you maintain
two unrelated libraries that happen to share a name, that is a real-world naming
collision that should be resolved at the source (rename or scope under an npm
org). The graph reflects what the manifests declare.

### Q. Where does `:Package.latestKnownVersion` come from?

Populated by the `package-publisher` structural plugin
(`src/ingestion/structural/plugins/package-publisher.plugin.ts`) from
one of: manifest sighting (lowest confidence), git tag, package-registry API,
or webhook (highest). The provenance is recorded in `latestKnownConfidence`.

---

## 9. Quick decision tree

When you encounter a node whose label is ambiguous:

```
Does the URN start with "cr:library:"?
  └─ yes → :Library — own code, has Functions
Does the URN start with "cr:package:"?
  └─ yes → :Package — declared dependency, no source
Does the node have an :ecosystem property?
  └─ yes → :Package (always)
  └─ no  → :Library (always)
Does the node have outgoing :CONTAINS edges to :Function?
  └─ yes → :Library
  └─ no  → :Package
```

---

## 10. Cross-references

- Service-level identity & catalog welding: [`service-topology.md`](./service-topology.md)
- File routing rules in monorepos: `src/ingestion/processors/code-pipeline/file-discovery.ts:getMonorepoRouting`
- Topology classification decision tree: `src/ingestion/extractors/autodiscovery.ts:187-203`
- Package release timeline & welding: `src/graph/mutations/packages.ts` (`mergeRelease`, `mergePackage`)
- Canonical edge inventory: `src/graph/schema.ts:23-101`
- Domain schemas: `src/graph/domain.ts:LibrarySchema`, `PackageSchema`
