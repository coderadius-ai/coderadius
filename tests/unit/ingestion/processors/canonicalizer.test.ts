import { describe, it, expect } from 'vitest';
import {
    canonicalizeDatastoreIdentities,
    stripEnvSuffix,
    inferEnvironment,
} from '../../../../src/ingestion/processors/connection-extractors/canonicalizer.js';
import type { PhysicalEndpointHint } from '../../../../src/ingestion/processors/connection-extractors/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hint(overrides: Partial<PhysicalEndpointHint> = {}): PhysicalEndpointHint {
    return {
        technology: 'mysql',
        host: 'mysql.acme.com',
        port: 3306,
        dbName: 'orders',
        sourceFile: '.env.production',
        confidence: 'high',
        templateSyntax: 'none',
        isTemplate: false,
        ...overrides,
    };
}

// ─── stripEnvSuffix ──────────────────────────────────────────────────────────

describe('stripEnvSuffix', () => {
    it('strips recognised dev/prod/staging suffixes', () => {
        expect(stripEnvSuffix('orders-dev')).toBe('orders');
        expect(stripEnvSuffix('orders_prod')).toBe('orders');
        expect(stripEnvSuffix('orders-production')).toBe('orders');
        expect(stripEnvSuffix('payments-staging')).toBe('payments');
        expect(stripEnvSuffix('inventory_test')).toBe('inventory');
        expect(stripEnvSuffix('users-local')).toBe('users');
        expect(stripEnvSuffix('billing-qa')).toBe('billing');
        expect(stripEnvSuffix('shipments_uat')).toBe('shipments');
    });

    it('is case-insensitive on the suffix', () => {
        expect(stripEnvSuffix('Orders-DEV')).toBe('Orders');
        expect(stripEnvSuffix('PAYMENTS_PROD')).toBe('PAYMENTS');
    });

    it('does NOT strip versioning / feature suffixes', () => {
        expect(stripEnvSuffix('orders_v2')).toBe('orders_v2');
        expect(stripEnvSuffix('payments_archive')).toBe('payments_archive');
        expect(stripEnvSuffix('users-api')).toBe('users-api');
        expect(stripEnvSuffix('inventory_legacy')).toBe('inventory_legacy');
    });

    it('does NOT strip when suffix is mid-string', () => {
        expect(stripEnvSuffix('orders-dev-shard1')).toBe('orders-dev-shard1');
        expect(stripEnvSuffix('prod-orders')).toBe('prod-orders');
    });

    it('leaves dbName untouched when no recognised suffix', () => {
        expect(stripEnvSuffix('orders')).toBe('orders');
        expect(stripEnvSuffix('payments_main')).toBe('payments_main');
    });
});

// ─── inferEnvironment ────────────────────────────────────────────────────────

describe('inferEnvironment', () => {
    it('detects production from dbName / sourceFile markers', () => {
        expect(inferEnvironment('orders', '.helm/values-prod.yaml')).toBe('production');
        expect(inferEnvironment('orders-prod', '.env.production')).toBe('production');
        expect(inferEnvironment('orders-acme-core-production', '.helm/values-acme-core-production.yaml')).toBe('production');
    });

    it('detects staging', () => {
        expect(inferEnvironment('orders-staging', '.helm/values-staging.yaml')).toBe('staging');
        expect(inferEnvironment('orders', '.helm/values-stage.yaml')).toBe('staging');
    });

    it('detects development from docker-compose / -dev suffix', () => {
        expect(inferEnvironment('orders-dev', 'docker-compose.yml')).toBe('development');
        expect(inferEnvironment('orders', 'docker-compose.dev.yml')).toBe('development');
    });

    it('falls back to unknown', () => {
        expect(inferEnvironment('orders', 'config/database.yml')).toBe('unknown');
    });
});

// ─── canonicalizeDatastoreIdentities ─────────────────────────────────────────

