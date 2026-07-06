# Technical Documentation: Team Mapping & Repository Discovery

This document describes CodeRadius's internal logic for team detection, organization mapping, and repository path resolution within the architectural graph.

## 1. Entity Architecture (Core Nodes)

CodeRadius uses three main nodes to define the organizational hierarchy in the Neo4j graph:

-   **Team**: Represents an organizational unit (e.g. "checkout-team").
-   **Service**: Represents a logical/technical component (e.g. "order-api").
-   **Repository**: Represents the physical anchor of the source code (e.g. "github.com/acme/order-service").

The main relationships are:
-   `(Team) -[:OWNS]-> (Service)`
-   `(Service) -[:STORED_IN {path: "..."}]-> (Repository)`

---

## 2. Team Detection & Mapping

Team detection happens primarily during the bootstrap of the ingestion pipeline, through two mechanisms:

### A. Backstage (Authoritative Source)
CodeRadius scans repositories for `catalog-info.yaml` files.
-   **Kind: Group**: Every entity of type `Group` is mapped directly to a `Team` node.
-   **Spec: Owner**: In a `Component` entity, the `spec.owner` field defines the team that owns the service.
-   **URN Normalization**: The `normalizeDependencyRef` function cleans up references (e.g. `group:default/my-team` becomes `my-team`).

### B. Manual Overrides
Explicit mappings can be defined in the `coderadius.yaml` file at the repository root (loaded via `loadRepoHints`).

### Identity and URNs
Every team has a globally unique ID in URN format: `cr:team:{normalized-name}`. This makes it possible to correlate the same team across different repositories.

---

## 3. Organization Mapping (Org)

The `org` attribute on `Repository` nodes is extracted automatically from the git remote URL during the **Source Resolution** phase.

### Parsing Logic
The `parseRepoUrl` function uses regexes to extract the organization from both HTTPS and SSH URLs:
-   `https://github.com/team-gateway/payment-service.git` → **Org**: `team-gateway`
-   `git@gitlab.acme.com:core-libs/core-libs.git` → **Org**: `core-libs`

### Root Organization
For nested groups (e.g. GitLab), the full path between the host and the final repo-name segment is preserved as `org` (no first-segment truncation). If no URL is available, the default value is `unknown`.

---

## 4. Backstage Config Parsing

The extraction process (`backstage-extractor.ts`) follows strict rules to guarantee data quality:

1.  **File Discovery**: Globally searches for `**/{catalog-info,catalog,system,systems}.yaml`.
2.  **Template Skipping**: Skips files containing template markers such as `${{` or `{%`. This avoids processing Backstage *Scaffolder* templates that are not real entities.
3.  **Schema Validation**: Uses `BackstageCatalogEntitySchema` (Zod) to validate the entity structure before inserting it into the graph.
4.  **Multi-document Support**: Supports YAML files containing multiple documents separated by `---`.

---

## 5. Directory Structure & Repository Paths

CodeRadius maps the physical disk structure to logical identities in the graph.

### Monorepo Routing
During the scan (`file-discovery.ts`), files are routed based on their path:
-   `apps/<name>/**` → Mapped as a **Service** (`<name>`).
-   `packages/<name>/**` → Mapped as a **Library** (`<name>`).
-   Root-level paths → Mapped to the overall **Repository**.

### Heuristic Auto-Discovery (Fallback)
If no Backstage catalog is found, `autodiscovery.ts` kicks in:
1.  **Indicators**: Looks for manifest files such as `package.json`, `go.mod`, `composer.json`, `requirements.txt` or `Dockerfile`.
2.  **Service Roots**: The directory containing the manifest is elected as the "Service Root".
3.  **Deduplication**: If multiple manifests exist in nested hierarchies (e.g. root and subfolder), the deepest (child) directory wins by default. The root/parent manifest is treated as workspace tooling and pruned, unless it vendors the child as a local path dependency ("monolith-root rescue"), in which case the root is kept too.

---

## 6. Collision Handling and Priorities

When information conflicts, CodeRadius applies the following priorities:

1.  **Backstage > Heuristics**: If a service is explicitly defined in a `catalog-info.yaml`, Backstage data always wins over auto-discovery (e.g. service name and team owner).
2.  **Directory Claiming**: A `claimedPaths`/`claimedSet` mechanism ensures that a directory cannot be claimed by two different services in the same run.
3.  **Language Detection**: Autodiscovery's detected language always wins over Backstage's declared language when autodiscovery finds one (`language: auto.language ?? primary.language`); Backstage's value is only used as a fallback when autodiscovery has no language signal. This is the opposite precedence of name/owner/system/dependsOn, which are catalog-sourced.

---

## 7. Querying & Consumer Services

Team and Org data is consumed by the various CodeRadius services:

### MCP Server (AI Interface)
-   **`list_services`**: Returns, for each service, its `teamOwner` and owning repository.
-   **`resolve_service_context`**: Given a file path (e.g. `apps/checkout/handler.ts`), walks up to the `Service` and from the service to the owning `Team`.
-   **`analyze_agentic_context`**: Generates per-team aggregate reports (e.g. "Which teams are using AI tools?").

### Dashboard (UI)
-   **Service Topology**: Displays team ownership badges.
-   **Impact Explorer**: Filters the "Blast Radius" of a change by impacted organization or team.
-   **Architecture Gravity**: Identifies SPOFs (Single Points of Failure) by aggregating bottlenecks per team.

---

> [!NOTE]
> This document reflects the state of the implementation as of the current CLI version. If the URL-parsing regexes or the language plugins change, update the relevant sections.
