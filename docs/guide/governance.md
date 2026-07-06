# Governance

Governance in CodeRadius is a rule engine: each rule is a YAML file wrapping a Cypher query, run against your architecture graph. Unlike a file linter, a rule can see the whole topology (which team owns a repository, which services expose an API, which repos have a CI test stage) because that's exactly what's in the graph. Checks that need cross-service or cross-repo context ("every service with a public API has an on-call team", "every repo has a test stage") are one query away instead of unbuildable in a per-file linter.

`cr policy verify` runs the rules and reports the result. With `--output graph` it also persists the result as `:PolicyEvaluation` nodes so the dashboard and later runs can read compliance history.

---

## Mental model

A rule's query does not filter down to violations. It evaluates **every entity in scope** and returns one row per entity, tagged `pass` or `fail`. The engine partitions the rows by that tag afterward.

```
1. Load rules       → built-in packs, or a path/pack you name with --rules-path
2. Run each query   → read-only, sandboxed, one row per evaluated entity
3. Validate rows     → entityId/entityName/entityType/status/detail required
4. Partition         → status='fail' → violations, status='pass' → compliant
5. Report / persist  → table/json/sarif to stdout, or PolicyEvaluation nodes to the graph
```

A rule that returns only failing rows is a bug, not a stricter check: the engine can no longer tell how many entities were actually evaluated, so the compliance percentage it computes is meaningless. Every rule must return the full entity population it targets, with `status` doing the pass/fail split:

```cypher
RETURN entityId, entityName, entityType,
       CASE WHEN <condition> THEN 'fail' ELSE 'pass' END AS status,
       ...
```

Do not `WHERE`-filter out compliant entities. If you do, `totalEvaluated` under-counts and the compliance percentage is meaningless.

---

## Rule schema

```yaml
id: acme-service-team-owner
name: Every service has a team owner
description: >-
  Services without a declared owning team have no one to page when they break.
level: error          # error | warning | note
scope: service        # repository | service | team | package | any
failFast: false        # optional, default false
tags:
  - ownership

query: |
  MATCH (s:Service)
  WHERE s.valid_to_commit IS NULL
  OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
  WITH s, collect(t.name) AS owners
  RETURN
    s.id      AS entityId,
    s.name    AS entityName,
    'Service' AS entityType,
    CASE WHEN size(owners) = 0 THEN 'fail' ELSE 'pass' END AS status,
    CASE WHEN size(owners) = 0 THEN 'No owning team declared' ELSE '' END AS detail
```

### Required fields

