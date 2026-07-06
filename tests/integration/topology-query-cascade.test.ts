import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { getTopologyMap } from '../../src/graph/queries/topology.js';

/**
 * Topology query — 3-tier COALESCE cascade defense-in-depth.
 *
 * Scenarios:
 *   Tier 1 (direct CONTAINS): Service -CONTAINS-> Function
 *   Tier 2 (SourceFile ancestor): Service -OWNS-> SourceFile -CONTAINS-> Function
 *   Tier 3 (self-if-arch): edge starts/ends at a Service/DataContainer/...
 *
 * The cascade fixes the empty-dashboard bug where pre-fix the query only
 * resolved Tier 1 and dropped 100% of rows when only SourceFile parents
 * existed (the common shape pre-fix).
 */
describe('getTopologyMap — Tier 2 cascade via SourceFile-OWNS-Service', () => {
    const PFX = 'cr:topology-cascade-test:';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (n) WHERE n.id STARTS WITH $p OR n.id IN $extraIds
                 DETACH DELETE n`,
                {
                    p: PFX,
                    extraIds: [
                        `${PFX}repoA`,
                        `${PFX}svcA`,
                        `${PFX}svcB`,
                        `${PFX}sfA`,
                        `${PFX}sfB`,
                        `${PFX}fnA`,
                        `${PFX}fnB`,
                        `${PFX}dataC`,
                    ],
                },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('returns edge Service→Service even when only Service-OWNS-SourceFile-CONTAINS-Function exists', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE
                   (svcA:Service { id: $svcA, name: 'inventory', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (svcB:Service { id: $svcB, name: 'orders',    valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (sfA:SourceFile { id: $sfA, path: 'src/inventory.php', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (sfB:SourceFile { id: $sfB, path: 'src/orders.php',    valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fnA:Function   { id: $fnA, name: 'createOrder', filepath: 'src/inventory.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fnB:Function   { id: $fnB, name: 'reserveStock', filepath: 'src/orders.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (svcA)-[:OWNS    { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(sfA),
                   (svcB)-[:OWNS    { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(sfB),
                   (sfA)-[:CONTAINS { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fnA),
                   (sfB)-[:CONTAINS { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fnB),
                   (fnA)-[:CALLS    { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fnB)`,
                {
                    svcA: `${PFX}svcA`, svcB: `${PFX}svcB`,
                    sfA: `${PFX}sfA`, sfB: `${PFX}sfB`,
                    fnA: `${PFX}fnA`, fnB: `${PFX}fnB`,
                },
            );
        } finally { await s.close(); }

        const topology = await getTopologyMap();

        const svcA = `${PFX}svcA`;
        const svcB = `${PFX}svcB`;

        expect(topology.nodes[svcA]).toBeDefined();
        expect(topology.nodes[svcB]).toBeDefined();
        expect(topology.nodes[svcA].type).toBe('Service');
        expect(topology.nodes[svcB].type).toBe('Service');

        const outA = topology.out[svcA] ?? [];
        const edgeAtoB = outA.find(e => e.target === svcB && e.rel === 'CALLS');
        expect(edgeAtoB).toBeDefined();
    });

    it('uses Tier 1 (direct Service-CONTAINS-Function) when present, in preference to Tier 2', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE
                   (svcA:Service { id: $svcA, name: 'inventory', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (svcB:Service { id: $svcB, name: 'orders',    valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fnA:Function { id: $fnA, name: 'createOrder', filepath: 'src/inventory.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fnB:Function { id: $fnB, name: 'reserveStock', filepath: 'src/orders.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (svcA)-[:CONTAINS { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fnA),
                   (svcB)-[:CONTAINS { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fnB),
                   (fnA)-[:CALLS    { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fnB)`,
                {
                    svcA: `${PFX}svcA`, svcB: `${PFX}svcB`,
                    fnA: `${PFX}fnA`, fnB: `${PFX}fnB`,
                },
            );
        } finally { await s.close(); }

        const topology = await getTopologyMap();
        const svcA = `${PFX}svcA`;
        const svcB = `${PFX}svcB`;
        const edgeAtoB = (topology.out[svcA] ?? []).find(e => e.target === svcB && e.rel === 'CALLS');
        expect(edgeAtoB).toBeDefined();
    });

    it('orphan Function (no Service parent via any tier) → edge excluded, query does not crash', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE
                   (fnA:Function { id: $fnA, name: 'orphanA', filepath: 'src/a.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fnB:Function { id: $fnB, name: 'orphanB', filepath: 'src/b.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fnA)-[:CALLS { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fnB)`,
                { fnA: `${PFX}fnA`, fnB: `${PFX}fnB` },
            );
        } finally { await s.close(); }

        const topology = await getTopologyMap();
        const fnA = `${PFX}fnA`;
        const fnB = `${PFX}fnB`;
        expect(topology.nodes[fnA]).toBeUndefined();
        expect(topology.nodes[fnB]).toBeUndefined();
    });

    it('Library-CONTAINS-Function on src side → topology surfaces Library node', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE
                   (libA:Library    { id: $libA, name: 'shared-lib', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (dataC:DataContainer { id: $dataC, name: 'orders_table', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (fnA:Function    { id: $fnA, name: 'helper', filepath: 'src/h.php', startLine: 1, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (libA)-[:CONTAINS { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(fnA),
                   (fnA)-[:READS    { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(dataC)`,
                {
                    libA: `${PFX}libA`,
                    dataC: `${PFX}dataC`,
                    fnA: `${PFX}fnA`,
                },
            );
        } finally { await s.close(); }

        const topology = await getTopologyMap();
        const libA = `${PFX}libA`;
        const dataC = `${PFX}dataC`;
        expect(topology.nodes[libA]).toBeDefined();
        expect(topology.nodes[libA].type).toBe('Library');
        const out = topology.out[libA] ?? [];
        const readEdge = out.find(e => e.target === dataC && e.rel === 'READS');
        expect(readEdge).toBeDefined();
    });
});

describe('getTopologyMap — coverage predicate via SourceFile presence', () => {
    const PFX = 'cr:topology-coverage-test:';

    async function wipeAll() {
        // Coverage queries ALL Repository nodes (no PFX filter), so we wipe
        // every Repository that doesn't carry a guarded id from real fixtures.
        // For test isolation, this suite assumes it runs against a Memgraph
        // freshly wiped by the harness, or that no real repos exist.
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (n) WHERE n.id STARTS WITH $p OR n.id IN $ids DETACH DELETE n`,
                {
                    p: PFX,
                    ids: [`${PFX}r1`, `${PFX}r2`, `${PFX}sf1`],
                },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipeAll(); await closeNeo4j(); });
    beforeEach(async () => { await wipeAll(); });

    it('Repository with at least one SourceFile is counted as scanned even when scanMode is null', async () => {
        // Pre-existing real repos (if any) may inflate the total / scanned
        // counters. We assert the delta-shape with a snapshot before/after.
        const before = await getTopologyMap();
        const beforeTotal = before.coverage?.totalKnownRepos ?? 0;
        const beforeScanned = before.coverage?.scannedRepos ?? 0;

        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE
                   (r:Repository { id: $r, name: 'inventory', scanMode: null, valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (sf:SourceFile { id: $sf, path: 'src/a.php', valid_from_commit: 'SYSTEM', valid_to_commit: null }),
                   (r)-[:CONTAINS { valid_from_commit: 'SYSTEM', valid_to_commit: null }]->(sf)`,
                { r: `${PFX}r1`, sf: `${PFX}sf1` },
            );
        } finally { await s.close(); }

        const after = await getTopologyMap();
        expect(after.coverage?.totalKnownRepos).toBe(beforeTotal + 1);
        expect(after.coverage?.scannedRepos).toBe(beforeScanned + 1);
    });

    it('Repository without SourceFiles is NOT counted as scanned', async () => {
        const before = await getTopologyMap();
        const beforeTotal = before.coverage?.totalKnownRepos ?? 0;
        const beforeScanned = before.coverage?.scannedRepos ?? 0;

        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (r:Repository { id: $r, name: 'empty', scanMode: null, valid_from_commit: 'SYSTEM', valid_to_commit: null })`,
                { r: `${PFX}r2` },
            );
        } finally { await s.close(); }

        const after = await getTopologyMap();
        expect(after.coverage?.totalKnownRepos).toBe(beforeTotal + 1);
        expect(after.coverage?.scannedRepos).toBe(beforeScanned);
    });
});
