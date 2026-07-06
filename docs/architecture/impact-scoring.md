# Impact Explorer Scoring System

> **Status**: Active  
> **Owner**: `src/graph/queries/topology.ts` (server-side), `packages/dashboard-ui/src/lib/blastTier.ts` (client-side)  
> **Tests**: `tests/unit/graph/gravity-score.test.ts` (see the test file for the full, evolving scenario set)

The Impact Explorer assigns every architectural node a **Downstream Gravity Score**: a pre-computed integer that feeds the T0-T4 tier classifier. The score is calculated server-side during dashboard generation and injected into the `TopologyMap` payload as `node.gravityScore`. The frontend is a pure renderer.

---

## 1. Mathematical Specification

### 1.1 Gravity Score Formula

For each node `n` in the topology graph:

```
gravityScore(n) = Σ (coefficient × gravityWeight(d))
                  for each d ∈ downstream(n, 2-hop)
```

Where:

| Symbol | Definition |
|--------|-----------|
| `coefficient` | `2.0` for Tier 1 (direct, 1-hop), `1.5` for Tier 2 (transitive, 2-hop via passthrough) |
| `gravityWeight(d)` | `1 + log₁₀(max(1, degree(d)))` |
| `degree(d)` | `|out[d]| + |in[d]|`: total edge count from pre-built adjacency maps (O(1) lookup) |

### 1.2 Gravity Weight Function

The `gravityWeight` function maps a node's degree (connectivity) to a weight:

```
gravityWeight(degree) = 1 + log₁₀(max(1, degree))
```

| Degree | Weight | Interpretation |
|--------|--------|---------------|
| 0-1 | 1.0 | Leaf node: minimum contribution |
| 10 | 2.0 | Moderate hub |
| 100 | 3.0 | Major infrastructure hub |
| 1000 | 4.0 | Enterprise-scale gateway |

The `log₁₀` provides two critical properties:
1. **Monotonically increasing**: Higher-connected downstream nodes always contribute more weight.
2. **Sub-linear growth**: Prevents a single mega-hub from dominating all scores. A 100-degree node contributes 3×, not 100×, more than a leaf.

### 1.3 Downstream Classification

Determining which nodes are "downstream" of a given node is based on **relationship direction semantics**:

```typescript
const EMISSION_DIRECTION_RELS = new Set([
    'WRITES', 'PUBLISHES_TO', 'PRODUCES', 'SPAWNS', 'DEAD_LETTERS_TO', 'IMPLEMENTS_ENDPOINT',
]);
```

Note: `MAPS_TO` is explicitly classified as a *dependency* (non-emission) relationship: "the ORM mapper depends on the table", not an emission rel, despite superficially looking like one.

- **Out-edge with EMISSION rel** → target is **downstream** (the source emits/produces for the target)
- **In-edge with non-EMISSION rel** → source is **downstream** (e.g., `CALLS`, `READS`, `LISTENS_TO`)

This follows the **damage direction**: "If I die, what breaks?" EMISSION relationships mean you're pushing data/events to the target. Non-emission in-edges mean someone depends on you.

### 1.4 Passthrough Expansion (Tier 2)

Tier 2 (transitive) expansion only follows through **passthrough resource types**:

```typescript
const PASSTHROUGH_TYPES = new Set([
    'DataContainer', 'MessageChannel', 'Datastore', 'APIEndpoint',
]);
```

Service→Service edges are NOT expanded transitively. Only infrastructure resources act as bridges (e.g., Service → DataContainer → Service).

### 1.5 Exclusions

- **Package nodes** (`type === 'Package'`) are excluded from scoring entirely. Software dependencies do not represent architectural blast radius.
- **Upstream dependencies** are excluded from the gravity score. They represent fragility, not danger.
- **Self-loops** are prevented via a visited set (`seen`).
- **Cycles** are handled by the same visited set; each node is counted at most once.

---

## 2. Impact Tier Classification

The gravity score is mapped to a tier using static thresholds:

| Tier | Key | Min Score | Description |
|------|-----|-----------|-------------|
| T0 | `seismic` | 100 | Org-wide cascade |
| T1 | `critical` | 50 | Multi-team incident |
| T2 | `high` | 15 | Significant blast radius |
| T3 | `moderate` | 6 | Limited, localized blast |
| T4 | `contained` | 0 | Isolated leaf |

### 2.1 Threshold Calibration

Thresholds were calibrated empirically using unit test scenarios (see `gravity-score.test.ts` for the full, evolving set):

| Scenario | Topology | Score | Tier |
|----------|----------|-------|------|
| Standalone worker | 0 downstream | 0 | T4 |
| 1 writer + 1 reader | 1 table, 1 reader | 5 | T4 |
| Shared DB (8 readers) | 1 table, 8 readers | 16 | T2 |
| Event bus (12 consumers) | 1 channel, 12 listeners | 22 | T2 |
| API Gateway (6 callers) | 1 endpoint, 6 callers | 13 | T3 |
| Enterprise DB (30 readers) | 1 table, 3 writers, 30 readers | 72 | T1 |

Previous thresholds (flat counting: 150/75/30/10) were too high for gravity-weighted scores because `log₁₀` compresses per-node contribution from flat 2.0/1.5/1.0 to a range of 2.0-6.0.

### 2.2 Tier Fraction (Progress Bar)

