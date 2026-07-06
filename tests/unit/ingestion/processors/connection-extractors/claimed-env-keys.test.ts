/**
 * claimedEnvKeys must be produced by the EXTRACTORS THEMSELVES — every lane
 * that consumes an env key (DSN patterns, tech trios, AND plugin classifiers
 * like nestjs-config) claims it, so the broker s0 host-shape lane can subtract
 * the full set instead of re-implementing matching with parallel regexes.
 *
 * The killer case pinned here: a DB-shaped typed config (`SHIP_DB_HOST` +
 * `SHIP_DB_NAME`) that nestjs-config CLASSIFIES but cannot EMIT (no technology
 * signal) — the keys are consumed by the datastore lane regardless, and must
 * never leak into the broker candidate lane as a false `s0` hit.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAllPhysicalHints } from '../../../../../src/ingestion/processors/connection-extractors/registry.js';
import {
    buildRepoEnvMap,
    synthesizeBrokerCandidateHints,
} from '../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';

const REPO = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../fixtures/acme-broker-discovery/acme-shipping',
);
const SERVICE_DIR = path.join(REPO, 'apps/dispatcher');

describe('extractAllPhysicalHints — claimedEnvKeys', () => {
    it('claims keys CLASSIFIED by nestjs-config even when no hint is emitted (missing tech signal)', () => {
        const { claimedEnvKeys } = extractAllPhysicalHints(REPO);
        expect(claimedEnvKeys).toContain('SHIP_DB_HOST');
        expect(claimedEnvKeys).toContain('SHIP_DB_NAME');
    });

    it('the claimed DB host never becomes a broker s0 candidate', () => {
        const { claimedEnvKeys } = extractAllPhysicalHints(REPO);
        const env = buildRepoEnvMap(REPO, { serviceRoot: SERVICE_DIR });
        const hints = synthesizeBrokerCandidateHints(env, { claimedEnvKeys });
        expect(hints.some(h => h.host === 'db.acme-prod.internal')).toBe(false);
    });
});

describe('DSN-shaped keys are claimed even when the code filter skips emission', () => {
    it('MEMCACHED_URI lands in claimedEnvKeys without a code reference, and never broker-candidates', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const { clearCodeEnvVarCache } = await import('../../../../../src/ingestion/processors/connection-extractors/code-env-scanner.js');
        const { extractAllPhysicalHints } = await import('../../../../../src/ingestion/processors/connection-extractors/registry.js');
        const { buildRepoEnvMap, synthesizeBrokerCandidateHints } = await import('../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js');
        const { clearRepoHintsCache } = await import('../../../../../src/config/repo-hints.js');

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-dsn-claim-'));
        try {
            clearCodeEnvVarCache();
            clearRepoHintsCache();
            // The code references SOMETHING (filter ON) but never MEMCACHED_URI.
            fs.mkdirSync(path.join(tmp, 'src'));
            fs.writeFileSync(path.join(tmp, 'src', 'app.php'), `<?php getenv('APP_DEBUG');`);
            fs.writeFileSync(path.join(tmp, '.env'), 'MEMCACHED_URI=cache-node:11211\nAPP_DEBUG=1\n');

            const { claimedEnvKeys } = extractAllPhysicalHints(tmp);
            expect(claimedEnvKeys.has('MEMCACHED_URI')).toBe(true);

            const env = buildRepoEnvMap(tmp);
            const hints = synthesizeBrokerCandidateHints(env, { claimedEnvKeys });
            expect(hints.filter((h) => h.host === 'cache-node')).toHaveLength(0);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
            clearCodeEnvVarCache();
            clearRepoHintsCache();
        }
    });
});
