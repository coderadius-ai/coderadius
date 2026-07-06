// ═══════════════════════════════════════════════════════════════════════════════
// Live-graph assessment harness (scripts/assess-graph.ts path) — integration.
//
// Seeds a tiny acme graph on the test Memgraph and verifies the shared
// snapshot builder + eval-scorer pipeline end-to-end in 'field' mode:
//   - canonical matching (METHOD /path with {} params, lowercased names)
//   - live-only semantics (tombstoned nodes satisfy nothing)
//   - repo scoping for labels that carry a discriminator
//   - exhaustive FP semantics for labels listed in expected_nodes
//   - negative pattern violations
// ═══════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getNeo4jSession, closeNeo4j } from '../../src/graph/neo4j.js';
import { EvalManifestSchema } from '../eval/types/eval-manifest.js';
import { scoreNodes, checkNegatives } from '../eval/scorers/eval-scorer.js';
import { buildGraphSnapshot } from '../eval/scorers/graph-snapshot.js';

const MARK = 'acme-assess-harness';

async function run(query: string, params: Record<string, unknown> = {}) {
    const session = getNeo4jSession();
    try {
        return await session.run(query, params);
    } finally {
        await session.close();
    }
}

const manifest = EvalManifestSchema.parse({
    fixture: 'acme-assess-harness',
    expected_nodes: {
        MessageChannel: ['acme.orders.created', 'acme.shipping.dispatched'],
        DataContainer: ['acme_orders', 'acme_payments'],
        APIEndpoint: ['GET /orders/{}', 'POST /orders'],
    },
    negative_nodes: {
        MessageChannel: ['doctrine.entitymanager.orm_default'],
    },
    negative_patterns: {
        MessageChannel: ['^rabbitmq\\.producer\\.'],
    },
});

