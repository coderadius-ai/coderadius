import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeMessageBroker,
    mergeMessageChannelWithKind,
    linkChannelHostedOn,
} from '../../src/graph/mutations/data-contracts.js';
import { runChannelTechnologyWeld } from '../../src/ingestion/processors/channel-technology-welder.js';
import { astGrounding } from '../../src/graph/grounding.js';

// ═════════════════════════════════════════════════════════════════════════════
// Fix 7 — Welder direct ch.brokerUrn binding + HOSTED_ON Pass 2 fallback
//
// Phase 1 welder used Service-CONNECTS_TO inference which painted FP residues
// (e.g. `error_log`, `cache_write`) with the Service broker's technology. Phase 2
// uses ONLY explicit channel↔broker bindings:
//   Pass 1: ch.brokerUrn = b.id (autopromoter-set or customer-declared).
//   Pass 2: HOSTED_ON single-broker fallback, backfills brokerUrn.
//
// Invariants:
//   - needsReview channels are skipped (Fix 6bis guard).
//   - Only NULL / 'unknown' / abstract-bus technologies are overwritten.
//   - ambiguous via brokerUrn impossible (1:1 binding); only Pass 2 can be ambiguous.
//   - Idempotent: second run is no-op.
// ═════════════════════════════════════════════════════════════════════════════

