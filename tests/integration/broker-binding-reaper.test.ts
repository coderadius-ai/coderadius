import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeMessageBroker,
    linkServiceConnectsToBroker,
} from '../../src/graph/mutations/data-contracts.js';
import { reapStaleEnvVarBrokerBindings } from '../../src/graph/mutations/broker-candidates.js';
import { astGrounding } from '../../src/graph/grounding.js';

// ═════════════════════════════════════════════════════════════════════════════
// Env-var binding reaper (C3) — triple guard:
//   1. source='env-var' ONLY (config / channel-convergence untouched)
//   2. only Services of the repos analyzed in THIS run
//   3. graph-only runs skip entirely (empty repo list → no-op)
// Staleness marker is the per-run `lastSeenRun` (runMarker), NOT a commit
// hash (every reconcile caller passes commitHash='SYSTEM').
// ═════════════════════════════════════════════════════════════════════════════

const COMMIT = 'REAPER_TEST';
const HOST_FRAGMENT = 'reaper-test.acme.example';
const REPO_A = 'crtest/reaper-repo-a';
const REPO_B = 'crtest/reaper-repo-b';
const SVC_A = `cr:service:${REPO_A}:orders-app`;
const SVC_B = `cr:service:${REPO_B}:billing-app`;
const BROKER = 'cr:broker:rabbitmq:reaper01:acme';

async function wipeFixture() {
    const session = getNeo4jSession();
    try {
        await session.run('MATCH (s:Service) WHERE s.id STARTS WITH $a OR s.id STARTS WITH $b DETACH DELETE s',
            { a: `cr:service:${REPO_A}:`, b: `cr:service:${REPO_B}:` });
        await session.run('MATCH (b:MessageBroker) WHERE b.host CONTAINS $h DETACH DELETE b', { h: HOST_FRAGMENT });
    } finally { await session.close(); }
}

async function createService(urn: string, name: string) {
    const session = getNeo4jSession();
    try {
        await session.run(
            `CREATE (s:Service {id: $id}) SET s.name = $name, s.valid_from_commit = $c, s.valid_to_commit = null`,
            { id: urn, name, c: COMMIT },
        );
    } finally { await session.close(); }
}

async function edgeState(serviceUrn: string, source: string): Promise<{ tombstoned: boolean } | null> {
    const session = getNeo4jSession();
    try {
        const r = await session.run(
            `MATCH (s:Service {id: $svc})-[rel:CONNECTS_TO {source: $source}]->(b:MessageBroker {id: $broker})
             RETURN rel.valid_to_commit AS vtc`,
            { svc: serviceUrn, source, broker: BROKER },
        );
        if (r.records.length === 0) return null;
        return { tombstoned: r.records[0].get('vtc') !== null };
    } finally { await session.close(); }
}

describe('reapStaleEnvVarBrokerBindings — triple guard', () => {
    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });

    beforeEach(async () => {
        await wipeFixture();
        await createService(SVC_A, 'orders-app');
        await createService(SVC_B, 'billing-app');
        await mergeMessageBroker({
            urn: BROKER, provider: 'rabbitmq', fingerprint: 'reaper01',
            declaredVia: 'inferred', host: `bus.${HOST_FRAGMENT}`, port: 5672, vhost: 'acme',
            fingerprintScope: 'global',
            grounding: astGrounding('test-setup@v1'),
        }, COMMIT);
    });

    it('tombstones a stale env-var edge of an analyzed repo; a re-stamped edge survives', async () => {
        // Old run stamped run-0001 on SVC_A's edge; the current run (run-0002)
        // re-stamps it. A second edge never re-stamped (legacy, no marker)
        // simulates the nginx/sftp leftovers.
        await linkServiceConnectsToBroker(SVC_A, BROKER, 'RABBITMQ_HOST', COMMIT, { runMarker: 'run-0002' });
        const session = getNeo4jSession();
        try {
            // Legacy edge on SVC_B (same repo list) with NO marker at all.
            await session.run(
                `MATCH (s:Service {id: $svc}), (b:MessageBroker {id: $broker})
                 CREATE (s)-[:CONNECTS_TO {source: 'env-var', valid_from_commit: $c, valid_to_commit: null}]->(b)`,
                { svc: SVC_B, broker: BROKER, c: COMMIT },
            );
        } finally { await session.close(); }

        const reaped = await reapStaleEnvVarBrokerBindings('run-0002', [REPO_A, REPO_B], COMMIT);
        expect(reaped).toBe(1);

        expect(await edgeState(SVC_A, 'env-var')).toEqual({ tombstoned: false });
        expect(await edgeState(SVC_B, 'env-var')).toEqual({ tombstoned: true });
    });

    it('does NOT touch edges of repos NOT analyzed in this run', async () => {
        await linkServiceConnectsToBroker(SVC_B, BROKER, 'RABBITMQ_HOST', COMMIT, { runMarker: 'run-OLD' });

        const reaped = await reapStaleEnvVarBrokerBindings('run-NEW', [REPO_A], COMMIT);
        expect(reaped).toBe(0);
        expect(await edgeState(SVC_B, 'env-var')).toEqual({ tombstoned: false });
    });

    it('graph-only guard: empty repo list is a hard no-op', async () => {
        await linkServiceConnectsToBroker(SVC_A, BROKER, 'RABBITMQ_HOST', COMMIT, { runMarker: 'run-OLD' });

        const reaped = await reapStaleEnvVarBrokerBindings('run-NEW', [], COMMIT);
        expect(reaped).toBe(0);
        expect(await edgeState(SVC_A, 'env-var')).toEqual({ tombstoned: false });
    });

    it('config and channel-convergence edges are NEVER touched, even when stale', async () => {
        await linkServiceConnectsToBroker(SVC_A, BROKER, null, COMMIT, { sourceType: 'config', runMarker: 'run-OLD' });
        await linkServiceConnectsToBroker(SVC_A, BROKER, null, COMMIT, { sourceType: 'channel-convergence' });

        const reaped = await reapStaleEnvVarBrokerBindings('run-NEW', [REPO_A], COMMIT);
        expect(reaped).toBe(0);
        expect(await edgeState(SVC_A, 'config')).toEqual({ tombstoned: false });
        expect(await edgeState(SVC_A, 'channel-convergence')).toEqual({ tombstoned: false });
    });

    it('idempotent: a second reap with the same marker finds nothing new', async () => {
        const session = getNeo4jSession();
        try {
            await session.run(
                `MATCH (s:Service {id: $svc}), (b:MessageBroker {id: $broker})
                 CREATE (s)-[:CONNECTS_TO {source: 'env-var', valid_from_commit: $c, valid_to_commit: null}]->(b)`,
                { svc: SVC_A, broker: BROKER, c: COMMIT },
            );
        } finally { await session.close(); }

        expect(await reapStaleEnvVarBrokerBindings('run-X', [REPO_A], COMMIT)).toBe(1);
        expect(await reapStaleEnvVarBrokerBindings('run-X', [REPO_A], COMMIT)).toBe(0);
    });
});
