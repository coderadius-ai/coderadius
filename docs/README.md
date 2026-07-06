# CodeRadius Documentation

CodeRadius builds a live, queryable graph of your services, APIs, databases, and teams from your actual code. It uses that graph to catch cross-repo breakage before it ships: enforce architectural policy in CI, evaluate blast radius on a proposed change, and give AI coding agents real architectural context instead of a guess.

## User Guide

### Core Workflows

- **[Use Cases](./guide/use-cases.md)**: Three concrete scenarios where CodeRadius prevents production incidents that linters and code search cannot catch.
- **[Governance](./guide/governance.md)**: Enforce architectural standards across your fleet in CI and in dashboards. Declarative YAML policies evaluated against the live graph.
- **[Impact Evaluation](./guide/impact-evaluation.md)**: Predict breaking changes and blast radius before merge. Like `terraform plan` for architecture.
- **[Vulnerability Scanning](./guide/vulnerability-scanning.md)**: Fleet-wide CVE intelligence on every analysis run. Know which services run a vulnerable version, who owns them, and what ships the fix.
- **[MCP Server](./guide/mcp-server.md)**: Give AI coding agents live architectural context so they stop breaking downstream systems.
- **[Grounding & Trust Tiers](./guide/grounding.md)**: What the colored dots on the dashboard mean, how to triage flagged entities, and how to filter by trust tier from the CLI.

### Setup & Configuration

- **[Introduction](./guide/introduction.md)**: What CodeRadius is, the problem it solves, and how to get started in under 10 minutes.
- **[CLI Commands](./guide/cli-commands.md)**: Complete reference of all available terminal commands and their flags.
- **[coderadius.yaml](./guide/coderadius-yaml.md)**: Teach the AI about proprietary SDKs and map database identities without writing code.
- **[.crignore](./guide/crignore.md)**: Control which files are excluded from analysis during ingestion.
- **[Supported Frameworks](./guide/supported-frameworks.md)**: Languages, frameworks, protocols, databases, and message brokers that CodeRadius analyzes out-of-the-box.

### Explore

- **[Architecture Dashboard](./guide/explore/architecture-dashboard.md)**: Self-contained HTML report for architectural health, dependency governance, and SPOF analysis.
- **[System Registry](./guide/explore/system-registry.md)**: Auto-generated service catalog of every repository, service, and team.
- **[SPOFs & Data Gravity](./guide/explore/data-gravity.md)**: Single Points of Failure detection and architectural bottleneck ranking.
- **[Agent Harness](./guide/explore/agentic-radar.md)**: AI tooling adoption metrics, maturity matrix, and context gap analysis.
- **[Blast Radius Scoring](./guide/explore/blast-radius-scoring.md)**: How CodeRadius classifies the risk of changing or breaking an architectural node using the Downstream Gravity Score and Impact Tiers (T0-T4).
- **[Context Engineering](./guide/explore/context-engineering.md)**: How to use CodeRadius to build and distribute organizational AI coding standards through context engineering.

## Architecture Deep-Dives

- **[System Architecture](./architecture/architecture.md)**: How CodeRadius constructs the architectural graph, from ingestion pipeline to graph storage and query layer.
- **[CodeRadius Code Ingestion Pipeline](./architecture/ingestion-pipeline.md)**: How the pipeline transforms a repository into a knowledge graph, filtering out as much noise as possible before invoking any LLM.
- **[Grounding, Evidence, Quality](./architecture/grounding.md)**: How CodeRadius attributes every node and edge in the graph to its origin, supporting evidence, and trust tier.
- **[Impact Explorer Scoring System](./architecture/impact-scoring.md)**: Mathematical specification of the Downstream Gravity Score that feeds the T0-T4 impact tier classifier.
- **[API Endpoint Dedup & Cross-Service Matchmaking](./architecture/api-endpoint-dedup.md)**: How CodeRadius prevents duplicate APIEndpoint nodes when the same logical route is described by multiple producers, and joins consumer->provider edges across services.
- **[Service Topology Architecture](./architecture/service-topology.md)**: The code-first identity model: filesystem autodiscovery decides what services exist, catalogs decide who owns them, and the topology resolver welds the two together.
- **[Catalog Drift: Grounded-Identity Reconciliation](./architecture/catalog-drift-grounding.md)**: How `cr drift` reconciles a catalog's declared facts against the code-observed graph; drift is only asserted between facts that resolve to the same real graph node.
- **[Data Domain Model](./architecture/data-domain-model.md)**: The logical/physical split for datastore topology: one logical identity, N physical surfaces, one per deployment environment.
- **[Messaging Domain Model](./architecture/messaging-domain-model.md)**: Three-layer ontology for message broker topology, scaling from a single cluster to multi-region, multi-tenant enterprise deployments.
- **[Graph URN Taxonomy](./architecture/datatable-identity-scoping.md)**: The canonical URN templates that key the CodeRadius graph; resources that should converge to the same node must produce the same URN.
- **[Library vs Package: Component Ontology](./architecture/component-library-vs-package.md)**: Disambiguates workspace-internal code (`:Library`) from declared dependencies (`:Package`) in the graph domain.
- **[Contrib Plugin System & Crossplane PubSub Extraction](./architecture/contrib-plugins.md)**: Extending the structural extraction layer with domain-specific plugins that extract infrastructure topology from Helm chart Crossplane CRD templates.
- **[Incremental Cache Versioning](./architecture/incremental-cache-versioning.md)**: The engine-versioned Merkle tree: how CLI upgrades with improved detection logic invalidate only the affected slice of the graph cache, without full re-ingestion.
- **[Graph Database Optimizations](./architecture/graph-database-optimizations.md)**: Traversal vs label scans: how the fundamental graph queries (like the Merkle index query) avoid performance bottlenecks at multi-tenant scale.
- **[Team Mapping & Repository Discovery](./architecture/team-mapping-logic.md)**: Internal logic for team detection, organization mapping, and repository path resolution within the architectural graph.