describe('canonicalizeDatastoreIdentities', () => {
    it('returns empty array for empty input', () => {
        expect(canonicalizeDatastoreIdentities([])).toEqual([]);
    });

    it('returns one identity per single hint', () => {
        const result = canonicalizeDatastoreIdentities([
            hint({ dbName: 'orders' }),
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].identityKey).toBe('orders');
        expect(result[0].environments).toHaveLength(1);
    });

    it('collapses prod + dev variants of the same logical DB', () => {
        const helmProd = hint({
            dbName: 'orders',
            host: 'orders.prod.acme.com',
            sourceFile: '.helm/values-prod.yaml',
        });
        const dockerDev = hint({
            dbName: 'orders-dev',
            host: 'mysql',
            sourceFile: 'docker-compose.yml',
        });

        const result = canonicalizeDatastoreIdentities([helmProd, dockerDev]);
        expect(result).toHaveLength(1);
        expect(result[0].identityKey).toBe('orders');
        expect(result[0].canonicalHint).toBe(helmProd);
        expect(result[0].environments).toHaveLength(2);
        expect(result[0].environments.map(e => e.environment).sort()).toEqual(['development', 'production']);
    });

    it('does NOT collapse logically different DBs', () => {
        const orders = hint({ dbName: 'orders', sourceFile: '.helm/values-prod.yaml' });
        const payments = hint({ dbName: 'payments', sourceFile: '.helm/values-prod.yaml' });

        const result = canonicalizeDatastoreIdentities([orders, payments]);
        expect(result).toHaveLength(2);
        expect(result.map(i => i.identityKey).sort()).toEqual(['orders', 'payments']);
    });

    it('groups by stripped dbName regardless of alias mismatch (helm + docker)', () => {
        // Helm-prod has no connectionAlias (manifest doesn't carry env-var
        // prefix info); docker-compose carries alias 'self' from DB_SELF_*
        // pattern. With alias-first grouping these would have split; with
        // dbName-first they collapse into one logical identity.
        const helmProd = hint({ dbName: 'orders', sourceFile: '.helm/values-prod.yaml' });
        const dockerSelf = hint({ dbName: 'orders-dev', connectionAlias: 'self', sourceFile: 'docker-compose.yml' });

        const result = canonicalizeDatastoreIdentities([helmProd, dockerSelf]);
        expect(result).toHaveLength(1);
        expect(result[0].identityKey).toBe('orders');
    });

    it('does collapse same dbName-root regardless of different connectionAlias', () => {
        // Two hints with the same logical dbName but different per-env aliases.
        // Most enterprise repos look like this — alias is just a per-env label.
        const a = hint({ dbName: 'orders', connectionAlias: 'primary', sourceFile: '.helm/values.yaml' });
        const b = hint({ dbName: 'orders-dev', connectionAlias: 'replica', sourceFile: 'docker-compose.yml' });

        const result = canonicalizeDatastoreIdentities([a, b]);
        expect(result).toHaveLength(1);
        expect(result[0].identityKey).toBe('orders');
    });

    it('picks helm-prod over docker-compose as canonical', () => {
        const docker = hint({
            dbName: 'orders',
            host: 'mysql',
            sourceFile: 'docker-compose.yml',
        });
        const helmProd = hint({
            dbName: 'orders',
            host: 'mysql.prod.acme.com',
            sourceFile: '.helm/values-acme-core-production.yaml',
        });

        const result = canonicalizeDatastoreIdentities([docker, helmProd]);
        expect(result).toHaveLength(1);
        expect(result[0].canonicalHint.sourceFile).toBe('.helm/values-acme-core-production.yaml');
    });

    it('breaks ties using DNS-shaped host preference', () => {
        // Same tier, different host shape.
        const serviceName = hint({
            dbName: 'orders',
            host: 'mysql',
            sourceFile: 'docker-compose.yml',
        });
        const dnsShape = hint({
            dbName: 'orders',
            host: 'mysql.acme.com',
            sourceFile: 'docker-compose.dev.yml',
        });

        const result = canonicalizeDatastoreIdentities([serviceName, dnsShape]);
        expect(result).toHaveLength(1);
        // dnsShape ('mysql.acme.com') has a real DNS host → wins.
        expect(result[0].canonicalHint.host).toBe('mysql.acme.com');
    });

    it('treats _v2 as a different identity (not an env suffix)', () => {
        const v1 = hint({ dbName: 'orders' });
        const v2 = hint({ dbName: 'orders_v2' });

        const result = canonicalizeDatastoreIdentities([v1, v2]);
        expect(result).toHaveLength(2);
    });

    it('handles three-hint scope (helm-prod + 2 docker-compose with mismatched aliases)', () => {
        // Mirrors a common enterprise repo shape: helm production (no alias),
        // docker-compose dev variant of the same DB (with a per-env alias),
        // and a second independent DB also in docker-compose. Expect 2
        // identities, with prod/dev collapsed by dbName-root regardless of
        // the docker-compose `alias='something-different-from-helm-prod'`.
        const helmProd = hint({
            dbName: 'orders',
            host: 'orders.prod.acme.com',
            sourceFile: '.helm/values-prod.yaml',
            // no connectionAlias on helm
        });
        const dockerOrdersDev = hint({
            dbName: 'orders-dev',
            host: 'mysql',
            sourceFile: 'docker-compose.yml',
            connectionAlias: 'svc-a',     // arbitrary per-env alias
        });
        const dockerPayments = hint({
            dbName: 'payments',
            host: 'mysql-payments',
            sourceFile: 'docker-compose.yml',
            connectionAlias: 'svc-b',
        });

        const result = canonicalizeDatastoreIdentities([helmProd, dockerOrdersDev, dockerPayments]);
        expect(result).toHaveLength(2);
        const keys = result.map(i => i.identityKey).sort();
        expect(keys).toEqual(['orders', 'payments']);
        const ordersIdentity = result.find(i => i.identityKey === 'orders')!;
        expect(ordersIdentity.environments).toHaveLength(2);
        expect(ordersIdentity.canonicalHint.sourceFile).toBe('.helm/values-prod.yaml');
    });

    it('preserves insertion order for non-collapsed identities', () => {
        const a = hint({ dbName: 'inventory' });
        const b = hint({ dbName: 'shipping' });
        const c = hint({ dbName: 'notifications' });

        const result = canonicalizeDatastoreIdentities([a, b, c]);
        expect(result.map(i => i.identityKey)).toEqual(['inventory', 'shipping', 'notifications']);
    });

    it('is idempotent on repeated invocations', () => {
        const hints = [
            hint({ dbName: 'orders', sourceFile: '.helm/values-prod.yaml' }),
            hint({ dbName: 'orders-dev', sourceFile: 'docker-compose.yml' }),
            hint({ dbName: 'payments', sourceFile: '.helm/values-prod.yaml' }),
        ];
        const a = canonicalizeDatastoreIdentities(hints);
        const b = canonicalizeDatastoreIdentities(hints);
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });
});

