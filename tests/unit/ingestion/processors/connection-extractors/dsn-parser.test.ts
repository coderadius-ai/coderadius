import { describe, it, expect } from 'vitest';
import {
    parseDsn,
    looksLikeDsn,
} from '../../../../../src/ingestion/processors/connection-extractors/dsn-parser.js';

describe('dsn-parser', () => {
    describe('parseDsn — happy paths', () => {
        it('parses a postgres DSN with credentials and strips them', () => {
            const r = parseDsn('postgres://app_user:s3cret@db.prod.acme.com:5432/app_main');
            expect(r).not.toBeNull();
            expect(r!.technology).toBe('postgres');
            expect(r!.host).toBe('db.prod.acme.com');
            expect(r!.port).toBe(5432);
            expect(r!.dbName).toBe('app_main');
            // Verify NO trace of the credentials anywhere in the result.
            const json = JSON.stringify(r);
            expect(json).not.toContain('s3cret');
            expect(json).not.toContain('app_user');
        });

        it('parses postgresql:// alias to postgres tech', () => {
            const r = parseDsn('postgresql://x:y@h:5432/d');
            expect(r!.technology).toBe('postgres');
        });

        it('parses mysql DSN', () => {
            const r = parseDsn('mysql://root:secret@db.host:3306/inventory');
            expect(r!.technology).toBe('mysql');
            expect(r!.host).toBe('db.host');
            expect(r!.port).toBe(3306);
            expect(r!.dbName).toBe('inventory');
        });

        it('parses mariadb scheme as mysql', () => {
            const r = parseDsn('mariadb://x@h/d');
            expect(r!.technology).toBe('mysql');
        });

        it('parses mongodb://', () => {
            const r = parseDsn('mongodb://u:p@cluster.mongo.example:27017/myapp');
            expect(r!.technology).toBe('mongodb');
            expect(r!.dbName).toBe('myapp');
            expect(JSON.stringify(r)).not.toContain(':p@');
        });

        it('parses mongodb+srv:// (Atlas) and recognises mongodb tech', () => {
            const r = parseDsn('mongodb+srv://u:secret@cluster0.acme.net/myapp');
            expect(r!.technology).toBe('mongodb');
            expect(r!.host).toBe('cluster0.acme.net');
            expect(r!.dbName).toBe('myapp');
            expect(JSON.stringify(r)).not.toContain('secret');
        });

        it('parses redis:// with empty path → db index 0', () => {
            const r = parseDsn('redis://x:y@cache.acme.com:6379');
            expect(r!.technology).toBe('redis');
            expect(r!.dbName).toBe('0');
        });

        it('parses redis:// with explicit db index in path', () => {
            const r = parseDsn('redis://x:y@cache.acme.com:6379/3');
            expect(r!.technology).toBe('redis');
            expect(r!.dbName).toBe('3');
        });

        it('parses rediss:// (TLS) as redis tech', () => {
            const r = parseDsn('rediss://h:6379/0');
            expect(r!.technology).toBe('redis');
        });

        it('parses memcached:// — no logical db, defaults dbName to "memcached"', () => {
            const r = parseDsn('memcached://cache.acme.com:11211');
            expect(r!.technology).toBe('memcached');
            expect(r!.host).toBe('cache.acme.com');
            expect(r!.port).toBe(11211);
            expect(r!.dbName).toBe('memcached');
        });

        it('parses memcached:// with no explicit port → defaults to 11211', () => {
            const r = parseDsn('memcached://cache.acme.com');
            expect(r!.technology).toBe('memcached');
            expect(r!.host).toBe('cache.acme.com');
            expect(r!.port).toBe(11211);
            expect(r!.dbName).toBe('memcached');
        });

        it('strips credentials from a memcached DSN', () => {
            const r = parseDsn('memcached://user:s3cret@cache.acme.com:11211');
            expect(r!.host).toBe('cache.acme.com');
            expect(JSON.stringify(r)).not.toContain('s3cret');
            expect(JSON.stringify(r)).not.toContain('user');
        });

        it('parses JDBC postgresql with port and db', () => {
            const r = parseDsn('jdbc:postgresql://db.acme.com:5432/orders');
            expect(r!.technology).toBe('postgres');
            expect(r!.host).toBe('db.acme.com');
            expect(r!.port).toBe(5432);
            expect(r!.dbName).toBe('orders');
        });

        it('parses JDBC mysql', () => {
            const r = parseDsn('jdbc:mysql://x.acme.com/inventory');
            expect(r!.technology).toBe('mysql');
            expect(r!.dbName).toBe('inventory');
        });
    });

    describe('parseDsn — query string params (Postgres schema)', () => {
        it('extracts currentSchema as schemaOrNs', () => {
            const r = parseDsn('postgres://h:5432/db?currentSchema=audit&sslmode=require');
            expect(r!.schemaOrNs).toBe('audit');
        });

        it('extracts search_path as schemaOrNs', () => {
            const r = parseDsn('postgres://h/db?search_path=public,extensions');
            expect(r!.schemaOrNs).toBe('public,extensions');
        });

        it('extracts schema for legacy syntax', () => {
            const r = parseDsn('postgres://h/db?schema=tenant_42');
            expect(r!.schemaOrNs).toBe('tenant_42');
        });

        it('extracts authSource for Mongo', () => {
            const r = parseDsn('mongodb://u:p@h:27017/myapp?authSource=admin');
            expect(r!.schemaOrNs).toBe('admin');
        });

        it('decodes percent-encoded query values', () => {
            const r = parseDsn('postgres://h/db?currentSchema=audit%2Fns');
            expect(r!.schemaOrNs).toBe('audit/ns');
        });
    });

    describe('parseDsn — security: credential stripping', () => {
        it('does not leak password into resolutionTrail or any field', () => {
            const dsn = 'postgres://leaky_user:VERY_SECRET_PASSWORD@db.prod/app';
            const r = parseDsn(dsn);
            const json = JSON.stringify(r);
            expect(json).not.toContain('VERY_SECRET_PASSWORD');
            expect(json).not.toContain('leaky_user');
        });

        it('handles password with @-symbol (URL-encoded) without leaking', () => {
            // common pattern: passwords containing '@' are URL-encoded as %40
            const dsn = 'mysql://app:p%40ss@host/db';
            const r = parseDsn(dsn);
            expect(r!.host).toBe('host');
            expect(r!.dbName).toBe('db');
            const json = JSON.stringify(r);
            expect(json).not.toContain('p@ss');
            expect(json).not.toContain('p%40ss');
            expect(json).not.toContain('app');
        });

        it('handles userinfo without password', () => {
            const r = parseDsn('postgres://app@host/db');
            expect(r!.host).toBe('host');
            expect(r!.dbName).toBe('db');
            const json = JSON.stringify(r);
            expect(json).not.toContain('app@');
        });

        it('handles missing userinfo entirely', () => {
            const r = parseDsn('postgres://host/db');
            expect(r!.host).toBe('host');
        });
    });

    describe('parseDsn — negative paths', () => {
        it('returns null for non-string', () => {
            expect(parseDsn(null)).toBeNull();
            expect(parseDsn(undefined)).toBeNull();
            expect(parseDsn(42)).toBeNull();
        });

        it('returns null for empty string', () => {
            expect(parseDsn('')).toBeNull();
            expect(parseDsn('   ')).toBeNull();
        });

        it('returns null for unsupported scheme', () => {
            expect(parseDsn('http://example.com')).toBeNull();
            expect(parseDsn('amqp://broker:5672/vhost')).toBeNull();
        });

        it('returns null when host or path is missing', () => {
            expect(parseDsn('postgres://')).toBeNull();
            expect(parseDsn('postgres://host')).toBeNull();              // no path
            expect(parseDsn('postgres://host/')).toBeNull();             // empty path
        });

        it('returns null for templated values (caller should resolve first)', () => {
            expect(parseDsn('postgres://${HOST}:5432/db')).toBeNull();
            expect(parseDsn('mysql://%env(DB_HOST)%/inventory')).toBeNull();
            expect(parseDsn('postgres://process.env.HOST/db')).toBeNull();
            expect(parseDsn('postgres://{{ .Values.host }}/db')).toBeNull();
        });

        it('returns null for malformed JDBC', () => {
            expect(parseDsn('jdbc:weird-scheme://host/db')).toBeNull();
            expect(parseDsn('jdbc:postgresql://')).toBeNull();
        });
    });

    describe('looksLikeDsn', () => {
        it('detects URL-shaped values', () => {
            expect(looksLikeDsn('postgres://x@h/d')).toBe(true);
            expect(looksLikeDsn('jdbc:mysql://h/d')).toBe(true);
            expect(looksLikeDsn('mongodb+srv://h/d')).toBe(true);
        });

        it('rejects plain values', () => {
            expect(looksLikeDsn('app_main')).toBe(false);
            expect(looksLikeDsn('db.prod.acme.com')).toBe(false);
            expect(looksLikeDsn('')).toBe(false);
            expect(looksLikeDsn(null as any)).toBe(false);
        });

        it('rejects template-bearing values', () => {
            expect(looksLikeDsn('postgres://${HOST}/db')).toBe(false);
            expect(looksLikeDsn('mysql://%env(URL)%')).toBe(false);
        });
    });
});
