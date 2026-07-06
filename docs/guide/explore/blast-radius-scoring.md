# Blast Radius Scoring

The **Blast Radius Explorer** assigns every node in the architecture graph (Service, Database, Message Channel, API Endpoint) a **Downstream Gravity Score** that measures the risk of that node failing or being changed. The score maps to an **Impact Tier** (T0 through T4, plus an evidence-gated T? Unverified) for a human-readable read at a glance.

> **Note:** The gravity score is pre-computed during dashboard generation. The Blast Radius Explorer UI does zero graph computation at render time. It reads `node.gravityScore` directly.

---

## Impact Tiers

| Tier | Label | Score Range | What It Means |
|:---|:---|:---|:---|
| **T0** | **Seismic** | ≥ 100 | An outage cascades across the entire organization. Think: core shared database with 30+ reader services, or the central event bus. |
| **T1** | **Critical** | 50-99 | Multi-team incident probable. A failure here breaks production for multiple domains. |
| **T2** | **High** | 15-49 | Significant blast radius. Changes require cross-team coordination and formal review. |
| **T3** | **Standard** | 6-14 | Localized impact. Standard change management is sufficient. |
| **T4** | **Contained** | 0-5 | Isolated leaf node. Safe to modify with minimal coordination. |
| **T?** | **Unverified** | (any) | The score has no observed dependent in the scanned graph. See below. |

---

## How the Score Works

The gravity score answers one question: **"If this node dies, how much of the architecture breaks?"**

### Core Principle: Downstream Gravity

The score counts **downstream** impact only: nodes that would be directly or transitively broken. Upstream dependencies (what this node depends on) are tracked separately and never added into the score. They tell you how *fragile* a node is, not how *dangerous* it is.

### What Makes It "Weighted"

A simple connection count would treat every downstream dependency as equal. Gravity weighs each one by its own connectivity: a downstream node that's itself a hub contributes more than an isolated leaf. Breaking a resource used by a critical hub service scores higher than breaking one used by a standalone worker.

Package nodes are always excluded from gravity scoring. A `node_modules` dependency doesn't count as a downstream consumer no matter how it's wired into the graph.

### The T? Unverified Tier

A node's score reflects what CodeRadius has *observed*: an in-edge dependent, a Tier-2 transitive node reached through a passthrough resource, or a consumed API endpoint. If none of those exist (no observed dependent at all), the UI demotes the tier chip to **T? Unverified**, regardless of the numeric score. This happens for nodes whose only graph presence is their own write/publish footprint. Real blast radius could be higher (an unscanned consumer repo you haven't ingested yet) or lower (a write-only target nobody reads back from). Don't read a numeric tier as gospel until you've confirmed the node isn't unverified.

### The `IMPLEMENTS_ENDPOINT` Discount

An API endpoint with zero *observed* consumers still gets counted, but at a reduced coefficient, not the full weight, and not zero. In an incomplete graph, zero observed callers doesn't mean zero real callers. The discount avoids both over-counting (treating every endpoint as maximally critical) and under-counting (dropping endpoints whose consumers just haven't been ingested yet).

### Worked Examples

**Example 1: Standalone worker**
- Topology: `notification-worker → (LISTENS_TO) → notifications`
- Zero downstream impact: if it breaks, nothing downstream is affected.
- **Gravity Score: 0 → T4 Contained**

**Example 2: Service writing to a shared table**
- Topology: `order-service → (WRITES) → orders_db ← (READS) ← 8 reader services`
- If `order-service` corrupts the data or the schema changes, 8 downstream consumers are hit. Each reader's own connectivity factors into the weight.
- **Gravity Score: ~16 → T2 High**

**Example 3: Event bus producer**
- Topology: `payment-service → (PUBLISHES_TO) → payment.completed ← (LISTENS_TO) ← 12 consumer services`
- If `payment-service` stops publishing, 12 downstream consumers receive no data.
- **Gravity Score: ~22 → T2 High**

**Example 4: Enterprise-scale data monolith**
- Topology: `identity-service → (WRITES) → core_users ← (READS) ← 30 reader services`
- An outage or schema migration on the writer cascades to 30 downstream teams.
- **Gravity Score: ~72 → T1 Critical**

---

## Interpreting the Banner

Selecting a node shows a **Target Banner**:

| Element | Source |
|---------|--------|
| **Tier Badge** (T0-T4, or T? Unverified) | Derived from the pre-computed gravity score and its evidence |
| **Direct count** | Tier 1 (1-hop) **downstream** nodes only |
| **Transitive count** | Tier 2 (2-hop) nodes reached via passthrough resources |
| **Upstream count** | Nodes this target depends on (informational, never part of the tier score) |
| **Teams count** | Unique teams spanning both the downstream and upstream sets |

> **Warning:** Direct is downstream-only. Upstream is a separate stat block. It is never folded into Direct, and it never contributes to the tier.

If the graph only covers part of your organization, the banner also shows a **coverage** annotation (e.g. "based on 12/40 repos scanned"). This is a reminder that gravity scores are lower bounds when large parts of the fleet haven't been ingested yet.

---

## When a High Tier Is Acceptable

Not every T0/T1 score demands action:

- **Authentication services**: a central `identity-service` will naturally score T1 or higher. Mitigation is operational (redundancy, circuit breakers), not architectural.
- **Event buses**: a core message broker concentrates connections by design. Watch the SPOF score in the [SPOFs dashboard](./data-gravity.md) for concentration risk instead.
- **API gateways**: a shared gateway serving many consumers will score high. Make sure it scales horizontally and rate-limits.

### When to Act

1. **T0 or T1 with no redundancy**: critical, and no failover, circuit breaker, or graceful degradation.
2. **Cross-team T2+**: multiple teams depend on one resource with no formal data contract or API versioning.
3. **Tight schema coupling**: services read a shared table directly, with no API or view in between.
4. **No ownership**: the node has no assigned team owner (see [Governance](../governance.md)).

---

## Relationship to SPOF Analysis

| Dimension | Gravity Score (Blast Radius Explorer) | SPOF Score (Data Gravity) |
|-----------|-------------------------------|--------------------------|
| **Question** | "What breaks if I die?" | "How concentrated are my dependents?" |
| **Scope** | Per-node, including services | Data resources and service bottlenecks only |
| **Algorithm** | Downstream 2-hop with degree weighting | Fan-in/fan-out with team diversity |
| **Range** | Unbounded integer to T0-T4 tier (or unverified) | 0-100 asymptotic curve |

Use both together: SPOFs identifies **which** resources are dangerously concentrated; the Blast Radius Explorer shows **what happens** when one of them fails.

---

## Further Reading

- [Architecture Dashboard](./architecture-dashboard.md): The unified dashboard containing the Blast Radius Explorer
- [SPOFs & Data Gravity](./data-gravity.md): Concentration risk analysis
- [Impact Evaluation](../impact-evaluation.md): Pre-commit blast radius prediction for code changes
- [MCP Server `analyze_blast_radius`](../mcp-server.md): Programmatic blast radius queries
