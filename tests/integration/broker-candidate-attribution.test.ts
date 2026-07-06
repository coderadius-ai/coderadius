import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { resolveServiceDependenciesFromEnvVars } from '../../src/ingestion/processors/service-host-to-dependency-resolver.js';
import { clearRepoHintsCache } from '../../src/config/repo-hints.js';
import type { ResolvedRepo } from '../../src/graph/types.js';

// ═════════════════════════════════════════════════════════════════════════════
// Attribution rules (C2 + B4) — per-service candidate emission:
//   - compose env: ONLY the service's own block (exact name, fallback dir-basename)
//   - config-declared broker connections: only services WITH code, only from
//     config files under THEIR serviceDir (monorepo scoping)
//   - hasCode = any code artifact (SourceFile counts, Functions not required)
//   - infra-only services (nginx/sftp) receive NOTHING from app sources
// ═════════════════════════════════════════════════════════════════════════════

const COMMIT = 'ATTR_TEST';
const REPO_QUALIFIED = 'crtest/attr-repo';
const HOST = 'bus.attr-test.acme.example';
const SVC = (name: string) => `cr:service:${REPO_QUALIFIED}:${name}`;

const RABBITMQ_CONFIG = `<?php
return [
    'rabbitmq' => [
        'connection' => [
            'default' => [
                'host'  => '${HOST}',
                'port'  => 5672,
                'vhost' => 'acme',
            ],
        ],
        'producer' => [
            'order_events' => [
                'connection' => 'default',
                'exchange' => ['type' => 'fanout', 'name' => 'acme.order-events'],
            ],
        ],
    ],
];
`;

const COMPOSE = `
services:
  orders-api:
    image: acme/orders-api
    environment:
      RABBITMQ_HOST: ${HOST}
  billing-api:
    image: acme/billing-api
    environment:
      BILLING_FLAG: "1"
  nginx:
    image: nginx:1.25
    environment:
      NGINX_PORT: "8080"
`;

let repoDir: string;
let repo: ResolvedRepo;

function write(rel: string, contents: string) {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

async function wipeFixture() {
    const session = getNeo4jSession();
    try {
        await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: `cr:service:${REPO_QUALIFIED}` });
        await session.run('MATCH (n) WHERE n.id STARTS WITH $p DETACH DELETE n', { p: 'cr://test/attr/' });
        await session.run('MATCH (c:BrokerCandidate) WHERE c.serviceUrn STARTS WITH $p DETACH DELETE c', { p: `cr:service:${REPO_QUALIFIED}` });
        await session.run('MATCH (b:MessageBroker) WHERE b.host CONTAINS $h DETACH DELETE b', { h: 'attr-test.acme.example' });
    } finally { await session.close(); }
}

async function createService(name: string, opts: { withSourceFile?: boolean } = {}) {
    const session = getNeo4jSession();
    try {
        await session.run(
            `CREATE (s:Service {id: $id}) SET s.name = $name, s.valid_from_commit = $c, s.valid_to_commit = null`,
            { id: SVC(name), name, c: COMMIT },
        );
        if (opts.withSourceFile) {
            // SourceFile WITHOUT any Function: pins the code-artifact predicate
            // (a config-only service still has code).
            await session.run(
                `MATCH (s:Service {id: $id})
                 CREATE (sf:SourceFile {id: $sfId})
                 SET sf.valid_from_commit = $c, sf.valid_to_commit = null
                 MERGE (s)-[r:CONTAINS]->(sf)
                 ON CREATE SET r.valid_from_commit = $c, r.valid_to_commit = null`,
                { id: SVC(name), sfId: `cr://test/attr/sourcefile:${name}`, c: COMMIT },
            );
        }
    } finally { await session.close(); }
}

async function candidatesOf(name: string): Promise<Array<{ sourceType: string; connectionName: string | null; host: string }>> {
    const session = getNeo4jSession();
    try {
        const r = await session.run(
            `MATCH (c:BrokerCandidate) WHERE c.serviceUrn = $svc
             RETURN c.sourceType AS sourceType, c.connectionName AS connectionName, c.host AS host
             ORDER BY c.sourceType`,
            { svc: SVC(name) },
        );
        return r.records.map(rec => ({
            sourceType: rec.get('sourceType') as string,
            connectionName: (rec.get('connectionName') as string | null) ?? null,
            host: rec.get('host') as string,
        }));
    } finally { await session.close(); }
}

describe('broker candidate attribution — per-service scoping', () => {
    beforeAll(async () => {
        await initSchema({ silent: true });
        await wipeFixture();

        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-attr-'));
        repo = { name: 'attr-repo', path: repoDir, origin: 'local', org: 'crtest' };

        write('docker-compose.yml', COMPOSE);
        // orders-api: code (reads the broker env var) + its own broker config.
        write('apps/orders-api/src/Config.php', `<?php\n$host = getenv('RABBITMQ_HOST');\n`);
        write('apps/orders-api/config/autoload/rabbitmq.global.php', RABBITMQ_CONFIG);
        // billing-api: code, NO broker config of its own.
        write('apps/billing-api/src/Billing.php', `<?php\n$flag = getenv('BILLING_FLAG');\n`);

        // Graph: two code services (SourceFile, zero Functions) + one infra-only.
        await createService('orders-api', { withSourceFile: true });
        await createService('billing-api', { withSourceFile: true });
        await createService('nginx');

        await resolveServiceDependenciesFromEnvVars([repo]);
    });

    afterAll(async () => {
        await wipeFixture();
        await closeNeo4j();
        clearRepoHintsCache(repoDir);
        fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it('the code service with the config receives BOTH the s4 config candidate and its compose s3 candidate', async () => {
        const candidates = await candidatesOf('orders-api');
        const config = candidates.filter(c => c.sourceType === 'config');
        const env = candidates.filter(c => c.sourceType === 'env-var');

        expect(config).toHaveLength(1);
        expect(config[0].connectionName).toBe('default');
        expect(config[0].host).toBe(HOST);

        expect(env).toHaveLength(1);
        expect(env[0].host).toBe(HOST);
    });

    it('a sibling code service does NOT inherit another service\'s config broker (monorepo scoping)', async () => {
        expect(await candidatesOf('billing-api')).toEqual([]);
    });

    it('an infra-only service receives NO candidates (compose-block isolation + code gate)', async () => {
        expect(await candidatesOf('nginx')).toEqual([]);
    });

    it('SourceFile without Functions counts as code (the s4 candidate above proves the predicate)', async () => {
        // orders-api has ZERO Function nodes — only a SourceFile — yet it
        // received the config-declared candidate, which is gated on hasCode.
        const candidates = await candidatesOf('orders-api');
        expect(candidates.some(c => c.sourceType === 'config')).toBe(true);
    });
});
