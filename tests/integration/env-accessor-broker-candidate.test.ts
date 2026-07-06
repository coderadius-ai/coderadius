import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    buildRepoEnvMap,
    synthesizeBrokerCandidateHints,
} from '../../src/ingestion/processors/connection-extractors/env-var-resolver.js';
import {
    scanCodeReferencedEnvVars,
    clearCodeEnvVarCache,
} from '../../src/ingestion/processors/connection-extractors/code-env-scanner.js';
import {
    scanCodeAccessorEnvVars,
    clearAccessorScanCache,
} from '../../src/ingestion/processors/connection-extractors/env-accessor-scanner.js';
import { extractAllPhysicalHints } from '../../src/ingestion/processors/connection-extractors/registry.js';
import {
    mergeBrokerCandidate,
    bindBrokerCandidates,
} from '../../src/graph/mutations/broker-candidates.js';
import { getEnvAccessors, loadRepoHints, clearRepoHintsCache } from '../../src/config/repo-hints.js';

// ═══════════════════════════════════════════════════════════════════════════
// Declared env-accessor wrappers (coderadius.yaml `envAccessors`) — the
// "wrapper blinds the whole infra tier" pin.
//
// Fixture shape (acme-orders): every env read goes through
// `EnvVault::fetch('KEY', 'literal-default')`; ONE plain getenv('APP_DEBUG')
// exists, which is the lethal configuration — the code-referenced filter
// turns ON with an incomplete set and silently drops every helm/compose key
// the wrapper actually reads. With the accessor declared:
//   - wrapper keys become code-referenced (filter survives them)
//   - literal defaults feed the env map as the weakest source
//   - RABBITMQ_HOST reaches the broker s3 lane (NEVER claimed)
//   - MYSQL_HOST/MYSQL_DATABASE reach the datastore trio (claimed as usual)
// ═══════════════════════════════════════════════════════════════════════════

const REPO = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/acme-secret-wrapper/acme-orders',
);
const PFX = 'cr://test/env-accessor/';
const COMMIT = 'TEST';

describe('declared env accessors → env map → broker candidate', () => {
    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await s.run(`MATCH (b:MessageBroker) WHERE b.host CONTAINS 'acme-prod.consul' DETACH DELETE b`);
            await s.run(
                `MATCH (c:BrokerCandidate) WHERE c.serviceUrn STARTS WITH $p OR c.host CONTAINS 'acme-prod.consul' DETACH DELETE c`,
                { p: PFX },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => {
        await wipe();
        clearCodeEnvVarCache();
        clearAccessorScanCache();
        clearRepoHintsCache();
    });

    it('REPRODUCES the bug: without the accessor, the filter is ON-but-incomplete and the broker key vanishes', () => {
        const codeReferenced = scanCodeReferencedEnvVars(REPO); // no accessors
        expect(codeReferenced.has('APP_DEBUG')).toBe(true);     // filter turns ON…
        expect(codeReferenced.has('RABBITMQ_HOST')).toBe(false); // …but misses wrapper keys

        const env = buildRepoEnvMap(REPO, {
            codeReferencedFilter: codeReferenced.size > 0 ? codeReferenced : undefined,
        });
        expect(env.vars.has('RABBITMQ_HOST')).toBe(false);      // helm value dropped
        expect(synthesizeBrokerCandidateHints(env)).toHaveLength(0);
    });

    it('with the declared accessor: helm value survives the filter and hits the s3 lane; datastore keys stay claimed', () => {
        const accessors = getEnvAccessors(loadRepoHints(REPO));
        expect(accessors).toHaveLength(1);

        const codeReferenced = scanCodeReferencedEnvVars(REPO, accessors);
        expect(codeReferenced.has('RABBITMQ_HOST')).toBe(true);

        const { claimedEnvKeys } = extractAllPhysicalHints(REPO);
        expect(claimedEnvKeys.has('MYSQL_HOST')).toBe(true);      // datastore: claimed
        expect(claimedEnvKeys.has('RABBITMQ_HOST')).toBe(false);  // broker: NEVER claimed

        const env = buildRepoEnvMap(REPO, {
            codeReferencedFilter: codeReferenced,
            accessorDefaults: scanCodeAccessorEnvVars(REPO, accessors).defaults,
        });
        // helm wins over the accessor default (first-writer-wins)
        expect(env.vars.get('RABBITMQ_HOST')?.value).toBe('mq.acme-prod.consul');

        const hints = synthesizeBrokerCandidateHints(env, { claimedEnvKeys });
        expect(hints).toHaveLength(1);
        expect(hints[0]!.provider).toBe('rabbitmq');
        expect(hints[0]!.host).toBe('mq.acme-prod.consul');
        // The DB host never leaks into the broker lane.
        expect(hints.some((h) => h.host === 'db.acme-prod.internal')).toBe(false);
    });

    it('accessor defaults ground the datastore identity when no manifest declares it', () => {
        const { hints, claimedEnvKeys } = extractAllPhysicalHints(REPO);
        const mysql = hints.find((h) => h.technology === 'mysql');
        expect(mysql).toBeDefined();
        expect(mysql!.host).toBe('db.acme-prod.internal');   // from the literal default
        expect(mysql!.dbName).toBe('orders');
        expect(claimedEnvKeys.has('MYSQL_DATABASE')).toBe(true);
    });

    it('graph leg: the wrapper-read broker key mints a needsReview broker via the s3 residual path', async () => {
        const svc = `${PFX}svc/orders`;
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (sv:Service {id: $id}) SET sv.name = 'orders', sv.valid_from_commit = 'TEST', sv.valid_to_commit = null`,
                { id: svc },
            );
        } finally { await s.close(); }

        const accessors = getEnvAccessors(loadRepoHints(REPO));
        const codeReferenced = scanCodeReferencedEnvVars(REPO, accessors);
        const { claimedEnvKeys } = extractAllPhysicalHints(REPO);
        const env = buildRepoEnvMap(REPO, {
            codeReferencedFilter: codeReferenced,
            accessorDefaults: scanCodeAccessorEnvVars(REPO, accessors).defaults,
        });
        const hints = synthesizeBrokerCandidateHints(env, { claimedEnvKeys });
        await mergeBrokerCandidate({ serviceUrn: svc, repoUrn: 'acme/acme-orders', ...hints[0]! }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.createdGuess).toBe(1);

        const sess = getNeo4jSession();
        try {
            const brokers = await sess.run(
                `MATCH (b:MessageBroker) WHERE b.host CONTAINS 'acme-prod.consul'
                 RETURN b.id AS id, b.provider AS provider, b.needsReview AS needsReview`,
            );
            expect(brokers.records).toHaveLength(1);
            expect(brokers.records[0]!.get('provider')).toBe('rabbitmq');
            expect(brokers.records[0]!.get('needsReview')).toBe(true);

            const connects = await sess.run(
                `MATCH (sv:Service {id: $svc})-[:CONNECTS_TO]->(b:MessageBroker) RETURN b.id AS id`,
                { svc },
            );
            expect(connects.records).toHaveLength(1);
        } finally { await sess.close(); }
    });
});
