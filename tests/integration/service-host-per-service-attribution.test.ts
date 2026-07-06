import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { resolveServiceDependenciesFromEnvVars } from '../../src/ingestion/processors/service-host-to-dependency-resolver.js';
import { clearCodeEnvVarCache } from '../../src/ingestion/processors/connection-extractors/code-env-scanner.js';

describe('resolveServiceDependenciesFromEnvVars — per-service attribution + env-var API synthesis', () => {
    let repoPath: string;

    async function wipeFixture() {
        const session = getNeo4jSession();
        try {
            await session.run(`MATCH (n) WHERE n.id STARTS WITH 'cr:service:acme/orders-monorepo' DETACH DELETE n`);
            await session.run(`MATCH (n:APIInterface) WHERE n.apiSource = 'env-var' AND n.id CONTAINS 'acme.example.com' DETACH DELETE n`);
            await session.run(`MATCH (n:APIDeployment) WHERE n.id CONTAINS 'acme.example.com' DETACH DELETE n`);
        } finally { await session.close(); }
    }

    async function createService(qualifiedRepo: string, name: string) {
        const session = getNeo4jSession();
        try {
            const id = `cr:service:${qualifiedRepo}:${name}`;
            await session.run(
                `CREATE (s:Service {id: $id})
                 SET s.name = $name, s.valid_from_commit = 'TEST', s.valid_to_commit = null`,
                { id, name },
            );
        } finally { await session.close(); }
    }

    beforeAll(async () => {
        await initSchema({ silent: true });
        await wipeFixture();
        // Build the fixture monorepo on disk.
        repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-per-svc-attr-'));
        // apps/orders-api: reads PAYMENT_URL, has its own .env.
        fs.mkdirSync(path.join(repoPath, 'apps', 'orders-api', 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'apps', 'orders-api', '.env'),
            'PAYMENT_URL=https://payment.acme.example.com\n');
        fs.writeFileSync(path.join(repoPath, 'apps', 'orders-api', 'src', 'PaymentClient.ts'),
            "const url = process.env.PAYMENT_URL;\nexport const url2 = url;\n");
        // apps/orders-worker: reads INVENTORY_URL, has its own .env.
        fs.mkdirSync(path.join(repoPath, 'apps', 'orders-worker', 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'apps', 'orders-worker', '.env'),
            'INVENTORY_URL=https://inventory.acme.example.com\n');
        fs.writeFileSync(path.join(repoPath, 'apps', 'orders-worker', 'src', 'InventoryClient.ts'),
            "const url = process.env.INVENTORY_URL;\nexport const url2 = url;\n");
        // Repo root .env: a shared variable used only by code referencing it nowhere.
        fs.writeFileSync(path.join(repoPath, '.env'),
            'CRON_SECRET=stub\n');

        await createService('acme/orders-monorepo', 'orders-api');
        await createService('acme/orders-monorepo', 'orders-worker');
        clearCodeEnvVarCache();
    });

    afterAll(async () => {
        if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
        await wipeFixture();
        await closeNeo4j();
    });

    beforeEach(() => clearCodeEnvVarCache());

    it('attributes PAYMENT_URL to orders-api only (per-service env scoping)', async () => {
        const result = await resolveServiceDependenciesFromEnvVars([{
            name: 'orders-monorepo', org: 'acme', path: repoPath,
        } as any]);
        expect(result.externalApisLinked).toBeGreaterThanOrEqual(1);

        const session = getNeo4jSession();
        try {
            // (orders-api) CONSUMES_API → APIInterface(env-var) for payment.acme.example.com
            const r1 = await session.run(
                `MATCH (s:Service {name: 'orders-api'})-[:CONSUMES_API]->(api:APIInterface {apiSource: 'env-var'})-[:DEPLOYED_AT]->(d:APIDeployment)
                 WHERE s.id = 'cr:service:acme/orders-monorepo:orders-api'
                 RETURN d.host AS h ORDER BY h`,
            );
            const apiHosts = r1.records.map(r => r.get('h')).sort();
            expect(apiHosts).toContain('payment.acme.example.com');
            expect(apiHosts).not.toContain('inventory.acme.example.com');

            // (orders-worker) CONSUMES_API → APIInterface(env-var) for inventory.acme.example.com
            const r2 = await session.run(
                `MATCH (s:Service {name: 'orders-worker'})-[:CONSUMES_API]->(api:APIInterface {apiSource: 'env-var'})-[:DEPLOYED_AT]->(d:APIDeployment)
                 WHERE s.id = 'cr:service:acme/orders-monorepo:orders-worker'
                 RETURN d.host AS h ORDER BY h`,
            );
            const workerHosts = r2.records.map(r => r.get('h')).sort();
            expect(workerHosts).toContain('inventory.acme.example.com');
            expect(workerHosts).not.toContain('payment.acme.example.com');
        } finally { await session.close(); }
    });

    it('the CONSUMES_API edge carries the sourceEnvKey for provenance', async () => {
        await resolveServiceDependenciesFromEnvVars([{
            name: 'orders-monorepo', org: 'acme', path: repoPath,
        } as any]);
        const session = getNeo4jSession();
        try {
            const r = await session.run(
                `MATCH (s:Service {name: 'orders-api'})-[rel:CONSUMES_API]->(api:APIInterface {apiSource: 'env-var'})-[:DEPLOYED_AT]->(d:APIDeployment {host: 'payment.acme.example.com'})
                 WHERE s.id = 'cr:service:acme/orders-monorepo:orders-api'
                 RETURN rel.sourceEnvKey AS k, rel.source AS src`,
            );
            expect(r.records[0].get('k')).toBe('PAYMENT_URL');
            expect(r.records[0].get('src')).toBe('env-var');
        } finally { await session.close(); }
    });
});
