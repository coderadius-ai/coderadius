import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    listPersistedPolicyRules,
    countEvaluationsForRules,
    deletePolicyRulesAndEvaluations,
} from '../../src/policy-runner/reporter.js';

// Graph ops behind `cr policy prune`. Deleting a rule must take its
// PolicyEvaluation results with it, and must leave unrelated rules untouched.

const PFX = 'crtest-prune';

describe('policy prune graph ops', () => {
    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (n) WHERE (n:PolicyRule OR n:PolicyEvaluation) AND n.id STARTS WITH $p DETACH DELETE n`,
                { p: PFX },
            );
        } finally {
            await s.close();
        }
    }

    async function seed() {
        const s = getNeo4jSession();
        try {
            await s.run(
                `
                MERGE (rt:PolicyRule {id: $target}) SET rt.name = 'Target', rt.tags = ['crtest']
                MERGE (rk:PolicyRule {id: $keep})   SET rk.name = 'Keep',   rk.tags = ['crtest']
                MERGE (e1:PolicyEvaluation {id: $e1}) SET e1.ruleId = $target, e1.tags = 'crtest'
                MERGE (e2:PolicyEvaluation {id: $e2}) SET e2.ruleId = $target, e2.tags = 'crtest'
                MERGE (ek:PolicyEvaluation {id: $ek}) SET ek.ruleId = $keep,   ek.tags = 'crtest'
                `,
                {
                    target: `${PFX}-target`, keep: `${PFX}-keep`,
                    e1: `${PFX}-eval-1`, e2: `${PFX}-eval-2`, ek: `${PFX}-eval-keep`,
                },
            );
        } finally {
            await s.close();
        }
    }

    async function idsPresent(label: 'PolicyRule' | 'PolicyEvaluation'): Promise<Set<string>> {
        const s = getNeo4jSession();
        try {
            const res = await s.run(
                `MATCH (n:${label}) WHERE n.id STARTS WITH $p RETURN n.id AS id`,
                { p: PFX },
            );
            return new Set(res.records.map(r => r.get('id') as string));
        } finally {
            await s.close();
        }
    }

    beforeAll(async () => { await initSchema({ silent: true }); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); await seed(); });

    it('listPersistedPolicyRules returns rule id + tags', async () => {
        const seeded = (await listPersistedPolicyRules()).filter(r => r.id.startsWith(PFX));
        expect(seeded.map(r => r.id).sort()).toEqual([`${PFX}-keep`, `${PFX}-target`]);
        expect(seeded.find(r => r.id === `${PFX}-target`)!.tags).toEqual(['crtest']);
    });

    it('countEvaluationsForRules counts validations per rule', async () => {
        const counts = await countEvaluationsForRules([`${PFX}-target`, `${PFX}-keep`]);
        expect(counts[`${PFX}-target`]).toBe(2);
        expect(counts[`${PFX}-keep`]).toBe(1);
    });

    it('deletePolicyRulesAndEvaluations removes the rule + its validations, leaving others', async () => {
        const result = await deletePolicyRulesAndEvaluations([`${PFX}-target`]);
        expect(result).toEqual({ rules: 1, evaluations: 2 });

        const rules = await idsPresent('PolicyRule');
        expect(rules.has(`${PFX}-target`)).toBe(false); // pruned
        expect(rules.has(`${PFX}-keep`)).toBe(true);    // untouched

        const evals = await idsPresent('PolicyEvaluation');
        expect(evals.has(`${PFX}-eval-1`)).toBe(false);
        expect(evals.has(`${PFX}-eval-2`)).toBe(false);
        expect(evals.has(`${PFX}-eval-keep`)).toBe(true); // belongs to the kept rule
    });
});
