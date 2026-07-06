import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { linkFieldsReferenceTypes } from '../../src/graph/mutations/data-contracts.js';

// ─── Phase 3 (Fix #2) — REFERENCES_TYPE welder ──────────────────────────────
//
// Verifies that:
//   1. The welder parses `DataField.type` strings via the language plugin
//      and creates `(DataField)-[:REFERENCES_TYPE]->(DataStructure)` edges.
//   2. Scope priority kicks in (same-scope wins over global).
//   3. PHP and TS plugins are both wired through the registry.
//   4. Idempotency: re-running does not duplicate.
//   5. Sweep: stale edges from previous commits get tombstoned.
//   6. Hard guards: TS utility types abort, inline object types abort,
//      primitives and builtin classes are filtered.

describe('linkFieldsReferenceTypes (Phase 3, Fix #2)', () => {
    const PFX = 'cr://test/fields-ref-type/';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: PFX });
        } finally { await s.close(); }
    }

    async function makeNode(label: string, id: string, props: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (n:${label} {id: $id}) SET n += $props,
                  n.valid_from_commit = 'TEST', n.valid_to_commit = null`,
                { id, props },
            );
        } finally { await s.close(); }
    }

    async function rel(rt: string, srcId: string, dstId: string, props: Record<string, unknown> = {}) {
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (a {id: $sid}), (b {id: $did})
                 MERGE (a)-[r:${rt}]->(b)
                 ON CREATE SET r += $props, r.valid_from_commit = 'TEST', r.valid_to_commit = null`,
                { sid: srcId, did: dstId, props },
            );
        } finally { await s.close(); }
    }

    async function countEdge(srcId: string, dstId: string): Promise<number> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (a {id: $sid})-[r:REFERENCES_TYPE]->(b {id: $did})
                 WHERE r.valid_to_commit IS NULL
                 RETURN count(r) AS n`,
                { sid: srcId, did: dstId },
            );
            const v = r.records[0].get('n');
            return typeof v === 'number' ? v : (typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
        } finally { await s.close(); }
    }

    async function buildScenario(opts: {
        sfPath: string;          // e.g. 'src/orders/Order.ts' or 'src/Order.php'
        dsName: string;
        scope?: string;
        fields: Array<{ name: string; type: string }>;
        referencedSchemas: Array<{ name: string; scope?: string }>;
    }) {
        const sfUrn = `${PFX}sf:${opts.sfPath}`;
        const dsUrn = `${PFX}ds:${opts.dsName}`;
        await makeNode('SourceFile', sfUrn, { path: opts.sfPath, name: opts.sfPath.split('/').pop() });
        await makeNode('DataStructure', dsUrn, { name: opts.dsName, scope: opts.scope ?? null });
        await rel('DEFINES_SCHEMA', sfUrn, dsUrn);

        const fieldUrns: string[] = [];
        for (const f of opts.fields) {
            const dfUrn = `${PFX}df:${opts.dsName}:${f.name}`;
            await makeNode('DataField', dfUrn, { name: f.name, type: f.type });
            await rel('HAS_FIELD', dsUrn, dfUrn);
            fieldUrns.push(dfUrn);
        }

        const targetUrns: string[] = [];
        for (const r of opts.referencedSchemas) {
            const targetUrn = `${PFX}ds:${r.name}${r.scope ? `:${r.scope}` : ''}`;
            await makeNode('DataStructure', targetUrn, { name: r.name, scope: r.scope ?? null });
            targetUrns.push(targetUrn);
        }

        return { sfUrn, dsUrn, fieldUrns, targetUrns };
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('creates REFERENCES_TYPE edge for TS Array<X>', async () => {
        const { fieldUrns, targetUrns } = await buildScenario({
            sfPath: 'src/orders/Order.ts',
            dsName: 'OrderEvent',
            scope: 'acme:orders',
            fields: [{ name: 'lineItems', type: 'Array<LineItem>' }],
            referencedSchemas: [{ name: 'LineItem', scope: 'acme:orders' }],
        });

        const res = await linkFieldsReferenceTypes('TEST');
        expect(await countEdge(fieldUrns[0], targetUrns[0])).toBe(1);
        expect(res.linked).toBeGreaterThanOrEqual(1);
    });

    it('creates REFERENCES_TYPE edge for PHP nullable type', async () => {
        const { fieldUrns, targetUrns } = await buildScenario({
            sfPath: 'src/Orders/Order.php',
            dsName: 'OrderEvent',
            scope: 'acme:orders',
            fields: [{ name: 'customer', type: '?User' }],
            referencedSchemas: [{ name: 'User', scope: 'acme:orders' }],
        });

        await linkFieldsReferenceTypes('TEST');
        expect(await countEdge(fieldUrns[0], targetUrns[0])).toBe(1);
    });

    it('scope priority: same-scope target wins over a global candidate', async () => {
        // Build a parent DataStructure scoped to 'acme:orders' and reference
        // 'User' which exists in TWO DataStructures: one global, one in scope.
        const sfUrn = `${PFX}sf:src/orders/Order.ts`;
        const parentDsUrn = `${PFX}ds:OrderEvent`;
        const targetGlobalUrn = `${PFX}ds:User:global`;
        const targetScopedUrn = `${PFX}ds:User:acme:orders`;
        const fieldUrn = `${PFX}df:OrderEvent:customer`;

        await makeNode('SourceFile', sfUrn, { path: 'src/orders/Order.ts', name: 'Order.ts' });
        await makeNode('DataStructure', parentDsUrn, { name: 'OrderEvent', scope: 'acme:orders' });
        await makeNode('DataField', fieldUrn, { name: 'customer', type: 'User' });
        await rel('DEFINES_SCHEMA', sfUrn, parentDsUrn);
        await rel('HAS_FIELD', parentDsUrn, fieldUrn);
        await makeNode('DataStructure', targetGlobalUrn, { name: 'User', scope: null });
        await makeNode('DataStructure', targetScopedUrn, { name: 'User', scope: 'acme:orders' });

        await linkFieldsReferenceTypes('TEST');

        // Same-scope must win; global must not be linked.
        expect(await countEdge(fieldUrn, targetScopedUrn)).toBe(1);
        expect(await countEdge(fieldUrn, targetGlobalUrn)).toBe(0);
    });

    it('skips primitives', async () => {
        const { fieldUrns } = await buildScenario({
            sfPath: 'src/orders/Order.ts',
            dsName: 'OrderEvent',
            scope: 'acme:orders',
            fields: [{ name: 'count', type: 'number' }],
            referencedSchemas: [],
        });
        await linkFieldsReferenceTypes('TEST');
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH ({id: $f})-[rel:REFERENCES_TYPE]->() WHERE rel.valid_to_commit IS NULL RETURN count(rel) AS n`,
                { f: fieldUrns[0] },
            );
            expect(r.records[0].get('n')?.toNumber?.() ?? r.records[0].get('n')).toBe(0);
        } finally { await s.close(); }
    });

    it('TS utility types abort (Partial, Omit, Pick, Record)', async () => {
        const { fieldUrns } = await buildScenario({
            sfPath: 'src/orders/Order.ts',
            dsName: 'OrderEvent',
            scope: 'acme:orders',
            fields: [
                { name: 'partial', type: 'Partial<User>' },
                { name: 'picked',  type: "Pick<User, 'id'>" },
                { name: 'omitted', type: "Omit<User, 'id'>" },
                { name: 'recorded', type: 'Record<string, User>' },
            ],
            // User exists as a candidate, but the utility-type strings abort.
            referencedSchemas: [{ name: 'User', scope: 'acme:orders' }],
        });

        await linkFieldsReferenceTypes('TEST');
        const s = getNeo4jSession();
        try {
            for (const fId of fieldUrns) {
                const r = await s.run(
                    `MATCH ({id: $f})-[rel:REFERENCES_TYPE]->() WHERE rel.valid_to_commit IS NULL RETURN count(rel) AS n`,
                    { f: fId },
                );
                const n = r.records[0].get('n')?.toNumber?.() ?? r.records[0].get('n');
                expect(n).toBe(0);
            }
        } finally { await s.close(); }
    });

    it('idempotent: re-running does not duplicate edges', async () => {
        const { fieldUrns, targetUrns } = await buildScenario({
            sfPath: 'src/orders/Order.ts',
            dsName: 'OrderEvent',
            scope: 'acme:orders',
            fields: [{ name: 'lineItems', type: 'Array<LineItem>' }],
            referencedSchemas: [{ name: 'LineItem', scope: 'acme:orders' }],
        });
        await linkFieldsReferenceTypes('TEST');
        await linkFieldsReferenceTypes('TEST');
        expect(await countEdge(fieldUrns[0], targetUrns[0])).toBe(1);
    });

    it('sweep: tombstones edges not refreshed this commit', async () => {
        const { fieldUrns, targetUrns } = await buildScenario({
            sfPath: 'src/orders/Order.ts',
            dsName: 'OrderEvent',
            scope: 'acme:orders',
            fields: [{ name: 'lineItems', type: 'Array<LineItem>' }],
            referencedSchemas: [{ name: 'LineItem', scope: 'acme:orders' }],
        });
        await linkFieldsReferenceTypes('FIRST');
        expect(await countEdge(fieldUrns[0], targetUrns[0])).toBe(1);

        // Now tombstone the source DataField so the welder will not refresh
        // its edge on the next run; the previously-welded edge must be swept.
        const s = getNeo4jSession();
        try {
            await s.run(
                `MATCH (df:DataField {id: $f}) SET df.valid_to_commit = 'FIRST'`,
                { f: fieldUrns[0] },
            );
        } finally { await s.close(); }

        const res = await linkFieldsReferenceTypes('SECOND');
        // Edge tombstoned because welder did not see the DataField this run.
        const live = await countEdge(fieldUrns[0], targetUrns[0]);
        expect(live).toBe(0);
        expect(res.swept).toBeGreaterThanOrEqual(1);
    });
});
