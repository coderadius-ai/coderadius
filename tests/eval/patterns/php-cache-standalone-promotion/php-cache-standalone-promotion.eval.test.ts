/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-cache-standalone-promotion
 *
 * Anonymised reproduction of a real customer miss: a memcached cache whose only
 * I/O (`new \Memcached(); ->addServer(...)`) lives in a CONSTRUCTOR. Constructors
 * are dropped by the taint gate, so the cache never reaches the per-function
 * binding loop and no :Datastore is created — a blast-radius False Negative.
 *
 * The recall is `datastore-promotion.ts` (high-confidence gate: declared client
 * library OR unambiguous DSN scheme), materialised at reconcile stage by
 * `standalone-datastore-promotion.ts`. This pins the full deterministic chain
 * fixture → hint → identity → gate → :Datastore NODE.
 *
 * Fixture (anonymised acme):
 *   - composer.json (ext-memcached + doctrine/dbal — the client-lib corroboration)
 *   - .env.example (MEMCACHED_* trio + DB_* contrast)
 *   - config/values.php (getenv() refs make the vars code-referenced)
 *   - classes/Acme/Cache/Cache.php (memcached I/O in a taint-dropped constructor)
 *
 * Deterministic, zero LLM, zero graph DB (InMemoryGraphStore).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAllPhysicalHints } from '../../../../src/ingestion/processors/connection-extractors/registry.js';
import { canonicalizeDatastoreIdentities } from '../../../../src/ingestion/processors/connection-extractors/canonicalizer.js';
import { selectPromotableDatastores, readDeclaredPackages } from '../../../../src/ingestion/processors/datastore-promotion.js';
import { computeStandaloneDatastoreDeltas } from '../../../../src/ingestion/processors/standalone-datastore-promotion.js';
import { InMemoryGraphStore } from '../../../../src/graph/write-model/in-memory-store.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');
const NS = 'acme/quote-engine';
const CTX = { qualifiedRepoName: NS, commitHash: 'eval', allowPlainTextHosts: false };
const MEMCACHED_URN = `cr:datastore:${NS}:memcached`;

describe('Pattern Eval — php-cache-standalone-promotion', () => {
    let stagedRepo: string;

    beforeAll(() => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-php-cache-promo-'));
        stagedRepo = path.join(tmp, 'quote-engine');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });
    });

    afterAll(() => {
        if (stagedRepo) fs.rmSync(path.dirname(stagedRepo), { recursive: true, force: true });
    });

    it('recovers the memcached hint from the MEMCACHED_* env trio', () => {
        const { hints } = extractAllPhysicalHints(stagedRepo);
        const memc = hints.find(h => h.technology === 'memcached');
        expect(memc, 'a memcached physical hint must be recovered').toBeDefined();
        expect(memc!.host).toBe('memcached');
        expect(memc!.port).toBe(11211);
    });

    it('memcached clears the high-confidence promotion gate via the declared ext-memcached client', () => {
        const identities = canonicalizeDatastoreIdentities(extractAllPhysicalHints(stagedRepo).hints);
        const pkgs = readDeclaredPackages(stagedRepo);
        expect(pkgs.has('ext-memcached')).toBe(true);
        const promotable = selectPromotableDatastores(identities, pkgs);
        expect(promotable.some(i => i.canonicalHint.technology === 'memcached')).toBe(true);
    });

    // THE FIX: the per-function loop never binds the constructor-only cache, so
    // reconcile-stage promotion materialises it — a :Datastore node with
    // heuristic grounding and NO function CONNECTS_TO.
    it('standalone promotion materialises a memcached :Datastore node (heuristic, no CONNECTS_TO)', async () => {
        const identities = canonicalizeDatastoreIdentities(extractAllPhysicalHints(stagedRepo).hints);
        const pkgs = readDeclaredPackages(stagedRepo);
        const { delta, promoted } = computeStandaloneDatastoreDeltas(identities, pkgs, new Set(), CTX);

        expect(promoted).toContainEqual({ urn: MEMCACHED_URN, technology: 'memcached' });
        const dsNode = delta.nodes.find(n => n.urn === MEMCACHED_URN);
        expect(dsNode?.grounding?.source).toBe('heuristic');
        expect(dsNode?.grounding?.evidence?.extractors).toContain('datastore-promotion@v1');
        expect(delta.edges.some(e => e.type === 'CONNECTS_TO')).toBe(false);

        // and it actually persists as a node
        const store = new InMemoryGraphStore();
        await store.apply(delta, { commitHash: 'eval' });
        expect(store.getNode('Datastore', MEMCACHED_URN), 'memcached :Datastore must be materialised').toBeDefined();
    });

    it('is idempotent: an identity already present (function-bound) is skipped', () => {
        const identities = canonicalizeDatastoreIdentities(extractAllPhysicalHints(stagedRepo).hints);
        const pkgs = readDeclaredPackages(stagedRepo);
        const { promoted } = computeStandaloneDatastoreDeltas(identities, pkgs, new Set([MEMCACHED_URN]), CTX);
        expect(promoted.some(p => p.urn === MEMCACHED_URN)).toBe(false);
    });
});
