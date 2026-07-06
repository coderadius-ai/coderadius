import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeMessageBroker, mergeMessageChannelWithKind } from '../../src/graph/mutations/data-contracts.js';
import { astGrounding } from '../../src/graph/grounding.js';
import { runChannelRoutingPatternResolver } from '../../src/ingestion/processors/channel-routing-pattern-resolver.js';

// ═════════════════════════════════════════════════════════════════════════════
// Fix C (v8) — Routing-key-to-queue welder
//
// Pins the complete welder behaviour (NOT a preparatory step for cross-kind
// dedup): when a code-side channel name matches a UNIQUE binding's
// patternRegex / bindingKey on a same-provider broker, move ALL live edges
// onto the queue and DETACH the code channel. Guards:
//   - exact-counterpart skip (provider-aware)
//   - provider parity between codeBroker and infraBroker
//   - target queue.channelKind = 'queue'
//   - bind.patternSyntax in {'amqp-topic', 'exact'} with separate match logic
//   - source exchange must be live + infra-derived + same broker as queue
//   - ambiguity (2+ matches) → stamp 'channel-routing-pattern-ambiguous@v1'
// ═════════════════════════════════════════════════════════════════════════════

describe('runChannelRoutingPatternResolver', () => {
    const PFX = 'cr://test/routing-resolver/';
    const COMMIT = 'ROUTING_TEST';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await s.run(`MATCH (ch:MessageChannel) WHERE ch.name STARTS WITH 'inventory.' OR ch.name STARTS WITH 'acme.events' OR ch.name STARTS WITH 'motor-' OR ch.name STARTS WITH 'order-' DETACH DELETE ch`);
            await s.run(`MATCH (b:MessageBroker) WHERE b.id STARTS WITH 'cr:broker:rabbitmq:fixctest' OR b.id STARTS WITH 'cr:broker:kafka:fixctest' DETACH DELETE b`);
        } finally { await s.close(); }
    }

    async function makeBroker(urn: string, provider: 'rabbitmq' | 'kafka', host: string | null, vhost: string | null) {
        await mergeMessageBroker({
            urn, provider,
            fingerprint: urn.split(':').pop() ?? 'fp',
            declaredVia: 'inferred',
            host: host ?? undefined,
            vhost: vhost ?? undefined,
            port: 5672,
            fingerprintScope: 'global',
            grounding: astGrounding('test-setup@v1'),
        }, COMMIT);
    }

    async function setNodeProps(urn: string, props: Record<string, unknown>) {
        const s = getNeo4jSession();
        try {
            const setClauses = Object.keys(props).map(k => `n.${k} = $props.${k}`).join(', ');
            await s.run(`MATCH (n {id: $id}) SET ${setClauses}`, { id: urn, props });
        } finally { await s.close(); }
    }

    async function makeFunction(urn: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:Function {id: $id})
                 SET f.name = 'fn', f.valid_from_commit = $c, f.valid_to_commit = null`,
                { id: urn, c: COMMIT },
            );
        } finally { await s.close(); }
    }

    // Helpers use CREATE (not MERGE) so multiple edges from the same Function
    // to the same channel — distinct by routingKey or consumerGroup — coexist.
    // Mirrors the production writer pattern in `linkFunctionToBroker`
    // (data-contracts.ts:1743) which keys identity by routingKey via MERGE
    // with literal prop. CREATE here keeps tests deterministic.
    async function publishesTo(fnUrn: string, channelUrn: string, props: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try {
            const setClauses = Object.keys(props).map(k => `r.${k} = $props.${k}`).join(', ');
            const extra = setClauses ? `, ${setClauses}` : '';
            await s.run(
                `MATCH (f:Function {id: $fid}), (c:MessageChannel {id: $cid})
                 CREATE (f)-[r:PUBLISHES_TO]->(c)
                 SET r.valid_from_commit = $commit, r.valid_to_commit = null${extra}`,
                { fid: fnUrn, cid: channelUrn, commit: COMMIT, props },
            );
        } finally { await s.close(); }
    }

    async function listensTo(fnUrn: string, channelUrn: string, props: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try {
            const setClauses = Object.keys(props).map(k => `r.${k} = $props.${k}`).join(', ');
            const extra = setClauses ? `, ${setClauses}` : '';
            await s.run(
                `MATCH (f:Function {id: $fid}), (c:MessageChannel {id: $cid})
                 CREATE (f)-[r:LISTENS_TO]->(c)
                 SET r.valid_from_commit = $commit, r.valid_to_commit = null${extra}`,
                { fid: fnUrn, cid: channelUrn, commit: COMMIT, props },
            );
        } finally { await s.close(); }
    }

    async function makeBinding(exchangeUrn: string, queueUrn: string, bindingKey: string, patternSyntax: 'amqp-topic' | 'exact', patternRegex: string | null) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (e:MessageChannel {id: $eid}), (q:MessageChannel {id: $qid})
                 MERGE (e)-[r:ROUTES_TO {bindingKey: $bk}]->(q)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null,
                               r.patternSyntax = $ps, r.patternRegex = $pr`,
                { eid: exchangeUrn, qid: queueUrn, bk: bindingKey, ps: patternSyntax, pr: patternRegex, c: COMMIT },
            );
        } finally { await s.close(); }
    }

    async function readChannel(urn: string): Promise<Record<string, unknown> | null> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (c:MessageChannel {id: $id})
                 RETURN c.id AS id, c.name AS name, c.brokerUrn AS bu, c.needsReview AS nr,
                        coalesce(c.evidence_extractors, []) AS ext`,
                { id: urn },
            );
            if (r.records.length === 0) return null;
            const rec = r.records[0];
            return {
                id: rec.get('id'), name: rec.get('name'), bu: rec.get('bu'),
                needsReview: rec.get('nr'), ext: rec.get('ext'),
            };
        } finally { await s.close(); }
    }

    async function readEdges(fnUrn: string, channelUrn: string, edgeType: 'PUBLISHES_TO' | 'LISTENS_TO'): Promise<Array<Record<string, unknown>>> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (f:Function {id: $fid})-[r:${edgeType}]->(c:MessageChannel {id: $cid})
                 WHERE r.valid_to_commit IS NULL
                 RETURN properties(r) AS props`,
                { fid: fnUrn, cid: channelUrn },
            );
            return r.records.map(rec => rec.get('props') as Record<string, unknown>);
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('Caso 1 (RED): topic exchange wildcard → rewire onto queue, edge props preserved, code-channel DETACHed', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code1`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra1`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.motor.save.ready', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra1', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'motor-save-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra1', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.motor.#', 'amqp-topic', '^inventory\\.motor\\..*$');

        const fn = `${PFX}function:publisher`;
        await makeFunction(fn);
        await publishesTo(fn, codeChannel, { routingKey: 'inventory.motor.save.ready', partitionKey: 'p1' });

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(1);
        expect(result.ambiguousMarked).toBe(0);

        // Code channel detached.
        expect(await readChannel(codeChannel)).toBeNull();
        // Edge moved to queue with props preserved.
        const edges = await readEdges(fn, queue, 'PUBLISHES_TO');
        expect(edges).toHaveLength(1);
        expect(edges[0].routingKey).toBe('inventory.motor.save.ready');
        expect(edges[0].partitionKey).toBe('p1');
        // Queue stamped.
        const q = await readChannel(queue);
        expect(q!.ext).toContain('channel-routing-pattern-resolver@v1');
    });

    it('Caso 2: direct exchange exact match (patternSyntax=exact)', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code2`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra2`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.order.placed', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.direct', 'exchange', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra2', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'order-placed-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra2', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.order.placed', 'exact', '^inventory\\.order\\.placed$');

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(1);
        expect(await readChannel(codeChannel)).toBeNull();
    });

    it('Caso 3: ambiguity (2+ bindings match) → no rewire, ambiguity stamp + needsReview=true', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code3`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra3`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'acme.events.shared', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra3', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const q1 = await mergeMessageChannelWithKind(
            'inventory-queue-a', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra3-q1', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const q2 = await mergeMessageChannelWithKind(
            'inventory-queue-b', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra3-q2', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(q1, { discoverySource: 'config' });
        await setNodeProps(q2, { discoverySource: 'config' });
        await makeBinding(exchange, q1, 'acme.events.#', 'amqp-topic', '^acme\\.events\\..*$');
        await makeBinding(exchange, q2, 'acme.events.shared', 'exact', '^acme\\.events\\.shared$');

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(0);
        expect(result.ambiguousMarked).toBe(1);
        const c = await readChannel(codeChannel);
        expect(c).not.toBeNull();
        expect(c!.needsReview).toBe(true);
        expect(c!.ext).toContain('channel-routing-pattern-ambiguous@v1');
    });

    it('Caso 4: idempotence — second run is a no-op', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code4`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra4`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.idem', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra4', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'inventory-idem-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra4', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.#', 'amqp-topic', '^inventory\\..*$');

        const first = await runChannelRoutingPatternResolver(COMMIT);
        const second = await runChannelRoutingPatternResolver(COMMIT);
        expect(first.rewired).toBe(1);
        expect(second.rewired).toBe(0);
    });

    it('Caso 5: provider guard — code on rabbitmq, binding on kafka → no rewire', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code5`;
        const kafkaBroker = `${PFX}broker:kafka:fixctest-infra5`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(kafkaBroker, 'kafka', null, null);

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.crosstech', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.kafka.events', 'topic', 'kafka', COMMIT,
            { scope: 'physical', brokerUrn: kafkaBroker, brokerFingerprint: 'fixctest-infra5', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'inventory-crosstech-queue', 'queue', 'kafka', COMMIT,
            { scope: 'physical', brokerUrn: kafkaBroker, brokerFingerprint: 'fixctest-infra5', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.crosstech', 'exact', '^inventory\\.crosstech$');

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(0);
        expect(await readChannel(codeChannel)).not.toBeNull();
    });

    it('Caso 6: target kind guard — ROUTES_TO target is exchange not queue → no rewire', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code6`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra6`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.exchange.only', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchA = await mergeMessageChannelWithKind(
            'acme.events.src', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra6a', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const exchB = await mergeMessageChannelWithKind(
            'acme.events.dest', 'exchange', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra6b', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchA, { discoverySource: 'config' });
        await setNodeProps(exchB, { discoverySource: 'config' });
        // Exchange-to-exchange binding (queue kind missing) → guard excludes.
        await makeBinding(exchA, exchB, 'inventory.exchange.only', 'exact', '^inventory\\.exchange\\.only$');

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(0);
        expect(await readChannel(codeChannel)).not.toBeNull();
    });

    it('Caso 7: host-only guard — code broker already vhost-set → no rewire (already converged)', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code7`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra7`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', 'acmesvc');  // host + vhost
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.fully.pinned', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra7', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'inventory-pinned-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra7', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.fully.pinned', 'exact', '^inventory\\.fully\\.pinned$');

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(0);
        expect(await readChannel(codeChannel)).not.toBeNull();
    });

    it('Caso 11 (multi-publisher with routingKey distinction): 2 PUBLISHES_TO from same Function, distinct routingKey → both migrated', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code11`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra11`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.multi.pub', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra11', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'inventory-multi-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra11', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.multi.#', 'amqp-topic', '^inventory\\.multi\\..*$');

        const fn = `${PFX}function:multi-pub`;
        await makeFunction(fn);
        await publishesTo(fn, codeChannel, { routingKey: 'inventory.multi.pub.a' });
        await publishesTo(fn, codeChannel, { routingKey: 'inventory.multi.pub.b' });

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(1);

        const edges = await readEdges(fn, queue, 'PUBLISHES_TO');
        // Both edges migrated, NOT collapsed.
        expect(edges).toHaveLength(2);
        const keys = edges.map(e => e.routingKey).sort();
        expect(keys).toEqual(['inventory.multi.pub.a', 'inventory.multi.pub.b']);
    });

    it('Caso 13 (multi-listener routingKey): LISTENS_TO branched by routingKey identity', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code13`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra13`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.listen.rk', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra13', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'inventory-listen-rk-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra13', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.listen.#', 'amqp-topic', '^inventory\\.listen\\..*$');

        const fn = `${PFX}function:multi-listen`;
        await makeFunction(fn);
        await listensTo(fn, codeChannel, { routingKey: 'inventory.listen.rk.a' });
        await listensTo(fn, codeChannel, { routingKey: 'inventory.listen.rk.b' });

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(1);

        const edges = await readEdges(fn, queue, 'LISTENS_TO');
        expect(edges).toHaveLength(2);
        const keys = edges.map(e => e.routingKey).sort();
        expect(keys).toEqual(['inventory.listen.rk.a', 'inventory.listen.rk.b']);
    });

    it('Caso 13b (multi-listener consumerGroup): 2 LISTENS_TO branched by consumerGroup', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code13b`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra13b`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.listen.cg', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra13b', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'inventory-listen-cg-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra13b', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.listen.cg', 'exact', '^inventory\\.listen\\.cg$');

        const fn = `${PFX}function:listen-cg`;
        await makeFunction(fn);
        await listensTo(fn, codeChannel, { consumerGroup: 'cg-a' });
        await listensTo(fn, codeChannel, { consumerGroup: 'cg-b' });

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(1);

        const edges = await readEdges(fn, queue, 'LISTENS_TO');
        expect(edges).toHaveLength(2);
        const cgs = edges.map(e => e.consumerGroup).sort();
        expect(cgs).toEqual(['cg-a', 'cg-b']);
    });

    it('Caso 16 (MANIFESTS_AS preservation): logical -[MANIFESTS_AS]-> codeCh becomes -> queue', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code16`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra16`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'acmesvc');

        // Distinguish codeChannel URN from logical URN by passing brokerFingerprint
        // so the codeChannel has `@<fp>` suffix and logical has bare URN.
        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.manifest', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, brokerFingerprint: 'fixctest-code16', confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const logical = await mergeMessageChannelWithKind(
            'inventory.manifest', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'logical', confidence: 0.7, grounding: astGrounding('logical@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra16', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'inventory-manifest-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra16', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.manifest', 'exact', '^inventory\\.manifest$');

        // Seed MANIFESTS_AS from logical to codeCh.
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (l:MessageChannel {id: $lid}), (p:MessageChannel {id: $pid})
                 MERGE (l)-[r:MANIFESTS_AS]->(p)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { lid: logical, pid: codeChannel, c: COMMIT },
            );
        } finally { await s.close(); }

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(1);
        expect(await readChannel(codeChannel)).toBeNull();

        // MANIFESTS_AS now points to queue, NOT codeCh (which is gone).
        const s2 = getNeo4jSession();
        try {
            const r = await s2.run(
                `MATCH (l:MessageChannel {id: $lid})-[r:MANIFESTS_AS]->(p:MessageChannel)
                 WHERE r.valid_to_commit IS NULL
                 RETURN p.id AS pid`,
                { lid: logical },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('pid')).toBe(queue);
        } finally { await s2.close(); }
    });

    it('provider-aware exact-counterpart guard: different-provider exact channel does not block RabbitMQ binding rewire', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code-provider`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra-provider`;
        const kafkaBroker = `${PFX}broker:kafka:fixctest-other-provider`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'orders');
        await makeBroker(kafkaBroker, 'kafka', null, 'orders');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.provider.guard', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const kafkaExact = await mergeMessageChannelWithKind(
            'inventory.provider.guard', 'queue', 'kafka', COMMIT,
            { scope: 'physical', brokerUrn: kafkaBroker, brokerFingerprint: 'fixctest-other-provider', confidence: 0.9, grounding: astGrounding('kafka-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra-provider', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const queue = await mergeMessageChannelWithKind(
            'inventory-provider-queue', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra-provider', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(kafkaExact, { discoverySource: 'config' });
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(queue, { discoverySource: 'config' });
        await makeBinding(exchange, queue, 'inventory.provider.#', 'amqp-topic', '^inventory\\.provider\\..*$');

        const fn = `${PFX}function:provider-guard`;
        await makeFunction(fn);
        await publishesTo(fn, codeChannel, { routingKey: 'inventory.provider.guard' });

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(1);
        expect(await readChannel(codeChannel)).toBeNull();
        expect(await readEdges(fn, queue, 'PUBLISHES_TO')).toHaveLength(1);
    });

    it('same-provider exact counterpart blocks rewire and ambiguity stamp', async () => {
        const codeBroker = `${PFX}broker:rabbitmq:fixctest-code-exact`;
        const infraBroker = `${PFX}broker:rabbitmq:fixctest-infra-exact`;
        await makeBroker(codeBroker, 'rabbitmq', 'rabbitmq.acme.example', null);
        await makeBroker(infraBroker, 'rabbitmq', null, 'orders');

        const codeChannel = await mergeMessageChannelWithKind(
            'inventory.exact.counterpart', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn: codeBroker, confidence: 0.7, grounding: astGrounding('code-side@v1') },
        );
        const exact = await mergeMessageChannelWithKind(
            'inventory.exact.counterpart', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra-exact', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const exchange = await mergeMessageChannelWithKind(
            'acme.events', 'topic', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra-exact', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const q1 = await mergeMessageChannelWithKind(
            'inventory-exact-q1', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra-exact', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        const q2 = await mergeMessageChannelWithKind(
            'inventory-exact-q2', 'queue', 'rabbitmq', COMMIT,
            { scope: 'physical', brokerUrn: infraBroker, brokerFingerprint: 'fixctest-infra-exact', confidence: 0.9, grounding: astGrounding('infra-side@v1') },
        );
        await setNodeProps(exact, { discoverySource: 'config' });
        await setNodeProps(exchange, { discoverySource: 'config' });
        await setNodeProps(q1, { discoverySource: 'config' });
        await setNodeProps(q2, { discoverySource: 'config' });
        await makeBinding(exchange, q1, 'inventory.exact.#', 'amqp-topic', '^inventory\\.exact\\..*$');
        await makeBinding(exchange, q2, 'inventory.exact.counterpart', 'exact', '^inventory\\.exact\\.counterpart$');

        const result = await runChannelRoutingPatternResolver(COMMIT);
        expect(result.rewired).toBe(0);
        expect(result.ambiguousMarked).toBe(0);
        const code = await readChannel(codeChannel);
        expect(code).not.toBeNull();
        expect(code!.ext as string[]).not.toContain('channel-routing-pattern-ambiguous@v1');
    });
});
