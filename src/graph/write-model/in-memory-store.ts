/**
 * InMemoryGraphStore — GraphStore test double.
 *
 * Mirrors the Memgraph applier semantics exactly, because its value as a
 * test double depends on that fidelity:
 *   - nodes upsert by (label, merge-key) — MERGE semantics;
 *   - `propsOnce` lands only on creation (ON CREATE SET);
 *   - a `null` prop value deletes the property (Cypher `+=` semantics);
 *   - edges MATCH their endpoints: a missing endpoint skips the edge and
 *     reports it in `ApplyResult.skippedEdges`;
 *   - grounding scalars are overwritten on re-touch, accumulator arrays
 *     union-dedup (the `groundingWriteClause` reduce() behaviour).
 */
import {
    GraphDeltaSchema,
    type EdgeUpsert,
    type GraphDelta,
    type NodeRef,
    type NodeUpsert,
    type PropRecord,
} from './delta.js';
import { flattenGrounding, type FlattenedGrounding, type GroundingFields } from '../grounding.js';
import type { ApplyOptions, ApplyResult, GraphStore, SkippedEdge } from './store.js';

export interface StoredEntity {
    props: PropRecord;
    grounding: FlattenedGrounding;
}

function nodeKey(ref: { label: string; urn: string }): string {
    return `${ref.label}␟${ref.urn}`;
}

function edgeKey(type: string, from: NodeRef, to: NodeRef, keyProps: PropRecord = {}): string {
    const identity = Object.keys(keyProps).sort().map(k => `${k}=${JSON.stringify(keyProps[k] ?? null)}`).join(',');
    return `${type}␟${nodeKey(from)}␟${nodeKey(to)}␟${identity}`;
}

/** Cypher `SET n += map` semantics: null deletes, everything else overwrites. */
function mergeProps(existing: PropRecord, incoming: PropRecord): PropRecord {
    const out: PropRecord = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
        if (value === null) delete out[key];
        else out[key] = value;
    }
    return out;
}

function unionDedup(existing: string[] | null | undefined, incoming: string[] | null | undefined): string[] {
    return [...new Set([...(existing ?? []), ...(incoming ?? [])])];
}

function nullWhenEmpty(values: string[]): string[] | null {
    return values.length > 0 ? values : null;
}

/** The `groundingWriteClause` re-touch semantics, in TypeScript. */
function stampGrounding(
    existing: FlattenedGrounding | undefined,
    incoming: GroundingFields,
    commitHash: string,
): FlattenedGrounding {
    const flat = flattenGrounding(incoming);
    return {
        ...flat,
        lastSeenCommit: commitHash,
        evidence_extractors: unionDedup(existing?.evidence_extractors, flat.evidence_extractors),
        evidence_fallbacksApplied: nullWhenEmpty(
            unionDedup(existing?.evidence_fallbacksApplied, flat.evidence_fallbacksApplied),
        ),
        evidence_mergedFrom: nullWhenEmpty(unionDedup(existing?.evidence_mergedFrom, flat.evidence_mergedFrom)),
    };
}

export class InMemoryGraphStore implements GraphStore {
    private readonly nodes = new Map<string, StoredEntity>();
    private readonly edges = new Map<string, StoredEntity>();

    async apply(delta: GraphDelta, opts: ApplyOptions): Promise<ApplyResult> {
        const parsed = GraphDeltaSchema.parse(delta);

        for (const node of parsed.nodes) this.upsertNode(node, opts.commitHash);

        const skippedEdges: SkippedEdge[] = [];
        let edgesUpserted = 0;
        for (const edge of parsed.edges) {
            if (this.upsertEdge(edge, opts.commitHash)) edgesUpserted++;
            else skippedEdges.push({ type: edge.type, fromUrn: edge.from.urn, toUrn: edge.to.urn, reason: 'missing-endpoint' });
        }

        return { nodesUpserted: parsed.nodes.length, edgesUpserted, skippedEdges };
    }

    private upsertNode(node: NodeUpsert, commitHash: string): void {
        const key = nodeKey(node);
        const existing = this.nodes.get(key);
        const baseProps = existing ? existing.props : { createdAt: Date.now(), ...(node.propsOnce ?? {}) };
        const props = mergeProps(baseProps, node.props);
        for (const [k, v] of Object.entries(node.propsIfMissing ?? {})) {
            if (props[k] === undefined || props[k] === null) props[k] = v;
        }
        this.nodes.set(key, {
            props,
            grounding: stampGrounding(existing?.grounding, node.grounding, commitHash),
        });
    }

    private upsertEdge(edge: EdgeUpsert, commitHash: string): boolean {
        if (!this.nodes.has(nodeKey(edge.from)) || !this.nodes.has(nodeKey(edge.to))) return false;
        const key = edgeKey(edge.type, edge.from, edge.to, edge.keyProps);
        const existing = this.edges.get(key);
        const baseProps = existing ? existing.props : { ...(edge.keyProps ?? {}), ...(edge.propsOnce ?? {}) };
        this.edges.set(key, {
            props: mergeProps(baseProps, edge.props),
            grounding: stampGrounding(existing?.grounding, edge.grounding, commitHash),
        });
        return true;
    }

    getNode(label: NodeRef['label'], urn: string): StoredEntity | undefined {
        return this.nodes.get(nodeKey({ label, urn }));
    }

    getEdge(type: string, from: NodeRef, to: NodeRef, keyProps: PropRecord = {}): StoredEntity | undefined {
        return this.edges.get(edgeKey(type, from, to, keyProps));
    }

    get nodeCount(): number {
        return this.nodes.size;
    }

    get edgeCount(): number {
        return this.edges.size;
    }
}
