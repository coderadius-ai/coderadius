/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-datastore-single-env (S1.1 Part D regression guard)
 *
 * The overwhelmingly common case: ONE logical database, ONE deployment
 * surface. After the Datastore → N DatabaseEndpoint refactor, this MUST still
 * produce exactly one `DatastoreIdentity` with exactly one `EnvironmentVariant`
 * — i.e. the writer emits a single `:DatabaseEndpoint`, never a spurious
 * multi-emit.
 *
 * Full pipeline, deterministic. Zero LLM, zero graph DB.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { loadRepoContext, clearRepoContextCache } from '../../../../src/config/repo-context.js';
import { resolveDatastoreBinding } from '../../../../src/ingestion/processors/db-scope-resolver.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — ts-datastore-single-env', () => {
    let ctx: ReturnType<typeof loadRepoContext>;

    beforeAll(() => {
        clearRepoContextCache(FIXTURE_DIR);
        ctx = loadRepoContext(FIXTURE_DIR);
    });

    afterAll(() => {
        clearRepoContextCache(FIXTURE_DIR);
    });

    it('produces a single logical Datastore identity', () => {
        expect(ctx.identities).toHaveLength(1);
        expect(ctx.identities[0].identityKey).toBe('orders');
    });

    it('materialises exactly one EnvironmentVariant', () => {
        expect(ctx.identities[0].environments).toHaveLength(1);
        expect(ctx.identities[0].environments[0].environment).toBe('production');
        expect(ctx.identities[0].environments[0].host).toBe('orders-db.acme.internal');
    });

    it('resolveDatastoreBinding returns one binding with one environment (no over-emit)', () => {
        const bindings = resolveDatastoreBinding(null, 'Database', ctx.hints, null, ctx.identities);
        expect(bindings).toHaveLength(1);
        expect(bindings[0].environments).toHaveLength(1);
    });
});
