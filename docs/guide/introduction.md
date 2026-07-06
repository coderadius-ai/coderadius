# Introduction

CodeRadius is a CLI that builds a live graph of your architecture (services, APIs, databases, message queues, teams) by statically analyzing your repositories. It uses that graph to block breaking changes in CI, predict blast radius before merge, and give AI coding agents real system context instead of just the files in front of them.

---

## The problem

AI coding agents and large engineering teams share the same blind spot: they optimize locally and break globally.

An agent renames a JSON field in a message payload, unaware a consumer three teams away parses it. An engineer refactors a database table, unaware six services read from it via a shared query. A new team scaffolds a service without CI, without ownership metadata, without any of the standards the rest of the org follows.

None of this shows up in a file-level linter, a code search, or a Slack thread. The breakage is topological, not syntactical. You need a cross-repo model of how services, APIs, databases, and teams actually connect. CodeRadius builds that model and makes it queryable.

---

## What it does

### 1. Governance: policy enforcement across the fleet

A governance engine evaluates declarative YAML rules (each one a Cypher query) against the graph and surfaces non-compliant repositories or services as structured violations. `cr policy verify` runs the checks and writes the results; a nonzero exit blocks CI.

Nine rules ship today in the `agent-readiness` pack, among them: no team ownership detected (`ar-codeowners`), no CI pipeline with a test stage (`ar-tests-present`), missing architecture context files, and context-quality checks. The full table is in [Governance](./governance.md), and `cr policy export agent-readiness` writes the YAML locally as a starting point.

You write your own rules for anything else: deprecated dependencies, database access patterns, whatever your org needs enforced.

→ [Governance](./governance.md)

### 2. Impact evaluation: blast radius before merge

`cr blast` diffs your changed files against the live graph in memory, finds every downstream consumer of what you touched, and reports breaking changes before you open a PR.

- The topological diff itself is sub-millisecond; end-to-end wall time depends on your LLM provider's latency for the changed files
- Exit code `2` on breaking changes, `1` on warnings, `0` clean (all three block or pass CI depending on your pipeline config)
- `--advisory` forces exit `0` for gradual rollout
- Markdown output for PR comment injection (GitHub Actions, GitLab CI, Bitbucket)

Think of it as `terraform plan` for your architecture.

→ [Impact Evaluation](./impact-evaluation.md)

### 3. MCP context: source of truth for AI agents

CodeRadius ships a native [Model Context Protocol](https://modelcontextprotocol.io) server. Connected to your IDE, an agent can ask the graph:

- Before changing an API: who consumes this endpoint?
- Before renaming a field: what's the exact data contract?
- Before proposing a refactor: what's the blast radius?

The agent isn't reading files and guessing. It's querying the cross-repo topology CodeRadius already built.

→ [MCP Server Reference](./mcp-server.md)

### Also included

- **[Architecture Dashboard](./explore/architecture-dashboard.md)**: self-contained HTML report with service inventory, dependency graphs, SPOF analysis, and governance violations
- **[System Registry](./explore/system-registry.md)**: auto-generated catalog of every repository, service, and team
- **[SPOFs & Data Gravity](./explore/data-gravity.md)**: shared databases, service bottlenecks, and concentration risk, ranked by a 0-100 SPOF score
- **[Agent Harness](./explore/agentic-radar.md)**: AI tooling adoption across the fleet, including maturity levels, capability catalog, and context gaps

---

## Who it's for

| Role | Primary use |
|---|---|
| Individual engineers | See blast radius before proposing a refactor |
| Tech leads | Gate PRs on architectural contract violations |
| AI coding agents | Query architecture before making a change |
| Platform teams | Run fleet-wide scans, enforce consistency |
| Engineering leaders | Map agentic-context adoption across teams |

---

## Quick start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0 (or the standalone binary)
- Docker (for the Memgraph graph database)
- An LLM provider (Google AI Studio, Anthropic, OpenAI, Vertex AI, or AWS Bedrock all work; Ollama runs locally with no API key at all)

### 1. Install the CLI

```bash
git clone https://github.com/coderadius-ai/coderadius.git
cd coderadius && bun install && bun link
```

### 2. Configure the workspace

```bash
cr init
```

Walks you through picking and configuring an LLM provider (used for semantic extraction, `.crignore` generation, `cr ask`, and the sink classifier, not for your runtime). It can also generate a `.crignore` file to exclude frontend assets, vendored code, and other non-architectural noise from ingestion (opt-in prompt; if the LLM call fails, it degrades with a warning and you write `.crignore` by hand).

### 3. Start the graph database

```bash
cr up
```

Starts Memgraph in Docker with the config CodeRadius expects.

### 4. Sync your architecture

```bash
cr analyze code ./path/to/your/services/*
```

### 5. Use it

```bash
# Blast radius of your current changes (--base defaults to origin/main)
cr blast --base main --head HEAD

# Enforce governance rules, write results to the graph
cr policy verify --output graph

# Open the MCP server for your IDE
cr mcp start

# Generate the Architecture Dashboard
cr ui
```

---

## Supported languages and frameworks

Five languages ship native analysis: **TypeScript**, **PHP**, **Python**, **Go**, and **Java**, including framework-specific extraction for NestJS, Symfony, FastAPI, Express, Laravel, Gin, Spring Boot, and JAX-RS. CodeRadius auto-discovers REST APIs, OpenAPI specs, GraphQL resolvers, database connections, and message broker topologies without you writing any annotations.

→ [Full compatibility matrix](./supported-frameworks.md)

---

## Next steps

- [Use Cases](./use-cases.md): three scenarios where CodeRadius catches breakage before it ships
- [Governance](./governance.md): define and enforce architectural standards
- [Impact Evaluation](./impact-evaluation.md): predict blast radius before you commit
- [MCP Server](./mcp-server.md): connect your AI agents to the architecture graph
