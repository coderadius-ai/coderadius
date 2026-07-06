# SPOFs & Data Gravity

The **SPOFs** domain finds the most dangerous concentration points in your architecture: resources and services where a single failure cascades across the organization. It answers the question every principal engineer dreads: *"If this one thing breaks, how many teams feel it?"*

```bash
# Full dashboard
cr ui

# SPOFs domain only
cr ui --focus gravity
```

---

## What It Detects

Two classes of risk, both requiring at least two distinct services touching the resource. A single-service dependency is never a SPOF by definition.

### Data Monoliths

A shared data resource (such as `DataContainer`, `Datastore`, or `MessageChannel`) accessed by a disproportionate number of services. When it changes schema, goes down, or needs migration, the blast radius is wide.

**Examples:**
- A `users` table read by 14 services and written by 3
- An `order.created` message channel consumed by 9 downstream services

API endpoints are never scored as data monoliths. They only ever show up as a dependency edge inside a *service bottleneck's* footprint (see below), never as a monolith row of their own.

### Service Bottlenecks

A service on a critical path in the dependency graph. This might be a heavily-consumed API provider or the sole writer to a shared resource.

**Examples:**
- An `identity-service` that 20 other services depend on for authentication
- A `payment-gateway` that's the sole producer for 5 downstream event consumers

---

## The SPOF Score

Every data monolith and service bottleneck gets a **SPOF Score** from 0 to 100:

```
raw = (distinctServices × 2.0) + (distinctTeams × 3.0) + (writeCount × 1.5) + (readCount × 0.5)
score = 100 × (1 − e^(−raw / 15))
```

Four inputs, one formula, applied identically to every resource type:

- **Distinct services**: how many services touch this resource at all
- **Distinct teams**: cross-team span; concentration inside one team is lower risk than the same fan-in spread across teams
- **Write count**: writes create contention and lock risk, weighted highest
- **Read count**: reads create coupling risk, weighted lowest

There's no per-type multiplier. A `MessageChannel` and a `Datastore` with identical fan-in/fan-out numbers score identically. If you were expecting database tables to be weighted higher than API endpoints for "schema coupling," that's not implemented; the score is purely topological.

The asymptotic curve means score growth slows as raw risk climbs. Going from 2 to 4 dependent services moves the score a lot more than going from 20 to 22.

### Reading the Score

The dashboard renders SPOF rows through the same tier classifier used by the [Blast Radius Explorer](./blast-radius-scoring.md), not a separate SPOF-specific band:

| Score | Tier |
|-------|------|
| 100+ | **Seismic** |
| 50-99 | **Critical** |
| 15-49 | **High** |
| 6-14 | **Standard** |
| 0-5 | **Contained** |

---

## Dashboard Rendering

Two leaderboards:

### Top Data Monoliths

| Field | Description |
|-------|-------------|
| **Name** | The resource name (e.g., `orders`, `user.created`) |
| **Type** | `DataContainer`, `Datastore`, or `MessageChannel` |
| **SPOF Score** | The 0-100 risk score |
| **Teams** | Teams owning services that consume or produce for this resource |
| **Write Services** | Services that write to this resource |
| **Read Services** | Services that read from this resource |

### Top Service Bottlenecks

Same structure, with **Dependent Services** in place of Read/Write Services.

Both leaderboards apply monorepo-aware qualification: if a repository hosts more than one service, each service reference is tagged with its repo context so two identically named services in different multi-service repos don't collide in the list.

Both node types also carry an optional **`runtimeImpactedDUs`** count: the number of distinct `DeploymentUnit` facets touched when deployment topology has been ingested. It's a runtime-layer signal on top of the code-level score, shown when non-zero.

---

## Header Stats

| Metric | Description |
|--------|-------------|
| **Seismic** | Count of monoliths/bottlenecks scoring ≥ 100 |
| **Critical** | Count scoring 50-99 |
| **High** | Count scoring 15-49 |
| **Services at Risk** | Unique count of services touched by any monolith or bottleneck |

There is no "Known Vulnerabilities" stat on this page. That's a distinct concept (CVE/OSV package scanning) surfaced on the Package Intelligence tab; see [Vulnerability Scanning](../vulnerability-scanning.md).

---

## Interpreting the Results

### When a High SPOF Score Is Acceptable

- **Authentication services**: Normal for an identity service to be a bottleneck. Mitigate operationally (redundancy, caching, circuit breakers), not architecturally.
- **Event buses**: A central message broker naturally concentrates connections. The risk lives in the bus itself, not the topology around it.
- **Shared databases in legacy monoliths**: If you're already migrating toward microservices, the monolith shrinks over time; don't panic-refactor it today.

### When to Act

1. **Cross-team, Critical or higher (score ≥ 50)**: A resource owned by Team A depended on by Teams B, C, D with no formal data contract.
2. **No circuit breakers**: Dependents have no graceful degradation for the bottleneck.
3. **Schema coupling**: Multiple services read a shared table directly, no abstraction layer.
4. **No ownership**: The bottleneck has no clear team owner (check the `ar-codeowners` rule in [Governance](../governance.md)).

### Mitigation Strategies

| Pattern | Strategy |
|---------|----------|
| **Shared database** | Introduce a data contract API. One service owns the schema, exposes controlled read/write endpoints. |
| **Central API bottleneck** | Add caching, circuit breakers, bulkhead isolation. Consider event-driven decoupling for non-real-time consumers. |
| **Single-writer resource** | Evaluate horizontal scaling for the producer, or a redundant writer. |

---

## Programmatic Access

```bash
cr ask
> "Which resources in our architecture have the highest SPOF scores?"
```

The `analyze_architecture_gravity` MCP tool returns the same `{dataMonoliths, serviceBottlenecks}` shape the dashboard renders, as structured JSON, for use in an agent's reasoning loop.

---

## Further Reading

- [Architecture Dashboard](./architecture-dashboard.md): The unified dashboard containing the SPOFs domain
- [Blast Radius Scoring](./blast-radius-scoring.md): Downstream impact tiers, which this page's tier classifier reuses directly
- [Impact Evaluation](../impact-evaluation.md): Predict the blast radius of changes to high-SPOF resources
- [MCP Server: analyze_architecture_gravity](../mcp-server.md#analyze_architecture_gravity): Programmatic access to gravity data
