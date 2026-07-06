import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phpConfigArrayExtractor } from '../../../../../src/ingestion/processors/connection-extractors/plugins/php-config-array.js';
import { clearRepoHintsCache } from '../../../../../src/config/repo-hints.js';

// ═════════════════════════════════════════════════════════════════════════════
// php-config-array datastore extractor (A2) — PHP `return [...]` config arrays.
//
// Shapes v1 (published module contracts):
//   (a) doctrine-orm-module:  ['doctrine']['connection'][name]['params']{...}
//       with `driverClass` (FQCN ::class) sibling of `params` or inside it
//   (b) Symfony dbal as PHP:  ['doctrine']['dbal']['connections'][name]{...}
//
// Accessor-wrapped values (coderadius.yaml `envAccessors`) become shell
// templates `${KEY:-default}` resolved downstream by `applyResolution`.
// ═════════════════════════════════════════════════════════════════════════════

const CODERADIUS_YAML = `
envAccessors:
  - callee: 'Acme\\Platform\\EnvVault::fetch'
    keyArg: 0
    defaultArg: 1
`;

const ORM_MODULE_CONFIG = `<?php
use Acme\\Platform\\EnvVault;
use Doctrine\\DBAL\\Driver\\PDOMySql\\Driver as MySqlDriver;

return [
    'doctrine' => [
        'connection' => [
            'orm_default' => [
                'driverClass' => MySqlDriver::class,
                'params' => [
                    'host'   => EnvVault::fetch('ORDERS_DB_HOST', 'mysql'),
                    'port'   => EnvVault::fetch('ORDERS_DB_PORT', 3306),
                    'user'   => EnvVault::fetch('ORDERS_DB_USER', 'orders'),
                    'dbname' => EnvVault::fetch('ORDERS_DB_NAME', 'orders_main'),
                ],
            ],
            'orm_reporting' => [
                'driverClass' => \\Doctrine\\DBAL\\Driver\\PDOMySql\\Driver::class,
                'params' => [
                    'host'   => EnvVault::fetch('REPORTING_DB_HOST', 'mysql'),
                    'dbname' => EnvVault::fetch('REPORTING_DB_NAME', 'reporting'),
                ],
            ],
            'orm_archive' => [
                'params' => [
                    'driver' => 'pdo_mysql',
                    'host'   => EnvVault::fetch('ARCHIVE_DB_HOST', 'mysql'),
                    'dbname' => 'archive',
                ],
            ],
        ],
    ],
];
`;

const DBAL_PHP_CONFIG = `<?php
return [
    'doctrine' => [
        'dbal' => [
            'connections' => [
                'default' => [
                    'driver' => 'pdo_pgsql',
                    'host'   => 'pg.acme-internal.example',
                    'port'   => 5432,
                    'dbname' => 'inventory',
                ],
            ],
        ],
    ],
];
`;

const NO_DRIVER_CONFIG = `<?php
return [
    'doctrine' => [
        'connection' => [
            'orm_default' => [
                'params' => [
                    'host'   => 'db.acme-internal.example',
                    'dbname' => 'shipments',
                ],
            ],
        ],
    ],
];
`;

const UNKNOWN_DRIVER_CONFIG = `<?php
return [
    'doctrine' => [
        'connection' => [
            'orm_default' => [
                'driverClass' => \\Acme\\Persistence\\CustomTsdbDriver::class,
                'params' => [
                    'host'   => 'tsdb.acme-internal.example',
                    'dbname' => 'metrics',
                ],
            ],
        ],
    ],
];
`;

