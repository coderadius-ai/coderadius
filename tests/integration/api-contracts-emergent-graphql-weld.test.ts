import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeAPIInterface,
    mergeAPIEndpoint,
    mergeEmergentGraphQLConsumedAPIInterface,
    mergeEmergentGraphQLEndpoint,
    weldEmergentToCanonical,
} from '../../src/graph/mutations/api-contracts.js';

// ─── Emergent GraphQL outbound → SDL canonical weld ──────────────────────────
//
// Validates the Fix #2 welder enhancement:
//   1. Outbound emergent endpoints anchor under a per-caller :APIInterface
//      via mergeEmergentGraphQLConsumedAPIInterface.
//   2. weldEmergentToCanonical moves both [:CALLS] (function-level) AND
//      [:CONSUMES_API] (service-level) onto the canonical SDL APIInterface.
//   3. The emergent :APIInterface is tombstoned when its last endpoint is
//      welded over.

describe('weldEmergentToCanonical — outbound GraphQL anchoring', () => {
    const PFX = 'cr://test/weld-emergent-graphql/';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            // Emergent graphql endpoints + APIs use deterministic URNs not starting with PFX
            // when their caller URN is itself PFX-scoped (`cr:endpoint:emergent-graphql:cr://test/...`).
            // Defensive: drop any emergent graphql endpoint with our test caller in its id.
            await session.run(
                `MATCH (n) WHERE n.id CONTAINS 'test/weld-emergent-graphql' DETACH DELETE n`,
            );
        } finally {
            await session.close();
        }
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

    async function createFunction(urn: string, serviceUrn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (f:Function {id: $fid})
                 SET f.name = $name, f.valid_from_commit = 'TEST', f.valid_to_commit = null
                 WITH f MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:CONTAINS]->(f)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: urn, sid: serviceUrn, name },
            );
        } finally { await session.close(); }
    }

    async function linkFunctionCalls(fUrn: string, epUrn: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (f:Function {id: $fid}), (ep:APIEndpoint {id: $eid})
                 MERGE (f)-[r:CALLS]->(ep)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: fUrn, eid: epUrn },
            );
        } finally { await session.close(); }
    }

    async function exposeApi(serviceUrn: string, apiUrn: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (s:Service {id: $sid}), (api:APIInterface {id: $aid})
                 MERGE (s)-[r:EXPOSES_API]->(api)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { sid: serviceUrn, aid: apiUrn },
            );
        } finally { await session.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    it('moves CALLS + CONSUMES_API from emergent → canonical and tombstones empty emergent API', async () => {
        // ── Caller side: PHP service that emits one emergent GQL outbound endpoint
        const callerSvcUrn = `${PFX}service:caller`;
        const callerFnUrn = `${PFX}function:caller:initOrder`;
        await createService(callerSvcUrn, 'caller');
        await createFunction(callerFnUrn, callerSvcUrn, 'initOrder');

        const emergentApiUrn = await mergeEmergentGraphQLConsumedAPIInterface(
            callerSvcUrn, 'InitOrderDoc', 'COMMIT_A',
        );
        const emergentEpUrn = await mergeEmergentGraphQLEndpoint(
            emergentApiUrn, 'MUTATION', 'initOrder', 'COMMIT_A', 'InitOrderDoc',
        );
        await linkFunctionCalls(callerFnUrn, emergentEpUrn);

        // ── Provider side: TS service exposing the SDL canonical endpoint
        const providerSvcUrn = `${PFX}service:provider`;
        const canonicalApiUrn = `${PFX}api:provider:graphql-sdl`;
        const canonicalEpUrn = `${PFX}endpoint:provider:graphql:MUTATION:initOrder`;
        await createService(providerSvcUrn, 'provider');
        await mergeAPIInterface(canonicalApiUrn, 'Provider SDL', '1.0.0', 'COMMIT_A', 'sdl');
        await exposeApi(providerSvcUrn, canonicalApiUrn);
        await mergeAPIEndpoint(
            canonicalApiUrn, canonicalEpUrn, '/graphql', null,
            'initOrder', 'SDL initOrder', null, 'COMMIT_A', 'graphql',
        );

        // ── Pre-weld sanity
        const session = getNeo4jSession();
        try {
            const pre = await session.run(
                `MATCH (s:Service {id: $sid})-[:CONSUMES_API]->(api:APIInterface)
                 RETURN api.id AS id ORDER BY api.id`,
                { sid: callerSvcUrn },
            );
            expect(pre.records.map(r => r.get('id'))).toEqual([emergentApiUrn]);
        } finally { await session.close(); }

        // ── Weld
        await weldEmergentToCanonical(emergentEpUrn, canonicalEpUrn);

        // ── Post-weld assertions
        const post = getNeo4jSession();
        try {
            // (1) Caller function now CALLS the canonical endpoint
            const r1 = await post.run(
                `MATCH (f:Function {id: $fid})-[:CALLS]->(ep:APIEndpoint)
                 RETURN ep.id AS id`,
                { fid: callerFnUrn },
            );
            expect(r1.records.map(r => r.get('id'))).toEqual([canonicalEpUrn]);

            // (2) Caller service now CONSUMES_API the canonical APIInterface
            const r2 = await post.run(
                `MATCH (s:Service {id: $sid})-[:CONSUMES_API]->(api:APIInterface)
                 RETURN api.id AS id ORDER BY api.id`,
                { sid: callerSvcUrn },
            );
            expect(r2.records.map(r => r.get('id'))).toEqual([canonicalApiUrn]);

            // (3) Emergent endpoint is gone
            const r3 = await post.run(
                `MATCH (ep:APIEndpoint {id: $id}) RETURN count(ep) AS n`,
                { id: emergentEpUrn },
            );
            expect(Number(r3.records[0].get('n'))).toBe(0);

            // (4) Emergent APIInterface is gone (no more endpoints → tombstoned by Step 3)
            const r4 = await post.run(
                `MATCH (api:APIInterface {id: $id}) RETURN count(api) AS n`,
                { id: emergentApiUrn },
            );
            expect(Number(r4.records[0].get('n'))).toBe(0);

            // (5) The new CONSUMES_API carries the welded_from provenance
            const r5 = await post.run(
                `MATCH (:Service {id: $sid})-[rel:CONSUMES_API]->(:APIInterface {id: $aid})
                 RETURN rel.welded_from AS w`,
                { sid: callerSvcUrn, aid: canonicalApiUrn },
            );
            expect(r5.records[0].get('w')).toBe(emergentApiUrn);
        } finally { await post.close(); }
    });

    it('leaves emergent APIInterface alive when other endpoints under it remain', async () => {
        // Two emergent endpoints under the same caller's emergent APIInterface;
        // only one welds. The APIInterface must survive Step 3 (not tombstoned).
        const callerSvcUrn = `${PFX}service:caller-multi`;
        const callerFnUrn = `${PFX}function:caller-multi:fn`;
        await createService(callerSvcUrn, 'caller-multi');
        await createFunction(callerFnUrn, callerSvcUrn, 'fn');

        const emergentApiUrn = await mergeEmergentGraphQLConsumedAPIInterface(
            callerSvcUrn, 'MultiDoc', 'COMMIT_A',
        );
        const epA = await mergeEmergentGraphQLEndpoint(emergentApiUrn, 'MUTATION', 'initOrder', 'COMMIT_A', 'MultiDoc');
        const epB = await mergeEmergentGraphQLEndpoint(emergentApiUrn, 'QUERY', 'order', 'COMMIT_A', 'MultiDoc');
        await linkFunctionCalls(callerFnUrn, epA);
        await linkFunctionCalls(callerFnUrn, epB);

        // Provider exposes only the initOrder canonical
        const providerSvcUrn = `${PFX}service:provider-multi`;
        const canonicalApiUrn = `${PFX}api:provider-multi:graphql-sdl`;
        const canonicalEpUrn = `${PFX}endpoint:provider-multi:graphql:MUTATION:initOrder`;
        await createService(providerSvcUrn, 'provider-multi');
        await mergeAPIInterface(canonicalApiUrn, 'Provider SDL', '1.0.0', 'COMMIT_A', 'sdl');
        await exposeApi(providerSvcUrn, canonicalApiUrn);
        await mergeAPIEndpoint(
            canonicalApiUrn, canonicalEpUrn, '/graphql', null,
            'initOrder', 'SDL initOrder', null, 'COMMIT_A', 'graphql',
        );

        // Weld only ep A
        await weldEmergentToCanonical(epA, canonicalEpUrn);

        const post = getNeo4jSession();
        try {
            // Emergent APIInterface SURVIVES because epB still hangs off it
            const r1 = await post.run(
                `MATCH (api:APIInterface {id: $id}) RETURN count(api) AS n`,
                { id: emergentApiUrn },
            );
            expect(Number(r1.records[0].get('n'))).toBe(1);

            // Caller now has BOTH CONSUMES_API edges (still emergent for epB, plus canonical for the welded epA)
            const r2 = await post.run(
                `MATCH (:Service {id: $sid})-[:CONSUMES_API]->(api:APIInterface)
                 RETURN api.id AS id ORDER BY api.id`,
                { sid: callerSvcUrn },
            );
            const ids = r2.records.map(r => r.get('id') as string).sort();
            expect(ids).toContain(emergentApiUrn);
            expect(ids).toContain(canonicalApiUrn);
        } finally { await post.close(); }
    });
});
