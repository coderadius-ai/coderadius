import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import {
    bindBrokerCandidates,
    mergeBrokerCandidate,
} from '../../src/graph/mutations/broker-candidates.js';
import { mergeMessageBroker } from '../../src/graph/mutations/data-contracts.js';
import { astGrounding } from '../../src/graph/grounding.js';

// ═════════════════════════════════════════════════════════════════════════════
// s4 config-declared lane (B0/B2) — candidate → bind → mint chain.
//
// Pins: per-vhost brokers carry connectionName/sourceFile/sourceRepoUrn (the
// channel-binding join keys) with CLEAN ast grounding; sourceEnvKeys = [] for
// config candidates (never [null]); sourceType threads to the edge on EVERY
// bind path (a1 anchor included); mint ORDER (config before residual); the
// config-shadow rule; ledger-level merge of same-identity config+env hints.
// ═════════════════════════════════════════════════════════════════════════════

const PFX = 'cr://test/config-broker/';
const COMMIT = 'CONFIG_BROKER_TEST';
const RUN_MARKER = 'run-cfg-0001';
const HOST = 'bus.config-broker-test.acme.example';
const REPO = 'crtest/config-broker-repo';
const SOURCE_FILE = 'config/autoload/rabbitmq.global.php';

async function wipeFixture() {
    const session = getNeo4jSession();
    try {
        await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        await session.run('MATCH (c:BrokerCandidate) WHERE c.serviceUrn STARTS WITH $p DETACH DELETE c', { p: PFX });
        await session.run('MATCH (b:MessageBroker) WHERE b.host CONTAINS $h DETACH DELETE b', { h: 'config-broker-test.acme.example' });
    } finally { await session.close(); }
}

async function createService(urn: string, name: string) {
    const session = getNeo4jSession();
    try {
        await session.run(
            `CREATE (s:Service {id: $id})
             SET s.name = $name, s.valid_from_commit = $c, s.valid_to_commit = null`,
            { id: urn, name, c: COMMIT },
        );
    } finally { await session.close(); }
}

function configCandidate(overrides: Partial<Parameters<typeof mergeBrokerCandidate>[0]> & { serviceUrn: string }) {
    return {
        source: 's4-config-declared' as const,
        provider: 'rabbitmq' as const,
        providerSource: 'declared' as const,
        host: HOST,
        port: 5672,
        sourceType: 'config' as const,
        sourceFile: SOURCE_FILE,
        confidence: 'high' as const,
        repoUrn: REPO,
        ...overrides,
    };
}