// ─── Cross-technology dbName collisions ──────────────────────────────────────
// Regression: a timeseries store's schema/bucket is frequently named after the
// app (INFLUXDB_SCHEMA=<app>), colliding with the RDBMS database of the same
// name. dbName-only grouping collapsed them into one identity and let the
// timeseries technology overwrite the RDBMS — corrupting the relational store
// and stranding its tables/functions. Distinct families must stay distinct.
describe('canonicalizeDatastoreIdentities — cross-technology identity boundaries', () => {
    it('does NOT merge an RDBMS and a timeseries store that share a logical dbName', () => {
        const mysql = hint({ technology: 'mysql', dbName: 'acme', host: 'mysql', port: 3306, sourceFile: '.env' });
        const influx = hint({ technology: 'influxdb', dbName: 'acme', host: 'influxdb', port: 8086, sourceFile: '.env' });

        const result = canonicalizeDatastoreIdentities([mysql, influx]);
        expect(result).toHaveLength(2);
        // RDBMS keeps its logical-db identity; the timeseries store is identified
        // by technology (the store instance is the blast-radius unit).
        expect(result.map(i => i.identityKey).sort()).toEqual(['acme', 'influxdb']);
        const influxId = result.find(i => i.canonicalHint.technology === 'influxdb')!;
        const mysqlId = result.find(i => i.canonicalHint.technology === 'mysql')!;
        expect(influxId.identityKey).toBe('influxdb');
        expect(mysqlId.identityKey).toBe('acme');
    });

    it('identifies schemaless families (timeseries/kv) by technology, never by picked-up dbName', () => {
        const influx = hint({ technology: 'influxdb', dbName: 'metrics_db', host: 'influxdb', port: 8086 });
        const memcached = hint({ technology: 'memcached', dbName: 'memcached', host: 'memcached', port: 11211 });

        const result = canonicalizeDatastoreIdentities([influx, memcached]);
        expect(result.map(i => i.identityKey).sort()).toEqual(['influxdb', 'memcached']);
    });

    it('still merges env-variants of the SAME schemaless technology', () => {
        const prod = hint({ technology: 'influxdb', dbName: 'acme', host: 'influx.prod.acme.com', sourceFile: '.helm/values-prod.yaml' });
        const dev = hint({ technology: 'influxdb', dbName: 'acme_dev', host: 'influxdb', sourceFile: 'docker-compose.yml' });

        const result = canonicalizeDatastoreIdentities([prod, dev]);
        expect(result).toHaveLength(1);
        expect(result[0].identityKey).toBe('influxdb');
        expect(result[0].environments).toHaveLength(2);
    });

    it('keeps two RDBMS logical DBs separate (unchanged behaviour)', () => {
        const orders = hint({ technology: 'mysql', dbName: 'orders' });
        const payments = hint({ technology: 'mysql', dbName: 'payments' });

        const result = canonicalizeDatastoreIdentities([orders, payments]);
        expect(result.map(i => i.identityKey).sort()).toEqual(['orders', 'payments']);
    });
});
