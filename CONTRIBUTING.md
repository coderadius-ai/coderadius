# Contributing to CodeRadius

Thanks for your interest in improving CodeRadius! This document covers everything you need to get a development environment running, pick the right test tier for your change, and submit a pull request that sails through review.

## Prerequisites

- **[Bun](https://bun.sh) >= 1.0**: the development runtime and package manager. CodeRadius is developed and tested with Bun, not Node.js.
- **Docker**: required only for integration tests (they run against a real Memgraph instance) and for using the CLI end-to-end against a graph database.

## Getting started

```bash
git clone https://github.com/coderadius-ai/coderadius.git
cd coderadius
bun install          # install dependencies
bun run build        # TypeScript typecheck (also rebuilds the dashboard bundle)
```

To run the CLI from source:

```bash
bun run dev -- --help
```

To spin up a local Memgraph for end-to-end use:

```bash
make start           # docker compose up -d + readiness wait
```

## Running the tests

The suite is organised in tiers by determinism level and dependency footprint. Every tier runs locally without an LLM API key unless explicitly noted.

| Tier | Command | Needs Docker? | Needs API key? |
| --- | --- | --- | --- |
| Unit | `bun run test:unit` | No | No |
| Integration | `make test-integration` | Yes | No |
| Eval: patterns | `make test-patterns` | No | No |
| Eval: extraction | `make test-extraction` | No | No |
| Eval: agents (replay) | `make test-eval-golden` | No | See note |

### Unit tests (`tests/unit/`)

Pure logic with no external services: sanitizer rules, schema validation, regex guards, in-memory pipelines.

```bash
bun run test:unit
```

### Integration tests (`tests/integration/`)

Exercise real graph mutations against Memgraph. The Make target starts an isolated test container (port 7688), runs the suite, and tears the container down:

```bash
make test-integration
```

If you prefer managing the database yourself:

```bash
make test-up
MEMGRAPH_URI=bolt://localhost:7688 bun run test:integration
make test-down
```

### Eval tests: patterns (`tests/eval/patterns/`)

End-to-end multi-file scenarios that exercise the full static pipeline (imports, taint propagation, plugin extraction, registry lookups). Deterministic, zero LLM calls, no database:

```bash
make test-patterns
```

(This selects the deterministic subset automatically; pattern tests that
replay LLM caches run in the `test-eval-golden` tier instead.)

### Eval tests: extraction (`tests/eval/extraction/`)

Golden fixtures run through the ephemeral extraction pipeline with a precision/recall gate, in replay mode:

```bash
make test-extraction
```

### Eval tests: agents (`tests/eval/agents/`)

LLM extraction quality on per-function snippets. Controlled by `EVAL_LLM_MODE`:

- `replay` (default): cached LLM outputs from `tests/eval/.llm-cache/`. Deterministic, ~2s, **no API key needed**
- `live`: real LLM calls, saves to cache
- `refresh`: real LLM calls, overwrites cache

```bash
make test-eval-golden
```

Only `live` and `refresh` require LLM provider credentials. If your change alters prompts or the LLM output schema, refresh the affected cache and commit the diff alongside your change.

> **Note:** replay caches are pinned to the exact prompt text. If prompts have
> drifted since the caches were recorded, some replay tests fail with cache
> misses until a maintainer runs a `refresh` pass. This does not indicate a
> problem with your change if the same tests fail on `main`.

## Which test tier covers my change?

Work through this decision tree before writing code:

1. **Sanitizer, agent schemas, schema validation, or pure regex/heuristic guards?** → unit test in `tests/unit/`.
2. **Graph mutations, the welder, or persistence ordering?** → integration test in `tests/integration/`.
3. **LLM output behaviour matters (prompt change, new field, new sanitizer step the LLM sees)?** → eval agents test with replay cache, plus a unit test for any deterministic guard.
4. **The change crosses multiple files in a real codebase pattern (taint propagation, import resolution, plugin extraction, decorator chains, framework signals)?** → eval patterns test with an anonymised fixture. This tier is **mandatory** when criterion 4 applies, even if a unit test already exists. A unit test on synthetic in-memory data does not catch regressions in the AST → import-graph → plugin-registry chain.

A pattern test pins the behaviour: the deterministic fixture freezes the inputs and the assertions cover every guarantee the fix introduces. Reviewers will ask for one when these subsystems change.

## Fixture policy

All test fixtures must be **fully synthetic**. Never copy code from a private or proprietary codebase, not even renamed. Reduce any real-world pattern you are reproducing to a minimal synthetic equivalent (3-5 files) and express it in the canonical `acme` e-commerce vocabulary:

- Organisations/packages: `acme`, `acme-corp`, `acme/inventory-service`
- Domain nouns: `orders`, `payment`, `inventory`, `shipping`, `notification`
- Identifiers, DNS names, database names, env-var prefixes, queue names: generic e-commerce equivalents only

If a reader of this public repository could identify a specific company or product from your fixture, it does not belong here.

## Development expectations

- **TDD**: write the failing test first (red), then make it pass (green), then refactor. A fix lands in the same change as the test that pins it.
- **Keep the core language-agnostic**: language-, framework-, and pattern-specific logic lives in plugins (`src/ingestion/core/languages/`, `src/ingestion/structural/plugins/`, `src/ingestion/processors/connection-extractors/plugins/`), never in the core pipeline.
- **Clean diffs**: no leftover TODOs, commented-out code, or debug output.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/). Examples from this repository's history:

```
feat(ts): static decorator-route extraction (NestJS / routing-controllers)
fix(graph): dedup evidence arrays on weld
docs(eval): document extraction tier + convention
refactor(eval): rename framework-coverage → extraction tier
chore(oss): remove dead code from the public tree
feat(oss)!: remove license-key gate, CodeRadius is fully open source
```

Types in use: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`. Scope is the affected area (`ts`, `php`, `graph`, `eval`, `cli`, ...). Append `!` for breaking changes.

## Pull requests

- Keep PRs focused: one logical change per PR.
- Fill in the PR template, including which test tier covers the change and the exact command you ran.
- `bun run build` (typecheck) and the relevant test tiers must pass.
- Link the issue the PR addresses, if one exists. For non-trivial features, open an issue or a [Discussion](https://github.com/coderadius-ai/coderadius/discussions) first so we can align on the approach before you invest time.

## Licensing of contributions

CodeRadius is licensed under [Apache-2.0](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms ("inbound = outbound"). There is no CLA to sign.
