import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    loadPhpDependencyMappings,
    loadPhpLocalPathDependencies,
} from '../../../../../src/ingestion/core/languages/php/dependencies.js';

describe('loadPhpDependencyMappings', () => {
    let repoRoot: string;

    beforeEach(() => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-php-deps-test-'));
    });
    afterEach(() => {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    function writeComposer(autoload: Record<string, unknown>): void {
        fs.writeFileSync(
            path.join(repoRoot, 'composer.json'),
            JSON.stringify({ autoload }),
        );
    }

    it('maps string-valued PSR-4 entries', () => {
        writeComposer({ 'psr-4': { 'Acme\\': 'src/' } });

        expect(loadPhpDependencyMappings(repoRoot)).toEqual([
            { prefix: 'Acme\\', directory: 'src/' },
        ]);
    });

    it('expands array-valued PSR-4 entries into one mapping per directory, preserving order', () => {
        // Composer allows a prefix to map to MULTIPLE roots, checked in order:
        //   "Acme\\": ["lib/Acme/", "src/Acme/"]
        // Casting the value to string crashed path.posix.join downstream
        // ("paths[0] must be of type string, got array").
        writeComposer({
            'psr-4': {
                'Acme\\': ['lib/Acme/', 'src/Acme/'],
                'Acme\\Orders\\': 'orders/src/',
            },
        });

        expect(loadPhpDependencyMappings(repoRoot)).toEqual([
            { prefix: 'Acme\\Orders\\', directory: 'orders/src/' },
            { prefix: 'Acme\\', directory: 'lib/Acme/' },
            { prefix: 'Acme\\', directory: 'src/Acme/' },
        ]);
    });

    it('drops non-string entries inside array values', () => {
        writeComposer({ 'psr-4': { 'Acme\\': ['src/', 42, null] } });

        expect(loadPhpDependencyMappings(repoRoot)).toEqual([
            { prefix: 'Acme\\', directory: 'src/' },
        ]);
    });

    it('sorts longest prefix first across mixed entries', () => {
        writeComposer({
            'psr-4': {
                'Acme\\': 'src/',
                'Acme\\Inventory\\': ['inventory/lib/', 'inventory/src/'],
            },
        });

        const prefixes = loadPhpDependencyMappings(repoRoot).map(m => m.prefix);
        expect(prefixes).toEqual(['Acme\\Inventory\\', 'Acme\\Inventory\\', 'Acme\\']);
    });

    it('returns [] when composer.json is missing or malformed', () => {
        expect(loadPhpDependencyMappings(repoRoot)).toEqual([]);

        fs.writeFileSync(path.join(repoRoot, 'composer.json'), '{not json');
        expect(loadPhpDependencyMappings(repoRoot)).toEqual([]);
    });
});

describe('loadPhpLocalPathDependencies', () => {
    let manifestDir: string;

    beforeEach(() => {
        manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-php-pathdeps-test-'));
    });
    afterEach(() => {
        fs.rmSync(manifestDir, { recursive: true, force: true });
    });

    function writeComposer(content: Record<string, unknown>): void {
        fs.writeFileSync(
            path.join(manifestDir, 'composer.json'),
            JSON.stringify(content),
        );
    }

    it('returns normalized urls of type=path repositories (array form)', () => {
        writeComposer({
            repositories: [
                { type: 'path', url: './contexts/orders' },
                { type: 'path', url: 'contexts/shipping/' },
                { type: 'vcs', url: 'https://example.com/acme/lib.git' },
                { type: 'composer', url: 'https://repo.example.com' },
            ],
        });

        expect(loadPhpLocalPathDependencies(manifestDir)).toEqual([
            'contexts/orders',
            'contexts/shipping',
        ]);
    });

    it('handles the object form of repositories', () => {
        writeComposer({
            repositories: {
                orders: { type: 'path', url: 'contexts/orders' },
                upstream: { type: 'vcs', url: 'https://example.com/acme.git' },
            },
        });

        expect(loadPhpLocalPathDependencies(manifestDir)).toEqual(['contexts/orders']);
    });

    it('keeps glob patterns verbatim', () => {
        writeComposer({
            repositories: [{ type: 'path', url: 'contexts/*' }],
        });

        expect(loadPhpLocalPathDependencies(manifestDir)).toEqual(['contexts/*']);
    });

    it('returns [] without repositories, on malformed json, or missing file', () => {
        writeComposer({ require: { 'acme/orders': '*' } });
        expect(loadPhpLocalPathDependencies(manifestDir)).toEqual([]);

        fs.writeFileSync(path.join(manifestDir, 'composer.json'), '{not json');
        expect(loadPhpLocalPathDependencies(manifestDir)).toEqual([]);

        fs.rmSync(path.join(manifestDir, 'composer.json'));
        expect(loadPhpLocalPathDependencies(manifestDir)).toEqual([]);
    });
});
