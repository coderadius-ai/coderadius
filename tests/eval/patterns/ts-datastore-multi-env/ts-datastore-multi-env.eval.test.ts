/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-datastore-multi-env (S1.1 Part D, logical/physical split)
 *
 * Pins the discovery → connection-extraction → canonicalize → binding chain
 * that feeds the graph-writer's per-environment `:DatabaseEndpoint` emission.
 *
 * A repo declares ONE logical database ("orders") across THREE deployment
 * environments (production / staging / development), each on a distinct host.
 * The pipeline MUST collapse them into a SINGLE `DatastoreIdentity` carrying
 * THREE `EnvironmentVariant`s — the contract the writer relies on to emit one
 * logical `:Datastore` + N physical `:DatabaseEndpoint{environment}` (paradigm
 * A), instead of the legacy single-node-with-`environments`-JSON (paradigm B).
 *
 * Each environment variant must yield a DISTINCT physical endpointKey so the
 * three endpoints never collapse into one node.
 *
 * Full pipeline, deterministic: real files → extractAllPhysicalHints →
 * canonicalizeDatastoreIdentities → resolveDatastoreBinding. Zero LLM, zero
 * graph DB.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { loadRepoContext, clearRepoContextCache } from '../../../../src/config/repo-context.js';
import { resolveDatastoreBinding, computeEndpointKey } from '../../../../src/ingestion/processors/db-scope-resolver.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — ts-datastore-multi-env', () => {
    let ctx: ReturnType<typeof loadRepoContext>;

    beforeAll(() => {
        clearRepoContextCache(FIXTURE_DIR);
        ctx = loadRepoContext(FIXTURE_DIR);
    });

    afterAll(() => {
        clearRepoContextCache(FIXTURE_DIR);
    });

    it('collapses the three env surfaces into ONE logical Datastore identity', () => {
        expect(ctx.identities).toHaveLength(1);
        expect(ctx.identities[0].identityKey).toBe('orders');
    });

    it('materialises three EnvironmentVariants (production / staging / development)', () => {
        const envs = ctx.identities[0].environments.map(e => e.environment).sort();
        expect(envs).toEqual(['development', 'production', 'staging']);
    });

    it('each environment keeps its own distinct host (no winner-collapse)', () => {
        const hosts = new Set(ctx.identities[0].environments.map(e => e.host));
        expect(hosts.size).toBe(3);
        expect([...hosts].sort()).toEqual([
            'orders-dev.acme.internal',
            'orders-prod.acme.internal',
            'orders-stg.acme.internal',
        ]);
    });

    it('resolveDatastoreBinding returns a single binding carrying all three environments', () => {
        const bindings = resolveDatastoreBinding(null, 'Database', ctx.hints, null, ctx.identities);
        expect(bindings).toHaveLength(1);
        expect(bindings[0].technology).toBe('mysql');
        expect(bindings[0].environments).toHaveLength(3);
    });

    it('the three environments produce three DISTINCT physical endpointKeys', () => {
        const bindings = resolveDatastoreBinding(null, 'Database', ctx.hints, null, ctx.identities);
        const keys = bindings[0].environments!.map(e => computeEndpointKey(e.host, e.port, e.dbName));
        expect(new Set(keys).size).toBe(3);
    });
});
