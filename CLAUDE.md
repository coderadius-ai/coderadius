# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

CodeRadius is a CLI tool that builds an architectural knowledge graph from polyglot codebases. It statically analyzes source code (TypeScript, PHP, Go, Python), extracts infrastructure dependencies via LLM-driven semantic analysis, persists everything to a Neo4j/Memgraph graph database, and enables cross-repo impact analysis ("blast radius") and governance policy enforcement.

## Build & Run Commands

**Runtime:** Bun (not Node.js for development). The project uses ES modules (`"type": "module"`).

```bash
bun install                # Install dependencies
bun run build              # TypeScript compilation (tsc, noEmit)
bun run dev                # Run CLI directly: bun run src/cli/index.ts
bun run dev:dashboard      # Dashboard dev server with live reload (http://localhost:3456)
```

### Testing

```bash
bun run test:unit                                    # All unit tests
bun vitest run tests/unit/path/to/file.test.ts       # Single unit test
bun run test:integration                             # Integration tests (requires running Memgraph)
make test-eval-golden      # Eval tests (LLM golden + replay-cached patterns)
make test-patterns         # Pattern fixtures, deterministic subset (no LLM, no DB)
```

The repo organises tests by determinism level and dependency footprint. Pick the right tier when adding a feature or fixing a bug:

- **Unit tests** (`tests/unit/`): pure logic, no external services. Defaults for sanitizer rules, schema validation, regex guards, in-memory pipelines. Run: `bun run test:unit` (~7s).

- **Integration tests** (`tests/integration/`): exercise real graph mutations against Memgraph. Required for any change to `src/graph/mutations/`, the welder (`dynamic-infra-resolver.ts`), or DB-backed pipelines. Run sequentially (no file parallelism). Run: `bun run test:integration` (~20s).

- **Eval tests — agents** (`tests/eval/agents/`): LLM extraction quality on per-function snippets, replay-cached. Use when a fix changes prompt rules, sanitizer behaviour visible to the LLM, or the LLM output schema. Three modes via `EVAL_LLM_MODE`:
  - `replay` (default): cached LLM outputs from `tests/eval/.llm-cache/`, ~2s, deterministic
  - `live`: real LLM calls, saves to cache
  - `refresh`: real LLM calls, overwrites cache

- **Eval tests — extraction goldens** (`tests/eval/extraction/`): the DB-free declarative coverage oracle. Each `<name>/expected.graph.yaml` is scored by ONE shared runner (`extraction.eval.test.ts`) that runs the full in-memory pipeline (`extractEphemeralTopology` + structural config merge) and gates at 90% precision/recall — nodes + edges + symbols, **exact** match, plus negatives. Add coverage by dropping `<name>/fixture/` + `<name>/expected.graph.yaml` (and a `<name>__heldout/` sibling with different names to catch overfitting) — **no per-fixture test code**. **This is the preferred tier for new language / framework / technology coverage** (routes, ORM, brokers, config): declarative, held-out-gated, mostly zero-LLM. Run: `make test-extraction` (or `bun vitest run tests/eval/extraction --config vitest.eval.config.ts`).

- **Eval tests — patterns** (`tests/eval/patterns/`): hand-written multi-file scenarios with **bespoke `it()` assertions** on things a declarative golden can't express — pipeline internals (grounding source/quality, `SymbolRegistry` contents, cross-file resolution decision paths, field required/optional flags) and multi-file structural resolution (Helm/Crossplane). Exercises the full static pipeline (imports, taint, plugin extraction, registry lookups). Typically deterministic (zero LLM calls). Prefer the **extraction** tier above for anything expressible as a graph golden; reach for `patterns/` only when the assertion is about internal state or needs multi-file structural context. Each pattern is a self-contained anonymised micro-repo:
  ```
  tests/eval/patterns/<name>/
    <name>.eval.test.ts              ← test, deterministic by default
    fixture/
      composer.json | package.json   ← language-appropriate manifest
      src/...                        ← anonymised PHP/TS files (acme/inventory only)
    expected.graph.yaml              ← optional, for LLM-replay variants
  ```
  Existing examples: `php-graphql-same-namespace`, `ts-taint-propagation`, `php-psr18-taint-propagation`, `php-symfony-messenger`. Run: `make test-patterns` (~5s, deterministic subset; replay-cached ones run in `make test-eval-golden`).

