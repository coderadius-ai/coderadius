# System Registry

The System Registry is an auto-generated service catalog: every repository, service, team, and API that CodeRadius has ingested, in one queryable set of tables. It exists to replace the manually maintained Backstage catalog entry that goes stale the week after someone writes it. The registry is rebuilt from the graph on every `cr analyze code` run, so it can't drift from what's actually in the repositories.

It's the default (first) tab of the [Architecture Dashboard](./architecture-dashboard.md).

```bash
# Open the full dashboard (System Registry is the first tab)
cr ui

# Render only the System Registry
cr ui --focus inventory
```

---

## What It Shows

The registry has five tabs: **Repositories**, **Services**, **Endpoints**, **Teams**, **Contracts**.

### Repositories

| Column | Description |
|--------|-------------|
| **Repository** | Full org/group/repo path, clickable link to the source |
| **Branch** | The ingested branch (e.g., `main`, `master`) |
| **Depth** | The depth of analysis performed: `CONTRACTS`, `SEMANTIC`, or `STRUCTURE` |
| **Stack** | Programming languages detected in the repository |
| **Teams** | Teams that own services stored in this repository |
| **Pulse** | Liveness: commit count over the last 12 months |

Click a row to open the **repository drawer**. See [Repository Detail Drawer](#repository-detail-drawer) below.

#### Analysis Depth

| Badge | Meaning | How to Get It |
|-------|---------|---------------|
| `CONTRACTS` | Full semantic extraction: intent, dependencies, capabilities, API call graph, and **data contracts** (produced/consumed payload schemas) | `cr analyze code --depth contracts` |
| `SEMANTIC` | Semantic code scan: intent, infrastructure dependencies, capabilities, API call graph via LLM analysis. Skips payload field extraction. | `cr analyze code` |
| `STRUCTURE` | Structural scan only: repository registered, agentic context and structural files detected, no code analysis | `cr analyze code --depth structure` |

Each level builds on the previous one. Re-running analysis with a higher `--depth` upgrades a repository from `STRUCTURE` → `SEMANTIC` → `CONTRACTS` without losing anything already extracted.

#### Pulse (Liveness)

Pulse is a tier derived from raw commit count over the trailing 12 months (no merge commits). It's a read on the property, not a separate data source. The tooltip shows the exact count.

| Tier | Badge | Commits (12 mo) |
|------|-------|------------------|
| `elite` | Green glow | ≥ 30 |
| `high` | Cyan glow | ≥ 5 |
| `medium` | Yellow, static | > 0 |
| `low` | Dim, static | 0 |
| `unknown` | No dot, renders `—` | No git history available (shallow clone, missing `.git`, path with no remote) |

The glow on `elite`/`high` is a static box-shadow, not an animation. `low` here means literally zero commits in the window, the opposite of what the tier name might suggest if you're used to other liveness schemes.

Pulse is informational in the System Registry. It does not filter or exclude any row from these tables. Despite what you might expect from an "aggregated metrics" framing elsewhere, it also does not currently exclude anything from the Agent Harness fleet counts. Every repository counts, live or not.

---

### Services

| Column | Description |
|--------|-------------|
| **Service** | The service name as detected from project structure or configuration |
| **Owner** | The team that owns this service (from Backstage catalog or git org) |
| **Stack** | Programming languages used by this service |
| **Repository** | The repository that contains this service, clickable |
| **Functions** | Total number of functions indexed by CodeRadius |
| **APIs** | Number of exposed API endpoints detected |
| **Dependencies** | Total package dependency count |

A dim em-dash (`—`) means missing data: no declared team owner, no detected endpoints, and so on.

---

### Endpoints

The API catalog: every logical API surface exposed anywhere in the fleet.

| Column | Description |
|--------|-------------|
| **API** | Title and version |
| **Source** | Where the surface was discovered (OpenAPI spec, code-inferred route, GraphQL SDL, ...) |
| **Services** | Services that expose this surface |
| **Owner** | Owning team, if known |
| **Repository** | Repository the spec or route lives in |
| **Endpoints** | Method/path pairs on this surface |
| **Deployments** | Environment + visibility + URL for each place it actually runs |
| **Consumers** | Number of distinct services observed calling it |

**Deduplication rule:** a row is keyed on `(repository, title, version, source)`. The same spec exposed by two services in one repo collapses into one row with two exposers. A vendored copy of the same spec sitting in a *different* repository stays a separate row. CodeRadius doesn't guess that they're the same surface across repos; it only merges what it can prove from the graph within one repository.

---

### Teams

| Column | Description |
|--------|-------------|
| **Team** | The team name as registered in the graph |
| **Type** | Team classification (e.g., `Stream-aligned`, `Platform`, `Enabling`) |
| **Services** | Number of services owned by this team |
| **Repositories** | Number of repositories owned by this team |
| **Stack** | Aggregate programming languages across all owned services |

---

### Contracts

Reserved for the data contract registry (produced/consumed payload schemas from OpenAPI, AsyncAPI, and GraphQL schemas). As of this build the tab is a placeholder. It renders an empty state, not a table. If you need contract data today, query it through `cr ask` or the graph directly; `CONTRACTS`-depth repositories already have the underlying `DataStructure` nodes, the UI just doesn't surface them here yet.

---

## Header Stats

| Metric | Description |
|--------|-------------|
| **Repositories** | Total number of repositories in the graph |
| **Services** | Total number of services extracted |
| **Teams** | Total number of teams detected |
| **Contracts** | Count of repositories at `CONTRACTS` ingestion depth (tooltip breaks down how many are `semantic`-only and `structure`-only) |

---

## Filtering, Searching, Export

Every table supports:

- **Global search**: filters across all visible text and hidden `searchValue` fields (repository URLs, hashes)
- **Column filters**: a dropdown of unique values per filterable column
- **Sorting**: click any column header
- **Export**: downloads the currently filtered table as CSV

The CSV export is tab-aware: the **Endpoints** export carries `spec` and `consumers` columns that the other tabs don't have, because those columns only make sense for API rows. Each tab exports the columns it actually renders, not a lowest-common-denominator schema.

---

## Repository Detail Drawer

Clicking a repository row opens a drawer with everything the registry knows about that repo beyond the table columns:

- **Hosting platform** badge (`github`, `gitlab`, `bitbucket`, `azure-devops`)
- **Core branches**: `main`/`master`/`develop`/`release/*`/`hotfix/*` detected in the repo, with the default branch marked
- **CI/CD pipelines**: tool, whether a test stage and a deploy stage were detected, job count, and (where extractable) the stage/trigger list
- **Docker images**: tagged by context (`base_image`, `infrastructure`, `ci_runner`), with the file they were declared in
- **Package manager / tool configs**: npm, yarn, pnpm, bun, and other detected tool settings
- **Scheduled tasks**: cron-like jobs discovered in the repo (name + runner)

None of this is on the table row itself. It's only visible after you click through, which keeps the table dense and the detail available on demand.

---

## Organizations and Tenants

Two fields exist on the inventory report but aren't rendered as their own tab:

- **Organizations**: a single-level grouping (GitLab base group, GitHub org, or IDP unit), each with its own repo and service counts. Used by the dashboard's org filter, not shown as a standalone table.
- **Tenant**: an optional single object (`name`, `slug`, `description`) for multi-tenant CodeRadius deployments. When set, it names the catalog in the UI header instead of the generic "Enterprise catalog" label.

---

## Relationship to `cr analyze`

The registry is populated during the analysis pipeline:

1. **`cr analyze code --depth structure`**: Scans repositories for metadata (team ownership, agentic configs, structural files). Creates `STRUCTURE`-level entries.
2. **`cr analyze code`**: Full LLM-powered semantic analysis: intent, infrastructure dependencies, capabilities, API call graph. Creates `SEMANTIC`-level entries.
3. **`cr analyze code --depth contracts`**: Extends `SEMANTIC` with data contract extraction: produced and consumed payload schemas for every I/O boundary. Creates `CONTRACTS`-level entries.

A repository upgrades `STRUCTURE` → `SEMANTIC` → `CONTRACTS` by re-running analysis at a higher depth. Nothing needs to be torn down first.

---

## Further Reading

- [Architecture Dashboard](./architecture-dashboard.md): The unified dashboard that contains the System Registry
- [CLI Reference -- `cr analyze`](../cli-commands.md#architecture-analysis): Analysis commands that populate the registry
- [Agent Harness](./agentic-radar.md): AI-tooling readiness and skill duplication, built on top of registry data
