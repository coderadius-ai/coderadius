import { describe, it, expect } from 'vitest';
import {
    buildRepoEnvMap,
    resolveTemplates,
} from '../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';
import type { RepoEnvMap } from '../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

function makeMap(entries: Record<string, string>): RepoEnvMap {
    const vars = new Map<string, { value: string; sourceFile: string; confidence: 'high'|'medium'|'low' }>();
    for (const [k, v] of Object.entries(entries)) vars.set(k, { value: v, sourceFile: '.env', confidence: 'high' });
    return { vars };
}

describe('env-var-resolver', () => {
    describe('symfony-env syntax', () => {
        it('resolves %env(VAR)%', () => {
            const env = makeMap({ DB_HOST: 'db.acme.com' });
            const r = resolveTemplates('%env(DB_HOST)%', 'symfony-env', env);
            expect(r.value).toBe('db.acme.com');
            expect(r.resolved).toBe(true);
            expect(r.trail).toContain('DB_HOST');
        });

        it('resolves %env(string:VAR)% with type modifier', () => {
            const env = makeMap({ DB_HOST: 'db.acme.com' });
            const r = resolveTemplates('%env(string:DB_HOST)%', 'symfony-env', env);
            expect(r.value).toBe('db.acme.com');
            expect(r.resolved).toBe(true);
        });

        it('uses default fallback %env(default:fallback:VAR)%', () => {
            const env = makeMap({});
            const r = resolveTemplates('%env(default:db.acme.com:DB_HOST)%', 'symfony-env', env);
            expect(r.value).toBe('db.acme.com');
            expect(r.resolved).toBe(true);
        });

        it('recursively resolves %env(resolve:DATABASE_URL)% containing %env(...)%', () => {
            const env = makeMap({
                DATABASE_URL: 'mysql://%env(DB_USER)%:%env(DB_PASS)%@%env(DB_HOST)%:3306/%env(DB_NAME)%',
                DB_USER: 'app',
                DB_PASS: 'secret',
                DB_HOST: 'db.acme.com',
                DB_NAME: 'app_main',
            });
            const r = resolveTemplates('%env(resolve:DATABASE_URL)%', 'symfony-env', env);
            expect(r.value).toBe('mysql://app:secret@db.acme.com:3306/app_main');
            expect(r.resolved).toBe(true);
            expect(r.trail).toContain('DATABASE_URL');
            expect(r.trail).toContain('DB_HOST');
            expect(r.trail).toContain('DB_NAME');
        });

        it('marks unresolvable when var is missing and no default', () => {
            const env = makeMap({});
            const r = resolveTemplates('%env(MISSING_VAR)%', 'symfony-env', env);
            expect(r.resolved).toBe(false);
        });

        it('aborts on resolve cycles', () => {
            const env = makeMap({
                A: '%env(resolve:B)%',
                B: '%env(resolve:A)%',
            });
            const r = resolveTemplates('%env(resolve:A)%', 'symfony-env', env, { maxDepth: 4 });
            expect(r.resolved).toBe(false);
        });
    });

    describe('js-template syntax', () => {
        it('resolves process.env.VAR', () => {
            const env = makeMap({ DATABASE_HOST: 'db.acme.com', DATABASE_NAME: 'app_main' });
            const r = resolveTemplates('process.env.DATABASE_HOST', 'js-template', env);
            expect(r.value).toBe('db.acme.com');
            expect(r.resolved).toBe(true);
        });

        it("resolves process.env['VAR']", () => {
            const env = makeMap({ DATABASE_HOST: 'db.acme.com' });
            const r = resolveTemplates("process.env['DATABASE_HOST']", 'js-template', env);
            expect(r.value).toBe('db.acme.com');
        });

        it('resolves process.env["VAR"]', () => {
            const env = makeMap({ DATABASE_HOST: 'db.acme.com' });
            const r = resolveTemplates('process.env["DATABASE_HOST"]', 'js-template', env);
            expect(r.value).toBe('db.acme.com');
        });

        it('flags unresolved when var is missing', () => {
            const env = makeMap({});
            const r = resolveTemplates('process.env.MISSING', 'js-template', env);
            expect(r.resolved).toBe(false);
        });
    });

    describe('shell syntax', () => {
        it('resolves ${VAR}', () => {
            const env = makeMap({ DB_HOST: 'db.acme.com' });
            const r = resolveTemplates('${DB_HOST}', 'shell', env);
            expect(r.value).toBe('db.acme.com');
        });

        it('uses default ${VAR:-default}', () => {
            const env = makeMap({});
            const r = resolveTemplates('${DB_HOST:-localhost}', 'shell', env);
            expect(r.value).toBe('localhost');
            expect(r.resolved).toBe(true);
        });

        it('marks ${VAR:?error} unresolved when missing', () => {
            const env = makeMap({});
            const r = resolveTemplates('${DB_HOST:?must-set}', 'shell', env);
            expect(r.resolved).toBe(false);
        });

        it('resolves bare $VAR when isolated', () => {
            const env = makeMap({ DB_HOST: 'db.acme.com' });
            const r = resolveTemplates('$DB_HOST', 'shell', env);
            expect(r.value).toBe('db.acme.com');
        });
    });

    describe('helm', () => {
        it('always marks {{ }} as unresolved in Phase 1', () => {
            const env = makeMap({});
            const r = resolveTemplates('{{ .Values.db.host }}', 'helm', env);
            expect(r.resolved).toBe(false);
        });
    });

    describe('confidence floor', () => {
        it('degrades to medium when value comes from .env.example', () => {
            const vars = new Map<string, { value: string; sourceFile: string; confidence: 'high'|'medium'|'low' }>();
            vars.set('DB_HOST', { value: 'db.acme.com', sourceFile: '.env.example', confidence: 'medium' });
            const r = resolveTemplates('${DB_HOST}', 'shell', { vars });
            expect(r.value).toBe('db.acme.com');
            expect(r.resolved).toBe(true);
            expect(r.confidenceFloor).toBe('medium');
        });
    });

    describe('sentinel guard', () => {
        it('marks unresolved when resolved value is a sentinel', () => {
            const env = makeMap({ DB_HOST: '<host>' });
            const r = resolveTemplates('${DB_HOST}', 'shell', env);
            expect(r.resolved).toBe(false);
        });
    });

    describe('buildRepoEnvMap (chained .env files)', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-env-test-'));
        it('reads .env files in priority order, first wins', () => {
            fs.writeFileSync(path.join(tmp, '.env'), 'SHARED_HOST=fallback\nLOCAL_VAR=ok\n');
            fs.writeFileSync(path.join(tmp, '.env.production'), 'SHARED_HOST=prod\n');
            const map = buildRepoEnvMap(tmp);
            expect(map.vars.get('SHARED_HOST')?.value).toBe('prod');
            expect(map.vars.get('SHARED_HOST')?.confidence).toBe('high');
            expect(map.vars.get('LOCAL_VAR')?.value).toBe('ok');
        });

        it('reads docker-compose env block', () => {
            fs.writeFileSync(path.join(tmp, 'docker-compose.yml'),
                `services:\n  app:\n    environment:\n      MERGED_VAR: from-compose\n`);
            const map = buildRepoEnvMap(tmp);
            expect(map.vars.get('MERGED_VAR')?.value).toBe('from-compose');
        });
    });
});