- **Shared fixtures** (`tests/fixtures/`): anonymised microservice repos used by integration + eval tests. Reuse before creating a new fixture from scratch.

#### When to add an `eval/patterns/` test (mandatory triggers)

Adding or extending a pattern test is **required** when:
- The change touches taint propagation, import resolution, plugin extraction, decorator registries, or any cross-file inference.
- The bug was reported against a real-world codebase (the pattern test is the deterministic, anonymised reproduction — the fix loses this test in CI before the regression reaches production).
- The feature introduces a new decorator kind, a new language plugin extension point, or a new framework signal.
- The fix requires multi-file PHP/TS interaction that a single-file unit test cannot reproduce (same-namespace imports, class-hierarchy back-propagation, cross-file const resolution).

A pattern test PINS the behaviour: the deterministic fixture freezes the inputs and the assertions cover every guarantee the fix introduces. Reviewers should reject changes to these subsystems that arrive without a corresponding pattern test.

#### Agent rules for tests

When you (the agent) implement a change, follow this decision tree before writing any code:

1. **Is the change in `src/ai/workflows/sanitizer.ts`, `src/ai/agents/`, schema validation, or pure regex/heuristic guards?** → Unit test in `tests/unit/`.
2. **Does it touch `src/graph/mutations/`, the welder, or persistence ordering?** → Integration test in `tests/integration/`.
3. **Does the LLM output behaviour matter (prompt change, new field, new sanitizer step the LLM sees)?** → Eval `agents/` test with replay cache, plus matching unit test for any deterministic guard.
4. **Does the change cross multiple files in a real codebase pattern (taint, plugin, decorator chain, framework signal)?** → Eval `patterns/` test with anonymised fixture. **Mandatory** even if a unit test already exists.

When you write the test, follow TDD: RED first (assertion that fails before the fix), then GREEN (implementation makes it pass). Do not commit a fix without its test in the same change. Do not skip the eval/patterns tier when criterion 4 applies — a unit test on synthetic in-memory data does not catch regressions in the AST → import-graph → plugin registry chain.

For pattern fixtures: anonymise to the canonical `acme/inventory/orders/payment/shipping/notification` vocabulary. Never copy verbatim from a private repo — reduce to the minimum reproduction (3-5 files) that exercises the bug.

Vitest note: Zod v4 must be inlined in vitest config to avoid ESM load-ordering issues with `vi.mock()`.

## Architecture

### Data Flow (Code Ingestion)

```
CLI command (cr analyze code)
  → code-ingestion.workflow.ts
    → orchestrator.ts (crash-resilient, Merkle-cached)
      → 4-stage pipeline per file:
        1. file-discovery.ts — find source files by language
        2. static-analyzer.ts — AST parsing via tree-sitter, extract symbols/calls
        3. semantic-extractor.ts — LLM analysis for intent & infra dependencies
        4. graph-writer.ts — persist nodes/edges to Neo4j
```

### Key Directories

