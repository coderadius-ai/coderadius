import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeMessageBroker } from '../../src/graph/mutations/data-contracts.js';
import { runChannelConnectionBinding } from '../../src/ingestion/processors/channel-connection-binding.js';
import { astGrounding } from '../../src/graph/grounding.js';

// ═════════════════════════════════════════════════════════════════════════════
// Channel ↔ connection binding (B6) — same-file join:
//   MessageChannel{connectionRef,_sourcePath} ↔ MessageBroker{connectionName,sourceFile}
// Pins: same-file binds HOSTED_ON + brokerUrn; an alias declared in ANOTHER
// file never binds (cross-file aliases are meaningless); >1 matching broker →
// skip (never blind); cross-repo same-path collisions are guarded by
// _repoUrn ↔ sourceRepoUrn.
// ═════════════════════════════════════════════════════════════════════════════

const COMMIT = 'CHCONN_TEST';
const HOST_FRAGMENT = 'chconn-test.acme.example';
const REPO = 'crtest/chconn-repo';
const FILE = 'config/autoload/rabbitmq.global.php';

async function wipeFixture() {
    const session = getNeo4jSession();
    try {
        await session.run(`MATCH (ch:MessageChannel) WHERE ch.name STARTS WITH 'chconn.test.' DETACH DELETE ch`);
        await session.run('MATCH (b:MessageBroker) WHERE b.host CONTAINS $h DETACH DELETE b', { h: HOST_FRAGMENT });
    } finally { await session.close(); }
}

async function createChannel(name: string, props: Record<string, unknown>) {
    const session = getNeo4jSession();
    try {
        await session.run(
            `CREATE (ch:MessageChannel {id: $id})
             SET ch.name = $name, ch.scope = 'physical', ch.channelKind = 'exchange',
                 ch.technology = 'rabbitmq', ch.discoverySource = 'config',
                 ch.valid_from_commit = $c, ch.valid_to_commit = null,
                 ch += $props`,
            { id: `cr:channel:exchange:${name}`, name, c: COMMIT, props },
        );
    } finally { await session.close(); }
}

async function createBroker(urn: string, vhost: string, joinProps: Record<string, unknown>) {
    await mergeMessageBroker({
        urn, provider: 'rabbitmq', fingerprint: urn.split(':')[3]!,
        declaredVia: 'config', host: `bus.${HOST_FRAGMENT}`, port: 5672, vhost,
        fingerprintScope: 'global',
        connectionName: joinProps.connectionName as string | undefined,
        sourceFile: joinProps.sourceFile as string | undefined,
        sourceRepoUrn: joinProps.sourceRepoUrn as string | undefined,
        grounding: astGrounding('php-config-array@v1'),
    }, COMMIT);
}

async function channelBinding(name: string): Promise<{ brokerUrn: string | null; hostedOn: string[] }> {
    const session = getNeo4jSession();
    try {
        const r = await session.run(
            `MATCH (ch:MessageChannel {id: $id})
             OPTIONAL MATCH (ch)-[h:HOSTED_ON]->(b:MessageBroker)
             WHERE h.valid_to_commit IS NULL
             RETURN ch.brokerUrn AS brokerUrn, collect(b.id) AS hostedOn`,
            { id: `cr:channel:exchange:${name}` },
        );
        return {
            brokerUrn: (r.records[0]?.get('brokerUrn') as string | null) ?? null,
            hostedOn: (r.records[0]?.get('hostedOn') as string[]) ?? [],
        };
    } finally { await session.close(); }
}

