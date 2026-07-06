import type { TieredBlastNode } from '../../../lib/topology';

/** Sort order: Services first, then other active types, then passive resources */
export const TYPE_SORT_ORDER: Record<string, number> = {
    Service: 0, SystemProcess: 1, Package: 2,
    APIEndpoint: 3, MessageChannel: 4, Datastore: 5,
};

/** Sort tiered impact nodes: T2 first, then by type-order, then alphabetic. */
export function sortItems(items: TieredBlastNode[]): TieredBlastNode[] {
    return [...items].sort((a, b) => {
        // T2 (transitive) before T1 (direct)
        if (a.tier !== b.tier) return b.tier - a.tier;
        const orderA = TYPE_SORT_ORDER[a.node.type] ?? 99;
        const orderB = TYPE_SORT_ORDER[b.node.type] ?? 99;
        if (orderA !== orderB) return orderA - orderB;
        return a.node.name.localeCompare(b.node.name);
    });
}
