/**
 * GraphStore — the persistence port of the write-model.
 *
 * The pipeline depends on this interface only. Adapters:
 *   - `MemgraphGraphStore` (memgraph-applier.ts): batched UNWIND writes,
 *     one transaction per apply().
 *   - `InMemoryGraphStore` (in-memory-store.ts): test double mirroring the
 *     same semantics without a database.
 */
import type { GraphDelta } from './delta.js';

export interface ApplyOptions {
    /** Stamped as `lastSeenCommit` on every node/edge grounding block. */
    commitHash: string;
}

/**
 * An edge whose endpoint MATCH found no node. Edges never MERGE their
 * endpoints (that would create untyped ghost nodes), so a miss is skipped
 * and REPORTED — never silently dropped.
 */
export interface SkippedEdge {
    type: string;
    fromUrn: string;
    toUrn: string;
    reason: 'missing-endpoint';
}

export interface ApplyResult {
    nodesUpserted: number;
    edgesUpserted: number;
    skippedEdges: SkippedEdge[];
}

export interface GraphStore {
    /**
     * Validate and persist a delta. Adapters guarantee all-or-nothing
     * application: a failure mid-delta leaves the store unchanged.
     */
    apply(delta: GraphDelta, opts: ApplyOptions): Promise<ApplyResult>;
}
