import { describe, expect, it } from 'vitest';
import {
    extractDependencies,
    isInternalPackage,
} from '../../../../src/ingestion/core/dependencies.js';

// ─── extractDependencies (plugin dispatch) ───────────────────────────────────

describe('extractDependencies composer platform handling', () => {
    const composerJson = JSON.stringify({
        require: {
            php: '~7.4',
            'ext-json': '*',
            'acme/inventory-client': '^2.0',
        },
        'require-dev': {
            'ext-xdebug': '*',
            'phpunit/phpunit': '^9.0',
        },
    });

    it('skips platform requirements in require and require-dev', () => {
        const deps = extractDependencies('repo/composer.json', composerJson, new Set());
        expect(deps.map(d => d.name).sort()).toEqual(['acme/inventory-client', 'phpunit/phpunit']);
    });

    it('never marks a platform requirement internal, even when a service shares its name', () => {
        // A docker-compose Service named "php" lands in knownInternalNames;
        // the platform requirement must not surface as an internal package.
        const deps = extractDependencies('repo/composer.json', composerJson, new Set(['php']));
        expect(deps.find(d => d.name === 'php')).toBeUndefined();
    });

    it('still flags real internal packages by vendor prefix', () => {
        const deps = extractDependencies('repo/composer.json', composerJson, new Set(['acme/orders-service']));
        const internal = deps.find(d => d.name === 'acme/inventory-client');
        expect(internal?.isInternal).toBe(true);
    });

    it('routes package.json to the npm parser', () => {
        const packageJson = JSON.stringify({
            dependencies: { '@acme/logger': '^1.0.0' },
            devDependencies: { vitest: '^2.0.0' },
        });
        const deps = extractDependencies('repo/package.json', packageJson, new Set(['@acme/inventory']));
        expect(deps).toEqual([
            { ecosystem: 'npm', name: '@acme/logger', requiredVersion: '^1.0.0', isDev: false, isInternal: true },
            { ecosystem: 'npm', name: 'vitest', requiredVersion: '^2.0.0', isDev: true, isInternal: false },
        ]);
    });

    it('returns [] for files no plugin recognizes', () => {
        expect(extractDependencies('repo/go.sum', 'whatever', new Set())).toEqual([]);
    });
});

// ─── isInternalPackage (unchanged behaviour pinned) ──────────────────────────

describe('isInternalPackage', () => {
    it('exact-matches known names', () => {
        expect(isInternalPackage('orders-service', new Set(['orders-service']))).toBe(true);
    });

    it('matches npm scope derived from known internals', () => {
        expect(isInternalPackage('@acme/logger', new Set(['@acme/inventory']))).toBe(true);
    });

    it('matches composer vendor derived from known internals', () => {
        expect(isInternalPackage('acme/logger', new Set(['acme/inventory']))).toBe(true);
    });

    it('rejects unrelated packages', () => {
        expect(isInternalPackage('guzzlehttp/guzzle', new Set(['acme/inventory']))).toBe(false);
    });
});
