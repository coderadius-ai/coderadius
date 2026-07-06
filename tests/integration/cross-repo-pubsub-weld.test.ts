import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    buildRepoEnvMap,
    synthesizeBrokerCandidateHints,
} from '../../src/ingestion/processors/connection-extractors/env-var-resolver.js';
import {
    mergeBrokerCandidate,
    bindBrokerCandidates,
    gcOrphanBrokerCandidates,
} from '../../src/graph/mutations/broker-candidates.js';
import { mergeMessageBroker } from '../../src/graph/mutations/data-contracts.js';
import { deduplicateMessageChannelsByExactNameDifferentKind } from '../../src/ingestion/processors/dynamic-infra-resolver.js';
import { infraGrounding } from '../../src/graph/grounding.js';

// ═══════════════════════════════════════════════════════════════════════════
// Broker-grounded discovery + cross-service weld — the 2-hop pub/sub pin.
//
// Story under test (all deterministic, zero LLM):
//   repo A (publisher)  carries INVENTORY_MQ_HOSTNAME=mq.acme-internal.consul.
//                       (arbitrary key name, trailing-dot FQDN → s0 candidate)
//   repo B (consumer)   carries NOTIF_BROKER_URL=amqp://...@same-host/inventory
//                       (scheme DSN → s1 candidate, self-anchoring)
//   bindBrokerCandidates() materialises ONE broker, binds BOTH services,
//   and the cross-kind welder then joins topic↔subscription on that shared
//   physical broker → Service A → channel ← Service B (the blast 2-hop).
//
// Guardrails pinned here: a guess never creates a broker alone (s0), value
// convergence corroborates the HOST but never the PROVIDER (a3-guess), and
// the weld only fires across a clean (non-needsReview) shared broker.
// ═══════════════════════════════════════════════════════════════════════════

const FIXTURES = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/acme-broker-discovery',
);
const REPO_A = path.join(FIXTURES, 'acme-inventory');
const REPO_B = path.join(FIXTURES, 'acme-notifications');

const PFX = 'cr://test/xrepo-weld/';
const COMMIT = 'TEST';
const HOST = 'mq.acme-internal.consul';