| Field | Type | Description |
|-------|------|--------------|
| `id` | string | Unique, kebab-case (`^[a-z][a-z0-9-]*$`). Used to build evaluation URNs. |
| `name` | string | Human-readable name shown in the dashboard. |
| `level` | `error` \| `warning` \| `note` | Impact of a violation: `error` is CI-blocking, `warning` is strongly recommended, `note` is informational. |
| `scope` | `repository` \| `service` \| `team` \| `package` \| `any` | The node type this rule targets. Used for grouping in reports; not enforced against `entityType`. |
| `query` | string | A read-only Cypher query returning the [query contract](#the-query-contract) columns. |

### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|--------------|
| `description` | string | none | Explanation of what the rule enforces and why. |
| `failFast` | boolean | `false` | If `true`, stop evaluating remaining rules once this rule produces any violation. |
| `tags` | string[] | `[]` | Filtering/grouping tags. Used by `--tag` and by `cr policy prune`'s pack-scoped reaping. |

A rule missing `level` or with an unrecognized value fails schema validation and is skipped at load time with a logged warning. It never reaches the report.

---

## The query contract

Every rule's Cypher query **must** return these columns:

| Column | Required | Type | Description |
|--------|----------|------|--------------|
| `entityId` | yes | string | The evaluated node's URN, e.g. `s.id`. |
| `entityName` | yes | string | Display name, e.g. `s.name`. |
| `entityType` | yes | string | The node's label (`'Repository'`, `'Service'`, ...). Used as the Cypher label when persisting the evaluation edge; not checked against `scope`. |
| `status` | yes | `'pass'` \| `'fail'` | The evaluation result for this entity. |
| `detail` | yes | string | Human-readable explanation. Required even for `pass` rows (it may be an empty string there, but the column itself must be present). |
| `structuredDetail` | no | map | Itemized checklist for rich rendering (see below). |

Rows that don't satisfy this shape are dropped with a warning; one malformed row does not fail the whole rule. If `structuredDetail` fails its own validation, it is dropped and the row falls back to plain `detail`. The rest of the row still counts.

### Structured detail

For rules that check several conditions per entity, return a `structuredDetail` map instead of (or alongside) prose:

```cypher
RETURN
  // ... standard columns ...
  { checks: checks, found: targets } AS structuredDetail
```

| Key | Type | Description |
|-----|------|--------------|
| `checks` | `[{ label: string, status: 'pass' \| 'fail' \| 'warn' }]` | One row per condition, rendered as a checklist. |
| `found` | `string[]` | The actual items detected on the entity. Carried through the pipeline; not currently used for anything beyond that (no fuzzy matching is implemented, so pass a plain array or omit it). |

A bare `checks` array (no `found`) is also accepted and wrapped automatically.

### Real example

The shipped `ar-makefile-targets` rule (below) requires a Makefile with `setup`, `test`, and `run` targets and renders a three-item checklist:

```cypher
MATCH (r:Repository)
WHERE r.valid_to_commit IS NULL
OPTIONAL MATCH (r)-[:HAS_TASK]->(t1:Task)
  WHERE coalesce(t1.taskOrigin, t1.source) = 'makefile'
OPTIONAL MATCH (svc:Service)-[:STORED_IN]->(r)
  WHERE svc.valid_to_commit IS NULL
OPTIONAL MATCH (svc)-[:HAS_TASK]->(t2:Task)
  WHERE coalesce(t2.taskOrigin, t2.source) = 'makefile'
WITH r, collect(DISTINCT t1.name) + collect(DISTINCT t2.name) AS rawTargets
WITH r, [x IN rawTargets WHERE x IS NOT NULL] AS targets
WITH r, targets,
  [x IN ['setup', 'test', 'run'] WHERE NOT x IN targets] AS missing,
  [x IN ['setup', 'test', 'run'] | { label: x, status: CASE WHEN x IN targets THEN 'pass' ELSE 'fail' END }] AS checks
RETURN
  r.id AS entityId,
  r.name AS entityName,
  'Repository' AS entityType,
  CASE WHEN size(missing) = 0 THEN 'pass' ELSE 'fail' END AS status,
  CASE
    WHEN size(missing) = 0 THEN 'Makefile defines setup, test, and run.'
    WHEN size(targets) = 0 THEN 'No Makefile targets found. Add setup, test, and run.'
    ELSE 'Makefile missing targets: ' + reduce(a = '', x IN missing | a + CASE WHEN a = '' THEN '' ELSE ', ' END + x)
  END AS detail,
  { checks: checks, found: targets } AS structuredDetail
```

Note the `coalesce(t.taskOrigin, t.source)`: `Task.source` was renamed to `taskOrigin` in the domain schema. The coalesce keeps the rule working across both.

---

## Built-in packs

CodeRadius ships one built-in pack, `agent-readiness`, checking whether a repository gives a coding agent enough to work safely and independently:

| Rule | Level | Checks |
|------|-------|--------|
| `ar-tests-present` | error | A CI pipeline with a test stage exists. |
| `ar-makefile-targets` | warning | A Makefile exposes `setup`, `test`, `run`. |
| `ar-codeowners` | warning | At least one team owns the repository (directly or via a service stored in it). |
| `ar-rules-validated` | warning | An agent rules file exists (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, or similar). |
| `ar-skills-coverage` | warning | At least one reusable agent skill is defined. |
| `ar-context-actionable` | warning | Agent context files carry actionable tooling commands, not just prose overview. |
| `ar-context-minimal` | warning | Agent context files aren't oversized (empirically, over-long context raises agent step count and cost without improving task success). |
| `ar-architecture-context` | warning | Cross-service context (APIs, events, shared data) is documented, not just internal file layout. |
| `ar-blast-radius` | warning | A code-pipeline scan (`semantic` or `contracts` depth) has run, so blast radius is computable. |

`cr policy verify` with no `--rules-path` runs this pack. It also runs automatically as a post-ingestion step ("Evaluating Governance Policies") after every `cr analyze code`, writing straight to the graph.

To customize: `cr policy export agent-readiness` copies the pack's YAML files into `.coderadius/policies/agent-readiness/`. Local copies there take priority over the built-in versions on the next run. Edit thresholds, delete rules you don't want, or add new ones alongside them.

---

## Rule resolution order

`--rules-path <path>` accepts a file, a directory, or a bare pack name, resolved in this order:

1. The path itself, if it exists as a file or directory.
2. `.coderadius/policies/<path>` for your local override/export location.
3. The built-in packs directory on disk (source checkouts / dev runs).
4. An embedded snapshot compiled into the binary (release builds don't ship the pack YAML files on disk).

With no `--rules-path` at all, every built-in pack loads (currently just `agent-readiness`).

---

## Running verification

```bash
cr policy verify [options]
```

| Flag | Default | Description |
|------|---------|--------------|
| `--rules-path <path>` | built-in packs | File, directory, or pack name. See resolution order above. |
| `--output <mode>` | `table` | `table` (terminal), `json` (full report), `sarif` (GitHub/GitLab SAST), `graph` (persist to Memgraph, print a one-line summary). |
| `--fail-on <level>` | `error` | Exit 1 if any violation at or above this level exists (`error`, `warning`, `note`). |
| `--tag <tag>` | none | Only run rules carrying this tag. |
| `--min-level <level>` | none | Only run rules at or above this level. |
| `--timeout <ms>` | `5000` | Per-query timeout (a DoS guard against runaway Cypher, not a performance knob to raise casually). |
| `--out <file>` | stdout | Write the rendered report to a file. |

Persistence to the graph (`:PolicyEvaluation` nodes) happens **only** with `--output graph`. `table`, `json`, and `sarif` never write to the database.

Rule queries are also rejected at load time if they contain a write clause (`CREATE`, `MERGE`, `DELETE`, `REMOVE`, `SET x =`, `DETACH DELETE`). A rule that tries to mutate the graph is dropped with a warning before it ever runs, on top of running against a read-only database user.

```bash
# Built-in packs, human-readable table
cr policy verify

# Persist agent-readiness results into the graph
cr policy verify --tag agent-readiness --output graph

# CI: fail on warnings too, write SARIF for the code-scanning tab
cr policy verify --fail-on warning --output sarif --out results.sarif
```

---

## Removing rules

There is no automatic garbage collection when a rule disappears from a pack. Tags are many-to-one, so a tag alone can't safely identify "everything that belonged to this pack" without risking deletion of an unrelated rule sharing the tag. Removal is explicit:

```bash
# Dry run: what would cr policy prune remove for this pack?
cr policy prune --rules-path ./policies/acme-pack/

# Delete specific rules and their persisted evaluations
cr policy prune ar-tier-declared --force
```

`cr policy prune` is dry-run by default; pass `--force` to actually delete. Pack-scoped pruning only reaps rule ids that both (a) are no longer present in the loaded pack and (b) share a tag with it. An untagged pack reaps nothing.

---

## The graph model

### `PolicyEvaluation`

One node per (rule, entity) pair, written only in `--output graph` mode:

| Property | Description |
|----------|--------------|
| `id` | `cr:eval:{ruleId}:{entityId}` |
| `ruleId`, `ruleName`, `level`, `scope` | Denormalized from the rule. |
| `status` | `'pass'` \| `'fail'`. |
| `entityId`, `entityName`, `entityType` | The evaluated node. |
| `detail` | Explanation string. |
| `structuredDetail` | JSON-serialized checklist, when the query returned one. |
| `tags` | CSV of the rule's tags. |
| `evaluatedAt` | ISO timestamp of this run. |

Linked to its entity as `(entity)-[:EVALUATED]->(pe:PolicyEvaluation)`.

### `PolicyRule`

A catalog node per rule, so 100%-passing rules stay visible in the dashboard instead of disappearing along with their (nonexistent) violations: `id`, `name`, `description`, `level`, `scope`, `tags`, `lastEvaluatedAt`, `evaluatedCount`, `compliantCount`, `violationCount`, `ok`, `error`, `query`.

Both node types carry a unique constraint on `id`.

### Lifecycle: full replace

Each `--output graph` run pre-cleans before writing: every existing `PolicyEvaluation` for the rule IDs about to be re-evaluated is deleted, then the fresh batch (pass + fail) is written. The graph always reflects the latest run for those rules with no stale evaluations or `isActive` flag bookkeeping.

### Querying evaluations directly

```cypher
-- Compliance summary per rule
MATCH (pe:PolicyEvaluation)
RETURN pe.ruleName AS rule,
       count(CASE WHEN pe.status = 'pass' THEN 1 END) AS passing,
       count(CASE WHEN pe.status = 'fail' THEN 1 END) AS failing,
       count(pe) AS total
ORDER BY failing DESC
```

```cypher
-- All violations for a specific repository
MATCH (r:Repository {name: 'acme-inventory'})-[:EVALUATED]->(pe:PolicyEvaluation)
WHERE pe.status = 'fail'
RETURN pe.ruleName, pe.level, pe.detail
```

```cypher
-- Fully compliant entities (pass every rule evaluated against them)
MATCH (entity)-[:EVALUATED]->(pe:PolicyEvaluation)
WITH entity, collect(pe.status) AS statuses
WHERE NOT 'fail' IN statuses
RETURN entity.name AS entity, size(statuses) AS rulesEvaluated
ORDER BY entity.name
```

---

## Where evaluations appear

`cr ui` has a Governance section with two views:

- **Repository compliance**: one row per entity, with a `/100` compliance score, a `passed/evaluated checks` count, a segmented bar (green = passing, yellow = "N drifts" for warning-level violations, red = "N violations" for error-level, cyan = "N advisories" for note-level), and an expandable drawer listing every violation with its checklist. Entities with zero violations show `all passing` instead of the bar.
- **Policy catalog**: one row per rule, with its own compliant/evaluated ratio, so a rule that's 100% compliant is still visible in the catalog instead of vanishing along with its absent violations.

The drawer for a given entity shows failing rules first (grouped, with the checklist if `structuredDetail` was returned) and a collapsed `COMPLIANT (n)` section for the passing rules underneath.

---

## Further reading

- [CLI Reference](./cli-commands.md): full `cr policy verify` / `prune` / `export` flag reference
- [Architecture Dashboard](./explore/architecture-dashboard.md): where governance results render
- [coderadius.yaml](./coderadius-yaml.md): per-repository configuration that rules can read
