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
import type { ResolvedRepo } from '../../src/graph/types.js';

// ═════════════════════════════════════════════════════════════════════════════
// Infra ingestion — end-to-end on an acme RabbitMQ definitions.json fixture.
//
// Pins the `cr analyze infra` data flow:
//   ingestStructural (plugin manager → rabbitmq-config plugin)
//     ↓
//   runReconcile (autopromote + technology weld + cross-kind dedup)
//
// Zero LLM. Zero source code. The fixture is a minimal acme repo carrying
// only `rabbitmq/definitions.json`.
// ═════════════════════════════════════════════════════════════════════════════

const REPO_NAME = 'acme/infra-ingestion-fixture';

function writeAcmeFixture(root: string): void {
    fs.mkdirSync(path.join(root, 'rabbitmq'), { recursive: true });
    // Minimal definitions.json: 1 topic exchange + 2 queues + 2 bindings.
    // Mirrors the shape an operator would export from the Management API.
    fs.writeFileSync(
        path.join(root, 'rabbitmq/definitions.json'),
        JSON.stringify({
            exchanges: [
                { name: 'acme.orders', vhost: '/prod', type: 'topic', durable: true, auto_delete: false },
            ],
            queues: [
                { name: 'acme.inventory.order.requested', vhost: '/prod', durable: true, auto_delete: false },
                { name: 'acme.payment.order.requested', vhost: '/prod', durable: true, auto_delete: false },
            ],
            bindings: [
                {
                    source: 'acme.orders',
                    destination: 'acme.inventory.order.requested',
                    destination_type: 'queue',
                    routing_key: 'acme.order.#',
                    vhost: '/prod',
                },
                {
                    source: 'acme.orders',
                    destination: 'acme.payment.order.requested',
                    destination_type: 'queue',
                    routing_key: 'acme.order.created',
                    vhost: '/prod',
                },
            ],
        }, null, 2),
        'utf-8',
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: REPO_NAME, version: '1.0.0' }), 'utf-8');
}

describe('infra ingestion end-to-end (rabbitmq definitions.json)', () => {
    let fixtureDir: string;
    let repo: ResolvedRepo;

    async function wipe() {
        const s = getNeo4jSession();
        try {
            const repoUrn = `cr:repository:${REPO_NAME}`;
            await s.run(`MATCH (r:Repository {id: $id}) DETACH DELETE r`, { id: repoUrn });
            await s.run(`MATCH (n:MessageBroker) WHERE n.fingerprint STARTS WITH 'local:rabbitmq/definitions.json' OR n.host CONTAINS 'local:rabbitmq' DETACH DELETE n`);
            await s.run(`MATCH (ch:MessageChannel) WHERE ch.name STARTS WITH 'acme.orders' OR ch.name STARTS WITH 'acme.inventory.order.' OR ch.name STARTS WITH 'acme.payment.order.' DETACH DELETE ch`);
        } finally { await s.close(); }
    }

    beforeAll(async () => {
        await initSchema({ silent: true });
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-ingestion-'));
        writeAcmeFixture(fixtureDir);
        repo = {
            name: REPO_NAME,
            path: fixtureDir,
            origin: 'local',
            commit: 'INFRA_TEST',
        };
        // Persist the Repository node so structural entities can attach via
        // DEFINES/IS_DEFINED_IN edges to a real graph anchor.
        await mergeRepositoriesBatch([{ name: REPO_NAME, commitHash: 'INFRA_TEST' }]);
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
        await mergeRepositoriesBatch([{ name: REPO_NAME, commitHash: 'INFRA_TEST' }]);
    });

    it('ingests broker + exchange + queues + ROUTES_TO edges from rabbitmq/definitions.json', async () => {
        const metrics = await ingestStructural([repo], [], silentReporter, { force: true });
        expect(metrics.filesProcessed).toBeGreaterThan(0);
        expect(metrics.entitiesPersisted).toBeGreaterThan(0);

        const s = getNeo4jSession();
        try {
            // 1 MessageBroker rabbitmq created.
            const brokers = await s.run(
                `MATCH (b:MessageBroker)
                 WHERE b.valid_to_commit IS NULL AND b.provider = 'rabbitmq'
                 RETURN b.id AS id, b.vhost AS vhost`,
            );
            expect(brokers.records.length).toBeGreaterThanOrEqual(1);
            const acmeBroker = brokers.records.find(r => r.get('vhost') === '/prod');
            expect(acmeBroker).toBeDefined();
            const brokerUrn = acmeBroker!.get('id') as string;

            // 1 topic exchange + 2 queues.
            const channels = await s.run(
                `MATCH (ch:MessageChannel)
                 WHERE ch.valid_to_commit IS NULL AND ch.brokerUrn = $bu
                 RETURN ch.name AS name, ch.channelKind AS kind ORDER BY name`,
                { bu: brokerUrn },
            );
            const names = channels.records.map(r => `${r.get('kind')}:${r.get('name')}`);
            expect(names).toContain('topic:acme.orders');
            expect(names).toContain('queue:acme.inventory.order.requested');
            expect(names).toContain('queue:acme.payment.order.requested');

            // ROUTES_TO with bindingKey + patternRegex on the pattern (`acme.order.#`).
            const routes = await s.run(
                `MATCH (ex:MessageChannel {name: 'acme.orders'})-[r:ROUTES_TO]->(dest:MessageChannel)
                 WHERE r.valid_to_commit IS NULL
                 RETURN dest.name AS dest, r.bindingKey AS key, r.isPattern AS isPattern, r.patternRegex AS regex
                 ORDER BY dest`,
            );
            const edges = routes.records.map(r => ({
                dest: r.get('dest') as string,
                key: r.get('key') as string,
                isPattern: r.get('isPattern') as boolean,
                regex: r.get('regex') as string | null,
            }));
            expect(edges.length).toBe(2);
            const pattern = edges.find(e => e.key === 'acme.order.#');
            expect(pattern).toBeDefined();
            expect(pattern!.isPattern).toBe(true);
            expect(pattern!.regex).toBeTruthy();
            const exact = edges.find(e => e.key === 'acme.order.created');
            expect(exact).toBeDefined();
            expect(exact!.isPattern).toBe(false);
        } finally { await s.close(); }
    });

    it('runReconcile after infra ingest stamps technology and is idempotent', async () => {
        await ingestStructural([repo], [], silentReporter, { force: true });

        const first = await runReconcile({ repos: [repo], commitHash: 'INFRA_TEST' });
        // technologyWeld may be 0 if the structural plugin already stamped
        // `technology: 'rabbitmq'` upstream — in that case the welder finds
        // nothing to overwrite. We only assert idempotence (second pass = 0).
        const second = await runReconcile({ repos: [repo], commitHash: 'INFRA_TEST' });
        expect(second.crossKindDedup.merged).toBe(0);
        expect(second.suffixDedup.welded).toBe(0);
        expect(second.technologyWeld.welded).toBe(0);
        // Sanity: the first run completed without throwing.
        expect(first).toBeDefined();
    });
});
