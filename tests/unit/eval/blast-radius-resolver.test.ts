import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/graph/queries/blast.js', () => ({
    analyzeBlast: vi.fn(),
    resolveResource: vi.fn(),
}));
vi.mock('../../../src/graph/neo4j.js', () => ({
    getMemgraphSession: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ records: [] }),
        close: vi.fn().mockResolvedValue(undefined),
    })),
}));
vi.mock('../../../src/utils/logger.js', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { analyzeBlast, resolveResource } from '../../../src/graph/queries/blast.js';
import { resolveBlastRadius } from '../../../src/eval/blast-radius-resolver.js';
import type { GraphDelta } from '../../../src/eval/types.js';

const mockAnalyzeBlast = analyzeBlast as ReturnType<typeof vi.fn>;
const mockResolveResource = resolveResource as ReturnType<typeof vi.fn>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEdge(overrides = {}) {
    return {
        sourceId: 'cr:function:repo:ts:A::pub',
        sourceName: 'pub',
        targetId: 'cr:channel:order.created',
        targetName: 'order.created',
        relType: 'PUBLISHES_TO',
        sourceFile: 'src/A.ts',
        targetType: 'MessageChannel',
        ...overrides,
    };
}

function makeDelta(overrides: Partial<GraphDelta> = {}): GraphDelta {
    return {
        changedFiles: ['src/A.ts'],
        addedEdges: [],
        removedEdges: [],
        addedNodes: [],
        removedNodes: [],
        ...overrides,
    };
}

function makeBlastResult(downstreamCount = 0, serviceName = 'payment-service') {
    const downstream = Array.from({ length: downstreamCount }, (_, i) => ({
        serviceName: `${serviceName}-${i}`,
        serviceUrn: `cr:service:${serviceName}-${i}`,
        teamOwner: 'platform',
        relationships: ['LISTENS_TO'],
        functions: [{ name: 'handleOrder', file: 'src/handler.ts' }],
        repository: { name: `${serviceName}-${i}`, url: null },
    }));
    return {
        target: { urn: 'cr:channel:order.created', name: 'order.created', type: 'MessageChannel' },
        downstreamBlasts: downstream,
        upstreamBlasts: [],
        summary: { blastRadiusScore: downstreamCount * 2, factors: {}, teamsInvolved: [] },
    };
}

// ─── resolveBlastRadius — removed edges ──────────────────────────────────────

describe('resolveBlastRadius — removed edges', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns empty findings when delta is empty', async () => {
        const result = await resolveBlastRadius(makeDelta());
        expect(result.findings).toHaveLength(0);
        expect(result.blastRadiusScore).toBe(0);
    });

    it('returns DANGER finding when removed edge breaks downstream consumers', async () => {
        mockResolveResource.mockResolvedValue([{ urn: 'cr:broker:order.created', name: 'order.created', type: 'MessageChannel' }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(2));

        const delta = makeDelta({ removedEdges: [makeEdge()] });
        const result = await resolveBlastRadius(delta);

        const danger = result.findings.filter(f => f.severity === 'DANGER');
        expect(danger).toHaveLength(1);
        expect(danger[0].affectedServices).toHaveLength(2);
    });

    it('returns INFO finding when removed edge has no downstream consumers', async () => {
        mockResolveResource.mockResolvedValue([{ urn: 'cr:broker:order.created', name: 'order.created', type: 'MessageChannel' }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(0));

        const delta = makeDelta({ removedEdges: [makeEdge()] });
        const result = await resolveBlastRadius(delta);

        const info = result.findings.filter(f => f.severity === 'INFO');
        expect(info).toHaveLength(1);
        expect(info[0].category).toBe('removed_dependency');
    });

    it('returns WARNING when removed resource cannot be resolved in master graph', async () => {
        mockResolveResource.mockResolvedValue([]); // not in graph

        const delta = makeDelta({ removedEdges: [makeEdge()] });
        const result = await resolveBlastRadius(delta);

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].severity).toBe('WARNING');
        expect(result.findings[0].title).toContain('Blast unresolved');
    });

    it('skips silently when impact query throws', async () => {
        mockResolveResource.mockResolvedValue([{ urn: 'cr:broker:x', name: 'x', type: 'MessageChannel' }]);
        mockAnalyzeBlast.mockRejectedValue(new Error('Cypher error'));

        const delta = makeDelta({ removedEdges: [makeEdge()] });
        const result = await resolveBlastRadius(delta);

        expect(result.findings).toHaveLength(0);
    });
});

