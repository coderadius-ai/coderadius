import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { resolveResource, analyzeBlast } from '../../src/graph/queries/blast.js';

describe('Impact Analyzer Service', () => {

    const TEST_PREFIX = '__test_mock_';
    const TEST_URN_PREFIX = 'cr://test/';

    beforeAll(async () => {
        // 1. Clean up any leftover test data from previous runs
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n', { prefix: TEST_URN_PREFIX });
        } finally {
            await session.close();
        }

        await initSchema();

        // 2. Insert mock topology for testing single-hop blast radius
        const populateSession = getNeo4jSession();
        try {
            await populateSession.run(`
                // Create Target Resource
                CREATE (users:DataContainer {id: '${TEST_URN_PREFIX}datacontainer:users', name: '${TEST_PREFIX}users'})
                
                // Create Downstream Service 1
                CREATE (s1:Service {id: '${TEST_URN_PREFIX}service:order-service', name: '${TEST_PREFIX}order-service'})
                CREATE (t1:Team {id: '${TEST_URN_PREFIX}team:checkout-team', name: '${TEST_PREFIX}checkout-team'})
                CREATE (t1)-[:OWNS]->(s1)
                CREATE (f1:Function {id: '${TEST_URN_PREFIX}function:order-service:getOrders', name: '${TEST_PREFIX}getOrders', filepath: 'order-service/src/handlers/orders.ts'})
                CREATE (s1)-[:CONTAINS]->(f1)
                CREATE (f1)-[:READS]->(users)
                
                // Create Downstream Service 2 (multiple functions reading)
                CREATE (s2:Service {id: '${TEST_URN_PREFIX}service:notification-service', name: '${TEST_PREFIX}notification-service'})
                CREATE (t2:Team {id: '${TEST_URN_PREFIX}team:comms-team', name: '${TEST_PREFIX}comms-team'})
                CREATE (t2)-[:OWNS]->(s2)
                CREATE (f2a:Function {id: '${TEST_URN_PREFIX}function:notification-service:checkUserPrefs', name: '${TEST_PREFIX}checkUserPrefs', filepath: 'notification-service/src/consumers/prefs.ts'})
                CREATE (f2b:Function {id: '${TEST_URN_PREFIX}function:notification-service:sendEmail', name: '${TEST_PREFIX}sendEmail', filepath: 'notification-service/src/consumers/email.ts'})
                CREATE (s2)-[:CONTAINS]->(f2a)
                CREATE (s2)-[:CONTAINS]->(f2b)
                CREATE (f2a)-[:READS]->(users)
                CREATE (f2b)-[:READS]->(users)

                // Create Upstream Service (Writer)
                CREATE (s3:Service {id: '${TEST_URN_PREFIX}service:user-service', name: '${TEST_PREFIX}user-service'})
                CREATE (t3:Team {id: '${TEST_URN_PREFIX}team:platform-team', name: '${TEST_PREFIX}platform-team'})
                CREATE (t3)-[:OWNS]->(s3)
                CREATE (f3:Function {id: '${TEST_URN_PREFIX}function:user-service:createUser', name: '${TEST_PREFIX}createUser', filepath: 'user-service/src/handlers/users.ts'})
                CREATE (s3)-[:CONTAINS]->(f3)
                CREATE (f3)-[:WRITES]->(users)
                
                // An ambiguous match
                CREATE (other:MessageChannel {id: '${TEST_URN_PREFIX}channel:users', name: '${TEST_PREFIX}users'})
                
                // Unrelated node to test filtering
                CREATE (unrelated:DataContainer {id: '${TEST_URN_PREFIX}datacontainer:products', name: '${TEST_PREFIX}products'})
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

    describe('resolveResource', () => {
        it('should return multiple matches for ambiguous names', async () => {
            const matches = await resolveResource(`${TEST_PREFIX}users`);
            expect(matches).toHaveLength(2);
            
            const urns = matches.map(m => m.urn).sort();
            expect(urns).toEqual([`${TEST_URN_PREFIX}channel:users`, `${TEST_URN_PREFIX}datacontainer:users`]);
            
            const types = matches.map(m => m.type).sort();
            expect(types).toEqual(['DataContainer', 'MessageChannel']);
        });

        it('should return a single match for an exact unique name', async () => {
            const matches = await resolveResource(`${TEST_PREFIX}products`);
            expect(matches).toHaveLength(1);
            expect(matches[0].urn).toBe(`${TEST_URN_PREFIX}datacontainer:products`);
            expect(matches[0].type).toBe('DataContainer');
        });

        it('should return a single match for an exact URN even if name is ambiguous', async () => {
            const matches = await resolveResource(`${TEST_URN_PREFIX}datacontainer:users`);
            expect(matches).toHaveLength(1);
            expect(matches[0].urn).toBe(`${TEST_URN_PREFIX}datacontainer:users`);
            expect(matches[0].name).toBe(`${TEST_PREFIX}users`);
            expect(matches[0].type).toBe('DataContainer');
        });

        it('should return empty array for non-existent resources', async () => {
            const matches = await resolveResource(`${TEST_PREFIX}does-not-exist`);
            expect(matches).toHaveLength(0);
        });
    });

    describe('analyzeBlast', () => {
        it('should correctly calculate upstream and downstream impact for a resource', async () => {
            const result = await analyzeBlast(`${TEST_URN_PREFIX}datacontainer:users`);

            expect(result.target).toEqual({
                urn: `${TEST_URN_PREFIX}datacontainer:users`,
                name: `${TEST_PREFIX}users`,
                type: 'DataContainer'
            });

            // Expected Downstream: order-service, notification-service
            expect(result.downstreamBlasts).toHaveLength(2);
            
            const downstreamNames = result.downstreamBlasts.map(i => i.serviceName).sort();
            expect(downstreamNames).toEqual([`${TEST_PREFIX}notification-service`, `${TEST_PREFIX}order-service`]);

            const orderSvc = result.downstreamBlasts.find(i => i.serviceName === `${TEST_PREFIX}order-service`)!;
            expect(orderSvc.teamOwner).toBe(`${TEST_PREFIX}checkout-team`);
            expect(orderSvc.relationships).toContain('READS');
            expect(orderSvc.functions).toContainEqual({ name: `${TEST_PREFIX}getOrders`, file: 'order-service/src/handlers/orders.ts' });

            const notifSvc = result.downstreamBlasts.find(i => i.serviceName === `${TEST_PREFIX}notification-service`)!;
            expect(notifSvc.teamOwner).toBe(`${TEST_PREFIX}comms-team`);
            const fnNames = notifSvc.functions.map(f => f.name).sort();
            expect(fnNames).toEqual([`${TEST_PREFIX}checkUserPrefs`, `${TEST_PREFIX}sendEmail`]);
            expect(notifSvc.functions).toContainEqual({ name: `${TEST_PREFIX}checkUserPrefs`, file: 'notification-service/src/consumers/prefs.ts' });

            // Expected Upstream: user-service
            expect(result.upstreamBlasts).toHaveLength(1);
            expect(result.upstreamBlasts[0].serviceName).toBe(`${TEST_PREFIX}user-service`);
            expect(result.upstreamBlasts[0].teamOwner).toBe(`${TEST_PREFIX}platform-team`);
            expect(result.upstreamBlasts[0].relationships).toContain('WRITES');
            expect(result.upstreamBlasts[0].functions).toContainEqual({ name: `${TEST_PREFIX}createUser`, file: 'user-service/src/handlers/users.ts' });

            // Summary verify. Score is now derived from topology.ts gravityScore
            // (see `tests/unit/graph/gravity-score.test.ts` for the calibrated formula);
            // the integration test only asserts that wiring populates a positive value
            // for a resource with confirmed downstream + upstream impact.
            expect(result.summary.blastRadiusScore).toBeGreaterThan(0);
            expect(result.summary.factors.crossTeamBlast).toBe(true);
            expect(result.summary.factors.downstreamServices).toBe(2);
            expect(result.summary.factors.upstreamServices).toBe(1);
            expect(result.summary.factors.hasWriteDependencies).toBe(true);
            expect(result.summary.teamsInvolved.sort()).toEqual([`${TEST_PREFIX}checkout-team`, `${TEST_PREFIX}comms-team`, `${TEST_PREFIX}platform-team`]);
        });

        it('should throw an error if URN is not found', async () => {
            await expect(analyzeBlast('cr://datacontainer/missing')).rejects.toThrow('Resource with URN cr://datacontainer/missing not found');
        });
    });
});
