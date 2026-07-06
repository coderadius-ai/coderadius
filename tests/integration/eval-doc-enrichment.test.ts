import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { buildEnrichedDocContext } from '../../src/graph/application/doc-generator.service.js';

describe('Doc Generator Enrichment Service', () => {

    const TEST_PREFIX = '__test_docenrich_';
    const TEST_URN_PREFIX = 'cr://test/docenrich/';

    beforeAll(async () => {
        // 1. Clean up any leftover test data
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n', { prefix: TEST_URN_PREFIX });
        } finally {
            await session.close();
        }

        await initSchema();

        // 2. Insert mock topology for testing enrichment
        const populateSession = getNeo4jSession();
        try {
            await populateSession.run(`
                // ── Shared DataContainer: loyalty_db (touched by 3 services, 2 teams, 1 writer) ──
                CREATE (loyaltyDb:DataContainer {id: '${TEST_URN_PREFIX}datacontainer:loyalty_db', name: '${TEST_PREFIX}loyalty_db', valid_to_commit: NULL})

                // Target Service: loyalty-service (writes to loyalty_db)
                CREATE (s1:Service {id: '${TEST_URN_PREFIX}service:loyalty-service', name: '${TEST_PREFIX}loyalty-service', valid_to_commit: NULL})
                CREATE (t1:Team {id: '${TEST_URN_PREFIX}team:loyalty-team', name: '${TEST_PREFIX}loyalty-team', valid_to_commit: NULL})
                CREATE (t1)-[:OWNS {valid_to_commit: NULL}]->(s1)
                CREATE (f1:Function {id: '${TEST_URN_PREFIX}function:loyalty-service:createVoucher', name: '${TEST_PREFIX}createVoucher', filepath: 'loyalty/src/handlers/create.ts', valid_to_commit: NULL})
                CREATE (s1)-[:CONTAINS {valid_to_commit: NULL}]->(f1)
                CREATE (f1)-[:WRITES {valid_to_commit: NULL}]->(loyaltyDb)

                // Downstream Service 1: returns-service (reads loyalty_db)
                CREATE (s2:Service {id: '${TEST_URN_PREFIX}service:returns-service', name: '${TEST_PREFIX}returns-service', valid_to_commit: NULL})
                CREATE (t2:Team {id: '${TEST_URN_PREFIX}team:returns-team', name: '${TEST_PREFIX}returns-team', valid_to_commit: NULL})
                CREATE (t2)-[:OWNS {valid_to_commit: NULL}]->(s2)
                CREATE (f2:Function {id: '${TEST_URN_PREFIX}function:returns-service:lookupVoucher', name: '${TEST_PREFIX}lookupVoucher', filepath: 'returns/src/lookup.ts', valid_to_commit: NULL})
                CREATE (s2)-[:CONTAINS {valid_to_commit: NULL}]->(f2)
                CREATE (f2)-[:READS {valid_to_commit: NULL}]->(loyaltyDb)

                // Downstream Service 2: billing-service (reads loyalty_db, same team as returns for testing)
                CREATE (s3:Service {id: '${TEST_URN_PREFIX}service:billing-service', name: '${TEST_PREFIX}billing-service', valid_to_commit: NULL})
                CREATE (t2)-[:OWNS {valid_to_commit: NULL}]->(s3)
                CREATE (f3:Function {id: '${TEST_URN_PREFIX}function:billing-service:calculateDiscount', name: '${TEST_PREFIX}calculateDiscount', filepath: 'billing/src/discount.ts', valid_to_commit: NULL})
                CREATE (s3)-[:CONTAINS {valid_to_commit: NULL}]->(f3)
                CREATE (f3)-[:READS {valid_to_commit: NULL}]->(loyaltyDb)

                // Event queue
                CREATE (queue:MessageChannel {id: '${TEST_URN_PREFIX}channel:loyalty-events', name: '${TEST_PREFIX}loyalty-events', technology: 'RabbitMQ', valid_to_commit: NULL})
                CREATE (f1pub:Function {id: '${TEST_URN_PREFIX}function:loyalty-service:publishVoucherEvent', name: '${TEST_PREFIX}publishVoucherEvent', filepath: 'loyalty/src/events.ts', valid_to_commit: NULL})
                CREATE (s1)-[:CONTAINS {valid_to_commit: NULL}]->(f1pub)
                CREATE (f1pub)-[:PUBLISHES_TO {valid_to_commit: NULL}]->(queue)

                // Dependency: returns calls loyalty-service
                CREATE (f2call:Function {id: '${TEST_URN_PREFIX}function:returns-service:callVoucher', name: '${TEST_PREFIX}callVoucher', filepath: 'returns/src/api.ts', valid_to_commit: NULL})
                CREATE (s2)-[:CONTAINS {valid_to_commit: NULL}]->(f2call)
                CREATE (f1api:Function {id: '${TEST_URN_PREFIX}function:loyalty-service:getVoucherApi', name: '${TEST_PREFIX}getVoucherApi', filepath: 'loyalty/src/api.ts', valid_to_commit: NULL})
                CREATE (s1)-[:CONTAINS {valid_to_commit: NULL}]->(f1api)
                CREATE (f2call)-[:CALLS {valid_to_commit: NULL}]->(f1api)
            `);

        } finally {
            await populateSession.close();
        }
    });

    afterAll(async () => {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n', { prefix: TEST_URN_PREFIX });
        } finally {
            await session.close();
            await closeNeo4j();
        }
    });

    describe('buildEnrichedDocContext', () => {
        it('should return topology with risk metrics for a valid service', async () => {
            const ctx = await buildEnrichedDocContext(
                `${TEST_PREFIX}loyalty-service`,
            );

            // Topology should be populated
            expect(ctx.topology).toBeDefined();
            expect(ctx.topology.serviceName).toBe(`${TEST_PREFIX}loyalty-service`);
            expect(ctx.topology.functions.length).toBeGreaterThan(0);

            // Risk metrics should be present
            if (ctx.riskMetrics) {
                expect(typeof ctx.riskMetrics.blastRadiusScore).toBe('number');
                expect(typeof ctx.riskMetrics.downstreamServicesImpacted).toBe('number');
                expect(typeof ctx.riskMetrics.dataConfidence).toBe('string');
                expect(['high', 'low']).toContain(ctx.riskMetrics.dataConfidence);
                expect(['blast', 'gravity', 'composite']).toContain(ctx.riskMetrics.scoreSource);
            }
        });

        it('should return riskMetrics: null when skipRisk is true', async () => {
            const ctx = await buildEnrichedDocContext(`${TEST_PREFIX}loyalty-service`, { skipRisk: true });

            expect(ctx.topology).toBeDefined();
            expect(ctx.topology.serviceName).toBe(`${TEST_PREFIX}loyalty-service`);
            expect(ctx.riskMetrics).toBeNull();
        });

        it('should detect critical data dependencies (loyalty_db is a shared resource)', async () => {
            const ctx = await buildEnrichedDocContext(`${TEST_PREFIX}loyalty-service`);

            expect(ctx.riskMetrics).not.toBeNull();
            if (ctx.riskMetrics) {
                // loyalty_db is written by loyalty-service and read by returns + billing = should appear as critical
                const loyaltyDbDep = ctx.riskMetrics.criticalDataDependencies.find(
                    d => d.name === `${TEST_PREFIX}loyalty_db`,
                );
                expect(loyaltyDbDep).toBeDefined();
                expect(loyaltyDbDep!.spofScore).toBeGreaterThan(0);

                // Fix #1: When a service has critical data dependencies, blastRadiusScore
                // should be > 0 even if the impact query returns 0 for a Service target.
                expect(ctx.riskMetrics.blastRadiusScore).toBeGreaterThan(0);
                // Score should be gravity-derived since the target is a Service node
                expect(['gravity', 'composite']).toContain(ctx.riskMetrics.scoreSource);
            }
        });

        it('should report high data confidence when teams are present', async () => {
            const ctx = await buildEnrichedDocContext(`${TEST_PREFIX}loyalty-service`);

            expect(ctx.riskMetrics).not.toBeNull();
            expect(ctx.riskMetrics!.dataConfidence).toBe('high');
        });

        it('should return empty topology for a non-existent service', async () => {
            const ctx = await buildEnrichedDocContext('nonexistent-service-xyz');

            expect(ctx.topology.functions.length).toBe(0);
            expect(ctx.topology.outbound.length).toBe(0);
            expect(ctx.topology.inbound.length).toBe(0);
        });
    });

    describe('graceful degradation', () => {
        const ISOLATED_PREFIX = '__test_docenrich_iso_';
        const ISOLATED_URN_PREFIX = 'cr://test/docenrich/iso/';

        beforeAll(async () => {
            const session = getNeo4jSession();
            try {
                // Insert a service with NO team ownership
                await session.run(`
                    CREATE (s:Service {id: '${ISOLATED_URN_PREFIX}service:orphan-svc', name: '${ISOLATED_PREFIX}orphan-svc', valid_to_commit: NULL})
                    CREATE (f:Function {id: '${ISOLATED_URN_PREFIX}function:orphan-svc:doWork', name: '${ISOLATED_PREFIX}doWork', filepath: 'orphan/src/index.ts', valid_to_commit: NULL})
                    CREATE (s)-[:CONTAINS {valid_to_commit: NULL}]->(f)
                    CREATE (db:DataContainer {id: '${ISOLATED_URN_PREFIX}datacontainer:orphan_db', name: '${ISOLATED_PREFIX}orphan_db', valid_to_commit: NULL})
                    CREATE (f)-[:WRITES {valid_to_commit: NULL}]->(db)
                `);
            } finally {
                await session.close();
            }
        });

        afterAll(async () => {
            const session = getNeo4jSession();
            try {
                await session.run('MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n', { prefix: ISOLATED_URN_PREFIX });
            } finally {
                await session.close();
            }
        });

        it('should report low data confidence when no teams are present', async () => {
            const ctx = await buildEnrichedDocContext(`${ISOLATED_PREFIX}orphan-svc`);

            expect(ctx.riskMetrics).not.toBeNull();
            if (ctx.riskMetrics) {
                expect(ctx.riskMetrics.dataConfidence).toBe('low');
            }
        });
    });
});