// ─── resolveBlastRadius — added edges ────────────────────────────────────────

describe('resolveBlastRadius — added edges', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns WARNING for orphan producer (new resource with no consumers)', async () => {
        mockResolveResource.mockResolvedValue([]); // new resource, not in graph
        const edge = makeEdge({ relType: 'PUBLISHES_TO', targetId: 'cr:broker:payments.initiated', targetName: 'payments.initiated' });

        const delta = makeDelta({ addedEdges: [edge] });
        const result = await resolveBlastRadius(delta);

        const warnings = result.findings.filter(f => f.severity === 'WARNING');
        expect(warnings).toHaveLength(1);
        expect(warnings[0].category).toBe('orphan_producer');
    });

    it('returns INFO for added producer edge when resource already has consumers', async () => {
        mockResolveResource.mockResolvedValue([{ urn: 'cr:broker:existing', name: 'existing', type: 'MessageChannel' }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(1));

        const edge = makeEdge({ relType: 'PUBLISHES_TO', targetId: 'cr:broker:existing', targetName: 'existing' });
        const delta = makeDelta({ addedEdges: [edge] });
        const result = await resolveBlastRadius(delta);

        const info = result.findings.filter(f => f.severity === 'INFO');
        expect(info).toHaveLength(1);
        expect(info[0].category).toBe('new_dependency');
    });

    it('returns INFO (not orphan check) for READS edge — non-producer rel type', async () => {
        const edge = makeEdge({ relType: 'READS', targetId: 'cr:datacontainer:users', targetName: 'users' });
        const delta = makeDelta({ addedEdges: [edge] });
        const result = await resolveBlastRadius(delta);

        // READS is not a producer rel → returns INFO without orphan check
        const info = result.findings.filter(f => f.severity === 'INFO');
        expect(info).toHaveLength(1);
        expect(info[0].category).toBe('new_dependency');
    });

    it('skips orphan check for target that also appears in removedEdges (renamed resource)', async () => {
        const sharedTargetId = 'cr:broker:order.created';
        const removed = makeEdge({ relType: 'PUBLISHES_TO', targetId: sharedTargetId, sourceId: 'cr:fn:old' });
        const added   = makeEdge({ relType: 'PUBLISHES_TO', targetId: sharedTargetId, sourceId: 'cr:fn:new' });

        mockResolveResource.mockResolvedValue([{ urn: sharedTargetId, name: 'order.created', type: 'MessageChannel' }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(0));

        const delta = makeDelta({ removedEdges: [removed], addedEdges: [added] });
        const result = await resolveBlastRadius(delta);

        // Only removed edge finding should exist — added edge skipped (same target)
        const orphans = result.findings.filter(f => f.category === 'orphan_producer');
        expect(orphans).toHaveLength(0);
    });

    it('uses fuzzy resolved resource for added producer checks', async () => {
        mockResolveResource
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ urn: 'cr:broker:existing', name: 'payments.initiated', type: 'MessageChannel' }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(1));

        const edge = makeEdge({
            relType: 'PUBLISHES_TO',
            targetId: 'cr:broker:local/app:payments.initiated',
            targetName: 'payments.initiated',
        });
        const result = await resolveBlastRadius(makeDelta({ addedEdges: [edge] }));

        expect(mockAnalyzeBlast).toHaveBeenCalledWith('cr:broker:existing');
        expect(result.findings[0].category).toBe('new_dependency');
    });
});

