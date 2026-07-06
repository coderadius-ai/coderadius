import { describe, test, expect } from 'vitest';
import { devtoolsPlugin } from '../../../src/ingestion/structural/plugins/devtools.plugin.js';
import type { PluginContext } from '../../../src/ingestion/structural/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
        relativePath: 'renovate.json',
        absolutePath: '/repo/renovate.json',
        basename: 'renovate.json',
        repoName: 'acme/my-service',
        ownerService: 'my-service',
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile — Renovate
// ═══════════════════════════════════════════════════════════════════════════════

describe('devtoolsPlugin.matchFile — Renovate', () => {
    test('matches renovate.json at repo root', () => {
        expect(devtoolsPlugin.matchFile('renovate.json', 'renovate.json')).toBe(true);
    });

    test('matches renovate.json5', () => {
        expect(devtoolsPlugin.matchFile('renovate.json5', 'renovate.json5')).toBe(true);
    });

    test('matches .renovaterc', () => {
        expect(devtoolsPlugin.matchFile('.renovaterc', '.renovaterc')).toBe(true);
    });

    test('matches .renovaterc.json', () => {
        expect(devtoolsPlugin.matchFile('.renovaterc.json', '.renovaterc.json')).toBe(true);
    });

    test('matches .github/renovate.json via relativePath', () => {
        expect(devtoolsPlugin.matchFile('.github/renovate.json', 'renovate.json')).toBe(true);
    });

    test('does NOT match renovate.yaml (not a supported Renovate filename)', () => {
        expect(devtoolsPlugin.matchFile('renovate.yaml', 'renovate.yaml')).toBe(false);
    });

    test('does NOT match my-renovate.json (prefix mismatch)', () => {
        expect(devtoolsPlugin.matchFile('my-renovate.json', 'my-renovate.json')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile — DevContainers
// ═══════════════════════════════════════════════════════════════════════════════

describe('devtoolsPlugin.matchFile — DevContainers', () => {
    test('matches devcontainer.json at root level (root devcontainer)', () => {
        expect(devtoolsPlugin.matchFile('devcontainer.json', 'devcontainer.json')).toBe(true);
    });

    test('matches .devcontainer/devcontainer.json (nested form)', () => {
        expect(devtoolsPlugin.matchFile('.devcontainer/devcontainer.json', 'devcontainer.json')).toBe(true);
    });

    test('does NOT match devcontainer.yaml', () => {
        expect(devtoolsPlugin.matchFile('devcontainer.yaml', 'devcontainer.yaml')).toBe(false);
    });

    test('does NOT match .devcontainer/ directory marker without file', () => {
        expect(devtoolsPlugin.matchFile('.devcontainer/', '.devcontainer')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile — Backstage catalog
// ═══════════════════════════════════════════════════════════════════════════════

describe('devtoolsPlugin.matchFile — Backstage catalog', () => {
    test('matches catalog-info.yaml', () => {
        expect(devtoolsPlugin.matchFile('catalog-info.yaml', 'catalog-info.yaml')).toBe(true);
    });

    test('matches catalog-info.yaml in subdirectory', () => {
        expect(devtoolsPlugin.matchFile('services/api/catalog-info.yaml', 'catalog-info.yaml')).toBe(true);
    });

    test('matches catalog.yaml', () => {
        expect(devtoolsPlugin.matchFile('catalog.yaml', 'catalog.yaml')).toBe(true);
    });

    test('matches catalog.yml', () => {
        expect(devtoolsPlugin.matchFile('catalog.yml', 'catalog.yml')).toBe(true);
    });

    test('does NOT match some-catalog-info.yaml (prefix mismatch)', () => {
        // Only exact basename matches
        expect(devtoolsPlugin.matchFile('some-catalog-info.yaml', 'some-catalog-info.yaml')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile — no false positives on common files
// ═══════════════════════════════════════════════════════════════════════════════

describe('devtoolsPlugin.matchFile — no false positives', () => {
    test('does NOT match package.json', () => {
        expect(devtoolsPlugin.matchFile('package.json', 'package.json')).toBe(false);
    });

    test('does NOT match Dockerfile', () => {
        expect(devtoolsPlugin.matchFile('Dockerfile', 'Dockerfile')).toBe(false);
    });

    test('does NOT match .gitlab-ci.yml', () => {
        expect(devtoolsPlugin.matchFile('.gitlab-ci.yml', '.gitlab-ci.yml')).toBe(false);
    });

    test('does NOT match tsconfig.json', () => {
        expect(devtoolsPlugin.matchFile('tsconfig.json', 'tsconfig.json')).toBe(false);
    });

    test('does NOT match docker-compose.yml', () => {
        expect(devtoolsPlugin.matchFile('docker-compose.yml', 'docker-compose.yml')).toBe(false);
    });

    test('does NOT match README.md', () => {
        expect(devtoolsPlugin.matchFile('README.md', 'README.md')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — presence-only semantics
// ═══════════════════════════════════════════════════════════════════════════════

describe('devtoolsPlugin.extract — presence-only semantics', () => {
    test('always returns zero entities (StructuralFile created by plugin-manager)', () => {
        const result = devtoolsPlugin.extract('{}', makeCtx());
        expect(result.entities).toHaveLength(0);
    });

    test('returns zero entities for empty content', () => {
        const result = devtoolsPlugin.extract('', makeCtx());
        expect(result.entities).toHaveLength(0);
    });

    test('returns zero entities regardless of file type matched', () => {
        const cases: Array<[string, string]> = [
            ['renovate.json', '{}'],
            ['.renovaterc', '{}'],
            ['catalog-info.yaml', 'apiVersion: backstage.io/v1alpha1'],
            ['devcontainer.json', '{}'],
        ];
        for (const [basename, content] of cases) {
            const result = devtoolsPlugin.extract(
                content,
                makeCtx({ relativePath: basename, basename }),
            );
            expect(result.entities, `should be empty for ${basename}`).toHaveLength(0);
        }
    });

    test('managedLabels is empty (no entity nodes created)', () => {
        expect(devtoolsPlugin.managedLabels).toHaveLength(0);
    });

    test('summary mentions the detected file path', () => {
        const result = devtoolsPlugin.extract('{}', makeCtx({ relativePath: 'renovate.json', basename: 'renovate.json' }));
        expect(result.summary).toContain('renovate.json');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// StructuralFile creation invariant
// ═══════════════════════════════════════════════════════════════════════════════

describe('devtoolsPlugin — StructuralFile creation invariant', () => {
    // The plugin-manager creates a StructuralFile node for every file where
    // at least one plugin returns matchFile() === true.
    // This test verifies that devtoolsPlugin correctly signals the plugin-manager
    // for all expected file types.

    const EXPECTED_MATCHES: Array<[string, string]> = [
        ['renovate.json', 'renovate.json'],
        ['renovate.json5', 'renovate.json5'],
        ['.renovaterc', '.renovaterc'],
        ['.renovaterc.json', '.renovaterc.json'],
        ['.github/renovate.json', 'renovate.json'],
        ['.devcontainer/devcontainer.json', 'devcontainer.json'],
        ['devcontainer.json', 'devcontainer.json'],
        ['catalog-info.yaml', 'catalog-info.yaml'],
        ['catalog.yaml', 'catalog.yaml'],
    ];

    for (const [relativePath, basename] of EXPECTED_MATCHES) {
        test(`matchFile returns true for ${relativePath}`, () => {
            expect(devtoolsPlugin.matchFile(relativePath, basename)).toBe(true);
        });
    }
});