The `normaliseToBar(rawScore)` function returns a 0-1 fraction within the current tier band, used for the visual progress bar:

```
bands = [6, 15, 50, 100, 200]  // upper bounds of T4 → T0
```

---

## 3. Data Flow

```
┌─────────────────────────────────────────────┐
│  Memgraph (Cypher Query)                    │
│  MATCH (a)-[r]->(b) WHERE type(r) IN rels   │
└──────────────────┬──────────────────────────┘
                   │ Records
                   ▼
┌─────────────────────────────────────────────┐
│  getTopologyMap(): topology.ts             │
│  1. Build nodes, out[], in[] adjacency maps │
│  2. computeGravityScores(nodes, out, in)    │
│     └── For each node: 2-hop downstream     │
│         traversal with gravityWeight()      │
│  3. nodes[urn].gravityScore = score         │
└──────────────────┬──────────────────────────┘
                   │ TopologyMap (JSON)
                   ▼
┌─────────────────────────────────────────────┐
│  Dashboard HTML (injected payload)          │
│  window.__TOPOLOGY__ = { nodes, out, in }   │
└──────────────────┬──────────────────────────┘
                   │ Props
                   ▼
┌─────────────────────────────────────────────┐
│  BlastRadiusExplorer.tsx (React)            │
│  rawScore = selectedNode.gravityScore ?? 0  │
│  tier = getImpactTier(rawScore)             │
│  └── Pure lookup, zero computation          │
└─────────────────────────────────────────────┘
```

---

## 4. Performance Characteristics

| Metric | Value |
|--------|-------|
| **Algorithm complexity** | O(N × degree²) where N = number of nodes |
| **Typical graph size** | < 1,000 architectural nodes, < 5,000 edges |
| **Expected runtime** | < 50ms for a 500-node graph (Node.js) |
| **Frontend cost** | O(1): single property read per node |
| **Cycle safety** | Guaranteed by visited set (`seen`) per node |
| **Memory overhead** | One `Set<string>` per node (discarded after scoring) |

The algorithm runs entirely in-memory on the pre-built adjacency maps (`out[]`, `in[]`). No additional database queries are needed.

---

## 5. Relationship to SPOF Score

The `calculateSpofScore()` in `gravity.ts` and `computeGravityScores()` in `topology.ts` serve different analytical purposes:

| Dimension | Gravity Score (Impact Explorer) | SPOF Score (Data Gravity) |
|-----------|-------------------------------|--------------------------|
| **Question** | What breaks if I die? | How concentrated are my dependents? |
| **Input** | Downstream 2-hop with degree weighting | Fan-in/fan-out with team diversity |
| **Range** | Unbounded integer → T0-T4 | 0-100 (asymptotic: `100 × (1 - e^(-raw/15))`) |
| **Scope** | All architectural nodes | Data resources + service bottlenecks only |
| **Computed in** | `topology.ts` (dashboard generation) | `gravity.ts` (gravity analysis) |
| **Persisted as** | `TopologyNode.gravityScore` | `GravityNodeSummary.spofScore` |

---

## 6. Design Decisions

### Why degree-based, not recursive propagation?

Recursive score propagation (where a node inherits the scores of its downstream nodes) creates three problems:
1. **Infinite loops** in cyclical graphs (A → B → C → A)
2. **Iteration convergence**: requires multiple passes until scores stabilize
3. **Computational cost**: potentially O(N²) or worse

The degree-based approach is O(1) per downstream node and guarantees termination.

### Why log₁₀?

Linear degree weighting would cause a single mega-hub (degree 500) to dominate all scores. `log₁₀` provides sub-linear growth that distinguishes leaf (1) from hub (10) from mega-hub (100) without extreme variance.

### Why server-side?

Client-side scoring in React would:
1. Block the main thread during initial render (jank)
2. Require re-computation on every node selection
3. Risk infinite loops if the algorithm had bugs in the DOM reconciliation cycle

Server-side pre-computation is a one-time cost during `cr ui` that produces a static, cache-friendly payload.

### Why exclude upstream from the score?

The blast radius measures **danger**, not **fragility**. If node A depends on a critical database B:
- A is **fragile** (if B breaks, A breaks)
- A is **not dangerous** (if A breaks, B continues serving everyone else)

Including upstream dependencies would conflate these two orthogonal concepts and inflate scores for leaf services that merely consume many APIs.

---

## 7. Code Pointers

| File | Purpose |
|------|---------|
| [`topology.ts`](../../src/graph/queries/topology.ts) | `computeGravityScores()`: the scoring engine |
| [`shared-types/index.ts`](../../packages/shared-types/index.ts) | `TopologyNode.gravityScore`: the field definition |
| [`topology-rels.ts`](../../packages/shared-types/topology-rels.ts) | `classifyGravityTier()`: threshold-to-tier mapper (shared with the UI adapter [`blastTier.ts`](../../packages/dashboard-ui/src/lib/blastTier.ts)) |
| [`BlastRadiusExplorer.tsx`](../../packages/dashboard-ui/src/components/blast-radius/BlastRadiusExplorer.tsx) | Frontend consumer (`selectedNode.gravityScore`) |
| [`gravity-score.test.ts`](../../tests/unit/graph/gravity-score.test.ts) | Unit tests across an evolving set of enterprise scenarios |
| [`gravity.ts`](../../src/graph/queries/gravity.ts) | Related: SPOF score for the Data Gravity dashboard |
