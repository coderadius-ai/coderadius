import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import { isComposerPlatformPackage } from '../../../../src/ingestion/core/languages/php/dependencies.js';

const plugin = new PHPPlugin();
const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-plugin-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('isComposerPlatformPackage', () => {
    it.each([
        'php',
        'php-64bit',
        'hhvm',
        'ext-json',
        'ext-pdo_mysql',
        'lib-icu',
        'composer',
        'composer-plugin-api',
        'composer-runtime-api',
    ])('recognizes platform package %s', name => {
        expect(isComposerPlatformPackage(name)).toBe(true);
    });

    it.each([
        'acme/inventory-client',
        'guzzlehttp/guzzle',
        'phpunit/phpunit',
        'extra-tools/parser',
        'library/orders',
    ])('rejects registry package %s', name => {
        expect(isComposerPlatformPackage(name)).toBe(false);
    });
});

describe('PHPPlugin.parseManifestDependencies', () => {
    it('parses composer.json and excludes platform packages', () => {
        const manifest = JSON.stringify({
            require: { php: '~8.2', 'ext-json': '*', 'acme/inventory-client': '^2.0' },
            'require-dev': { 'phpunit/phpunit': '^9.0' },
        });
        expect(plugin.parseManifestDependencies('composer.json', manifest)).toEqual([
            { ecosystem: 'composer', name: 'acme/inventory-client', requiredVersion: '^2.0', isDev: false },
            { ecosystem: 'composer', name: 'phpunit/phpunit', requiredVersion: '^9.0', isDev: true },
        ]);
    });

    it('returns null for files it does not own', () => {
        expect(plugin.parseManifestDependencies('package.json', '{}')).toBeNull();
    });

    it('returns [] for malformed composer.json', () => {
        expect(plugin.parseManifestDependencies('composer.json', '{ invalid')).toEqual([]);
    });
});

describe('PHPPlugin dependency helpers', () => {
    it('loads PSR-4 mappings sorted by longest prefix and returns [] for invalid composer.json', () => {
        const validRepo = makeTempDir();
        fs.writeFileSync(path.join(validRepo, 'composer.json'), JSON.stringify({
            autoload: {
                'psr-4': {
                    'App\\': 'src/',
                    'App\\Domain\\': 'src/Domain/',
                },
            },
        }));

        expect(plugin.loadDependencyMappings(validRepo)).toEqual([
            { prefix: 'App\\Domain\\', directory: 'src/Domain/' },
            { prefix: 'App\\', directory: 'src/' },
        ]);

        const invalidRepo = makeTempDir();
        fs.writeFileSync(path.join(invalidRepo, 'composer.json'), '{ invalid json');
        expect(plugin.loadDependencyMappings(invalidRepo)).toEqual([]);

        const noAutoloadRepo = makeTempDir();
        fs.writeFileSync(path.join(noAutoloadRepo, 'composer.json'), JSON.stringify({ name: 'acme/no-autoload' }));
        expect(plugin.loadDependencyMappings(noAutoloadRepo)).toEqual([]);

        const emptyRepo = makeTempDir();
        expect(plugin.loadDependencyMappings(emptyRepo)).toEqual([]);
    });

    it('extracts composer dependencies with locked versions and skips platform requirements', async () => {
        const repo = makeTempDir();
        fs.writeFileSync(path.join(repo, 'composer.json'), JSON.stringify({
            require: {
                php: '^8.2',
                'ext-json': '*',
                'guzzlehttp/guzzle': '^7.8',
                'symfony/http-client': '^6.4',
            },
            'require-dev': {
                'phpunit/phpunit': '^10.5',
            },
        }, null, 2));
        fs.writeFileSync(path.join(repo, 'composer.lock'), JSON.stringify({
            packages: [
                { name: 'guzzlehttp/guzzle', version: '7.8.1' },
                { name: 'symfony/http-client', version: '6.4.5' },
            ],
            'packages-dev': [
                { name: 'phpunit/phpunit', version: '10.5.20' },
            ],
        }, null, 2));

        const deps = await plugin.extractDependencies(repo);
        expect(deps).toEqual([
            {
                name: 'guzzlehttp/guzzle',
                ecosystem: 'composer',
                declaredRange: '^7.8',
                lockedVersion: '7.8.1',
                isDev: false,
            },
            {
                name: 'symfony/http-client',
                ecosystem: 'composer',
                declaredRange: '^6.4',
                lockedVersion: '6.4.5',
                isDev: false,
            },
            {
                name: 'phpunit/phpunit',
                ecosystem: 'composer',
                declaredRange: '^10.5',
                lockedVersion: '10.5.20',
                isDev: true,
            },
        ]);
    });

    it('tolerates malformed composer.json and composer.lock while still returning good dependencies', async () => {
        const repo = makeTempDir();

        const goodDir = path.join(repo, 'packages', 'good');
        fs.mkdirSync(goodDir, { recursive: true });
        fs.writeFileSync(path.join(goodDir, 'composer.json'), JSON.stringify({
            require: {
                'monolog/monolog': '^3.0',
            },
        }));
        fs.writeFileSync(path.join(goodDir, 'composer.lock'), '{ not-json');

        const badDir = path.join(repo, 'packages', 'bad');
        fs.mkdirSync(badDir, { recursive: true });
        fs.writeFileSync(path.join(badDir, 'composer.json'), '{ broken-json');

        const deps = await plugin.extractDependencies(repo);
        expect(deps).toEqual([
            {
                name: 'monolog/monolog',
                ecosystem: 'composer',
                declaredRange: '^3.0',
                lockedVersion: null,
                isDev: false,
            },
        ]);
    });

    it('handles repos with only require-dev entries and missing lock versions', async () => {
        const repo = makeTempDir();
        fs.writeFileSync(path.join(repo, 'composer.json'), JSON.stringify({
            'require-dev': {
                php: '^8.2',
                'ext-curl': '*',
                'friendsofphp/php-cs-fixer': '^3.0',
            },
        }));

        const deps = await plugin.extractDependencies(repo);
        expect(deps).toEqual([
            {
                name: 'friendsofphp/php-cs-fixer',
                ecosystem: 'composer',
                declaredRange: '^3.0',
                lockedVersion: null,
                isDev: true,
            },
        ]);
    });
});
