import { describe, it, expect } from 'vitest';
import {
    diffTopologySnapshots,
    isDeltaEmpty,
    getAffectedResourceUrns,
    getRemovedEdgesByTarget,
    getAddedEdgesByTarget,
} from '../../../src/eval/graph-differ.js';
import type { FileTopologySnapshot, GraphEdgeSnapshot, GraphNodeSnapshot } from '../../../src/eval/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEdge(overrides: Partial<GraphEdgeSnapshot> = {}): GraphEdgeSnapshot {
    return {
        sourceId: 'cr:function:repo:ts:OrderController::publish',
        sourceName: 'publish',
        targetId: 'cr:channel:order.created',
        targetName: 'order.created',
        relType: 'PUBLISHES_TO',
        sourceFile: 'src/OrderController.ts',
        targetType: 'MessageChannel',
        ...overrides,
    };
}

function makeNode(overrides: Partial<GraphNodeSnapshot> = {}): GraphNodeSnapshot {
    return {
        id: 'cr:channel:order.created',
        type: 'MessageChannel',
        name: 'order.created',
        sourceFile: 'src/OrderController.ts',
        ...overrides,
    };
}

function makeSnapshot(filePath: string, edges: GraphEdgeSnapshot[] = [], nodes: GraphNodeSnapshot[] = []): FileTopologySnapshot {
    return { filePath, edges, nodes };
}

// ─── diffTopologySnapshots ────────────────────────────────────────────────────