describe('graph-assessment harness (field mode)', () => {
    beforeAll(async () => {
        await run(`
            CREATE (sv:Service {id: 'cr:service:acme/acme:harness', name: 'harness', valid_to_commit: null, assessfx: $mark}),
                   (f:Function {id: 'cr:fn:harness', name: 'Harness.touch', valid_to_commit: null, assessfx: $mark}),
                   (c1:MessageChannel {name: 'acme.orders.created', assessfx: $mark}),
                   (c2:MessageChannel {name: 'Acme.Shipping.Dispatched', assessfx: $mark}),
                   (c3:MessageChannel {name: 'rabbitmq.producer.acme_metrics', assessfx: $mark}),
                   (:MessageChannel {name: 'acme.dead.queue', valid_to_commit: 'deadbeef', assessfx: $mark}),
                   (:MessageChannel {name: 'doctrine.entitymanager.orm_default', valid_to_commit: 'deadbeef', assessfx: $mark}),
                   (sv)-[:CONTAINS]->(f),
                   (f)-[:PUBLISHES_TO]->(c1), (f)-[:PUBLISHES_TO]->(c2), (f)-[:PUBLISHES_TO]->(c3),
                   (:DataContainer {name: 'acme_orders', scope: 'acme/acme', assessfx: $mark}),
                   (:DataContainer {name: 'other_repo_table', scope: 'acme/other', assessfx: $mark}),
                   (:APIEndpoint {name: '/orders/{orderId}', path: '/orders/{orderId}', method: 'get', apiKind: 'rest', assessfx: $mark}),
                   (:APIEndpoint {name: '/orders', path: '/orders/', method: 'POST', apiKind: 'rest', assessfx: $mark})
        `, { mark: MARK });
    });

    afterAll(async () => {
        await run(`MATCH (n {assessfx: $mark}) DETACH DELETE n`, { mark: MARK });
        await closeNeo4j();
    });

    it('matches canonical forms and computes exhaustive P/R per label', async () => {
        const snapshot = await buildGraphSnapshot(
            Object.keys(manifest.expected_nodes),
            { mode: 'field', repoScope: 'acme/acme' },
        );
        const scores = scoreNodes(manifest, snapshot);
        const byLabel = new Map(scores.map((s) => [s.category, s]));

        // Channels are a global label (no repo discriminator), so the shared
        // test DB may hold leftovers from other suites: assert containment on
        // our seeded names, not exact FP equality.
        const ch = byLabel.get('MessageChannel')!;
        expect(ch.truePositives.sort()).toEqual(['acme.orders.created', 'acme.shipping.dispatched']);
        expect(ch.falsePositives).toContain('rabbitmq.producer.acme_metrics');
        expect(ch.falseNegatives).toEqual([]);

        // Containers: repoScope gives a deterministic universe, so the
        // exhaustive-FP semantics is pinned EXACTLY here: the other repo's
        // table is excluded by scope (not an FP), acme_payments was never
        // created (FN), and nothing else leaks in.
        const dc = byLabel.get('DataContainer')!;
        expect(dc.truePositives).toEqual(['acme_orders']);
        expect(dc.falsePositives).toEqual([]);
        expect(dc.falseNegatives).toEqual(['acme_payments']);

        // Endpoints: method uppercased, {param} → {}, trailing slash stripped.
        const ep = byLabel.get('APIEndpoint')!;
        expect(ep.truePositives.sort()).toEqual(['GET /orders/{}', 'POST /orders']);
        expect(ep.falseNegatives).toEqual([]);
    });

    it('tombstoned nodes satisfy neither expected nor negative assertions', async () => {
        const snapshot = await buildGraphSnapshot(['MessageChannel'], { mode: 'field' });
        const names = snapshot.get('MessageChannel')!;
        expect(names).not.toContain('acme.dead.queue');

        // The only doctrine.* node is tombstoned → no negative violation from it.
        const violations = checkNegatives(manifest, snapshot);
        expect(violations.filter((v) => v.violatingName.startsWith('doctrine.'))).toEqual([]);

        // The LIVE producer DI id violates the pattern.
        expect(violations.some((v) => v.matchType === 'pattern'
            && v.violatingName === 'rabbitmq.producer.acme_metrics')).toBe(true);
    });

    it('rejects unsafe labels instead of interpolating them', async () => {
        await expect(buildGraphSnapshot(['Bad) DETACH DELETE n //'], { mode: 'field' }))
            .rejects.toThrow(/unsafe label/i);
    });

    it('repoScope on MessageChannel includes config-declared channels via the StructuralFile leg', async () => {
        await run(`
            CREATE (r:Repository {id: 'cr:repository:acme/acme', name: 'acme', valid_to_commit: null, assessfx: $mark}),
                   (stf:StructuralFile {id: 'cr:structuralfile:acme/acme:config/bus.php', assessfx: $mark}),
                   (cfg:MessageChannel {name: 'acme.scoped.config-exchange', discoverySource: 'config', valid_to_commit: null, assessfx: $mark}),
                   (other:MessageChannel {name: 'other.config-exchange', discoverySource: 'config', valid_to_commit: null, assessfx: $mark}),
                   (r)-[:HAS_CONFIG]->(stf),
                   (stf)-[:DEFINES]->(cfg)
        `, { mark: MARK });
        const scoped = await buildGraphSnapshot(['MessageChannel'], { mode: 'field', repoScope: 'acme/acme' });
        const names = scoped.get('MessageChannel')!;
        expect(names).toContain('acme.scoped.config-exchange');   // declared by the repo's config
        expect(names).not.toContain('other.config-exchange');     // declared by nobody in scope
    });

    it('repoScope on MessageChannel keeps only channels touched by the repo services', async () => {
        await run(`
            CREATE (sa:Service {id: 'cr:service:acme/acme:orders', name: 'orders', valid_to_commit: null, assessfx: $mark}),
                   (sb:Service {id: 'cr:service:acme/other:billing', name: 'billing', valid_to_commit: null, assessfx: $mark}),
                   (fa:Function {id: 'cr:fn:a', name: 'OrdersPub.send', valid_to_commit: null, assessfx: $mark}),
                   (fb:Function {id: 'cr:fn:b', name: 'BillingPub.send', valid_to_commit: null, assessfx: $mark}),
                   (ca:MessageChannel {name: 'acme.scoped.orders.created', valid_to_commit: null, assessfx: $mark}),
                   (cb:MessageChannel {name: 'other.scoped.billing.created', valid_to_commit: null, assessfx: $mark}),
                   (sa)-[:CONTAINS]->(fa)-[:PUBLISHES_TO]->(ca),
                   (sb)-[:CONTAINS]->(fb)-[:LISTENS_TO]->(cb)
        `, { mark: MARK });

        const scoped = await buildGraphSnapshot(['MessageChannel'], { mode: 'field', repoScope: 'acme/acme' });
        const names = scoped.get('MessageChannel')!;
        expect(names).toContain('acme.scoped.orders.created');
        expect(names).not.toContain('other.scoped.billing.created');
    });

    it('same-name nodes collapse to ONE canonical entry (no double-counted FP)', async () => {
        await run(`
            CREATE (:MessageChannel {name: 'acme.dup.topic', channelKind: 'topic', valid_to_commit: null, assessfx: $mark}),
                   (:MessageChannel {name: 'acme.dup.topic', channelKind: 'topic', valid_to_commit: null, assessfx: $mark})
        `, { mark: MARK });
        const snapshot = await buildGraphSnapshot(['MessageChannel'], { mode: 'field' });
        const dups = snapshot.get('MessageChannel')!.filter((n) => n === 'acme.dup.topic');
        expect(dups).toHaveLength(1);
    });
});
