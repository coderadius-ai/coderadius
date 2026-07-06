import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { deduplicateMessageChannelsBySuffix, resolveDynamicInfrastructure } from '../../src/ingestion/processors/dynamic-infra-resolver.js';
import type { ProgressReporter } from '../../src/ingestion/core/progress.js';

const NOOP_REPORTER: ProgressReporter = {
    report: () => {},
    warn: () => {},
    error: () => {},
} as any;

// ─── Cat D: MessageChannel suffix dedup ──────────────────────────────────────
//
// Orchestrator scenario: a publisher in one Service emits the fully-qualified
// routing key (DI-resolved from a config), while a consumer `__invoke` handler
// in the same Service emits just the truncated stem (LLM derives it from the
// class name). After dynamic-infra-resolver normalizes any {envSuffix}, both
// nodes are concrete. This step welds the short consumer-side node into the
// long publisher-side node so the graph shows a single canonical channel.

describe('deduplicateMessageChannelsBySuffix', () => {
    const PFX = 'cr://test/channel-dedup/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
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

    async function makeChannel(id: string, name: string, channelKind: string | null = 'topic') {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (c:MessageChannel {id: $id})
                 SET c.name = $name, c.channelKind = $kind, c.valid_from_commit = 'TEST', c.valid_to_commit = null`,
                { id, name, kind: channelKind },
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

    it('welds a short consumer channel into the long publisher channel within the same service', async () => {
        const svcId = `${PFX}svc/inventory`;
        const fnPubId = `${PFX}func/QuoteController.handle`;
        const fnConId = `${PFX}func/QuoteHandler.__invoke`;
        const longId = `${PFX}channel/topic/acme.inventory.quote.requested`;
        const shortId = `${PFX}channel/topic/quote.requested`;

        await makeService(svcId, 'inventory');
        await makeFunction(fnPubId, svcId, 'QuoteController.handle');
        await makeFunction(fnConId, svcId, 'QuoteHandler.__invoke');
        await makeChannel(longId, 'acme.inventory.quote.requested', 'topic');
        await makeChannel(shortId, 'quote.requested', 'topic');
        await publishesTo(fnPubId, longId);
        await listensTo(fnConId, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(1);

        const s = getNeo4jSession();
        try {
            // Short node is gone
            const shortRes = await s.run(
                'MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id',
                { id: shortId },
            );
            expect(shortRes.records.length).toBe(0);

            // Long node still has both edges (publisher + rewired consumer)
            const edgesRes = await s.run(
                `MATCH (f:Function)-[r:PUBLISHES_TO|LISTENS_TO]->(c:MessageChannel {id: $id})
                 RETURN f.id AS fid, type(r) AS rtype
                 ORDER BY fid`,
                { id: longId },
            );
            const edges = edgesRes.records.map(r => ({ fid: r.get('fid'), rtype: r.get('rtype') }));
            expect(edges).toHaveLength(2);
            expect(edges).toContainEqual({ fid: fnPubId, rtype: 'PUBLISHES_TO' });
            expect(edges).toContainEqual({ fid: fnConId, rtype: 'LISTENS_TO' });
        } finally { await s.close(); }
    });

    it('does NOT weld pairs that lack a shared service', async () => {
        const svcAId = `${PFX}svc/serviceA`;
        const svcBId = `${PFX}svc/serviceB`;
        const fnAId = `${PFX}func/A.publish`;
        const fnBId = `${PFX}func/B.consume`;
        const longId = `${PFX}channel/topic/acme.extra.quote.requested`;
        const shortId = `${PFX}channel/topic/quote.requested`;

        await makeService(svcAId, 'serviceA');
        await makeService(svcBId, 'serviceB');
        await makeFunction(fnAId, svcAId, 'A.publish');
        await makeFunction(fnBId, svcBId, 'B.consume');
        await makeChannel(longId, 'acme.extra.quote.requested', 'topic');
        await makeChannel(shortId, 'quote.requested', 'topic');
        await publishesTo(fnAId, longId);
        await listensTo(fnBId, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run(
                'MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id',
                { id: shortId },
            );
            expect(shortRes.records.length).toBe(1);
        } finally { await s.close(); }
    });

    it('does NOT weld when multiple long candidates exist (ambiguous)', async () => {
        const svcId = `${PFX}svc/multi`;
        const fnPubAId = `${PFX}func/PubA.handle`;
        const fnPubBId = `${PFX}func/PubB.handle`;
        const fnConId = `${PFX}func/Consumer.__invoke`;
        const longAId = `${PFX}channel/topic/svc-a.quote.requested`;
        const longBId = `${PFX}channel/topic/svc-b.quote.requested`;
        const shortId = `${PFX}channel/topic/quote.requested`;

        await makeService(svcId, 'multi');
        await makeFunction(fnPubAId, svcId, 'PubA.handle');
        await makeFunction(fnPubBId, svcId, 'PubB.handle');
        await makeFunction(fnConId, svcId, 'Consumer.__invoke');
        await makeChannel(longAId, 'svc-a.quote.requested', 'topic');
        await makeChannel(longBId, 'svc-b.quote.requested', 'topic');
        await makeChannel(shortId, 'quote.requested', 'topic');
        await publishesTo(fnPubAId, longAId);
        await publishesTo(fnPubBId, longBId);
        await listensTo(fnConId, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run(
                'MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id',
                { id: shortId },
            );
            expect(shortRes.records.length).toBe(1);
        } finally { await s.close(); }
    });

    it('does NOT weld when channelKind differs', async () => {
        const svcId = `${PFX}svc/kind-mismatch`;
        const fnPubId = `${PFX}func/Pub.handle`;
        const fnConId = `${PFX}func/Con.__invoke`;
        const longId = `${PFX}channel/topic/acme.inventory.quote.requested`;
        const shortId = `${PFX}channel/queue/quote.requested`;

        await makeService(svcId, 'kind-mismatch');
        await makeFunction(fnPubId, svcId, 'Pub.handle');
        await makeFunction(fnConId, svcId, 'Con.__invoke');
        await makeChannel(longId, 'acme.inventory.quote.requested', 'topic');
        await makeChannel(shortId, 'quote.requested', 'queue');
        await publishesTo(fnPubId, longId);
        await listensTo(fnConId, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run(
                'MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id',
                { id: shortId },
            );
            expect(shortRes.records.length).toBe(1);
        } finally { await s.close(); }
    });

    it('welds short embedded as a non-suffix segment run (quote.product ⊂ acme.inventory.quote.product.requested)', async () => {
        // Scenario: handler emits `quote.product` (LLM derives from
        // ProductQuoteHandler class name, dropping the trailing `.requested`),
        // publisher emits `acme.inventory.quote.product.requested` (DI-resolved).
        // The short is NOT a pure suffix of the long: `.requested` follows the
        // match. Same logical channel, weld required.
        const svcId = `${PFX}svc/non-suffix`;
        const fnPubId = `${PFX}func/PubProduct.handle`;
        const fnConId = `${PFX}func/ProductQuoteHandler.__invoke`;
        const longId = `${PFX}channel/topic/acme.inventory.quote.product.requested`;
        const shortId = `${PFX}channel/topic/quote.product`;

        await makeService(svcId, 'non-suffix');
        await makeFunction(fnPubId, svcId, 'PubProduct.handle');
        await makeFunction(fnConId, svcId, 'ProductQuoteHandler.__invoke');
        await makeChannel(longId, 'acme.inventory.quote.product.requested', 'topic');
        await makeChannel(shortId, 'quote.product', 'topic');
        await publishesTo(fnPubId, longId);
        await listensTo(fnConId, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(1);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run(
                'MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id',
                { id: shortId },
            );
            expect(shortRes.records.length).toBe(0);

            const edges = await s.run(
                `MATCH (f:Function)-[r:PUBLISHES_TO|LISTENS_TO]->(c:MessageChannel {id: $id})
                 RETURN f.id AS fid, type(r) AS rtype ORDER BY fid`,
                { id: longId },
            );
            const result = edges.records.map(r => ({ fid: r.get('fid'), rtype: r.get('rtype') }));
            expect(result).toHaveLength(2);
            expect(result).toContainEqual({ fid: fnPubId, rtype: 'PUBLISHES_TO' });
            expect(result).toContainEqual({ fid: fnConId, rtype: 'LISTENS_TO' });
        } finally { await s.close(); }
    });

    it('welds short embedded mid-string (save.product ⊂ acme.inventory.save.product.requested)', async () => {
        const svcId = `${PFX}svc/non-suffix2`;
        const fnPubId = `${PFX}func/PubSave.handle`;
        const fnConId = `${PFX}func/ProductSaveHandler.__invoke`;
        const longId = `${PFX}channel/topic/acme.inventory.save.product.requested`;
        const shortId = `${PFX}channel/topic/save.product`;

        await makeService(svcId, 'non-suffix2');
        await makeFunction(fnPubId, svcId, 'PubSave.handle');
        await makeFunction(fnConId, svcId, 'ProductSaveHandler.__invoke');
        await makeChannel(longId, 'acme.inventory.save.product.requested', 'topic');
        await makeChannel(shortId, 'save.product', 'topic');
        await publishesTo(fnPubId, longId);
        await listensTo(fnConId, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(1);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run('MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id', { id: shortId });
            expect(shortRes.records.length).toBe(0);
        } finally { await s.close(); }
    });

    it('does NOT weld when the short matches a partial segment (NOT segment-aligned)', async () => {
        // `quote.req` is a substring of `acme.inventory.quote.requested.handler`
        // BUT `req` is not a complete segment, should NOT be welded
        // (segment-boundary requirement protects against false positives).
        const svcId = `${PFX}svc/partial`;
        const fnPubId = `${PFX}func/Pub.handle`;
        const fnConId = `${PFX}func/Con.handle`;
        const longId = `${PFX}channel/topic/acme.inventory.quote.requested.handler`;
        const shortId = `${PFX}channel/topic/quote.req`;

        await makeService(svcId, 'partial');
        await makeFunction(fnPubId, svcId, 'Pub.handle');
        await makeFunction(fnConId, svcId, 'Con.handle');
        await makeChannel(longId, 'acme.inventory.quote.requested.handler', 'topic');
        await makeChannel(shortId, 'quote.req', 'topic');
        await publishesTo(fnPubId, longId);
        await listensTo(fnConId, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run('MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id', { id: shortId });
            expect(shortRes.records.length).toBe(1);
        } finally { await s.close(); }
    });

    it('does NOT weld when the short matches AMBIGUOUSLY in two long candidates (different starts)', async () => {
        // If `quote.product` could fit at TWO segment positions across multiple
        // long candidates, skip (defense against guessing the wrong canonical).
        const svcId = `${PFX}svc/ambiguous-segment`;
        const fnP1 = `${PFX}func/P1.handle`;
        const fnP2 = `${PFX}func/P2.handle`;
        const fnCon = `${PFX}func/Con.__invoke`;
        const long1Id = `${PFX}channel/topic/acme.inventory.quote.product.requested`;
        const long2Id = `${PFX}channel/topic/svc-b.quote.product.requested`;
        const shortId = `${PFX}channel/topic/quote.product`;

        await makeService(svcId, 'ambiguous-segment');
        await makeFunction(fnP1, svcId, 'P1.handle');
        await makeFunction(fnP2, svcId, 'P2.handle');
        await makeFunction(fnCon, svcId, 'Con.__invoke');
        await makeChannel(long1Id, 'acme.inventory.quote.product.requested', 'topic');
        await makeChannel(long2Id, 'svc-b.quote.product.requested', 'topic');
        await makeChannel(shortId, 'quote.product', 'topic');
        await publishesTo(fnP1, long1Id);
        await publishesTo(fnP2, long2Id);
        await listensTo(fnCon, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run('MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id', { id: shortId });
            expect(shortRes.records.length).toBe(1);
        } finally { await s.close(); }
    });

    // ─── matchStart >= 2 guard ──────────────────────────────────────────────
    // Both `save.requested` (2 segments) and `update.save.requested` (3 segments)
    // are LLM-derived stems with NO service-namespace prefix. Without the
    // matchStart>=2 guard, the welder would treat `update.save.requested` as
    // a "long canonical" and fuse `save.requested` into it — incorrectly
    // conflating two distinct logical channels. A real canonical has at least
    // two prefix segments before the matched portion (e.g. `acme.inventory`).
    it('does NOT weld save.requested into update.save.requested (both are stems, matchStart=1)', async () => {
        const svcId = `${PFX}svc/two-stems`;
        const fnSaveId = `${PFX}func/SaveHandler.__invoke`;
        const fnUpdSaveId = `${PFX}func/UpdateSaveHandler.__invoke`;
        const longId = `${PFX}channel/queue/update.save.requested`;
        const shortId = `${PFX}channel/queue/save.requested`;

        await makeService(svcId, 'two-stems');
        await makeFunction(fnSaveId, svcId, 'SaveHandler.__invoke');
        await makeFunction(fnUpdSaveId, svcId, 'UpdateSaveHandler.__invoke');
        await makeChannel(longId, 'update.save.requested', 'queue');
        await makeChannel(shortId, 'save.requested', 'queue');
        await listensTo(fnSaveId, shortId);
        await listensTo(fnUpdSaveId, longId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            // Both nodes must survive — they represent different canonicals
            const shortRes = await s.run(
                'MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id',
                { id: shortId },
            );
            expect(shortRes.records.length).toBe(1);
            const longRes = await s.run(
                'MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id',
                { id: longId },
            );
            expect(longRes.records.length).toBe(1);
            // Edge mappings must remain intact
            const saveEdges = await s.run(
                `MATCH (f:Function {id: $fid})-[r:LISTENS_TO]->(c:MessageChannel {id: $cid})
                 RETURN count(r) AS n`,
                { fid: fnSaveId, cid: shortId },
            );
            expect(Number(saveEdges.records[0].get('n'))).toBe(1);
        } finally { await s.close(); }
    });

    it('does NOT weld single-word stems (avoid promoting "events" into "acme.api.events")', async () => {
        const svcId = `${PFX}svc/single-word`;
        const fnPubId = `${PFX}func/Pub.handle`;
        const fnConId = `${PFX}func/Con.handle`;
        const longId = `${PFX}channel/topic/acme.api.events`;
        const shortId = `${PFX}channel/topic/events`;

        await makeService(svcId, 'single-word');
        await makeFunction(fnPubId, svcId, 'Pub.handle');
        await makeFunction(fnConId, svcId, 'Con.handle');
        await makeChannel(longId, 'acme.api.events', 'topic');
        await makeChannel(shortId, 'events', 'topic');
        await publishesTo(fnPubId, longId);
        await listensTo(fnConId, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run(
                'MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id',
                { id: shortId },
            );
            expect(shortRes.records.length).toBe(1);
        } finally { await s.close(); }
    });

    // ─── Shared-prefix sibling welds (Fix 2b) ───────────────────────────────
    // Today the welder requires a UNIQUE long candidate per short. When the
    // consumer-derived stem matches multiple sibling long names that share the
    // same prefix (e.g. `quote.product` matches both
    // `acme.inventory.quote.product.requested` and ...completed), the welder
    // bails defensively. The new behaviour: when ALL long candidates share the
    // SAME prefix up to the match start AND the same matchStart, weld short to
    // each. Mismatched prefix or mismatched depth still blocks the weld
    // (ambiguous identity).

    it('welds to multiple sibling longs with identical prefix and matchStart', async () => {
        const svcId = `${PFX}svc/sibling-prefix`;
        const fnPubReq = `${PFX}func/PubReq.handle`;
        const fnPubCmp = `${PFX}func/PubCmp.handle`;
        const fnCon = `${PFX}func/ProductHandler.__invoke`;
        const longReqId = `${PFX}channel/topic/acme.inventory.quote.product.requested`;
        const longCmpId = `${PFX}channel/topic/acme.inventory.quote.product.completed`;
        const shortId = `${PFX}channel/topic/quote.product`;

        await makeService(svcId, 'sibling-prefix');
        await makeFunction(fnPubReq, svcId, 'PubReq.handle');
        await makeFunction(fnPubCmp, svcId, 'PubCmp.handle');
        await makeFunction(fnCon, svcId, 'ProductHandler.__invoke');
        await makeChannel(longReqId, 'acme.inventory.quote.product.requested', 'topic');
        await makeChannel(longCmpId, 'acme.inventory.quote.product.completed', 'topic');
        await makeChannel(shortId, 'quote.product', 'topic');
        await publishesTo(fnPubReq, longReqId);
        await publishesTo(fnPubCmp, longCmpId);
        await listensTo(fnCon, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(2);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run('MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id', { id: shortId });
            expect(shortRes.records.length).toBe(0);
            // The consumer LISTENS_TO edge survives, redirected to BOTH longs.
            const consumerEdges = await s.run(
                `MATCH (f:Function {id: $fid})-[:LISTENS_TO]->(c:MessageChannel)
                 RETURN c.id AS id ORDER BY c.id`,
                { fid: fnCon },
            );
            const ids = consumerEdges.records.map(r => r.get('id'));
            expect(ids).toContain(longReqId);
            expect(ids).toContain(longCmpId);
        } finally { await s.close(); }
    });

    it('does NOT weld when sibling longs have different matchStart (different depth)', async () => {
        const svcId = `${PFX}svc/different-depth`;
        const fnP1 = `${PFX}func/P1.handle`;
        const fnP2 = `${PFX}func/P2.handle`;
        const fnCon = `${PFX}func/Con.handle`;
        // matchStart=2 for the first (acme.inventory.quote.product.requested)
        // matchStart=3 for the second (svc-b.inventory.acme.quote.product)
        const long1Id = `${PFX}channel/topic/acme.inventory.quote.product.requested`;
        const long2Id = `${PFX}channel/topic/svc-b.inventory.acme.quote.product`;
        const shortId = `${PFX}channel/topic/quote.product`;

        await makeService(svcId, 'different-depth');
        await makeFunction(fnP1, svcId, 'P1.handle');
        await makeFunction(fnP2, svcId, 'P2.handle');
        await makeFunction(fnCon, svcId, 'Con.handle');
        await makeChannel(long1Id, 'acme.inventory.quote.product.requested', 'topic');
        await makeChannel(long2Id, 'svc-b.inventory.acme.quote.product', 'topic');
        await makeChannel(shortId, 'quote.product', 'topic');
        await publishesTo(fnP1, long1Id);
        await publishesTo(fnP2, long2Id);
        await listensTo(fnCon, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run('MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id', { id: shortId });
            expect(shortRes.records.length).toBe(1);
        } finally { await s.close(); }
    });

    it('does NOT weld when sibling longs share matchStart but different prefix', async () => {
        const svcId = `${PFX}svc/different-prefix`;
        const fnP1 = `${PFX}func/P1.handle`;
        const fnP2 = `${PFX}func/P2.handle`;
        const fnCon = `${PFX}func/Con.handle`;
        // Both match at matchStart=2 but prefixes differ:
        // ['acme','inventory'] vs ['svc-b','ops']
        const long1Id = `${PFX}channel/topic/acme.inventory.quote.product.requested`;
        const long2Id = `${PFX}channel/topic/svc-b.ops.quote.product.requested`;
        const shortId = `${PFX}channel/topic/quote.product`;

        await makeService(svcId, 'different-prefix');
        await makeFunction(fnP1, svcId, 'P1.handle');
        await makeFunction(fnP2, svcId, 'P2.handle');
        await makeFunction(fnCon, svcId, 'Con.handle');
        await makeChannel(long1Id, 'acme.inventory.quote.product.requested', 'topic');
        await makeChannel(long2Id, 'svc-b.ops.quote.product.requested', 'topic');
        await makeChannel(shortId, 'quote.product', 'topic');
        await publishesTo(fnP1, long1Id);
        await publishesTo(fnP2, long2Id);
        await listensTo(fnCon, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);

        const s = getNeo4jSession();
        try {
            const shortRes = await s.run('MATCH (c:MessageChannel {id: $id}) RETURN c.id AS id', { id: shortId });
            expect(shortRes.records.length).toBe(1);
        } finally { await s.close(); }
    });

    it('does NOT weld single-segment stem even when sibling prefix is shared', async () => {
        // Safeguard: the existing "stem must be multi-segment" rule still holds
        // (dot-required check). A single-word stem like "quote" is too generic
        // even when all long candidates share a clean prefix.
        const svcId = `${PFX}svc/single-with-shared-prefix`;
        const fnP1 = `${PFX}func/P1.handle`;
        const fnP2 = `${PFX}func/P2.handle`;
        const fnCon = `${PFX}func/Con.handle`;
        const long1Id = `${PFX}channel/topic/acme.inventory.quote.requested`;
        const long2Id = `${PFX}channel/topic/acme.inventory.quote.completed`;
        const shortId = `${PFX}channel/topic/quote`;

        await makeService(svcId, 'single-with-shared-prefix');
        await makeFunction(fnP1, svcId, 'P1.handle');
        await makeFunction(fnP2, svcId, 'P2.handle');
        await makeFunction(fnCon, svcId, 'Con.handle');
        await makeChannel(long1Id, 'acme.inventory.quote.requested', 'topic');
        await makeChannel(long2Id, 'acme.inventory.quote.completed', 'topic');
        await makeChannel(shortId, 'quote', 'topic');
        await publishesTo(fnP1, long1Id);
        await publishesTo(fnP2, long2Id);
        await listensTo(fnCon, shortId);

        const welded = await deduplicateMessageChannelsBySuffix();
        expect(welded).toBe(0);
    });
});

// ─── promoteStubToConcreteNode: URN namespace for MessageChannel ─────────────
//
// Bug fix: when a MessageChannel stub like
//   cr:channel:topic:acme.inventory{envSuffix}.quote.requested
// is normalized via env-placeholder stripping, the resulting node MUST keep the
// canonical kinded URN (`cr:channel:<kind>:<name>`), same shape produced by
// linkFunctionToBroker / mergeMessageChannelWithKind. Previously the resolver
// rebuilt the URN with `buildUrn(nodeType.toLowerCase(), newName)` producing
// the un-kinded `cr:messagechannel:acme.inventory.quote.requested`, which then
// never matched concrete consumer-side nodes (kinded URN) and got tombstoned
// by deleteOrphanMessageChannels.

describe('resolveDynamicInfrastructure: MessageChannel URN namespace', () => {
    const PFX = 'cr://test/promote-urn/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            // Wipe both the stub prefix AND any nodes that may be created by promotion
            // (URNs change after promotion, so they don't share the PFX).
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
            await s.run(
                'MATCH (n:MessageChannel) WHERE n.name STARTS WITH "acme.inventory.promote-test" DETACH DELETE n',
            );
        } finally { await s.close(); }
    }

    async function makeStub(id: string, name: string, channelKind: string | null) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (c:MessageChannel:UnresolvedDynamicNode {id: $id})
                 SET c.name = $name, c.channelKind = $kind, c.unresolved = true,
                     c.valid_from_commit = 'TEST', c.valid_to_commit = null`,
                { id, name, kind: channelKind },
            );
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('promotes a topic-kinded stub to a kinded URN (cr:channel:topic:<name>)', async () => {
        // Stub URN as it would be written by linkFunctionToBroker for a publisher
        // emitting `acme.inventory{envSuffix}.promote-test.quote.requested` with
        // channelKind=topic. The URN already follows the kinded convention.
        const stubId = `${PFX}cr:channel:topic:acme.inventory{envSuffix}.promote-test.quote.requested`;
        await makeStub(stubId, 'acme.inventory{envSuffix}.promote-test.quote.requested', 'topic');

        await resolveDynamicInfrastructure(NOOP_REPORTER);

        const s = getNeo4jSession();
        try {
            // Expected: kinded URN survives.
            const expected = await s.run(
                'MATCH (c:MessageChannel {id: "cr:channel:topic:acme.inventory.promote-test.quote.requested"}) RETURN c.name AS name, c.channelKind AS kind',
            );
            expect(expected.records.length).toBe(1);
            expect(expected.records[0].get('name')).toBe('acme.inventory.promote-test.quote.requested');
            expect(expected.records[0].get('kind')).toBe('topic');

            // Bug regression: un-kinded URN must NOT exist.
            const wrong = await s.run(
                'MATCH (c:MessageChannel {id: "cr:messagechannel:acme.inventory.promote-test.quote.requested"}) RETURN c.id AS id',
            );
            expect(wrong.records.length).toBe(0);
        } finally { await s.close(); }
    });

    it('promotes a subscription-kinded stub to a sub-prefixed URN (cr:channel:sub:<name>)', async () => {
        // Subscriptions use `sub` not `subscription` in URN per buildMessageChannelUrn.
        const stubId = `${PFX}cr:channel:sub:acme.inventory{envSuffix}.promote-test.save.ready`;
        await makeStub(stubId, 'acme.inventory{envSuffix}.promote-test.save.ready', 'subscription');

        await resolveDynamicInfrastructure(NOOP_REPORTER);

        const s = getNeo4jSession();
        try {
            const expected = await s.run(
                'MATCH (c:MessageChannel {id: "cr:channel:sub:acme.inventory.promote-test.save.ready"}) RETURN c.name AS name, c.channelKind AS kind',
            );
            expect(expected.records.length).toBe(1);
            expect(expected.records[0].get('kind')).toBe('subscription');
        } finally { await s.close(); }
    });

    it('falls back to generic URN when channelKind is missing on the stub', async () => {
        // Edge case: legacy stub without channelKind. Use generic builder
        // (un-kinded), still better than crashing.
        const stubId = `${PFX}cr:channel:acme.inventory{envSuffix}.promote-test.legacy`;
        await makeStub(stubId, 'acme.inventory{envSuffix}.promote-test.legacy', null);

        await resolveDynamicInfrastructure(NOOP_REPORTER);

        const s = getNeo4jSession();
        try {
            // Either kinded or un-kinded survives, we just assert no crash and a node exists.
            const result = await s.run(
                'MATCH (c:MessageChannel) WHERE c.name = "acme.inventory.promote-test.legacy" RETURN c.id AS id',
            );
            expect(result.records.length).toBeGreaterThanOrEqual(1);
        } finally { await s.close(); }
    });
});