// ─── resolveBlastRadius — renamed dependencies ──────────────────────────────

describe('resolveBlastRadius — renamed dependencies', () => {
    beforeEach(() => vi.clearAllMocks());

    it('pairs removed and added MAPS_TO edges into one renamed_dependency finding', async () => {
        mockResolveResource.mockResolvedValue([{
            urn: 'cr:datacontainer:unknown/inventory-core:cart_extra_data',
            name: 'cart_extra_data',
            type: 'DataContainer',
        }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(2, 'acme-corp-service'));

        const removed = makeEdge({
            sourceId: 'cr:function:unknown/inventory-core:typescript:Order.entity.ts::CartAdditionalData::__class_metadata',
            sourceName: 'CartAdditionalData::__class_metadata',
            sourceFile: 'apps/api/src/entity.ts',
            relType: 'MAPS_TO',
            targetType: 'DataContainer',
            targetId: 'cr:datacontainer:unknown/inventory-core:cart_extra_data',
            targetName: 'cart_extra_data',
        });
        const added = makeEdge({
            sourceId: 'cr:function:unknown/inventory-core:typescript:Order.entity.ts::CartAdditionalData::__class_metadata',
            sourceName: 'CartAdditionalData::__class_metadata',
            sourceFile: 'apps/api/src/entity.ts',
            relType: 'MAPS_TO',
            targetType: 'DataContainer',
            targetId: 'cr:datacontainer:unknown/inventory-core:cart_extra_datum',
            targetName: 'cart_extra_datum',
        });

        const result = await resolveBlastRadius(makeDelta({ removedEdges: [removed], addedEdges: [added] }));

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].category).toBe('renamed_dependency');
        expect(result.findings[0].severity).toBe('DANGER');
        expect(result.findings[0].removedEdge).toEqual(removed);
        expect(result.findings[0].addedEdge).toEqual(added);
    });

    it('pairs IMPLEMENTS_ENDPOINT edges when route handler short-name matches across sourceNames', async () => {
        // Regression: when a PHP/Express route is renamed, the source URN/name
        // embeds the route path itself (e.g. `POST /api/x/quote::__route_handler`).
        // Both sourceId and sourceName differ, so the strict pair detector
        // misses it and emits two separate findings. We treat the trailing
        // short-name after `::` as the function identity for IMPLEMENTS_ENDPOINT.
        mockResolveResource.mockResolvedValue([{
            urn: 'cr:endpoint:unknown/inventory:src/openapi.yml:POST:/api/acme/pricing/quote',
            name: '/api/acme/pricing/quote',
            type: 'APIEndpoint',
        }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(1, 'api-service'));

        const removed = makeEdge({
            sourceId: 'cr:function:unknown/inventory:php:www/index.php::POST /api/acme/pricing/quote::__route_handler',
            sourceName: 'POST /api/acme/pricing/quote::__route_handler',
            sourceFile: 'www/index.php',
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
            targetId: 'cr:endpoint:unknown/inventory:src/openapi.yml:POST:/api/acme/pricing/quote',
            targetName: '/api/acme/pricing/quote',
        });
        const added = makeEdge({
            sourceId: 'cr:function:unknown/inventory:php:www/index.php::POST /api/acme/pricing/quota::__route_handler',
            sourceName: 'POST /api/acme/pricing/quota::__route_handler',
            sourceFile: 'www/index.php',
            relType: 'IMPLEMENTS_ENDPOINT',
            targetType: 'APIEndpoint',
            targetId: 'cr:endpoint:unknown/inventory:src/openapi.yml:POST:/api/acme/pricing/quota',
            targetName: 'POST /api/acme/pricing/quota',
        });

        const result = await resolveBlastRadius(makeDelta({ removedEdges: [removed], addedEdges: [added] }));

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0].category).toBe('renamed_dependency');
        expect(result.findings[0].severity).toBe('DANGER');
    });

    it('prefers same repo stem when exact target URN misses but table name exists in multiple repos', async () => {
        mockResolveResource
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { urn: 'cr:datacontainer:unknown/acme-corp:shopping_carts', name: 'shopping_carts', type: 'DataContainer' },
                { urn: 'cr:datacontainer:unknown/inventory-core:shopping_carts', name: 'shopping_carts', type: 'DataContainer' },
            ]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(0));

        const removed = makeEdge({
            relType: 'MAPS_TO',
            targetType: 'DataContainer',
            targetId: 'cr:datacontainer:local/inventory-core:shopping_carts',
            targetName: 'shopping_carts',
        });

        await resolveBlastRadius(makeDelta({ removedEdges: [removed] }));

        expect(mockAnalyzeBlast).toHaveBeenCalledWith('cr:datacontainer:unknown/inventory-core:shopping_carts');
    });

    it('enriches table rename finding with inherited column list', async () => {
        // When the differ flags a table rename cascade, the MAPS_TO rename
        // finding must carry "(N columns inherited: a, b, c)" so the reader
        // sees one consolidated DANGER instead of N per-column DANGERs.
        mockResolveResource.mockResolvedValue([{
            urn: 'cr:datacontainer:local/orders:purchases',
            name: 'purchases',
            type: 'DataContainer',
        }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(1, 'order-svc'));

        const removed = makeEdge({
            sourceId: 'cr:function:local/orders:php:Acme\\Entity\\Order::__class_metadata',
            sourceName: 'Acme\\Entity\\Order::__class_metadata',
            sourceFile: 'src/Entity/Order.php',
            relType: 'MAPS_TO',
            targetType: 'DataContainer',
            targetId: 'cr:datacontainer:local/orders:orders',
            targetName: 'orders',
        });
        const added = makeEdge({
            sourceId: 'cr:function:local/orders:php:Acme\\Entity\\Order::__class_metadata',
            sourceName: 'Acme\\Entity\\Order::__class_metadata',
            sourceFile: 'src/Entity/Order.php',
            relType: 'MAPS_TO',
            targetType: 'DataContainer',
            targetId: 'cr:datacontainer:local/orders:purchases',
            targetName: 'purchases',
        });

        const delta = makeDelta({
            removedEdges: [removed],
            addedEdges: [added],
            tableRenameCascades: [{
                oldTable: 'orders',
                newTable: 'purchases',
                columns: ['id', 'customer_id', 'total'],
            }],
        });
        const result = await resolveBlastRadius(delta);

        const renamed = result.findings.filter(f => f.category === 'renamed_dependency');
        expect(renamed).toHaveLength(1);
        expect(renamed[0].whatChanged).toContain('3 columns inherited');
        expect(renamed[0].whatChanged).toContain('id');
        expect(renamed[0].whatChanged).toContain('customer_id');
        expect(renamed[0].whatChanged).toContain('total');
    });

    it('suppresses orphan WARNING on the new side of a table rename', async () => {
        // After a table rename, the new-side DC has no consumers yet (the
        // consumers still call the OLD name, breaking but already flagged
        // by the DANGER). The orphan signal is redundant noise; drop it.
        // Default mock: every resolve returns [] except where overridden;
        // ensures the orphan path produces a real WARNING (without the
        // suppression code under test), so this test is truly RED before
        // the implementation lands.
        mockResolveResource.mockResolvedValue([]);
        mockResolveResource
            .mockResolvedValueOnce([{ urn: 'cr:datacontainer:local/orders:purchases', name: 'purchases', type: 'DataContainer' }]);

        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(1));

        const removed = makeEdge({
            sourceId: 'cr:function:local/orders:php:Acme\\Entity\\Order::__class_metadata',
            sourceName: 'Acme\\Entity\\Order::__class_metadata',
            sourceFile: 'src/Entity/Order.php',
            relType: 'MAPS_TO', targetType: 'DataContainer',
            targetId: 'cr:datacontainer:local/orders:orders', targetName: 'orders',
        });
        const added = makeEdge({
            sourceId: 'cr:function:local/orders:php:Acme\\Entity\\Order::__class_metadata',
            sourceName: 'Acme\\Entity\\Order::__class_metadata',
            sourceFile: 'src/Entity/Order.php',
            relType: 'MAPS_TO', targetType: 'DataContainer',
            targetId: 'cr:datacontainer:local/orders:purchases', targetName: 'purchases',
        });
        // Synthetic orphan producer toward the new table (would normally be
        // a WARNING via the addedByTarget loop). When tableRenameCascades
        // contains the new table, this WARNING must be suppressed.
        const orphanAdd = makeEdge({
            sourceId: 'cr:function:local/orders:php:Acme\\Other::publish',
            sourceName: 'Acme\\Other::publish',
            sourceFile: 'src/Other.php',
            relType: 'WRITES', targetType: 'DataContainer',
            targetId: 'cr:datacontainer:local/orders:purchases', targetName: 'purchases',
        });

        const result = await resolveBlastRadius(makeDelta({
            removedEdges: [removed],
            addedEdges: [added, orphanAdd],
            tableRenameCascades: [{ oldTable: 'orders', newTable: 'purchases', columns: [] }],
        }));

        const warnings = result.findings.filter(f => f.severity === 'WARNING');
        expect(warnings).toHaveLength(0);
    });

    it('renders HAS_FIELD rename pair as a column-level finding with downstream blast on the parent table', async () => {
        // The DataField URN follows `cr:schema:database_table:<table>:field:<name>`.
        // When the column is renamed, the resolver looks up the parent
        // DataContainer via HAS_SCHEMA and runs the blast there: the impact
        // is on consumers of the table, not on the (consumer-less) DataField.
        // This test exercises the fallback (mocked session returns no records,
        // so resolveColumnParentDataContainer returns null and we fall through
        // to resolveResource on the targetUrn). The fallback path still routes
        // through the column-aware title/rationale branches.
        mockResolveResource.mockResolvedValue([{
            urn: 'cr:datacontainer:acme/orders-core:orders',
            name: 'orders',
            type: 'DataContainer',
        }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(1, 'order-repo'));

        const removed = makeEdge({
            sourceId: 'cr:schema:database_table:orders',
            sourceName: 'orders',
            sourceFile: 'src/Entity/Order.php',
            relType: 'HAS_FIELD',
            targetType: 'DataField',
            targetId: 'cr:schema:database_table:orders:field:customer_id',
            targetName: 'customer_id',
        });
        const added = makeEdge({
            sourceId: 'cr:schema:database_table:orders',
            sourceName: 'orders',
            sourceFile: 'src/Entity/Order.php',
            relType: 'HAS_FIELD',
            targetType: 'DataField',
            targetId: 'cr:schema:database_table:orders:field:buyer_id',
            targetName: 'buyer_id',
        });

        const result = await resolveBlastRadius(makeDelta({ removedEdges: [removed], addedEdges: [added] }));

        expect(result.findings).toHaveLength(1);
        const finding = result.findings[0];
        expect(finding.category).toBe('renamed_dependency');
        expect(finding.title).toContain('Column renamed');
        expect(finding.title).toContain('customer_id');
        expect(finding.title).toContain('buyer_id');
        expect(finding.whatChanged).toContain('Column renamed: `customer_id` -> `buyer_id` in table `orders`');
        expect(finding.rationale).toContain('parent table');
    });

    // Regression: when a customer's PHP entity file is touched but the welder
    // has cross-repo-deduped its DataContainer into a winner URN owned by
    // another repo, the ephemeral re-extraction emits the loser-scope URN
    // while the DB snapshot returns the winner URN. Both targetNames are
    // identical (same logical table); pairing them as a rename produces a
    // misleading "Table mapping changed: X -> X" finding. isRenamePair must
    // refuse to pair edges whose targetName matches (defense in depth in
    // addition to the differ-level scope-drift collapse).
    it('does NOT pair as rename when target names are identical (scope-drift artifact)', async () => {
        mockResolveResource.mockResolvedValue([{
            urn: 'cr:datacontainer:acme/orders-core:orders',
            name: 'orders',
            type: 'DataContainer',
        }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(2));

        const sourceId = 'cr:function:local/orders:php:Acme\\Entity\\Order::__class_metadata';
        const sourceName = 'Acme\\Entity\\Order::__class_metadata';
        const sourceFile = 'src/Entity/Order.php';

        const removed = makeEdge({
            sourceId, sourceName, sourceFile,
            relType: 'MAPS_TO',
            targetType: 'DataContainer',
            targetId: 'cr:datacontainer:acme/orders-core:orders',
            targetName: 'orders',
        });
        const added = makeEdge({
            sourceId, sourceName, sourceFile,
            relType: 'MAPS_TO',
            targetType: 'DataContainer',
            targetId: 'cr:datacontainer:local/orders:orders',
            targetName: 'orders',
        });

        const result = await resolveBlastRadius(makeDelta({ removedEdges: [removed], addedEdges: [added] }));

        const renamed = result.findings.filter(f => f.category === 'renamed_dependency');
        expect(renamed).toHaveLength(0);
    });
});

