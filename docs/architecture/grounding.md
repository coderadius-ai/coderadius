# Grounding, Evidence, Quality

Every inferred node and every inferred edge in the CodeRadius graph carries a structured **grounding** block answering three orthogonal questions:

| Question | Field | Type |
|---|---|---|
| Who produced this fact? | `source` | categorical enum |
| What supports it? | `evidence` | structured object |
| How much should I trust it? | `quality` | categorical enum |

The model replaces the legacy `confidence: float` field. Floats compound badly along path computations, do not survive LLM model upgrades, and answer none of the three questions independently. The categorical model is the operator-facing contract for the dashboard, the `cr doctor` triage queue, and the `--quality-at-least` / `--source` filters across the CLI.

---

## The Vocabulary

The categorical enums and pure-type interfaces are exported by the `@coderadius/shared-types` package so the CLI backend and the dashboard frontend agree at compile time. The backend wraps them in zod schemas + builder functions; the dashboard wraps them in UI-only palette / label maps.

| File | Owner | Contents |
|---|---|---|
| `packages/shared-types/grounding.ts` | shared | enums, types, `QUALITY_RANK`, `qualityAtLeast`, `isStructuralFamily` |
| `src/graph/grounding.ts` | backend | zod schemas, builders (`astGrounding`, `llmGrounding`, ...), `mergeEvidence`, `flattenGrounding` |
| `packages/dashboard-ui/src/types/grounding.ts` | frontend | `QUALITY_META` (colors + labels), `SOURCE_META` (labels + details) |

### `source` (7 values)

Who or what produced the fact. Stable across LLM model upgrades.

| Source | Meaning |
|---|---|
| `ast` | Direct AST read (decorator, function signature, deterministic config parse). No inference. |
| `heuristic` | Pattern matched (file naming, symbol convention). Weak signal. |
| `llm` | Produced by an LLM call without a static cross-check. |
| `composite` | Multiple sources concord (e.g. AST + LLM, or registry lookup hit). |
| `declared` | User asserted in `coderadius.yaml` or service catalog. |
| `infra` | Confirmed by a real infrastructure snapshot (RabbitMQ admin, K8s, Terraform state). |
| `runtime` | Confirmed by OTel / runtime trace observation. |

### `quality` (5 values)

Categorical tier of trust. **Assigned by explicit per-pipeline rules**, never derived via probability math.

| Quality | Dashboard label | Meaning |
|---|---|---|
| `exact` | **Verified** | Direct evidence in source or contract. Decorator, OpenAPI spec, declared catalog entry. |
| `high` | **Strong** | Multiple extractors agree. Composite of AST + LLM with concord. |
| `medium` | **Probable** | Single signal, plausible. LLM-only extraction with clean sanitizer pass. |
| `low` | **Weak** | Inferred from indirect evidence. LLM-only with marginal signals. |
| `speculative` | **Guess** | No direct evidence. Surfaced only when the engine had to invent something. |

The 5-tier ladder enables `qualityAtLeast(value, threshold)` filtering: a value of `exact` is at least `high` (passes); a value of `medium` is not (fails).

### `evidence` (structured object)

Inspectable record of what supports the fact:

```ts
interface Evidence {
    extractors: string[];          // versioned identities of every pass that contributed
    llmCalls?: LlmCallEvidence[];  // { model, promptHash, timestamp } for each LLM hop
    fallbacksApplied?: string[];   // 'env-var-stem-normalize', 'cqrs-suffix-fallback', ...
    mergedFrom?: string[];         // URNs of welded predecessors
}
```

Extractors carry a version suffix (`symfony-messenger-php@v1`) so a regex or prompt change creates a new identity, leaving stale entries queryable for later sweeps.

### Operational flags

- `needsReview: boolean`: explicit human-triage flag. Operational signal, **not derived from quality**. Surfaced by `cr doctor` and by the dashboard's "needs review" pill.
- `lastSeenCommit: string`: commit sha at which the fact was last reconciled against fresh code.

---

## Quality Assignment Rules

Quality is assigned by the producer or builder, never derived from a probability score. The rules:

| Pipeline path | source | quality |
|---|---|---|
| Pure AST extraction (provider, decorator, deterministic walk) | `ast` | `exact` |
| Static analyzer with criticalInvocation resolved via registry | `composite` | `high` |
| LLM extraction with resolved criticalInvocation context in prompt | `composite` | `high` |
| LLM extraction without criticalInvocation, name passes guards | `llm` | `medium` |
| LLM extraction surviving only sanitizer guards by exclusion | `llm` | `low` |
| Sanitizer transform applied (env-stem normalize, name promotion) | upstream `source` | `min(upstream, medium)` |
| Welder (suffix-dedup, cross-kind, class-name bridge) | `composite` | `min(merged inputs)` |
| `coderadius.yaml` declared | `declared` | `exact` |
| Infra snapshot match | `infra` | `exact` |
| Runtime trace match | `runtime` | `exact` |

