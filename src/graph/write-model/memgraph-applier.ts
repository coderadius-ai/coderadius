/**
 * MemgraphGraphStore — the production GraphStore adapter.
 *
 * Applies a GraphDelta in ONE Memgraph transaction:
 *   - node upserts grouped per label → one UNWIND MERGE batch each, merging
 *     on the label's constraint key from `domain.ts:CONSTRAINT_MAP`;
 *   - edge upserts grouped per (type, from-label, to-label) → UNWIND MATCH
 *     MATCH MERGE; rows whose endpoint MATCH misses are reported as
 *     `skippedEdges`, never silently dropped and never MERGE-d into ghosts;
 *   - grounding stamped per row via the shared `groundingWriteClause`.
 *
 * Label and key identifiers interpolated into Cypher come exclusively from
 * the `NODE_LABELS` enum / `CONSTRAINT_MAP`; relationship types are
 * schema-validated to SCREAMING_SNAKE. Everything else travels as params.
 */
import type { ManagedTransaction, QueryResult } from 'neo4j-driver';
import { CONSTRAINT_MAP } from '../domain.js';
import { groundingParams, groundingWriteClause, runInTransaction } from '../mutations/_run.js';
import {
    GraphDeltaSchema,
    type EdgeUpsert,
    type GraphDelta,
    type NodeUpsert,
} from './delta.js';
import type { ApplyOptions, ApplyResult, GraphStore, SkippedEdge } from './store.js';

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const k = key(item);
        const group = groups.get(k);
        if (group) group.push(item);
        else groups.set(k, [item]);
    }
    return groups;
}

function ifMissingKeys(node: NodeUpsert): string[] {
    return Object.keys(node.propsIfMissing ?? {}).sort();
}

/**
 * One batch per (label, propsIfMissing key-set): the coalesce SET clauses are
 * static per query, so rows in a batch must share the same if-missing keys.
 * Key names are schema-validated to identifier shape before interpolation.
 */
function nodeBatchCypher(label: NodeUpsert['label'], coalesceKeys: string[]): string {
    const key = CONSTRAINT_MAP[label];
    const coalesceClause = coalesceKeys.length > 0
        ? `SET ${coalesceKeys.map(k => `n.\`${k}\` = coalesce(n.\`${k}\`, row.propsIfMissing.\`${k}\`)`).join(', ')}`
        : '';
    return `
        UNWIND $rows AS row
        MERGE (n:\`${label}\` {\`${key}\`: row.urn})
        ON CREATE SET n.createdAt = timestamp(), n += row.propsOnce
        SET n += row.props
        ${coalesceClause}
        ${groundingWriteClause('n', 'row.ground_')}
    `;
}

function edgeKeyPropsKeys(edge: EdgeUpsert): string[] {
    return Object.keys(edge.keyProps ?? {}).sort();
}

function edgeNullKeyProps(edge: EdgeUpsert): string[] {
    return edgeKeyPropsKeys(edge).filter(k => (edge.keyProps ?? {})[k] === null);
}

/**
 * One batch per (type, endpoint labels, keyProps key-set, null-mask): the
 * identity clauses are static per query, so rows in a batch must share which
 * keys are null. Key names are schema-validated to identifier shape before
 * interpolation.
 *
 * Batches whose keyProps are all non-null use a single MERGE with the keys in
 * the relationship pattern. Batches with null identity values cannot: Memgraph
 * rejects nulls in a MERGE pattern ("Can't have null literal properties
 * inside merge") on the MATCH+MATCH plan, so those run as an explicit
 * two-statement emulation inside the same transaction — ensure-exists
 * (FOREACH-create when no edge matches the null/equality identity) followed
 * by a SET pass on the matched identity. A null identity value means the
 * property is ABSENT on the edge, mirroring the legacy mutation semantics.
 */
function edgeMergeCypher(edge: EdgeUpsert): string {
    const keys = edgeKeyPropsKeys(edge);
    const keyPattern = keys.length > 0
        ? ` {${keys.map(k => `\`${k}\`: row.keyProps.\`${k}\``).join(', ')}}`
        : '';
    return `
        UNWIND $rows AS row
        ${edgeEndpointMatch(edge)}
        MERGE (a)-[r:\`${edge.type}\`${keyPattern}]->(b)
        ON CREATE SET r += row.propsOnce
        SET r += row.props
        ${groundingWriteClause('r', 'row.ground_')}
        RETURN collect(row.i) AS applied
    `;
}

function edgeEndpointMatch(edge: EdgeUpsert): string {
    const fromKey = CONSTRAINT_MAP[edge.from.label];
    const toKey = CONSTRAINT_MAP[edge.to.label];
    return `
        MATCH (a:\`${edge.from.label}\` {\`${fromKey}\`: row.fromUrn})
        MATCH (b:\`${edge.to.label}\` {\`${toKey}\`: row.toUrn})`;
}