const RABBITMQ_ONLY_CONFIG = `<?php
use Acme\\Platform\\EnvVault;

return [
    'rabbitmq' => [
        'connection' => [
            'default' => [
                'host'  => EnvVault::fetch('BUS_HOST', 'rabbitmq'),
                'vhost' => 'acme/notifications',
            ],
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

beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-php-config-array-'));
    fs.writeFileSync(path.join(repoDir, 'coderadius.yaml'), CODERADIUS_YAML);
});

afterEach(() => {
    clearRepoHintsCache(repoDir);
    fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('phpConfigArrayExtractor.candidateFile', () => {
    it('accepts php files under a config/ segment, rejects source files', () => {
        expect(phpConfigArrayExtractor.candidateFile('config/autoload/database.global.php', 'database.global.php')).toBe(true);
        expect(phpConfigArrayExtractor.candidateFile('app/config/db.php', 'db.php')).toBe(true);
        expect(phpConfigArrayExtractor.candidateFile('src/Service/Database.php', 'database.php')).toBe(false);
        expect(phpConfigArrayExtractor.candidateFile('config/routes.yaml', 'routes.yaml')).toBe(false);
    });
});

describe('phpConfigArrayExtractor.extract — doctrine-orm-module shape', () => {
    it('emits one mysql hint per connection with distinct aliases and shell templates', () => {
        const abs = writeConfig('config/autoload/database.global.php', ORM_MODULE_CONFIG);
        const hints = phpConfigArrayExtractor.extract(abs, ORM_MODULE_CONFIG, { repoPath: repoDir });

        expect(hints).toHaveLength(3);
        expect(hints.map(h => h.connectionAlias).sort()).toEqual(['orm_archive', 'orm_default', 'orm_reporting']);
        for (const h of hints) {
            expect(h.technology).toBe('mysql');
            expect(h.templateSyntax).toBe('shell');
            expect(h.sourceFile).toBe('config/autoload/database.global.php');
        }

        const dflt = hints.find(h => h.connectionAlias === 'orm_default')!;
        expect(dflt.host).toBe('${ORDERS_DB_HOST:-mysql}');
        expect(dflt.dbName).toBe('${ORDERS_DB_NAME:-orders_main}');
        expect(dflt.portTemplate).toBe('${ORDERS_DB_PORT:-3306}');
    });

    it('resolves driverClass through use-statement aliases AND fully-qualified ::class', () => {
        const abs = writeConfig('config/autoload/database.global.php', ORM_MODULE_CONFIG);
        const hints = phpConfigArrayExtractor.extract(abs, ORM_MODULE_CONFIG, { repoPath: repoDir });
        // orm_default uses the alias form, orm_reporting the FQ form, orm_archive the pdo token.
        expect(hints.every(h => h.technology === 'mysql')).toBe(true);
    });

    it('skips a connection whose driverClass is present but unknown (no guess over an explicit driver)', () => {
        const abs = writeConfig('config/autoload/database.global.php', UNKNOWN_DRIVER_CONFIG);
        const hints = phpConfigArrayExtractor.extract(abs, UNKNOWN_DRIVER_CONFIG, { repoPath: repoDir });
        expect(hints).toHaveLength(0);
    });

    it('defaults to mysql ONLY when host+dbname present and no driver at all (declared heuristic)', () => {
        const abs = writeConfig('config/autoload/database.global.php', NO_DRIVER_CONFIG);
        const hints = phpConfigArrayExtractor.extract(abs, NO_DRIVER_CONFIG, { repoPath: repoDir });
        expect(hints).toHaveLength(1);
        expect(hints[0].technology).toBe('mysql');
        expect(hints[0].confidence).toBe('medium');
    });
});

describe('phpConfigArrayExtractor.extract — Symfony dbal as PHP array', () => {
    it('emits a postgres hint from literal values', () => {
        const abs = writeConfig('config/packages/doctrine.php', DBAL_PHP_CONFIG);
        const hints = phpConfigArrayExtractor.extract(abs, DBAL_PHP_CONFIG, { repoPath: repoDir });
        expect(hints).toHaveLength(1);
        expect(hints[0]).toMatchObject({
            technology: 'postgres',
            host: 'pg.acme-internal.example',
            port: 5432,
            dbName: 'inventory',
            connectionAlias: 'default',
            templateSyntax: 'none',
            confidence: 'high',
        });
    });
});

describe('phpConfigArrayExtractor — non-doctrine config', () => {
    it('returns nothing for a rabbitmq-only config (datastore lane untouched)', () => {
        const abs = writeConfig('config/autoload/rabbitmq.global.php', RABBITMQ_ONLY_CONFIG);
        const hints = phpConfigArrayExtractor.extract(abs, RABBITMQ_ONLY_CONFIG, { repoPath: repoDir });
        expect(hints).toHaveLength(0);
    });
});

describe('phpConfigArrayExtractor.claimEnvKeys', () => {
    it('claims ONLY the accessor keys referenced by datastore connections', () => {
        const abs = writeConfig('config/autoload/database.global.php', ORM_MODULE_CONFIG);
        const claimed = phpConfigArrayExtractor.claimEnvKeys!(abs, ORM_MODULE_CONFIG, { repoPath: repoDir }).sort();
        expect(claimed).toEqual([
            'ARCHIVE_DB_HOST',
            'ORDERS_DB_HOST', 'ORDERS_DB_NAME', 'ORDERS_DB_PORT', 'ORDERS_DB_USER',
            'REPORTING_DB_HOST', 'REPORTING_DB_NAME',
        ]);
    });

    it('does NOT claim broker accessor keys (rabbitmq section is not a datastore)', () => {
        const abs = writeConfig('config/autoload/rabbitmq.global.php', RABBITMQ_ONLY_CONFIG);
        const claimed = phpConfigArrayExtractor.claimEnvKeys!(abs, RABBITMQ_ONLY_CONFIG, { repoPath: repoDir });
        expect(claimed).toEqual([]);
    });
});
