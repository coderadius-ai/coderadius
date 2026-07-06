import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { deleteOrphanMessageChannels } from '../../src/graph/mutations/data-contracts.js';

// Config-declared channels (Laminas RabbitMqModule / Messenger transports)
// have no Function pub/sub edges until a weld connects them — the orphan
// reaper must spare a channel that a live StructuralFile DEFINES, exactly
// like the DataContainer GC spares migration-declared tables.

describe('deleteOrphanMessageChannels × StructuralFile liveness', () => {
    const PFX = 'cr://test/config-channel-liveness/';

    async function run(query: string, params: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try { return await s.run(query, params); } finally { await s.close(); }
    }

    async function wipe() {
        await run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('structural re-emission REVIVES a previously tombstoned channel (declaration asserts current existence)', async () => {
        const { mergeStructuralEntity } = await import('../../src/ingestion/structural/queries.js');
        const stf = `${PFX}stf-revive`;
        const chId = `${PFX}ch/revived`;
        await run(`CREATE (sf:StructuralFile {id: $stf}),
                          (:MessageChannel {id: $ch, name: 'acme.revived-exchange', valid_to_commit: 'SYSTEM'})`,
            { stf, ch: chId });

        await mergeStructuralEntity({
            id: chId,
            labels: ['MessageChannel'],
            properties: { name: 'acme.revived-exchange', channelKind: 'exchange', discoverySource: 'config' },
            relationshipType: 'DEFINES',
        }, stf);

        const rows = await run('MATCH (ch:MessageChannel {id: $ch}) RETURN ch.valid_to_commit AS dead', { ch: chId });
        expect(rows.records[0]!.get('dead')).toBeNull();
    });

    it('spares a config-declared channel (StructuralFile DEFINES), reaps the true orphan', async () => {
        await run(`
            CREATE (stf:StructuralFile {id: $stf}),
                   (declared:MessageChannel {id: $declared, name: 'acme.declared-exchange', valid_to_commit: null}),
                   (orphan:MessageChannel {id: $orphan, name: 'acme.orphan', valid_to_commit: null}),
                   (stf)-[:DEFINES]->(declared)
        `, { stf: `${PFX}stf`, declared: `${PFX}ch/declared`, orphan: `${PFX}ch/orphan` });

        await deleteOrphanMessageChannels('TEST');

        const rows = await run(
            `MATCH (ch:MessageChannel) WHERE ch.id STARTS WITH $p
             RETURN ch.id AS id, ch.valid_to_commit AS dead ORDER BY id`, { p: PFX });
        const byId = new Map(rows.records.map((r) => [r.get('id'), r.get('dead')]));
        expect(byId.get(`${PFX}ch/declared`)).toBeNull();      // survives
        expect(byId.get(`${PFX}ch/orphan`)).toBe('TEST');       // reaped
    });
});

describe('container name hygiene (reconcile pass)', () => {
    it('tombstones shape-invalid LIVE containers, spares real tables', async () => {
        const { tombstoneShapeInvalidDataContainers } = await import('../../src/ingestion/processors/container-name-hygiene.js');
        const PFX2 = 'cr://test/container-hygiene/';
        const run2 = async (q: string, p: Record<string, unknown> = {}) => {
            const s = getNeo4jSession();
            try { return await s.run(q, p); } finally { await s.close(); }
        };
        await run2('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX2 });
        await run2(`
            CREATE (:DataContainer {id: $a, name: 'SELECT 1', valid_to_commit: null}),
                   (:DataContainer {id: $b, name: 'doctrine.entitymanager.orm_default', valid_to_commit: null}),
                   (:DataContainer {id: $c, name: 'acme_orders', valid_to_commit: null})
        `, { a: `${PFX2}a`, b: `${PFX2}b`, c: `${PFX2}c` });

        const n = await tombstoneShapeInvalidDataContainers('TEST');
        expect(n).toBeGreaterThanOrEqual(2);

        const rows = await run2('MATCH (d:DataContainer) WHERE d.id STARTS WITH $p RETURN d.id AS id, d.valid_to_commit AS dead', { p: PFX2 });
        const byId = new Map(rows.records.map((r) => [r.get('id'), r.get('dead')]));
        expect(byId.get(`${PFX2}a`)).toBe('TEST');
        expect(byId.get(`${PFX2}b`)).toBe('TEST');
        expect(byId.get(`${PFX2}c`)).toBeNull();
        await run2('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX2 });
    });
});
