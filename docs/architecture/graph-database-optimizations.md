# Graph Database Optimizations: Traversal vs Label Scans

When scaling the CodeRadius graph database (Memgraph/Neo4j) to handle multi-tenant environments with hundreds of repositories and millions of `SourceFile` nodes, how we query the graph becomes as important as what we store in it.

This document details critical architectural optimizations made to the fundamental graph queries (specifically the Merkle index query) to avoid disastrous performance bottlenecks.

## The Problem: The "Elasticsearch" Anti-Pattern

In early iterations of the ingestion pipeline, loading a repository's current state (the Merkle Index) relied on string matching:

```cypher
MATCH (r:Repository {id: $rUrn}) WHERE r.valid_to_commit IS NULL
OPTIONAL MATCH (sf:SourceFile) WHERE sf.id STARTS WITH $sfPrefix AND sf.valid_to_commit IS NULL
// ...
```

**Why this is dangerous:**
Graph databases are not designed to be key-value stores or full-text search engines. The `OPTIONAL MATCH (sf:SourceFile)` statement forces the database engine to perform a **Label Scan**:
1. It scans **every single `SourceFile` node** in the entire database.
2. It filters them down by checking if the string `id` starts with the prefix.

With 2 million files across 50 repositories, loading the index for *one* repository requires traversing 2 million nodes. This is an $O(N)$ operation where $N$ is the total global file count.

## The Solution: O(1) Graph Traversal

Graph databases excel at traversals. Finding files belonging to a repository should rely on physical graph edges, making the operation $O(F)$ where $F$ is the number of files in that specific repository.

The optimized "Unicorn" query looks like this:

```cypher
MATCH (r:Repository {id: $rUrn}) WHERE r.valid_to_commit IS NULL
OPTIONAL MATCH (r)-[rc:CONTAINS]->(sf:SourceFile) WHERE rc.valid_to_commit IS NULL AND sf.valid_to_commit IS NULL
OPTIONAL MATCH (sf)-[rf:CONTAINS]->(f:Function) WHERE rf.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
// ...
```

By traversing the `[:CONTAINS]` edge directly from the `Repository` anchor node, the database engine only visits the exact `SourceFile` nodes belonging to that repository. No full-table scans. No string matching.

### Architectural Constraint: Normalized Monorepo Topologies

For the traversal optimization to work, **every** `SourceFile` must be reachable via a direct `[:CONTAINS]` edge from the `Repository`. 

In monorepos (`apps/` and `packages/`), files are logically owned by a `Service` or `Library`, not the root repository. Historically, the graph reflected this by linking:

```text
Repository -[:CONTAINS]-> Service -[:OWNS]-> SourceFile
```

Under this old topology, a direct query from `Repository` to `SourceFile` would fail to discover files inside packages or services.

To support the O(1) graph traversal without relying on fragile multi-hop or variable-length queries (`*1..3`), the ingestion pipeline (`graph-writer.ts`) enforces a **normalized topological guarantee**:

> **Rule:** Regardless of service or library routing, *every* `SourceFile` receives a direct `Repository -[:CONTAINS]-> SourceFile` edge upon ingestion.

This means a file in `apps/payment-service/src/index.ts` will have *both*:
1. `Service(payment-service) -[:OWNS]-> SourceFile` (For service-level queries)
2. `Repository -[:CONTAINS]-> SourceFile` (For repository-level traversals like the Merkle tree)

## Temporal Graph Integrity

CodeRadius uses a Temporal Graph strategy (soft-deletes). Nodes are historically preserved but marked as logically deleted using the `valid_to_commit` property.

**Rule:** Every read-query must include the temporal constraint `WHERE node.valid_to_commit IS NULL` to ensure only the currently active architecture is returned.

Omitting this check on a `Repository` node could cause the system to merge new files into a "historic" snapshot of the repository, breaking the Merkle index and corrupting the graph state.
