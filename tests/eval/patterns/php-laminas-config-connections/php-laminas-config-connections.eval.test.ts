/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-laminas-config-connections
 *
 * Deterministic (zero LLM, zero graph DB) end-to-end pin of the PHP config-array
 * connection lane on a Laminas/Doctrine flavoured micro-repo. Exercises the full
 * static chain that a single-file unit test cannot reproduce:
 *
 *   coderadius.yaml envAccessors  →  EnvVault::fetch('KEY','default') call sites
 *     →  accessor-value hook ${KEY:-default}  →  registry resolution against the
 *        repo env map  →  datastore hints + broker-connection hints
 *   laminas structural plugins  →  MessageChannel{connectionRef,_repoUrn,_sourcePath}
 *
 * The cross-cutting contract pinned here is the channel↔connection BINDING JOIN:
 * every emitted channel's (connectionRef, _sourcePath) pair must line up with a
 * broker-connection hint (connectionName, sourceFile) from the SAME file, with
 * per-vhost correctness (notify_out → the 'acme/notifications' vhost hint).
 *
 * Fixture (anonymised acme e-commerce vocabulary):
 *   - composer.json                          laminas + doctrine-orm-module manifest
 *   - coderadius.yaml                        envAccessors + declared broker-client
 *   - config/autoload/database.global.php    3 doctrine connections (orders/reporting/archive)
 *   - config/autoload/rabbitmq.global.php    oldsound: 3 connections (3 vhosts) + producers/consumer
 *   - config/autoload/messenger.global.php   laminas messenger bridge: async (literal DSN) + sync
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
    extractAllPhysicalHints,
    extractAllBrokerConnectionHints,
} from '../../../../src/ingestion/processors/connection-extractors/registry.js';
import {
    buildRepoEnvMap,
    type RepoEnvMap,
} from '../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';
import {
    scanCodeAccessorEnvVars,
    clearAccessorScanCache,
} from '../../../../src/ingestion/processors/connection-extractors/env-accessor-scanner.js';
import {
    getEnvAccessors,
    loadRepoHints,
    clearRepoHintsCache,
} from '../../../../src/config/repo-hints.js';
import { laminasRabbitmqPlugin } from '../../../../src/ingestion/structural/plugins/messaging/laminas-rabbitmq.plugin.js';
import { laminasMessengerPhpPlugin } from '../../../../src/ingestion/structural/plugins/messaging/laminas-messenger-php.plugin.js';
import type { PluginContext, StructuralEntity } from '../../../../src/ingestion/structural/types.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';
import fs from 'node:fs';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');
const REPO_URN = 'cr:repository:acme/platform-app';

/** Mirror the env-map the registry builds for broker-hint resolution. */
function buildResolverEnvMap(): RepoEnvMap {
    const accessors = getEnvAccessors(loadRepoHints(FIXTURE_DIR));
    const accessorDefaults = scanCodeAccessorEnvVars(FIXTURE_DIR, accessors).defaults;
    return buildRepoEnvMap(FIXTURE_DIR, { accessorDefaults });
}

function makeContext(relativePath: string): PluginContext {
    const absolutePath = path.join(FIXTURE_DIR, relativePath);
    return {
        relativePath,
        absolutePath,
        repoName: 'acme/platform-app',
        repoUrn: REPO_URN,
        scopeManager: new ScopeManager(path.dirname(absolutePath)),
    };
}

function extractChannels(
    plugin: typeof laminasRabbitmqPlugin,
    relativePath: string,
): StructuralEntity[] {
    const content = fs.readFileSync(path.join(FIXTURE_DIR, relativePath), 'utf-8');
    return plugin.extract(content, makeContext(relativePath)).entities;
}

