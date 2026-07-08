# System Architecture

Understanding how CodeRadius works internally helps you configure it accurately, troubleshoot unexpected graph results, and reason about what will and will not be captured during ingestion. This document covers the full lifecycle: from raw source code on disk to a queryable architectural graph in Memgraph.

---

## High-Level Overview

CodeRadius is composed of three principal layers that operate in sequence during an ingestion run:

```
┌────────────────────────────────────────┐
│         Ingestion Pipeline             │
│  Source Resolution → Extraction →      │
│  LLM Semantic Analysis → Graph Upsert  │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│         Memgraph Graph Database        │
│  Nodes: Service, Repository, Team...   │
│  Edges: STORED_IN, OWNS, CALLS...      │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│  Query & Delivery Layer                │
│  MCP Server / CLI Reports / REST API   │
└────────────────────────────────────────┘
```

The ingestion pipeline writes to the graph. The query layer reads from it. These two operations are fully isolated, which means running a query or starting the MCP server never requires re-ingesting code.

---

## Phase 1: Source Resolution

Before extracting anything, CodeRadius resolves the repository topology. Given a target path (or a list of paths), the **Source Resolver** identifies:

- **Repository boundaries**: Does the target contain one repository or many? Are they in a monorepo structure or independent repositories?
- **Service boundaries**: Within each repository, which directories represent discrete deployable units (services)?
- **Team ownership**: If a Backstage catalog (`catalog-info.yaml`) or custom ownership files exist, they are parsed to associate services with team nodes.

The source resolver is designed to handle enterprise-scale inputs without requiring all repositories to be cloned. It can resolve targets from:
- Local disk paths (`cr analyze code ./services/*`)
- Git remote URLs (for CI pipelines referencing specific commits)
- Backstage catalogs (for organization-wide service discovery)

### The `.crignore` File

Just as `.gitignore` directs `git` to ignore irrelevant files, `.crignore` tells CodeRadius what to exclude from ingestion. Typical exclusions include:

```
# Frontend assets
*.css
*.scss
/public/**

# Vendored code
/vendor/**
/node_modules/**

# Generated files
*.generated.ts
build/**
dist/**
```

`cr init` can generate a `.crignore` for you: it scans the repository's directory tree and asks an LLM agent (`crignoreAgent`) to propose exclusion rules; you're prompted before it runs and before it overwrites an existing file.

---

## Phase 2: Structural Extraction (Zero-LLM)

Structural extraction is the fast, deterministic phase that runs without any LLM calls. It is powered by a **plugin-based architecture** where each plugin knows how to identify and parse a specific class of files.

Structural plugins are designed for static artifact files: those that carry configuration or contract information that can be parsed without semantic understanding. Each plugin:
1. Declares which files it is interested in (via a `matchFile` predicate)
2. Extracts structured nodes and relationships from matching files

### Built-in Structural Plugins

| Plugin | What It Extracts |
|--------|-----------------|
| `dockerfile` | `Dockerfile` → `DockerImage` nodes, base image detection |
| `container-image` | `docker-compose.yml`, Helm charts, K8s manifests → `DockerImage` nodes (`USES_IMAGE`) |
| `package-publisher` | `package.json`, `composer.json` → `Package`, `Release` nodes and dependency relationships |
| `makefile` | `Makefile`, `GNUmakefile` → `Task` nodes (build targets) |
| `github-actions` | `.github/workflows/*.yml` → `CIPipeline`, `Task` nodes |
| `gitlabci` | `.gitlab-ci.yml` → `CIPipeline` nodes with stage/trigger metadata |
| `toolconfig` | `tsconfig.json`, etc. → `ToolConfig` nodes (compiler settings) |
| `renovate` | `renovate.json`, `.renovaterc` → `ToolConfig` nodes (automerge policy) |
| `devtools` | `catalog-info.yaml`, `devcontainer.json` → `StructuralFile` provenance, `System`/`Team` linkage |
| `ghost-directories` | Inferred from filesystem layout → `ProjectDirectory` nodes |
| **`agentic-config`** | AI tool configurations → `AgenticConfig` nodes *(core for the Radar)* |

