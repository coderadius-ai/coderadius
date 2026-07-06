/**
 * GraphDelta — the typed write-model of the ingestion pipeline.
 *
 * Pure interpreters turn analysis payloads into a GraphDelta: a plain-data
 * description of node and edge upserts. A GraphStore applier (Memgraph or
 * in-memory) executes it. The schema here is the single boundary where
 * malformed facts are rejected, so the pipeline above stays fully typed and
 * the persistence below stays free of domain decisions.
 *
 * Validation deliberately encodes Memgraph's storage rules:
 *   - property values are flat scalars or scalar arrays (nested objects
 *     would silently stringify or fail at the driver — rejected here);
 *   - grounding storage keys and the per-label merge key are reserved:
 *     grounding is stamped exclusively by the applier, the merge key is
 *     written from `urn`;
 *   - relationship types are interpolated into Cypher, so they are
 *     restricted to SCREAMING_SNAKE as an injection guard.
 */
import { z } from 'zod';
import { NODE_LABELS, CONSTRAINT_MAP, type NodeLabel } from '../domain.js';
import { GroundingFieldsSchema } from '../grounding.js';

const PropScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const PropValueSchema = z.union([PropScalarSchema, z.array(PropScalarSchema), z.null()]);
const PropsSchema = z.record(z.string(), PropValueSchema);

export type PropValue = z.infer<typeof PropValueSchema>;
export type PropRecord = z.infer<typeof PropsSchema>;

/**
 * Keys writable only by the applier: the flat grounding storage block plus
 * `createdAt`, which adapters stamp server-side on node creation.
 */
const GROUNDING_STORAGE_KEYS: ReadonlySet<string> = new Set([
    'source',
    'quality',
    'needsReview',
    'lastSeenCommit',
    'evidence_extractors',
    'evidence_llmCalls',
    'evidence_fallbacksApplied',
    'evidence_mergedFrom',
    'createdAt',
]);

/**
 * `propsIfMissing` keys are interpolated into per-key `coalesce()` SET
 * clauses by the Memgraph applier, so they must be identifier-shaped.
 */
const SAFE_PROP_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function forbidReservedKeys(
    props: PropRecord | undefined,
    reserved: ReadonlySet<string>,
    ctx: z.RefinementCtx,
    path: string,
): void {
    for (const key of Object.keys(props ?? {})) {
        if (reserved.has(key)) {
            ctx.addIssue({
                code: 'custom',
                path: [path, key],
                message: `prop '${key}' is reserved (grounding storage or merge key); it is stamped by the applier`,
            });
        }
    }
}

const NodeLabelSchema = z.enum(NODE_LABELS);

export const NodeRefSchema = z.object({
    label: NodeLabelSchema,
    urn: z.string().min(1),
});
export type NodeRef = z.infer<typeof NodeRefSchema>;

export const NodeUpsertSchema = z
    .object({
        label: NodeLabelSchema,
        urn: z.string().min(1),
        props: PropsSchema.default({}),
        /** Applied only when the node is created (Cypher `ON CREATE SET`). */
        propsOnce: PropsSchema.optional(),
        /**
         * First-non-null-wins (Cypher `SET n.k = coalesce(n.k, $v)`): fills
         * the property when absent, never overwrites an existing value. Used
         * to protect authoritative stamps (e.g. a structural extractor's
         * `kindFamily`) from later weaker producers.
         */
        propsIfMissing: PropsSchema.optional(),
        grounding: GroundingFieldsSchema,
    })
    .superRefine((node, ctx) => {
        const reserved = new Set([...GROUNDING_STORAGE_KEYS, CONSTRAINT_MAP[node.label as NodeLabel]]);
        forbidReservedKeys(node.props, reserved, ctx, 'props');
        forbidReservedKeys(node.propsOnce, reserved, ctx, 'propsOnce');
        forbidReservedKeys(node.propsIfMissing, reserved, ctx, 'propsIfMissing');
        for (const key of Object.keys(node.propsIfMissing ?? {})) {
            if (!SAFE_PROP_KEY_RE.test(key)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['propsIfMissing', key],
                    message: `propsIfMissing key '${key}' must be identifier-shaped (interpolated into Cypher)`,
                });
            }
        }
    });
export type NodeUpsert = z.infer<typeof NodeUpsertSchema>;

export const EdgeUpsertSchema = z
    .object({
        type: z
            .string()
            .regex(/^[A-Z][A-Z0-9_]*$/, 'relationship type must be SCREAMING_SNAKE (Cypher injection guard)'),
        from: NodeRefSchema,
        to: NodeRefSchema,
        props: PropsSchema.default({}),
        /** Applied only when the edge is created (Cypher `ON CREATE SET`). */
        propsOnce: PropsSchema.optional(),
        /**
         * Properties that participate in the edge MERGE identity (e.g. AMQP
         * `routingKey`): two upserts with different keyProps produce two
         * distinct edges. `null` is a valid identity value (matches the
         * null-key edge only).
         */
        keyProps: PropsSchema.optional(),
        grounding: GroundingFieldsSchema,
    })
    .superRefine((edge, ctx) => {
        forbidReservedKeys(edge.props, GROUNDING_STORAGE_KEYS, ctx, 'props');
        forbidReservedKeys(edge.propsOnce, GROUNDING_STORAGE_KEYS, ctx, 'propsOnce');
        forbidReservedKeys(edge.keyProps, GROUNDING_STORAGE_KEYS, ctx, 'keyProps');
        for (const key of Object.keys(edge.keyProps ?? {})) {
            if (!SAFE_PROP_KEY_RE.test(key)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['keyProps', key],
                    message: `keyProps key '${key}' must be identifier-shaped (interpolated into Cypher)`,
                });
            }
        }
    });
export type EdgeUpsert = z.infer<typeof EdgeUpsertSchema>;

export const GraphDeltaSchema = z.object({
    nodes: z.array(NodeUpsertSchema).default([]),
    edges: z.array(EdgeUpsertSchema).default([]),
});
export type GraphDelta = z.infer<typeof GraphDeltaSchema>;

export function emptyDelta(): GraphDelta {
    return { nodes: [], edges: [] };
}

/** Pure concatenation: MERGE-based application makes repeated facts idempotent. */
export function mergeDeltas(...deltas: GraphDelta[]): GraphDelta {
    return {
        nodes: deltas.flatMap(d => d.nodes),
        edges: deltas.flatMap(d => d.edges),
    };
}
