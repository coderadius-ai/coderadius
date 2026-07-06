import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phpConfigArrayExtractor } from '../../../../../src/ingestion/processors/connection-extractors/plugins/php-config-array.js';
import { extractAllBrokerConnectionHints } from '../../../../../src/ingestion/processors/connection-extractors/registry.js';
import type { RepoEnvMap } from '../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';
import { clearRepoHintsCache } from '../../../../../src/config/repo-hints.js';

// ═════════════════════════════════════════════════════════════════════════════
// extractBrokers (B2) — broker CONNECTIONS from published config shapes.
//
// Vhost policy (explicit):
//   literal → verbatim ('' normalized to '/')
//   accessor-wrapped → ${K:-d} template, resolved by the registry (B3),
//                      the WHOLE hint drops when unresolved
//   absent → contractual AMQP default '/'
// ═════════════════════════════════════════════════════════════════════════════

const CODERADIUS_YAML = `
envAccessors:
  - callee: 'Acme\\Platform\\EnvVault::fetch'
    keyArg: 0
    defaultArg: 1
`;

const RABBITMQ_CONFIG = `<?php
use Acme\\Platform\\EnvVault;

return [
    'rabbitmq' => [
        'connection' => [
            'default' => [
                'host'  => EnvVault::fetch('BUS_HOST', 'rabbitmq'),
                'port'  => EnvVault::fetch('BUS_PORT', 5672),
                'vhost' => 'acme',
            ],
            'notifications' => [
                'host'  => EnvVault::fetch('BUS_HOST', 'rabbitmq'),
                'vhost' => 'acme/notifications',
            ],
            'payments' => [
                'host'  => EnvVault::fetch('PAYMENTS_BUS_HOST', 'rabbitmq'),
                'vhost' => '/',
            ],
        ],
        'producer' => [
            'order_events' => [
                'connection' => 'default',
                'exchange' => ['name' => 'acme.order-events', 'type' => 'fanout'],
            ],
        ],
    ],
];
`;

const VHOST_EDGE_CASES_CONFIG = `<?php
use Acme\\Platform\\EnvVault;

return [
    'rabbitmq' => [
        'connection' => [
            'no_vhost'       => ['host' => 'bus.acme.internal'],
            'empty_vhost'    => ['host' => 'bus.acme.internal', 'vhost' => ''],
            'template_vhost' => ['host' => 'bus.acme.internal', 'vhost' => EnvVault::fetch('BUS_VHOST', '/')],
            'broken_vhost'   => ['host' => 'bus.acme.internal', 'vhost' => SomeFactory::vhost()],
        ],
    ],
];
`;

const MESSENGER_CONFIG = `<?php
return [
    'symfony' => [
        'messenger' => [
            'transports' => [
                'async' => [
                    'dsn' => 'amqp://bus.acme.internal:5672/acme%2Fevents',
                    'options' => ['exchange' => ['name' => 'acme.events']],
                ],
                'bare' => ['dsn' => 'amqp://'],
                'sync' => 'sync://',
            ],
        ],
    ],
];
`;

const DOCTRINE_ONLY_CONFIG = `<?php
return [
    'doctrine' => [
        'connection' => [
            'orm_default' => ['params' => ['host' => 'db', 'dbname' => 'orders']],
        ],
    ],
];
`;

let repoDir: string;

function writeConfig(rel: string, content: string): string {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}

function envMapOf(entries: Record<string, string>): RepoEnvMap {
    return {
        vars: new Map(Object.entries(entries).map(([k, v]) => [
            k, { value: v, sourceFile: '.env', confidence: 'high' as const },
        ])),
    };
}

beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-php-broker-conn-'));
    fs.writeFileSync(path.join(repoDir, 'coderadius.yaml'), CODERADIUS_YAML);
});