describe('diffTopologySnapshots', () => {

    it('returns empty delta when current and proposed are identical', () => {
        const edge = makeEdge();
        const node = makeNode();
        const snapshot = makeSnapshot('src/OrderController.ts', [edge], [node]);
        const current = new Map([['src/OrderController.ts', snapshot]]);
        const proposed = new Map([['src/OrderController.ts', snapshot]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/OrderController.ts']);

        expect(delta.addedEdges).toHaveLength(0);
        expect(delta.removedEdges).toHaveLength(0);
        expect(delta.addedNodes).toHaveLength(0);
        expect(delta.removedNodes).toHaveLength(0);
    });

    it('detects added edge when proposed has a new relationship', () => {
        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts')]]);
        const newEdge = makeEdge();
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [newEdge])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.addedEdges).toHaveLength(1);
        expect(delta.addedEdges[0]).toMatchObject({ relType: 'PUBLISHES_TO', targetId: 'cr:channel:order.created' });
        expect(delta.removedEdges).toHaveLength(0);
    });

    it('detects removed edge when proposed is missing a relationship', () => {
        const edge = makeEdge();
        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [edge])]]);
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts')]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.removedEdges[0].relType).toBe('PUBLISHES_TO');
        expect(delta.addedEdges).toHaveLength(0);
    });

    it('handles a rename as: one removed + one added edge', () => {
        const oldEdge = makeEdge({ targetId: 'cr:channel:order.created', targetName: 'order.created' });
        const newEdge = makeEdge({ targetId: 'cr:channel:order.placed', targetName: 'order.placed' });

        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [oldEdge])]]);
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [newEdge])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.removedEdges[0].targetId).toBe('cr:channel:order.created');
        expect(delta.addedEdges).toHaveLength(1);
        expect(delta.addedEdges[0].targetId).toBe('cr:channel:order.placed');
    });

    it('treats OpenAPI and code endpoint URNs as the same IMPLEMENTS_ENDPOINT when method and path match', () => {
        const currentEdge = makeEdge({
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
            targetId: 'cr:endpoint:unknown/acme-shop:src/openapi.yml:POST:/quote',
            targetName: '/quote',
        });
        const proposedEdge = makeEdge({
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
            targetId: 'cr:endpoint:code:POST:/quote',
            targetName: '/quote',
        });
        const currentNode = makeNode({
            type: 'APIEndpoint',
            id: currentEdge.targetId,
            name: '/quote',
        });
        const proposedNode = makeNode({
            type: 'APIEndpoint',
            id: proposedEdge.targetId,
            name: '/quote',
        });

        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [currentEdge], [currentNode])]]);
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [proposedEdge], [proposedNode])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.addedEdges).toHaveLength(0);
        expect(delta.removedEdges).toHaveLength(0);
        expect(delta.addedNodes).toHaveLength(0);
        expect(delta.removedNodes).toHaveLength(0);
    });

    it('preserves path colons in the IMPLEMENTS_ENDPOINT identity key', () => {
        // Defense-in-depth: paths CAN contain ':' (Google-style /v1/foo:action,
        // legacy data not normalized). The identity key must rebuild the path
        // via slice(methodIndex+1).join(':') and not assume parts[length-1]
        // is the whole path.
        const sharedSource = 'cr:function:repo:ts:Controller::activate';
        const currentEdge = makeEdge({
            sourceId: sharedSource,
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
            targetId: 'cr:endpoint:unknown/repo:src/openapi.yml:POST:/v1/users:activate',
            targetName: 'POST /v1/users:activate',
        });
        const proposedEdge = makeEdge({
            sourceId: sharedSource,
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
            targetId: 'cr:endpoint:code:POST:/v1/users:activate',
            targetName: 'POST /v1/users:activate',
        });
        const currentNode = makeNode({ type: 'APIEndpoint', id: currentEdge.targetId, name: 'POST /v1/users:activate' });
        const proposedNode = makeNode({ type: 'APIEndpoint', id: proposedEdge.targetId, name: 'POST /v1/users:activate' });

        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [currentEdge], [currentNode])]]);
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [proposedEdge], [proposedNode])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.addedEdges).toHaveLength(0);
        expect(delta.removedEdges).toHaveLength(0);
        expect(delta.addedNodes).toHaveLength(0);
        expect(delta.removedNodes).toHaveLength(0);
    });

    it('does NOT collapse GraphQL endpoints with HTTP endpoints sharing a token', () => {
        // GraphQL URN (cr:endpoint:graphql:cr:apiinterface:foo:bar:QUERY:opName)
        // contains no HTTP_METHOD token — endpointIdentityKey returns null and
        // the diff falls back to full-URN comparison. Two unrelated endpoints
        // must therefore remain distinct.
        const sharedSource = 'cr:function:repo:ts:Resolver::list';
        const gqlEdge = makeEdge({
            sourceId: sharedSource,
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
            targetId: 'cr:endpoint:graphql:cr:apiinterface:repo:gql:QUERY:listOrders',
            targetName: 'QUERY listOrders',
        });
        const httpEdge = makeEdge({
            sourceId: sharedSource,
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
            targetId: 'cr:endpoint:code:GET:/orders',
            targetName: 'GET /orders',
        });

        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [gqlEdge])]]);
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [httpEdge])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.removedEdges[0].targetId).toContain('graphql');
        expect(delta.addedEdges).toHaveLength(1);
        expect(delta.addedEdges[0].targetId).toBe('cr:endpoint:code:GET:/orders');
    });

    it('detects added node when a new resource appears in proposed', () => {
        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts')]]);
        const newNode = makeNode({ id: 'cr:channel:payments.initiated', name: 'payments.initiated' });
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [], [newNode])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.addedNodes).toHaveLength(1);
        expect(delta.addedNodes[0].id).toBe('cr:channel:payments.initiated');
        expect(delta.removedNodes).toHaveLength(0);
    });

    it('detects removed node when a resource disappears from proposed', () => {
        const node = makeNode();
        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [], [node])]]);
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts')]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.removedNodes).toHaveLength(1);
        expect(delta.addedNodes).toHaveLength(0);
    });

    it('ignores files not in changedFiles scope', () => {
        const edge = makeEdge();
        const current = new Map([
            ['src/A.ts', makeSnapshot('src/A.ts', [edge])],
            ['src/Unrelated.ts', makeSnapshot('src/Unrelated.ts', [makeEdge({ targetId: 'cr:broker:other' })])],
        ]);
        const proposed = new Map([
            ['src/A.ts', makeSnapshot('src/A.ts')],
            ['src/Unrelated.ts', makeSnapshot('src/Unrelated.ts')],
        ]);

        // Only A.ts is in the PR scope
        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        // Only the change in A.ts should be captured, Unrelated.ts should be ignored
        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.removedEdges[0].targetId).toBe(edge.targetId);
    });

    it('handles a new file (not in DB) — all proposed edges are additions', () => {
        const newEdge = makeEdge({ sourceFile: 'src/NewController.ts' });
        // current has no entry for this file (new file in PR)
        const current = new Map<string, FileTopologySnapshot>();
        const proposed = new Map([['src/NewController.ts', makeSnapshot('src/NewController.ts', [newEdge])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/NewController.ts']);

        expect(delta.addedEdges).toHaveLength(1);
        expect(delta.removedEdges).toHaveLength(0);
    });

    it('handles a deleted file (not in proposed) — all current edges are removals', () => {
        const edge = makeEdge();
        const current = new Map([['src/Deleted.ts', makeSnapshot('src/Deleted.ts', [edge])]]);
        const proposed = new Map<string, FileTopologySnapshot>();

        const delta = diffTopologySnapshots(current, proposed, ['src/Deleted.ts']);

        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.addedEdges).toHaveLength(0);
    });

    it('correctly identifies changedFiles on the delta', () => {
        const current = new Map<string, FileTopologySnapshot>();
        const proposed = new Map<string, FileTopologySnapshot>();
        const changed = ['src/A.ts', 'src/B.ts'];

        const delta = diffTopologySnapshots(current, proposed, changed);

        expect(delta.changedFiles).toEqual(changed);
    });

    it('handles multiple changes in the same file correctly', () => {
        const kept   = makeEdge({ relType: 'PUBLISHES_TO', targetId: 'cr:broker:kept' });
        const removed = makeEdge({ relType: 'WRITES', targetId: 'cr:datacontainer:old_table' });
        const added   = makeEdge({ relType: 'READS', targetId: 'cr:datacontainer:new_table' });

        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [kept, removed])]]);
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [kept, added])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);

        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.removedEdges[0].targetId).toBe('cr:datacontainer:old_table');
        expect(delta.addedEdges).toHaveLength(1);
        expect(delta.addedEdges[0].targetId).toBe('cr:datacontainer:new_table');
    });
});