describe('php-config broker candidates — s4 lane end-to-end', () => {
    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    it('mints one CLEAN broker per vhost with the channel-binding join keys on the node', async () => {
        const svc = `${PFX}service:platform-app`;
        await createService(svc, 'platform-app');

        await mergeBrokerCandidate(configCandidate({ serviceUrn: svc, vhost: 'acme', connectionName: 'default' }), COMMIT);
        await mergeBrokerCandidate(configCandidate({ serviceUrn: svc, vhost: 'acme/notifications', connectionName: 'notifications' }), COMMIT);
        await mergeBrokerCandidate(configCandidate({ serviceUrn: svc, vhost: '/', connectionName: 'payments' }), COMMIT);

        const result = await bindBrokerCandidates(COMMIT, { runMarker: RUN_MARKER });
        expect(result.createdConfigDeclared).toBe(3);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (b:MessageBroker) WHERE b.host = $h AND b.valid_to_commit IS NULL
                 RETURN b.vhost AS vhost, b.connectionName AS connectionName,
                        b.sourceFile AS sourceFile, b.sourceRepoUrn AS sourceRepoUrn,
                        b.declaredVia AS declaredVia, coalesce(b.needsReview, false) AS needsReview,
                        b.source AS source, b.quality AS quality
                 ORDER BY b.vhost`,
                { h: HOST },
            );
            expect(r.records).toHaveLength(3);
            const byConn = new Map(r.records.map(rec => [rec.get('connectionName'), rec]));
            expect([...byConn.keys()].sort()).toEqual(['default', 'notifications', 'payments']);
            for (const rec of r.records) {
                expect(rec.get('sourceFile')).toBe(SOURCE_FILE);
                expect(rec.get('sourceRepoUrn')).toBe(REPO);
                expect(rec.get('declaredVia')).toBe('config');
                expect(rec.get('needsReview')).toBe(false);
                expect(rec.get('source')).toBe('ast');
                expect(rec.get('quality')).toBe('high');
            }
            expect(byConn.get('default')!.get('vhost')).toBe('acme');
            expect(byConn.get('notifications')!.get('vhost')).toBe('acme/notifications');
            expect(byConn.get('payments')!.get('vhost')).toBe('/');

            // Edges carry source='config' (NOT env-var) + the run marker.
            const edges = await session.run(
                `MATCH (s:Service {id: $svc})-[rel:CONNECTS_TO]->(b:MessageBroker)
                 WHERE rel.valid_to_commit IS NULL
                 RETURN rel.source AS source, rel.via AS via, rel.lastSeenRun AS marker`,
                { svc },
            );
            expect(edges.records).toHaveLength(3);
            for (const rec of edges.records) {
                expect(rec.get('source')).toBe('config');
                expect(rec.get('via')).toBe('broker-candidate:s4-config-declared');
                expect(rec.get('marker')).toBe(RUN_MARKER);
            }
        } finally { await session.close(); }
    });

    it('config candidates persist sourceEnvKeys = [] (never [null]) before binding', async () => {
        const svc = `${PFX}service:platform-app`;
        await createService(svc, 'platform-app');
        await mergeBrokerCandidate(configCandidate({ serviceUrn: svc, vhost: 'acme', connectionName: 'default' }), COMMIT);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (c:BrokerCandidate) WHERE c.serviceUrn = $svc
                 RETURN c.sourceEnvKeys AS keys, c.sourceType AS sourceType, c.connectionName AS conn`,
                { svc },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('keys')).toEqual([]);
            expect(r.records[0].get('sourceType')).toBe('config');
            expect(r.records[0].get('conn')).toBe('default');
        } finally { await session.close(); }
    });

    it('accessor-default resolution (confidence medium) demotes quality one tier via applyFallback', async () => {
        const svc = `${PFX}service:platform-app`;
        await createService(svc, 'platform-app');
        await mergeBrokerCandidate(
            configCandidate({ serviceUrn: svc, vhost: 'acme', connectionName: 'default', confidence: 'medium' }),
            COMMIT,
        );
        await bindBrokerCandidates(COMMIT, { runMarker: RUN_MARKER });

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (b:MessageBroker) WHERE b.host = $h AND b.valid_to_commit IS NULL
                 RETURN b.quality AS quality, b.evidence_fallbacksApplied AS fallbacks,
                        coalesce(b.needsReview, false) AS needsReview`,
                { h: HOST },
            );
            expect(r.records).toHaveLength(1);
            expect(r.records[0].get('quality')).toBe('medium');
            expect(r.records[0].get('fallbacks')).toContain('accessor-default-resolution');
            expect(r.records[0].get('needsReview')).toBe(false);
        } finally { await session.close(); }
    });

    it('mint ORDER pin: an s3 residual in the SAME run stays needsReview while the config broker is clean', async () => {
        const svc = `${PFX}service:platform-app`;
        await createService(svc, 'platform-app');
        await mergeBrokerCandidate(configCandidate({ serviceUrn: svc, vhost: 'acme', connectionName: 'default' }), COMMIT);
        // s3 key-name residual on a DIFFERENT host — must mint its own
        // needsReview broker without contaminating the config one.
        await mergeBrokerCandidate({
            source: 's3-key-name',
            provider: 'rabbitmq',
            providerSource: 'key-name',
            host: 'legacy.config-broker-test.acme.example',
            port: 5672,
            sourceEnvKey: 'RABBITMQ_HOST',
            sourceType: 'env-var',
            sourceFile: '.env',
            confidence: 'high',
            serviceUrn: svc,
            repoUrn: REPO,
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT, { runMarker: RUN_MARKER });
        expect(result.createdConfigDeclared).toBe(1);
        expect(result.createdGuess).toBe(1);

        const session = getNeo4jSession();
        try {
            const config = await session.run(
                `MATCH (b:MessageBroker {host: $h}) WHERE b.valid_to_commit IS NULL
                 RETURN coalesce(b.needsReview, false) AS nr, b.quality AS q`,
                { h: HOST },
            );
            expect(config.records[0].get('nr')).toBe(false);
            expect(config.records[0].get('q')).toBe('high');

            const residual = await session.run(
                `MATCH (b:MessageBroker {host: $h}) WHERE b.valid_to_commit IS NULL
                 RETURN coalesce(b.needsReview, false) AS nr`,
                { h: 'legacy.config-broker-test.acme.example' },
            );
            expect(residual.records[0].get('nr')).toBe(true);
        } finally { await session.close(); }
    });

    it('config + env hints with the SAME identity merge at ledger level → ONE clean broker, no twin', async () => {
        const svc = `${PFX}service:platform-app`;
        await createService(svc, 'platform-app');
        // env s3 hint arrives FIRST; the config hint upgrades the SAME candidate
        // (identity: serviceUrn, host, port, vhost) to the s4 lane.
        await mergeBrokerCandidate({
            source: 's3-key-name',
            provider: 'rabbitmq',
            providerSource: 'key-name',
            host: HOST,
            port: 5672,
            vhost: 'acme',
            sourceEnvKey: 'RABBITMQ_HOST',
            sourceType: 'env-var',
            sourceFile: '.env',
            confidence: 'high',
            serviceUrn: svc,
            repoUrn: REPO,
        }, COMMIT);
        await mergeBrokerCandidate(configCandidate({ serviceUrn: svc, vhost: 'acme', connectionName: 'default' }), COMMIT);

        const result = await bindBrokerCandidates(COMMIT, { runMarker: RUN_MARKER });
        expect(result.createdConfigDeclared).toBe(1);
        expect(result.createdGuess).toBe(0);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (b:MessageBroker) WHERE b.host = $h AND b.valid_to_commit IS NULL
                 RETURN count(b) AS n, collect(coalesce(b.needsReview, false)) AS nrs,
                        collect(b.connectionName) AS conns`,
                { h: HOST },
            );
            expect(Number(r.records[0].get('n'))).toBe(1);
            expect(r.records[0].get('nrs')).toEqual([false]);
            expect(r.records[0].get('conns')).toEqual(['default']);
            // The env key is preserved on the merged candidate's audit trail →
            // verified indirectly: the single broker came from the s4 mint.
        } finally { await session.close(); }
    });

    it('a config candidate ANCHORING (a1) onto a pre-existing broker writes a CONFIG edge — sourceType threading pin', async () => {
        const svc = `${PFX}service:platform-app`;
        await createService(svc, 'platform-app');
        // Pre-existing guess broker with the same identity.
        await mergeMessageBroker({
            urn: 'cr:broker:rabbitmq:cfganchor01:acme',
            provider: 'rabbitmq', fingerprint: 'cfganchor01',
            declaredVia: 'inferred', host: HOST, port: 5672, vhost: 'acme',
            fingerprintScope: 'global',
            grounding: { source: 'heuristic', quality: 'low', evidence: { extractors: ['broker-key-name@guess'] }, needsReview: true },
        }, COMMIT);

        await mergeBrokerCandidate(configCandidate({ serviceUrn: svc, vhost: 'acme', connectionName: 'default' }), COMMIT);
        const result = await bindBrokerCandidates(COMMIT, { runMarker: RUN_MARKER });
        expect(result.boundExisting).toBe(1);
        expect(result.createdConfigDeclared).toBe(0);

        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (s:Service {id: $svc})-[rel:CONNECTS_TO]->(b:MessageBroker {id: 'cr:broker:rabbitmq:cfganchor01:acme'})
                 WHERE rel.valid_to_commit IS NULL
                 RETURN rel.source AS source, coalesce(b.needsReview, false) AS nr`,
                { svc },
            );
            expect(r.records).toHaveLength(1);
            // WITHOUT the threading fix this edge would be 'env-var' and the
            // reaper would tombstone it on the next run.
            expect(r.records[0].get('source')).toBe('config');
            // declared providerSource is contract-grade → cleans the guess broker.
            expect(r.records[0].get('nr')).toBe(false);
        } finally { await session.close(); }
    });

    it('config-shadow: a vhost-LESS s3 twin on a config-declared host does NOT mint; a vhost-BEARING env twin anchors (D0)', async () => {
        const svcApp = `${PFX}service:platform-app`;
        const svcEnvOnly = `${PFX}service:legacy-worker`;
        const svcNull = `${PFX}service:bare-reader`;
        await createService(svcApp, 'platform-app');
        await createService(svcEnvOnly, 'legacy-worker');
        await createService(svcNull, 'bare-reader');

        // Config candidates (3 vhosts) from the app service.
        await mergeBrokerCandidate(configCandidate({ serviceUrn: svcApp, vhost: 'acme', connectionName: 'default' }), COMMIT);
        await mergeBrokerCandidate(configCandidate({ serviceUrn: svcApp, vhost: '/', connectionName: 'payments' }), COMMIT);
        // s3 twin WITH matching vhost from another service of the SAME repo
        // (same-repo twins never converge) → must anchor onto the config
        // broker (Phase D0), not re-mint it with guess grounding.
        await mergeBrokerCandidate({
            source: 's3-key-name', provider: 'rabbitmq', providerSource: 'key-name',
            host: HOST, port: 5672, vhost: 'acme',
            sourceEnvKey: 'RABBITMQ_HOST', sourceType: 'env-var', sourceFile: '.env',
            confidence: 'high', serviceUrn: svcEnvOnly, repoUrn: REPO,
        }, COMMIT);
        // s3 twin with NO vhost → config-shadow: stays unbound, no vhost-less twin.
        await mergeBrokerCandidate({
            source: 's3-key-name', provider: 'rabbitmq', providerSource: 'key-name',
            host: HOST, port: 5672,
            sourceEnvKey: 'RABBITMQ_HOST', sourceType: 'env-var', sourceFile: '.env',
            confidence: 'high', serviceUrn: svcNull, repoUrn: REPO,
        }, COMMIT);

        const result = await bindBrokerCandidates(COMMIT, { runMarker: RUN_MARKER });
        expect(result.createdConfigDeclared).toBe(2);
        expect(result.convergedGuess).toBe(0); // same-repo twins never converge
        expect(result.shadowedByConfig).toBe(1);
        expect(result.createdGuess).toBe(0);
        expect(result.unbound).toBe(1);

        const session = getNeo4jSession();
        try {
            // No vhost-less broker exists on the host: exactly the 2 per-vhost ones.
            const r = await session.run(
                `MATCH (b:MessageBroker) WHERE b.host = $h AND b.valid_to_commit IS NULL
                 RETURN collect(b.vhost) AS vhosts, collect(coalesce(b.needsReview, false)) AS nrs`,
                { h: HOST },
            );
            expect((r.records[0].get('vhosts') as string[]).sort()).toEqual(['/', 'acme']);
            expect(r.records[0].get('nrs')).toEqual([false, false]);

            // The vhost-bearing env twin anchored: edge from legacy-worker, source env-var.
            const anchored = await session.run(
                `MATCH (s:Service {id: $svc})-[rel:CONNECTS_TO]->(b:MessageBroker {vhost: 'acme'})
                 WHERE rel.valid_to_commit IS NULL AND b.host = $h
                 RETURN rel.source AS source`,
                { svc: svcEnvOnly, h: HOST },
            );
            expect(anchored.records).toHaveLength(1);
            expect(anchored.records[0].get('source')).toBe('env-var');

            // The vhost-less candidate is still in the ledger (visible).
            const ledger = await session.run(
                `MATCH (c:BrokerCandidate) WHERE c.serviceUrn = $svc RETURN count(c) AS n`,
                { svc: svcNull },
            );
            expect(Number(ledger.records[0].get('n'))).toBe(1);
        } finally { await session.close(); }
    });
});
