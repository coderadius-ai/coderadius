import { describe, it, expect } from 'vitest';
import {
    resolveContainerScope,
    matchesTableGlob,
    resolveDatastoreBinding,
    familyForTechnology,
    ALL_KIND_FAMILIES,
    ALL_KNOWN_TECHS,
} from '../../../../src/ingestion/processors/db-scope-resolver.js';
import type { DatastoreIdentity } from '../../../../src/ingestion/processors/db-scope-resolver.js';
import type { PhysicalEndpointHint } from '../../../../src/ingestion/processors/connection-extractors/types.js';
import type { RepoHints } from '../../../../src/config/repo-hints.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHints(databaseScope?: Record<string, string[]>): RepoHints {
    const databases = databaseScope
        ? Object.entries(databaseScope).map(([id, tables]) => ({
            id,
            technology: 'mysql' as const,
            shared: false,
            tables,
        }))
        : [];
    return {
        databases,
        decorators: [],
        hints: [],
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// matchesTableGlob
// ═════════════════════════════════════════════════════════════════════════════

describe('matchesTableGlob', () => {
    it('exact match', () => {
        expect(matchesTableGlob('orders', 'orders')).toBe(true);
        expect(matchesTableGlob('orders', 'ORDERS')).toBe(true); // case-insensitive
        expect(matchesTableGlob('orders', 'order')).toBe(false);
    });

    it('wildcard-all', () => {
        expect(matchesTableGlob('*', 'anything')).toBe(true);
        expect(matchesTableGlob('*', '')).toBe(true);
    });

    it('prefix wildcard (wp_*)', () => {
        expect(matchesTableGlob('wp_*', 'wp_posts')).toBe(true);
        expect(matchesTableGlob('wp_*', 'wp_options')).toBe(true);
        expect(matchesTableGlob('wp_*', 'other_table')).toBe(false);
    });

    it('suffix wildcard (*_logs)', () => {
        expect(matchesTableGlob('*_logs', 'audit_logs')).toBe(true);
        expect(matchesTableGlob('*_logs', 'event_logs')).toBe(true);
        expect(matchesTableGlob('*_logs', 'audit_log')).toBe(false);
    });

    it('infix wildcard (*order*)', () => {
        expect(matchesTableGlob('*order*', 'pre_order_items')).toBe(true);
        expect(matchesTableGlob('*order*', 'orders')).toBe(true);
        expect(matchesTableGlob('*order*', 'products')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveContainerScope
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveContainerScope', () => {
    it('should fall back to qualifiedRepoName when no database_scope configured', () => {
        const result = resolveContainerScope('users', 'org/repo', makeHints());
        expect(result).toEqual({ scope: 'org/repo', scopeSource: 'repo_fallback' });
    });

    it('should return manual override when table matches a pattern', () => {
        const hints = makeHints({
            'legacy-shared-db': ['orders', 'users', 'wp_*'],
            'inventory-db': ['products', 'stock_items'],
        });

        expect(resolveContainerScope('orders', 'org/repo', hints)).toEqual({
            scope: 'legacy-shared-db',
            scopeSource: 'manual_override',
        });

        expect(resolveContainerScope('wp_posts', 'org/repo', hints)).toEqual({
            scope: 'legacy-shared-db',
            scopeSource: 'manual_override',
        });

        expect(resolveContainerScope('products', 'org/repo', hints)).toEqual({
            scope: 'inventory-db',
            scopeSource: 'manual_override',
        });
    });

    it('should fall back to qualifiedRepoName when no pattern matches', () => {
        const hints = makeHints({
            'legacy-shared-db': ['orders'],
        });

        expect(resolveContainerScope('unknown_table', 'org/repo', hints)).toEqual({
            scope: 'org/repo',
            scopeSource: 'repo_fallback',
        });
    });

    it('should match case-insensitively', () => {
        const hints = makeHints({
            'shared': ['WP_*'],
        });

        expect(resolveContainerScope('wp_posts', 'org/repo', hints)).toEqual({
            scope: 'shared',
            scopeSource: 'manual_override',
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveDatastoreBinding — kindFamily compatibility gate
//
// Regression coverage for the misattribution bug: when only a single
// auto-discovered connection hint exists (e.g. a MongoDB driver in env vars)
// and the DataContainer originates from a relational ORM (Doctrine, TypeORM,
// Eloquent), the binding must REFUSE rather than silently linking the
// relational table to the document store. The kindFamily signal — emitted by
// ORM extractors with deterministic structural evidence — drives the gate.
// ═════════════════════════════════════════════════════════════════════════════

const NO_HINTS: RepoHints = { databases: [], decorators: [], hints: [] };

function physicalHint(technology: string, dbName = 'app_main', confidence: 'high' | 'medium' | 'low' = 'high'): PhysicalEndpointHint {
    return {
        technology,
        host: 'db.example.com',
        port: technology === 'mongodb' ? 27017 : 3306,
        dbName,
        sourceFile: '.env.production',
        confidence,
        templateSyntax: 'none',
        isTemplate: false,
    };
}

function makeIdentity(technology: string, dbName = 'app_main', confidence: 'high' | 'medium' | 'low' = 'high'): DatastoreIdentity {
    const hint = physicalHint(technology, dbName, confidence);
    return {
        identityKey: dbName,
        canonicalHint: hint,
        environments: [{
            environment: 'production',
            host: hint.host,
            port: hint.port,
            dbName: hint.dbName,
            sourceFile: hint.sourceFile,
        }],
    };
}

describe('resolveDatastoreBinding — kindFamily gate', () => {
    it('refuses to bind an rdbms entity to the only-available mongodb connection (regression)', () => {
        // Doctrine `@ORM\Table` → kindFamily='rdbms'. Only mongo identity available.
        // Must fail-closed instead of silently attaching to the mongo Datastore.
        const result = resolveDatastoreBinding(
            'orders', 'Database', NO_HINTS, null,
            [makeIdentity('mongodb', 'archive')],
            'rdbms',
        );
        expect(result).toEqual([]);
    });

    it('binds an rdbms entity when a compatible mysql identity exists alongside mongo', () => {
        const result = resolveDatastoreBinding(
            'orders', 'Database', NO_HINTS, null,
            [makeIdentity('mongodb', 'archive'), makeIdentity('mysql', 'app_main')],
            'rdbms',
        );
        expect(result).toHaveLength(1);
        expect(result[0].technology).toBe('mysql');
        expect(result[0].datastoreId).toBe('app_main');
        expect(result[0].bindingReason).toBe('sole-candidate');
        expect(result[0].confidence).toBeGreaterThan(0.9);
    });

    it('binds an rdbms entity to a compatible postgres identity', () => {
        const result = resolveDatastoreBinding(
            'orders', 'Database', NO_HINTS, null,
            [makeIdentity('postgres', 'app_main')],
            'rdbms',
        );
        expect(result).toHaveLength(1);
        expect(result[0].technology).toBe('postgres');
    });

    it('binds a document entity to the only-available mongo identity (legitimate match)', () => {
        const result = resolveDatastoreBinding(
            'archive', 'Database', NO_HINTS, null,
            [makeIdentity('mongodb', 'archive')],
            'document',
        );
        expect(result).toHaveLength(1);
        expect(result[0].technology).toBe('mongodb');
    });

    it('refuses to bind a document entity when only an rdbms identity exists', () => {
        const result = resolveDatastoreBinding(
            'archive', 'Database', NO_HINTS, null,
            [makeIdentity('mysql', 'app_main')],
            'document',
        );
        expect(result).toEqual([]);
    });

    it('default-RDBMS guard: refuses non-RDBMS auto-binding when kindFamily is unset', () => {
        // Without a kindFamily signal, the only auto-discovered identity is
        // a MongoDB hint. The default-RDBMS guard fails-closed so that
        // non-RDBMS connections require positive evidence (kindFamily,
        // structural extractor, or explicit YAML datastores).
        const result = resolveDatastoreBinding(
            'orders', 'Database', NO_HINTS, null,
            [makeIdentity('mongodb', 'archive')],
            // no kindFamily
        );
        expect(result).toEqual([]);
    });

    it('default-RDBMS guard: still binds RDBMS identities when kindFamily is unset', () => {
        // The guard only filters out specialized non-RDBMS identities.
        // A single high-confidence mysql/postgres identity still binds.
        const result = resolveDatastoreBinding(
            'orders', 'Database', NO_HINTS, null,
            [makeIdentity('mysql', 'app_main')],
            // no kindFamily
        );
        expect(result).toHaveLength(1);
        expect(result[0].technology).toBe('mysql');
    });

    it('rejects a yaml binding whose technology mismatches the kindFamily', () => {
        const yaml: RepoHints = {
            databases: [{ id: 'archive', technology: 'mongodb', shared: false, tables: ['orders'] }],
            decorators: [],
            hints: [],
        };
        const result = resolveDatastoreBinding(
            'orders', 'Database', yaml, null,
            undefined,
            'rdbms',
        );
        expect(result).toEqual([]);
    });

    // ─── Multi-binding (multi-database shape) ────────────────────────────

    it('returns ALL candidate identities when 2+ are compatible', () => {
        // The repo has multiple logical RDBMS databases (e.g. `orders` and
        // `payments`). With kindFamily='rdbms', both pass the family gate.
        // The resolver returns both — the LLM-assignment step picks per-table.
        const result = resolveDatastoreBinding(
            'orders', 'Database', NO_HINTS, null,
            [
                makeIdentity('mysql', 'orders'),
                makeIdentity('mysql', 'payments'),
            ],
            'rdbms',
        );
        expect(result).toHaveLength(2);
        for (const b of result) {
            expect(b.bindingReason).toBe('env-canonical-default');
            expect(b.confidence).toBeLessThan(0.9);
        }
    });

    it('prefers high-confidence identities when both high and medium are present', () => {
        const result = resolveDatastoreBinding(
            'orders', 'Database', NO_HINTS, null,
            [
                makeIdentity('mysql', 'main', 'medium'),
                makeIdentity('mysql', 'sole', 'high'),
            ],
            'rdbms',
        );
        // The high-conf identity wins as a sole-candidate; medium is dropped.
        expect(result).toHaveLength(1);
        expect(result[0].datastoreId).toBe('sole');
    });

    it('returns empty when identities array is empty', () => {
        const result = resolveDatastoreBinding(
            'orders', 'Database', NO_HINTS, null,
            [],
            'rdbms',
        );
        expect(result).toEqual([]);
    });

    it('Cache: auto-promotes discovered kv identities (redis/memcached) — S1.2 policy flip', () => {
        // Policy flip (S1.2): a discovered kv cache (redis/memcached) connection
        // becomes a Datastore on its own, mirroring the Database path's rdbms
        // auto-promotion. Previously Cache was yaml-only.
        const result = resolveDatastoreBinding(
            null, 'Cache', NO_HINTS, null,
            [makeIdentity('redis', 'cache')],
        );
        expect(result).toHaveLength(1);
        expect(result[0].technology).toBe('redis');
    });

    it('Cache: does NOT auto-promote non-kv (rdbms) identities — family gate', () => {
        // A cache access must never bind to a SQL identity.
        const result = resolveDatastoreBinding(
            null, 'Cache', NO_HINTS, null,
            [makeIdentity('mysql', 'orders')],
        );
        expect(result).toEqual([]);
    });

    it('Cache: P0 yaml binding works', () => {
        const yaml: RepoHints = {
            databases: [{ id: 'shared-redis', technology: 'redis', shared: true, tables: [] }],
            decorators: [],
            hints: [],
        };
        const result = resolveDatastoreBinding(null, 'Cache', yaml, null);
        expect(result).toHaveLength(1);
        expect(result[0].datastoreId).toBe('shared-redis');
        expect(result[0].bindingReason).toBe('p0-yaml');
        expect(result[0].confidence).toBe(1.0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// family/tech sync invariants
//
// `pruneIncompatibleStoredInEdges` (in `src/graph/mutations/data-contracts.ts`)
// builds its incompatibility map by inverting `familyForTechnology` over
// `ALL_KNOWN_TECHS`. The two MUST stay in sync — if someone adds a new
// technology to one without the other, the prune mutation silently misses it.
// ═════════════════════════════════════════════════════════════════════════════

describe('family/tech sync invariant', () => {
    it('every entry in ALL_KNOWN_TECHS resolves to a non-null family', () => {
        const orphanTechs = ALL_KNOWN_TECHS.filter(t => familyForTechnology(t) === null);
        expect(orphanTechs).toEqual([]);
    });

    it('every kind family in ALL_KIND_FAMILIES has at least one tech in ALL_KNOWN_TECHS', () => {
        const familiesWithoutTech = ALL_KIND_FAMILIES.filter(family =>
            !ALL_KNOWN_TECHS.some(tech => familyForTechnology(tech) === family),
        );
        expect(familiesWithoutTech).toEqual([]);
    });

    it('each tech belongs to exactly one family (no cross-family duplicates)', () => {
        for (const tech of ALL_KNOWN_TECHS) {
            const family = familyForTechnology(tech);
            expect(family).not.toBeNull();
            // Sanity: family must be one of the declared values.
            expect(ALL_KIND_FAMILIES).toContain(family);
        }
    });

    // Time-series stores (InfluxDB et al.) are a first-class datastore family, not
    // an opaque/unknown technology. A datastore FN here is a blast-radius safety
    // break, so the family must resolve and never collapse into rdbms/kv.
    it('influxdb (and time-series siblings) resolve to the timeseries family', () => {
        expect(familyForTechnology('influxdb')).toBe('timeseries');
        expect(familyForTechnology('victoriametrics')).toBe('timeseries');
        expect(familyForTechnology('questdb')).toBe('timeseries');
        expect(familyForTechnology('prometheus')).toBe('timeseries');
        expect(ALL_KIND_FAMILIES).toContain('timeseries');
    });
});