afterEach(() => {
    clearRepoHintsCache(repoDir);
    fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('phpConfigArrayExtractor.extractBrokers — oldsound/laminas shape', () => {
    it('emits one hint per connection with connectionName and NO sourceEnvKey', () => {
        const abs = writeConfig('config/autoload/rabbitmq.global.php', RABBITMQ_CONFIG);
        const hints = phpConfigArrayExtractor.extractBrokers!(abs, RABBITMQ_CONFIG, { repoPath: repoDir });

        expect(hints.map(h => h.connectionName).sort()).toEqual(['default', 'notifications', 'payments']);
        for (const h of hints) {
            expect(h.provider).toBe('rabbitmq');
            expect(h.providerSource).toBe('declared');
            expect(h.sourceType).toBe('config');
            expect(h.sourceFile).toBe('config/autoload/rabbitmq.global.php');
            expect('sourceEnvKey' in h).toBe(false);
        }
    });

    it('vhost literal stays verbatim even when host is accessor-wrapped (literal beats default)', () => {
        const abs = writeConfig('config/autoload/rabbitmq.global.php', RABBITMQ_CONFIG);
        const hints = phpConfigArrayExtractor.extractBrokers!(abs, RABBITMQ_CONFIG, { repoPath: repoDir });

        const notif = hints.find(h => h.connectionName === 'notifications')!;
        expect(notif.vhost).toBe('acme/notifications');
        expect(notif.host).toBe('${BUS_HOST:-rabbitmq}');

        const dflt = hints.find(h => h.connectionName === 'default')!;
        expect(dflt.vhost).toBe('acme');
        expect(dflt.portTemplate).toBe('${BUS_PORT:-5672}');
    });

    it('vhost policy: absent → "/", empty → "/", template kept, unresolvable expression → hint dropped', () => {
        const abs = writeConfig('config/autoload/rabbitmq.global.php', VHOST_EDGE_CASES_CONFIG);
        const hints = phpConfigArrayExtractor.extractBrokers!(abs, VHOST_EDGE_CASES_CONFIG, { repoPath: repoDir });

        expect(hints.map(h => h.connectionName).sort()).toEqual(['empty_vhost', 'no_vhost', 'template_vhost']);
        expect(hints.find(h => h.connectionName === 'no_vhost')!.vhost).toBe('/');
        expect(hints.find(h => h.connectionName === 'empty_vhost')!.vhost).toBe('/');
        expect(hints.find(h => h.connectionName === 'template_vhost')!.vhost).toBe('${BUS_VHOST:-/}');
    });
});

describe('phpConfigArrayExtractor.extractBrokers — messenger transports (literal DSN)', () => {
    it('parses literal amqp DSN into host/port/vhost with the transport as connectionName', () => {
        const abs = writeConfig('config/autoload/messenger.global.php', MESSENGER_CONFIG);
        const hints = phpConfigArrayExtractor.extractBrokers!(abs, MESSENGER_CONFIG, { repoPath: repoDir });

        expect(hints).toHaveLength(1);
        expect(hints[0]).toMatchObject({
            provider: 'rabbitmq',
            host: 'bus.acme.internal',
            port: 5672,
            vhost: 'acme/events',
            connectionName: 'async',
            sourceType: 'config',
            confidence: 'high',
        });
    });

    it('drops bare amqp:// (no host) and string transports', () => {
        const abs = writeConfig('config/autoload/messenger.global.php', MESSENGER_CONFIG);
        const hints = phpConfigArrayExtractor.extractBrokers!(abs, MESSENGER_CONFIG, { repoPath: repoDir });
        expect(hints.some(h => h.connectionName === 'bare')).toBe(false);
        expect(hints.some(h => h.connectionName === 'sync')).toBe(false);
    });
});

describe('phpConfigArrayExtractor.extractBrokers — non-broker config', () => {
    it('returns nothing for a doctrine-only config', () => {
        const abs = writeConfig('config/autoload/database.global.php', DOCTRINE_ONLY_CONFIG);
        expect(phpConfigArrayExtractor.extractBrokers!(abs, DOCTRINE_ONLY_CONFIG, { repoPath: repoDir })).toEqual([]);
    });
});

describe('extractAllBrokerConnectionHints (B3) — registry resolution', () => {
    it('resolves host templates against the env map and applies the provider default port', () => {
        writeConfig('config/autoload/rabbitmq.global.php', RABBITMQ_CONFIG);
        const hints = extractAllBrokerConnectionHints(repoDir, envMapOf({ BUS_HOST: 'bus.acme-prod.internal' }));

        const notif = hints.find(h => h.connectionName === 'notifications')!;
        expect(notif.host).toBe('bus.acme-prod.internal');
        expect(notif.vhost).toBe('acme/notifications');
        expect(notif.port).toBe(5672);
        // template-resolved host → medium confidence (mint demotes via applyFallback)
        expect(notif.confidence).toBe('medium');
    });

    it('falls back to the accessor default when the env map has no entry (shell :- semantics)', () => {
        writeConfig('config/autoload/rabbitmq.global.php', RABBITMQ_CONFIG);
        const hints = extractAllBrokerConnectionHints(repoDir, envMapOf({}));
        const dflt = hints.find(h => h.connectionName === 'default')!;
        expect(dflt.host).toBe('rabbitmq');
        expect(dflt.port).toBe(5672);
    });

    it('drops the hint when host stays unresolved (accessor without default, no env entry)', () => {
        const NO_DEFAULT = `<?php
use Acme\\Platform\\EnvVault;

return [
    'rabbitmq' => [
        'connection' => [
            'default' => ['host' => EnvVault::fetch('UNSET_BUS_HOST'), 'vhost' => '/'],
        ],
    ],
];
`;
        writeConfig('config/autoload/rabbitmq.global.php', NO_DEFAULT);
        const hints = extractAllBrokerConnectionHints(repoDir, envMapOf({}));
        expect(hints).toEqual([]);
    });

    it('keeps literal-only configs at high confidence', () => {
        writeConfig('config/autoload/messenger.global.php', MESSENGER_CONFIG);
        const hints = extractAllBrokerConnectionHints(repoDir, envMapOf({}));
        expect(hints).toHaveLength(1);
        expect(hints[0].confidence).toBe('high');
    });
});
