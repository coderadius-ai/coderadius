/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-memcached-datastore (S1.2 Memcached DSN extractor)
 *
 * Before S1.2 a `MEMCACHED_URL=memcached://...` was invisible: `parseDsn` had no
 * `memcached` scheme, `DSN_KEY_PATTERNS` had no MEMCACHED_* entry, and the
 * trio synthesizer required a logical dbName memcached never has. Net: zero
 * hint → zero identity → no way to model the cache tier.
 *
 * This pins the connection layer now RECOGNISES memcached end-to-end (file →
 * extractAllPhysicalHints → canonicalizeDatastoreIdentities): one `kv`-family
 * identity named `memcached`.
 *
 * SCOPE: S1.2 recognises memcached AND (policy flip) auto-promotes discovered
 * kv caches (redis/memcached) to a Cache binding, the same way the Database
 * path auto-promotes rdbms. The graph-writer Cache case then materialises a
 * `:Datastore` + `:DatabaseEndpoint{environment}` via S1.1's
 * the datastore interpreter (interpret/datastore.ts). This pins the file → identity → Cache-binding
 * chain deterministically; node materialisation reuses the S1.1 mutations
 * (covered by the datastore-multi-env integration test).
 *
 * Full pipeline, deterministic. Zero LLM, zero graph DB.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { loadRepoContext, clearRepoContextCache } from '../../../../src/config/repo-context.js';
import { resolveDatastoreBinding, familyForTechnology } from '../../../../src/ingestion/processors/db-scope-resolver.js';
import type { RepoHints } from '../../../../src/config/repo-hints.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — ts-memcached-datastore', () => {
    let ctx: ReturnType<typeof loadRepoContext>;

    beforeAll(() => {
        clearRepoContextCache(FIXTURE_DIR);
        ctx = loadRepoContext(FIXTURE_DIR);
    });

    afterAll(() => {
        clearRepoContextCache(FIXTURE_DIR);
    });

    it('recognises memcached:// and produces a single kv-family identity named "memcached"', () => {
        expect(ctx.identities).toHaveLength(1);
        const id = ctx.identities[0];
        expect(id.identityKey).toBe('memcached');
        expect(id.canonicalHint.technology).toBe('memcached');
        expect(id.canonicalHint.host).toBe('cache.acme.internal');
        expect(id.canonicalHint.port).toBe(11211);
        expect(familyForTechnology('memcached')).toBe('kv');
    });

    it('auto-promotes the memcached identity to a Cache binding (policy flip), one env variant', () => {
        // No coderadius.yaml — the discovered kv identity alone now binds. The
        // graph-writer Cache case turns this into a :Datastore + N
        // :DatabaseEndpoint{environment} (one per variant) via S1.1.
        const NO_HINTS = { databases: [] } as unknown as RepoHints;
        const bindings = resolveDatastoreBinding(null, 'Cache', NO_HINTS, null, ctx.identities);
        expect(bindings).toHaveLength(1);
        expect(bindings[0].technology).toBe('memcached');
        expect(bindings[0].environments).toHaveLength(1);
    });
});
