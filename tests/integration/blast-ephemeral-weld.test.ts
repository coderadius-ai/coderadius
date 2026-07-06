import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { weldDataContainersByEndpoint } from '../../src/graph/mutations/data-contracts.js';
import {
    resolveWeldedDataContainerUrns,
    rewireEphemeralEdgesToWeldedTargets,
} from '../../src/eval/ephemeral-weld-resolver.js';
import type { FileTopologySnapshot } from '../../src/eval/types.js';

// ─── Integration: ephemeral weld resolver end-to-end ─────────────────────────
//
// Regression for the "Table mapping changed: X -> X" blast false-positive.
//
// Setup: two DataContainer nodes with the same name and identical physical
// endpoint fingerprint but distinct URN scopes (e.g. PHP service and TS
// service both pointing at the same RDBMS table). The welder collapses them
// into a single winner and tombstones the loser with `welded_into`.
//
// Ephemeral extraction of the PHP-side file naively emits the loser URN
// because it works in single-repo isolation. Without the rewire pass the
// differ would compare loser-URN (ephemeral) against winner-URN (DB) and
// surface a phantom rename. The rewire pass closes the gap.

describe('Step 2 — ephemeral weld resolver (integration)', () => {
    const PFX = 'cr://test/ephemeral-weld/';
    const COMMIT = 'STEP2WELD';
    const FP = 'fp0123456789abcd';
    // Alphabetic order matters: weldDataContainersByEndpoint picks the
    // lexicographically smaller URN as winner (a.id < b.id filter).
    // acme/orders-core < local/orders → acme/orders-core wins.
    const WINNER_URN = `${PFX}datacontainer:acme/orders-core:orders`;
    const LOSER_URN = `${PFX}datacontainer:local/orders:orders`;

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally {
            await s.close();
        }
    }

    async function seedDataContainer(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (d:DataContainer {id: $id})
                 SET d.name = $name,
                     d.valid_from_commit = 'SEED',
                     d.valid_to_commit = null,
                     d.physicalEndpointKey = $fp,
                     d.kindFamily = 'rdbms',
                     d.physicalEndpointConfidence = 'high'`,
                { id, name, fp: FP },
            );
        } finally { await s.close(); }
    }

    async function readContainer(id: string) {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (d:DataContainer {id: $id})
                 RETURN d.valid_to_commit AS tombstone, d.welded_into AS weldedInto`,
                { id },
            );
            const rec = r.records[0];
            return rec ? { tombstone: rec.get('tombstone'), weldedInto: rec.get('weldedInto') } : null;
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('rewires an ephemeral edge from the welded loser URN to the winner URN', async () => {
        // 1. Seed two DC nodes sharing the same physical fingerprint and name.
        await seedDataContainer(WINNER_URN, 'orders');
        await seedDataContainer(LOSER_URN, 'orders');

        // 2. Run the welder; it should tombstone exactly one.
        const weld = await weldDataContainersByEndpoint(COMMIT);
        expect(weld.weldedPairs).toBe(1);
        expect(weld.tombstoned).toBe(1);

        const winnerRow = await readContainer(WINNER_URN);
        const loserRow = await readContainer(LOSER_URN);
        expect(winnerRow?.tombstone).toBeNull();
        expect(loserRow?.tombstone).toBe(COMMIT);
        expect(loserRow?.weldedInto).toBe(WINNER_URN);

        // 3. Build an ephemeral snapshot pointing at the loser URN (mimics
        //    the naive single-repo URN that extractEphemeralTopology emits).
        const snapshots = new Map<string, FileTopologySnapshot>([
            ['src/Entity/Order.php', {
                filePath: 'src/Entity/Order.php',
                edges: [{
                    sourceId: `${PFX}function:local/orders:php:Acme\\Entity\\Order::__class_metadata`,
                    sourceName: 'Acme\\Entity\\Order::__class_metadata',
                    targetId: LOSER_URN,
                    targetName: 'orders',
                    relType: 'MAPS_TO',
                    sourceFile: 'src/Entity/Order.php',
                    targetType: 'DataContainer',
                }],
                nodes: [{
                    id: LOSER_URN,
                    type: 'DataContainer',
                    name: 'orders',
                    sourceFile: 'src/Entity/Order.php',
                }],
            }],
        ]);

        // 4. Run the rewire pass: edge and node must now reference the winner.
        await rewireEphemeralEdgesToWeldedTargets(snapshots);

        const snap = snapshots.get('src/Entity/Order.php')!;
        expect(snap.edges[0].targetId).toBe(WINNER_URN);
        expect(snap.edges[0].targetName).toBe('orders');
        expect(snap.nodes[0].id).toBe(WINNER_URN);
    });

    it('resolveWeldedDataContainerUrns returns empty map for un-welded URNs', async () => {
        // Pre-condition: only one DC seeded, no welding happens.
        await seedDataContainer(WINNER_URN, 'orders');
        const result = await resolveWeldedDataContainerUrns([WINNER_URN]);
        expect(result.size).toBe(0);
    });

    it('leaves snapshots untouched when nothing has been welded', async () => {
        await seedDataContainer(WINNER_URN, 'orders');
        const snapshots = new Map<string, FileTopologySnapshot>([
            ['src/Entity/Order.php', {
                filePath: 'src/Entity/Order.php',
                edges: [{
                    sourceId: `${PFX}function:acme/orders-core:php:Acme\\Entity\\Order::__class_metadata`,
                    sourceName: 'Acme\\Entity\\Order::__class_metadata',
                    targetId: WINNER_URN,
                    targetName: 'orders',
                    relType: 'MAPS_TO',
                    sourceFile: 'src/Entity/Order.php',
                    targetType: 'DataContainer',
                }],
                nodes: [],
            }],
        ]);

        await rewireEphemeralEdgesToWeldedTargets(snapshots);

        expect(snapshots.get('src/Entity/Order.php')!.edges[0].targetId).toBe(WINNER_URN);
    });
});
