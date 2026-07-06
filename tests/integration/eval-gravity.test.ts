import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { analyzeDataGravity, analyzeServiceBottlenecks } from '../../src/graph/queries/gravity.js';

describe('Gravity & SPOF Analysis', () => {

    const TEST_PREFIX = '__test_gravity_';
    const TEST_URN_PREFIX = 'cr://test/gravity/';

    beforeAll(async () => {
        // 1. Clean up any leftover test data from previous runs
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n', { prefix: TEST_URN_PREFIX });
        } finally {
            await session.close();
        }

        await initSchema();

        // 2. Insert mock topology for testing gravity analysis
        const populateSession = getNeo4jSession();
        try {
            await populateSession.run(`
                // ── Shared DataContainer: orders (touched by 3 services, 3 teams, 1 writer) ──
                CREATE (orders:DataContainer {id: '${TEST_URN_PREFIX}datacontainer:orders', name: '${TEST_PREFIX}orders'})

                // Service 1: checkout-service (writes to orders)
                CREATE (s1:Service {id: '${TEST_URN_PREFIX}service:checkout-service', name: '${TEST_PREFIX}checkout-service'})
                CREATE (t1:Team {id: '${TEST_URN_PREFIX}team:checkout-team', name: '${TEST_PREFIX}checkout-team'})
                CREATE (t1)-[:OWNS]->(s1)
                CREATE (f1:Function {id: '${TEST_URN_PREFIX}function:checkout-service:placeOrder', name: '${TEST_PREFIX}placeOrder', filepath: 'checkout/src/handlers/order.ts'})
                CREATE (s1)-[:CONTAINS]->(f1)
                CREATE (f1)-[:WRITES]->(orders)

                // Service 2: inventory-service (reads orders)
                CREATE (s2:Service {id: '${TEST_URN_PREFIX}service:inventory-service', name: '${TEST_PREFIX}inventory-service'})
                CREATE (t2:Team {id: '${TEST_URN_PREFIX}team:inventory-team', name: '${TEST_PREFIX}inventory-team'})
                CREATE (t2)-[:OWNS]->(s2)
                CREATE (f2:Function {id: '${TEST_URN_PREFIX}function:inventory-service:checkStock', name: '${TEST_PREFIX}checkStock', filepath: 'inventory/src/stock.ts'})
                CREATE (s2)-[:CONTAINS]->(f2)
                CREATE (f2)-[:READS]->(orders)

                // Service 3: analytics-service (reads orders)
                CREATE (s3:Service {id: '${TEST_URN_PREFIX}service:analytics-service', name: '${TEST_PREFIX}analytics-service'})
                CREATE (t3:Team {id: '${TEST_URN_PREFIX}team:analytics-team', name: '${TEST_PREFIX}analytics-team'})
                CREATE (t3)-[:OWNS]->(s3)
                CREATE (f3:Function {id: '${TEST_URN_PREFIX}function:analytics-service:reportSales', name: '${TEST_PREFIX}reportSales', filepath: 'analytics/src/reports.ts'})
                CREATE (s3)-[:CONTAINS]->(f3)
                CREATE (f3)-[:READS]->(orders)

                // ── MessageChannel: events (published by 2 services, consumed by 1) ──
                CREATE (events:MessageChannel {id: '${TEST_URN_PREFIX}channel:events', name: '${TEST_PREFIX}events', technology: 'RabbitMQ'})
                CREATE (f1pub:Function {id: '${TEST_URN_PREFIX}function:checkout-service:publishOrder', name: '${TEST_PREFIX}publishOrder', filepath: 'checkout/src/events.ts'})
                CREATE (s1)-[:CONTAINS]->(f1pub)
                CREATE (f1pub)-[:PUBLISHES_TO]->(events)

                CREATE (f2pub:Function {id: '${TEST_URN_PREFIX}function:inventory-service:publishStockUpdate', name: '${TEST_PREFIX}publishStockUpdate', filepath: 'inventory/src/events.ts'})
                CREATE (s2)-[:CONTAINS]->(f2pub)
                CREATE (f2pub)-[:PUBLISHES_TO]->(events)

                CREATE (f3listen:Function {id: '${TEST_URN_PREFIX}function:analytics-service:consumeEvents', name: '${TEST_PREFIX}consumeEvents', filepath: 'analytics/src/consumer.ts'})
                CREATE (s3)-[:CONTAINS]->(f3listen)
                CREATE (f3listen)-[:LISTENS_TO]->(events)

                // ── Isolated DataContainer: audit_log (only 1 service, 1 team) ──
                CREATE (audit:DataContainer {id: '${TEST_URN_PREFIX}datacontainer:audit_log', name: '${TEST_PREFIX}audit_log'})
                CREATE (f3audit:Function {id: '${TEST_URN_PREFIX}function:analytics-service:writeAudit', name: '${TEST_PREFIX}writeAudit', filepath: 'analytics/src/audit.ts'})
                CREATE (s3)-[:CONTAINS]->(f3audit)
                CREATE (f3audit)-[:WRITES]->(audit)

                // ── Service dependency: analytics depends on checkout via function call ──
                CREATE (f3call:Function {id: '${TEST_URN_PREFIX}function:analytics-service:callCheckout', name: '${TEST_PREFIX}callCheckout', filepath: 'analytics/src/api.ts'})
                CREATE (s3)-[:CONTAINS]->(f3call)
                CREATE (f1api:Function {id: '${TEST_URN_PREFIX}function:checkout-service:getOrderApi', name: '${TEST_PREFIX}getOrderApi', filepath: 'checkout/src/api.ts'})
                CREATE (s1)-[:CONTAINS]->(f1api)
                CREATE (f3call)-[:CALLS]->(f1api)
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

    describe('analyzeDataGravity', () => {
        it('should rank orders table as the top SPOF', async () => {
            const results = await analyzeDataGravity(100);

            // Find the orders table
            const orders = results.find(n => n.name === `${TEST_PREFIX}orders`);
            expect(orders).toBeDefined();

            // orders: 3 services, 3 teams, 1 write, 2 reads
            // Asymptotic curve: raw = 6 + 9 + 1.5 + 1 = 17.5 → score ≈ 69
            expect(orders!.spofScore).toBe(69);
            expect(orders!.distinctServicesCount).toBe(3);
            expect(orders!.distinctTeamsCount).toBe(3);
            expect(orders!.writeAccessCount).toBeGreaterThanOrEqual(1);
            expect(orders!.type).toBe('DataContainer');
        });

        it('should exclude audit_log (only 1 service — below gravity threshold)', async () => {
            const results = await analyzeDataGravity(100);

            // audit_log: 1 service, 1 team → excluded by WHERE distinctServicesCount > 1
            const audit = results.find(n => n.name === `${TEST_PREFIX}audit_log`);
            expect(audit).toBeUndefined();
        });

        it('should include the events MessageChannel', async () => {
            const results = await analyzeDataGravity(100);

            const events = results.find(n => n.name === `${TEST_PREFIX}events`);
            expect(events).toBeDefined();

            // events: 3 services, 3 teams, 2 publishes, 1 listen
            // Asymptotic curve: raw = 6 + 9 + 3 + 0.5 = 18.5 → score ≈ 71
            expect(events!.spofScore).toBe(71);
            expect(events!.type).toBe('MessageChannel');
        });
    });

    describe('analyzeServiceBottlenecks', () => {
        it('should rank checkout-service as a bottleneck (analytics calls it)', async () => {
            const results = await analyzeServiceBottlenecks(1000);

            const checkout = results.find(n => n.name === `${TEST_PREFIX}checkout-service`);
            expect(checkout).toBeDefined();

            // At least 1 dependent service (analytics-service calls checkout-service)
            expect(checkout!.distinctServicesCount).toBeGreaterThanOrEqual(1);
            expect(checkout!.spofScore).toBeGreaterThan(0);
        });
    });
});
