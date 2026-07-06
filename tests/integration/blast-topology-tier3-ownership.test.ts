/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Integration — Blast topology Tier-3 ownership (Repository fallback)
 *
 * Regression for the acme-monolith case: a single-service (non-monorepo) repo
 * where the Service neither CONTAINS the Function directly (Tier 1) nor OWNS
 * the SourceFile (Tier 2). The only link is:
 *
 *   Service -STORED_IN-> Repository -CONTAINS-> SourceFile -CONTAINS-> Function -[io]-> Infra
 *
 * Such a Service used to show ZERO connected IO in the Blast Explorer because
 * getTopologyMap() resolved a Function to its parent Service only via Tier 1 /
 * Tier 2. Tier 3 salvages this, GUARDED by "the repo hosts exactly one
 * Service", so a genuine monorepo never attributes a loose file to every one
 * of its services.
 *
 * Pure graph DB. Deterministic. No LLM.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { getTopologyMap } from '../../src/graph/queries/topology.js';

const TOKEN = 'tier3probe';

// Single-service repo (the acme-monolith shape)
const MONO_REPO = `cr:repository:acme/${TOKEN}-mono`;
const MONO_SVC = `cr:service:acme/${TOKEN}-mono:mono`;
const MONO_SF = `cr:sourcefile:acme/${TOKEN}-mono:src/orders.php`;
const MONO_FN = `cr:function:acme/${TOKEN}-mono:src/orders.php::place`;
const MONO_DB = `cr:datastore:acme/${TOKEN}-mono:ordersdb`;

// Multi-service repo (the monorepo guard case)
const MULTI_REPO = `cr:repository:acme/${TOKEN}-multi`;
const MULTI_SVC_A = `cr:service:acme/${TOKEN}-multi:svc-a`;
const MULTI_SVC_B = `cr:service:acme/${TOKEN}-multi:svc-b`;
const MULTI_SF = `cr:sourcefile:acme/${TOKEN}-multi:src/loose.php`;
const MULTI_FN = `cr:function:acme/${TOKEN}-multi:src/loose.php::run`;
const MULTI_DB = `cr:datastore:acme/${TOKEN}-multi:multidb`;

async function wipe() {
    const s = getNeo4jSession();
    try {
        await s.run(`MATCH (n) WHERE n.id CONTAINS $tok DETACH DELETE n`, { tok: TOKEN });
    } finally {
        await s.close();
    }
}

async function cy(cypher: string, params: Record<string, unknown> = {}) {
    const s = getNeo4jSession();
    try {
        await s.run(cypher, params);
    } finally {
        await s.close();
    }
}

describe('Blast topology — Tier 3 Repository ownership fallback', () => {
    beforeAll(async () => {
        await initSchema({ silent: true });
        await wipe();

        // ── Single-service repo: Service only reachable via Repository chain ──
        await cy(`CREATE (r:Repository {id:$id, name:'mono', valid_to_commit:null})`, { id: MONO_REPO });
        await cy(`CREATE (s:Service {id:$id, name:'mono', valid_to_commit:null})`, { id: MONO_SVC });
        await cy(`CREATE (sf:SourceFile {id:$id, name:'orders.php', path:'src/orders.php', valid_to_commit:null})`, { id: MONO_SF });
        await cy(`CREATE (f:Function {id:$id, name:'place', filepath:'src/orders.php', startLine:1, valid_to_commit:null})`, { id: MONO_FN });
        await cy(`CREATE (d:Datastore {id:$id, name:'ordersdb', valid_to_commit:null})`, { id: MONO_DB });
        await cy(`MATCH (s:Service {id:$s}),(r:Repository {id:$r}) CREATE (s)-[:STORED_IN {valid_to_commit:null}]->(r)`, { s: MONO_SVC, r: MONO_REPO });
        await cy(`MATCH (r:Repository {id:$r}),(sf:SourceFile {id:$sf}) CREATE (r)-[:CONTAINS {valid_to_commit:null}]->(sf)`, { r: MONO_REPO, sf: MONO_SF });
        await cy(`MATCH (sf:SourceFile {id:$sf}),(f:Function {id:$f}) CREATE (sf)-[:CONTAINS {valid_to_commit:null}]->(f)`, { sf: MONO_SF, f: MONO_FN });
        await cy(`MATCH (f:Function {id:$f}),(d:Datastore {id:$d}) CREATE (f)-[:WRITES {valid_to_commit:null}]->(d)`, { f: MONO_FN, d: MONO_DB });

        // ── Multi-service repo: orphan Function, two services on the repo ──
        await cy(`CREATE (r:Repository {id:$id, name:'multi', valid_to_commit:null})`, { id: MULTI_REPO });
        await cy(`CREATE (a:Service {id:$id, name:'svc-a', valid_to_commit:null})`, { id: MULTI_SVC_A });
        await cy(`CREATE (b:Service {id:$id, name:'svc-b', valid_to_commit:null})`, { id: MULTI_SVC_B });
        await cy(`CREATE (sf:SourceFile {id:$id, name:'loose.php', path:'src/loose.php', valid_to_commit:null})`, { id: MULTI_SF });
        await cy(`CREATE (f:Function {id:$id, name:'run', filepath:'src/loose.php', startLine:1, valid_to_commit:null})`, { id: MULTI_FN });
        await cy(`CREATE (d:Datastore {id:$id, name:'multidb', valid_to_commit:null})`, { id: MULTI_DB });
        await cy(`MATCH (a:Service {id:$s}),(r:Repository {id:$r}) CREATE (a)-[:STORED_IN {valid_to_commit:null}]->(r)`, { s: MULTI_SVC_A, r: MULTI_REPO });
        await cy(`MATCH (b:Service {id:$s}),(r:Repository {id:$r}) CREATE (b)-[:STORED_IN {valid_to_commit:null}]->(r)`, { s: MULTI_SVC_B, r: MULTI_REPO });
        await cy(`MATCH (r:Repository {id:$r}),(sf:SourceFile {id:$sf}) CREATE (r)-[:CONTAINS {valid_to_commit:null}]->(sf)`, { r: MULTI_REPO, sf: MULTI_SF });
        await cy(`MATCH (sf:SourceFile {id:$sf}),(f:Function {id:$f}) CREATE (sf)-[:CONTAINS {valid_to_commit:null}]->(f)`, { sf: MULTI_SF, f: MULTI_FN });
        await cy(`MATCH (f:Function {id:$f}),(d:Datastore {id:$d}) CREATE (f)-[:WRITES {valid_to_commit:null}]->(d)`, { f: MULTI_FN, d: MULTI_DB });
    });

    afterAll(async () => {
        await wipe();
        await closeNeo4j();
    });

    it('Tier 3: a single-service repo surfaces its Function IO under the Service', async () => {
        const topo = await getTopologyMap();
        expect(topo.nodes[MONO_SVC]).toBeDefined();
        const out = topo.out[MONO_SVC] ?? [];
        expect(out.some(e => e.target === MONO_DB && e.rel === 'WRITES')).toBe(true);
    });

    it('Tier 3 guard: a multi-service repo does NOT attribute the orphan Function to any service', async () => {
        const topo = await getTopologyMap();
        const aOut = topo.out[MULTI_SVC_A] ?? [];
        const bOut = topo.out[MULTI_SVC_B] ?? [];
        expect(aOut.some(e => e.target === MULTI_DB && e.rel === 'WRITES')).toBe(false);
        expect(bOut.some(e => e.target === MULTI_DB && e.rel === 'WRITES')).toBe(false);
    });
});
