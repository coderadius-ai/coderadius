import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRepoEnvMap } from '../../../../src/ingestion/processors/connection-extractors/env-var-resolver';

function makeRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-envscope-'));
}

function write(repo: string, rel: string, contents: string) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

describe('buildRepoEnvMap — per-service scoping', () => {
    let repo: string;
    beforeEach(() => { repo = makeRepo(); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('legacy call (no opts) reads repo-root .env only', () => {
        write(repo, '.env', 'PAYMENT_URL=https://payment.acme.example.com\n');
        const env = buildRepoEnvMap(repo);
        expect(env.vars.get('PAYMENT_URL')?.value).toBe('https://payment.acme.example.com');
    });

    it('serviceRoot prioritises service-local .env over repo-root .env', () => {
        // Repo root has a generic dev value; service has the real one.
        write(repo, '.env', 'PAYMENT_URL=http://localhost:9999\n');
        write(repo, 'apps/orders-api/.env', 'PAYMENT_URL=https://payment.acme.example.com\n');
        const env = buildRepoEnvMap(repo, { serviceRoot: path.join(repo, 'apps/orders-api') });
        expect(env.vars.get('PAYMENT_URL')?.value).toBe('https://payment.acme.example.com');
    });

    it('service-local env var not in repo root → present after scoping', () => {
        write(repo, '.env', 'GLOBAL_FLAG=1\n');
        write(repo, 'apps/orders-api/.env', 'ORDERS_API_PORT=4000\n');
        const env = buildRepoEnvMap(repo, { serviceRoot: path.join(repo, 'apps/orders-api') });
        expect(env.vars.get('ORDERS_API_PORT')?.value).toBe('4000');
        expect(env.vars.get('GLOBAL_FLAG')?.value).toBe('1');
    });

    it('codeReferencedFilter drops repo-root vars NOT referenced by service code', () => {
        // Repo .env has 3 vars; only PAYMENT_URL is in the code-referenced set.
        // INVENTORY_URL and CRON_SECRET must be dropped.
        write(repo, '.env', [
            'PAYMENT_URL=https://payment.acme.example.com',
            'INVENTORY_URL=https://inventory.acme.example.com',
            'CRON_SECRET=stub',
        ].join('\n'));
        const env = buildRepoEnvMap(repo, {
            serviceRoot: path.join(repo, 'apps/orders-api'),
            codeReferencedFilter: new Set(['PAYMENT_URL']),
        });
        expect(env.vars.has('PAYMENT_URL')).toBe(true);
        expect(env.vars.has('INVENTORY_URL')).toBe(false);
        expect(env.vars.has('CRON_SECRET')).toBe(false);
    });

    it('codeReferencedFilter does NOT filter service-local .env (those are already scoped)', () => {
        // Filter only applies to repo-root vars that "leak in"; service-local files
        // are scoped by definition and trusted.
        write(repo, 'apps/orders-api/.env', 'PAYMENT_URL=https://payment.acme.example.com\n');
        const env = buildRepoEnvMap(repo, {
            serviceRoot: path.join(repo, 'apps/orders-api'),
            codeReferencedFilter: new Set(['DIFFERENT_KEY']),
        });
        expect(env.vars.has('PAYMENT_URL')).toBe(true);
    });

    it('no serviceRoot + codeReferencedFilter set → filter still applies on repo .env (defensive)', () => {
        write(repo, '.env', 'PAYMENT_URL=https://payment.acme.example.com\nCRON_SECRET=stub\n');
        const env = buildRepoEnvMap(repo, {
            codeReferencedFilter: new Set(['PAYMENT_URL']),
        });
        expect(env.vars.has('PAYMENT_URL')).toBe(true);
        expect(env.vars.has('CRON_SECRET')).toBe(false);
    });
});
