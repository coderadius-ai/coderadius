import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildRepoEnvMap,
    readDockerComposeEnvByService,
} from '../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';

// ═════════════════════════════════════════════════════════════════════════════
// Compose per-service scoping (C1) — the repo-global compose merge gave
// infra-only services (nginx/sftp/assets) the app's broker env and produced
// spurious CONNECTS_TO edges. `composeServiceNames` keeps ONLY the matching
// service block (exact lowercase match, never fuzzy); no match → ZERO compose
// vars. Without opts the merged behavior is byte-identical (regression pin
// for extractAllPhysicalHints).
// ═════════════════════════════════════════════════════════════════════════════

const COMPOSE = `
services:
  orders-app:
    image: acme/orders-app
    environment:
      RABBITMQ_HOST: bus.acme.internal
      APP_DEBUG: "0"
  worker:
    image: acme/worker
    environment:
      - WORKER_QUEUE=acme.orders
      - RABBITMQ_HOST=bus-worker.acme.internal
  nginx:
    image: nginx:1.25
    environment:
      NGINX_PORT: "8080"
  sftp:
    image: atmoz/sftp
`;

function makeRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-composescope-'));
}

function write(repo: string, rel: string, contents: string) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

describe('readDockerComposeEnvByService', () => {
    it('returns one entry per service with its own env block (object + array forms)', () => {
        const blocks = readDockerComposeEnvByService(COMPOSE);
        const byName = new Map(blocks.map(b => [b.serviceName, b.env]));

        expect([...byName.keys()].sort()).toEqual(['nginx', 'orders-app', 'worker']);
        expect(byName.get('orders-app')!.get('RABBITMQ_HOST')).toBe('bus.acme.internal');
        expect(byName.get('worker')!.get('RABBITMQ_HOST')).toBe('bus-worker.acme.internal');
        expect(byName.get('worker')!.get('WORKER_QUEUE')).toBe('acme.orders');
        expect(byName.get('nginx')!.get('NGINX_PORT')).toBe('8080');
        // env-less services contribute no block
        expect(byName.has('sftp')).toBe(false);
    });
});

describe('buildRepoEnvMap — composeServiceNames scoping', () => {
    let repo: string;
    beforeEach(() => { repo = makeRepo(); write(repo, 'docker-compose.yml', COMPOSE); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('keeps ONLY the matching service block and stamps sourceFile with #service', () => {
        const env = buildRepoEnvMap(repo, { composeServiceNames: ['orders-app'] });
        expect(env.vars.get('RABBITMQ_HOST')?.value).toBe('bus.acme.internal');
        expect(env.vars.get('RABBITMQ_HOST')?.sourceFile).toBe('docker-compose.yml#orders-app');
        // other services' vars are invisible
        expect(env.vars.has('WORKER_QUEUE')).toBe(false);
        expect(env.vars.has('NGINX_PORT')).toBe(false);
    });

    it('first listed candidate that matches wins (Service.name, then dir-basename)', () => {
        const env = buildRepoEnvMap(repo, { composeServiceNames: ['no-such-svc', 'worker'] });
        expect(env.vars.get('RABBITMQ_HOST')?.value).toBe('bus-worker.acme.internal');
        expect(env.vars.get('WORKER_QUEUE')?.value).toBe('acme.orders');
    });

    it('match is exact lowercase, never fuzzy', () => {
        const env = buildRepoEnvMap(repo, { composeServiceNames: ['ORDERS-APP'] });
        expect(env.vars.get('RABBITMQ_HOST')?.value).toBe('bus.acme.internal');
        const fuzzy = buildRepoEnvMap(repo, { composeServiceNames: ['orders'] });
        expect(fuzzy.vars.has('RABBITMQ_HOST')).toBe(false);
    });

    it('no matching block → ZERO compose vars (infra-only service isolation)', () => {
        const env = buildRepoEnvMap(repo, { composeServiceNames: ['sftp'] });
        expect(env.vars.has('RABBITMQ_HOST')).toBe(false);
        expect(env.vars.has('NGINX_PORT')).toBe(false);
        expect(env.vars.has('WORKER_QUEUE')).toBe(false);
    });

    it('PIN: without composeServiceNames the merged (first-writer-wins) behavior is unchanged', () => {
        const env = buildRepoEnvMap(repo);
        // orders-app appears before worker → first writer wins for RABBITMQ_HOST
        expect(env.vars.get('RABBITMQ_HOST')?.value).toBe('bus.acme.internal');
        expect(env.vars.get('WORKER_QUEUE')?.value).toBe('acme.orders');
        expect(env.vars.get('NGINX_PORT')?.value).toBe('8080');
        expect(env.vars.get('RABBITMQ_HOST')?.sourceFile).toBe('docker-compose.yml');
    });
});

describe('buildRepoEnvMap — includeRepoGlobalDefaults', () => {
    let repo: string;
    beforeEach(() => {
        repo = makeRepo();
        write(repo, 'helm/values.yaml', 'env:\n  - name: HELM_BUS_HOST\n    value: bus.helm.internal\n');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('false → helm values and accessor defaults are skipped (codeless services)', () => {
        const env = buildRepoEnvMap(repo, {
            includeRepoGlobalDefaults: false,
            accessorDefaults: [{ key: 'ACCESSOR_BUS_HOST', value: 'bus.accessor.internal' }],
        });
        expect(env.vars.has('HELM_BUS_HOST')).toBe(false);
        expect(env.vars.has('ACCESSOR_BUS_HOST')).toBe(false);
    });

    it('default (absent) → helm values and accessor defaults included (byte-identical pin)', () => {
        const env = buildRepoEnvMap(repo, {
            accessorDefaults: [{ key: 'ACCESSOR_BUS_HOST', value: 'bus.accessor.internal' }],
        });
        expect(env.vars.get('HELM_BUS_HOST')?.value).toBe('bus.helm.internal');
        expect(env.vars.get('ACCESSOR_BUS_HOST')?.value).toBe('bus.accessor.internal');
    });
});
