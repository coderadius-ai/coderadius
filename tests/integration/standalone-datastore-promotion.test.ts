import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { promoteStandaloneDatastores } from '../../src/ingestion/processors/standalone-datastore-promotion.js';
import type { ResolvedRepo } from '../../src/graph/types.js';

// ═════════════════════════════════════════════════════════════════════════════
// Standalone datastore promotion against Memgraph (reconcile-stage recall).
//
// Anonymised repro of the real miss: a cache (memcached) whose only I/O lives in
// a taint-dropped constructor never gets a function-bound :Datastore. The
// promotion materialises it from the connection hint, corroborated by the
// declared client library (`ext-memcached`). It must:
//   • create the missing datastore (source 'heuristic', distinct from observed
//     ast/exact function-bound nodes),
//   • SKIP an identity that already has a function-bound node (idempotent, and
//     never clobber its grounding),
//   • be a no-op on re-run.
// ═════════════════════════════════════════════════════════════════════════════

const NS = 'acme/orders-svc';
const MYSQL_URN = `cr:datastore:${NS}:orders`;

function makeFixtureRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-promo-'));
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
        require: { 'ext-memcached': '*', 'doctrine/dbal': '^3.0' },
    }));
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), [
        'services:',
        '  app:',
        '    environment:',
        '      MEMCACHED_HOST: memcached',
        '      MEMCACHED_PORT: "11211"',
        '      MYSQL_HOST: db',
        '      MYSQL_DATABASE: orders',
        '      MYSQL_PORT: "3306"',
        '',
    ].join('\n'));
    // Code references make the env keys code-referenced (realistic gate path).
    fs.writeFileSync(path.join(dir, 'app.php'),
        "<?php getenv('MEMCACHED_HOST'); getenv('MYSQL_HOST'); getenv('MYSQL_DATABASE');\n");
    return dir;
}

describe('promoteStandaloneDatastores (integration)', () => {
    let repoDir: string;
    let repo: ResolvedRepo;

    async function wipe(): Promise<void> {
        const s = getNeo4jSession();
        try { await s.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: `cr:datastore:${NS}` }); }
        finally { await s.close(); }
    }

    async function seedFunctionBoundMysql(): Promise<void> {
        const s = getNeo4jSession();
        try {
            await s.run(
                `CREATE (d:Datastore {id: $id})
                 SET d.name = 'orders', d.namespace = $ns, d.technology = 'mysql',
                     d.source = 'ast', d.quality = 'exact',
                     d.valid_from_commit = 'SEED', d.valid_to_commit = null`,
                { id: MYSQL_URN, ns: NS },
            );
        } finally { await s.close(); }
    }

    async function liveDatastores(): Promise<Array<{ name: string; tech: string; src: string }>> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (d:Datastore) WHERE d.namespace = $ns AND d.valid_to_commit IS NULL
                 RETURN d.name AS name, d.technology AS tech, d.source AS src ORDER BY name`,
                { ns: NS },
            );
            return r.records.map(x => ({ name: x.get('name'), tech: x.get('tech'), src: x.get('src') }));
        } finally { await s.close(); }
    }

    beforeAll(async () => {
        await initSchema({ silent: true });
        repoDir = makeFixtureRepo();
        repo = { name: 'orders-svc', path: repoDir, origin: 'local', org: 'acme', commit: 'PROMO_TEST' };
    });
    afterAll(async () => { await wipe(); fs.rmSync(repoDir, { recursive: true, force: true }); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('promotes the taint-dropped datastore without clobbering a function-bound one', async () => {
        await seedFunctionBoundMysql();

        const res = await promoteStandaloneDatastores([repo]);

        expect(res.promoted).toBe(1); // only memcached is new; mysql already bound → skipped
        const live = await liveDatastores();
        expect(live.find(d => d.name === 'memcached'))
            .toEqual({ name: 'memcached', tech: 'memcached', src: 'heuristic' });
        // mysql untouched: still ast/exact, single node (no clobber, no duplicate)
        expect(live.filter(d => d.name === 'orders'))
            .toEqual([{ name: 'orders', tech: 'mysql', src: 'ast' }]);
    });

    it('is idempotent: a second run promotes nothing and creates no duplicate', async () => {
        await seedFunctionBoundMysql();
        await promoteStandaloneDatastores([repo]);

        const res2 = await promoteStandaloneDatastores([repo]);

        expect(res2.promoted).toBe(0);
        expect((await liveDatastores()).filter(d => d.name === 'memcached')).toHaveLength(1);
    });

    it('promotes every corroborated datastore when none are function-bound yet', async () => {
        const res = await promoteStandaloneDatastores([repo]);

        expect(res.promoted).toBe(2); // memcached (ext-memcached) + mysql (doctrine/dbal)
        expect((await liveDatastores()).map(d => d.name)).toEqual(['memcached', 'orders']);
    });
});
