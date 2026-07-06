import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { ingestStructural } from '../../src/ingestion/structural/plugin-manager.js';
import { runReconcile } from '../../src/ingestion/workflows/reconcile.workflow.js';
import { clearMessageBrokerRegistry } from '../../src/ingestion/core/messaging/broker-registry.js';
import { silentReporter } from '../../src/ingestion/core/progress.js';
import { mergeRepositoriesBatch } from '../../src/graph/mutations/code-graph.js';
import {
    mergeMessageChannelWithKind,
    linkFunctionPublishesTo,
    linkFunctionListensTo,
} from '../../src/graph/mutations/data-contracts.js';
import { astGrounding } from '../../src/graph/grounding.js';
import type { ResolvedRepo } from '../../src/graph/types.js';

// ═════════════════════════════════════════════════════════════════════════════
// Order-independence guarantee: ingesting code-first then infra-first must
// produce the SAME final graph state.
//
// Models the two real flows:
//   A) `cr analyze code` first → user drops `definitions.json` later
//       → `cr analyze infra` (which runs reconcile at the end).
//   B) `cr analyze infra` first → `cr analyze code` later (already runs
//       reconcile at the end).
//
// Both must converge: same MessageChannel count + same brokerUrn binding +
// same technology stamped + same edge count after reconcile.
// ═════════════════════════════════════════════════════════════════════════════

const REPO_NAME = 'acme/order-independence-fixture';
const PFX = 'cr://test/order-independence/';
const COMMIT = 'ORDER_TEST';
const CHANNEL_NAME = 'acme.order.created';

function writeAcmeInfraFixture(root: string): void {
    fs.mkdirSync(path.join(root, 'rabbitmq'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'rabbitmq/definitions.json'),
        JSON.stringify({
            exchanges: [
                { name: 'acme.orders', vhost: '/prod', type: 'topic', durable: true, auto_delete: false },
            ],
            queues: [
                { name: CHANNEL_NAME, vhost: '/prod', durable: true, auto_delete: false },
            ],
            bindings: [
                {
                    source: 'acme.orders',
                    destination: CHANNEL_NAME,
                    destination_type: 'queue',
                    routing_key: CHANNEL_NAME,
                    vhost: '/prod',
                },
            ],
        }, null, 2),
        'utf-8',
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: REPO_NAME, version: '1.0.0' }), 'utf-8');
}