OpenAPI 2/3 specs (`APIInterface`, `APIEndpoint` nodes) and Backstage
`catalog-info.yaml` (`System`, `Domain`, `Team`, `Service` nodes) are also
extracted with zero LLM calls, but by dedicated top-level extractors
(`src/ingestion/extractors/openapi-extractor.ts`,
`src/ingestion/extractors/backstage-extractor.ts`) rather than by the
`StructuralPlugin`/`FILE_PLUGINS` contract above.

### The Agentic Config Plugin in Detail

This plugin is the foundation of the **Agent Harness**. It matches files from 28+ AI coding tools using path-based regular expressions:

```
.cursorrules              → cursor / global_rule
.cursor/rules/*.mdc       → cursor / rule
.cursor/mcp.json          → cursor / mcp_config
.windsurfrules            → windsurf / global_rule
CLAUDE.md                 → claude / global_rule
GEMINI.md                 → gemini / global_rule
.agents/skills/*/SKILL.md → generic / skill
.agents/workflows/*.md    → generic / workflow
langgraph.json            → langgraph / multi_agent_config
config/agents.yaml        → crewai / subagents_config
```

For each matched file, the plugin extracts:

- **`tool`**: The AI coding tool the file is intended for (cursor, windsurf, claude, gemini, etc.)
- **`configType`**: The functional category of the file (`global_rule`, `rule`, `skill`, `workflow`, `mcp_config`, `memory_bank`, etc.)
- **`topics`**: Automatically extracted governance topics via keyword scanning (security, testing, architecture, ci-cd, database, etc.)
- **`contentFingerprint`**: A normalized hash for near-duplicate detection, computed after stripping whitespace and comments, making it resilient to cosmetic differences between copies
- **`description`**: Extracted from YAML frontmatter or the first heading in the file body

---

## Phase 3: Taint-Based Code Analysis

For source code files (TypeScript, PHP, Python, Go, Java), CodeRadius uses a **Taint Analysis Engine** to identify functions that perform external I/O. These are the only functions that can affect cross-service architectural contracts.

### How the Taint Engine Works

A function is considered "tainted" if it:
- Makes an outbound HTTP call
- Reads from or writes to a database table
- Publishes to or consumes from a message broker (RabbitMQ, PubSub)
- Reads sensitive environment variables
- Invokes inter-process communication mechanisms

Functions that perform only internal business logic (pure functions, transformations, validation) are **ignored entirely**. This means that on a typical enterprise codebase, the taint filter eliminates **85%+ of all functions** before a single LLM token is spent. This is what makes enterprise-scale ingestion economically viable.

### AST Parsing with Tree-sitter

