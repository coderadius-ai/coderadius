import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildRepoEnvMap,
    readDockerComposeEnvByService,
} from '../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';

// ═════════════════════════════════════════════════════════════════════════════
// docker-compose `env_file:` resolution.
//
// Repro of a real miss: a service declares its datastore connection vars only
// in an `env_file`-referenced file (the inline `environment:` block does NOT
// carry them). The compose reader previously ignored `env_file:`, so a cache
// engine whose host lived exclusively in `app/local.env` (MEMCACHED_HOST /
// MEMCACHED_PORT) never reached the env map → no Cache hint, no Cache node.
//
// docker-compose precedence: inline `environment:` overrides `env_file:`.
// ═════════════════════════════════════════════════════════════════════════════

const COMPOSE = `
services:
  app:
    image: acme/orders-app
    env_file:
      - ./app/local.env
      - ./app/pact.env
    environment:
      APP_DEBUG: "0"
      MEMCACHED_PORT: "11999"
  worker:
    image: acme/worker
    env_file: ./app/local.env
  nginx:
    image: nginx:1.25
    environment:
      NGINX_PORT: "8080"
`;

const LOCAL_ENV = `
# committed dev env referenced via env_file
MEMCACHED_HOST=memcached
MEMCACHED_PORT=11211
MYSQL_HOST=db.acme.internal
MYSQL_DATABASE=orders
`;

function makeRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-envfile-'));
}

function write(repo: string, rel: string, contents: string) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

describe('readDockerComposeEnvByService — env_file', () => {
    it('captures env_file paths per service (array and string forms)', () => {
        const blocks = readDockerComposeEnvByService(COMPOSE);
        const byName = new Map(blocks.map(b => [b.serviceName, b]));

        expect(byName.get('app')!.envFiles).toEqual(['./app/local.env', './app/pact.env']);
        expect(byName.get('worker')!.envFiles).toEqual(['./app/local.env']);
        expect(byName.get('nginx')!.envFiles).toEqual([]);
    });

    it('includes a service that has env_file but no inline environment block', () => {
        const blocks = readDockerComposeEnvByService(COMPOSE);
        const worker = blocks.find(b => b.serviceName === 'worker');
        expect(worker).toBeDefined();
        expect(worker!.env.size).toBe(0);
        expect(worker!.envFiles).toEqual(['./app/local.env']);
    });
});

describe('buildRepoEnvMap — env_file resolution', () => {
    let repo: string;
    beforeEach(() => {
        repo = makeRepo();
        write(repo, 'docker-compose.yml', COMPOSE);
        write(repo, 'app/local.env', LOCAL_ENV);
        write(repo, 'app/pact.env', 'PACT_BROKER_URL=https://pact.acme.internal\n');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('resolves datastore vars that live only in an env_file (memcached repro)', () => {
        const env = buildRepoEnvMap(repo);
        expect(env.vars.get('MEMCACHED_HOST')?.value).toBe('memcached');
        expect(env.vars.get('MYSQL_HOST')?.value).toBe('db.acme.internal');
        expect(env.vars.get('MYSQL_DATABASE')?.value).toBe('orders');
        expect(env.vars.get('PACT_BROKER_URL')?.value).toBe('https://pact.acme.internal');
    });

    it('inline environment overrides env_file for the same key', () => {
        const env = buildRepoEnvMap(repo);
        // app.environment sets MEMCACHED_PORT=11999; env_file sets 11211 → inline wins
        expect(env.vars.get('MEMCACHED_PORT')?.value).toBe('11999');
    });

    it('scoped composeServiceNames resolves the matched service env_file', () => {
        const env = buildRepoEnvMap(repo, { composeServiceNames: ['worker'] });
        expect(env.vars.get('MEMCACHED_HOST')?.value).toBe('memcached');
        // nginx-only vars stay invisible under worker scope
        expect(env.vars.has('NGINX_PORT')).toBe(false);
    });

    it('missing env_file path is ignored gracefully', () => {
        fs.rmSync(path.join(repo, 'app/pact.env'));
        const env = buildRepoEnvMap(repo);
        // local.env still resolves; missing pact.env does not throw
        expect(env.vars.get('MEMCACHED_HOST')?.value).toBe('memcached');
        expect(env.vars.has('PACT_BROKER_URL')).toBe(false);
    });
});