// ─── isDeltaEmpty ─────────────────────────────────────────────────────────────

describe('isDeltaEmpty', () => {
    it('returns true when all delta arrays are empty', () => {
        const delta = diffTopologySnapshots(new Map(), new Map(), []);
        expect(isDeltaEmpty(delta)).toBe(true);
    });

    it('returns false when there are added edges', () => {
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [makeEdge()])]]);
        const delta = diffTopologySnapshots(new Map(), proposed, ['src/A.ts']);
        expect(isDeltaEmpty(delta)).toBe(false);
    });

    it('returns false when there are removed edges', () => {
        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [makeEdge()])]]);
        const delta = diffTopologySnapshots(current, new Map(), ['src/A.ts']);
        expect(isDeltaEmpty(delta)).toBe(false);
    });
});

// ─── getAffectedResourceUrns ──────────────────────────────────────────────────

describe('getAffectedResourceUrns', () => {
    it('returns all distinct target URNs from added and removed edges', () => {
        // Distinct URN + distinct targetName: two genuinely different
        // resources. Same name with different URN would be collapsed by
        // dropScopeDriftPairs as a scope-drift no-op, which is not what this
        // test wants to exercise.
        const added   = makeEdge({ targetId: 'cr:broker:new', targetName: 'order.shipped' });
        const removed = makeEdge({ targetId: 'cr:broker:old', targetName: 'order.created' });
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [added])]]);
        const current  = new Map([['src/A.ts', makeSnapshot('src/A.ts', [removed])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);
        const urns = getAffectedResourceUrns(delta);

        expect(urns).toContain('cr:broker:new');
        expect(urns).toContain('cr:broker:old');
        expect(urns.size).toBe(2);
    });

    it('deduplicates the same URN appearing in both added and removed', () => {
        const edge = makeEdge({ targetId: 'cr:broker:shared' });
        // Same target appears in both (e.g. relType changed)
        const e1 = { ...edge, relType: 'PUBLISHES_TO' };
        const e2 = { ...edge, relType: 'LISTENS_TO' };
        const current  = new Map([['src/A.ts', makeSnapshot('src/A.ts', [e1])]]);
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [e2])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/A.ts']);
        const urns = getAffectedResourceUrns(delta);

        expect(urns.size).toBe(1);
        expect(urns).toContain('cr:broker:shared');
    });
});

// ─── getRemovedEdgesByTarget ──────────────────────────────────────────────────

describe('getRemovedEdgesByTarget', () => {
    it('groups removed edges by their target URN', () => {
        const e1 = makeEdge({ sourceId: 'cr:fn:A', targetId: 'cr:broker:q1' });
        const e2 = makeEdge({ sourceId: 'cr:fn:B', targetId: 'cr:broker:q1' });
        const e3 = makeEdge({ sourceId: 'cr:fn:C', targetId: 'cr:broker:q2' });

        const current = new Map([['src/A.ts', makeSnapshot('src/A.ts', [e1, e2, e3])]]);
        const delta = diffTopologySnapshots(current, new Map(), ['src/A.ts']);
        const byTarget = getRemovedEdgesByTarget(delta);

        expect(byTarget.get('cr:broker:q1')).toHaveLength(2);
        expect(byTarget.get('cr:broker:q2')).toHaveLength(1);
    });
});