describe('channel-technology-welder Phase 2 — direct brokerUrn + HOSTED_ON fallback', () => {
    const PFX = 'cr://test/tech-weld/';
    const COMMIT = 'TECH_WELD_TEST';
    const TEST_DOMAIN = 'tech-weld.acme.example';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await session.run(`MATCH (n:MessageChannel) WHERE n.name STARTS WITH 'tech-weld.' DETACH DELETE n`);
            await session.run(`MATCH (n:MessageBroker) WHERE n.host CONTAINS '${TEST_DOMAIN}' DETACH DELETE n`);
        } finally { await session.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    // ─── Pass 1 — direct brokerUrn binding ──────────────────────────────────

    it('Pass 1: overwrites symfony-messenger with rabbitmq when ch.brokerUrn matches broker', async () => {
        const brokerUrn = 'cr:broker:rabbitmq:p1bind00:orders';
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'p1bind00',
            declaredVia: 'inferred', host: `rabbitmq.p1bind.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);

        const chUrn = await mergeMessageChannelWithKind(
            'tech-weld.p1.bind', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn, confidence: 0.8, grounding: astGrounding('test@v1') },
        );

        const result = await runChannelTechnologyWeld(COMMIT);
        expect(result.welded).toBeGreaterThanOrEqual(1);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id})
                 RETURN ch.technology AS tech, ch.evidence_extractors AS ext`,
                { id: chUrn },
            );
            expect(r.records[0].get('tech')).toBe('rabbitmq');
            const ext = r.records[0].get('ext') as string[] | null;
            expect(ext).toContain('channel-technology-welder@v1');
        } finally { await session.close(); }
    });

    it('Pass 1: does NOT touch channel without brokerUrn (no Service inference path)', async () => {
        const brokerUrn = 'cr:broker:rabbitmq:p1noUrn0:orders';
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'p1noUrn0',
            declaredVia: 'inferred', host: `rabbitmq.p1noUrn.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);

        // No brokerUrn on channel; broker exists in graph but channel-broker
        // binding is NOT explicit → welder must skip (no Service inference).
        const chUrn = await mergeMessageChannelWithKind(
            'tech-weld.p1.noUrn', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', confidence: 0.8, grounding: astGrounding('test@v1') },
        );

        await runChannelTechnologyWeld(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id}) RETURN ch.technology AS tech`,
                { id: chUrn },
            );
            expect(r.records[0].get('tech')).toBe('symfony-messenger');
        } finally { await session.close(); }
    });

    it('Pass 1: does NOT overwrite when broker.provider is unknown', async () => {
        const brokerUrn = 'cr:broker:unknown:p1unkn00';
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'unknown', fingerprint: 'p1unkn00',
            declaredVia: 'inferred', host: `unknown.${TEST_DOMAIN}`,
            port: 0, vhost: '', fingerprintScope: 'global',
        }, COMMIT);

        const chUrn = await mergeMessageChannelWithKind(
            'tech-weld.p1.unknownBroker', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn, confidence: 0.8, grounding: astGrounding('test@v1') },
        );

        await runChannelTechnologyWeld(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id}) RETURN ch.technology AS tech`,
                { id: chUrn },
            );
            // Provider 'unknown' not in PHYSICAL_PROVIDERS whitelist → no-op.
            expect(r.records[0].get('tech')).toBe('symfony-messenger');
        } finally { await session.close(); }
    });

    it('Pass 1: does NOT overwrite concrete tech (kafka stays kafka even with rabbitmq broker)', async () => {
        const brokerUrn = 'cr:broker:rabbitmq:p1conc00:orders';
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'p1conc00',
            declaredVia: 'inferred', host: `rabbitmq.p1conc.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);

        const chUrn = await mergeMessageChannelWithKind(
            'tech-weld.p1.concrete', 'topic', 'kafka', COMMIT,
            { scope: 'physical', brokerUrn, confidence: 0.9, grounding: astGrounding('test@v1') },
        );

        await runChannelTechnologyWeld(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id}) RETURN ch.technology AS tech`,
                { id: chUrn },
            );
            // Concrete tech NOT in overwritable whitelist → stays.
            expect(r.records[0].get('tech')).toBe('kafka');
        } finally { await session.close(); }
    });

    // ─── Pass 2 — HOSTED_ON fallback ──────────────────────────────────────────

    it('Pass 2: HOSTED_ON fallback welds + backfills brokerUrn', async () => {
        const brokerUrn = 'cr:broker:rabbitmq:p2host00:orders';
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'p2host00',
            declaredVia: 'inferred', host: `rabbitmq.p2host.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);

        // Channel without brokerUrn but with HOSTED_ON (structural plugin emit).
        const chUrn = await mergeMessageChannelWithKind(
            'tech-weld.p2.hostedOn', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', confidence: 0.8, grounding: astGrounding('test@v1') },
        );
        await linkChannelHostedOn(chUrn, brokerUrn, COMMIT);

        await runChannelTechnologyWeld(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id})
                 RETURN ch.technology AS tech, ch.brokerUrn AS bu`,
                { id: chUrn },
            );
            expect(r.records[0].get('tech')).toBe('rabbitmq');
            // Pass 2 backfills brokerUrn.
            expect(r.records[0].get('bu')).toBe(brokerUrn);
        } finally { await session.close(); }
    });

    it('Pass 2: skips ambiguous HOSTED_ON (>1 broker)', async () => {
        const brokerAUrn = 'cr:broker:rabbitmq:p2ambA00';
        const brokerBUrn = 'cr:broker:kafka:p2ambB00';
        await mergeMessageBroker({
            urn: brokerAUrn, provider: 'rabbitmq', fingerprint: 'p2ambA00',
            declaredVia: 'inferred', host: `rabbitmq.p2amb.${TEST_DOMAIN}`,
            port: 5672, vhost: '/', fingerprintScope: 'global',
        }, COMMIT);
        await mergeMessageBroker({
            urn: brokerBUrn, provider: 'kafka', fingerprint: 'p2ambB00',
            declaredVia: 'inferred', host: `kafka.p2amb.${TEST_DOMAIN}`,
            port: 9092, vhost: '', fingerprintScope: 'global',
        }, COMMIT);

        const chUrn = await mergeMessageChannelWithKind(
            'tech-weld.p2.ambiguous', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', confidence: 0.8, grounding: astGrounding('test@v1') },
        );
        await linkChannelHostedOn(chUrn, brokerAUrn, COMMIT);
        await linkChannelHostedOn(chUrn, brokerBUrn, COMMIT);

        await runChannelTechnologyWeld(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id})
                 RETURN ch.technology AS tech, ch.brokerUrn AS bu`,
                { id: chUrn },
            );
            // 2 different brokers → ambiguous → no-op.
            expect(r.records[0].get('tech')).toBe('symfony-messenger');
            expect(r.records[0].get('bu')).toBeNull();
        } finally { await session.close(); }
    });

    // ─── Fix 6bis guard ───────────────────────────────────────────────────────

    it('needsReview channel is NOT welded (Fix 6bis protection)', async () => {
        const brokerUrn = 'cr:broker:rabbitmq:nrev0000:orders';
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'nrev0000',
            declaredVia: 'inferred', host: `rabbitmq.nrev.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);

        const chUrn = await mergeMessageChannelWithKind(
            'tech-weld.needsReview.fp', 'topic', 'unknown', COMMIT,
            { scope: 'physical', brokerUrn, confidence: 0.5, grounding: astGrounding('test@v1') },
        );
        // Mark channel as needsReview (simulates Fix 6bis low-evidence marker).
        const sSetup = getNeo4jSession();
        try {
            await sSetup.run(
                `MATCH (ch:MessageChannel {id: $id}) SET ch.needsReview = true`,
                { id: chUrn },
            );
        } finally { await sSetup.close(); }

        await runChannelTechnologyWeld(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id})
                 RETURN ch.technology AS tech, ch.evidence_extractors AS ext`,
                { id: chUrn },
            );
            // Welder must skip needsReview channels — FP residue stays unknown.
            expect(r.records[0].get('tech')).toBe('unknown');
            const ext = (r.records[0].get('ext') as string[] | null) ?? [];
            expect(ext).not.toContain('channel-technology-welder@v1');
        } finally { await session.close(); }
    });

    // ─── Idempotency ──────────────────────────────────────────────────────────

    it('idempotent: a second run does not duplicate evidence_extractors', async () => {
        const brokerUrn = 'cr:broker:rabbitmq:idem0001:orders';
        await mergeMessageBroker({
            urn: brokerUrn, provider: 'rabbitmq', fingerprint: 'idem0001',
            declaredVia: 'inferred', host: `rabbitmq.idem.${TEST_DOMAIN}`,
            port: 5672, vhost: 'orders', fingerprintScope: 'global',
        }, COMMIT);

        const chUrn = await mergeMessageChannelWithKind(
            'tech-weld.idem.event', 'topic', 'symfony-messenger', COMMIT,
            { scope: 'physical', brokerUrn, confidence: 0.8, grounding: astGrounding('test@v1') },
        );

        await runChannelTechnologyWeld(COMMIT);
        await runChannelTechnologyWeld(COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (ch:MessageChannel {id: $id})
                 RETURN ch.technology AS tech, ch.evidence_extractors AS ext`,
                { id: chUrn },
            );
            expect(r.records[0].get('tech')).toBe('rabbitmq');
            const ext = r.records[0].get('ext') as string[] | null;
            expect(ext?.filter(x => x === 'channel-technology-welder@v1')).toHaveLength(1);
        } finally { await session.close(); }
    });
});
