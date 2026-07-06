import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The symbol-registry DB lifecycle against real Memgraph
// (config-symbols mutations real, LLM agent mocked): cache-state persistence
// and reload across runs, stored-symbol load, soft-delete tombstoning.

vi.mock('../../src/ai/mastra/index.js', () => ({
    getMastra: () => ({
        getAgent: () => ({
            generate: async () => ({
                object: {
                    bindings: [{ diKey: 'acme.orders.connection', physicalName: 'orders_db', category: 'database', technology: 'postgres' }],
                },
                usage: {},
            }),
        }),
    }),
}));

import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeConfigSymbol } from '../../src/graph/mutations/config-symbols.js';
import { buildSymbolRegistryForRepo } from '../../src/ingestion/core/symbol-extraction.js';
import { buildUrn } from '../../src/graph/urn.js';
import type { ResolvedRepo } from '../../src/graph/types.js';

const REPO_NAME = 'symreg-lifecycle';
const ORG = 'acme';
const Q_NAME = `${ORG}/${REPO_NAME}`;
const DOCTRINE_PATH = 'config/doctrine.yaml';

let repoDir: string;

function writeRepo(files: Record<string, string>): ResolvedRepo {
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(repoDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return { name: REPO_NAME, org: ORG, path: repoDir, commit: 'LIFECYCLE_C1' } as ResolvedRepo;
}

async function wipe(): Promise<void> {
    const s = getNeo4jSession();
    try {
        await s.run('MATCH (n) WHERE n.id CONTAINS $marker DETACH DELETE n', { marker: REPO_NAME });
    } finally { await s.close(); }
}

describe('symbol-registry lifecycle on Memgraph', () => {
    beforeAll(async () => { await initSchema({ silent: true }); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => {
        await wipe();
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symreg-it-'));
        // The symbol cache state lives on the :Repository node
        // (saveSymbolExtractionCacheState MATCHes it — without the node the
        // save is a silent no-op), so the lifecycle needs it seeded.
        const s = getNeo4jSession();
        try {
            await s.run(
                'MERGE (r:Repository {id: $id}) SET r.name = $name, r.valid_to_commit = null',
                { id: buildUrn('repository', Q_NAME), name: REPO_NAME },
            );
        } finally { await s.close(); }
    });
    afterEach(() => { fs.rmSync(repoDir, { recursive: true, force: true }); });

    it('persists the cache state and the second run replays from it with zero LLM activity', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: 'doctrine:\n  dbal: { url: "%env(DATABASE_URL)%" }\n' });

        const first = await buildSymbolRegistryForRepo({ repo, persistCacheState: true });
        expect(first.diagnostics.llmCalls).toBe(1);
        expect(first.registry.getAll().map(b => b.key)).toContain('acme.orders.connection');

        const second = await buildSymbolRegistryForRepo({ repo, persistCacheState: true });
        expect(second.diagnostics).toMatchObject({ cacheHits: 1, llmCalls: 0 });
        expect(second.registry.getAll().map(b => b.key)).toContain('acme.orders.connection');
        expect(second.cacheState.targetPlanHash).toBe(first.cacheState.targetPlanHash);
    });

    it('soft-deletes a stored symbol whose source is gone (tombstone visible in the graph)', async () => {
        await mergeConfigSymbol(
            'acme.legacy.connection', 'legacy_db', 'database', Q_NAME, 'LIFECYCLE_C0',
            { sourceFile: 'config/removed.yaml', extractorVersion: 'config-symbol-extractor-v2' },
        );
        const repo = writeRepo({
            'config/messaging.php': `<?php
$container->register('acme.order.publisher', \\Acme\\Order\\OrderPublisher::class)
    ->addTag('messenger.publisher', ['queue' => 'acme.order.created']);
`,
        });

        const result = await buildSymbolRegistryForRepo({ repo, persistCacheState: true });
        expect(result.registry.getAll().map(b => b.key)).toContain('acme.order.publisher');

        const s = getNeo4jSession();
        try {
            const res = await s.run(
                'MATCH (c:ConfigSymbol) WHERE c.id CONTAINS $repo AND c.key = $key RETURN c.valid_to_commit AS tombstone',
                { repo: REPO_NAME, key: 'acme.legacy.connection' },
            );
            expect(res.records).toHaveLength(1);
            expect(res.records[0].get('tombstone')).toBe('LIFECYCLE_C1');
        } finally { await s.close(); }
    });

    it('loads stored symbols from the graph when nothing is extractable (preserve-all path)', async () => {
        await mergeConfigSymbol(
            'acme.payments.queue', 'acme.payment.requested', 'message_channel', Q_NAME, 'LIFECYCLE_C0',
            { sourceFile: 'config/old.yaml', extractorVersion: 'config-symbol-extractor-v2' },
        );
        const repo = writeRepo({ 'src/orders.ts': 'export const noop = 1;\n' });

        const result = await buildSymbolRegistryForRepo({ repo, persistCacheState: true });

        const stored = result.registry.getAll().find(b => b.key === 'acme.payments.queue');
        expect(stored).toMatchObject({ value: 'acme.payment.requested' });
    });
});
