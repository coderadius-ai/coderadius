/**
 * s2 — declared-sink broker candidates: typed config + co-import gate.
 *
 * The provider comes from the customer's coderadius.yaml declaration
 * (contract); the config↔sink association is proven by a file importing BOTH
 * the declared package AND the config module. A DB-shaped typed config in the
 * same service has no such co-import and must never become a broker candidate.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeDeclaredSinkBrokerCandidates } from '../../../../../src/ingestion/processors/connection-extractors/declared-sink-broker-candidates.js';
import { buildRepoEnvMap } from '../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';
import {
    loadRepoHints,
    getDeclaredBrokerClients,
    clearRepoHintsCache,
    buildCustomKnowledgePrompt,
    type RepoHints,
} from '../../../../../src/config/repo-hints.js';

const REPO = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../fixtures/acme-broker-discovery/acme-shipping',
);
const SERVICE_DIR = path.join(REPO, 'apps/dispatcher');

function envOf() {
    return buildRepoEnvMap(REPO, { serviceRoot: SERVICE_DIR });
}

describe('synthesizeDeclaredSinkBrokerCandidates (s2)', () => {
    it('emits a candidate for the co-imported broker config: declared provider, resolved host/vhost', () => {
        const { hints, claimedEnvKeys } = synthesizeDeclaredSinkBrokerCandidates(
            SERVICE_DIR, envOf(), [{ name: '@acme/wire', provider: 'rabbitmq' }],
        );
        expect(hints).toHaveLength(1);
        const h = hints[0]!;
        expect(h.source).toBe('s2-declared-sink');
        expect(h.provider).toBe('rabbitmq');
        expect(h.providerSource).toBe('declared');
        expect(h.host).toBe('bus.acme-prod.internal');
        expect(h.vhost).toBe('shipping');
        expect(h.sourceEnvKey).toBe('SHIP_BUS_HOSTNAME');
        // Consumed keys are claimed so s0 never double-emits them.
        expect(claimedEnvKeys).toContain('SHIP_BUS_HOSTNAME');
        expect(claimedEnvKeys).toContain('SHIP_BUS_VHOST');
        // The DB config has no co-import: its keys are NOT claimed by s2.
        expect(claimedEnvKeys).not.toContain('SHIP_DB_HOST');
    });

    it('the DB-shaped config without co-import never becomes a broker candidate', () => {
        const { hints } = synthesizeDeclaredSinkBrokerCandidates(
            SERVICE_DIR, envOf(), [{ name: '@acme/wire', provider: 'rabbitmq' }],
        );
        expect(hints.some(h => h.host === 'db.acme-prod.internal')).toBe(false);
    });

    it('no declared broker-clients → no scan, no candidates', () => {
        const { hints, claimedEnvKeys } = synthesizeDeclaredSinkBrokerCandidates(SERVICE_DIR, envOf(), []);
        expect(hints).toHaveLength(0);
        expect(claimedEnvKeys.size).toBe(0);
    });

    it('a declared package that nothing co-imports with the config → no candidate', () => {
        const { hints } = synthesizeDeclaredSinkBrokerCandidates(
            SERVICE_DIR, envOf(), [{ name: '@acme/other-bus', provider: 'kafka' }],
        );
        expect(hints).toHaveLength(0);
    });

    it('credentials from the env never reach the hint', () => {
        const { hints } = synthesizeDeclaredSinkBrokerCandidates(
            SERVICE_DIR, envOf(), [{ name: '@acme/wire', provider: 'rabbitmq' }],
        );
        expect(JSON.stringify(hints)).not.toContain('fixture-placeholder');
    });
});

describe('getDeclaredBrokerClients (coderadius.yaml provider field)', () => {
    it('reads name+provider pairs from packages.analyze broker-client entries', () => {
        clearRepoHintsCache(REPO);
        const hints = loadRepoHints(REPO);
        expect(getDeclaredBrokerClients(hints)).toEqual([
            { name: '@acme/wire', provider: 'rabbitmq' },
        ]);
    });

    it('the LLM customKnowledge prompt is BYTE-IDENTICAL with or without provider (eval replay cache stays valid)', () => {
        const base = {
            hints: [],
            databases: [],
            packages: {
                analyze: [{ name: '@acme/wire', kind: 'broker-client' as const, label: 'Acme Wire Bus' }],
                ignore: [],
            },
        } as unknown as RepoHints;
        const withProvider = {
            ...base,
            packages: {
                analyze: [{ name: '@acme/wire', kind: 'broker-client' as const, label: 'Acme Wire Bus', provider: 'rabbitmq' as const }],
                ignore: [],
            },
        } as unknown as RepoHints;
        expect(buildCustomKnowledgePrompt(withProvider)).toBe(buildCustomKnowledgePrompt(base));
    });
});