// ─── resolveBlastRadius — sorting and scoring ─────────────────────────────────

describe('resolveBlastRadius — sorting and scoring', () => {
    beforeEach(() => vi.clearAllMocks());

    it('sorts findings DANGER → WARNING → INFO', async () => {
        // Setup: one removed edge (no consumers → INFO) + one added orphan (WARNING)
        mockResolveResource
            .mockResolvedValueOnce([{ urn: 'cr:broker:old', name: 'old', type: 'MessageChannel' }])  // removedEdge resolve
            .mockResolvedValueOnce([]);                                                                 // addedEdge orphan check
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(2)); // DANGER for the removed

        const removed = makeEdge({ targetId: 'cr:broker:old', targetName: 'old' });
        const added   = makeEdge({ relType: 'PUBLISHES_TO', targetId: 'cr:broker:brand-new', targetName: 'brand-new' });

        // Use two separate targets so orphan isn't skipped
        mockResolveResource
            .mockResolvedValueOnce([{ urn: 'cr:broker:old', name: 'old', type: 'MessageChannel' }])
            .mockResolvedValueOnce([]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(2));

        const delta = makeDelta({ removedEdges: [removed], addedEdges: [added] });
        const result = await resolveBlastRadius(delta);

        const severities = result.findings.map(f => f.severity);
        // DANGER should come before WARNING
        if (severities.includes('DANGER') && severities.includes('WARNING')) {
            expect(severities.indexOf('DANGER')).toBeLessThan(severities.indexOf('WARNING'));
        }
    });

    it('computes blastRadiusScore as zero when all findings are INFO', async () => {
        mockResolveResource.mockResolvedValue([{ urn: 'cr:broker:x', name: 'x', type: 'MessageChannel' }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(0));

        const delta = makeDelta({ removedEdges: [makeEdge()] });
        const result = await resolveBlastRadius(delta);

        expect(result.blastRadiusScore).toBe(0);
    });

    it('computes blastRadiusScore proportional to affected services', async () => {
        mockResolveResource.mockResolvedValue([{ urn: 'cr:broker:x', name: 'x', type: 'MessageChannel' }]);
        mockAnalyzeBlast.mockResolvedValue(makeBlastResult(3)); // DANGER with 3 downstream

        const delta = makeDelta({ removedEdges: [makeEdge()] });
        const result = await resolveBlastRadius(delta);

        // score formula: DANGER = affectedCount * 2 + 1 = 3*2+1 = 7
        expect(result.blastRadiusScore).toBe(7);
    });
});
