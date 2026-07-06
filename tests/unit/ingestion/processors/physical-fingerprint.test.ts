import { describe, it, expect } from 'vitest';
import {
    buildPhysicalEndpoint,
    canonicalizeTechnology,
    defaultPort,
    familyFor,
    isUnbindableHost,
    isUnfingerprintableHost,
    isUnusableHost,
    isUnusableLogicalName,
    normalizeDbName,
    normalizeHost,
} from '../../../../src/ingestion/processors/physical-fingerprint.js';

describe('physical-fingerprint', () => {
    describe('canonicalizeTechnology', () => {
        it('normalizes alias technologies', () => {
            expect(canonicalizeTechnology('mariadb')).toBe('mysql');
            expect(canonicalizeTechnology('postgresql')).toBe('postgres');
            expect(canonicalizeTechnology('mongo')).toBe('mongodb');
            expect(canonicalizeTechnology('mongodb+srv')).toBe('mongodb');
        });
        it('preserves canonical names case-insensitively', () => {
            expect(canonicalizeTechnology('MySQL')).toBe('mysql');
            expect(canonicalizeTechnology('REDIS')).toBe('redis');
        });
    });

    describe('familyFor', () => {
        it('maps technologies to families', () => {
            expect(familyFor('mysql')).toBe('rdbms');
            expect(familyFor('postgres')).toBe('rdbms');
            expect(familyFor('mongodb')).toBe('document');
            expect(familyFor('redis')).toBe('kv');
            expect(familyFor('kafka')).toBe('broker');
            expect(familyFor('s3')).toBe('object');
        });
        it('returns undefined for unknown tech', () => {
            expect(familyFor('rocketdb')).toBeUndefined();
        });
    });

    describe('defaultPort', () => {
        it('returns canonical default ports', () => {
            expect(defaultPort('mysql')).toBe(3306);
            expect(defaultPort('mariadb')).toBe(3306);
            expect(defaultPort('postgres')).toBe(5432);
            expect(defaultPort('mongodb')).toBe(27017);
            expect(defaultPort('redis')).toBe(6379);
        });
    });

    describe('normalizeHost', () => {
        it('lowercases and trims', () => {
            expect(normalizeHost('  MyDB.SHARED  ')).toBe('mydb.shared');
        });
        it('strips IPv6 brackets', () => {
            expect(normalizeHost('[::1]')).toBe('::1');
        });
        it('strips trailing FQDN dot', () => {
            expect(normalizeHost('example.com.')).toBe('example.com');
        });
        it('returns empty for falsy', () => {
            expect(normalizeHost('')).toBe('');
        });
    });

    describe('normalizeDbName', () => {
        it('strips backticks', () => {
            expect(normalizeDbName('mysql', '`app_main`')).toBe('app_main');
        });
        it('strips quotes', () => {
            expect(normalizeDbName('mysql', '"app_main"')).toBe('app_main');
            expect(normalizeDbName('postgres', "'app'")).toBe('app');
        });
        it('strips slashes', () => {
            expect(normalizeDbName('mysql', '/app_main/')).toBe('app_main');
        });
        it('lowercases', () => {
            expect(normalizeDbName('mysql', 'AppMain')).toBe('appmain');
        });
        it('URL-decodes', () => {
            expect(normalizeDbName('mysql', 'app%20main')).toBe('app main');
        });
    });

    // ─── Host predicates: isUnbindableHost vs isUnfingerprintableHost ────────────
    //
    // The two predicates encode different concerns:
    //   - isUnbindableHost: drop the hint at extraction time (the value isn't a
    //     real host at all — empty, sentinel, unresolved template).
    //   - isUnfingerprintableHost: keep the hint, but skip cross-repo welding
    //     (loopback / Docker-Compose service names bind in-repo but aren't
    //     stable across repos).
    //
    // Conflating these two — as the original `isUnusableHost` did — broke
    // monoliths whose only DB connection is `DB_HOST=127.0.0.1` or
    // `DB_HOST=mysql`: the hint was dropped entirely and every Doctrine /
    // Eloquent table fell through to "no Datastore".

    describe('isUnbindableHost (extraction-time drop)', () => {
        it('keeps loopback hosts — monoliths with DB_HOST=localhost still bind in-repo', () => {
            expect(isUnbindableHost('localhost')).toBe(false);
            expect(isUnbindableHost('127.0.0.1')).toBe(false);
            expect(isUnbindableHost('0.0.0.0')).toBe(false);
            expect(isUnbindableHost('::1')).toBe(false);
            expect(isUnbindableHost('host.docker.internal')).toBe(false);
        });
        it('keeps Docker-Compose service names — they bind in-repo even if not weldable', () => {
            expect(isUnbindableHost('mysql')).toBe(false);
            expect(isUnbindableHost('postgres')).toBe(false);
            expect(isUnbindableHost('redis')).toBe(false);
            expect(isUnbindableHost('db')).toBe(false);
            expect(isUnbindableHost('mongo')).toBe(false);
        });
        it('drops sentinels and unresolved templates', () => {
            expect(isUnbindableHost('<host>')).toBe(true);
            expect(isUnbindableHost('your-host')).toBe(true);
            expect(isUnbindableHost('${DB_HOST}')).toBe(true);
            expect(isUnbindableHost('%env(DB_HOST)%')).toBe(true);
            expect(isUnbindableHost('process.env.DB_HOST')).toBe(true);
            expect(isUnbindableHost('{{ .Values.db.host }}')).toBe(true);
        });
        it('drops empty values', () => {
            expect(isUnbindableHost('')).toBe(true);
            expect(isUnbindableHost('   ')).toBe(true);
        });
        it('accepts real DNS hosts', () => {
            expect(isUnbindableHost('db.prod.acme.com')).toBe(false);
            expect(isUnbindableHost('mysql.shared.svc.cluster.local')).toBe(false);
        });
    });

    describe('isUnfingerprintableHost (cross-repo weld suppression)', () => {
        it('catches loopback hosts (cannot weld across repos)', () => {
            expect(isUnfingerprintableHost('localhost')).toBe(true);
            expect(isUnfingerprintableHost('127.0.0.1')).toBe(true);
            expect(isUnfingerprintableHost('::1')).toBe(true);
            expect(isUnfingerprintableHost('host.docker.internal')).toBe(true);
        });
        it('catches Docker-Compose service names (`mysql`, `postgres`, ...)', () => {
            expect(isUnfingerprintableHost('mysql')).toBe(true);
            expect(isUnfingerprintableHost('postgres')).toBe(true);
            expect(isUnfingerprintableHost('redis')).toBe(true);
            expect(isUnfingerprintableHost('db')).toBe(true);
        });
        it('catches sentinels and templates', () => {
            expect(isUnfingerprintableHost('<host>')).toBe(true);
            expect(isUnfingerprintableHost('${DB_HOST}')).toBe(true);
        });
        it('accepts real DNS hosts (can weld across repos)', () => {
            expect(isUnfingerprintableHost('db.prod.acme.com')).toBe(false);
            expect(isUnfingerprintableHost('mysql.shared.svc.cluster.local')).toBe(false);
        });
    });

    describe('isUnusableHost (legacy alias for isUnfingerprintableHost)', () => {
        it('preserves the original strict semantics for existing callers', () => {
            expect(isUnusableHost('localhost')).toBe(true);
            expect(isUnusableHost('mysql')).toBe(true);
            expect(isUnusableHost('${DB_HOST}')).toBe(true);
            expect(isUnusableHost('db.prod.acme.com')).toBe(false);
        });
    });

    describe('isUnusableLogicalName', () => {
        it('catches sentinels and templates', () => {
            expect(isUnusableLogicalName('<dbname>')).toBe(true);
            expect(isUnusableLogicalName('${DB}')).toBe(true);
            expect(isUnusableLogicalName('process.env.DB_NAME')).toBe(true);
        });
        it('accepts real names', () => {
            expect(isUnusableLogicalName('app_main')).toBe(false);
            expect(isUnusableLogicalName('orders_prod')).toBe(false);
        });
    });

    describe('buildPhysicalEndpoint', () => {
        it('produces a stable 16-hex fingerprint', () => {
            const ep = buildPhysicalEndpoint({
                technology: 'mysql', host: 'db.prod.acme.com', port: 3306,
                logicalName: 'app_main',
            });
            expect(ep).not.toBeNull();
            expect(ep!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
            expect(ep!.family).toBe('rdbms');
            expect(ep!.host).toBe('db.prod.acme.com');
            expect(ep!.port).toBe(3306);
            expect(ep!.logicalName).toBe('app_main');
        });

        it('is symmetric across casing', () => {
            const a = buildPhysicalEndpoint({ technology: 'mysql', host: 'DB.Prod.ACME.com', port: 3306, logicalName: 'AppMain' });
            const b = buildPhysicalEndpoint({ technology: 'mysql', host: 'db.prod.acme.com', port: 3306, logicalName: 'appmain' });
            expect(a!.fingerprint).toBe(b!.fingerprint);
        });

        it('applies default port when missing', () => {
            const a = buildPhysicalEndpoint({ technology: 'mysql', host: 'db.acme.com', logicalName: 'app' });
            const b = buildPhysicalEndpoint({ technology: 'mysql', host: 'db.acme.com', port: 3306, logicalName: 'app' });
            expect(a!.fingerprint).toBe(b!.fingerprint);
        });

        it('treats mariadb as mysql', () => {
            const a = buildPhysicalEndpoint({ technology: 'mariadb', host: 'db.acme.com', port: 3306, logicalName: 'app' });
            const b = buildPhysicalEndpoint({ technology: 'mysql', host: 'db.acme.com', port: 3306, logicalName: 'app' });
            expect(a!.fingerprint).toBe(b!.fingerprint);
        });

        it('rejects unusable hosts', () => {
            expect(buildPhysicalEndpoint({ technology: 'mysql', host: 'localhost', logicalName: 'app' })).toBeNull();
            expect(buildPhysicalEndpoint({ technology: 'mysql', host: '${DB}', logicalName: 'app' })).toBeNull();
        });

        it('rejects unusable logical names', () => {
            expect(buildPhysicalEndpoint({ technology: 'mysql', host: 'db.acme.com', logicalName: '${DB}' })).toBeNull();
            expect(buildPhysicalEndpoint({ technology: 'mysql', host: 'db.acme.com', logicalName: '<DBName>' })).toBeNull();
        });

        it('rejects unknown technology family', () => {
            expect(buildPhysicalEndpoint({ technology: 'starbase', host: 'db.acme.com', logicalName: 'x' })).toBeNull();
        });

        it('separates Postgres schema from logical name in the key', () => {
            const sameDbA = buildPhysicalEndpoint({ technology: 'postgres', host: 'pg.acme.com', port: 5432, logicalName: 'app_main', schemaOrNs: 'public' });
            const sameDbB = buildPhysicalEndpoint({ technology: 'postgres', host: 'pg.acme.com', port: 5432, logicalName: 'app_main', schemaOrNs: 'audit' });
            expect(sameDbA!.fingerprint).not.toBe(sameDbB!.fingerprint);
        });

        it('strips MySQL backticks before fingerprinting', () => {
            const a = buildPhysicalEndpoint({ technology: 'mysql', host: 'db.acme.com', port: 3306, logicalName: '`app_main`' });
            const b = buildPhysicalEndpoint({ technology: 'mysql', host: 'db.acme.com', port: 3306, logicalName: 'app_main' });
            expect(a!.fingerprint).toBe(b!.fingerprint);
        });
    });
});
