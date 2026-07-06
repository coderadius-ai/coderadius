import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanguagePlugin, RuntimeServiceSignals } from '../../../../src/ingestion/core/languages/types';
import { classifyServiceRole } from '../../../../src/ingestion/extractors/autodiscovery';

function makeRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-presence-'));
}

function touch(dir: string, rel: string, contents = '') {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

function stubPlugin(signals: RuntimeServiceSignals | undefined): LanguagePlugin {
    return { language: 'fake', extensions: [], scopeExclusions: [], runtimeServiceSignals: signals } as unknown as LanguagePlugin;
}

describe('classifyServiceRole — manifestPresence signal', () => {
    let repo: string;
    beforeEach(() => { repo = makeRepo(); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    // ── Semantics change (RC0 fix from acme-platform ingestion analysis) ──
    // manifestPresence is a SUPPORTING signal, never standalone:
    // a workspace with only a manifest + file count threshold (no
    // bootstrap, no start script, no Dockerfile, no dependency
    // marker) is NOT a runtime service. Previously the signal was
    // ANY-OF with the strong ones and trivially misclassified
    // NestJS `libs/helper` (16 helper-only TS files, `nest build`
    // script) as a Service.

    it('PHP-style monolith: composer.json with require + ≥10 .php files alone → undefined (no entrypoint)', () => {
        const dir = path.join(repo, 'apps/inventory');
        touch(dir, 'composer.json', JSON.stringify({ require: { 'acme/inventory-core': '^1.0' } }));
        for (let i = 0; i < 12; i++) {
            touch(dir, `src/Stub${i}.php`, '<?php\nfinal class Stub {}\n');
        }
        const plugin = stubPlugin({
            manifestPresence: [{
                manifest: 'composer.json',
                requireSection: 'require',
                minSourceFiles: 10,
                sourceExtensions: ['.php'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('PHP-style: composer.json with require but only 4 .php files (sotto soglia) → undefined', () => {
        const dir = path.join(repo, 'apps/tiny');
        touch(dir, 'composer.json', JSON.stringify({ require: { 'acme/inventory-core': '^1.0' } }));
        for (let i = 0; i < 4; i++) {
            touch(dir, `src/Stub${i}.php`, '<?php\nfinal class Stub {}\n');
        }
        const plugin = stubPlugin({
            manifestPresence: [{
                manifest: 'composer.json',
                requireSection: 'require',
                minSourceFiles: 10,
                sourceExtensions: ['.php'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('PHP-style: composer.json with empty require + many .php files → undefined', () => {
        const dir = path.join(repo, 'apps/empty-require');
        touch(dir, 'composer.json', JSON.stringify({ require: {} }));
        for (let i = 0; i < 20; i++) {
            touch(dir, `src/Stub${i}.php`, '<?php\nfinal class Stub {}\n');
        }
        const plugin = stubPlugin({
            manifestPresence: [{
                manifest: 'composer.json',
                requireSection: 'require',
                minSourceFiles: 10,
                sourceExtensions: ['.php'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('TS-style monolith: package.json dependencies + ≥10 .ts files alone → undefined (no entrypoint)', () => {
        const dir = path.join(repo, 'apps/orders');
        touch(dir, 'package.json', JSON.stringify({ dependencies: { fastify: '^4.0.0' } }));
        for (let i = 0; i < 11; i++) {
            touch(dir, `src/stub${i}.ts`, 'export const x = 1;\n');
        }
        const plugin = stubPlugin({
            manifestPresence: [{
                manifest: 'package.json',
                requireSection: 'dependencies',
                minSourceFiles: 10,
                sourceExtensions: ['.ts', '.tsx'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('TS-style monolith WITH start script + ≥10 .ts files → runtime (combo: strong + supporting)', () => {
        const dir = path.join(repo, 'apps/orders-real');
        touch(dir, 'package.json', JSON.stringify({
            scripts: { start: 'node dist/main.js' },
            dependencies: { fastify: '^4.0.0' },
        }));
        for (let i = 0; i < 11; i++) {
            touch(dir, `src/stub${i}.ts`, 'export const x = 1;\n');
        }
        const plugin = stubPlugin({
            manifestFields: [{ manifest: 'package.json', jsonPath: 'scripts.start', condition: 'exists' }],
            manifestPresence: [{
                manifest: 'package.json',
                requireSection: 'dependencies',
                minSourceFiles: 10,
                sourceExtensions: ['.ts', '.tsx'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBe('runtime');
    });

    it('presence count ignores files under vendor/ and node_modules/', () => {
        const dir = path.join(repo, 'apps/inventory');
        touch(dir, 'composer.json', JSON.stringify({ require: { 'acme/inventory-core': '^1.0' } }));
        for (let i = 0; i < 50; i++) {
            touch(dir, `vendor/some-dep/Stub${i}.php`, '<?php\n');
        }
        touch(dir, 'src/OneFile.php', '<?php\n');
        const plugin = stubPlugin({
            manifestPresence: [{
                manifest: 'composer.json',
                requireSection: 'require',
                minSourceFiles: 10,
                sourceExtensions: ['.php'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('presence count ignores tests/ examples/ dist/ build/ dirs', () => {
        const dir = path.join(repo, 'apps/orders');
        touch(dir, 'package.json', JSON.stringify({ dependencies: { fastify: '^4.0.0' } }));
        for (let i = 0; i < 30; i++) {
            touch(dir, `tests/stub${i}.ts`, 'export const x = 1;\n');
        }
        for (let i = 0; i < 30; i++) {
            touch(dir, `dist/stub${i}.ts`, 'export const x = 1;\n');
        }
        touch(dir, 'src/oneFile.ts', 'export const y = 2;\n');
        const plugin = stubPlugin({
            manifestPresence: [{
                manifest: 'package.json',
                requireSection: 'dependencies',
                minSourceFiles: 10,
                sourceExtensions: ['.ts', '.tsx'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('supporting-only semantics: presence alone does NOT fire when all strong signals miss', () => {
        // REGRESSION GUARD (RC0): this was the exact scenario that
        // misclassified `libs/helper` and `libs/product` in acme-platform.
        // No bootstrap, no start script, no framework dep marker — the
        // workspace is a library even with 15+ files. Returning
        // 'runtime' here was the bug; keeping it as 'undefined' is the
        // contract.
        const dir = path.join(repo, 'apps/no-entrypoint');
        touch(dir, 'composer.json', JSON.stringify({ require: { 'acme/inventory-core': '^1.0' } }));
        for (let i = 0; i < 15; i++) {
            touch(dir, `src/Stub${i}.php`, '<?php\nfinal class Stub {}\n');
        }
        const plugin = stubPlugin({
            manifestFields: [{ manifest: 'composer.json', jsonPath: 'bin', condition: 'exists' }],
            entrypoints: [{ files: ['public/index.php'], patterns: [/<\?php/] }],
            dependencyMarkers: [{ manifest: 'composer.json', packages: ['symfony/runtime'], sections: ['require'] }],
            manifestPresence: [{
                manifest: 'composer.json',
                requireSection: 'require',
                minSourceFiles: 10,
                sourceExtensions: ['.php'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('combo semantics: presence + ANY one strong signal → runtime', () => {
        // Counterpart of the regression guard above: when at least one
        // strong signal does fire (here: a bootstrap entrypoint), the
        // workspace IS a runtime service and presence reinforces it.
        const dir = path.join(repo, 'apps/has-entrypoint');
        touch(dir, 'composer.json', JSON.stringify({ require: { 'acme/inventory-core': '^1.0' } }));
        touch(dir, 'public/index.php', '<?php require __DIR__."/../vendor/autoload.php";');
        for (let i = 0; i < 15; i++) {
            touch(dir, `src/Stub${i}.php`, '<?php\nfinal class Stub {}\n');
        }
        const plugin = stubPlugin({
            entrypoints: [{ files: ['public/index.php'], patterns: [/<\?php/] }],
            manifestPresence: [{
                manifest: 'composer.json',
                requireSection: 'require',
                minSourceFiles: 10,
                sourceExtensions: ['.php'],
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBe('runtime');
    });
});