Cross-source composite promotion is **capped at `high`**: `exact` is reserved for single-source ground truth (pure AST, declared, infra, runtime), never for cross-confirmation. Same-source merges preserve the original quality.

---

## Storage Layout

Memgraph does not store nested objects, so the `evidence` block is flattened onto the node / edge as 8 properties:

| Property | Type | Write strategy |
|---|---|---|
| `source` | string | overwrite (last writer wins) |
| `quality` | string | overwrite |
| `needsReview` | bool | overwrite |
| `lastSeenCommit` | string | overwrite |
| `evidence_extractors` | string[] | union + dedup (Cypher `reduce()`) |
| `evidence_fallbacksApplied` | string[] | union + dedup |
| `evidence_mergedFrom` | string[] | union + dedup |
| `evidence_llmCalls` | string[] | overwrite (each entry is `JSON.stringify(LlmCallEvidence)`) |

### Array dedup invariant (critical)

Memgraph's array `+` operator concatenates without dedup. A naive `SET node.evidence_extractors = coalesce(node.evidence_extractors, []) + $new` would balloon `['x', 'x', 'x', ...]` across re-syncs.

The shared Cypher template in `src/graph/mutations/_run.ts:groundingWriteClause()` uses `reduce()` to dedup atomically:

```cypher
SET node.evidence_extractors = reduce(_acc = [], _x IN
    coalesce(node.evidence_extractors, []) + coalesce($ground_extractors, [])
    | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)
```

The dedup runs unconditionally on every write (no branching on existence). Every mutation that touches a node must call `groundingWriteClause(alias)`; never inline the SET manually.

### `evidence_llmCalls` is NOT array-deduped in Cypher

LLM call evidence flattens to JSON strings (`{"model":"gemini","promptHash":"h1","timestamp":"..."}`). Two calls with the same `model` and `promptHash` but different timestamps serialize to **different strings**, so Cypher's IN-based dedup never matches them.

To prevent unbounded blob growth across re-syncs, `mergeEvidence()` and `flattenGrounding()` dedup llmCalls in TypeScript by `(model, promptHash)` and **cap retained entries at 10** (keeping the most recent). The Cypher write is "last writer wins" (no `reduce`) since the TS side already canonicalizes.

---

## Producer Contract

Every mutation in `src/graph/mutations/` accepts an optional `grounding: GroundingFields` parameter at the **end** of the positional argument list:

```ts
await mergeMessageChannelWithKind(name, kind, technology, commitHash, schemaPath, schemaFormat, tags, grounding);
```

If the caller omits the argument, the mutation stamps `UNTAGGED_GROUNDING`: a deliberately weak default (`source: 'heuristic'`, `quality: 'speculative'`, `needsReview: true`, extractor `'untagged@v1'`). This is a guardrail: an accidental untagged write **visibly degrades** the node and surfaces in `cr doctor` instead of masquerading as authoritative `ast/exact`. A warning is logged once per process.

Sweep target: `evidence_extractors CONTAINS 'untagged@v1'` lists every node that landed in the default so a later pass can assign a real extractor identity.

### Builders

The standard grounding constructors:

```ts
astGrounding('symfony-messenger-php@v1')
    // → source: 'ast', quality: 'exact', extractor stamped

llmGrounding('vertex/gemini-2.5-flash-lite', promptHash, 'unified-analyzer@v1', 'medium')
    // → source: 'llm', quality: 'medium', llmCalls populated

compositeGrounding(astProv, llmProv)
    // → source: 'composite', quality capped at 'high', evidence merged

applyFallback(prov, 'env-var-stem-normalize', 'envvar-resolver@v1')
    // → source unchanged, quality demoted one tier, fallbacksApplied stamped

weldGrounding(survivor, subordinate, subordinateId, 'cross-kind-weld@v1')
    // → source: 'composite', quality: min, mergedFrom appended with subordinate id
```

---

## Welder Ordering Invariant

The class-name bridge welder (`weldMessagePublishersByClass` in `src/graph/mutations/message-channels.ts`) and the cross-kind / suffix dedup welders (`dynamic-infra-resolver.ts`) all use `coalesce(canonical.X, placeholder.X)` semantics to carry over `technology` and `kindFamily` from the subordinate when the canonical lacks them.

**These welders must run strictly as post-processing passes**, after every per-file write that populates technology / kindFamily on either node. If the welder runs first, both nodes carry `null` technology and the survivor loses the trace.

Current ordering, enforced across `src/ingestion/workflows/code-ingestion.workflow.ts` and `src/ingestion/workflows/reconcile.workflow.ts`:

```
Stage 1: Generating Scope Filters
Stage 2: Populating Symbol Registry
Stage 3: Analyzing Codebase                ← per-file pipeline writes channels with full tech context
Stage 4: Resolving Infrastructure          ← resolveDynamicInfrastructure only
Stage 5: Synthesizing Architecture Graph
Stage 6: Reconciling Graph State           ← runReconcile() (reconcile.workflow.ts): welders run
                                              here (deduplicateBySuffix → byExactName → byClass)
```

