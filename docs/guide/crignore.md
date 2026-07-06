# .crignore

`.crignore` controls which files CodeRadius excludes from analysis. It uses `.gitignore` pattern syntax: any path matching a pattern is skipped before parsing, taint analysis, or LLM extraction ever see it. This applies to `cr analyze code`, `cr analyze infra`, and structural scans (`--depth structure`). All three route through the same `ScopeManager`. `cr blast` also respects a `.crignore`, but through a separate, simpler engine (see [Limitations](#limitations-in-cr-blast) below).

## Why It Exists

Not every file in a repository is architecturally relevant:

- **Frontend assets** (`*.css`, `*.svg`, `*.png`) carry no I/O behavior
- **Vendored dependencies** (`vendor/`, `node_modules/`) duplicate what's already captured from package manifests
- **Generated code** (`*.generated.ts`, `*.pb.go`) is derivative of source-of-truth definitions
- **Test fixtures and mocks** contain synthetic data that pollutes the graph
- **Build artifacts** (`dist/`, `build/`) are compiled output

Excluding these before ingestion saves LLM tokens, cuts ingestion time, and keeps the graph free of nodes that don't represent real architecture.

## File Location

Place `.crignore` in the root of each repository. There's no nested or per-directory support. CodeRadius reads exactly one `.crignore`, at `<repo-root>/.crignore`:

```
your-repo/
├── src/
├── .crignore     ← here
├── .gitignore
└── package.json
```

## Generating `.crignore` with AI

`cr init` offers to auto-generate a `.crignore` by analyzing your directory tree with an LLM:

```bash
cr init
# ... provider setup ...
# ◆ Do you want to run the AI now to generate a .crignore?
#   Yes / No
```

The AI reads your project structure: framework conventions, language ecosystem, and build tool output directories. It writes a `.crignore` tailored to your stack. This is the recommended starting point.

The same generation step also fires automatically during `cr analyze code`, independent of `cr init`: for any repository resolved as `origin: remote` (cloned from a URL rather than a local path) that has no `.crignore`, the ingestion workflow's "Generating Scope Filters" step calls the same LLM and writes the result into the repo's working copy. It then copies that file back into the repo's cache directory, so the next run (or a fresh worktree of the same repo) inherits it without regenerating. Local (non-cloned) repos are never auto-generated for; you write those yourself or run `cr init`.

## Syntax

`.crignore` follows the [`.gitignore` pattern format](https://git-scm.com/docs/gitignore#_pattern_format):

| Pattern | Matches | Example |
|---------|---------|---------|
| `*.css` | All CSS files anywhere in the tree | `src/styles/main.css` |
| `dist/` | The `dist` directory and everything inside it | `dist/bundle.js` |
| `**/vendor/**` | Any `vendor` directory at any depth | `lib/vendor/sdk.php` |
| `!src/api/generated.ts` | Negation: re-include a previously excluded file | none |
| `*.test.ts` | All TypeScript test files | `src/orders/OrderService.test.ts` |
| `#` | Comment line (ignored) | none |

### Key Rules

- Patterns are matched relative to the repository root
- A trailing `/` matches directories only
- `**` matches zero or more directories
- `!` negates a pattern (re-includes a previously excluded path)
- Empty lines and lines starting with `#` are ignored

## Recommended Patterns

### TypeScript / JavaScript

```text
# Build output
dist/
build/
.next/
.nuxt/
out/

# Dependencies (captured from package.json)
node_modules/

# Test files and fixtures
**/*.test.ts
**/*.test.tsx
**/*.spec.ts
**/*.spec.tsx
**/__tests__/
**/__mocks__/
**/__fixtures__/
**/test-utils/

# Frontend assets
**/*.css
**/*.scss
**/*.less
**/*.svg
**/*.png
**/*.jpg
**/*.gif
**/*.ico
**/*.woff
**/*.woff2
**/*.ttf

# Generated code
**/*.generated.ts
**/*.d.ts

# Config noise
.eslintrc*
.prettierrc*
jest.config.*
vitest.config.*
tsconfig.*.json
!tsconfig.json
```

### PHP

```text
# Vendored dependencies
vendor/

# Cache and build
var/cache/
var/log/
storage/
bootstrap/cache/

# Frontend (Laravel Mix, Webpack)
public/css/
public/js/
public/mix-manifest.json
resources/css/
resources/js/

# Tests
tests/
phpunit.xml
```

### Python

```text
# Virtual environments
.venv/
venv/
env/

# Build artifacts
__pycache__/
*.pyc
*.egg-info/
dist/
build/

# Tests
tests/
test_*.py
*_test.py
conftest.py

# Jupyter
*.ipynb
.ipynb_checkpoints/
```

### Go

```text
# Binary output
bin/
/main

# Test files
*_test.go
testdata/

# Generated protobuf
*.pb.go

# Vendor (if not using go modules)
vendor/
```

## What Happens Without `.crignore`

CodeRadius always applies a built-in exclusion list, whether or not `.crignore` exists. It's not a fallback that only kicks in when `.crignore` is absent; it's a floor underneath every `.crignore` you write. Roughly 80 universal patterns are always active: test/e2e directories (`tests/`, `e2e/`, `cypress/`, `playwright/`, `__mocks__/`, ...), docs and examples, lockfiles, vendored JS library paths, minified/sourcemap files (`*.min.js`, `*.js.map`), compiled binaries (`*.class`, `*.dll`, `*.pyc`), and Terraform/CDK build output.

On top of that, a Tier-3 heuristic runs against every file regardless of pattern matches:
- Any file over 300KB is excluded outright.
- Any file whose first 10KB averages more than 300 characters per line is treated as minified/bundled and excluded. This catches bundled libraries (amcharts.js, lodash.min, ag-grid) that pass the size check but still choke a parser.

These heuristics are conservative. They don't know your team's conventions, your vendored SDKs, or where your codegen lands. A project-specific `.crignore` still matters: without one, you'll parse more files than you need to, spend more LLM tokens, and take longer per run.

## Re-ingesting After Changes

A normal `cr analyze code` run already picks up `.crignore` edits correctly, no flag required. File discovery filters candidates through `ScopeManager` *before* building the Merkle index, so a file newly excluded by an edited `.crignore` never enters the new index. The diff between old and new index reports it as deleted, and the pipeline soft-deletes (tombstones) its `SourceFile` node and edges.

```bash
cr analyze code
```

`--force` is a different lever: it bypasses the Merkle/Scout/Extractor caches and re-analyzes everything from scratch. Reach for it when you've changed extraction logic or suspect stale graph state, not merely to make a `.crignore` edit take effect.

```bash
cr analyze code --force
```

## Limitations in `cr blast`

`cr blast` filters its git diff through `.crignore` too, but through an independent, simpler parser (not the `ScopeManager` used by ingestion). It does a naive glob-to-regex translation (`*` → `.*`, `?` → `.`) with no special-casing for `!`. A `!pattern` line is compiled into a regex that looks for a literal `!` character in the path; it will never match, so negation is silently inert in `cr blast`. There's also no `**`/directory-anchoring semantics beyond the literal glob translation.

Practical consequence: a file can be excluded from `cr analyze code` but still show up in a `cr blast` diff, or a negation pattern that correctly re-includes a file for ingestion has no effect on blast radius filtering. If your `.crignore` relies on `!` re-inclusion, verify blast's behavior separately. Don't assume the two commands see the same file set.

## Further Reading

- [CLI Reference: cr init](./cli-commands.md#init): The interactive setup that generates `.crignore`
- [CLI Reference: cr analyze code](./cli-commands.md#analyze-code): The analysis command that respects `.crignore`
- [coderadius.yaml](./coderadius-yaml.md): Per-repository configuration for database scoping and custom SDK knowledge
