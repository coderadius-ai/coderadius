import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { weldEmergentToCanonical } from '../../src/graph/mutations/api-contracts.js';

describe('weldEmergentToCanonical — edge property carry-over', () => {
    const PFX = 'cr://test/weld-edge-carryover/';
    const COMMIT = 'WELD_CARRYOVER_TEST';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally { await session.close(); }
    }

    async function createFn(urn: string, name: string) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (f:Function {id: $id})
                 SET f.name = $name, f.valid_from_commit = $c, f.valid_to_commit = null`,
                { id: urn, name, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    async function createEndpoint(urn: string, props: Record<string, unknown>) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `CREATE (ep:APIEndpoint {id: $id})
                 SET ep += $props, ep.valid_from_commit = $c, ep.valid_to_commit = null`,
                { id: urn, props, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    async function callsWithProps(fnUrn: string, epUrn: string, props: Record<string, unknown>) {
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (f:Function {id: $fid}), (ep:APIEndpoint {id: $eid})
                 CREATE (f)-[r:CALLS]->(ep)
                 SET r += $props, r.valid_from_commit = $c, r.valid_to_commit = null`,
                { fid: fnUrn, eid: epUrn, props, c: COMMIT },
            );
        } finally { await session.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    it('preserves observedBaseUrl / observedEnvironment / declaredBy on the canonical CALLS edge', async () => {
        const fnUrn = `${PFX}function:caller`;
        const emergentEp = `${PFX}endpoint:emergent:POST:/orders`;
        const canonicalEp = `${PFX}endpoint:canonical:POST:/orders`;

        await createFn(fnUrn, 'callOrders');
        await createEndpoint(emergentEp, { method: 'POST', path: '/orders', epSource: 'emergent' });
        await createEndpoint(canonicalEp, { method: 'POST', path: '/orders', epSource: 'openapi' });

        // Emergent CALLS edge with caller-side metadata (set by graph-writer in Fix #5 Step 3)
        await callsWithProps(fnUrn, emergentEp, {
            observedBaseUrl: 'https://api.acme.example.com/v2',
            observedEnvironment: 'production',
            declaredBy: 'env-var',
        });

        await weldEmergentToCanonical(emergentEp, canonicalEp, {
            weldedBy: 'url-exact',
            weldConfidence: 'exact',
            commitHash: COMMIT,
        });

        const session = getNeo4jSession();
        try {
            // Canonical CALLS edge has the carried-over metadata
            const r1 = await session.run(
                `MATCH (f:Function {id: $fid})-[rel:CALLS]->(ep:APIEndpoint {id: $eid})
                 RETURN rel.observedBaseUrl AS u, rel.observedEnvironment AS e,
                        rel.declaredBy AS d, rel.weldedBy AS wb, rel.weldConfidence AS wc,
                        rel.valid_to_commit AS vt`,
                { fid: fnUrn, eid: canonicalEp },
            );
            expect(r1.records).toHaveLength(1);
            const row = r1.records[0];
            expect(row.get('u')).toBe('https://api.acme.example.com/v2');
            expect(row.get('e')).toBe('production');
            expect(row.get('d')).toBe('env-var');
            expect(row.get('wb')).toBe('url-exact');
            expect(row.get('wc')).toBe('exact');
            expect(row.get('vt')).toBeNull();

            // Old emergent CALLS edge removed
            const r2 = await session.run(
                `MATCH (f:Function {id: $fid})-[rel:CALLS]->(ep:APIEndpoint {id: $eid})
                 RETURN count(rel) AS n`,
                { fid: fnUrn, eid: emergentEp },
            );
            expect(Number(r2.records[0].get('n'))).toBe(0);

            // Emergent endpoint detached (deleted)
            const r3 = await session.run(
                `MATCH (ep:APIEndpoint {id: $id}) RETURN count(ep) AS n`,
                { id: emergentEp },
            );
            expect(Number(r3.records[0].get('n'))).toBe(0);
        } finally { await session.close(); }
    });

    it('weldedBy/weldConfidence are required: defaults sensible when not passed', async () => {
        // Backwards compat with old callsites that don't pass weldedBy/weldConfidence.
        // The function should still work and set weldedBy=null / weldConfidence=null.
        const fnUrn = `${PFX}function:bc`;
        const emergentEp = `${PFX}endpoint:emergent-bc:POST:/foo`;
        const canonicalEp = `${PFX}endpoint:canonical-bc:POST:/foo`;
        await createFn(fnUrn, 'callBc');
        await createEndpoint(emergentEp, { method: 'POST', path: '/foo', epSource: 'emergent' });
        await createEndpoint(canonicalEp, { method: 'POST', path: '/foo', epSource: 'openapi' });
        await callsWithProps(fnUrn, emergentEp, {});
        // No opts at all (legacy call site)
        await weldEmergentToCanonical(emergentEp, canonicalEp);
        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (:Function {id: $fid})-[rel:CALLS]->(:APIEndpoint {id: $eid})
                 RETURN count(rel) AS n`,
                { fid: fnUrn, eid: canonicalEp },
            );
            expect(Number(r.records[0].get('n'))).toBe(1);
        } finally { await session.close(); }
    });
});