describe('channel-connection binding — same-file join', () => {
    beforeAll(async () => { await initSchema({ silent: true }); await wipeFixture(); });
    afterAll(async () => { await wipeFixture(); await closeNeo4j(); });
    beforeEach(async () => { await wipeFixture(); });

    it('binds each channel to the broker of ITS connection (per-vhost correctness)', async () => {
        await createBroker('cr:broker:rabbitmq:chconn01:acme', 'acme',
            { connectionName: 'default', sourceFile: FILE, sourceRepoUrn: REPO });
        await createBroker('cr:broker:rabbitmq:chconn01:acme-notifications', 'acme/notifications',
            { connectionName: 'notifications', sourceFile: FILE, sourceRepoUrn: REPO });

        await createChannel('chconn.test.order-events',
            { connectionRef: 'default', _sourcePath: FILE, _repoUrn: `cr:repository:${REPO}` });
        await createChannel('chconn.test.notifications',
            { connectionRef: 'notifications', _sourcePath: FILE, _repoUrn: `cr:repository:${REPO}` });

        const result = await runChannelConnectionBinding(COMMIT);
        expect(result.bound).toBe(2);
        expect(result.ambiguous).toBe(0);

        const orderEvents = await channelBinding('chconn.test.order-events');
        expect(orderEvents.brokerUrn).toBe('cr:broker:rabbitmq:chconn01:acme');
        expect(orderEvents.hostedOn).toEqual(['cr:broker:rabbitmq:chconn01:acme']);

        const notifications = await channelBinding('chconn.test.notifications');
        expect(notifications.brokerUrn).toBe('cr:broker:rabbitmq:chconn01:acme-notifications');
        expect(notifications.hostedOn).toEqual(['cr:broker:rabbitmq:chconn01:acme-notifications']);
    });

    it('a same-named alias declared in ANOTHER file does NOT bind (cross-file aliases are meaningless)', async () => {
        await createBroker('cr:broker:rabbitmq:chconn02:acme', 'acme',
            { connectionName: 'default', sourceFile: 'apps/other/config/rabbitmq.php', sourceRepoUrn: REPO });
        await createChannel('chconn.test.orphan',
            { connectionRef: 'default', _sourcePath: FILE, _repoUrn: `cr:repository:${REPO}` });

        const result = await runChannelConnectionBinding(COMMIT);
        expect(result.bound).toBe(0);

        const orphan = await channelBinding('chconn.test.orphan');
        expect(orphan.brokerUrn).toBeNull();
        expect(orphan.hostedOn).toEqual([]);
    });

    it('>1 matching broker → skip, never a blind bind', async () => {
        // Two brokers improbably sharing connectionName+sourceFile (e.g. a
        // half-migrated graph): the join must refuse to choose.
        await createBroker('cr:broker:rabbitmq:chconn03:acme', 'acme',
            { connectionName: 'default', sourceFile: FILE, sourceRepoUrn: REPO });
        await createBroker('cr:broker:rabbitmq:chconn03b:acme', 'acme-b',
            { connectionName: 'default', sourceFile: FILE, sourceRepoUrn: REPO });
        await createChannel('chconn.test.ambiguous',
            { connectionRef: 'default', _sourcePath: FILE, _repoUrn: `cr:repository:${REPO}` });

        const result = await runChannelConnectionBinding(COMMIT);
        expect(result.bound).toBe(0);
        expect(result.ambiguous).toBe(1);
        expect((await channelBinding('chconn.test.ambiguous')).brokerUrn).toBeNull();
    });

    it('cross-repo guard: same relative path + connection name in ANOTHER repo does not bind', async () => {
        await createBroker('cr:broker:rabbitmq:chconn04:acme', 'acme',
            { connectionName: 'default', sourceFile: FILE, sourceRepoUrn: 'crtest/other-repo' });
        await createChannel('chconn.test.crossrepo',
            { connectionRef: 'default', _sourcePath: FILE, _repoUrn: `cr:repository:${REPO}` });

        const result = await runChannelConnectionBinding(COMMIT);
        expect(result.bound).toBe(0);
        expect((await channelBinding('chconn.test.crossrepo')).brokerUrn).toBeNull();
    });

    it('idempotent: re-running re-touches the same edge without duplicates', async () => {
        await createBroker('cr:broker:rabbitmq:chconn05:acme', 'acme',
            { connectionName: 'default', sourceFile: FILE, sourceRepoUrn: REPO });
        await createChannel('chconn.test.idem',
            { connectionRef: 'default', _sourcePath: FILE, _repoUrn: `cr:repository:${REPO}` });

        expect((await runChannelConnectionBinding(COMMIT)).bound).toBe(1);
        expect((await runChannelConnectionBinding(COMMIT)).bound).toBe(1);
        expect((await channelBinding('chconn.test.idem')).hostedOn).toHaveLength(1);
    });
});
