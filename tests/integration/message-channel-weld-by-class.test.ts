import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { weldMessagePublishersByClass } from '../../src/graph/mutations/message-channels.js';

// Step C — Class-name bridge welding.
//
// After file processing, the LLM may have emitted a MessageChannel whose
// `name` is the bare CQRS class (e.g. `ProductQuoteMessage`) because the
// dispatch site couldn't be paired with the routing config in time. The
// welder uses a precomputed registry `Map<className, canonicalRoutingKey>`
// to redirect PUBLISHES_TO / LISTENS_TO edges from the class-name placeholder
// to the canonical channel, then tombstones the orphan.

describe('weldMessagePublishersByClass', () => {
    const PFX = 'cr://test/class-bridge/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally { await s.close(); }
    }

    async function makeFunction(id: string, name: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (f:Function {id: $id})
                 SET f.name = $name, f.valid_from_commit = 'TEST', f.valid_to_commit = null`,
                { id, name },
            );
        } finally { await s.close(); }
    }

    async function makeChannel(id: string, name: string, extra: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (c:MessageChannel {id: $id})
                 SET c.name = $name,
                     c.channelKind = $channelKind,
                     c.technology = $technology,
                     c.kindFamily = $kindFamily,
                     c.valid_from_commit = 'TEST',
                     c.valid_to_commit = null`,
                {
                    id,
                    name,
                    channelKind: extra.channelKind ?? 'topic',
                    technology: extra.technology ?? null,
                    kindFamily: extra.kindFamily ?? null,
                },
            );
        } finally { await s.close(); }
    }

    async function publishesTo(funcId: string, channelId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (f:Function {id: $fid}), (c:MessageChannel {id: $cid})
                 MERGE (f)-[r:PUBLISHES_TO]->(c)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: funcId, cid: channelId },
            );
        } finally { await s.close(); }
    }

    async function listensTo(funcId: string, channelId: string) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (f:Function {id: $fid}), (c:MessageChannel {id: $cid})
                 MERGE (f)-[r:LISTENS_TO]->(c)
                 ON CREATE SET r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { fid: funcId, cid: channelId },
            );
        } finally { await s.close(); }
    }

    async function countEdges(fid: string, cid: string, type: 'PUBLISHES_TO' | 'LISTENS_TO'): Promise<number> {
        const s = getNeo4jSession();
        try {
            const result = await s.run(
                `MATCH (f:Function {id: $fid})-[r:${type}]->(c:MessageChannel {id: $cid}) RETURN count(r) AS n`,
                { fid, cid },
            );
            return Number(result.records[0].get('n'));
        } finally { await s.close(); }
    }

    async function nodeExists(id: string): Promise<boolean> {
        const s = getNeo4jSession();
        try {
            const result = await s.run('MATCH (n:MessageChannel {id: $id}) RETURN count(n) AS n', { id });
            return Number(result.records[0].get('n')) > 0;
        } finally { await s.close(); }
    }

    async function readProp(id: string, prop: string): Promise<unknown> {
        const s = getNeo4jSession();
        try {
            const result = await s.run(`MATCH (n:MessageChannel {id: $id}) RETURN n.${prop} AS v`, { id });
            return result.records[0]?.get('v');
        } finally { await s.close(); }
    }

    beforeAll(async () => {
        await initSchema();
    });

    afterAll(async () => {
        await wipe();
        await closeNeo4j();
    });

    beforeEach(async () => {
        await wipe();
    });

    it('redirects PUBLISHES_TO edge from CQRS-class-name placeholder to canonical channel', async () => {
        const fnId = `${PFX}func/Dispatcher.send`;
        const placeholderId = `${PFX}channel/placeholder/ProductQuoteMessage`;
        await makeFunction(fnId, 'Dispatcher.send');
        await makeChannel(placeholderId, 'ProductQuoteMessage');
        await publishesTo(fnId, placeholderId);

        const registry = new Map<string, string>([
            ['ProductQuoteMessage', 'acme.inventory.quote.product.requested'],
        ]);
        const result = await weldMessagePublishersByClass(registry, 'TEST');

        expect(result.weldedEdges).toBe(1);

        // Find the canonical channel by name and verify the edge moved.
        const s = getNeo4jSession();
        try {
            const can = await s.run(
                `MATCH (c:MessageChannel {name: 'acme.inventory.quote.product.requested'}) RETURN c.id AS id`,
            );
            expect(can.records.length).toBe(1);
            const canonicalId = can.records[0].get('id') as string;
            expect(await countEdges(fnId, canonicalId, 'PUBLISHES_TO')).toBe(1);
            expect(await countEdges(fnId, placeholderId, 'PUBLISHES_TO')).toBe(0);
        } finally { await s.close(); }
    });

    it('redirects LISTENS_TO edges the same way', async () => {
        const fnId = `${PFX}func/Handler.__invoke`;
        const placeholderId = `${PFX}channel/placeholder/OrderCreatedEvent`;
        await makeFunction(fnId, 'Handler.__invoke');
        await makeChannel(placeholderId, 'OrderCreatedEvent');
        await listensTo(fnId, placeholderId);

        const registry = new Map<string, string>([
            ['OrderCreatedEvent', 'acme.orders.created'],
        ]);
        const result = await weldMessagePublishersByClass(registry, 'TEST');

        expect(result.weldedEdges).toBe(1);

        const s = getNeo4jSession();
        try {
            const can = await s.run(
                `MATCH (c:MessageChannel {name: 'acme.orders.created'}) RETURN c.id AS id`,
            );
            expect(can.records.length).toBe(1);
            const canonicalId = can.records[0].get('id') as string;
            expect(await countEdges(fnId, canonicalId, 'LISTENS_TO')).toBe(1);
        } finally { await s.close(); }
    });

    it('tombstones the class-name placeholder node after all edges are redirected', async () => {
        const fnId = `${PFX}func/Dispatcher.publish`;
        const placeholderId = `${PFX}channel/placeholder/QuoteRequestedEvent`;
        await makeFunction(fnId, 'Dispatcher.publish');
        await makeChannel(placeholderId, 'QuoteRequestedEvent');
        await publishesTo(fnId, placeholderId);

        const registry = new Map<string, string>([
            ['QuoteRequestedEvent', 'acme.quote.requested'],
        ]);
        const result = await weldMessagePublishersByClass(registry, 'TEST');

        expect(result.tombstonedPlaceholders).toBe(1);
        expect(await nodeExists(placeholderId)).toBe(false);
    });

    it('does NOT redirect when className has no entry in registry', async () => {
        const fnId = `${PFX}func/Dispatcher.send`;
        const placeholderId = `${PFX}channel/placeholder/UnknownMessage`;
        await makeFunction(fnId, 'Dispatcher.send');
        await makeChannel(placeholderId, 'UnknownMessage');
        await publishesTo(fnId, placeholderId);

        const registry = new Map<string, string>([
            ['OtherMessage', 'acme.other.topic'],
        ]);
        const result = await weldMessagePublishersByClass(registry, 'TEST');

        expect(result.weldedEdges).toBe(0);
        expect(await nodeExists(placeholderId)).toBe(true);
        expect(await countEdges(fnId, placeholderId, 'PUBLISHES_TO')).toBe(1);
    });

    it('preserves placeholder technology and kindFamily on the canonical channel', async () => {
        const fnId = `${PFX}func/Pub.send`;
        const placeholderId = `${PFX}channel/placeholder/InventoryUpdatedEvent`;
        await makeFunction(fnId, 'Pub.send');
        await makeChannel(placeholderId, 'InventoryUpdatedEvent', {
            technology: 'rabbitmq',
            kindFamily: 'broker',
        });
        await publishesTo(fnId, placeholderId);

        const registry = new Map<string, string>([
            ['InventoryUpdatedEvent', 'acme.inventory.updated'],
        ]);
        await weldMessagePublishersByClass(registry, 'TEST');

        const s = getNeo4jSession();
        try {
            const can = await s.run(
                `MATCH (c:MessageChannel {name: 'acme.inventory.updated'}) RETURN c.id AS id`,
            );
            expect(can.records.length).toBe(1);
            const canonicalId = can.records[0].get('id') as string;
            expect(await readProp(canonicalId, 'technology')).toBe('rabbitmq');
            expect(await readProp(canonicalId, 'kindFamily')).toBe('broker');
        } finally { await s.close(); }
    });
});