The taint analysis is built on [Tree-sitter](https://tree-sitter.github.io/tree-sitter/), a high-performance, language-agnostic AST parser. CodeRadius uses language-specific grammars to parse source code into Abstract Syntax Trees and query them using Tree-sitter's query language.

This approach is:
- **Significantly faster** than regex-based parsing
- **Resilient to formatting variations** (any valid file parses correctly)
- **Accurate** in identifying call sites and data flows at the AST level

---

## Phase 4: Semantic Extraction (LLM)

Tainted functions identified in Phase 3 are passed to the **Value Resolution Engine** and subsequently the **LLM Extraction Agent** to perform semantic analysis. This is where implicit knowledge becomes explicit graph data.

### Value Resolution Engine (Zero-LLM Triage)

Before invoking the LLM, the system performs a static cross-file value resolution of critical I/O invocations. If an infrastructure target (e.g., topic name, database table) can be resolved statically with high confidence (≥ 0.9), the system generates the architectural edges directly and **skips the LLM entirely**. If partially resolved, it injects the traced context into the LLM prompt to maximize accuracy.

### LLM Extraction Agent

For functions that cannot be resolved fully statically, the LLM agent:
- Infers the **intent** of each tainted function (e.g., "Fetches an order by ID from the orders service")
- Extracts the **data contract**: if the function produces or consumes a payload, it identifies the payload fields and their types
- Identifies the **target resource**: which API endpoint, database table, or message channel the function is interacting with
- Resolves **cross-service edges**: matches client-side calls (Service A references `/api/v1/orders`) to canonical server-side endpoints discovered during Phase 2

### LLM Provider Support

CodeRadius is **fully provider-agnostic**. The model layer (`src/ai/models/provider.ts`) is a simple factory that delegates to 6 pluggable backends. Any model string supported by the provider SDK works:

| Provider ID | Backend | Auth |
|-------------|---------|------|
| `vertex` | Google Vertex AI | Service account / ADC |
| `google-genai` | Google AI (Gemini API) | API key |
| `anthropic` | Anthropic | API key |
| `openai` | OpenAI (or any OpenAI-compatible endpoint via `baseURL`) | API key |
| `ollama` | Ollama (local) | None |
| `bedrock` | Amazon Bedrock | AWS credentials (`~/.aws/credentials`) or IAM role |

Provider and model are configured **per-tier** in `~/.coderadius/config/settings.json`: `ai.fast` covers high-volume work (`ingest`, `mcp`), `ai.smart` covers quality work (`chat`, `doc`). Per-action keys (`ai.chat`, `ai.doc`, ...) and environment variables (`MODEL_PROVIDER`, `MODEL_NAME`, `MODEL_NAME_<ACTION>`) override their tier. This allows running ingestion on a cost-efficient model while using a frontier model for interactive chat.

### Merkle Hash Cache

To avoid re-running costly LLM calls on unchanged functions, CodeRadius computes a **Merkle hash** of each source file. If the hash has not changed since the previous ingestion run, the cached extraction results are returned immediately, skipping the LLM entirely.

On incremental runs (after small code changes), only modified files trigger LLM extraction. This makes incremental ingestion complete in seconds rather than hours.

---

## Phase 5: Graph Upsert

After extraction, all nodes and relationships are written to **Memgraph**, an in-memory graph database compatible with the openCypher query language (the same query language as Neo4j).

Every inferred node and edge written in this phase carries a **provenance** block that stamps the fact's origin (`source`), supporting evidence (`evidence_*`), and trust tier (`quality`). The categorical model lets the dashboard, the `cr doctor` triage queue, and the CLI's `--quality-at-least` / `--source` filters branch on the same vocabulary. See [Grounding, Evidence, Quality](./grounding.md) for the full producer contract, the quality assignment matrix, and the welder ordering invariant.

### The Graph Data Model (Ontology)

CodeRadius maintains a strict ontology of node types. Every node type has a corresponding Zod schema that enforces type safety end-to-end from ingestion to query:

#### Core Topology Nodes
| Node | Description |
|------|-------------|
| `Domain` | High-level business domain (e.g., payments, identity) |
| `System` | A group of related services forming a bounded context |
| `Team` | An engineering team. Owns services. |
| `Service` | A discrete deployable unit (microservice, function, monolith) |
| `DeploymentUnit` | A runtime boundary within a monolith (Helm release, nginx vhost). Auto-detected when multiple catalog components share a directory. See [Service Topology](./service-topology.md). |
| `Repository` | A Git repository. Services are stored in repositories. |

#### Contract Nodes
| Node | Description |
|------|-------------|
| `APIInterface` | An OpenAPI specification or auto-discovered API surface |
| `APIEndpoint` | A single HTTP endpoint (`GET /users/{id}`) |
| `DataStructure` | A known data schema (database table or message payload) |
| `DataField` | A field within a `DataStructure`, with its type |
| `MessageChannel` | A topic, queue, exchange, transport, or logical event. The `scope` property distinguishes `logical` (business event), `physical` (broker address), and `transport` (Symfony Messenger wrapper). See [Messaging Domain Model](./messaging-domain-model.md). |
| `MessageBroker` | A physical broker instance (RabbitMQ cluster, Kafka cluster, SQS account+region, Pub/Sub project, …). Identity is fingerprinted on `(provider:host:port:vhost)` so two clusters with the same nominal name never collide. |

#### Implementation Nodes
| Node | Description |
|------|-------------|
| `Function` | A tainted function with its intent and capabilities |
| `SourceFile` | A source code file that contains functions |
| `Package` | An npm or Composer package dependency |
| `Release` | A published version of a `Package`, with version and timestamp |
| `EnvVar` | An environment variable read by a service |
| `AgenticConfig` | An AI coding tool configuration file *(Radar layer)* |

#### Infrastructure Nodes
| Node | Description |
|------|-------------|
| `Datastore` | A database instance (postgres, redis, etc.) |
| `DataContainer` | A table, collection, or queue-backed data container within a `Datastore` |
| `DockerImage` | A container image used by a service |
| `APIDeployment` | A deployment surface (base URL / host) of an `APIInterface` (public ingress, internal mesh, or env-var-synthesized) |

#### Structural / Governance Nodes
| Node | Description |
|------|-------------|
| `StructuralFile` | A configuration file detected during structural extraction (provenance node). Links an owner (`Repository` or `Service`) to the entities it defines. |
| `ToolConfig` | A tool-level configuration node (e.g., `tsconfig.json`, `renovate.json`). Carries extracted settings (strictness flags, automerge policy). |
| `CIPipeline` | A CI/CD pipeline definition (`.gitlab-ci.yml`, `.github/workflows/*.yml`). Carries stage, trigger, job count, and environment metadata. |
| `Task` | A named build target or script command extracted from a `Makefile`, `package.json`, or `composer.json` scripts block. |
| `ProjectDirectory` | A semantically meaningful directory inferred from filesystem layout (e.g., `tests/`, `docs/`, `migrations/`). |

### Key Relationships (Edges)

#### Ownership & Topology
| Relationship | Meaning |
|-------------|---------|
| `(Team)-[:OWNS]->(Service)` | Team ownership, sourced from Backstage or `coderadius.yaml` |
| `(Service)-[:STORED_IN]->(Repository)` | Service to repository mapping |
| `(System)-[:CONTAINS]->(Service)` | Bounded context membership |
| `(Service)-[:DEPLOYED_AS]->(DeploymentUnit)` | Monolith facet: Service is deployed as this runtime unit. See [Service Topology](./service-topology.md). |

#### API & Messaging
| Relationship | Meaning |
|-------------|---------|
| `(Service)-[:EXPOSES_API]->(APIInterface)` | Service exposes an API surface |
| `(Service)-[:CALLS]->(APIEndpoint)` | Cross-service HTTP dependency |
| `(Function)-[:PUBLISHES_TO {routingKey?, partitionKey?}]->(MessageChannel)` | Async event production. Routing key participates in the edge identity, so two publish call sites with different keys produce two distinct edges. |
| `(Function)-[:LISTENS_TO {consumerGroup?, filterExpression?}]->(MessageChannel)` | Async event consumption (Kafka consumer-group, SQS subscription, Pub/Sub filter expression). |
| `(MessageChannel)-[:ROUTES_TO {bindingKey, isPattern, patternRegex}]->(MessageChannel)` | Exchange → queue binding. AMQP topic wildcards (`*`, `#`) compile to `patternRegex` at ingestion so cross-service queries match via `routingKey =~ patternRegex`. |
| `(MessageChannel)-[:HOSTED_ON]->(MessageBroker)` | Channel runs on this broker. Anchors the cross-broker isolation guard. |
| `(MessageChannel{logical})-[:MANIFESTS_AS]->(MessageChannel{physical})` | A business event is realised by N physical channels (Shovel / Federation / MirrorMaker, or LLM-extracted → config-declared). |
| `(MessageChannel{transport})-[:BACKED_BY]->(MessageChannel{physical})` | Symfony Messenger transport sits on top of an underlying physical queue/exchange. |
| `(MessageChannel)-[:DEAD_LETTERS_TO]->(MessageChannel)` | Captures second-order blast: a broken consumer pushes backlog onto its DLQ. |

#### Data Access
| Relationship | Meaning |
|-------------|---------|
| `(Function)-[:READS]->(DataContainer)` | Database read access |
| `(Function)-[:WRITES]->(DataContainer)` | Database write access |
| `(Function)-[:PRODUCES]->(DataStructure)` | Function produces a known payload |
| `(Function)-[:CONSUMES]->(DataStructure)` | Function consumes a known payload |

#### Structural Provenance
| Relationship | Meaning |
|-------------|---------|
| `(Service\|Repository)-[:HAS_CONFIG]->(StructuralFile)` | Links an owner to a detected configuration file |
| `(StructuralFile)-[:DEFINES]->(Task\|ToolConfig\|CIPipeline\|...)` | A structural file is the source of record for an extracted entity |

#### Golden Path Shortcut Edges
These edges bypass the `StructuralFile` provenance chain and link owners directly to extracted entities for fast compliance queries (`cr policy verify`).

| Relationship | Meaning |
|-------------|---------|
| `(Service\|Repository)-[:HAS_TASK]->(Task)` | Shortcut to a build target |
| `(Service\|Repository)-[:HAS_TOOL_CONFIG]->(ToolConfig)` | Shortcut to a compiler/tool config (tsconfig, renovate) |
| `(Service\|Repository)-[:HAS_CI_PIPELINE]->(CIPipeline)` | Shortcut to a CI pipeline definition |
| `(Service\|Repository)-[:HAS_DOCKER_IMAGE]->(DockerImage)` | Shortcut to a container image |
| `(Service\|Repository)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig)` | Shortcut to an AI tool configuration |

#### Package & Release
| Relationship | Meaning |
|-------------|---------|
| `(Repository)-[:PUBLISHES]->(Package)` | Repository publishes a package |
| `(Repository)-[:DEPENDS_ON]->(Package)` | Repository declares a package dependency |
| `(Package)-[:HAS_RELEASE]->(Release)` | Package has a published version |

#### Container
| Relationship | Meaning |
|-------------|---------|
| `(StructuralFile)-[:USES_BASE_IMAGE]->(DockerImage)` | Dockerfile uses a specific base image |
| `(Service)-[:CONTAINS_DIRECTORY]->(ProjectDirectory)` | Service contains a semantically categorized directory |

---

## The Query Layer

The query layer provides three different surfaces for reading from the graph:

### MCP Server

```bash
cr mcp start
```

Provides AI coding agents with 10 tools for real-time architectural context. The server speaks the Model Context Protocol and is compatible with any MCP-aware IDE or agent framework (Cursor, Windsurf, Mastra, LangGraph, etc.).

### Generate the unified architecture dashboard
```bash
cr ui
```

### CLI Reports

```bash
cr blast --files orders
```

CLI commands execute Cypher queries against the graph and render results as rich terminal output or self-contained HTML dashboards.

### Cypher (Direct)

If you need raw graph access, you can connect directly to Memgraph using the Bolt protocol (`bolt://localhost:7687`). The Memgraph Lab web interface (started via `cr up`) provides a visual query editor.

---

## Observability: Liveness Data

CodeRadius enriches the graph with **liveness data**: a measure of how active each repository is in terms of recent commit velocity. Liveness is computed during structural extraction by analyzing the git commit log for each ingested repository.

### Liveness Levels

| Level | Commits (last 12 months) | Meaning |
|-------|------------------------|---------|
| `elite` | ≥ 30 | Core active project, high engineering throughput |
| `high` | 5-29 | Steadily maintained project |
| `medium` | 1-4 | Infrequently touched, but alive (e.g., critical infrastructure, stable libraries) |
| `low` | 0 | No recent commits. Likely abandoned or frozen. |
| `unknown` | N/A | Git history unavailable (shallow clone or access error) |

The graph stores the raw `Repository.livenessCommits` scalar; the discrete tier above (`elite`/`high`/`medium`/`low`/`unknown`) is derived on read via `tierFromCommits()`. The Agent Harness uses liveness data to ensure that `low` repositories do not skew organizational metrics. However, `medium` pulse repositories are **intentionally included** in the radar because they often represent critical, stable components (infrastructure libraries, shared SDKs) that are important but not actively developed.

---

## Infrastructure Components

### Memgraph

CodeRadius uses [Memgraph](https://memgraph.com/) as its graph database. Memgraph is an in-memory, openCypher-compatible graph database that processes complex graph traversals in milliseconds.

```bash
# Start Memgraph and Memgraph Lab
cr up

# Memgraph Bolt endpoint: bolt://localhost:7687
# Memgraph Lab UI: http://localhost:3001
```

> [!NOTE]
> CodeRadius uses a vector index in Memgraph (cosine similarity; dimension matches the configured embedding provider, e.g. 768 for Gemini, 1024 for Bedrock) for the semantic duplicate detection feature in the Agent Harness. The index is created lazily on first ingestion run, not on `cr up`.

### Resource Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Memgraph RAM | 2 GB | 8-16 GB (scales with fleet size) |
| Memgraph Disk | 500 MB | 10+ GB (for large organization graphs) |
| Processing (ingestion) | 4 vCPU | 8+ vCPU (for parallel ingestion) |
