# Grounding & Trust Tiers

The graph is built from several kinds of evidence: a deterministic AST parse, an LLM call, a customer declaration in `coderadius.yaml`, a live infrastructure snapshot. Those are not equally trustworthy. Pretending they are, with a single blended "confidence" number, hides the thing you actually need to know when you're staring at a node: is this a fact, or a guess? Grounding is how CodeRadius tags every node and edge with three answers: who produced this fact, what supports it, and how much to trust it.

## The Mental Model: Three Questions Per Fact

- **Source**: Who said it. One of seven categorical values: `ast`, `heuristic`, `llm`, `composite`, `declared`, `infra`, `runtime`.
- **Evidence**: What supports it. A structured object: which extractors fired (`evidence.extractors`), which LLM calls contributed (`evidence.llmCalls`), which sanitizer fallbacks ran (`evidence.fallbacksApplied`), which predecessor nodes were merged in (`evidence.mergedFrom`).
- **Quality**: How much to trust it. A five-tier ladder from Verified down to Guess.

Quality is **assigned** by an explicit rule per pipeline step, never derived from probability math. This replaces an earlier `confidence: float` model. The reason is simple: a `0.8` from an AST extractor and a `0.8` from an LLM call are not the same kind of `0.8`, and multiplying floats along a chain of inferences produces numbers that look precise and are quietly wrong. Categorical tiers don't compound. They're just facts about which pipeline path produced this node.

## The 5 Quality Tiers

Every inferred entity (`MessageChannel`, `DataContainer`, `APIEndpoint`, ...) carries one of these. On the dashboard it's a colored dot.

| Dot | Label | Internal id | Meaning |
|---|---|---|---|
| ● green | **Verified** | `exact` | Direct evidence in code or contract. The strongest tier. |
| ● light green | **Strong** | `high` | Confirmed by multiple independent analyses. |
| ● amber | **Probable** | `medium` | Single source, plausible. |
| ● orange | **Weak** | `low` | Inferred from indirect evidence. |
| ● red | **Guess** | `speculative` | No direct evidence. Treat with skepticism. |

The internal id is what CLI flags accept (e.g. `--quality-at-least medium`).

## The 7 Source Types

The dot says *how much* to trust; the source says *how the fact was established*.

| Internal id | Label | How to read it |
|---|---|---|
| `ast` | Static code analysis | Parsed directly from source: a decorator, a function signature, a deterministic config walk. |
| `heuristic` | Naming heuristic | Pattern-matched on a file or symbol name. The weakest static signal. |
| `llm` | LLM inference | Extracted by a language model from code semantics, with no static cross-check. |
| `composite` | Cross-verified | Multiple independent analyses agree. |
| `declared` | Declared in catalog | Asserted by `coderadius.yaml` or a service catalog entry. |
| `infra` | Infrastructure match | Confirmed by a live infrastructure snapshot (RabbitMQ admin API, K8s, Terraform state). |
| `runtime` | Runtime trace | Observed in production traffic (OTel span). |

`runtime` is real in the enum and in the UI's palette, but no code path in the engine assigns it today. There is no `runtimeGrounding()` builder. It's reserved for when OTel trace ingestion lands; until then you will never see a `runtime`-sourced node in your graph.

## What Drives the Tier?

The engine assigns quality by which pipeline path produced the fact:

| If the fact came from | Source | Quality |
|---|---|---|
| Pure AST extraction (decorator, function signature, deterministic config walk) | `ast` | Verified |
| `coderadius.yaml` declaration | `declared` | Verified |
| A naming/pattern heuristic with no AST cross-check | `heuristic` | Probable (default; can be demoted to Weak) |
| Static analyzer + registry hit agree | `composite` | Strong |
| LLM extraction with full static context in the prompt, static analysis agrees | `composite` | Strong |
| LLM extraction with weak static context | `llm` | Probable |
| LLM extraction surviving only sanitizer guards by exclusion | `llm` | Weak |
| Sanitizer applied a fallback (env-stem normalize, name promotion) | source unchanged | demoted one tier |
| Welder merged two predecessors | `composite` if sources differ | min(predecessors) |
| Infrastructure snapshot match (e.g. OSV.dev CVE enrichment) | `infra` | Strong |
| Runtime trace match | `runtime` | not wired. No producer exists yet. |