describe('Pattern Eval — php-laminas-config-connections', () => {
    beforeAll(() => {
        clearRepoHintsCache(FIXTURE_DIR);
        clearAccessorScanCache(FIXTURE_DIR);
    });

    afterAll(() => {
        clearRepoHintsCache(FIXTURE_DIR);
        clearAccessorScanCache(FIXTURE_DIR);
    });

    // ── 1. Datastore hints ───────────────────────────────────────────────────
    it('recovers exactly 3 mysql doctrine connections with distinct dbName identities', () => {
        const { hints } = extractAllPhysicalHints(FIXTURE_DIR);
        const mysql = hints.filter(h => h.technology === 'mysql');

        expect(mysql).toHaveLength(3);
        expect(mysql.map(h => h.dbName).sort()).toEqual(['archive', 'orders_main', 'reporting']);
        // Each doctrine connection keeps its own alias — three distinct identities.
        expect(new Set(mysql.map(h => h.connectionAlias)).size).toBe(3);
        expect(mysql.map(h => h.connectionAlias).sort())
            .toEqual(['orm_archive', 'orm_default', 'orm_reporting']);

        for (const h of mysql) {
            // Host accessor default 'mysql' (a compose-service name) is KEPT by the
            // registry's isUnbindableHost filter and resolved via shell `:-`.
            expect(h.host).toBe('mysql');
            expect(h.sourceFile).toBe('config/autoload/database.global.php');
        }

        // orm_default carried port + user accessors; its port template resolves to 3306.
        const dflt = mysql.find(h => h.connectionAlias === 'orm_default')!;
        expect(dflt.port).toBe(3306);
    });

    // ── 2. Broker-connection hints ───────────────────────────────────────────
    it('resolves 4 rabbitmq broker connections (3 oldsound vhosts + 1 messenger transport)', () => {
        const envMap = buildResolverEnvMap();
        const hints = extractAllBrokerConnectionHints(FIXTURE_DIR, envMap);

        expect(hints).toHaveLength(4);
        for (const h of hints) {
            expect(h.provider).toBe('rabbitmq');
            expect(h.sourceType).toBe('config');
            // Broker hints never carry a sourceEnvKey property (config lane, not s1).
            expect('sourceEnvKey' in h).toBe(false);
        }

        // 3 oldsound connections, one per declared vhost.
        const oldsound = hints.filter(h => h.sourceFile === 'config/autoload/rabbitmq.global.php');
        expect(oldsound.map(h => h.connectionName).sort()).toEqual(['default', 'notifications', 'payments']);
        expect(oldsound.map(h => h.vhost).sort()).toEqual(['/', 'acme', 'acme/notifications']);

        const dflt = oldsound.find(h => h.connectionName === 'default')!;
        expect(dflt.vhost).toBe('acme');
        expect(dflt.host).toBe('rabbitmq');     // accessor default for BUS_HOST
        expect(dflt.port).toBe(5672);           // BUS_PORT default

        const payments = oldsound.find(h => h.connectionName === 'payments')!;
        expect(payments.port).toBe(5672);         // no port declared → provider default

        // 1 messenger transport with a literal DSN.
        const messenger = hints.filter(h => h.sourceFile === 'config/autoload/messenger.global.php');
        expect(messenger).toHaveLength(1);
        expect(messenger[0]).toMatchObject({
            connectionName: 'async',
            host: 'bus.acme.internal',
            vhost: 'acme/events',
            port: 5672,
        });
    });

    // ── 3. Channels carry connectionRef / provenance ─────────────────────────
    it('oldsound channels carry connectionRef + _repoUrn + _sourcePath', () => {
        const rel = 'config/autoload/rabbitmq.global.php';
        const channels = extractChannels(laminasRabbitmqPlugin, rel);

        // 2 producers (order_events: exchange+queue, notify_out: exchange) +
        // 1 consumer (shipment_import: exchange+queue) → 5 channels.
        expect(channels).toHaveLength(5);
        for (const ch of channels) {
            expect(ch.properties._repoUrn).toBe(REPO_URN);
            expect(ch.properties._sourcePath).toBe(rel);
            expect(typeof ch.properties.connectionRef).toBe('string');
        }

        const byName = (name: string) => channels.find(c => c.properties.name === name)!;
        expect(byName('acme.order-events').properties.connectionRef).toBe('default');
        expect(byName('acme.notifications').properties.connectionRef).toBe('notifications');
        expect(byName('acme.shipment-import').properties.connectionRef).toBe('default');
    });

    it('messenger channels carry connectionRef = transport name + provenance', () => {
        const rel = 'config/autoload/messenger.global.php';
        const channels = extractChannels(laminasMessengerPhpPlugin, rel);

        // async transport: 1 exchange (acme.events) + 1 queue (acme.events). sync skipped.
        expect(channels).toHaveLength(2);
        for (const ch of channels) {
            expect(ch.properties.connectionRef).toBe('async');
            expect(ch.properties._repoUrn).toBe(REPO_URN);
            expect(ch.properties._sourcePath).toBe(rel);
        }
    });

    // ── 4. Channel↔connection JOIN keys line up (the binding contract) ────────
    it('every channel binds to a broker hint by (connectionRef===connectionName, _sourcePath===sourceFile)', () => {
        const envMap = buildResolverEnvMap();
        const brokerHints = extractAllBrokerConnectionHints(FIXTURE_DIR, envMap);
        const channels = [
            ...extractChannels(laminasRabbitmqPlugin, 'config/autoload/rabbitmq.global.php'),
            ...extractChannels(laminasMessengerPhpPlugin, 'config/autoload/messenger.global.php'),
        ];

        for (const ch of channels) {
            const match = brokerHints.find(h =>
                h.connectionName === ch.properties.connectionRef
                && h.sourceFile === ch.properties._sourcePath);
            expect(match, `channel ${ch.properties.name} must bind to a broker hint`).toBeDefined();
        }

        // Per-vhost correctness pin: notify_out's exchange joins the hint whose
        // vhost is 'acme/notifications' (NOT 'acme').
        const notifyExchange = channels.find(c => c.properties.name === 'acme.notifications')!;
        const notifyHint = brokerHints.find(h =>
            h.connectionName === notifyExchange.properties.connectionRef
            && h.sourceFile === notifyExchange.properties._sourcePath)!;
        expect(notifyHint.vhost).toBe('acme/notifications');
    });

    // ── 5. No cross-claim: datastore keys claimed, broker keys NOT ────────────
    it('claims the datastore accessor keys but never the broker accessor keys', () => {
        const { claimedEnvKeys } = extractAllPhysicalHints(FIXTURE_DIR);

        // Datastore subtree keys are claimed (so the broker lane never re-reads them).
        expect(claimedEnvKeys.has('ORDERS_DB_HOST')).toBe(true);
        expect(claimedEnvKeys.has('ORDERS_DB_NAME')).toBe(true);
        expect(claimedEnvKeys.has('REPORTING_DB_HOST')).toBe(true);
        expect(claimedEnvKeys.has('ARCHIVE_DB_HOST')).toBe(true);

        // Broker accessor keys must remain UNCLAIMED — they belong to the broker lane.
        expect(claimedEnvKeys.has('BUS_HOST')).toBe(false);
        expect(claimedEnvKeys.has('BUS_PORT')).toBe(false);
        expect(claimedEnvKeys.has('PAYMENTS_BUS_HOST')).toBe(false);
    });
});
