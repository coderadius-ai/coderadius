import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeAPIInterface,
    linkServiceConsumesAPI,
    pruneStaleEnvVarAPIs,
} from '../../src/graph/mutations/api-contracts.js';
import { mergeAPIDeployment } from '../../src/graph/mutations/api-deployment.js';
import { astGrounding } from '../../src/graph/grounding.js';
import { buildUrn } from '../../src/graph/urn.js';

describe('env-var API synthesis — APIInterface + APIDeployment + CONSUMES_API', () => {
    const PFX = 'cr://test/env-var-api/';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await session.run(
                `MATCH (n:APIInterface) WHERE n.apiSource = 'env-var' AND n.id STARTS WITH 'cr:api:env-var:' AND n.id CONTAINS 'acme.example.com' DETACH DELETE n`,
            );
            await session.run(
                `MATCH (n:APIDeployment) WHERE n.id CONTAINS 'acme.example.com' DETACH DELETE n`,
            );
        } finally { await session.close(); }
    }

    async function createService(urn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = 'TEST', s.valid_to_commit = null`,
                { id: urn, name },
            );
        } finally { await session.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    it('mergeAPIInterface creates an env-var APIInterface keyed by host', async () => {
        const apiUrn = buildUrn('api', 'env-var', 'orders.acme.example.com');
        const grounding = astGrounding('env-var-http-synth@v1');
        await mergeAPIInterface(apiUrn, 'orders', 'inferred', 'COMMIT_A', 'env-var', 'OUTBOUND', grounding);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (api:APIInterface {id: $id})
                 RETURN api.title AS title, api.apiSource AS apiSource, api.direction AS direction, api.version AS version`,
                { id: apiUrn },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('title')).toBe('orders');
            expect(r.records[0].get('apiSource')).toBe('env-var');
            expect(r.records[0].get('direction')).toBe('OUTBOUND');
            expect(r.records[0].get('version')).toBe('inferred');
        } finally { await session.close(); }
    });

    it('mergeAPIDeployment creates a deployment linked via DEPLOYED_AT', async () => {
        const apiUrn = buildUrn('api', 'env-var', 'orders.acme.example.com');
        const grounding = astGrounding('env-var-http-synth@v1');
        await mergeAPIInterface(apiUrn, 'orders', 'inferred', 'COMMIT_A', 'env-var', 'OUTBOUND', grounding);
        await mergeAPIDeployment({ apiUrn, baseUrl: 'https://orders.acme.example.com/v1', declaredBy: 'inferred', confidence: 'medium', grounding }, 'COMMIT_A');

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (api:APIInterface {id: $id})-[:DEPLOYED_AT]->(d:APIDeployment)
                 RETURN d.declaredBy AS declaredBy, d.confidence AS confidence, d.host AS host`,
                { id: apiUrn },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('declaredBy')).toBe('inferred');
            expect(r.records[0].get('confidence')).toBe('medium');
            expect(r.records[0].get('host')).toBe('orders.acme.example.com');
        } finally { await session.close(); }
    });

    it('linkServiceConsumesAPI creates CONSUMES_API edge with sourceEnvKey', async () => {
        const sUrn = `${PFX}service:caller`;
        await createService(sUrn, 'caller');
        const apiUrn = buildUrn('api', 'env-var', 'payment.acme.example.com');
        const grounding = astGrounding('env-var-http-synth@v1');
        await mergeAPIInterface(apiUrn, 'payment', 'inferred', 'COMMIT_A', 'env-var', 'OUTBOUND', grounding);
        await linkServiceConsumesAPI(sUrn, apiUrn, 'PAYMENT_URL', 'COMMIT_A');

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (s:Service {id: $sid})-[rel:CONSUMES_API]->(api:APIInterface {id: $aid})
                 RETURN rel.sourceEnvKey AS k, rel.source AS src`,
                { sid: sUrn, aid: apiUrn },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('k')).toBe('PAYMENT_URL');
            expect(r.records[0].get('src')).toBe('env-var');
        } finally { await session.close(); }
    });

    it('is idempotent on repeated calls with same host', async () => {
        const apiUrn = buildUrn('api', 'env-var', 'orders.acme.example.com');
        const grounding = astGrounding('env-var-http-synth@v1');
        await mergeAPIInterface(apiUrn, 'orders', 'inferred', 'COMMIT_A', 'env-var', 'OUTBOUND', grounding);
        await mergeAPIInterface(apiUrn, 'orders', 'inferred', 'COMMIT_A', 'env-var', 'OUTBOUND', grounding);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (api:APIInterface) WHERE api.apiSource = 'env-var' AND api.id CONTAINS 'orders.acme.example.com' RETURN count(api) AS n`,
            );
            expect(Number(r.records[0].get('n'))).toBe(1);
        } finally { await session.close(); }
    });

    it('pruneStaleEnvVarAPIs tombstones nodes not re-emitted', async () => {
        const grounding = astGrounding('env-var-http-synth@v1');
        const apiUrn1 = buildUrn('api', 'env-var', 'orders.acme.example.com');
        const apiUrn2 = buildUrn('api', 'env-var', 'payment.acme.example.com');

        await mergeAPIInterface(apiUrn1, 'orders', 'inferred', 'COMMIT_A', 'env-var', 'OUTBOUND', grounding);
        await mergeAPIDeployment({ apiUrn: apiUrn1, baseUrl: 'https://orders.acme.example.com', declaredBy: 'inferred', confidence: 'medium', grounding }, 'COMMIT_A');
        await mergeAPIInterface(apiUrn2, 'payment', 'inferred', 'COMMIT_A', 'env-var', 'OUTBOUND', grounding);
        await mergeAPIDeployment({ apiUrn: apiUrn2, baseUrl: 'https://payment.acme.example.com', declaredBy: 'inferred', confidence: 'medium', grounding }, 'COMMIT_A');

        // Re-emit only apiUrn1 with COMMIT_B
        const grounding2 = astGrounding('env-var-http-synth@v1');
        await mergeAPIInterface(apiUrn1, 'orders', 'inferred', 'COMMIT_B', 'env-var', 'OUTBOUND', grounding2);

        const pruned = await pruneStaleEnvVarAPIs('COMMIT_B');
        expect(pruned).toBe(1);

        const session = getNeo4jSession();
        try {
            const alive = await session.run(
                `MATCH (api:APIInterface) WHERE api.apiSource = 'env-var' AND api.valid_to_commit IS NULL AND api.id CONTAINS 'acme.example.com' RETURN api.id AS id`,
            );
            expect(alive.records).toHaveLength(1);
            expect(alive.records[0].get('id')).toBe(apiUrn1);

            const tombstoned = await session.run(
                `MATCH (api:APIInterface {id: $id}) RETURN api.valid_to_commit AS vt`,
                { id: apiUrn2 },
            );
            expect(tombstoned.records[0].get('vt')).toBe('COMMIT_B');
        } finally { await session.close(); }
    });
});