describe('cross-repo pub/sub: broker candidates → bind → weld', () => {
    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await s.run(
                `MATCH (b:MessageBroker)
                 WHERE b.host CONTAINS 'acme-internal' OR b.host CONTAINS 'acme-orders'
                 DETACH DELETE b`,
            );
            await s.run(
                `MATCH (c:BrokerCandidate)
                 WHERE c.serviceUrn STARTS WITH $p OR c.host CONTAINS 'acme-internal' OR c.host CONTAINS 'acme-orders'
                 DETACH DELETE c`,
                { p: PFX },
            );
        } finally { await s.close(); }
    }

    async function makeService(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = 'TEST', s.valid_to_commit = null`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function makeFunction(id: string, serviceId: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:Function {id: $id})
                 SET f.name = $name, f.valid_from_commit = 'TEST', f.valid_to_commit = null
                 WITH f MATCH (s:Service {id: $sid})
                 MERGE (s)-[r:CONTAINS]->(f)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { id, sid: serviceId, name },
            );
        } finally { await s.close(); }
    }

    async function makeChannel(id: string, name: string, channelKind: string, brokerUrn: string | null) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (c:MessageChannel {id: $id})
                 SET c.name = $name, c.channelKind = $kind, c.brokerUrn = $brokerUrn,
                     c.valid_from_commit = 'TEST', c.valid_to_commit = null`,
                { id, name, kind: channelKind, brokerUrn },
            );
        } finally { await s.close(); }
    }

    async function linkFn(funcId: string, channelId: string, rel: 'PUBLISHES_TO' | 'LISTENS_TO') {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (f:Function {id: $fid}), (c:MessageChannel {id: $cid})
                 MERGE (f)-[r:${rel}]->(c)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: funcId, cid: channelId },
            );
        } finally { await s.close(); }
    }

    async function readBrokers(hostContains: string): Promise<Array<Record<string, unknown>>> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (b:MessageBroker)
                 WHERE b.valid_to_commit IS NULL AND b.host CONTAINS $h
                 RETURN b.id AS id, b.provider AS provider, b.host AS host, b.vhost AS vhost,
                        b.needsReview AS needsReview, properties(b) AS props`,
                { h: hostContains },
            );
            return r.records.map(rec => ({
                id: rec.get('id'), provider: rec.get('provider'), host: rec.get('host'),
                vhost: rec.get('vhost'), needsReview: rec.get('needsReview'),
                props: rec.get('props'),
            }));
        } finally { await s.close(); }
    }

    async function readConnects(serviceId: string): Promise<string[]> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (s:Service {id: $id})-[rel:CONNECTS_TO]->(b:MessageBroker)
                 WHERE rel.valid_to_commit IS NULL
                 RETURN b.id AS bid ORDER BY bid`,
                { id: serviceId },
            );
            return r.records.map(rec => rec.get('bid') as string);
        } finally { await s.close(); }
    }

    async function readCandidates(): Promise<Array<Record<string, unknown>>> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (c:BrokerCandidate)
                 WHERE c.valid_to_commit IS NULL
                 RETURN c.id AS id, c.serviceUrn AS serviceUrn, c.repoUrn AS repoUrn,
                        c.host AS host, c.vhost AS vhost, c.provider AS provider,
                        c.providerSource AS providerSource, c.needsReview AS needsReview,
                        c.sourceEnvKeys AS sourceEnvKeys`,
            );
            return r.records.map(rec => ({
                id: rec.get('id'), serviceUrn: rec.get('serviceUrn'), repoUrn: rec.get('repoUrn'),
                host: rec.get('host'), vhost: rec.get('vhost'), provider: rec.get('provider'),
                providerSource: rec.get('providerSource'), needsReview: rec.get('needsReview'),
                sourceEnvKeys: rec.get('sourceEnvKeys'),
            }));
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    // ─── Filesystem discovery over the acme fixtures ─────────────────────────

    it('repo B fixture: arbitrary-key amqp:// DSN → s1 hint, credentials stripped', () => {
        const env = buildRepoEnvMap(REPO_B, { serviceRoot: path.join(REPO_B, 'apps/consumer') });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        const h = hints[0]!;
        expect(h.source).toBe('s1-scheme');
        expect(h.provider).toBe('rabbitmq');
        expect(h.host).toBe(HOST);
        expect(h.vhost).toBe('inventory');
        expect(JSON.stringify(h)).not.toContain('fixture-secret');
    });

    it('repo A fixture: non-standard key + trailing-dot FQDN in helm values → s0 hint', () => {
        const env = buildRepoEnvMap(REPO_A);
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        const h = hints[0]!;
        expect(h.source).toBe('s0-host-shape');
        expect(h.sourceEnvKey).toBe('INVENTORY_MQ_HOSTNAME');
        expect(h.provider).toBeUndefined();
    });

    // ─── Ledger + bind: the full discovery chain ─────────────────────────────

    it('E2E: s1 self-anchors, s0 a1-binds onto it (trailing dot normalized), weld yields the 2-hop', async () => {
        const svcA = `${PFX}svc/inventory`;
        const svcB = `${PFX}svc/notifications`;
        await makeService(svcA, 'inventory');
        await makeService(svcB, 'notifications');

        // Discovery from the real fixture trees.
        const hintsA = synthesizeBrokerCandidateHints(buildRepoEnvMap(REPO_A));
        const hintsB = synthesizeBrokerCandidateHints(
            buildRepoEnvMap(REPO_B, { serviceRoot: path.join(REPO_B, 'apps/consumer') }),
        );
        await mergeBrokerCandidate({ serviceUrn: svcA, repoUrn: 'acme/acme-inventory', ...hintsA[0]! }, COMMIT);
        await mergeBrokerCandidate({ serviceUrn: svcB, repoUrn: 'acme/acme-notifications', ...hintsB[0]! }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.createdSelfAnchored).toBe(1);
        expect(result.boundExisting).toBe(1);
        expect(result.unbound).toBe(0);

        // ONE broker, host normalized (no trailing dot), vhost from the DSN,
        // clean (scheme is contract-grade), no credentials anywhere.
        const brokers = await readBrokers('acme-internal');
        expect(brokers).toHaveLength(1);
        const broker = brokers[0]!;
        expect(broker.host).toBe(HOST);
        expect(broker.provider).toBe('rabbitmq');
        expect(broker.vhost).toBe('inventory');
        expect(broker.needsReview ?? false).toBe(false);
        expect(JSON.stringify(broker.props)).not.toContain('fixture-secret');

        // Both services bound to the SAME broker.
        expect(await readConnects(svcA)).toEqual([broker.id]);
        expect(await readConnects(svcB)).toEqual([broker.id]);

        // Candidates consumed.
        expect(await readCandidates()).toHaveLength(0);

        // Weld: publisher topic (svcA) ↔ consumer subscription (svcB) on the
        // shared physical broker → single channel carrying both edges.
        const fnPub = `${PFX}fn/InventorySync.dispatch`;
        const fnCon = `${PFX}fn/StockConsumer.handle`;
        await makeFunction(fnPub, svcA, 'InventorySync.dispatch');
        await makeFunction(fnCon, svcB, 'StockConsumer.handle');
        const topicId = `${PFX}channel/topic/acme.inventory.stock.low`;
        const subId = `${PFX}channel/sub/acme.inventory.stock.low`;
        await makeChannel(topicId, 'acme.inventory.stock.low', 'topic', broker.id as string);
        await makeChannel(subId, 'acme.inventory.stock.low', 'subscription', broker.id as string);
        await linkFn(fnPub, topicId, 'PUBLISHES_TO');
        await linkFn(fnCon, subId, 'LISTENS_TO');

        const weld = await deduplicateMessageChannelsByExactNameDifferentKind();
        expect(weld.merged).toBe(1);

        const s = getNeo4jSession();
        try {
            const twoHop = await s.run(
                `MATCH (sa:Service {id: $svcA})-[:CONTAINS]->(:Function)-[:PUBLISHES_TO]->(ch:MessageChannel)
                       <-[:LISTENS_TO]-(:Function)<-[:CONTAINS]-(sb:Service {id: $svcB})
                 WHERE ch.valid_to_commit IS NULL
                 RETURN ch.name AS name`,
                { svcA, svcB },
            );
            expect(twoHop.records).toHaveLength(1);
            expect(twoHop.records[0]!.get('name')).toBe('acme.inventory.stock.low');
        } finally { await s.close(); }
    });

    it('s0 alone: candidate persists needsReview, NO broker, NO binding (criterion 3)', async () => {
        const svcA = `${PFX}svc/inventory`;
        await makeService(svcA, 'inventory');
        const hints = synthesizeBrokerCandidateHints(buildRepoEnvMap(REPO_A));
        await mergeBrokerCandidate({ serviceUrn: svcA, repoUrn: 'acme/acme-inventory', ...hints[0]! }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.unbound).toBe(1);
        expect(await readBrokers('acme-internal')).toHaveLength(0);
        expect(await readConnects(svcA)).toEqual([]);

        const cands = await readCandidates();
        expect(cands).toHaveLength(1);
        expect(cands[0]!.needsReview).toBe(true);
        expect(cands[0]!.sourceEnvKeys).toContain('INVENTORY_MQ_HOSTNAME');
    });

    it('inverse ingest order: unbound candidate is replayed graph-only when the broker appears later (criterion 7)', async () => {
        const svcA = `${PFX}svc/inventory`;
        await makeService(svcA, 'inventory');
        const hints = synthesizeBrokerCandidateHints(buildRepoEnvMap(REPO_A));
        await mergeBrokerCandidate({ serviceUrn: svcA, repoUrn: 'acme/acme-inventory', ...hints[0]! }, COMMIT);

        const first = await bindBrokerCandidates(COMMIT);
        expect(first.unbound).toBe(1);

        // "analyze infra later": a clean broker with the real host appears.
        await mergeMessageBroker({
            urn: `${PFX}broker/rabbitmq/anchored`,
            provider: 'rabbitmq',
            fingerprint: 'testfp01',
            declaredVia: 'config',
            host: HOST,
            vhost: 'inventory',
            grounding: infraGrounding('rabbitmq-config@v1'),
        }, COMMIT);

        // Graph-only replay (no repos involved) must bind the ledger entry.
        const second = await bindBrokerCandidates(COMMIT);
        expect(second.boundExisting).toBe(1);
        expect(await readConnects(svcA)).toEqual([`${PFX}broker/rabbitmq/anchored`]);
        expect(await readCandidates()).toHaveLength(0);
    });

    it('a1 ambiguity: same host owned by two providers → no blind pick, candidate stays (criterion 8a)', async () => {
        const svcA = `${PFX}svc/inventory`;
        await makeService(svcA, 'inventory');
        for (const [provider, fp] of [['rabbitmq', 'fpr1'], ['kafka', 'fpk1']] as const) {
            await mergeMessageBroker({
                urn: `${PFX}broker/${provider}/shared`,
                provider, fingerprint: fp, declaredVia: 'config',
                host: 'shared.acme-orders.consul',
                grounding: infraGrounding('test@v1'),
            }, COMMIT);
        }
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/acme-inventory',
            source: 's0-host-shape', host: 'shared.acme-orders.consul',
            sourceEnvKey: 'EVENTS_HOST', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.boundExisting).toBe(0);
        expect(result.unbound).toBe(1);
        expect(await readConnects(svcA)).toEqual([]);
    });

    it('a1 vhost rules: null adopts the unique vhost-bearing broker; "/" matches ONLY "/"', async () => {
        const svcA = `${PFX}svc/inventory`;
        const svcB = `${PFX}svc/notifications`;
        await makeService(svcA, 'inventory');
        await makeService(svcB, 'notifications');
        await mergeMessageBroker({
            urn: `${PFX}broker/rabbitmq/vhosted`,
            provider: 'rabbitmq', fingerprint: 'fpv1', declaredVia: 'config',
            host: 'vh.acme-orders.consul', vhost: 'orders',
            grounding: infraGrounding('test@v1'),
        }, COMMIT);

        // vhost null (unknown) → adopts the unique vhost-bearing broker.
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/r1',
            source: 's0-host-shape', host: 'vh.acme-orders.consul',
            sourceEnvKey: 'MQ_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);
        // vhost '/' (KNOWN default) → must NOT melt into 'orders'.
        await mergeBrokerCandidate({
            serviceUrn: svcB, repoUrn: 'acme/r2',
            source: 's1-scheme', provider: 'rabbitmq', providerSource: 'scheme',
            host: 'vh.acme-orders.consul', vhost: '/',
            sourceEnvKey: 'MQ_URL', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(await readConnects(svcA)).toEqual([`${PFX}broker/rabbitmq/vhosted`]);
        // The '/' candidate self-anchors (s1) onto a DISTINCT broker instead.
        const bound = await readConnects(svcB);
        expect(bound).toHaveLength(1);
        expect(bound[0]).not.toBe(`${PFX}broker/rabbitmq/vhosted`);
        expect(result.createdSelfAnchored).toBe(1);
    });

    it('a3-clean: declared provider + independent repo host agreement → clean broker (criterion 8b)', async () => {
        const svcA = `${PFX}svc/p1`;
        const svcB = `${PFX}svc/p2`;
        await makeService(svcA, 'p1');
        await makeService(svcB, 'p2');
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/repo-one',
            source: 's0-host-shape', host: 'conv.acme-orders.consul',
            sourceEnvKey: 'BUS_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);
        await mergeBrokerCandidate({
            serviceUrn: svcB, repoUrn: 'acme/repo-two',
            source: 's0-host-shape', provider: 'rabbitmq', providerSource: 'declared',
            host: 'conv.acme-orders.consul', port: 5672, // one-sided port: null adopts the unique known
            sourceEnvKey: 'BROKER_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.convergedClean).toBe(1);
        const brokers = await readBrokers('conv.acme-orders');
        expect(brokers).toHaveLength(1);
        expect(brokers[0]!.provider).toBe('rabbitmq');
        expect(brokers[0]!.needsReview ?? false).toBe(false);
        expect(await readConnects(svcA)).toEqual([brokers[0]!.id]);
        expect(await readConnects(svcB)).toEqual([brokers[0]!.id]);
    });

    it('a3 port compatibility: two KNOWN different ports on the same host never converge', async () => {
        const svcA = `${PFX}svc/p1`;
        const svcB = `${PFX}svc/p2`;
        await makeService(svcA, 'p1');
        await makeService(svcB, 'p2');
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/repo-one',
            source: 's0-host-shape', host: 'ports.acme-orders.consul', port: 6650,
            sourceEnvKey: 'BUS_A_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);
        await mergeBrokerCandidate({
            serviceUrn: svcB, repoUrn: 'acme/repo-two',
            source: 's0-host-shape', provider: 'rabbitmq', providerSource: 'declared',
            host: 'ports.acme-orders.consul', port: 6651,
            sourceEnvKey: 'BUS_B_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.convergedClean).toBe(0);
        expect(result.convergedGuess).toBe(0);
    });

    it('s2 declared residual alone: mints needsReview broker counted as createdDeclaredReview, NOT createdGuess', async () => {
        const svcA = `${PFX}svc/declared-solo`;
        await makeService(svcA, 'declared-solo');
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/solo-repo',
            source: 's2-declared-sink', provider: 'rabbitmq', providerSource: 'declared',
            host: 'declared.acme-orders.consul', vhost: 'orders',
            sourceEnvKey: 'BUS_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.createdDeclaredReview).toBe(1);
        expect(result.createdGuess).toBe(0);
        expect(result.guessOnlyBindings).toBe(1);
        const brokers = await readBrokers('declared.acme-orders');
        expect(brokers).toHaveLength(1);
        expect(brokers[0]!.needsReview).toBe(true);
        expect(brokers[0]!.provider).toBe('rabbitmq');
    });

    it('a3-guess-provider: host agreement with provider ONLY from key-name → broker stays needsReview (criterion 8c)', async () => {
        const svcA = `${PFX}svc/p1`;
        const svcB = `${PFX}svc/p2`;
        await makeService(svcA, 'p1');
        await makeService(svcB, 'p2');
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/repo-one',
            source: 's3-key-name', provider: 'rabbitmq', providerSource: 'key-name',
            host: 'gp.acme-orders.consul',
            sourceEnvKey: 'RABBITMQ_HOST', sourceFile: '.env', confidence: 'high',
        }, COMMIT);
        await mergeBrokerCandidate({
            serviceUrn: svcB, repoUrn: 'acme/repo-two',
            source: 's0-host-shape', host: 'gp.acme-orders.consul',
            sourceEnvKey: 'EVENTS_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.convergedGuess).toBe(1);
        expect(result.guessOnlyBindings).toBeGreaterThanOrEqual(1);
        const brokers = await readBrokers('gp.acme-orders');
        expect(brokers).toHaveLength(1);
        expect(brokers[0]!.needsReview).toBe(true);
    });

    it('same-repo candidates are NOT independent observers: no convergence, s3 residual stays guess', async () => {
        const svcA = `${PFX}svc/m1`;
        const svcB = `${PFX}svc/m2`;
        await makeService(svcA, 'm1');
        await makeService(svcB, 'm2');
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/monorepo',
            source: 's3-key-name', provider: 'rabbitmq', providerSource: 'key-name',
            host: 'mono.acme-orders.consul',
            sourceEnvKey: 'RABBITMQ_HOST', sourceFile: '.env', confidence: 'high',
        }, COMMIT);
        await mergeBrokerCandidate({
            serviceUrn: svcB, repoUrn: 'acme/monorepo',
            source: 's0-host-shape', host: 'mono.acme-orders.consul',
            sourceEnvKey: 'EVENTS_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.convergedClean).toBe(0);
        expect(result.convergedGuess).toBe(0);
        // s3 residual still creates its (visible) guess broker; it stays dirty.
        expect(result.createdGuess).toBe(1);
        const brokers = await readBrokers('mono.acme-orders');
        expect(brokers).toHaveLength(1);
        expect(brokers[0]!.needsReview).toBe(true);
    });

    it('s3 alone (single-repo legacy shape): broker created but needsReview with @guess extractor', async () => {
        const svcA = `${PFX}svc/legacy`;
        await makeService(svcA, 'legacy');
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/legacy-repo',
            source: 's3-key-name', provider: 'rabbitmq', providerSource: 'key-name',
            host: 'legacy.acme-orders.consul', vhost: 'orders',
            sourceEnvKey: 'RABBITMQ_HOST', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT);
        expect(result.createdGuess).toBe(1);
        const brokers = await readBrokers('legacy.acme-orders');
        expect(brokers).toHaveLength(1);
        expect(brokers[0]!.needsReview).toBe(true);
        const extractors = (brokers[0]!.props as Record<string, unknown>).evidence_extractors as string[];
        expect(extractors.some(e => e.includes('@guess'))).toBe(true);
        expect(await readConnects(svcA)).toEqual([brokers[0]!.id]);
    });

    it('bind is idempotent: second run binds nothing new and duplicates no edges', async () => {
        const svcA = `${PFX}svc/idem`;
        await makeService(svcA, 'idem');
        await mergeBrokerCandidate({
            serviceUrn: svcA, repoUrn: 'acme/idem-repo',
            source: 's1-scheme', provider: 'rabbitmq', providerSource: 'scheme',
            host: 'idem.acme-orders.consul', vhost: '/',
            sourceEnvKey: 'MQ_URL', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const first = await bindBrokerCandidates(COMMIT);
        expect(first.createdSelfAnchored).toBe(1);
        const second = await bindBrokerCandidates(COMMIT);
        expect(second.createdSelfAnchored).toBe(0);
        expect(second.boundExisting).toBe(0);
        expect(await readConnects(svcA)).toHaveLength(1);
    });

    it('gc removes candidates of tombstoned AND hard-deleted services, keeps live unbound candidates visible', async () => {
        const svcLive = `${PFX}svc/live`;
        const svcDead = `${PFX}svc/dead`;
        const svcGone = `${PFX}svc/gone`;
        await makeService(svcLive, 'live');
        await makeService(svcDead, 'dead');
        await makeService(svcGone, 'gone');
        await mergeBrokerCandidate({
            serviceUrn: svcLive, repoUrn: 'acme/r-live',
            source: 's0-host-shape', host: 'live.acme-orders.consul',
            sourceEnvKey: 'A_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);
        await mergeBrokerCandidate({
            serviceUrn: svcDead, repoUrn: 'acme/r-dead',
            source: 's0-host-shape', host: 'dead.acme-orders.consul',
            sourceEnvKey: 'B_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);
        await mergeBrokerCandidate({
            serviceUrn: svcGone, repoUrn: 'acme/r-gone',
            source: 's0-host-shape', host: 'gone.acme-orders.consul',
            sourceEnvKey: 'C_HOSTNAME', sourceFile: '.env', confidence: 'high',
        }, COMMIT);

        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (sv:Service {id: $id}) SET sv.valid_to_commit = 'TEST-TOMB'`,
                { id: svcDead },
            );
            // Hard delete: the candidate becomes truly DETACHED (no edge left).
            await s.run(
                `MATCH (sv:Service {id: $id}) DETACH DELETE sv`,
                { id: svcGone },
            );
        } finally { await s.close(); }

        const removed = await gcOrphanBrokerCandidates();
        expect(removed).toBe(2);
        const cands = await readCandidates();
        expect(cands).toHaveLength(1);
        expect(cands[0]!.serviceUrn).toBe(svcLive);
    });
});