Cross-source composite promotion is capped at Strong: two sources agreeing is stronger evidence than either alone, but it doesn't get promoted all the way to Verified. In practice, Verified is reached by exactly two builders today: pure AST reads and `coderadius.yaml` declarations. The engine's own composite-cap comment also lists `infra` and `runtime` alongside those two as "single-source ground truth," but neither builder actually assigns Verified. The `infra` builder tops out at Strong on purpose (the code comment: *"curated, not speculative... rather than exact, reserved for deterministic AST reads"*), and `runtime` has no builder at all. Treat Verified as an AST/declared-only tier until that's wired up.

## Where You See It

### Dashboard

**Graph cards** (the radial blast-radius view): each inferred node has a small colored dot in its bottom-right corner. Cluster supernodes show the *worst* quality among their members, with a tooltip reading "worst in cluster."

**Popover** (single-click a node): a one-line composed marker consisting of tier word, trailing dot, then `· ` and the source label (e.g. `Probable ● · LLM inference`).

**Inspect drawer** (click a node to open the full panel): a **Data quality** section (not "GROUNDING" - that ML term is for code, Cypher, and this doc, not the UI). Quality and Source are two separate rows, not one mashed-together line. The Quality row reads `tier ●` with the last-seen commit right-aligned on the same row, and hovering the tier or the dot shows the tagline. Below that, only when present: Extractors, Sanitizers (fallbacks applied), Welded from (merged predecessor IDs), LLM call count. If `needsReview` is set, a "Needs review" chip appears in the section header.

### Suppressed on structural entities

The dot is hidden by default on the structural family: labels that are uniformly `ast`/Verified because they're direct AST artefacts. These include `Repository`, `Service`, `SourceFile`, `Function`, `Class`, `Package`, `Release`, `ProjectDirectory`, `StructuralFile`, `Team`, `TeamAlias`, `Library`, `System`, `Domain`, `Link`, `CIComponent` (plus a matching set of structural edge types: `CONTAINS`, `HAS_ENDPOINT`, `PART_OF`, `OWNS`, `OWNS_REPOSITORY`, `DEFINES`, `HAS_LINK`, `INCLUDES_COMPONENT`). Showing a dot on every file and function would drown out the decision-relevant tiers on the entities that actually vary.

## Operator Workflows

### See the trust distribution after a sync

`cr analyze code` prints a grounding breakdown at the end, but only when at least one inferred node exists. On a fresh database or a structural-only run (no message channels, no data structures, nothing inferred yet) the block is skipped entirely.

```
  GROUNDING
  ──────────────────────────────────────────────────────────────────────────
  Entity          │ exact │ high │ medium │ low │ speculative │ review
  MessageChannel  │     3 │    1 │      1 │   0 │           0 │      0
  DataContainer   │     7 │    4 │      2 │   1 │           0 │      1
  APIEndpoint     │    27 │    0 │      0 │   0 │           0 │      0
```

(Non-zero counts render cyan, zeros dim; a non-zero review count renders yellow.) The full set of labels this table can show: `MessageChannel`, `DataContainer`, `Datastore`, `APIInterface`, `APIEndpoint`, `DataStructure`, `Cache`, `Database`, `SystemProcess`. There is one row per label, printed even at zero, so the shape is stable across runs.

### Triage flagged entities

```bash
cr doctor
cr doctor --label MessageChannel
cr doctor --quality-at-least medium --source llm
```

Lists every node with `needsReview = true`, grouped by label, with a concrete reason and a concrete suggestion for each. These are derived from the extractor tags on the node, not a generic "low confidence" shrug:

```
MessageChannel (1)
  order.created                                       llm/medium
    → Multiple brokers bind to the same channel
      Pin the intended broker in `coderadius.yaml.messageBrokers`.
```

