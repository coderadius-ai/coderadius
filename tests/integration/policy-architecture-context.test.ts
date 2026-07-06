import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { loadPolicies, getBuiltinPacksDir } from '../../src/policy-runner/loader.js';
import { executeRules } from '../../src/policy-runner/executor.js';
import { closeSandbox } from '../../src/policy-runner/sandbox.js';
import type { PolicyRuleResult } from '../../src/policy-runner/types.js';

// Deterministic, anonymised reproduction of the architectural-context ladder the
// GTM "context grounding" diagnostic asserts:
//   NO:      agent configs exist but none describe the architecture
//   PARTIAL: architecture notes present, but ungrounded (no analysis / no MCP).
//            Within PARTIAL we further split INTERNAL-only architecture (the
//            "blind to the blast radius" wedge) from CROSS-SERVICE topology.
//   OK:      full code analysis plus the coderadius MCP configured (the live
//            grounding link; a static doc does not count)
// Loads the SHIPPED YAML through the real loader + executor + sandbox, so it
// pins both the query text and the Memgraph-side behaviour.

const PFX = 'cr:test:ar-arch';
const PACK = path.join(getBuiltinPacksDir(), 'agent-readiness');

async function wipe() {
    const s = getNeo4jSession();
    try {
        await s.run(
            `MATCH (n)
             WHERE (n:Repository OR n:Service OR n:AgenticConfig)
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

function byId(result: PolicyRuleResult): Map<string, { status: string; detail: string }> {
    const m = new Map<string, { status: string; detail: string }>();
    for (const e of result.evaluations) {
        if (e.entityId.startsWith(PFX)) m.set(e.entityId, { status: e.status, detail: e.detail });
    }
    return m;
}

describe('agent-readiness: ar-architecture-context 3-level ladder', () => {
    beforeAll(async () => { await initSchema({ silent: true }); });
    afterAll(async () => { await wipe(); await closeSandbox(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('grades NO / PARTIAL / OK and rejects look-alike MCP names', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `
                // NO-a: no agent config at all -> fail
                MERGE (r1:Repository {id: $r1}) SET r1.name = 'no-configs'

                // NO-b: configs present, none about architecture -> fail
                MERGE (r2:Repository {id: $r2}) SET r2.name = 'configs-no-arch'
                MERGE (c2:AgenticConfig {id: $c2}) SET c2.configType = 'rule', c2.topics = 'testing,security'
                MERGE (r2)-[:HAS_AGENTIC_CONFIG]->(c2)

                // PARTIAL-a: arch notes but only a structural scan -> fail
                MERGE (r3:Repository {id: $r3}) SET r3.name = 'arch-no-analysis', r3.scanMode = 'structure'
                MERGE (c3:AgenticConfig {id: $c3}) SET c3.configType = 'rule', c3.topics = 'architecture,testing'
                MERGE (r3)-[:HAS_AGENTIC_CONFIG]->(c3)

                // PARTIAL-b (WEDGE): INTERNAL-only architecture + full analysis, no
                // grounding link -> fail with the "blind to the blast radius" detail.
                MERGE (r4:Repository {id: $r4}) SET r4.name = 'arch-no-link', r4.scanMode = 'semantic'
                MERGE (c4:AgenticConfig {id: $c4}) SET c4.configType = 'rule', c4.topics = 'architecture'
                MERGE (r4)-[:HAS_AGENTIC_CONFIG]->(c4)

                // OK: full analysis + coderadius MCP configured -> pass
                MERGE (r5:Repository {id: $r5}) SET r5.name = 'ok-mcp', r5.scanMode = 'semantic'
                MERGE (c5:AgenticConfig {id: $c5}) SET c5.configType = 'mcp_config', c5.mcpServers = 'coderadius,github'
                MERGE (r5)-[:HAS_AGENTIC_CONFIG]->(c5)

                // GUARD: a look-alike MCP name must NOT count as a link -> fail
                MERGE (r6:Repository {id: $r6}) SET r6.name = 'mcp-lookalike', r6.scanMode = 'semantic'
                MERGE (c6:AgenticConfig {id: $c6}) SET c6.configType = 'mcp_config', c6.mcpServers = 'my-coderadius-proxy'
                MERGE (r6)-[:HAS_AGENTIC_CONFIG]->(c6)

                // CROSS-REPO: context that DOES document cross-service topology,
                // full analysis, but no grounding link -> fail with a distinct detail.
                // topics has ONLY 'cross-repo-architecture' (no 'architecture'), pinning
                // that archConfigs counts cross-repo topics as architectural context.
                MERGE (r7:Repository {id: $r7}) SET r7.name = 'cross-repo-no-link', r7.scanMode = 'semantic'
                MERGE (c7:AgenticConfig {id: $c7}) SET c7.configType = 'rule', c7.topics = 'cross-repo-architecture'
                MERGE (r7)-[:HAS_AGENTIC_CONFIG]->(c7)
                `,
                {
                    r1: `${PFX}:r1`,
                    r2: `${PFX}:r2`, c2: `${PFX}:c2`,
                    r3: `${PFX}:r3`, c3: `${PFX}:c3`,
                    r4: `${PFX}:r4`, c4: `${PFX}:c4`,
                    r5: `${PFX}:r5`, c5: `${PFX}:c5`,
                    r6: `${PFX}:r6`, c6: `${PFX}:c6`,
                    r7: `${PFX}:r7`, c7: `${PFX}:c7`,
                },
            );
        } finally {
            await s.close();
        }

        const result = await runRule('ar-architecture-context.yaml');
        expect(result.ok).toBe(true); // query is valid Cypher against Memgraph
        const m = byId(result);

        expect(m.get(`${PFX}:r1`)?.status).toBe('fail');
        expect(m.get(`${PFX}:r1`)?.detail).toContain('No agent context files');

        expect(m.get(`${PFX}:r2`)?.status).toBe('fail');
        expect(m.get(`${PFX}:r2`)?.detail).toContain('none mention architecture');

        expect(m.get(`${PFX}:r3`)?.status).toBe('fail');
        expect(m.get(`${PFX}:r3`)?.detail).toContain('not analyzed');

        expect(m.get(`${PFX}:r4`)?.status).toBe('fail');
        // internal-only architecture, analyzed, no MCP -> the cross-service wedge
        expect(m.get(`${PFX}:r4`)?.detail).toContain('blind to the blast radius');

        expect(m.get(`${PFX}:r5`)?.status).toBe('pass');
        expect(m.get(`${PFX}:r5`)?.detail).toContain('MCP configured');

        // The sales wedge: a hand-written-looking proxy name is NOT grounding.
        // It must not pass, and falls back to the NO tier.
        expect(m.get(`${PFX}:r6`)?.status).toBe('fail');
        expect(m.get(`${PFX}:r6`)?.detail).toContain('none mention architecture');

        // Cross-service topology IS documented (analyzed, no MCP) -> distinct detail,
        // and it is NOT mis-graded as "none mention architecture".
        expect(m.get(`${PFX}:r7`)?.status).toBe('fail');
        expect(m.get(`${PFX}:r7`)?.detail).toContain('document cross-repo architecture');
    });

    it('counts a dual-attached config once, and honours Service-path attachment', async () => {
        const s = getNeo4jSession();
        try {
            await s.run(
                `
                // DEDUP: one config reachable via BOTH the direct and Service path.
                // archConfigs/totalConfigs must count it once -> "1 context file(s)".
                MERGE (rD:Repository {id: $rD}) SET rD.name = 'dual-attached', rD.scanMode = 'structure'
                MERGE (sD:Service {id: $sD}) SET sD.name = 'svc-d'
                MERGE (sD)-[:STORED_IN]->(rD)
                MERGE (cD:AgenticConfig {id: $cD}) SET cD.configType = 'rule', cD.topics = 'architecture'
                MERGE (rD)-[:HAS_AGENTIC_CONFIG]->(cD)
                MERGE (sD)-[:HAS_AGENTIC_CONFIG]->(cD)

                // OWNER-TOPOLOGY: OK link attached only via the Service, not the repo.
                MERGE (rE:Repository {id: $rE}) SET rE.name = 'svc-path-ok', rE.scanMode = 'semantic'
                MERGE (sE:Service {id: $sE}) SET sE.name = 'svc-e'
                MERGE (sE)-[:STORED_IN]->(rE)
                MERGE (cE:AgenticConfig {id: $cE}) SET cE.configType = 'mcp_config', cE.mcpServers = 'coderadius'
                MERGE (sE)-[:HAS_AGENTIC_CONFIG]->(cE)
                `,
                {
                    rD: `${PFX}:rD`, sD: `${PFX}:sD`, cD: `${PFX}:cD`,
                    rE: `${PFX}:rE`, sE: `${PFX}:sE`, cE: `${PFX}:cE`,
                },
            );
        } finally {
            await s.close();
        }

        const result = await runRule('ar-architecture-context.yaml');
        expect(result.ok).toBe(true);
        const m = byId(result);

        expect(m.get(`${PFX}:rD`)?.status).toBe('fail');
        expect(m.get(`${PFX}:rD`)?.detail).toContain('1 context file(s)'); // counted once, not twice

        expect(m.get(`${PFX}:rE`)?.status).toBe('pass'); // Service-path link reaches OK
        expect(m.get(`${PFX}:rE`)?.detail).toContain('MCP configured');
    });
});