async function seedCodeSidePublisher(): Promise<void> {
    // Simulates what `cr analyze code` would write: a Service whose Function
    // publishes to a topic-kind logical channel with the same canonical name
    // as the queue declared in the infra fixture. After reconcile, the
    // cross-kind dedup must merge them into a single canonical channel.
    const s = getNeo4jSession();
    try {
        await s.run(
            `CREATE (svc:Service {id: $sid})
             SET svc.name = 'order-publisher', svc.valid_from_commit = $c, svc.valid_to_commit = null`,
            { sid: `${PFX}service:order-publisher`, c: COMMIT },
        );
        await s.run(
            `MATCH (svc:Service {id: $sid})
             CREATE (fn:Function {id: $fid})
             SET fn.name = 'publish', fn.valid_from_commit = $c, fn.valid_to_commit = null
             MERGE (svc)-[r:CONTAINS]->(fn)
             ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
            { sid: `${PFX}service:order-publisher`, fid: `${PFX}function:publish`, c: COMMIT },
        );
    } finally { await s.close(); }
    const topicUrn = await mergeMessageChannelWithKind(
        CHANNEL_NAME, 'topic', 'symfony-messenger', COMMIT,
        { scope: 'physical', confidence: 0.7, grounding: astGrounding('order-test-setup@v1') },
    );
    await linkFunctionPublishesTo(`${PFX}function:publish`, topicUrn, COMMIT, {
        grounding: astGrounding('order-test-setup@v1'),
    });
}

async function snapshotGraph(): Promise<{
    channels: Array<{ name: string; kind: string; tech: string | null; scope: string | null; brokerUrn: string | null }>;
    brokers: Array<{ provider: string; vhost: string | null }>;
    routesTo: number;
    publishesTo: number;
}> {
    const s = getNeo4jSession();
    try {
        const channels = await s.run(
            `MATCH (ch:MessageChannel)
             WHERE ch.valid_to_commit IS NULL AND ch.name = $name
             RETURN ch.name AS name, ch.channelKind AS kind, ch.technology AS tech, ch.scope AS scope, ch.brokerUrn AS brokerUrn
             ORDER BY ch.id`,
            { name: CHANNEL_NAME },
        );
        const brokers = await s.run(
            `MATCH (b:MessageBroker)
             WHERE b.valid_to_commit IS NULL AND b.provider = 'rabbitmq' AND b.vhost = '/prod'
             RETURN b.provider AS provider, b.vhost AS vhost
             ORDER BY b.id`,
        );
        const routes = await s.run(
            `MATCH (:MessageChannel)-[r:ROUTES_TO]->(dest:MessageChannel)
             WHERE r.valid_to_commit IS NULL AND dest.name = $name
             RETURN count(r) AS n`,
            { name: CHANNEL_NAME },
        );
        const pubs = await s.run(
            `MATCH (:Function)-[r:PUBLISHES_TO]->(ch:MessageChannel)
             WHERE r.valid_to_commit IS NULL AND ch.name = $name
             RETURN count(r) AS n`,
            { name: CHANNEL_NAME },
        );
        return {
            channels: channels.records.map(rec => ({
                name: rec.get('name') as string,
                kind: rec.get('kind') as string,
                tech: rec.get('tech') as string | null,
                scope: rec.get('scope') as string | null,
                brokerUrn: rec.get('brokerUrn') as string | null,
            })),
            brokers: brokers.records.map(rec => ({
                provider: rec.get('provider') as string,
                vhost: rec.get('vhost') as string | null,
            })),
            routesTo: Number(routes.records[0].get('n')),
            publishesTo: Number(pubs.records[0].get('n')),
        };
    } finally { await s.close(); }
}

describe('order-independence: code-first vs infra-first reconcile to the same state', () => {
    let fixtureDir: string;
    let repo: ResolvedRepo;

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run(`MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n`, { p: PFX });
            await s.run(`MATCH (r:Repository {id: $id}) DETACH DELETE r`, { id: `cr:repository:${REPO_NAME}` });
            await s.run(`MATCH (b:MessageBroker) WHERE b.provider = 'rabbitmq' AND b.vhost = '/prod' DETACH DELETE b`);
            await s.run(`MATCH (ch:MessageChannel) WHERE ch.name = $name OR ch.name = 'acme.orders' DETACH DELETE ch`, { name: CHANNEL_NAME });
        } finally { await s.close(); }
    }

    beforeAll(async () => {
        await initSchema({ silent: true });
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-indep-'));
        writeAcmeInfraFixture(fixtureDir);
        repo = { name: REPO_NAME, path: fixtureDir, origin: 'local', commit: COMMIT };
    });

    afterAll(async () => {
        await wipe();
        if (fixtureDir && fs.existsSync(fixtureDir)) {
            fs.rmSync(fixtureDir, { recursive: true, force: true });
        }
        await closeNeo4j();
    });

    beforeEach(async () => {
        clearMessageBrokerRegistry();
        await wipe();
        await mergeRepositoriesBatch([{ name: REPO_NAME, commitHash: COMMIT }]);
    });

    it('code-first then infra-then-reconcile → infra-first then code-then-reconcile produce equivalent graphs', async () => {
        // Order A: code → infra → reconcile.
        await seedCodeSidePublisher();
        await ingestStructural([repo], [], silentReporter, { force: true });
        await runReconcile({ repos: [repo], commitHash: COMMIT });
        const snapshotA = await snapshotGraph();

        // Reset.
        clearMessageBrokerRegistry();
        await wipe();
        await mergeRepositoriesBatch([{ name: REPO_NAME, commitHash: COMMIT }]);

        // Order B: infra → code → reconcile.
        await ingestStructural([repo], [], silentReporter, { force: true });
        await seedCodeSidePublisher();
        await runReconcile({ repos: [repo], commitHash: COMMIT });
        const snapshotB = await snapshotGraph();

        // Invariants that must converge regardless of ingest order.
        expect(snapshotB.brokers).toEqual(snapshotA.brokers);
        expect(snapshotB.channels.length).toBe(snapshotA.channels.length);
        // After reconcile the channel has the same kind, scope, brokerUrn and
        // technology in both orderings (cross-kind dedup collapses the topic
        // and queue into a canonical entity; tech welder stamps `rabbitmq`).
        expect(snapshotB.channels[0].kind).toBe(snapshotA.channels[0].kind);
        expect(snapshotB.channels[0].brokerUrn).toBe(snapshotA.channels[0].brokerUrn);
        expect(snapshotB.channels[0].tech).toBe(snapshotA.channels[0].tech);
        // Edges converge: same routes + same publisher edges.
        expect(snapshotB.routesTo).toBe(snapshotA.routesTo);
        expect(snapshotB.publishesTo).toBe(snapshotA.publishesTo);
    });
});
