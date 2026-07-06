import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageScriptsPlugin, detectJsRunner } from '../../../../src/ingestion/structural/plugins/package-scripts.plugin.js';
import { simpleToolsPlugin } from '../../../../src/ingestion/structural/plugins/simple-tools.plugin.js';
import { parseBunLock } from '../../../../src/ingestion/core/languages/typescript/dependencies.js';
import type { PluginContext } from '../../../../src/ingestion/structural/types.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Package Manager Detection — Unit Tests
//
// Covers:
//   1. detectJsRunner() — packageManager field, lockfile walk, fallback
//   2. packageScriptsPlugin — runner integration in task extraction
//   3. simpleToolsPlugin — ToolConfig presence matching for all lockfile types
//   4. parseBunLock() — Bun text lockfile parsing
// ═══════════════════════════════════════════════════════════════════════════════

let tempDir: string;

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-detect-'));
    return dir;
}

function makeContext(relativePath: string, absolutePath: string, repoName = 'test-repo'): PluginContext {
    return {
        relativePath,
        absolutePath,
        repoName,
        repoUrn: `cr://repository/${repoName}`,
        scopeManager: new ScopeManager(tempDir),
    };
}

beforeEach(() => {
    tempDir = makeTempDir();
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── detectJsRunner() ────────────────────────────────────────────────────────

describe('detectJsRunner', () => {
    it('should return pnpm from packageManager field', () => {
        const result = detectJsRunner(
            { packageManager: 'pnpm@9.15.0' },
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('pnpm');
    });

    it('should return yarn from packageManager field', () => {
        const result = detectJsRunner(
            { packageManager: 'yarn@4.1.0' },
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('yarn');
    });

    it('should return bun from packageManager field', () => {
        const result = detectJsRunner(
            { packageManager: 'bun@1.2.3' },
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('bun');
    });

    it('should return npm from packageManager field', () => {
        const result = detectJsRunner(
            { packageManager: 'npm@10.2.0' },
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('npm');
    });

    it('should detect pnpm from lockfile in same directory', () => {
        fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');
        const result = detectJsRunner(
            {},
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('pnpm');
    });

    it('should detect yarn from lockfile in same directory', () => {
        fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '');
        const result = detectJsRunner(
            {},
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('yarn');
    });

    it('should detect bun from bun.lock in same directory', () => {
        fs.writeFileSync(path.join(tempDir, 'bun.lock'), '');
        const result = detectJsRunner(
            {},
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('bun');
    });

    it('should detect bun from bun.lockb (legacy binary) in same directory', () => {
        fs.writeFileSync(path.join(tempDir, 'bun.lockb'), '');
        const result = detectJsRunner(
            {},
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('bun');
    });

    it('should detect npm from package-lock.json in same directory', () => {
        fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
        const result = detectJsRunner(
            {},
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('npm');
    });

    it('should walk up to repo root for lockfile detection (monorepo)', () => {
        // Root has pnpm-lock.yaml, child package has no lockfile
        fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');
        const childDir = path.join(tempDir, 'packages', 'api');
        fs.mkdirSync(childDir, { recursive: true });

        const result = detectJsRunner(
            {},
            path.join(childDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('pnpm');
    });

    it('should fallback to npm when no lockfile or packageManager field found', () => {
        const result = detectJsRunner(
            {},
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('npm');
    });

    it('should prioritize packageManager field over lockfile presence', () => {
        // Both pnpm lockfile and yarn packageManager field present — field wins
        fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');
        const result = detectJsRunner(
            { packageManager: 'yarn@4.1.0' },
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('yarn');
    });

    it('should ignore invalid packageManager values and fallback to lockfile', () => {
        fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');
        const result = detectJsRunner(
            { packageManager: '' },
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('pnpm');
    });

    it('should ignore unknown packageManager values and fallback to lockfile', () => {
        fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '');
        const result = detectJsRunner(
            { packageManager: 'deno@2.0.0' },
            path.join(tempDir, 'package.json'),
            tempDir,
        );
        expect(result).toBe('yarn');
    });
});

// ─── packageScriptsPlugin integration ────────────────────────────────────────

describe('packageScriptsPlugin — runner detection integration', () => {
    it('should detect pnpm runner from lockfile when extracting scripts', () => {
        fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');
        const pkgJson = JSON.stringify({
            name: 'my-app',
            scripts: { build: 'tsc', test: 'vitest' },
        });
        const ctx = makeContext('package.json', path.join(tempDir, 'package.json'));
        const result = packageScriptsPlugin.extract(pkgJson, ctx);

        expect(result.entities).toHaveLength(2);
        expect(result.entities[0].properties.source).toBe('pnpm');
        expect(result.entities[1].properties.source).toBe('pnpm');
        expect(result.summary).toContain('pnpm');
    });

    it('should detect composer runner for composer.json regardless of JS lockfiles', () => {
        // Even if there's a yarn.lock next to the composer.json
        fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '');
        const composerJson = JSON.stringify({
            name: 'acme/app',
            scripts: { 'post-install-cmd': '@php artisan optimize' },
        });
        const ctx = makeContext('composer.json', path.join(tempDir, 'composer.json'));
        const result = packageScriptsPlugin.extract(composerJson, ctx);

        expect(result.entities).toHaveLength(1);
        expect(result.entities[0].properties.source).toBe('composer');
    });

    it('should use packageManager field from package.json content', () => {
        const pkgJson = JSON.stringify({
            name: 'my-bun-app',
            packageManager: 'bun@1.2.0',
            scripts: { dev: 'bun run src/index.ts' },
        });
        const ctx = makeContext('package.json', path.join(tempDir, 'package.json'));
        const result = packageScriptsPlugin.extract(pkgJson, ctx);

        expect(result.entities).toHaveLength(1);
        expect(result.entities[0].properties.source).toBe('bun');
    });
});

// ─── simpleToolsPlugin — lockfile ToolConfig matching ────────────────────────

describe('simpleToolsPlugin — package manager lockfile matching', () => {
    const lockfiles: [string, string][] = [
        ['package-lock.json', 'npm'],
        ['yarn.lock', 'yarn'],
        ['.yarnrc.yml', 'yarn'],
        ['pnpm-lock.yaml', 'pnpm'],
        ['pnpm-workspace.yaml', 'pnpm'],
        ['bun.lock', 'bun'],
        ['bun.lockb', 'bun'],
        ['composer.lock', 'composer'],
        ['Pipfile.lock', 'pipenv'],
        ['poetry.lock', 'poetry'],
        ['uv.lock', 'uv'],
        ['pdm.lock', 'pdm'],
        ['go.sum', 'go'],
    ];

    for (const [filename, expectedTool] of lockfiles) {
        it(`should match ${filename} as ${expectedTool} ToolConfig`, () => {
            expect(simpleToolsPlugin.matchFile(filename, filename)).toBe(true);

            const ctx = makeContext(filename, path.join(tempDir, filename));
            const result = simpleToolsPlugin.extract('', ctx);

            expect(result.entities.length).toBeGreaterThanOrEqual(1);
            const toolEntity = result.entities.find(e => e.properties.tool === expectedTool);
            expect(toolEntity).toBeDefined();
            expect(toolEntity!.labels).toContain('ToolConfig');
        });
    }

    it('should NOT match non-lockfile files', () => {
        expect(simpleToolsPlugin.matchFile('README.md', 'README.md')).toBe(false);
        expect(simpleToolsPlugin.matchFile('index.ts', 'index.ts')).toBe(false);
        expect(simpleToolsPlugin.matchFile('go.mod', 'go.mod')).toBe(false);
    });
});

// ─── parseBunLock — Bun text lockfile parsing ────────────────────────────────

describe('parseBunLock', () => {
    it('should parse bun.lock JSONC format with trailing commas', () => {
        const lockContent = `{
  "lockfileVersion": 1,
  "workspaces": {},
  "packages": {
    "react": ["react@18.3.0", { "dependencies": { "loose-envify": "^1.1.0" } }],
    "@types/node": ["@types/node@22.0.0"],
    "vitest": ["vitest@3.2.4", { "bin": { "vitest": "vitest.mjs" } }],
  },
}`;
        const lockPath = path.join(tempDir, 'bun.lock');
        fs.writeFileSync(lockPath, lockContent);

        const map = new Map<string, string>();
        parseBunLock(lockPath, map);

        expect(map.get('react')).toBe('18.3.0');
        expect(map.get('@types/node')).toBe('22.0.0');
        expect(map.get('vitest')).toBe('3.2.4');
    });

    it('should skip workspace: protocol versions', () => {
        const lockContent = `{
  "packages": {
    "@acme/shared": ["@acme/shared@workspace:packages/shared"],
    "react": ["react@18.3.0"],
  },
}`;
        const lockPath = path.join(tempDir, 'bun.lock');
        fs.writeFileSync(lockPath, lockContent);

        const map = new Map<string, string>();
        parseBunLock(lockPath, map);

        expect(map.has('@acme/shared')).toBe(false);
        expect(map.get('react')).toBe('18.3.0');
    });

    it('should handle empty or malformed lockfiles gracefully', () => {
        const lockPath = path.join(tempDir, 'bun.lock');

        // Empty file
        fs.writeFileSync(lockPath, '');
        const map1 = new Map<string, string>();
        expect(() => parseBunLock(lockPath, map1)).not.toThrow();
        expect(map1.size).toBe(0);

        // No packages key
        fs.writeFileSync(lockPath, '{"lockfileVersion": 1}');
        const map2 = new Map<string, string>();
        parseBunLock(lockPath, map2);
        expect(map2.size).toBe(0);
    });
});