- **`src/cli/`** — Commander.js commands. Entry point: `src/cli/index.ts`
- **`src/ingestion/core/`** — Language-agnostic analysis: import graphs, source resolution, symbol registry, taint propagation (BFS to find I/O functions)
- **`src/ingestion/core/languages/`** — Language plugins (TS, PHP, Go, Python) for import/export extraction
- **`src/ingestion/processors/code-pipeline/`** — The 4-stage pipeline above
- **`src/ingestion/extractors/`** — Specialized extractors: OpenAPI, GraphQL, Backstage, lockfiles, CODEOWNERS
- **`src/ingestion/structural/`** — Plugin system for framework/infra detection (Dockerfile, GitHub Actions, Helm, etc.)
- **`src/ai/agents/`** — Mastra LLM agents. `unified-analyzer.ts` is the core semantic extractor (fast + deep variants)
- **`src/ai/models/`** — LLM provider abstraction (Anthropic, OpenAI, Gemini, Ollama)
- **`src/ai/workflows/sanitizer.ts`** — Deterministic post-LLM filters to remove hallucinated/generic names
- **`src/graph/`** — Neo4j domain models (Zod schemas in `domain.ts`), mutations, and queries
- **`src/graph/urn.ts`** — URN format for node IDs: `cr:{type}:{namespace}:{name}`
- **`src/eval/`** — Impact analysis: ephemeral extraction, graph diffing, blast radius resolution
- **`src/mcp/`** — MCP server for IDE integration
- **`src/policy-runner/`** — YAML/JS governance policy execution against the graph
- **`src/config/`** — Settings management, credentials, per-repo hints

### Key Design Patterns

- **Write-through pipeline**: Each file completes all 4 stages before the next file begins (no buffering)
- **Merkle caching**: Files are hashed; unchanged files skip re-processing across runs
- **Taint analysis**: BFS from known I/O sinks filters ~85% of functions before any LLM calls
- **Deterministic sanitization**: `sanitizer.ts` strips LLM hallucinations without additional LLM calls
- **Language plugins**: Each language implements import/export extraction; the pipeline is language-agnostic above that layer
- **Rate-limit backpressure**: `src/utils/congestion-control.ts` (per-call 429 retry, backoff + jitter) over `src/utils/aimd-semaphore.ts` (adaptive concurrency). Invariants: G1 slot released before backoff sleep; G2 one decrease per congestion window, stale 429s during a freeze never extend it; G3 bounded queue opt-in. Half-open recovery: first post-freeze success jumps the limit back to `initialLimit`. Run-level quota circuit breaker (`QuotaCircuitOpenError`): 20 consecutive fleet-wide 429s over 8 min with zero successes → fail fast, one probe per minute; a probe success closes the circuit. Embedding batch failures under quota pressure skip the per-item fallback (no request amplification). Above the concurrency limiter sits an **adaptive requests-per-minute limiter** (`src/utils/rate-limiter.ts`, `AdaptiveRateLimiter`) — concurrency caps in-flight, but provider quotas are per-minute, so this auto-tunes the *rate* via slow-start→AIMD (×2 per success window until the first 429, then ×0.5-per-cooldown-window decrease + additive increase; the quota is discovered, not configured). One token consumed PER ATTEMPT before the concurrency `acquire` (retries pay budget → no amplification; token-wait never holds a slot). Per quota-domain registry keyed `{provider}:{model}` so a Gemini 429 doesn't throttle an OpenAI fallback. Rolling-window dead-quota breaker (`QuotaFloorStuckError`): rate pinned at floor + high 429 ratio + duration → fail fast even when sporadic successes would reset the consecutive-streak breaker. Env: `LLM_RATE_RPM` (hard ceiling/seed; `0` disables), `LLM_RATE_{INITIAL,MIN,MAX,INCREASE_RPM,SUCCESS_STREAK,COOLDOWN_MS,BURST_SECONDS,DECREASE_FACTOR}`. Default ON (slow-start makes it safe); disabled under vitest unless an `LLM_RATE_*` is set. `maxRetries:0` on every analysis `agent.generate` so the bucket is the sole request-count authority.
- **APIEndpoint dedup**: per-service `rewireImplementsEdgesToOpenApi` (anchored on `(s:Service)` for multi-tenant safety) collapses code-inferred ↔ OpenAPI; `weldOpenApiAcrossSpecs` reconciles vendored OAS copies (CONSUMES_API → EXPOSES_API) into the authoritative endpoint; cross-service `weldEmergentToCanonical` in `processors/global-resolver.ts` welds emergent (consumer) into canonical (provider). All producers must stamp `APIInterface.source` and write paths via `normalizeApiPathLossless` (PHP route extractor preserves var names verbatim). See `docs/architecture/api-endpoint-dedup.md`.
- **Cross-repo `DEPENDS_ON` late binding**: catalog `dependsOn` declarations create `:UnresolvedDependency` placeholder nodes (URN `cr:unresolveddep:{name}`, repo-agnostic) instead of phantom `:Service` stubs. `bindUnresolvedDependencies()` reconciles them to real `:Service` nodes at the end of the global workflow (deterministic match: `catalogName` first, then `name`); `gcOrphanUnresolvedDependencies()` hard-deletes leftovers. See `docs/architecture/service-topology.md#cross-repo-dependency-resolution`.
- **Catalog drift is grounded-identity reconciliation**: `cr drift` asserts drift only between a declared `dependsOn` ref that resolves (exact `catalogName`/`name`) to a real node and the service's observed edge to that same node. Refs that resolve to nothing are *unverifiable ≠ drift* (off-score, with a `Verifiable coverage` line); dimensions with no grounded key (currently APIs) are not reported, not string-matched. No compare-time normalization (that would be a silent-bug heuristic). See `docs/architecture/catalog-drift-grounding.md`.

