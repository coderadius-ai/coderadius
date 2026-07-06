/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Integration — weldDuplicateEmergentEndpoints (S2.1b, cross-function REST dedup)
 *
 * Three functions call what is ONE logical endpoint but landed as three nodes
 * (`/itest-dedup/users/123`, `/456`, `/{userId}`) because emergent endpoints are
 * keyed by lossless path. The dedup pass must collapse them into ONE survivor
 * (the most-templated `/{userId}`), move every inbound CALLS edge onto it, and
 * remove the loser nodes.
 *
 * Requires Memgraph. Wipes are scoped to the `itest-dedup` marker.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeEmergentAPIEndpoint,
    linkFunctionCallsEndpoint,
    weldDuplicateEmergentEndpoints,
} from '../../src/graph/mutations/api-contracts.js';
import { astGrounding } from '../../src/graph/grounding.js';

const MARK = 'itest-dedup';
const COMMIT = 'ITEST_DEDUP_C';

async function wipe() {
    const session = getNeo4jSession();
    try {
        await session.run(`MATCH (ep:APIEndpoint) WHERE ep.path CONTAINS $m DETACH DELETE ep`, { m: MARK });
        await session.run(`MATCH (f:Function) WHERE f.id CONTAINS $m DETACH DELETE f`, { m: MARK });
    } finally { await session.close(); }
}

async function makeFunction(id: string) {
    const session = getNeo4jSession();
    try {
        await session.run(
            `CREATE (f:Function {id: $id}) SET f.name = $id, f.valid_from_commit = 'TEST', f.valid_to_commit = null`,
            { id },
        );
    } finally { await session.close(); }
}

describe('weldDuplicateEmergentEndpoints — cross-function REST dedup', () => {
    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('collapses three path-variants into one templated survivor and moves all CALLS edges', async () => {
        const g = astGrounding('graph-writer@v1');
        const paths = [`/${MARK}/users/123`, `/${MARK}/users/456`, `/${MARK}/users/{userId}`];
        const epUrns: string[] = [];
        for (let i = 0; i < paths.length; i++) {
            const epUrn = await mergeEmergentAPIEndpoint('GET', paths[i], paths[i], COMMIT, g);
            epUrns.push(epUrn);
            const fid = `cr:function:${MARK}:f${i}`;
            await makeFunction(fid);
            await linkFunctionCallsEndpoint(fid, epUrn, COMMIT);
        }

        // Pre-condition: 3 distinct emergent endpoints exist.
        const session = getNeo4jSession();
        try {
            const before = await session.run(
                `MATCH (ep:APIEndpoint) WHERE ep.path CONTAINS $m AND ep.valid_to_commit IS NULL RETURN count(ep) AS n`,
                { m: MARK },
            );
            expect(Number(before.records[0].get('n'))).toBe(3);
        } finally { await session.close(); }

        const welded = await weldDuplicateEmergentEndpoints(COMMIT);
        expect(welded).toBe(2); // two losers collapsed

        const s2 = getNeo4jSession();
        try {
            // Exactly one survivor remains, and it is the templated form.
            const survivors = await s2.run(
                `MATCH (ep:APIEndpoint) WHERE ep.path CONTAINS $m
                 OPTIONAL MATCH (ep)<-[c:CALLS]-(:Function)
                 RETURN ep.path AS path, count(c) AS callers`,
                { m: MARK },
            );
            expect(survivors.records).toHaveLength(1);
            expect(survivors.records[0].get('path')).toBe(`/${MARK}/users/{userId}`);
            // All three functions' CALLS edges were moved onto the survivor.
            expect(Number(survivors.records[0].get('callers'))).toBe(3);
        } finally { await s2.close(); }
    });

    it('is a no-op when there are no duplicates', async () => {
        const g = astGrounding('graph-writer@v1');
        const epUrn = await mergeEmergentAPIEndpoint('GET', `/${MARK}/health`, `/${MARK}/health`, COMMIT, g);
        await makeFunction(`cr:function:${MARK}:solo`);
        await linkFunctionCallsEndpoint(`cr:function:${MARK}:solo`, epUrn, COMMIT);

        const welded = await weldDuplicateEmergentEndpoints(COMMIT);
        expect(welded).toBe(0);
    });
});
