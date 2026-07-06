import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { resolveDataField, analyzeLineage } from '../../src/graph/queries/lineage.js';

describe('Data Lineage Analyzer Service', () => {

    beforeAll(async () => {
        // 1. Wipe graph
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) DETACH DELETE n');
        } finally {
            await session.close();
        }

        await initSchema();

        // 2. Insert multi-service topology with shared DataFields
        //
        // Scenario:
        //   user-service: createUser PRODUCES UserPayload(email, name)
        //                 createUser PUBLISHES_TO user.created (MessageChannel)
        //
        //   notification-service: sendWelcome LISTENS_TO user.created (MessageChannel)
        //                         sendWelcome CONSUMES UserEvent(email, timestamp)
        //
        // Expected lineage for "email":
        //   createUser (PRODUCES) → user.created → sendWelcome (CONSUMES)
        //   Semantic gate passes because both UserPayload and UserEvent have "email"
        //
        // Expected lineage for "timestamp":
        //   sendWelcome (CONSUMES) only — no upstream match (UserPayload has no "timestamp")
        //
        const populateSession = getNeo4jSession();
        try {
            await populateSession.run(`
                // ── Services ──
                CREATE (s1:Service {id: 'cr://service/user-service', name: 'user-service'})
                CREATE (s2:Service {id: 'cr://service/notification-service', name: 'notification-service'})

                // ── Functions ──
                CREATE (f1:Function {id: 'cr://function/user-service/createUser', name: 'createUser', filepath: 'src/user.ts', language: 'typescript', startLine: 1, endLine: 10})
                CREATE (f2:Function {id: 'cr://function/notification-service/sendWelcome', name: 'sendWelcome', filepath: 'src/notify.ts', language: 'typescript', startLine: 1, endLine: 10})

                // ── Service → Function ownership ──
                CREATE (s1)-[:CONTAINS]->(f1)
                CREATE (s2)-[:CONTAINS]->(f2)

                // ── DataStructures (schemas) ──
                CREATE (ds1:DataStructure {id: 'cr://schema/message_payload/UserPayload', name: 'UserPayload', type: 'message_payload'})
                CREATE (ds2:DataStructure {id: 'cr://schema/message_payload/UserEvent', name: 'UserEvent', type: 'message_payload'})

                // ── DataFields ──
                CREATE (df1a:DataField {id: 'cr://schema/message_payload/UserPayload/field/email', name: 'email', type: 'string', required: true})
                CREATE (df1b:DataField {id: 'cr://schema/message_payload/UserPayload/field/name', name: 'name', type: 'string', required: true})
                CREATE (df2a:DataField {id: 'cr://schema/message_payload/UserEvent/field/email', name: 'email', type: 'string', required: true})
                CREATE (df2b:DataField {id: 'cr://schema/message_payload/UserEvent/field/timestamp', name: 'timestamp', type: 'number', required: true})

                // ── DataStructure → DataField ──
                CREATE (ds1)-[:HAS_FIELD]->(df1a)
                CREATE (ds1)-[:HAS_FIELD]->(df1b)
                CREATE (ds2)-[:HAS_FIELD]->(df2a)
                CREATE (ds2)-[:HAS_FIELD]->(df2b)

                // ── Function → DataStructure ──
                CREATE (f1)-[:PRODUCES]->(ds1)
                CREATE (f2)-[:CONSUMES]->(ds2)

                // ── Infrastructure (MessageChannel) ──
                CREATE (broker:MessageChannel {id: 'cr://channel/user.created', name: 'user.created'})
                CREATE (f1)-[:PUBLISHES_TO]->(broker)
                CREATE (f2)-[:LISTENS_TO]->(broker)

                // ── Isolated field (no lineage path) ──
                CREATE (ds3:DataStructure {id: 'cr://schema/message_payload/OrphanPayload', name: 'OrphanPayload', type: 'message_payload'})
                CREATE (df3:DataField {id: 'cr://schema/message_payload/OrphanPayload/field/orphan', name: 'orphan', type: 'string', required: false})
                CREATE (ds3)-[:HAS_FIELD]->(df3)
            `);
        } finally {
            await populateSession.close();
        }
    });

    afterAll(async () => {
        await closeNeo4j();
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // resolveDataField
    // ═══════════════════════════════════════════════════════════════════════════

    describe('resolveDataField', () => {
        it('should return multiple matches for ambiguous field names', async () => {
            const matches = await resolveDataField('email');
            expect(matches.length).toBeGreaterThanOrEqual(2);

            const urns = matches.map(m => m.urn).sort();
            expect(urns).toContain('cr://schema/message_payload/UserPayload/field/email');
            expect(urns).toContain('cr://schema/message_payload/UserEvent/field/email');
        });

        it('should return a single match for an exact URN', async () => {
            const matches = await resolveDataField('cr://schema/message_payload/UserPayload/field/email');
            expect(matches).toHaveLength(1);
            expect(matches[0].urn).toBe('cr://schema/message_payload/UserPayload/field/email');
            expect(matches[0].name).toBe('email');
            expect(matches[0].structureName).toBe('UserPayload');
        });

        it('should return empty array for non-existent fields', async () => {
            const matches = await resolveDataField('does-not-exist-field');
            expect(matches).toHaveLength(0);
        });

        it('should include owning service context when available', async () => {
            const matches = await resolveDataField('cr://schema/message_payload/UserPayload/field/email');
            expect(matches[0].serviceName).toBe('user-service');
        });

        it('should support fuzzy matching', async () => {
            const matches = await resolveDataField('mail'); // partial match to "email"
            expect(matches.length).toBeGreaterThanOrEqual(1);
            expect(matches.some(m => m.name === 'email')).toBe(true);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // analyzeLineage
    // ═══════════════════════════════════════════════════════════════════════════

    describe('analyzeLineage', () => {
        it('should trace "email" across two services with semantic gate', async () => {
            const result = await analyzeLineage('cr://schema/message_payload/UserPayload/field/email');

            expect(result.targetField).toEqual({
                urn: 'cr://schema/message_payload/UserPayload/field/email',
                name: 'email',
                structure: 'UserPayload',
            });

            // Should have at least 2 hops: createUser (PRODUCES) → sendWelcome (CONSUMES)
            expect(result.journey.length).toBeGreaterThanOrEqual(2);

            const serviceNames = result.journey.map(j => j.serviceName);
            expect(serviceNames).toContain('user-service');
            expect(serviceNames).toContain('notification-service');

            const createUserStep = result.journey.find(j => j.functionName === 'createUser');
            expect(createUserStep).toBeDefined();
            expect(createUserStep!.action).toBe('PRODUCES');
            expect(createUserStep!.bridgeResource?.name).toBe('user.created');

            const sendWelcomeStep = result.journey.find(j => j.functionName === 'sendWelcome');
            expect(sendWelcomeStep).toBeDefined();
            expect(sendWelcomeStep!.action).toBe('CONSUMES');

            // Summary
            expect(result.summary.servicesTraversed).toBe(2);
            expect(result.summary.requiresDeepScan).toBe(false);
        });

        it('should return only one hop for "timestamp" (no upstream semantic match)', async () => {
            const result = await analyzeLineage('cr://schema/message_payload/UserEvent/field/timestamp');

            expect(result.targetField.name).toBe('timestamp');

            // Only sendWelcome should appear — createUser's UserPayload has no "timestamp" field
            expect(result.journey.length).toBe(1);
            expect(result.journey[0].functionName).toBe('sendWelcome');
            expect(result.journey[0].serviceName).toBe('notification-service');
        });

        it('should return empty journey for orphaned field', async () => {
            const result = await analyzeLineage('cr://schema/message_payload/OrphanPayload/field/orphan');

            expect(result.targetField.name).toBe('orphan');
            expect(result.journey).toHaveLength(0);
            expect(result.summary.totalHops).toBe(0);
            expect(result.summary.requiresDeepScan).toBe(true);
        });

        it('should throw an error if URN does not exist', async () => {
            await expect(
                analyzeLineage('cr://schema/message_payload/Missing/field/missing')
            ).rejects.toThrow('DataField with URN');
        });
    });
});