### Graph Model

Follows C4 architecture model. Key node types: System, Repository, Service, Library, Team, SourceFile, Function, Class, Database, MessageChannel, Cache, APIInterface, APIDeployment, APIEndpoint. Contracts: DataContract, APIContract, ServiceContract.

### Grounding contract (mandatory)

Every node and every edge in the graph carries grounding, a four-property block describing **who** produced the fact, **what supports it**, and **how much** to trust it. "Grounding" is the ML term for anchoring a claim in retrieved evidence: every inferred entity is grounded in (a) a deterministic AST read, (b) an LLM call, (c) an AST + LLM composite, or (d) a user declaration / infra snapshot / runtime trace.

Single source of truth for the **vocabulary** (enums, type shapes, structural-family predicate): `packages/shared-types/grounding.ts`. Imported by both the backend (`src/graph/grounding.ts`) and the dashboard (`packages/dashboard-ui/src/types/grounding.ts`) so they cannot drift.

The backend layer adds zod schemas, builders (`astGrounding`, `llmGrounding`, `compositeGrounding`, `weldGrounding`, `applyFallback`), and `mergeEvidence` (which dedupes `llmCalls` by `(model, promptHash)` and caps at 10 entries to prevent blob growth). The dashboard layer adds UI-only palette / label tokens (`QUALITY_META`, `SOURCE_META`).

**Categorical schema** (no floats, no derived math):
- `source` ∈ {`ast` | `heuristic` | `llm` | `composite` | `declared` | `infra` | `runtime`}
- `quality` ∈ {`exact` | `high` | `medium` | `low` | `speculative`}
- `evidence`: structured object with `extractors[]`, optional `llmCalls[]`, `fallbacksApplied[]`, `mergedFrom[]`
- `needsReview?: boolean`: operational flag for the human triage queue

**Producer rules**:
1. Every mutation in `src/graph/mutations/` accepts an optional `grounding: GroundingFields` parameter at the **end** of the param list. If omitted, the mutation stamps `UNTAGGED_GROUNDING` (`heuristic/speculative` with `needsReview=true` and extractor `untagged@v1`) as a defensive default that visibly degrades the tier. A later sweep can grep `evidence_extractors CONTAINS 'untagged@v1'` to find untagged emissions.
2. Producers populate grounding via the helpers in `grounding.ts`:
   - `astGrounding('extractor-name@v1')`: deterministic AST walk
   - `llmGrounding(model, promptHash, 'extractor@v1', quality)`: LLM output
   - `compositeGrounding(left, right)`: multi-source agreement; quality caps at `high` on cross-source promotion to avoid claiming `exact` for non-AST signals
   - `applyFallback(ground, fallbackName, extractor)`: sanitizer / resolver transform fired (demotes quality one tier)
   - `weldGrounding(left, right, subId, weldExtractor)`: welder merging two predecessors