Filters:
- `--label <name>`: Restrict to one label. `cr doctor`'s label set is slightly wider than the breakdown table above; it adds `SourceFile`, `MessageBroker`, and `BrokerCandidate`. That means a `SourceFile` can legitimately show up here even though it's elsewhere always `ast`/Verified and dot-suppressed: a structural-plugin extractor can flag one specific file for review (an ambiguous Symfony Messenger dynamic-routing case, for example). `BrokerCandidate` entries exist *only* to be reviewed. They are unconfirmed broker guesses that nothing has grounded yet.
- `--quality-at-least <tier>`: keep entities at or above the given tier (`exact` ≥ `high` ≥ `medium` ≥ `low` ≥ `speculative`).
- `--source <s>`: keep entities whose source matches. Repeat the flag for multiple sources.

Nothing here mutates the graph. It's a read-only triage view. You either accept the inference, fix the source code so a static extractor catches it, or declare the entity in `coderadius.yaml` to promote it.

There's also a `findDisputed()` query (`src/graph/queries/grounding.ts`) that flags nodes where the evidence trail shows both an LLM extractor tag and a deterministic extractor tag, yet `source` still resolved to `llm`. This means the static signal was present but didn't win. It's not wired to a CLI command yet; today it's a library function for anyone building tooling on top of the query layer.

### Filter coverage diagnostics

```bash
bun run scripts/diag-graph-coverage.ts --quality-at-least high
bun run scripts/diag-graph-coverage.ts --source ast
bun run scripts/diag-graph-coverage.ts --repo my-repo --source llm
```

Same filter vocabulary as `cr doctor`. Useful for:
- "Show me only what I should trust" → `--quality-at-least high`.
- "Show me what the LLM inferred, so I can sanity-check it" → `--source llm`.
- "Show me the deterministic baseline" → `--source ast`.

## Inspecting an Entity's Evidence

The Inspect Drawer's Data quality section, expanded, shows:

- The tier's tagline (hover the tier word or dot), e.g. "Direct evidence in code or contract."
- The source's detail line (hover the source label), e.g. "Parsed directly from source: decorator, function signature, AST walk."
- The extractor identities that contributed, e.g. `symfony-messenger-php@v1`, `unified-analyzer@v1`. Each is versioned, so a prompt or regex change produces a new identity and old entries stay queryable rather than silently reinterpreted.
- If the node was welded (merged with another node that described the same real-world thing), the predecessor URNs (Welded from).
- If a sanitizer fallback fired, its name (Sanitizers). For example, `env-var-stem-normalize` canonicalizes `acme.inventory{envSuffix}.X.Y` down to `acme.inventory.X.Y`. Any fallback demotes quality by exactly one tier.

## FAQ

**Why categorical and not a percentage?**

Because a `0.8` from an AST extractor and a `0.8` from an LLM mean different things, and multiplying them along a chain of inferences produces silently-wrong math. Categorical tiers are explicit per-pipeline assignments, not derived statistics.

**Can I override the tier on a specific entity?**

Yes. Declare it in `coderadius.yaml`. A catalog-asserted entity gets `source: declared, quality: exact` (Verified) and overrides whatever the engine inferred.

**Why is everything in my graph "Verified"?**

You probably just synced a well-typed codebase with OpenAPI specs, decorators, and config files that the AST extractor reads directly. That's the happy path. The decision-relevant tiers (Probable, Weak, Guess) show up once the engine has to infer from ambiguous code.

**Why is everything "Probable"?**

The codebase has weak static signals: no decorators, no config files, and no contracts. So the LLM is doing most of the inference. Declare the canonical entities in `coderadius.yaml` to promote them to Verified.

**The `needs-review` count is large. What now?**

Run `cr doctor`. Every item comes with a concrete reason and suggestion (see above). If a tag isn't recognized yet, you'll get a generic "low confidence, here's the raw extractor tag" fallback instead of nothing. One specific tag worth knowing: `untagged@v1` means a graph mutation ran without a grounding argument, so it fell back to the defensive `heuristic`/`speculative`/`needsReview=true` default. Find them with `evidence_extractors CONTAINS 'untagged@v1'`. This is an internal tagging gap, not a data problem, and safe to ignore beyond reporting it.
