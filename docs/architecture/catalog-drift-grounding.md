# Catalog drift: grounded-identity reconciliation

`cr drift` reconciles a Backstage/Cortex catalog's **declared** facts against the
**code-observed** graph. The rule is simple and absolute:

> Drift is only asserted between facts that resolve to the **same real graph
> node**. Anything that cannot be grounded is **unverifiable**, never drift.

This replaced an earlier string set-diff that compared a declared ref's *name*
(`trust-me-api`) against an observed node's *title* (`trustme`). Those live in two
independent naming worlds and never matched, so the report invented drift. The
tempting fix, a normalizer that strips `-api` / dotted-FQN / case to force the
names equal, is a **heuristic = silent bug**: it quietly merges two distinct
entities or misses a renamed one, with no signal. We do not do that.

## The three states (dependencies)

For each declared `dependsOn` ref `d` on a service `S`:

1. **Resolve by exact identity.** Find the node `N` where
   `N.catalogName = d OR N.name = d`, among the labels a `dependsOn` can target:
   `Service | Library | Datastore | Cache | MessageBroker | MessageChannel`.
   A ref grounds only on a **single** match (ambiguous multi-matches stay
   unverifiable, mirroring `bindUnresolvedDependencies`). Refs are already
   syntax-parsed to bare names at ingestion (`normalizeDependencyRef` strips the
   Backstage `kind:ns/` prefix); no compare-time normalization happens.

2. Classify:
   | state | meaning | score |
   |---|---|---|
   | **aligned** | `d` resolves to `N` and `S` has the edge to `N` | none |
   | **grounded drift** (`groundedMissing`) | `d` resolves to `N` but `S` has no edge to `N` | counts |
   | **observed-undeclared** | `S` has an edge to an in-scope node no declared ref claims | counts |
   | **unverifiable** | `d` resolves to no node in scope | off-score |

**Ambiguity guard.** An observed edge is only reported as *observed-undeclared*
when **every** declaration on `S` resolved. If any declaration is unverifiable,
an unmatched observed edge might BE that declaration under a name we can't
resolve, so it is unverifiable, not drift. This is why, for a service whose
catalog refs are mostly cross-repo (out of scope), the intra-repo sibling edges
do not show up as false "undeclared" drift.

## API provides / consumes: dropped

There is **no grounded key** between a declared API ref and a code `APIInterface`:
catalog API entities in practice carry no `spec.definition` and no server URL, and
the API welders join on `(method, path)`, never on catalog refs. So the API
dimension is **not reported** rather than fabricated by string-matching.

**Re-introduction path:** when catalog API entities carry an OAS `spec.definition`
or a server URL, resolve `providesApis`/`consumesApis` to the code `APIInterface`
through the existing `(method, path)` welder identity (see
[api-endpoint-dedup.md](./api-endpoint-dedup.md)), then add the dimension back as
a grounded three-state comparison, identical to dependencies.

## Score and coverage

```
driftScore         = round((1 - entitiesWithGroundedDrift / (totalCatalogEntities + orphans)) * 100)
verifiableCoverage = round(verifiedFacts / (verifiedFacts + unverifiedFacts) * 100)
```

- Only entities with **grounded** drift (ghost, orphan, owner, system, grounded
  dependency drift) lower the score. Unverifiable facts are off-score: a service
  whose declarations we could not ground does not get punished for being out of
  scope.
- `verifiableCoverage` is the share of declared dependency facts we could actually
  ground. It makes the limited check-scope explicit on the same screen, so a high
  alignment score on a single-repo run is not mistaken for "everything checks out"
  when most refs were simply unverifiable. Unverifiable facts upgrade to
  aligned/drift automatically once the referenced repo is also ingested (the node
  then exists) or a grounded API key appears.

## Code map

- `src/graph/queries/drift-classify.ts`: pure, DB-free functions for `classifyDependencyDrift`,
  `computeDriftScore`, and `computeVerifiableCoverage`. Unit-tested.
- `src/graph/queries/drift.ts`: `getDependencyReconciliation` (resolve refs by
  exact identity, scan observed edges, classify) and `getCatalogDriftReport`
  (aggregate, score, coverage). Ghost/orphan/owner/system are unchanged grounded
  dimensions. `normalizeDependencyRef` is no longer used here (it stays in
  ingestion).
- `src/cli/commands/drift.ts`: renders the `Dependency Drift` (grounded) section,
  a dimmed off-score `Unverifiable` section, and the `Verifiable coverage` line.

## Tests

- Unit `tests/unit/graph/drift-queries.test.ts`: covers the classifier, score, and coverage logic.
- Integration `tests/integration/catalog-drift-grounding.test.ts`: tests graph to drift conversion,
  all five states plus score plus coverage, on a controlled graph.
- Eval pattern `tests/eval/patterns/catalog-drift-grounding/`: pins that a real
  `catalog-info.yaml` parses to the bare-name refs the resolver matches by.
