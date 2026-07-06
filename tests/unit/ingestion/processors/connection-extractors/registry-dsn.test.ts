import { describe, it, expect, afterAll } from 'vitest';
import { extractAllPhysicalHints } from '../../../../../src/ingestion/processors/connection-extractors/registry.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * End-to-end tests for the orchestrator's env-var DSN synthesis path.
 *
 * The orchestrator MUST recognize single-variable DSNs like DATABASE_URL when
 * they appear in .env files or Helm values. Critically, credentials (user,
 * password) must NEVER appear in the emitted PhysicalEndpointHint — this is a
 * hard security invariant.
 */

describe('orchestrator — DSN env-var synthesis', () => {
    const tempDirs: string[] = [];

    function mkRepo(files: Record<string, string>): string {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-orch-dsn-'));
        tempDirs.push(tmp);
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(tmp, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
        }
        return tmp;
    }

    afterAll(() => {
        for (const d of tempDirs) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('synthesizes a hint from a Heroku-style DATABASE_URL', () => {
        const repo = mkRepo({
            '.env.production': 'DATABASE_URL=postgres://app_user:s3cret@db.prod.acme.com:5432/app_main\n',
        });
        const r = extractAllPhysicalHints(repo);
        expect(r.hints).toHaveLength(1);
        const h = r.hints[0];
        expect(h.technology).toBe('postgres');
        expect(h.host).toBe('db.prod.acme.com');
        expect(h.port).toBe(5432);
        expect(h.dbName).toBe('app_main');
        expect(h.connectionAlias).toBe('default');
    });

    it('NEVER leaks the password into the synthesized hint', () => {
        const repo = mkRepo({
            '.env.production': 'DATABASE_URL=mysql://app:NEVER_LEAK_THIS@db/inventory\n',
        });
        const r = extractAllPhysicalHints(repo);
        const json = JSON.stringify({ hints: r.hints, dropped: r.droppedTemplate });
        expect(json).not.toContain('NEVER_LEAK_THIS');
        expect(json).not.toContain('app:');
        expect(json).not.toContain(':app@');
    });

    it('treats unrelated variables (e.g. URLs to non-DB services) as non-DSN', () => {
        const repo = mkRepo({
            '.env.production': [
                'API_BASE_URL=https://api.acme.com/v1',
                'AUTH_URL=https://auth.acme.com/oauth',
                'WEBHOOK_URL=https://webhook.example.com/hook',
            ].join('\n'),
        });
        const r = extractAllPhysicalHints(repo);
        // The DSN synthesizer only matches *known DB schemes* — http(s) URLs
        // never produce a DataContainer hint.
        expect(r.hints).toHaveLength(0);
    });

    it('handles multiple DSNs (PRIMARY_DATABASE_URL, READ_DATABASE_URL) with distinct aliases', () => {
        const repo = mkRepo({
            '.env.production': [
                'PRIMARY_DATABASE_URL=postgres://u:p@primary.db/app',
                'READ_DATABASE_URL=postgres://u:p@replica.db/app',
            ].join('\n'),
        });
        const r = extractAllPhysicalHints(repo);
        expect(r.hints).toHaveLength(2);
        const aliases = new Set(r.hints.map(h => h.connectionAlias));
        expect(aliases.has('primary')).toBe(true);
        expect(aliases.has('read')).toBe(true);
    });

    it('parses MONGO_URI alongside DATABASE_URL', () => {
        const repo = mkRepo({
            '.env.production': [
                'DATABASE_URL=postgres://u:p@pg.prod.acme.com/main',
                'MONGO_URI=mongodb://m:p@cluster.mongo.acme/myapp',
            ].join('\n'),
        });
        const r = extractAllPhysicalHints(repo);
        const techs = new Set(r.hints.map(h => h.technology));
        expect(techs.has('postgres')).toBe(true);
        expect(techs.has('mongodb')).toBe(true);
    });

    it('skips templated DSN values (resolver leaves placeholder unresolved)', () => {
        const repo = mkRepo({
            '.env.production': 'DATABASE_URL=postgres://${MISSING_USER}:${MISSING_PASS}@db/app\n',
        });
        const r = extractAllPhysicalHints(repo);
        expect(r.hints).toHaveLength(0);
    });

    it('extracts schemaOrNs from Postgres DSN currentSchema query', () => {
        const repo = mkRepo({
            '.env.production': 'DATABASE_URL=postgres://u:p@pg.prod.acme.com/app?currentSchema=audit\n',
        });
        const r = extractAllPhysicalHints(repo);
        expect(r.hints).toHaveLength(1);
        expect(r.hints[0].schemaOrNs).toBe('audit');
    });

    it('two repos with the SAME DATABASE_URL produce the same fingerprint (welding precondition)', async () => {
        const repoA = mkRepo({
            '.env.production': 'DATABASE_URL=postgres://userA:passA@shared.db.acme.com:5432/app_main\n',
        });
        const repoB = mkRepo({
            '.env.production': 'DATABASE_URL=postgres://userB:differentPass@shared.db.acme.com:5432/app_main\n',
        });
        const a = extractAllPhysicalHints(repoA).hints[0];
        const b = extractAllPhysicalHints(repoB).hints[0];

        // Same physical endpoint despite different credentials — credentials
        // intentionally don't enter the identity. This is what makes the
        // cross-repo welding work for Node/Heroku-style apps.
        const { buildPhysicalEndpoint } = await import(
            '../../../../../src/ingestion/processors/physical-fingerprint.js'
        );
        const fpA = buildPhysicalEndpoint({
            technology: a.technology, host: a.host, port: a.port,
            logicalName: a.dbName, schemaOrNs: a.schemaOrNs,
        })!.fingerprint;
        const fpB = buildPhysicalEndpoint({
            technology: b.technology, host: b.host, port: b.port,
            logicalName: b.dbName, schemaOrNs: b.schemaOrNs,
        })!.fingerprint;

        expect(fpA).toBe(fpB);
    });

    it('SPRING_DATASOURCE_URL pattern is recognized', () => {
        const repo = mkRepo({
            '.env.production': 'SPRING_DATASOURCE_URL=jdbc:postgresql://db.acme.com:5432/orders?currentSchema=public\n',
        });
        const r = extractAllPhysicalHints(repo);
        expect(r.hints).toHaveLength(1);
        const h = r.hints[0];
        expect(h.technology).toBe('postgres');
        expect(h.host).toBe('db.acme.com');
        expect(h.dbName).toBe('orders');
    });

    // ─── Local-network host retention (regression) ──────────────────────────────
    //
    // Hints whose host is a Docker-Compose service name or loopback used to be
    // dropped at extraction time. They must now SURVIVE extraction (so the
    // originating repo can still bind its tables to a real Datastore) while
    // their physical fingerprint is suppressed (so two independent repos that
    // both write to `localhost`/`mysql` aren't welded into one Datastore).

    it('keeps a hint whose host is a Docker-Compose service name (e.g. DB_PRIMARY_HOST=mysql)', () => {
        const repo = mkRepo({
            'docker-compose.yml': [
                'version: "3"',
                'services:',
                '  app:',
                '    image: php:8',
                '    environment:',
                '      DB_PRIMARY_HOST: mysql',
                '      DB_PRIMARY_DBNAME: orders_main',
                '      DB_PRIMARY_DRIVER: pdo_mysql',
                '',
            ].join('\n'),
        });
        const r = extractAllPhysicalHints(repo);
        const hint = r.hints.find(h => h.host === 'mysql');
        expect(hint).toBeDefined();
        expect(hint!.technology).toBe('mysql');
        expect(hint!.dbName).toBe('orders_main');
    });

    it('keeps a hint whose host is loopback (monolith with DB_HOST=127.0.0.1)', () => {
        const repo = mkRepo({
            '.env': 'DB_HOST=127.0.0.1\nDB_NAME=acme_dev\nDB_DRIVER=pdo_mysql\n',
        });
        const r = extractAllPhysicalHints(repo);
        const hint = r.hints.find(h => h.host === '127.0.0.1');
        expect(hint).toBeDefined();
        expect(hint!.dbName).toBe('acme_dev');
        expect(hint!.technology).toBe('mysql');
    });

    it('still drops empty / sentinel / unresolved-template hosts', async () => {
        const repo = mkRepo({
            '.env': 'DB_HOST=${UNSET_VAR}\nDB_NAME=app\nDB_DRIVER=mysql\n',
        });
        const r = extractAllPhysicalHints(repo);
        // The unresolved-template hint must NOT survive extraction.
        expect(r.hints.find(h => h.host.includes('${'))).toBeUndefined();
    });

    it('local-network hosts produce no cross-repo fingerprint', async () => {
        const repo = mkRepo({
            'docker-compose.yml': [
                'services:',
                '  app:',
                '    environment:',
                '      DB_PRIMARY_HOST: mysql',
                '      DB_PRIMARY_DBNAME: orders_main',
                '      DB_PRIMARY_DRIVER: pdo_mysql',
                '',
            ].join('\n'),
        });
        const r = extractAllPhysicalHints(repo);
        const hint = r.hints.find(h => h.host === 'mysql');
        expect(hint).toBeDefined();
        const { buildPhysicalEndpoint } = await import(
            '../../../../../src/ingestion/processors/physical-fingerprint.js'
        );
        const fp = buildPhysicalEndpoint({
            technology: hint!.technology, host: hint!.host, port: hint!.port,
            logicalName: hint!.dbName, schemaOrNs: hint!.schemaOrNs,
        });
        // No fingerprint → no cross-repo welding for service-name hosts.
        expect(fp).toBeNull();
    });
});