/** WHERE fragment matching the (null-mask aware) edge identity for alias `e`. */
function edgeIdentityWhere(edge: EdgeUpsert, alias: string): string {
    const conditions = edgeKeyPropsKeys(edge).map(k =>
        (edge.keyProps ?? {})[k] === null
            ? `${alias}.\`${k}\` IS NULL`
            : `${alias}.\`${k}\` = row.keyProps.\`${k}\``,
    );
    return conditions.join(' AND ');
}

function edgeEnsureExistsCypher(edge: EdgeUpsert): string {
    return `
        UNWIND $rows AS row
        ${edgeEndpointMatch(edge)}
        OPTIONAL MATCH (a)-[e:\`${edge.type}\`]->(b) WHERE ${edgeIdentityWhere(edge, 'e')}
        FOREACH (_ IN CASE WHEN e IS NULL THEN [1] ELSE [] END |
            CREATE (a)-[ne:\`${edge.type}\`]->(b)
            SET ne += row.keyPropsNonNull, ne += row.propsOnce)
    `;
}

function edgeUpdateCypher(edge: EdgeUpsert): string {
    return `
        UNWIND $rows AS row
        ${edgeEndpointMatch(edge)}
        MATCH (a)-[r:\`${edge.type}\`]->(b) WHERE ${edgeIdentityWhere(edge, 'r')}
        SET r += row.props
        ${groundingWriteClause('r', 'row.ground_')}
        RETURN collect(row.i) AS applied
    `;
}

function nodeRow(node: NodeUpsert, commitHash: string): Record<string, unknown> {
    return {
        urn: node.urn,
        props: node.props,
        propsOnce: node.propsOnce ?? {},
        propsIfMissing: node.propsIfMissing ?? {},
        ...groundingParams(node.grounding, commitHash),
    };
}

function edgeRow(edge: EdgeUpsert, index: number, commitHash: string): Record<string, unknown> {
    const keyProps = edge.keyProps ?? {};
    return {
        i: String(index),
        fromUrn: edge.from.urn,
        toUrn: edge.to.urn,
        props: edge.props,
        propsOnce: edge.propsOnce ?? {},
        keyProps,
        keyPropsNonNull: Object.fromEntries(Object.entries(keyProps).filter(([, v]) => v !== null)),
        ...groundingParams(edge.grounding, commitHash),
    };
}

function appliedIndexes(result: QueryResult): Set<string> {
    const applied = result.records[0]?.get('applied') as string[] | undefined;
    return new Set(applied ?? []);
}

export class MemgraphGraphStore implements GraphStore {
    async apply(delta: GraphDelta, opts: ApplyOptions): Promise<ApplyResult> {
        const parsed = GraphDeltaSchema.parse(delta);
        const nodeBatches = groupBy(parsed.nodes, n => `${n.label}␟${ifMissingKeys(n).join(',')}`);
        const edgeBatches = groupBy(parsed.edges, e =>
            `${e.type}␟${e.from.label}␟${e.to.label}␟${edgeKeyPropsKeys(e).join(',')}␟null:${edgeNullKeyProps(e).join(',')}`);

        const skippedEdges: SkippedEdge[] = [];
        let edgesUpserted = 0;

        // Node steps run before edge steps inside the same transaction, so
        // edges resolve against nodes introduced by this very delta.
        await runInTransaction([
            ...[...nodeBatches.values()].map(batch => async (tx: ManagedTransaction) => {
                await tx.run(nodeBatchCypher(batch[0].label, ifMissingKeys(batch[0])), {
                    rows: batch.map(n => nodeRow(n, opts.commitHash)),
                });
            }),
            ...[...edgeBatches.values()].map(batch => async (tx: ManagedTransaction) => {
                const rows = { rows: batch.map((e, i) => edgeRow(e, i, opts.commitHash)) };
                let result: QueryResult;
                if (edgeNullKeyProps(batch[0]).length === 0) {
                    result = await tx.run(edgeMergeCypher(batch[0]), rows);
                } else {
                    await tx.run(edgeEnsureExistsCypher(batch[0]), rows);
                    result = await tx.run(edgeUpdateCypher(batch[0]), rows);
                }
                const applied = appliedIndexes(result);
                edgesUpserted += applied.size;
                for (const [i, edge] of batch.entries()) {
                    if (!applied.has(String(i))) {
                        skippedEdges.push({
                            type: edge.type,
                            fromUrn: edge.from.urn,
                            toUrn: edge.to.urn,
                            reason: 'missing-endpoint',
                        });
                    }
                }
            }),
        ]);

        return { nodesUpserted: parsed.nodes.length, edgesUpserted, skippedEdges };
    }
}
