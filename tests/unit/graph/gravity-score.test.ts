import { describe, it, expect } from 'vitest';
import type { TopologyMap, TopologyNode, TopologyEdge, GravityEvidence } from '@coderadius/shared-types';
import {
    TIER_GRADES,
    classifyGravityTier,
    normaliseToBar,
} from '@coderadius/shared-types';
import { computeGravityScores, gravityWeight } from '../../../src/graph/queries/topology.js';

// ─── Production engine under test ───────────────────────────────────────────
//
// These scenarios exercise the REAL computeGravityScores exported by
// src/graph/queries/topology.ts (no local mirror) and the REAL tier
// thresholds from @coderadius/shared-types/topology-rels.ts.
//
// scoreOf/evidenceOf run the engine on the whole map (idempotent: the engine
// overwrites gravityScore/gravityEvidence on every call) and read one node.

function scoreOf(topology: TopologyMap, urn: string): number {
    computeGravityScores(topology.nodes, topology.out, topology.in);
    return topology.nodes[urn].gravityScore ?? 0;
}

function evidenceOf(topology: TopologyMap, urn: string): GravityEvidence | undefined {
    computeGravityScores(topology.nodes, topology.out, topology.in);
    return topology.nodes[urn].gravityEvidence;
}

/** Grade adapter: scenarios assert 'T0'..'T4' on the raw score (no evidence). */
function classifyTier(score: number): string {
    return TIER_GRADES[classifyGravityTier(score)];
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeNode(name: string, type: string): TopologyNode {
    return { name, type };
}

function buildTopology(
    nodeEntries: [string, TopologyNode][],
    edges: { source: string; target: string; rel: string }[],
): TopologyMap {
    const nodes: Record<string, TopologyNode> = {};
    const out: Record<string, TopologyEdge[]> = {};
    const inMap: Record<string, TopologyEdge[]> = {};

    for (const [urn, node] of nodeEntries) {
        nodes[urn] = node;
    }

    for (const { source, target, rel } of edges) {
        const edge: TopologyEdge = { source, target, rel };
        (out[source] ??= []).push(edge);
        (inMap[target] ??= []).push(edge);
    }

    return { nodes, out, in: inMap };
}


// ─── Test Scenarios ─────────────────────────────────────────────────────────

describe('Downstream Gravity Score', () => {

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 1: Leaf Node (standalone worker, no downstream)
    // Expected: T4 Contained — it breaks nothing.
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 1: Leaf node (standalone worker)', () => {
        const topo = buildTopology(
            [
                ['cr:service:email-worker', makeNode('email-worker', 'Service')],
                ['cr:channel:notifications', makeNode('notifications', 'MessageChannel')],
            ],
            [
                // email-worker LISTENS_TO notifications (upstream dep, not downstream)
                { source: 'cr:service:email-worker', target: 'cr:channel:notifications', rel: 'LISTENS_TO' },
            ],
        );

        it('scores 0 — no downstream impact', () => {
            const score = scoreOf(topo, 'cr:service:email-worker');
            expect(score).toBe(0);
        });

        it('classifies as T4 Contained', () => {
            expect(classifyTier(scoreOf(topo, 'cr:service:email-worker'))).toBe('T4');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 2: Service writing to a table read by 1 other service
    // Expected: T3 Moderate — small but non-zero downstream.
    //
    //   order-service ─(WRITES)─▶ orders_db ◀─(READS)─ reporting-service
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 2: Single writer, single reader', () => {
        const topo = buildTopology(
            [
                ['cr:service:order-service', makeNode('order-service', 'Service')],
                ['cr:dc:orders_db', makeNode('orders_db', 'DataContainer')],
                ['cr:service:reporting-service', makeNode('reporting-service', 'Service')],
            ],
            [
                { source: 'cr:service:order-service', target: 'cr:dc:orders_db', rel: 'WRITES' },
                { source: 'cr:service:reporting-service', target: 'cr:dc:orders_db', rel: 'READS' },
            ],
        );

        it('order-service has downstream impact (writes to a table someone reads)', () => {
            const score = scoreOf(topo, 'cr:service:order-service');
            expect(score).toBeGreaterThan(0);
        });

        it('order-service classifies as T3 or T4 (small blast radius)', () => {
            const tier = classifyTier(scoreOf(topo, 'cr:service:order-service'));
            expect(['T3', 'T4']).toContain(tier);
        });

        it('reporting-service has 0 downstream (it only READS)', () => {
            const score = scoreOf(topo, 'cr:service:reporting-service');
            expect(score).toBe(0);
            expect(classifyTier(score)).toBe('T4');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 3: Shared database accessed by 8 services (Data Monolith)
    // Expected: T1 or T0 — this is a critical shared resource.
    //
    //   svc-A ─(WRITES)─▶ core_users ◀─(READS)─ svc-B, svc-C, ..., svc-H
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 3: Shared database — data monolith (8 readers)', () => {
        const nodes: [string, TopologyNode][] = [
            ['cr:dc:core_users', makeNode('core_users', 'DataContainer')],
            ['cr:service:identity-service', makeNode('identity-service', 'Service')],
        ];
        const edges: { source: string; target: string; rel: string }[] = [
            { source: 'cr:service:identity-service', target: 'cr:dc:core_users', rel: 'WRITES' },
        ];

        // 8 reader services
        for (let i = 1; i <= 8; i++) {
            const svcUrn = `cr:service:consumer-${i}`;
            nodes.push([svcUrn, makeNode(`consumer-${i}`, 'Service')]);
            edges.push({ source: svcUrn, target: 'cr:dc:core_users', rel: 'READS' });
        }

        const topo = buildTopology(nodes, edges);

        it('identity-service (the sole writer) has high gravity score', () => {
            const score = scoreOf(topo, 'cr:service:identity-service');
            // Tier 1 direct: core_users table (degree = 9: 1 write + 8 reads)
            // Tier 2 transitive: 8 reader services (each with degree 1)
            expect(score).toBeGreaterThanOrEqual(10);
        });

        it('identity-service classifies as T2 or higher (16 is High with gravity thresholds)', () => {
            const tier = classifyTier(scoreOf(topo, 'cr:service:identity-service'));
            expect(['T0', 'T1', 'T2']).toContain(tier);
        });

        it('a reader service has zero downstream', () => {
            const score = scoreOf(topo, 'cr:service:consumer-1');
            expect(score).toBe(0);
            expect(classifyTier(score)).toBe('T4');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 4: Event bus producer with 12 downstream consumers
    // Expected: T1+ — this is a critical event source.
    //
    //   payment-service ─(PUBLISHES_TO)─▶ payment.completed ◀─(LISTENS_TO)─ 12 services
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 4: Event bus producer (12 consumers)', () => {
        const nodes: [string, TopologyNode][] = [
            ['cr:channel:payment.completed', makeNode('payment.completed', 'MessageChannel')],
            ['cr:service:payment-service', makeNode('payment-service', 'Service')],
        ];
        const edges: { source: string; target: string; rel: string }[] = [
            { source: 'cr:service:payment-service', target: 'cr:channel:payment.completed', rel: 'PUBLISHES_TO' },
        ];

        for (let i = 1; i <= 12; i++) {
            const svcUrn = `cr:service:listener-${i}`;
            nodes.push([svcUrn, makeNode(`listener-${i}`, 'Service')]);
            edges.push({ source: svcUrn, target: 'cr:channel:payment.completed', rel: 'LISTENS_TO' });
        }

        const topo = buildTopology(nodes, edges);

        it('payment-service (producer) has high gravity score', () => {
            const score = scoreOf(topo, 'cr:service:payment-service');
            // 12 transitive consumers via passthrough + 1 direct channel = score ~22
            expect(score).toBeGreaterThanOrEqual(20);
        });

        it('payment-service classifies as T2 or higher', () => {
            const tier = classifyTier(scoreOf(topo, 'cr:service:payment-service'));
            expect(['T0', 'T1', 'T2']).toContain(tier);
        });

        it('a listener has zero downstream (it only consumes)', () => {
            const score = scoreOf(topo, 'cr:service:listener-1');
            expect(score).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 5: API Gateway called by many services
    // Expected: T2+ — it's a critical dependency, but CALLS flow is different.
    //
    //   svc-A, svc-B, svc-C ─(CALLS)─▶ gateway-endpoint
    //   gateway-service ─(IMPLEMENTS_ENDPOINT)─▶ gateway-endpoint
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 5: API Gateway endpoint (6 callers)', () => {
        const nodes: [string, TopologyNode][] = [
            ['cr:endpoint:GET:/api/users', makeNode('GET /api/users', 'APIEndpoint')],
            ['cr:service:gateway', makeNode('gateway', 'Service')],
        ];
        const edges: { source: string; target: string; rel: string }[] = [
            // gateway IMPLEMENTS_ENDPOINT → endpoint (emission: downstream)
            { source: 'cr:service:gateway', target: 'cr:endpoint:GET:/api/users', rel: 'IMPLEMENTS_ENDPOINT' },
        ];

        // 6 services that CALL this endpoint
        for (let i = 1; i <= 6; i++) {
            const svcUrn = `cr:service:caller-${i}`;
            nodes.push([svcUrn, makeNode(`caller-${i}`, 'Service')]);
            edges.push({ source: svcUrn, target: 'cr:endpoint:GET:/api/users', rel: 'CALLS' });
        }

        const topo = buildTopology(nodes, edges);

        it('gateway has downstream impact via IMPLEMENTS_ENDPOINT → endpoint → callers', () => {
            const score = scoreOf(topo, 'cr:service:gateway');
            expect(score).toBeGreaterThan(0);
        });

        it('gateway classifies as T2 or T3 (6 callers is moderate-to-high blast)', () => {
            const tier = classifyTier(scoreOf(topo, 'cr:service:gateway'));
            expect(['T0', 'T1', 'T2', 'T3']).toContain(tier);
        });

        it('a calling service has zero downstream (CALLS = upstream dep)', () => {
            const score = scoreOf(topo, 'cr:service:caller-1');
            expect(score).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 6: Weighted gravity — downstream node has high connectivity
    // A service writes to a table that is read by a CRITICAL hub service.
    // The hub's degree should inflate the writer's score compared to a table
    // read only by a leaf service.
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 6: Gravity weighting — hub vs leaf downstream', () => {
        // Graph A: writer → table ← leaf-reader (degree 1)
        const topoLeaf = buildTopology(
            [
                ['cr:service:writer', makeNode('writer', 'Service')],
                ['cr:dc:table-a', makeNode('table-a', 'DataContainer')],
                ['cr:service:leaf-reader', makeNode('leaf-reader', 'Service')],
            ],
            [
                { source: 'cr:service:writer', target: 'cr:dc:table-a', rel: 'WRITES' },
                { source: 'cr:service:leaf-reader', target: 'cr:dc:table-a', rel: 'READS' },
            ],
        );

        // Graph B: writer → table ← hub-reader (degree 20: calls 19 other endpoints)
        const hubNodes: [string, TopologyNode][] = [
            ['cr:service:writer', makeNode('writer', 'Service')],
            ['cr:dc:table-b', makeNode('table-b', 'DataContainer')],
            ['cr:service:hub-reader', makeNode('hub-reader', 'Service')],
        ];
        const hubEdges: { source: string; target: string; rel: string }[] = [
            { source: 'cr:service:writer', target: 'cr:dc:table-b', rel: 'WRITES' },
            { source: 'cr:service:hub-reader', target: 'cr:dc:table-b', rel: 'READS' },
        ];
        // Give hub-reader 19 more outgoing edges to inflate its degree
        for (let i = 1; i <= 19; i++) {
            const epUrn = `cr:endpoint:GET:/api/resource-${i}`;
            hubNodes.push([epUrn, makeNode(`GET /api/resource-${i}`, 'APIEndpoint')]);
            hubEdges.push({ source: 'cr:service:hub-reader', target: epUrn, rel: 'CALLS' });
        }
        const topoHub = buildTopology(hubNodes, hubEdges);

        it('writer→hub-reader scores higher than writer→leaf-reader', () => {
            const scoreLeaf = scoreOf(topoLeaf, 'cr:service:writer');
            const scoreHub = scoreOf(topoHub, 'cr:service:writer');
            expect(scoreHub).toBeGreaterThan(scoreLeaf);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 7: Cycle safety — A → B → C → A
    // The algorithm must NOT loop infinitely. Each node should produce a
    // finite score in bounded time.
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 7: Cycle safety (A → B → C → A)', () => {
        const topo = buildTopology(
            [
                ['cr:service:svc-a', makeNode('svc-a', 'Service')],
                ['cr:service:svc-b', makeNode('svc-b', 'Service')],
                ['cr:service:svc-c', makeNode('svc-c', 'Service')],
            ],
            [
                { source: 'cr:service:svc-a', target: 'cr:service:svc-b', rel: 'CALLS' },
                { source: 'cr:service:svc-b', target: 'cr:service:svc-c', rel: 'CALLS' },
                { source: 'cr:service:svc-c', target: 'cr:service:svc-a', rel: 'CALLS' },
            ],
        );

        it('terminates without infinite loop', () => {
            // Should complete in <100ms — if it hangs, the test times out
            const score = scoreOf(topo, 'cr:service:svc-a');
            expect(typeof score).toBe('number');
            expect(Number.isFinite(score)).toBe(true);
        });

        it('produces a finite, non-negative score', () => {
            const score = scoreOf(topo, 'cr:service:svc-a');
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThan(1000);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 8: Enterprise-scale shared DB (T0 Seismic candidate)
    // A massive shared database written by 3 services, read by 30.
    // Expected: T0 Seismic for the writers.
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 8: Enterprise shared DB (3 writers, 30 readers) — T0 candidate', () => {
        const nodes: [string, TopologyNode][] = [
            ['cr:dc:enterprise_ledger', makeNode('enterprise_ledger', 'DataContainer')],
        ];
        const edges: { source: string; target: string; rel: string }[] = [];

        // 3 writer services
        for (let i = 1; i <= 3; i++) {
            const svcUrn = `cr:service:writer-${i}`;
            nodes.push([svcUrn, makeNode(`writer-${i}`, 'Service')]);
            edges.push({ source: svcUrn, target: 'cr:dc:enterprise_ledger', rel: 'WRITES' });
        }

        // 30 reader services (each also connects to 2 other resources for realism)
        for (let i = 1; i <= 30; i++) {
            const svcUrn = `cr:service:reader-${i}`;
            nodes.push([svcUrn, makeNode(`reader-${i}`, 'Service')]);
            edges.push({ source: svcUrn, target: 'cr:dc:enterprise_ledger', rel: 'READS' });

            // Add 2 more dependencies to each reader to increase their degree
            for (let j = 0; j < 2; j++) {
                const epUrn = `cr:endpoint:reader-${i}-dep-${j}`;
                if (!nodes.some(([u]) => u === epUrn)) {
                    nodes.push([epUrn, makeNode(`dep-${i}-${j}`, 'APIEndpoint')]);
                }
                edges.push({ source: svcUrn, target: epUrn, rel: 'CALLS' });
            }
        }

        const topo = buildTopology(nodes, edges);

        it('writer-1 has extremely high gravity score', () => {
            const score = scoreOf(topo, 'cr:service:writer-1');
            // T1 direct: table (degree 33) + T2 transitive: 30 readers (each degree ~3)
            // Expected: ~72
            expect(score).toBeGreaterThanOrEqual(50);
        });

        it('writer-1 classifies as T1 or T0', () => {
            const tier = classifyTier(scoreOf(topo, 'cr:service:writer-1'));
            expect(['T0', 'T1']).toContain(tier);
        });

        it('a reader has zero downstream (only READs)', () => {
            const score = scoreOf(topo, 'cr:service:reader-1');
            expect(score).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 9: Unconsumed endpoints — discount, NOT zero
    // 10 endpoints implemented, nobody calls them. In an incomplete graph,
    // missing consumers are possible. Score should be > 0 (discounted) but
    // significantly less than full 2.0× scoring.
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 9: Unconsumed endpoints (IMPLEMENTS_ENDPOINT, 0 callers)', () => {
        const nodes: [string, TopologyNode][] = [
            ['cr:service:api-gateway', makeNode('api-gateway', 'Service')],
        ];
        const edges: { source: string; target: string; rel: string }[] = [];

        // 10 endpoints, nobody calls them
        for (let i = 1; i <= 10; i++) {
            const epUrn = `cr:endpoint:GET:/api/resource-${i}`;
            nodes.push([epUrn, makeNode(`GET /api/resource-${i}`, 'APIEndpoint')]);
            edges.push({ source: 'cr:service:api-gateway', target: epUrn, rel: 'IMPLEMENTS_ENDPOINT' });
        }

        const topo = buildTopology(nodes, edges);

        it('scores > 0 — discount, not zero (incomplete graph safety)', () => {
            const score = scoreOf(topo, 'cr:service:api-gateway');
            expect(score).toBeGreaterThan(0);
        });

        it('scores less than full 2.0× would give', () => {
            const score = scoreOf(topo, 'cr:service:api-gateway');
            // Full 2.0× for 10 endpoints with degree=1 each: 10 × 2.0 × 1.0 = 20
            // Discounted 0.5× for 10 endpoints: 10 × 0.5 × 1.0 = 5
            expect(score).toBeLessThan(20);
        });

        it('classifies as T3 or T4 (not T2+ like before)', () => {
            const tier = classifyTier(scoreOf(topo, 'cr:service:api-gateway'));
            expect(['T3', 'T4']).toContain(tier);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 10: Mixed endpoints — 3 consumed, 7 unconsumed
    // Consumed endpoints get full 2.0×, unconsumed get 0.5× discount.
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 10: Mixed endpoints (3 consumed, 7 unconsumed)', () => {
        const nodes: [string, TopologyNode][] = [
            ['cr:service:api-gateway', makeNode('api-gateway', 'Service')],
        ];
        const edges: { source: string; target: string; rel: string }[] = [];

        // 10 endpoints
        for (let i = 1; i <= 10; i++) {
            const epUrn = `cr:endpoint:GET:/api/resource-${i}`;
            nodes.push([epUrn, makeNode(`GET /api/resource-${i}`, 'APIEndpoint')]);
            edges.push({ source: 'cr:service:api-gateway', target: epUrn, rel: 'IMPLEMENTS_ENDPOINT' });
        }

        // Only 3 endpoints have callers
        for (let i = 1; i <= 3; i++) {
            const callerUrn = `cr:service:caller-${i}`;
            nodes.push([callerUrn, makeNode(`caller-${i}`, 'Service')]);
            edges.push({ source: callerUrn, target: `cr:endpoint:GET:/api/resource-${i}`, rel: 'CALLS' });
        }

        const topo = buildTopology(nodes, edges);

        it('scores between all-consumed and all-unconsumed', () => {
            const score = scoreOf(topo, 'cr:service:api-gateway');
            // Should be > all-unconsumed (10 × 0.5) but < all-consumed (10 × 2.0)
            expect(score).toBeGreaterThan(5);  // > pure discount
            expect(score).toBeLessThan(30);    // < full weight for all
        });

        it('consumed endpoints contribute more than unconsumed', () => {
            // We can verify this indirectly: with 3 consumed and 7 unconsumed,
            // the score should be meaningfully above the all-unconsumed baseline.
            const score = scoreOf(topo, 'cr:service:api-gateway');
            // 3 consumed × 2.0 + 7 unconsumed × 0.5 = 6 + 3.5 = ~9.5 (before weight)
            expect(score).toBeGreaterThanOrEqual(6);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 11: Large API gateway — 80 endpoints, 0 callers
    // Validates that the 0.5× discount prevents T0 inflation while keeping
    // the service at a meaningful tier (T1, not T4).
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 11: Large API gateway (80 endpoints, 0 callers)', () => {
        const nodes: [string, TopologyNode][] = [
            ['cr:service:api-gateway', makeNode('api-gateway', 'Service')],
        ];
        const edges: { source: string; target: string; rel: string }[] = [];

        for (let i = 1; i <= 80; i++) {
            const epUrn = `cr:endpoint:GET:/api/resource-${i}`;
            nodes.push([epUrn, makeNode(`GET /api/resource-${i}`, 'APIEndpoint')]);
            edges.push({ source: 'cr:service:api-gateway', target: epUrn, rel: 'IMPLEMENTS_ENDPOINT' });
        }

        const topo = buildTopology(nodes, edges);

        it('does NOT classify as T0 Seismic (inflation fix)', () => {
            const tier = classifyTier(scoreOf(topo, 'cr:service:api-gateway'));
            expect(tier).not.toBe('T0');
        });

        it('still has a meaningful score (not T4 — conservative discount)', () => {
            const score = scoreOf(topo, 'cr:service:api-gateway');
            // 80 × 0.5 × weight(1) = 80 × 0.5 × 1.0 = 40 → T2
            expect(score).toBeGreaterThanOrEqual(15); // at least T2
        });

        it('classifies as T2 or T1 (not T0, not T4)', () => {
            const tier = classifyTier(scoreOf(topo, 'cr:service:api-gateway'));
            expect(['T1', 'T2']).toContain(tier);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 12: ORM mapping star — MAPS_TO is a dependency, not emission
    // A sync service maps N tables via its ORM entities. The tables do NOT
    // break when the service dies; the service breaks when a table changes.
    //
    //   inventory-sync ─(MAPS_TO)─▶ warehouse_stock, sku_catalog, shipment_log
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 12: ORM mapping star (MAPS_TO reclassification)', () => {
        const tables = ['warehouse_stock', 'sku_catalog', 'shipment_log'];
        const topo = buildTopology(
            [
                ['cr:service:inventory-sync', makeNode('inventory-sync', 'Service')],
                ...tables.map((t): [string, TopologyNode] => [`cr:dc:${t}`, makeNode(t, 'DataContainer')]),
            ],
            tables.map(t => ({ source: 'cr:service:inventory-sync', target: `cr:dc:${t}`, rel: 'MAPS_TO' })),
        );

        it('mapped tables do NOT count as downstream of the mapper', () => {
            expect(scoreOf(topo, 'cr:service:inventory-sync')).toBe(0);
        });

        it('the mapper counts as an observed downstream dependent of each table', () => {
            for (const t of tables) {
                expect(scoreOf(topo, `cr:dc:${t}`)).toBeGreaterThan(0);
                const ev = evidenceOf(topo, `cr:dc:${t}`);
                expect(ev?.observed).toBe(true);
                expect(ev?.directFromInEdges).toBeGreaterThanOrEqual(1);
            }
        });

        it('the mapper itself has no observed dependents', () => {
            expect(evidenceOf(topo, 'cr:service:inventory-sync')?.observed).toBe(false);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 13: Evidence gate — write-footprint star vs shared DB
    // (a) A batch exporter that only writes/publishes to dead-end resources
    //     has a score but NO observed dependent: observed=false.
    // (b) A writer whose table has 5 readers is observed via Tier-2 even
    //     though nothing points at the writer directly.
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 13: Evidence gate (observed vs write footprint)', () => {
        const starNodes: [string, TopologyNode][] = [
            ['cr:service:batch-exporter', makeNode('batch-exporter', 'Service')],
        ];
        const starEdges: { source: string; target: string; rel: string }[] = [];
        for (let i = 1; i <= 4; i++) {
            starNodes.push([`cr:dc:export_${i}`, makeNode(`export_${i}`, 'DataContainer')]);
            starEdges.push({ source: 'cr:service:batch-exporter', target: `cr:dc:export_${i}`, rel: 'WRITES' });
        }
        for (let i = 1; i <= 2; i++) {
            starNodes.push([`cr:channel:export.batch.${i}`, makeNode(`export.batch.${i}`, 'MessageChannel')]);
            starEdges.push({ source: 'cr:service:batch-exporter', target: `cr:channel:export.batch.${i}`, rel: 'PUBLISHES_TO' });
        }
        const starTopo = buildTopology(starNodes, starEdges);

        it('write-footprint star: score > 0 but observed=false', () => {
            expect(scoreOf(starTopo, 'cr:service:batch-exporter')).toBeGreaterThan(0);
            const ev = evidenceOf(starTopo, 'cr:service:batch-exporter');
            expect(ev).toBeDefined();
            expect(ev?.observed).toBe(false);
            expect(ev?.directFromInEdges).toBe(0);
            expect(ev?.transitiveCount).toBe(0);
            expect(ev?.consumedEndpoints).toBe(0);
        });

        const sharedNodes: [string, TopologyNode][] = [
            ['cr:service:ledger-writer', makeNode('ledger-writer', 'Service')],
            ['cr:dc:orders_ledger', makeNode('orders_ledger', 'DataContainer')],
        ];
        const sharedEdges = [
            { source: 'cr:service:ledger-writer', target: 'cr:dc:orders_ledger', rel: 'WRITES' },
        ];
        for (let i = 1; i <= 5; i++) {
            sharedNodes.push([`cr:service:ledger-reader-${i}`, makeNode(`ledger-reader-${i}`, 'Service')]);
            sharedEdges.push({ source: `cr:service:ledger-reader-${i}`, target: 'cr:dc:orders_ledger', rel: 'READS' });
        }
        const sharedTopo = buildTopology(sharedNodes, sharedEdges);

        it('shared-DB writer: observed=true via Tier-2 readers (no direct in-edges)', () => {
            const ev = evidenceOf(sharedTopo, 'cr:service:ledger-writer');
            expect(ev?.directFromInEdges).toBe(0);
            expect(ev?.transitiveCount).toBe(5);
            expect(ev?.observed).toBe(true);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 14: Consumed endpoint counts as observed demand
    // A service whose only graph presence is one endpoint with one caller is
    // observed-dangerous even though nothing points at the service itself.
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 14: Consumed endpoint observes the provider', () => {
        const topo = buildTopology(
            [
                ['cr:service:pricing-api', makeNode('pricing-api', 'Service')],
                ['cr:endpoint:GET:/quotes', makeNode('GET /quotes', 'APIEndpoint')],
                ['cr:endpoint:GET:/health', makeNode('GET /health', 'APIEndpoint')],
                ['cr:service:storefront', makeNode('storefront', 'Service')],
            ],
            [
                { source: 'cr:service:pricing-api', target: 'cr:endpoint:GET:/quotes', rel: 'IMPLEMENTS_ENDPOINT' },
                { source: 'cr:service:pricing-api', target: 'cr:endpoint:GET:/health', rel: 'IMPLEMENTS_ENDPOINT' },
                { source: 'cr:service:storefront', target: 'cr:endpoint:GET:/quotes', rel: 'CALLS' },
            ],
        );

        it('counts only the endpoint with a real caller', () => {
            const ev = evidenceOf(topo, 'cr:service:pricing-api');
            expect(ev?.consumedEndpoints).toBe(1);
            expect(ev?.observed).toBe(true);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 15: DEAD_LETTERS_TO is emission (drift fix)
    // The DLQ accumulates backlog when the source channel dead-letters into
    // it: DLQ sits downstream of the source channel, never the reverse.
    //
    //   orders_queue ─(DEAD_LETTERS_TO)─▶ orders_dlq ◀─(LISTENS_TO)─ dlq-consumer
    // ────────────────────────────────────────────────────────────────────────
    describe('Scenario 15: DEAD_LETTERS_TO emission direction', () => {
        const topo = buildTopology(
            [
                ['cr:channel:orders_queue', makeNode('orders_queue', 'MessageChannel')],
                ['cr:channel:orders_dlq', makeNode('orders_dlq', 'MessageChannel')],
                ['cr:service:dlq-consumer', makeNode('dlq-consumer', 'Service')],
            ],
            [
                { source: 'cr:channel:orders_queue', target: 'cr:channel:orders_dlq', rel: 'DEAD_LETTERS_TO' },
                { source: 'cr:service:dlq-consumer', target: 'cr:channel:orders_dlq', rel: 'LISTENS_TO' },
            ],
        );

        it('source channel counts the DLQ (T1) and its consumer (T2) as downstream', () => {
            expect(scoreOf(topo, 'cr:channel:orders_queue')).toBeGreaterThan(0);
        });

        it('the DLQ does NOT count the source channel as downstream', () => {
            const ev = evidenceOf(topo, 'cr:channel:orders_dlq');
            // Only the consumer is a dependent; the dead-lettering source is upstream.
            expect(ev?.directFromInEdges).toBe(1);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // classifyGravityTier — evidence-gated demotion chokepoint
    // ────────────────────────────────────────────────────────────────────────
    describe('classifyGravityTier demotion', () => {
        const ev = (observed: boolean): GravityEvidence => ({
            observed, inDegree: 0, directFromInEdges: 0, transitiveCount: 0, consumedEndpoints: 0,
        });

        it('demotes an unobserved seismic score to unverified', () => {
            expect(classifyGravityTier(125, ev(false))).toBe('unverified');
            expect(TIER_GRADES.unverified).toBe('T?');
        });

        it('keeps the numeric tier when evidence is observed', () => {
            expect(classifyGravityTier(125, ev(true))).toBe('seismic');
            expect(classifyGravityTier(60, ev(true))).toBe('critical');
        });

        it('never demotes when evidence is absent (legacy payloads, SPOF summaries)', () => {
            expect(classifyGravityTier(125)).toBe('seismic');
            expect(classifyGravityTier(125, null)).toBe('seismic');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // normaliseToBar — tier boundaries land on fixed gauge positions
    // ────────────────────────────────────────────────────────────────────────
    describe('normaliseToBar tier-anchored gauge', () => {
        it('maps tier thresholds onto fifths of the bar', () => {
            expect(normaliseToBar(0)).toBe(0);
            expect(normaliseToBar(6)).toBeCloseTo(0.2, 10);
            expect(normaliseToBar(15)).toBeCloseTo(0.4, 10);
            expect(normaliseToBar(50)).toBeCloseTo(0.6, 10);
            expect(normaliseToBar(100)).toBeCloseTo(0.8, 10);
            expect(normaliseToBar(200)).toBeCloseTo(1, 10);
        });

        it('clamps above the saturation band', () => {
            expect(normaliseToBar(350)).toBe(1);
        });

        it('is monotonically increasing inside bands', () => {
            expect(normaliseToBar(72)).toBeGreaterThan(normaliseToBar(50));
            expect(normaliseToBar(72)).toBeLessThan(normaliseToBar(100));
            expect(normaliseToBar(3)).toBeGreaterThan(0);
            expect(normaliseToBar(3)).toBeLessThan(normaliseToBar(6));
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // gravityWeight function unit tests
    // ────────────────────────────────────────────────────────────────────────
    describe('gravityWeight helper', () => {
        it('degree 0 → weight 1 (minimum)', () => {
            expect(gravityWeight(0)).toBe(1);
        });

        it('degree 1 → weight 1', () => {
            expect(gravityWeight(1)).toBeCloseTo(1, 1);
        });

        it('degree 10 → weight 2', () => {
            expect(gravityWeight(10)).toBeCloseTo(2, 1);
        });

        it('degree 100 → weight 3', () => {
            expect(gravityWeight(100)).toBeCloseTo(3, 1);
        });

        it('is monotonically increasing', () => {
            const w1 = gravityWeight(1);
            const w5 = gravityWeight(5);
            const w10 = gravityWeight(10);
            const w50 = gravityWeight(50);
            expect(w5).toBeGreaterThan(w1);
            expect(w10).toBeGreaterThan(w5);
            expect(w50).toBeGreaterThan(w10);
        });
    });
});
