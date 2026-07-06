import { describe, it, expect, afterAll } from 'vitest';
import { extractAllPhysicalHints } from '../../../../../src/ingestion/processors/connection-extractors/registry.js';
import { canonicalizeDatastoreIdentities } from '../../../../../src/ingestion/processors/connection-extractors/canonicalizer.js';
import { buildPhysicalEndpoint } from '../../../../../src/ingestion/processors/physical-fingerprint.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * End-to-end tests for the NestJS registerAs + Zod config extraction path.
 *
 * Validates the full pipeline: plugin extraction → template resolution →
 * physical fingerprinting → canonicalization → cross-repo welding.
 *
 * The pattern under test:
 *   - `*.config.ts` with `registerAs('x', () => schema.parse(process.env))`
 *   - Zod schema `z.object({ DATABASE_HOST: z.string(), ... })`
 *   - Values resolved from Helm production values or .env files
 */

describe('orchestrator — NestJS registerAs + Zod config extraction', () => {
    const tempDirs: string[] = [];

    function mkRepo(files: Record<string, string>): string {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-nestjs-cfg-'));
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

    // ─── Core extraction ─────────────────────────────────────────────────────

    it('extracts a MySQL hint from registerAs + z.object config + Helm values', () => {
        const repo = mkRepo({
            'src/database/Database.config.ts': [
                "import { registerAs } from '@nestjs/config'",
                "import { z } from 'zod'",
                "const schema = z.object({",
                "    DATABASE_TYPE: z.literal('mysql'),",
                "    DATABASE_HOST: z.string().min(1),",
                "    DATABASE_PORT: z.string().min(1).optional(),",
                "    DATABASE_PASSWORD: z.string().min(1),",
                "    DATABASE_NAME: z.string().min(1),",
                "    DATABASE_USER: z.string().min(1),",
                "})",
                "export default registerAs('database', () => {",
                "    const config = schema.parse(process.env)",
                "    return { host: config.DATABASE_HOST, database: config.DATABASE_NAME }",
                "})",
            ].join('\n'),
            '.charts/api/values-production.yaml': [
                'envs:',
                '  plain:',
                '    - name: DATABASE_TYPE',
                "      value: 'mysql'",
                '    - name: DATABASE_HOST',
                "      value: 'mysql-prod.service.consul.'",
                '    - name: DATABASE_NAME',
                "      value: 'orders'",
                '    - name: DATABASE_PORT',
                "      value: '3309'",
            ].join('\n'),
        });

        const r = extractAllPhysicalHints(repo);
        const mysqlHints = r.hints.filter(h => h.technology === 'mysql');
        expect(mysqlHints.length).toBeGreaterThanOrEqual(1);

        const h = mysqlHints[0];
        expect(h.host).toBe('mysql-prod.service.consul.');
        expect(h.port).toBe(3309);
        expect(h.dbName).toBe('orders');
    });

    it('resolves portTemplate correctly from Helm values', () => {
        const repo = mkRepo({
            'src/db/Db.config.ts': [
                "import { registerAs } from '@nestjs/config'",
                "import { z } from 'zod'",
                "const schema = z.object({",
                "    DATABASE_TYPE: z.literal('postgres'),",
                "    DATABASE_HOST: z.string(),",
                "    DATABASE_PORT: z.string(),",
                "    DATABASE_NAME: z.string(),",
                "})",
                "export default registerAs('db', () => schema.parse(process.env))",
            ].join('\n'),
            '.helm/values-production.yaml': [
                'envs:',
                '  plain:',
                '    - name: DATABASE_HOST',
                "      value: 'pg.prod.acme.com'",
                '    - name: DATABASE_NAME',
                "      value: 'analytics'",
                '    - name: DATABASE_PORT',
                "      value: '5433'",
            ].join('\n'),
        });

        const r = extractAllPhysicalHints(repo);
        const pgHint = r.hints.find(h => h.technology === 'postgres');
        expect(pgHint).toBeDefined();
        expect(pgHint!.port).toBe(5433);
        expect(pgHint!.host).toBe('pg.prod.acme.com');
    });

    it('falls back to defaultPort when portTemplate is absent or unresolvable', () => {
        const repo = mkRepo({
            'src/db/Db.config.ts': [
                "import { registerAs } from '@nestjs/config'",
                "import { z } from 'zod'",
                "const schema = z.object({",
                "    DATABASE_TYPE: z.literal('mysql'),",
                "    DATABASE_HOST: z.string(),",
                "    DATABASE_NAME: z.string(),",
                // No DATABASE_PORT in schema
                "})",
                "export default registerAs('db', () => schema.parse(process.env))",
            ].join('\n'),
            '.env.production': [
                'DATABASE_HOST=db.prod.acme.com',
                'DATABASE_NAME=inventory',
            ].join('\n'),
        });

        const r = extractAllPhysicalHints(repo);
        const h = r.hints.find(h => h.technology === 'mysql');
        expect(h).toBeDefined();
        expect(h!.port).toBe(3306); // MySQL default
    });

    // ─── Cross-repo fingerprint welding ──────────────────────────────────────

    it('produces matching fingerprints for two repos pointing to the same database', () => {
        // Repo A: NestJS registerAs + Zod pattern (the pattern we're fixing)
        const repoA = mkRepo({
            'src/database/Database.config.ts': [
                "import { registerAs } from '@nestjs/config'",
                "import { z } from 'zod'",
                "const schema = z.object({",
                "    DATABASE_TYPE: z.literal('mysql'),",
                "    DATABASE_HOST: z.string(),",
                "    DATABASE_PORT: z.string().optional(),",
                "    DATABASE_NAME: z.string(),",
                "})",
                "export default registerAs('database', () => schema.parse(process.env))",
            ].join('\n'),
            '.charts/api/values-production.yaml': [
                'envs:',
                '  plain:',
                '    - name: DATABASE_HOST',
                "      value: 'mysql-shared.service.consul.'",
                '    - name: DATABASE_NAME',
                "      value: 'shared_db'",
                '    - name: DATABASE_PORT',
                "      value: '3309'",
            ].join('\n'),
        });

        // Repo B: Doctrine YAML pattern (already working)
        const repoB = mkRepo({
            'config/packages/doctrine.yaml': [
                'doctrine:',
                '    dbal:',
                '        url: "mysql://u:p@mysql-shared.service.consul.:3309/shared_db"',
            ].join('\n'),
        });

        const hA = extractAllPhysicalHints(repoA).hints.find(h => h.technology === 'mysql');
        const hB = extractAllPhysicalHints(repoB).hints.find(h => h.technology === 'mysql');

        expect(hA).toBeDefined();
        expect(hB).toBeDefined();

        const fpA = buildPhysicalEndpoint({
            technology: hA!.technology, host: hA!.host, port: hA!.port,
            logicalName: hA!.dbName, schemaOrNs: hA!.schemaOrNs,
        });
        const fpB = buildPhysicalEndpoint({
            technology: hB!.technology, host: hB!.host, port: hB!.port,
            logicalName: hB!.dbName, schemaOrNs: hB!.schemaOrNs,
        });

        expect(fpA).not.toBeNull();
        expect(fpB).not.toBeNull();
        expect(fpA!.fingerprint).toBe(fpB!.fingerprint);
    });

    // ─── Canonicalization ────────────────────────────────────────────────────

    it('produces a valid DatastoreIdentity from the extracted hint', () => {
        const repo = mkRepo({
            'src/db/Db.config.ts': [
                "import { registerAs } from '@nestjs/config'",
                "import { z } from 'zod'",
                "const schema = z.object({",
                "    DATABASE_TYPE: z.literal('mysql'),",
                "    DATABASE_HOST: z.string(),",
                "    DATABASE_NAME: z.string(),",
                "})",
                "export default registerAs('db', () => schema.parse(process.env))",
            ].join('\n'),
            '.charts/api/values-production.yaml': [
                'envs:',
                '  plain:',
                '    - name: DATABASE_HOST',
                "      value: 'mysql-prod.consul.'",
                '    - name: DATABASE_NAME',
                "      value: 'payments'",
            ].join('\n'),
        });

        const r = extractAllPhysicalHints(repo);
        const identities = canonicalizeDatastoreIdentities(r.hints);
        const id = identities.find(i => i.identityKey === 'payments');
        expect(id).toBeDefined();
        expect(id!.canonicalHint.technology).toBe('mysql');
        expect(id!.canonicalHint.host).toBe('mysql-prod.consul.');
    });

    // ─── Negative cases ──────────────────────────────────────────────────────

    it('does NOT extract from config files without registerAs', () => {
        const repo = mkRepo({
            'src/cache/Cache.config.ts': [
                "export default {",
                "    DATABASE_HOST: 'localhost',",
                "    DATABASE_NAME: 'cache',",
                "};",
            ].join('\n'),
        });
        const r = extractAllPhysicalHints(repo);
        // No hints from the NestJS plugin (may still get hints from env trios)
        const nestjsHints = r.hints.filter(h =>
            h.sourceFile.includes('Cache.config.ts'));
        expect(nestjsHints).toHaveLength(0);
    });

    it('does NOT extract from registerAs without z.object', () => {
        const repo = mkRepo({
            'src/app/App.config.ts': [
                "import { registerAs } from '@nestjs/config'",
                "export default registerAs('app', () => ({",
                "    port: parseInt(process.env.APP_PORT ?? '3000', 10),",
                "}))",
            ].join('\n'),
        });
        const r = extractAllPhysicalHints(repo);
        const appHints = r.hints.filter(h =>
            h.sourceFile.includes('App.config.ts'));
        expect(appHints).toHaveLength(0);
    });

    it('does NOT extract when Zod schema has no DB-relevant keys', () => {
        const repo = mkRepo({
            'src/jwt/Jwt.config.ts': [
                "import { registerAs } from '@nestjs/config'",
                "import { z } from 'zod'",
                "const schema = z.object({",
                "    JWT_SECRET: z.string(),",
                "    JWT_EXPIRY: z.string(),",
                "    APP_PORT: z.string(),",
                "})",
                "export default registerAs('jwt', () => schema.parse(process.env))",
            ].join('\n'),
        });
        const r = extractAllPhysicalHints(repo);
        const jwtHints = r.hints.filter(h =>
            h.sourceFile.includes('Jwt.config.ts'));
        expect(jwtHints).toHaveLength(0);
    });
});