// ─── getAddedEdgesByTarget ────────────────────────────────────────────────────

describe('getAddedEdgesByTarget', () => {
    it('groups added edges by their target URN', () => {
        const e1 = makeEdge({ sourceId: 'cr:fn:A', targetId: 'cr:broker:new' });
        const e2 = makeEdge({ sourceId: 'cr:fn:B', targetId: 'cr:broker:new' });
        const proposed = new Map([['src/A.ts', makeSnapshot('src/A.ts', [e1, e2])]]);

        const delta = diffTopologySnapshots(new Map(), proposed, ['src/A.ts']);
        const byTarget = getAddedEdgesByTarget(delta);

        expect(byTarget.get('cr:broker:new')).toHaveLength(2);
    });
});

// ─── scope-drift normalisation ────────────────────────────────────────────────
//
// Regression: two edges that share (sourceFile, sourceId, relType, targetType,
// targetName) but differ only on targetId are a "scope-drift" artifact, not a
// real topology change. They happen when the DB holds a DataContainer welded
// to a winner URN (cross-repo dedup by physical endpoint) while ephemeral
// re-extraction emits the naive single-repo URN. The differ must collapse
// these pairs to a no-op so they never reach the blast resolver as a
// misleading "Table mapping changed: X -> X" rename.

describe('diffTopologySnapshots — scope-drift normalization', () => {
    const dcEdgeBase = {
        sourceId: 'cr:function:local/orders:php:Acme\\Entity\\Order::__class_metadata',
        sourceName: 'Acme\\Entity\\Order::__class_metadata',
        sourceFile: 'src/Entity/Order.php',
        relType: 'MAPS_TO',
        targetType: 'DataContainer',
        targetName: 'orders',
    };

    it('drops scope-drift pairs (same source/relType/targetName, different targetId)', () => {
        const currentEdge = makeEdge({ ...dcEdgeBase, targetId: 'cr:datacontainer:acme/orders-core:orders' });
        const proposedEdge = makeEdge({ ...dcEdgeBase, targetId: 'cr:datacontainer:local/orders:orders' });
        const current = new Map([[dcEdgeBase.sourceFile, makeSnapshot(dcEdgeBase.sourceFile, [currentEdge])]]);
        const proposed = new Map([[dcEdgeBase.sourceFile, makeSnapshot(dcEdgeBase.sourceFile, [proposedEdge])]]);

        const delta = diffTopologySnapshots(current, proposed, [dcEdgeBase.sourceFile]);

        expect(delta.removedEdges).toHaveLength(0);
        expect(delta.addedEdges).toHaveLength(0);
    });

    it('keeps the pair when sourceFile differs (different file = real change)', () => {
        const currentEdge = makeEdge({ ...dcEdgeBase, sourceFile: 'src/Entity/Old.php', targetId: 'cr:datacontainer:acme/orders-core:orders' });
        const proposedEdge = makeEdge({ ...dcEdgeBase, sourceFile: 'src/Entity/New.php', targetId: 'cr:datacontainer:local/orders:orders' });
        const current = new Map([['src/Entity/Old.php', makeSnapshot('src/Entity/Old.php', [currentEdge])]]);
        const proposed = new Map([['src/Entity/New.php', makeSnapshot('src/Entity/New.php', [proposedEdge])]]);

        const delta = diffTopologySnapshots(current, proposed, ['src/Entity/Old.php', 'src/Entity/New.php']);

        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.addedEdges).toHaveLength(1);
    });

    it('keeps the pair when targetName differs (genuine rename)', () => {
        const currentEdge = makeEdge({ ...dcEdgeBase, targetId: 'cr:datacontainer:acme/orders-core:orders', targetName: 'orders' });
        const proposedEdge = makeEdge({ ...dcEdgeBase, targetId: 'cr:datacontainer:acme/orders-core:purchases', targetName: 'purchases' });
        const current = new Map([[dcEdgeBase.sourceFile, makeSnapshot(dcEdgeBase.sourceFile, [currentEdge])]]);
        const proposed = new Map([[dcEdgeBase.sourceFile, makeSnapshot(dcEdgeBase.sourceFile, [proposedEdge])]]);

        const delta = diffTopologySnapshots(current, proposed, [dcEdgeBase.sourceFile]);

        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.addedEdges).toHaveLength(1);
    });
});

