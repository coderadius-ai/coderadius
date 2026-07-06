# CLI Commands

`cr` is the CodeRadius command-line interface. It ingests source code and infrastructure declarations into a graph database, then answers architecture questions against that graph: what a service depends on, what breaks if you change a file, which governance rules are violated. This page is the full command reference.

Install it from source (requires [Bun](https://bun.sh) ≥ 1.0 and Node.js ≥ 22):

```bash
git clone https://github.com/coderadius-ai/coderadius.git
cd coderadius && bun install && bun link
```

## Quick Start

```bash
# Start infrastructure
cr up

# Analyze your codebase architecture
cr analyze code ./services/*

# Open the Architecture Dashboard
cr ui

# Predict blast radius of code changes
cr blast

# Connect coding agents to the graph
cr mcp configure
```

---

## Global Usage

```
cr [command] [subcommand] [options]
cr --version
cr --help
```

**Command categories:**

| Category | Commands |
|----------|----------|
| **Core** | `analyze`, `blast`, `policy`, `review`, `drift`, `ask`, `ui`, `docs` |
| **Setup** | `init`, `up`, `down`, `mcp` |
| **Maintenance** | `validate`, `prune`, `state`, `config` |

**Legacy aliases:** `sync` (→ `analyze`), `eval blast` (→ `blast`), `chat` (→ `ask`), `start` (→ `up`), `stop` (→ `down`), `doc` (→ `docs`), `team-alias` (→ `config team-alias`), `completion` (→ `config completion`) all still work. They're hidden from `--help`; use the canonical names in new scripts, but old CI pipelines and tutorials referencing these don't break.

---

## Init

Initializes the CodeRadius workspace for the current directory or user environment.

**What it does:**
1. Creates `~/.coderadius/config/settings.json` with an LLM provider choice: Google AI Studio (default), Anthropic Claude, OpenAI, Ollama, Google Vertex AI, or AWS Bedrock
2. Creates `~/.coderadius/config/credentials.json` (chmod 600) for API keys
3. Interactively generates a `.crignore` file using AI analysis of the current directory tree to exclude frontend noise, vendored dependencies, and generated files
4. Optionally installs shell autocompletion for `cr`

```bash
cr init
```

This command is interactive. It requires no flags but walks you through several prompts.

**Example session:**
```
  ◆ Which LLM provider would you like to use?
  │  ● Google AI Studio (API key, simplest)
  │  ○ Anthropic Claude
  │  ○ OpenAI
  │  ○ Ollama (local, no API key needed)
  │  ○ Google Vertex AI (GCP project required)
  │  ○ AWS Bedrock (uses AWS CLI credentials)

  ◆ Fast model (bulk code analysis): gemini-2.5-flash

  ◆ Do you want to run the AI now to generate a .crignore?
    Yes / No
```

Picking `vertex` additionally prompts for a Google Cloud Project ID. Picking `bedrock` reuses your existing AWS CLI credentials; no separate prompt.

> **Note:** After running `cr init`, your configuration is stored globally at `~/.coderadius/config/settings.json`. You can override it on a per-project basis using a local `.env` file. The format uses a concise `provider/model` string syntax.
>
> Models are configured per **tier**: `fast` covers high-volume work (`ingest`, `mcp`), `smart` covers quality work (`chat`, `doc`). A per-action key (e.g. `"chat": "..."`) overrides its tier:
>
> ```json
> {
>     "ai": {
>         "fast": "vertex/gemini-3.1-flash-lite",
>         "smart": "vertex/gemini-3.1-pro",
>         "embedding": "openai/text-embedding-3-small"
>     }
> }
> ```

---

## Architecture Analysis

Commands for analyzing codebases and building the architectural graph. All analysis commands are subcommands of `cr analyze`.

### Analyze Code

The primary analysis command. Analyzes source code directories, parses configuration files, extracts tainted functions, and upserts all results into the Memgraph graph database. The `--depth` flag controls analysis depth.

```bash
cr analyze code [paths...] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `paths...` | One or more source paths to analyze. Accepts globs. A path prefixed with `@` (e.g. `@targets.txt`) is read as a newline-delimited path list, equivalent to `--paths-file`. Defaults to the current working directory when omitted. |

**Options:**

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Enable verbose logging. Prints timestamps and per-function extraction details. |
| `--depth <level>` | Analysis depth. Default: `semantic`. See [Depth Levels](#depth-levels) below. |
| `--force` | Bypass all caches (Merkle, Scout, Extractor) and re-analyze everything from scratch. Use after a `.crignore` change or a suspected stale graph state. |
| `--transparent-urns` | Populate plaintext display fields for debugging. Broker URNs stay opaque and stable; datastore fingerprints remain transparent. |
| `--json` | Outputs the analysis telemetry report as JSON to stdout. Useful for piping into CI dashboards. |
| `--paths-file <file>` | Read source targets from a file (one target per line, useful for large fleets). |
| `--source-strategy <strategy>` | Explicit source resolution strategy override. Values: `cache`, `pull`, `ci`. |
| `--llm-concurrency <n>` | Override LLM parallelism level (1-20, default: 3). |
| `--taint-depth <n>` | Override taint propagation max iterations (1-100, default: 32). |
| `--trace [dir]` | Generate a structured execution trace report. Defaults to `~/.coderadius/traces/`. |

#### Depth Levels

| Depth | Scope | LLM? | Description |
|-------|-------|------|-------------|
| `structure` | Topology, agentic context, API specs, dependencies | No | Lightweight structural scan. Maps repos, services, teams, agentic configs, and structural files. No source code parsing, no LLM. |
| `semantic` (default) | + source code analysis, cross-service resolution | Yes | Full code analysis with AST parsing, taint analysis, LLM semantic extraction, and cross-service dependency resolution. |
| `contracts` | + data contract field extraction | Yes (heavy) | Everything in `semantic` plus data contract extraction: produced and consumed payload schemas (field names and types) for every I/O boundary. |

**Examples:**

```bash
# Analyze the current directory (default: semantic depth)
cr analyze code

# Analyze multiple service roots
cr analyze code ./services/payments ./services/identity ./services/notifications

# Analyze all repos in a directory (glob)
cr analyze code ./repos/*

# Structure-only scan (no LLM, fast)
cr analyze code ./repos/* --depth structure

# Full data contract extraction
cr analyze code ./services/* --depth contracts

# Force complete re-analysis (no cache)
cr analyze code ./services/* --force

# CI mode: output JSON telemetry to stdout
cr analyze code --source-strategy ci --json

# Increase LLM parallelism for faster extraction
cr analyze code ./services/* --llm-concurrency 10

# Read targets from a file instead of the shell expanding globs
cr analyze code @targets.txt
```

**Telemetry Output:**

After a run, the CLI prints an ingestion report:
- **Performance**: duration, LLM time, parsing time, files processed/skipped, functions ingested/unchanged
- **Pipeline Funnel**: functions parsed, dropped (untainted / all gates), survivors per gate (UseCase, Convention, Synthetic, Taint, DI, Framework, API Client), cache hits, static bypass rate, retries/failures
- **Agentic Metadata**: entities enriched vs. attempted, enrichment time, failure buckets
- **Token Usage**: input/cached/output tokens, cache hit rate, per-phase breakdown
- **Economics**: LLM cost, embedding cost, total estimated cost

---

### Analyze Infra

Ingests infrastructure declarations only: message broker definitions, Helm/Kubernetes manifests, Docker Compose files, CI configs, and agentic tooling. Parses no source code and makes zero LLM calls. Accepts directories (scanned for structural files) as well as standalone files (routed directly to the matching structural plugin).

```bash
cr analyze infra [paths...] [options]
```

`paths...` also accepts an `@file` argument (e.g. `@targets.txt`), read as a newline-delimited path list, same shorthand as `cr analyze code`.

**Options:**

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Enable verbose logging |
| `--force` | Bypass all caches (Merkle, Scout, Extractor) and re-extract from scratch |
| `--transparent-urns` | Populate plaintext display fields for debugging. Broker URNs stay opaque and stable; datastore fingerprints remain transparent. |
| `--json` | Output telemetry report as JSON to stdout |
| `--paths-file <file>` | Read source targets from a file (one target per line) |
| `--source-strategy <strategy>` | Source resolution strategy: `cache`, `pull`, `ci` |
| `--trace [dir]` | Generate a structured execution trace report. Defaults to `~/.coderadius/traces/`. |

**Examples:**

```bash
# Ingest all infra declarations found in the repo fleet
cr analyze infra ./repos/*

# Ingest a single broker definitions file directly
cr analyze infra ./infra/rabbitmq-definitions.json
```

### Analyze Traces

Analyzes runtime telemetry (distributed traces) from Datadog or Jaeger exports. Overlays the trace topology on top of the static graph, validating the static architecture against real runtime behavior.

```bash
cr analyze traces --file <path> [options]
```

**Options:**

| Option | Required | Description |
|--------|----------|-------------|
| `-f, --file <path>` | Required | Path to the JSON traces export file |
| `-v, --verbose` | No | Verbose logging |

**Example:**

```bash
# Analyze a Datadog traces export
cr analyze traces --file ./traces/datadog-export.json

# Analyze a Jaeger export
cr analyze traces --file ./jaeger-traces.json
```

### Analyze Vuln

Scans all package dependencies in the graph for known vulnerabilities (CVEs) by querying the [OSV.dev](https://osv.dev) public database. Creates `Vulnerability` nodes and links them to affected `Package` nodes with version-aware edges.

Vulnerability enrichment also runs automatically during every `cr analyze code` run. Use this standalone command to re-scan on demand without re-analyzing the codebase. See [Vulnerability Scanning](./vulnerability-scanning.md) for the full guide: graph model, dashboard surfaces, governance policies, and air-gapped operation.

```bash
cr analyze vuln [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Enable verbose logging |
| `--refresh` | Force re-fetch from OSV even if the local cache is fresh |
| `--offline` | Skip API calls, use cached data only |
| `--json` | Output results as JSON |

**Privacy**: only public package names and versions are sent to OSV.dev. Source code, file paths, and repository metadata never leave the machine.

**Examples:**

```bash
# Scan all packages in the graph for vulnerabilities
cr analyze vuln

# Force refresh from OSV (bypass 24h cache)
cr analyze vuln --refresh

# Offline mode: use only cached vulnerability data
cr analyze vuln --offline
```

**Graph impact:**

| Node / Edge | Description |
|-------------|-------------|
| `Vulnerability` | CVE/advisory node with severity, CVSS score, fix version, references |
| `(Package)-[:HAS_VULNERABILITY]->(Vulnerability)` | Links package to vulnerability, with `vulnerableInstalledVersions[]` for version-aware blast radius queries |

**Example Cypher query** (which services have critical CVEs in production deps):

```cypher
MATCH (v:Vulnerability)<-[hv:HAS_VULNERABILITY]-(p:Package)<-[dep:DEPENDS_ON]-(s:Service)
WHERE v.severity = 'CRITICAL' AND dep.isDev = false
  AND dep.installedVersion IN hv.vulnerableInstalledVersions
RETURN s.name, p.name, v.osvId, v.cvssScore
```

---

## Impact Evaluation

Predicts the architectural blast radius of a code change in memory, without modifying the production graph. Returns a structured finding report at three severity levels (`DANGER`, `WARNING`, `INFO`) and emits a semantic exit code so CI / agents can branch without parsing the text output.

```bash
cr blast [path] [options]
```

The repo path is a positional argument and defaults to the current directory, matching the `cr analyze` convention. Pass an explicit path to evaluate a different workspace.

**Exit codes:**

| Code | State | When |
|------|-------|------|
| `0` | SAFE | No breaks, no warnings |
| `1` | WATCH | No breaks, at least one warning worth reviewing |
| `2` | BREAKING | At least one downstream consumer will break |

**Options:**

| Option | Description |
|--------|-------------|
| `--base <sha-or-branch>` | Base commit SHA or branch to diff against (default: `origin/main`) |
| `--head <sha>` | Head commit SHA to analyze (defaults to `HEAD`) |
| `--files <files>` | Comma-separated list of files to analyze, bypassing git diff |
| `--repo-name <name>` | Canonical identifier for the repository within the global graph |
| `-m, --intent <text>` | Semantic context declaring the purpose of the change (enhances analysis precision) |
| `--output <file>` | Direct structured output to a specified file path |
| `--format <format>` | Output format: `auto` (default, tty-aware), `markdown`, or `json` |
| `--advisory` | Always return exit code 0, even on DANGER findings (advisory mode) |
| `--allow-unknown-baseline` | Proceed even if the repository is absent from the master graph (confidence drops to LOW) |
| `--verbose` | Emit extended execution traces for the resolution pipeline |

**Examples:**

```bash
# Standard usage (current directory, default base origin/main)
cr blast

# Analyze a sibling repo
cr blast ../orchestrator

# Override base / head refs
cr blast --base main --head feature/redis-auth

# Describe the intent for better LLM context
cr blast -m "Migrate auth module to Redis"

# Output markdown for CI comment injection
cr blast --format markdown > report.md

# Analyze specific files without git
cr blast --files "src/payments/PaymentController.php"

# Advisory mode (never blocks CI)
cr blast --advisory
```

See [Impact Evaluation](./impact-evaluation.md) for full integration instructions for GitHub Actions, GitLab CI, and Bitbucket Pipelines.

---

## Governance Policies

The `cr policy` command group verifies governance rules against the architecture graph, prunes saved policies from it, and exports built-in packs for local customization.

### `cr policy verify`

Runs governance rules against the architecture graph. With no `--rules-path`, it runs the built-in packs (including `agent-readiness`); pass `--rules-path` to run a custom file or directory. Returns violations at configurable severity levels.

```bash
cr policy verify [options]
```

**Options:**

| Option | Required | Description |
|--------|----------|-------------|
| `--rules-path <path>` | No | Path to a YAML policy file or directory. Defaults to the built-in packs. A bare pack name (e.g. `agent-readiness`) resolves to `.coderadius/policies/<name>` if present, otherwise the built-in pack. |
| `--output <mode>` | No | Output format: `json`, `sarif`, `table` (default), `graph` |
| `--fail-on <severity>` | No | Exit with code 1 if violations at or above this severity (`error`, `warning`, `note`). Default: `error` |
| `--timeout <ms>` | No | Per-query timeout in milliseconds (DoS guard). Default: `5000` |
| `--tag <tag>` | No | Only run rules with this tag |
| `--min-level <level>` | No | Only run rules at or above this level (`note`, `warning`, `error`) |
| `--out <file>` | No | Write output to a file instead of stdout |

**Examples:**

```bash
# Run the built-in packs (no path needed)
cr policy verify

# Re-run only the agent-readiness checks and persist results into the graph
cr policy verify --tag agent-readiness --output graph

# Run rules from a custom directory
cr policy verify --rules-path ./policies/

# Output as SARIF (for IDE integration)
cr policy verify --rules-path ./policies/ --output sarif --out results.sarif

# Fail on warnings too
cr policy verify --fail-on warning
```

On completion, `cr policy verify` touches `/tmp/health-check`; this backs a Kubernetes CronJob readiness probe when the command runs as a scheduled job. Harmless outside that context, but worth knowing if you're inspecting `/tmp`.

### `cr policy prune`

Removes `PolicyRule` catalog nodes and their `PolicyEvaluation` results from the graph. Dry-run by default: pass `--force` to delete. There is no automatic orphan GC (tags are many-to-one and cannot identify a pack scope), so removing a rule from a pack and reflecting it in the graph is an explicit operation.

| Option | Required | Description |
|--------|----------|-------------|
| `[ruleIds...]` | No | Rule ids to remove (surgical mode) |
| `--rules-path <path>` | No | Reap rules persisted under this pack's tags but no longer loaded |
| `--force` | No | Actually delete (default is a dry-run preview) |

**Examples:**

```bash
# Preview which rules a pack would reap (orphans within its tag scope)
cr policy prune --rules-path ./policies/

# Delete specific rules and their validations
cr policy prune ar-tier-declared --force
```

### `cr policy export`

Copies a built-in policy pack to a local directory so you can customize the rules. On the next `cr policy verify` run, the local copy takes priority over the built-in pack.

```bash
cr policy export <pack-name> [options]
```

| Option | Required | Description |
|--------|----------|-------------|
| `<pack-name>` | Required | Name of the built-in pack to export (e.g. `agent-readiness`) |
| `--path <dir>` | No | Target directory. Default: `.coderadius/policies` |
| `--force` | No | Overwrite an existing local copy without confirmation |

**Examples:**

```bash
# Export the agent-readiness pack for local customization
cr policy export agent-readiness

# Re-export, overwriting local edits
cr policy export agent-readiness --force
```

---

## Architecture Dashboard

Generates the **Architecture Dashboard**, a single self-contained HTML file covering AI tooling observability, package dependencies, data gravity, governance alerts, and blast-radius topology.

```bash
cr ui [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--out <path>` | Generated temp file | Output path for the self-contained HTML dashboard |
| `--focus <domains>` | All tabs | Focus the dashboard on one or more architectural domains (comma-separated). Allowed values: `agentic-radar`, `deps`, `gravity`, `blast`, `inventory`, `governance` |
| `--json` | `false` | Output pure JSON (headless/CI mode) |

**Example:**

```bash
# Generate the dashboard and auto-open it
cr ui

# Generate with a timestamped filename
cr ui --out ./reports/health-$(date +%Y-%m-%d).html

# Focus the dashboard exclusively on the blast radius topology
cr ui --focus blast

# Output raw JSON for CI pipelines
cr ui --json
```

See [Architecture Dashboard](./explore/architecture-dashboard.md) for a full explanation of the dashboard domains and components.

---

## Docs

Commands for generating and managing architecture documentation. All doc commands are subcommands of `cr docs`.

### Generate Specifications

Generates an architecture document for one or more target services (up to 10), including C4 diagrams and architectural risk analysis. Uses the LLM configured during `cr init`.

```bash
cr docs generate [options]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `-t, --target <services>` | Interactive multi-select | Comma-separated service names (up to 10). If omitted, an interactive multi-select prompt shows all known services. |
| `-o, --output <path>` | `./ARCHITECTURE.md` (single service) or `./PLATFORM-ARCHITECTURE.md` (multiple services) | Output file path |
| `--skip-risk` | false | Skip risk analysis. Generates C4 diagrams only. Faster and cheaper. |

**Example:**

```bash
# Interactive service selection
cr docs generate

# Target a specific service
cr docs generate --target payments-service

# Document multiple services in one platform document
cr docs generate --target orders-api,payments-service,shipping-service

# Generate for a specific service, output to a custom path
cr docs generate --target orders-api --output ./docs/architecture/orders.md

# Skip risk analysis (faster)
cr docs generate --target payments-service --skip-risk
```

The generated document includes:
- C4 Context and Container diagrams (Mermaid format)
- List of inbound consumers and outbound dependencies
- Architectural risk metrics: Blast Radius Score, downstream services impacted, critical data dependencies
- LLM-generated narrative describing the service's purpose, responsibilities, and risk profile

---

## Agentic Chat

Opens an interactive terminal chat session with the **CodeRadius Architect Agent**, an LLM-powered agent with full access to your architectural graph via MCP tools.

```bash
cr ask
```

You can ask the agent questions like:
- *"Which services consume the payments queue?"*
- *"What would break if I rename the `customerId` field in the orders table?"*
- *"Which teams have the highest SPOF exposure in the architecture?"*

---

## MCP Server

Commands for managing the Model Context Protocol (MCP) server integration with IDE agents.

### Start Server

Starts the CodeRadius MCP server on stdio for IDE agent integration.

```bash
cr mcp start
```

### Configure IDE

Interactive wizard that auto-detects installed IDE environments (Cursor, Windsurf, Claude Desktop, Claude Code, Gemini CLI, Antigravity) and injects the MCP server configuration automatically.

```bash
cr mcp configure
```

> **Note:** For full MCP documentation on available tools, security model, IDE configuration examples, and debugging tips, see the dedicated [MCP Server](./mcp-server.md) page.

---

## Infrastructure Management

Commands for managing the local infrastructure (Memgraph graph database).

### Start Database

Starts the Memgraph graph database container using Docker and initializes the database schema.

```bash
cr up
```

**What it does:**
1. Runs preflight checks (Docker installed, daemon running, workspace initialized, port available)
2. Creates or restarts the Memgraph container on `bolt://localhost:7687`
3. Initializes the database schema (uniqueness constraints and secondary indexes). Vector indexes are created lazily on the first `cr analyze code`/`cr analyze infra` run, once the configured embedding model's dimension is known

> **Note:** Requires Docker to be running. If Memgraph is already running, this command is idempotent.

### Stop Database

Stops the Memgraph container. Data is persisted in Docker volumes by default.

```bash
cr down [options]
```

| Option | Description |
|--------|-------------|
| `--clean` | Remove container and volumes (full reset) |

**Example:**

```bash
# Stop, preserving data
cr down

# Stop and wipe all data
cr down --clean
```

---

## State Management

Export and import architecture graph snapshots. Useful for sharing state between environments, version-controlling your graph, or disaster recovery.

### State Export

Dumps the architecture graph to a `.cypherl` snapshot file (one Cypher statement per line, Git-diffable).

```bash
cr state export [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--out <path>` | `./state.cypherl` | Output file path |

**Example:**

```bash
# Export to default file
cr state export

# Export to a specific path
cr state export --out ./backups/graph-$(date +%Y%m%d).cypherl
```

### State Import

Restores the architecture graph from a `.cypherl` snapshot. By default, the existing graph is wiped before importing.

```bash
cr state import <file> [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt (for scripting/CI) |
| `--no-wipe` | Don't clear the graph before import (additive import) |

**Example:**

```bash
# Restore from a snapshot (wipes current graph)
cr state import ./state.cypherl

# Additive import (layer on top of existing graph)
cr state import ./second-env.cypherl --no-wipe

# CI mode (no confirmation)
cr state import ./state.cypherl --force
```

---

## Configuration Validation

Validates the repo's declarative `coderadius.yaml` without running an analysis: strict schema checking (typos surface as errors) plus a semantic dry-run against the repo (sections that match nothing produce warnings). Offline by design: no graph, no LLM. Exits `0` when the schema is valid (warnings allowed) and `1` when invalid. CI/pre-commit friendly.

```bash
cr validate [options]
```

| Option | Description |
|--------|-------------|
| `--repo <path>` | Repository root to validate (default: current directory) |
| `--json` | Emit the raw report as JSON (for CI) |

**Examples:**

```bash
# Validate the current repo
cr validate

# Validate a sibling repo, machine-readable
cr validate --repo ../orders-service --json
```

---

## Data Pruning

Destructive operations for removing data from the graph or cache. **Use with caution**: these operations cannot be undone.

### Prune Graph

Permanently deletes all nodes, relationships, and indexes from the Memgraph database. Requires explicit confirmation.

```bash
cr prune graph [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt (e.g. for scripting/CI) |

After pruning, run `cr analyze code` to repopulate the graph.

### Prune Cache

Clears all local caches (embeddings, classifiers, OSV, datastore assignments) and downloaded repositories. The next analysis run will re-analyze everything from scratch.

```bash
cr prune cache [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt (e.g. for scripting/CI) |

### Prune All

Wipes the graph database AND deletes all local caches in a single operation.

```bash
cr prune all [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt (e.g. for scripting/CI) |

---

## Grounding Review

Read-only commands for inspecting the trust attribution of entities in the graph. See the [Grounding & Trust Tiers](./grounding.md) guide for the conceptual model.

### Review Pending

Lists every inferred entity flagged with `needsReview = true`, grouped by node label. The engine flags entities when it cannot decide between competing signals, when a sanitizer fallback fires on a weak source, or when a mutation runs without a grounding argument (defensive catch).

```bash
cr review pending [options]
```

| Option | Description |
|--------|-------------|
| `--label <name>` | Restrict to a single inferred label (MessageChannel, DataContainer, APIEndpoint, ...) |
| `--quality-at-least <tier>` | Keep only entities whose quality is at least the given tier (exact, high, medium, low, speculative) |
| `--source <s>` | Keep only entities whose grounding source matches (ast, heuristic, llm, composite, declared, infra, runtime). Repeat the flag for multiple sources |

The command is read-only: it prints the triage list and exits. To act on a flagged entity, either accept the engine's inference (no action), tighten the source code so a static extractor catches it, or declare the entity in `coderadius.yaml` to override the tier with a `declared` source.

```bash
# All pending entities
cr review pending

# Only flagged MessageChannels
cr review pending --label MessageChannel

# Only LLM-inferred entities with quality medium or above
cr review pending --quality-at-least medium --source llm

# LLM-inferred OR heuristic-inferred (anything not from AST or composite)
cr review pending --source llm --source heuristic
```

### Diagnostic Coverage Dump

The diagnostic script `scripts/diag-graph-coverage.ts` dumps every inferred entity in the graph with its grounding columns. Useful for sanity-checking an analysis, comparing two ingestion runs, or finding stale entities filtered by source.

```bash
bun run scripts/diag-graph-coverage.ts [options]
```

| Option | Description |
|--------|-------------|
| `--repo <name>` | Restrict to a single repository scope. Default: the first repository scope found in the graph. |
| `--quality-at-least <tier>` | Keep only entities whose quality is at least the given tier |
| `--source <s>` | Keep only entities whose grounding source matches |

```bash
# Production-trust baseline: only what the AST extractor verified directly
bun run scripts/diag-graph-coverage.ts --source ast

# Trust above the noise floor
bun run scripts/diag-graph-coverage.ts --quality-at-least high

# Find what the LLM inferred for a single repo (so you can sanity-check it)
bun run scripts/diag-graph-coverage.ts --repo my-repo --source llm
```

---

## Catalog Drift

Compares catalog-declared truth (Backstage, Cortex) against the code-extracted graph: ghost services (in catalog, not in code), orphan services (in code, not in catalog), and grounded dependency drift. Declared references that cannot be grounded to a real node are reported as unverifiable, not as drift.

```bash
cr drift [options]
```

| Option | Description |
|--------|-------------|
| `--json` | Output the full report as JSON |
| `--source <catalog>` | Filter to a specific catalog source (`backstage`, `cortex`) |
| `--limit <n>` | Max rows per section (default: `20`, `0` = unlimited) |

**Examples:**

```bash
# Full drift report
cr drift

# Only Backstage-declared entities, unlimited rows, machine-readable
cr drift --source backstage --limit 0 --json
```

---

## Configuration

Commands for managing settings, team aliases, and shell completion.

### Show Config

Displays the current resolved configuration: the merged result of global settings (`~/.coderadius/config/settings.json`), local `.env` file, and environment variables. Shows resolved provider and model per action context (default, ingest, chat, doc, mcp), plus a `From` column with the provenance of each resolved model (`built-in (fast)`, `ai.smart`, `ai.chat`, `env`, ...).

```bash
cr config show [options]
```

| Option | Description |
|--------|-------------|
| `--json` | Output as raw JSON |

### Print CI Environment

Prints the environment variables a CI pipeline needs to reproduce your local LLM configuration, as shell `export` lines: `MODEL_PROVIDER`, `MODEL_NAME`, the provider-specific credentials, and the embedding model when it uses a different provider. Secret values are never printed; they appear as `<set-your-key>` placeholders.

```bash
cr config env
```

The command takes no options. Pipe the output into your CI secret manager or a `.env` template and fill in the placeholders.

### Team Alias Management

Manages AI-proposed team identity aliases. During analysis, CodeRadius may detect that multiple repository-level organization names refer to the same logical team. These proposals are surfaced as "phantom teams" that can be approved or rejected.

```bash
# List all pending team alias proposals
cr config team-alias list
cr config team-alias list --pending  # Only pending

# Approve a phantom team alias
cr config team-alias approve "platform-payments"

# Reject a phantom team alias
cr config team-alias reject "platform-payments-old"
```

### Shell Completion

Manages shell autocompletion for the `cr` CLI.

```bash
# Install autocompletion into your shell profile (.bashrc / .zshrc)
cr config completion --setup

# Remove autocompletion from your shell profile
cr config completion --cleanup
```

After running `--setup`, restart your terminal or `source` your profile file. Tab completion will then work for all `cr` commands and subcommands.

---

## Environment Variables

CodeRadius reads the following environment variables, either from your shell, a local `.env` file, or the global `~/.coderadius/config/credentials.json`:

| Variable | Description |
|----------|-------------|
| `MEMGRAPH_URI` | Bolt URI for Memgraph (default: `bolt://localhost:7687`) |
| `MEMGRAPH_USER` | Memgraph username (default: `coderadius`) |
| `MEMGRAPH_PASSWORD` | Memgraph password (default: `coderadius`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Google Cloud credentials JSON. Auto-set by `google-github-actions/auth` when using Workload Identity Federation in CI. |
| `GOOGLE_VERTEX_PROJECT` | Google Cloud project ID for Vertex AI |
| `GOOGLE_VERTEX_LOCATION` | Google Cloud location for Vertex AI (default: `global`) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI Studio API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `AWS_REGION` | AWS region for Bedrock |
| `AWS_ACCESS_KEY_ID` | AWS access key for Bedrock |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key for Bedrock |
| `MODEL_PROVIDER` | Override LLM provider (e.g. `vertex`, `anthropic`, `openai`) |
| `MODEL_NAME` | Override LLM model name |
| `OPENAI_BASE_URL` | Custom OpenAI-compatible API base URL |
| `OLLAMA_BASE_URL` | Ollama server base URL |
| `EMBEDDING_MODEL` | Override embedding model (`provider/model` syntax) |

**Per-action overrides:** `MODEL_PROVIDER`, `MODEL_NAME`, and `EMBEDDING_MODEL` each have an `_<ACTION>` variant that wins over the general one for that action: `MODEL_PROVIDER_INGEST`, `MODEL_NAME_CHAT`, `EMBEDDING_MODEL_DOC`, etc. `ACTION` is one of `INGEST`, `CHAT`, `DOC`, `MCP`. Use this to run, say, a cheaper model for bulk ingestion and a stronger one for `cr ask`.

### Concurrency and Rate Limiting

Two independent knobs govern LLM traffic during ingestion: a concurrency limiter (in-flight requests) and a requests-per-minute limiter (provider quota). Both auto-tune by default; you only need these variables to override the auto-tuned bounds or to pin a hard cap.

| Variable | Description |
|----------|-------------|
| `LLM_CONCURRENCY` | Legacy hard cap on in-flight LLM calls. Set only if you want AIMD growth disabled entirely; prefer `--llm-concurrency` for a one-off run. |
| `LLM_CONCURRENCY_INITIAL`, `LLM_CONCURRENCY_MIN`, `LLM_CONCURRENCY_MAX`, `LLM_CONCURRENCY_HARD_MAX` | AIMD concurrency bounds |
| `LLM_CONCURRENCY_SUCCESS_STREAK`, `LLM_CONCURRENCY_DECREASE_FACTOR`, `LLM_CONCURRENCY_COOLDOWN_MS` | AIMD growth/backoff tuning |
| `LLM_CONCURRENCY_MAX_QUEUE`, `LLM_CONCURRENCY_MAX_WAIT_MS` | Bounded queue (opt-in) |
| `LLM_RATE_RPM` | Hard ceiling on requests per minute. `0` disables the rate limiter entirely. |
| `LLM_RATE_INITIAL`, `LLM_RATE_MIN`, `LLM_RATE_MAX` | Rate-limiter bounds (requests/minute) |
| `LLM_RATE_INCREASE_RPM`, `LLM_RATE_SUCCESS_STREAK`, `LLM_RATE_COOLDOWN_MS`, `LLM_RATE_BURST_SECONDS`, `LLM_RATE_DECREASE_FACTOR` | Slow-start / AIMD tuning for the rate limiter |
| `CODERADIUS_SINK_CLASSIFIER_MODE` | Overrides the sink-classifier mode globally (see [coderadius.yaml](./coderadius-yaml.md)) |

The rate limiter is disabled under `vitest` unless an `LLM_RATE_*` variable is explicitly set, so test suites are unaffected.
