import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeMessageBroker } from '../../src/graph/mutations/data-contracts.js';
import { computeBrokerFingerprint, makeBrokerUrn } from '../../src/ingestion/core/messaging/broker-registry.js';

describe('cr analyze code --depth=structure', () => {
    const host = 'rabbitmq.structure-depth.acme.example';
    const vhost = 'orders';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run(`MATCH (b:MessageBroker) WHERE b.host = $host DETACH DELETE b`, { host });
        } finally {
            await s.close();
        }
    }

    beforeAll(async () => { await initSchema({ silent: true }); await wipe(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('runs deterministic reconcile as the terminal structure-only step', async () => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-structure-reconcile-'));
        fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'acme-structure-reconcile', version: '1.0.0' }), 'utf-8');
        try {
            const fp = computeBrokerFingerprint({ provider: 'rabbitmq', host, port: 5672, vhost });
            const primary = makeBrokerUrn('rabbitmq', fp, vhost);
            const secondary = 'cr:broker:rabbitmq:structure-secondary:orders';
            await mergeMessageBroker({
                urn: primary,
                provider: 'rabbitmq',
                fingerprint: fp,
                declaredVia: 'inferred',
                host,
                port: 5672,
                vhost,
                fingerprintScope: 'global',
            }, 'STRUCTURE_TEST');
            await mergeMessageBroker({
                urn: secondary,
                provider: 'rabbitmq',
                fingerprint: 'structure-secondary',
                declaredVia: 'inferred',
                host,
                port: 5672,
                vhost,
                fingerprintScope: 'global',
            }, 'STRUCTURE_TEST');

            const result = spawnSync(
                'bun',
                ['run', 'src/cli/index.ts', 'analyze', 'code', fixtureDir, '--depth=structure'],
                {
                    cwd: process.cwd(),
                    encoding: 'utf-8',
                    env: { ...process.env, NODE_ENV: 'test' },
                    timeout: 60_000,
                },
            );
            expect(result.status).toBe(0);

            const s = getNeo4jSession();
            try {
                const rows = await s.run(
                    `MATCH (b:MessageBroker)
                     WHERE b.host = $host
                     RETURN collect(b.id) AS ids`,
                    { host },
                );
                expect(rows.records[0].get('ids')).toEqual([primary]);
            } finally {
                await s.close();
            }
        } finally {
            fs.rmSync(fixtureDir, { recursive: true, force: true });
        }
    });
});