// ─── Table-rename cascade suppression ────────────────────────────────────────
//
// Renaming `@ORM\Table(name="orders")` to `name="purchases"` flips the parent
// table name. Because the DataStructure URN scheme includes the table
// (`cr:schema:database_table:<table>`), every dependent edge (DataStructure
// itself, every DataField, every HAS_FIELD, the HAS_SCHEMA join with the DC,
// the Function PRODUCES edge) churns even though the user only changed one
// string. Without suppression the blast resolver emits 1 + N + 1 + 1 DANGER
// findings (one per column "removed", one per column "added", plus the
// MAPS_TO rename, plus an orphan WARNING for the new table). The differ
// must collapse the cascade to a single MAPS_TO rename pair so the resolver
// renders ONE table-rename DANGER. Column-rename behaviour *inside* an
// unchanged table (the Step 3 happy path) must keep working.

describe('diffTopologySnapshots — table rename cascade suppression', () => {
    const META_SOURCE = {
        sourceId: 'cr:function:local/orders:php:Acme\\Entity\\Order::__class_metadata',
        sourceName: 'Acme\\Entity\\Order::__class_metadata',
        sourceFile: 'src/Entity/Order.php',
    };
    const OLD_TABLE = 'orders';
    const NEW_TABLE = 'purchases';
    const OLD_DS = `cr:schema:database_table:${OLD_TABLE}`;
    const NEW_DS = `cr:schema:database_table:${NEW_TABLE}`;

    function mapsToPair(oldTable: string, newTable: string) {
        return {
            removed: makeEdge({
                ...META_SOURCE,
                relType: 'MAPS_TO', targetType: 'DataContainer',
                targetId: `cr:datacontainer:local/orders:${oldTable}`,
                targetName: oldTable,
            }),
            added: makeEdge({
                ...META_SOURCE,
                relType: 'MAPS_TO', targetType: 'DataContainer',
                targetId: `cr:datacontainer:local/orders:${newTable}`,
                targetName: newTable,
            }),
        };
    }

    function hasFieldEdge(dsUrn: string, column: string) {
        return makeEdge({
            sourceId: dsUrn,
            sourceName: dsUrn.split(':').pop()!,
            sourceFile: META_SOURCE.sourceFile,
            relType: 'HAS_FIELD',
            targetType: 'DataField',
            targetId: `${dsUrn}:field:${column}`,
            targetName: column,
        });
    }

    it('suppresses HAS_FIELD/HAS_SCHEMA/PRODUCES cascade on table rename', () => {
        const { removed: mapsRemoved, added: mapsAdded } = mapsToPair(OLD_TABLE, NEW_TABLE);
        const columns = ['id', 'customer_id', 'total'];

        // Build old + new snapshots covering the full cascade.
        const oldEdges = [
            mapsRemoved,
            makeEdge({
                ...META_SOURCE, relType: 'PRODUCES', targetType: 'DataStructure',
                targetId: OLD_DS, targetName: OLD_TABLE,
            }),
            makeEdge({
                sourceId: `cr:datacontainer:local/orders:${OLD_TABLE}`,
                sourceName: OLD_TABLE,
                sourceFile: META_SOURCE.sourceFile,
                relType: 'HAS_SCHEMA', targetType: 'DataStructure',
                targetId: OLD_DS, targetName: OLD_TABLE,
            }),
            ...columns.map(c => hasFieldEdge(OLD_DS, c)),
        ];
        const newEdges = [
            mapsAdded,
            makeEdge({
                ...META_SOURCE, relType: 'PRODUCES', targetType: 'DataStructure',
                targetId: NEW_DS, targetName: NEW_TABLE,
            }),
            makeEdge({
                sourceId: `cr:datacontainer:local/orders:${NEW_TABLE}`,
                sourceName: NEW_TABLE,
                sourceFile: META_SOURCE.sourceFile,
                relType: 'HAS_SCHEMA', targetType: 'DataStructure',
                targetId: NEW_DS, targetName: NEW_TABLE,
            }),
            ...columns.map(c => hasFieldEdge(NEW_DS, c)),
        ];

        const current = new Map([[META_SOURCE.sourceFile, makeSnapshot(META_SOURCE.sourceFile, oldEdges)]]);
        const proposed = new Map([[META_SOURCE.sourceFile, makeSnapshot(META_SOURCE.sourceFile, newEdges)]]);

        const delta = diffTopologySnapshots(current, proposed, [META_SOURCE.sourceFile]);

        // Only the MAPS_TO rename pair must remain.
        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.removedEdges[0].relType).toBe('MAPS_TO');
        expect(delta.addedEdges).toHaveLength(1);
        expect(delta.addedEdges[0].relType).toBe('MAPS_TO');

        // Cascade metadata is captured for the resolver.
        expect(delta.tableRenameCascades).toHaveLength(1);
        expect(delta.tableRenameCascades![0]).toMatchObject({
            oldTable: OLD_TABLE,
            newTable: NEW_TABLE,
        });
        expect(delta.tableRenameCascades![0].columns.sort()).toEqual([...columns].sort());
    });

    it('preserves column-level changes inside an unrenamed table (Step 3 happy path)', () => {
        // MAPS_TO unchanged. Single HAS_FIELD rename within the same table.
        const dsUrn = OLD_DS;
        const removedField = hasFieldEdge(dsUrn, 'customer_id');
        const addedField = hasFieldEdge(dsUrn, 'buyer_id');

        const current = new Map([[META_SOURCE.sourceFile, makeSnapshot(META_SOURCE.sourceFile, [removedField])]]);
        const proposed = new Map([[META_SOURCE.sourceFile, makeSnapshot(META_SOURCE.sourceFile, [addedField])]]);

        const delta = diffTopologySnapshots(current, proposed, [META_SOURCE.sourceFile]);

        expect(delta.removedEdges).toHaveLength(1);
        expect(delta.removedEdges[0].relType).toBe('HAS_FIELD');
        expect(delta.removedEdges[0].targetName).toBe('customer_id');
        expect(delta.addedEdges).toHaveLength(1);
        expect(delta.addedEdges[0].targetName).toBe('buyer_id');
        expect(delta.tableRenameCascades ?? []).toHaveLength(0);
    });

    it('handles multiple table renames in the same diff independently', () => {
        const meta2 = {
            sourceId: 'cr:function:local/orders:php:Acme\\Entity\\Invoice::__class_metadata',
            sourceName: 'Acme\\Entity\\Invoice::__class_metadata',
            sourceFile: 'src/Entity/Invoice.php',
        };
        const oldDs2 = 'cr:schema:database_table:invoices';
        const newDs2 = 'cr:schema:database_table:bills';

        const oldEdges = [
            mapsToPair(OLD_TABLE, NEW_TABLE).removed,
            hasFieldEdge(OLD_DS, 'id'),
            { ...mapsToPair('invoices', 'bills').removed, ...meta2 },
            { ...hasFieldEdge(oldDs2, 'amount'), sourceFile: meta2.sourceFile },
        ];
        const newEdges = [
            mapsToPair(OLD_TABLE, NEW_TABLE).added,
            hasFieldEdge(NEW_DS, 'id'),
            { ...mapsToPair('invoices', 'bills').added, ...meta2 },
            { ...hasFieldEdge(newDs2, 'amount'), sourceFile: meta2.sourceFile },
        ];

        const current = new Map([
            [META_SOURCE.sourceFile, makeSnapshot(META_SOURCE.sourceFile, oldEdges.filter(e => e.sourceFile === META_SOURCE.sourceFile))],
            [meta2.sourceFile, makeSnapshot(meta2.sourceFile, oldEdges.filter(e => e.sourceFile === meta2.sourceFile))],
        ]);
        const proposed = new Map([
            [META_SOURCE.sourceFile, makeSnapshot(META_SOURCE.sourceFile, newEdges.filter(e => e.sourceFile === META_SOURCE.sourceFile))],
            [meta2.sourceFile, makeSnapshot(meta2.sourceFile, newEdges.filter(e => e.sourceFile === meta2.sourceFile))],
        ]);

        const delta = diffTopologySnapshots(current, proposed, [META_SOURCE.sourceFile, meta2.sourceFile]);

        // Each rename yields one MAPS_TO pair; the HAS_FIELD cascades are dropped.
        const mapsToCount = delta.removedEdges.filter(e => e.relType === 'MAPS_TO').length
            + delta.addedEdges.filter(e => e.relType === 'MAPS_TO').length;
        expect(mapsToCount).toBe(4); // 2 removed + 2 added
        expect(delta.removedEdges.filter(e => e.relType === 'HAS_FIELD')).toHaveLength(0);
        expect(delta.addedEdges.filter(e => e.relType === 'HAS_FIELD')).toHaveLength(0);
        expect(delta.tableRenameCascades).toHaveLength(2);
    });
});