`weldMessagePublishersByClass`, `deduplicateMessageChannelsBySuffix`, and `deduplicateMessageChannelsByExactNameDifferentKind` were moved out of Stage 4 into `runReconcile()`. The move is documented at the call sites in `dynamic-infra-resolver.ts` ("moved to `runReconcile()` so they fire..."). Do not move the welders earlier than the terminal reconcile step. The invariant is documented at the call site (`weldMessagePublishersByClass`) and the docstring forbids relocation.

---

## Reading Grounding

### Aggregator queries (`src/graph/queries/grounding.ts`)

```ts
countByQualityTier()
    // → one row per inferred label: { label, total, tiers: { exact, high, medium, low, speculative }, needsReview }
    // Used by `cr analyze code` final report and the dashboard chrome.

listNeedsReview({ label?, qualityAtLeast?, sourceIn? })
    // → triage list of nodes with needsReview=true (with optional tier / source narrowing).
    // Used by `cr doctor`.

findDisputed()
    // → nodes where source='llm' but evidence_extractors contains BOTH llm + a deterministic
    //   extractor (the LLM and a static signal disagree). Used to tune the resolver.
```

### Inferred-vs-structural distinction

The dashboard's `QualityBadge` is suppressed on the **structural family** (Repository, Service, SourceFile, Function, Class, Package, ...). These labels are uniformly `ast/exact` and would drown out the decision-relevant tiers (medium / low / speculative) on inferred entities.

The predicate `isStructuralFamily(label)` from the shared-types module is the single source of truth for this suppression rule. The inferred-set is the negation:

| Inferred family (badge visible) | Structural family (badge suppressed) |
|---|---|
| MessageChannel, DataContainer, Datastore, APIInterface, APIEndpoint, APIDeployment, DataStructure, Cache, DatabaseEndpoint, SystemProcess | Repository, Service, SourceFile, Function, Class, Package, Release, ProjectDirectory, StructuralFile, Team, TeamAlias, Library, System, Domain |

### Inferred edges

Grounding propagates onto inferred edges (`PUBLISHES_TO`, `LISTENS_TO`, `CALLS`, `READS`, `WRITES`, `CONSUMES_API`, `EXPOSES_API`, `IMPLEMENTS`, `DEPENDS_ON`, `STORED_IN`, `HAS_SCHEMA`, `ROUTES_TO`). Structural edges (`CONTAINS`, `HAS_ENDPOINT`, `PART_OF`, `OWNS`) are stamped trivially `ast/exact` and the dashboard suppresses their badge.

---

## Common Operator Workflows

### "Show me only high-trust entities"

```bash
bun run scripts/diag-graph-coverage.ts --quality-at-least high
```

Lists every inferred node whose quality is `exact` or `high`. Drops medium / low / speculative.

### "Show me the LLM-only attributions for a single repo"

```bash
bun run scripts/diag-graph-coverage.ts --repo core-service --source llm
```

Lists nodes where the LLM was the sole signal. Useful when verifying a regression after a model upgrade.

### "Triage entities the engine wants a human to look at"

```bash
cr doctor --label MessageChannel
cr doctor --quality-at-least medium --source llm
```

Lists every node flagged `needsReview = true`, optionally narrowed by label / quality / source.

### "Why is this MessageChannel `medium` instead of `high`?"

Open the inspect drawer on the dashboard. The Grounding section shows the dot + tier label + source label. The dot tooltip lists the descriptive tagline and the extractor identities. If the welder fired, `evidence_mergedFrom` will be populated; if a sanitizer fallback fired, `evidence_fallbacksApplied` will list the fallback name (e.g. `env-var-stem-normalize`).

---

## Migration Notes (pre-1.0 → 1.0)

The shared-types extraction (`packages/shared-types/grounding.ts`) eliminates the manual frontend mirror that existed in earlier pre-1.0 revisions. Future schema changes propagate to both halves at compile time.

**Not yet migrated** (acceptable pre-1.0):
- `TopologyNode.confidence: number` is kept alongside the new `quality` / `groundingSource` fields for graph view rendering (edge opacity, dashed treatment on weak edges). A future cleanup can branch those visual decisions on `quality` instead.
- The resolver (`src/ingestion/core/value-resolution/index.ts`) returns `confidence: number` on `ResolvedInvocationArg`. The result feeds the LLM prompt as text, so the grounding trace is recovered downstream by the graph-writer; the resolver itself does not yet emit `grounding: GroundingFields`.
- LLM cache refresh (`make test-eval-golden-refresh`) now always persists the freshly generated cache, even when tests fail; the `.llm-cache/*.jsonl` files are git-tracked, so `git diff` is the drift-inspection surface and `git checkout -- tests/eval/.llm-cache/` is the rollback.
