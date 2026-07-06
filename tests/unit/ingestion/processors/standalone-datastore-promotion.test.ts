import { describe, it, expect } from 'vitest';
import { computeStandaloneDatastoreDeltas } from '../../../../src/ingestion/processors/standalone-datastore-promotion.js';
import type { DatastoreIdentity } from '../../../../src/ingestion/processors/db-scope-resolver.js';
import type { PhysicalEndpointHint } from '../../../../src/ingestion/processors/connection-extractors/types.js';

// ═════════════════════════════════════════════════════════════════════════════
// Standalone datastore promotion — pure core.
//
// Recall fix: a datastore whose only I/O function is dropped by the taint gate
// (e.g. a cache built in a constructor) never reaches the per-function binding
// loop, so no :Datastore node exists — a blast-radius False Negative. The
// reconcile-stage promotion materialises it WITHOUT a function: node + endpoint,
// NO CONNECTS_TO. Gated by the existing high-confidence FP guard
// (selectPromotableDatastores). Idempotent via skip-existing URNs.
// ═════════════════════════════════════════════════════════════════════════════

function identity(over: Partial<PhysicalEndpointHint> & { technology: string; identityKey: string }): DatastoreIdentity {
    const { identityKey, ...hintOver } = over;
    const canonicalHint: PhysicalEndpointHint = {
        host: 'h', port: 0, dbName: identityKey, confidence: 'high',
        templateSyntax: 'none', sourceFile: 'docker-compose.yml', ...hintOver,
    };
    return {
        identityKey,
        canonicalHint,
        environments: [{
            environment: 'production',
            host: canonicalHint.host,
            port: canonicalHint.port,
            dbName: canonicalHint.dbName,
            sourceFile: canonicalHint.sourceFile,
        }],
    };
}

const CTX = { qualifiedRepoName: 'acme/orders', commitHash: 'c1', allowPlainTextHosts: false };
const memcached = identity({ technology: 'memcached', identityKey: 'memcached', host: 'memcached', port: 11211 });

describe('computeStandaloneDatastoreDeltas', () => {
    it('promotes a kv cache corroborated by a declared client library, with no CONNECTS_TO', () => {
        const { delta, promoted } = computeStandaloneDatastoreDeltas(
            [memcached], new Set(['ext-memcached']), new Set(), CTX,
        );
        expect(promoted).toEqual([{ urn: 'cr:datastore:acme/orders:memcached', technology: 'memcached' }]);

        const dsNode = delta.nodes.find(n => n.label === 'Datastore');
        expect(dsNode?.urn).toBe('cr:datastore:acme/orders:memcached');
        expect(dsNode?.props?.technology).toBe('memcached');
        // standalone promotion is a heuristic recall, distinct from observed ast/exact
        expect(dsNode?.grounding?.source).toBe('heuristic');
        expect(dsNode?.grounding?.evidence?.extractors).toContain('datastore-promotion@v1');
        // function-INDEPENDENT: no CONNECTS_TO edge (an endpoint SERVED_BY is fine)
        expect(delta.edges.some(e => e.type === 'CONNECTS_TO')).toBe(false);
    });

    it('skips an identity whose Datastore URN already exists (idempotent, no grounding clobber)', () => {
        const { delta, promoted } = computeStandaloneDatastoreDeltas(
            [memcached], new Set(['ext-memcached']),
            new Set(['cr:datastore:acme/orders:memcached']), CTX,
        );
        expect(promoted).toEqual([]);
        expect(delta.nodes).toHaveLength(0);
    });

    it('refuses promotion when the FP guard fails (no client lib, no DSN scheme)', () => {
        const mysqlNoClient = identity({ technology: 'mysql', identityKey: 'orders', host: 'db.acme.internal', port: 3306 });
        const { promoted } = computeStandaloneDatastoreDeltas(
            [mysqlNoClient], new Set(), new Set(), CTX,
        );
        expect(promoted).toEqual([]);
    });

    it('promotes an rdbms corroborated by a declared client library', () => {
        const mysql = identity({ technology: 'mysql', identityKey: 'orders', host: 'db.acme.internal', port: 3306 });
        const { promoted } = computeStandaloneDatastoreDeltas(
            [mysql], new Set(['doctrine/dbal']), new Set(), CTX,
        );
        expect(promoted.map(p => p.urn)).toEqual(['cr:datastore:acme/orders:orders']);
    });
});