3. Welders MUST stamp `source: 'composite'` on the surviving node and dedup `evidence_mergedFrom` / `evidence_extractors` via Cypher `reduce()` (Memgraph's array `+` does NOT dedup). The shared pattern lives in `_run.ts:groundingWriteClause()`; reuse it.
4. **Field collisions**: domain discriminators that previously used `source` were renamed (`api.apiSource`, `ep.epSource`, `Release.releaseSource`, `Task.taskOrigin`). The grounding `source` always lives at `n.source` / `rel.source`. Producers and queries must use the renamed discriminators.

**Storage** (Memgraph property limitation, nested objects flatten):
- `source`, `quality`, `needsReview`, `lastSeenCommit` (scalars)
- `evidence_extractors`, `evidence_fallbacksApplied`, `evidence_mergedFrom` (string arrays, deduped on write)
- `evidence_llmCalls` (JSON-string array, opaque blob, deduped in TypeScript before flattening)

**Reading**: aggregator queries live in `src/graph/queries/grounding.ts` (`countByQualityTier`, `listNeedsReview`, `findDisputed`). The CLI consumes them via `cr analyze code` (final breakdown line) and `cr review pending` (triage queue). The dashboard mirror is `packages/dashboard-ui/src/types/grounding.ts`; keep the enums byte-identical with the backend.

**UI rule**: `QualityBadge` is suppressed by default for the **structural family** (SourceFile, Function, Service, Repository, Class, ...) because those are uniformly `ast/exact` and would drown the decision-relevant tiers (medium / low / speculative on inferred entities). The predicate is `isStructuralFamily(label)` in the mirror. The Inspect Drawer always shows the Grounding section: suppression is for the card-level glanceable view only.

## Workspaces

Monorepo with `packages/*` workspace. Currently includes `packages/dashboard-ui` (built separately with `bun run build:ui`).

### Dashboard UI Development

The dashboard has a live-reload dev server powered entirely by Bun (no Vite/webpack). It uses `Bun.build()` + `Bun.serve()` + WebSocket for ~100ms rebuild cycles.

```bash
make dashboard                                     # Fetch live data, start dev server, open browser
bun run dev:dashboard                              # Same as above
bun run dev:dashboard -- --data payload.json       # Use a saved payload file instead of querying the graph
bun run dev:dashboard -- --port 4000               # Custom port
```

On startup the dev server runs `bun run dev -- ui --json` to fetch the real payload from the graph (requires Memgraph running with data). The payload is fetched once; subsequent UI file changes trigger re-bundle + browser reload against the same data. Use `--data` to skip the graph query and load a previously saved JSON file.

The dev server watches `packages/dashboard-ui/src/` and `packages/shared-types/` for changes.

The production build (`bun run build:ui`) is unchanged: Bun bundles everything into a single self-contained HTML string in `src/cli/commands/ui/template-react.ts`.

## Coding Rules (mandatory)

These rules apply to every change — code, tests, fixtures, docs. Violations have caused real regressions in the past; treat them as hard guardrails.

### 1. No overfitting in the core

The `src/ingestion/core/` and `src/ingestion/processors/code-pipeline/` layers MUST stay language-agnostic and pattern-agnostic. They orchestrate a pipeline; they do not know what PHP/TS/Go look like.

**Forbidden in the core**:
- Regexes, AST patterns, framework names, or method-name lists tied to a single language (`$container->get`, `useEffect`, `gorilla/mux`, etc.).
- Special-case branches for a specific project's pattern, library, or class name.
- "If file basename matches X" hardcodes (those belong in plugins via `matches()`).

**Always go through plugins**:
- Language behavior → `src/ingestion/core/languages/<lang>/` (php, typescript, go, python).
- Connection-string parsing → `src/ingestion/processors/connection-extractors/plugins/`.
- Framework / infra detection → `src/ingestion/structural/plugins/`.
- DSN / URI shapes → `connection-extractors/dsn-parser.ts` (shared utility, not the core).

If you find yourself reaching for a regex like `/\$?(?:this->)?(?:container|services)->get/i` inside a core file, **stop**. The right place is the language plugin's critical-invocation extractor.

### 2. Plugin contract over inline branching

When a new pattern is needed, extend the relevant plugin's contract — don't add a new conditional to the core. Examples:

- New PHP message broker pattern → extend `core/languages/php/value-resolution.ts:extractPhpMemberInvocation` (or its config tables).
- New TS framework signal → extend `core/languages/typescript/framework-signals.ts`.
- New env-var template syntax → extend `connection-extractors/env-var-resolver.ts:resolveTemplates` with a new `TemplateSyntax` value, never inline in plugins or callers.

Plugin interfaces are: `ConnectionExtractor`, `LanguagePlugin`, `StructuralPlugin`. The core only sees these.

### 3. Separation of concerns

- **Core**: language-neutral orchestration, node merging, graph mutations, post-ingestion welding.
- **Plugins**: language- and framework-specific extraction.
- **Sanitizer / DI registry / LLM agents**: live under `src/ai/`, never imported from the core pipeline directly except through their public API.

When a fix spans multiple layers, name the responsibility explicitly in the PR / commit message ("plugin extension: PHP service-locator critical invocation"), not "static bypass tweak in task-builder".

### 4. No proprietary or third-party private code

Source code from private codebases MUST NOT appear in this repository in any form: code, plugins, tests, fixtures, docs, comments, or commit messages.

- **Production fixtures**: always anonymize. Use the canonical example domain `acme` with kebab-case compounds (e.g. `acme-corp`, `acme.com`, `acme/inventory-service`). Never reuse names from any private codebase: no real slugs, real internal package names, real DNS, real DB names, real Helm values, real DI keys.
- **Business domain**: replace domain-specific business terms with neutral e-commerce equivalents (`order`, `payment`, `inventory`, `shipping`, `notification`). Never a private codebase's domain nouns, not even translated to English.
- **File paths in fixtures**: rename project-specific directory structures to neutral analogues like `src/database/` or `app/persistence/`.
- **Identifiers in extractors**: when the extractor needs an example for unit-test seeds, generate it (`'orders'`, `'users'`, `'shipments'`, `'order.created'`), don't paste from a private repo.
- **Prompts / agent instructions**: scrub domain-specific vocabulary before committing prompt updates. Generic terms only.
- **Diagnostic scripts in `scripts/diag-*.ts`**: keep parameterized — `--repo <path>` — never embed private paths or names as defaults.
- **Memory / coderadius.yaml hints**: shipped templates and example configs use `acme` only. Repo-specific hints stay on the user's machine, never in this repo.

To reproduce a bug from a private codebase, reduce it to a minimal (3-5 file) fully anonymized fixture first.

### 5. Code Cleaning

Write simple, testable code.
Follow Domain Driven Design principles.
Follow Clean Architecture principles.
Be Dry/Shy/Tell the other guy.
Keep cyclomatic complexity under 6.
Write test cases before writing the code, follows Red-Green-Refactor.
Follows SOLID principles.
Functions should be small and focused, under 150 lines.

Every PR/commit must result in clean code. Do not commit incomplete or intermediate states. Remove TODOs and commented code.


### 6. Pre-commit checklist

Before staging any change, ask:
- [ ] Does this regex / list / heuristic belong in the core, or in a plugin?
- [ ] If it's a fix reproduced from a private codebase, is the test fixture anonymized to `acme`?
- [ ] Are file paths, package names, DNS, DB names, DI keys, env-var prefixes, business terms in the diff all generic?
- [ ] Could this change expose any private codebase's identifiers or structure?
- [ ] Did you add a test at the right tier (see Testing strategy above)?
- [ ] If the change crosses multiple files in real codebase patterns (taint, plugin, decorator, framework signal), is there an `eval/patterns/` test pinning it?

If any answer is unclear, push back and refactor before committing.
