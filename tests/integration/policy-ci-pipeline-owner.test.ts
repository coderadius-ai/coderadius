import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { loadPolicies, getBuiltinPacksDir } from '../../src/policy-runner/loader.js';
import { executeRules } from '../../src/policy-runner/executor.js';
import { closeSandbox } from '../../src/policy-runner/sandbox.js';
import type { PolicyRuleResult } from '../../src/policy-runner/types.js';

// Regression guard for the agent-readiness pack's owner-topology assumption.
//
// The HAS_CI_PIPELINE / OWNS shortcut signals are stamped on the StructuralFile's
// OWNER, which is either the Repository OR a Service stored in it (see
// createShortcutEdge in src/ingestion/structural/queries.ts). A single-service repo
// catalogued via Backstage anchors its .gitlab-ci.yml on the Service, so the
// pipeline hangs off the Service, not the Repository.
//
// The original ar-tests-present query rooted only on (r:Repository)-[:HAS_CI_PIPELINE]->,
// so a Service-owned pipeline produced a false `fail` even when a test stage existed.
// ar-codeowners had the mirror gap: it only saw Team->Service ownership and missed a
// Team that OWNS the Repository directly (orphan repos materialised by the alias resolver).
//
// These tests load the SHIPPED YAML rules and run them through the real executor +
// sandbox, so they pin both the query text and the Memgraph-side behaviour.

const PFX = 'cr:test:ar-pack';
const PACK = path.join(getBuiltinPacksDir(), 'agent-readiness');

async function wipe() {
    const s = getNeo4jSession();
    try {
        await s.run(
            `MATCH (n)
             WHERE (n:Repository OR n:Service OR n:CIPipeline OR n:Team)
               AND n.id STARTS WITH $p
             DETACH DELETE n`,
            { p: PFX },
        );
    } finally {
        await s.close();
    }
}

async function runRule(file: string): Promise<PolicyRuleResult> {
    const rules = await loadPolicies({ rulesPath: path.join(PACK, file) });
    expect(rules).toHaveLength(1);
    const results = await executeRules(rules);
    return results[0];
}

/** Map seeded repo id -> evaluated status, ignoring repos from other tests/real data. */
function statusById(result: PolicyRuleResult): Map<string, string> {
    const m = new Map<string, string>();
    for (const e of result.evaluations) {
        if (e.entityId.startsWith(PFX)) m.set(e.entityId, e.status);
    }
    return m;
}

describe('agent-readiness pack: shortcut-edge owner topology', () => {
    beforeAll(async () => { await initSchema({ silent: true }); });
    afterAll(async () => { await wipe(); await closeSandbox(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('ar-tests-present passes when the CI pipeline is owned by the Service, not the Repository', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `
                // A: Service-owned pipeline WITH test stage (the reported false-fail) -> pass
                MERGE (rA:Repository {id: $rA}) SET rA.name = 'svc-owned-with-tests'
                MERGE (sA:Service {id: $sA}) SET sA.name = 'svc-a'
                MERGE (sA)-[:STORED_IN]->(rA)
                MERGE (pA:CIPipeline {id: $pA}) SET pA.name = '.gitlab-ci.yml', pA.hasTestStage = true
                MERGE (sA)-[:HAS_CI_PIPELINE]->(pA)

                // B: Repository-owned pipeline WITH test stage -> pass (pre-existing path still works)
                MERGE (rB:Repository {id: $rB}) SET rB.name = 'repo-owned-with-tests'
                MERGE (pB:CIPipeline {id: $pB}) SET pB.name = '.gitlab-ci.yml', pB.hasTestStage = true
                MERGE (rB)-[:HAS_CI_PIPELINE]->(pB)

                // C: Service-owned pipeline WITHOUT a test stage -> fail (true negative preserved)
                MERGE (rC:Repository {id: $rC}) SET rC.name = 'svc-owned-no-tests'
                MERGE (sC:Service {id: $sC}) SET sC.name = 'svc-c'
                MERGE (sC)-[:STORED_IN]->(rC)
                MERGE (pC:CIPipeline {id: $pC}) SET pC.name = '.gitlab-ci.yml', pC.hasTestStage = false
                MERGE (sC)-[:HAS_CI_PIPELINE]->(pC)

                // D: no pipeline at all -> fail
                MERGE (rD:Repository {id: $rD}) SET rD.name = 'no-pipeline'
                `,
                {
                    rA: `${PFX}:ci:repo-a`, sA: `${PFX}:ci:svc-a`, pA: `${PFX}:ci:pipe-a`,
                    rB: `${PFX}:ci:repo-b`, pB: `${PFX}:ci:pipe-b`,
                    rC: `${PFX}:ci:repo-c`, sC: `${PFX}:ci:svc-c`, pC: `${PFX}:ci:pipe-c`,
                    rD: `${PFX}:ci:repo-d`,
                },
            );
        } finally {
            await s.close();
        }

        const result = await runRule('ar-tests-present.yaml');
        expect(result.ok).toBe(true); // query is valid Cypher against Memgraph

        const status = statusById(result);
        expect(status.get(`${PFX}:ci:repo-a`)).toBe('pass'); // the fix: Service-owned counts
        expect(status.get(`${PFX}:ci:repo-b`)).toBe('pass'); // regression guard: Repository-owned
        expect(status.get(`${PFX}:ci:repo-c`)).toBe('fail'); // pipeline without test stage
        expect(status.get(`${PFX}:ci:repo-d`)).toBe('fail'); // no pipeline
    });

    it('ar-codeowners passes when a Team OWNS the Repository directly, not only via a Service', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `
                // A: Team -> Service -> Repository (pre-existing path) -> pass
                MERGE (rA:Repository {id: $rA}) SET rA.name = 'team-via-service'
                MERGE (sA:Service {id: $sA}) SET sA.name = 'svc-a'
                MERGE (sA)-[:STORED_IN]->(rA)
                MERGE (tA:Team {id: $tA}) SET tA.name = 'team-a'
                MERGE (tA)-[:OWNS]->(sA)

                // B: Team OWNS the Repository directly (orphan repo via alias resolver) -> pass
                MERGE (rB:Repository {id: $rB}) SET rB.name = 'team-direct'
                MERGE (tB:Team {id: $tB}) SET tB.name = 'team-b'
                MERGE (tB)-[:OWNS]->(rB)

                // C: no team ownership at all -> fail
                MERGE (rC:Repository {id: $rC}) SET rC.name = 'no-team'
                `,
                {
                    rA: `${PFX}:co:repo-a`, sA: `${PFX}:co:svc-a`, tA: `${PFX}:co:team-a`,
                    rB: `${PFX}:co:repo-b`, tB: `${PFX}:co:team-b`,
                    rC: `${PFX}:co:repo-c`,
                },
            );
        } finally {
            await s.close();
        }

        const result = await runRule('ar-codeowners.yaml');
        expect(result.ok).toBe(true); // EXISTS{} subquery is valid against Memgraph

        const status = statusById(result);
        expect(status.get(`${PFX}:co:repo-a`)).toBe('pass'); // team via service
        expect(status.get(`${PFX}:co:repo-b`)).toBe('pass'); // the fix: team owns repo directly
        expect(status.get(`${PFX}:co:repo-c`)).toBe('fail'); // no ownership
    });
});
