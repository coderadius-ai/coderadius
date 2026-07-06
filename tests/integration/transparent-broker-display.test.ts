import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    mergeMessageBroker,
    cleanupTransparentArtifacts,
} from '../../src/graph/mutations/data-contracts.js';
import {
    setUrnsTransparent,
    resetUrnTransparencyForTesting,
} from '../../src/utils/urn-transparency.js';

// ═════════════════════════════════════════════════════════════════════════════
// Fix 10 P2.5 — displayHost/displayVhost integration tests + cleanup helper.
// ═════════════════════════════════════════════════════════════════════════════

describe('mergeMessageBroker displayHost (Fix 10)', () => {
    const TEST_DOMAIN = 'transp-broker.acme.example';

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run(`MATCH (b:MessageBroker) WHERE b.host CONTAINS $domain DETACH DELETE b`, { domain: TEST_DOMAIN });
        } finally { await session.close(); }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); resetUrnTransparencyForTesting(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); resetUrnTransparencyForTesting(); });

    it('opaque mode: stores NORMALIZED host, NO displayHost / displayVhost', async () => {
        setUrnsTransparent(false);
        const urn = 'cr:broker:rabbitmq:opaque0a';
        await mergeMessageBroker({
            urn, provider: 'rabbitmq', fingerprint: 'opaque0a',
            declaredVia: 'inferred',
            host: `RabbitMQ.${TEST_DOMAIN}.`,  // raw: mixed case + trailing dot
            port: 5672, vhost: 'prod', fingerprintScope: 'global',
        }, 'C1');

        const s = getNeo4jSession();
        try {
            const r = await s.run(`MATCH (b:MessageBroker {id: $urn}) RETURN b.host AS host, b.displayHost AS dh, b.displayVhost AS dv`, { urn });
            // host stored normalized (lowercase, no trailing dot).
            expect(r.records[0].get('host')).toBe(`rabbitmq.${TEST_DOMAIN}`);
            // displayHost / displayVhost absent (PII protection).
            expect(r.records[0].get('dh')).toBeNull();
            expect(r.records[0].get('dv')).toBeNull();
        } finally { await s.close(); }
    });

    it('transparent mode: stores normalized host + original displayHost / displayVhost', async () => {
        setUrnsTransparent(true);
        const urn = 'cr:broker:rabbitmq:transp0a';
        await mergeMessageBroker({
            urn, provider: 'rabbitmq', fingerprint: 'transp0a',
            declaredVia: 'inferred',
            host: `RabbitMQ.${TEST_DOMAIN}.`,
            port: 5672, vhost: 'Prod', fingerprintScope: 'global',
        }, 'C1');

        const s = getNeo4jSession();
        try {
            const r = await s.run(`MATCH (b:MessageBroker {id: $urn}) RETURN b.host AS host, b.displayHost AS dh, b.displayVhost AS dv`, { urn });
            expect(r.records[0].get('host')).toBe(`rabbitmq.${TEST_DOMAIN}`);
            expect(r.records[0].get('dh')).toBe(`RabbitMQ.${TEST_DOMAIN}.`);  // original preserved
            expect(r.records[0].get('dv')).toBe('Prod');
        } finally { await s.close(); }
    });

    it('cleanupTransparentArtifacts removes displayHost from all brokers (idempotent)', async () => {
        setUrnsTransparent(true);
        const urn = 'cr:broker:rabbitmq:clean0a';
        await mergeMessageBroker({
            urn, provider: 'rabbitmq', fingerprint: 'clean0a',
            declaredVia: 'inferred',
            host: `original.${TEST_DOMAIN}`,
            port: 5672, vhost: 'OriginalVhost', fingerprintScope: 'global',
        }, 'C1');

        // Run cleanup.
        await cleanupTransparentArtifacts();

        const s = getNeo4jSession();
        try {
            const r = await s.run(`MATCH (b:MessageBroker {id: $urn}) RETURN b.displayHost AS dh, b.displayVhost AS dv`, { urn });
            expect(r.records[0].get('dh')).toBeNull();
            expect(r.records[0].get('dv')).toBeNull();
        } finally { await s.close(); }

        // Idempotent: second call doesn't throw.
        await cleanupTransparentArtifacts();
    });

    it('opaque mode after previous transparent run: subsequent merge removes stale displayHost', async () => {
        const urn = 'cr:broker:rabbitmq:toggle00';
        // Run 1: transparent → populates displayHost.
        setUrnsTransparent(true);
        await mergeMessageBroker({
            urn, provider: 'rabbitmq', fingerprint: 'toggle00',
            declaredVia: 'inferred',
            host: `host.${TEST_DOMAIN}`,
            port: 5672, vhost: 'v1', fingerprintScope: 'global',
        }, 'C1');

        // Run 2: opaque → must REMOVE displayHost.
        resetUrnTransparencyForTesting();
        setUrnsTransparent(false);
        await mergeMessageBroker({
            urn, provider: 'rabbitmq', fingerprint: 'toggle00',
            declaredVia: 'inferred',
            host: `host.${TEST_DOMAIN}`,
            port: 5672, vhost: 'v1', fingerprintScope: 'global',
        }, 'C2');

        const s = getNeo4jSession();
        try {
            const r = await s.run(`MATCH (b:MessageBroker {id: $urn}) RETURN b.displayHost AS dh`, { urn });
            expect(r.records[0].get('dh')).toBeNull();
        } finally { await s.close(); }
    });
});
