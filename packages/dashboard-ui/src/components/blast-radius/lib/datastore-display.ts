import type { TopologyNode } from '@coderadius/shared-types';

/**
 * Datastore-set display helpers.
 *
 * A DataContainer can be STORED_IN more than one datastore: a conservative
 * ambiguous bind links every candidate (bindingReason 'ambiguous-multi-candidate',
 * needsReview=true) rather than guessing one. `TopologyNode.datastore` is therefore
 * an array, [0] being the primary (first STORED_IN edge). These helpers centralise
 * the "primary vs all vs ambiguous" decisions so every surface renders the set
 * the same way.
 */

export type DatastoreRef = { name: string; host?: string | null };

type DatastoreNode = Pick<TopologyNode, 'datastore' | 'needsReview'>;

/** Every datastore bound to the node, [] when none. */
export function datastoresOf(node: DatastoreNode): DatastoreRef[] {
    return node.datastore ?? [];
}

/** Primary (first STORED_IN) datastore, or null. Use for compact single-slot
 *  displays and for identity / clustering keys, where one representative wins. */
export function primaryDatastore(node: DatastoreNode): DatastoreRef | null {
    return node.datastore?.[0] ?? null;
}

/** An ambiguous bind: flagged for review AND linking more than one datastore.
 *  This is the conservative multi-candidate bind the binder could not resolve. */
export function isAmbiguousDatastore(node: DatastoreNode): boolean {
    return Boolean(node.needsReview) && (node.datastore?.length ?? 0) > 1;
}

/** One `name @ host` line per datastore. */
function datastoreLines(node: DatastoreNode): string[] {
    return datastoresOf(node).map(d => `${d.name}${d.host ? ` @ ${d.host}` : ''}`);
}

/** Tooltip text for a node's datastore set. A single store reads as before; a
 *  set lists every candidate, prefixed by an ambiguity note when unresolved. */
export function datastoreTooltip(node: DatastoreNode): string {
    const lines = datastoreLines(node);
    if (lines.length <= 1) return `Datastore: ${lines[0] ?? ''}`;
    const head = isAmbiguousDatastore(node)
        ? `Ambiguous bind, ${lines.length} candidate stores:`
        : `Datastores (${lines.length}):`;
    return `${head}\n${lines.join('\n')}`;
}
