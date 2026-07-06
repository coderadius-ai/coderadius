import { describe, test, expect } from 'vitest';
import { ciConfigPlugin } from '../../../src/ingestion/structural/plugins/ciconfig.plugin.js';
import type { PluginContext } from '../../../src/ingestion/structural/types.js';

// ─── Test context ─────────────────────────────────────────────────────────────

const ctx: PluginContext = {
    relativePath: '.gitlab-ci.yml',
    absolutePath: '/repo/.gitlab-ci.yml',
    basename: '.gitlab-ci.yml',
    repoName: 'acme/my-service',
    ownerService: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile — detection rules
// ═══════════════════════════════════════════════════════════════════════════════

describe('ciConfigPlugin.matchFile', () => {

    // ── GitLab CI ─────────────────────────────────────────────────────────────

    test('matches .gitlab-ci.yml', () => {
        expect(ciConfigPlugin.matchFile('.gitlab-ci.yml', '.gitlab-ci.yml')).toBe(true);
    });

    test('matches .gitlab-ci.yaml (GitLab accepts both .yml and .yaml)', () => {
        expect(ciConfigPlugin.matchFile('.gitlab-ci.yaml', '.gitlab-ci.yaml')).toBe(true);
    });

    test('does NOT match gitlab-ci.yml (no leading dot)', () => {
        expect(ciConfigPlugin.matchFile('gitlab-ci.yml', 'gitlab-ci.yml')).toBe(false);
    });

    // ── GitHub Actions ────────────────────────────────────────────────────────

    test('matches .github/workflows/ci.yml', () => {
        expect(ciConfigPlugin.matchFile('.github/workflows/ci.yml', 'ci.yml')).toBe(true);
    });

    test('matches .github/workflows/deploy.yaml', () => {
        expect(ciConfigPlugin.matchFile('.github/workflows/deploy.yaml', 'deploy.yaml')).toBe(true);
    });

    test('matches .github/workflows/release.yml', () => {
        expect(ciConfigPlugin.matchFile('.github/workflows/release.yml', 'release.yml')).toBe(true);
    });

    test('does NOT match .github/other/ci.yml (not under workflows/)', () => {
        // Only files under .github/workflows/ are GitHub Actions
        expect(ciConfigPlugin.matchFile('.github/other/ci.yml', 'ci.yml')).toBe(false);
    });

    test('does NOT match arbitrary YAML in repo root', () => {
        expect(ciConfigPlugin.matchFile('config.yml', 'config.yml')).toBe(false);
        expect(ciConfigPlugin.matchFile('docker-compose.yml', 'docker-compose.yml')).toBe(false);
    });

    test('does NOT match .yml files in non-workflow directories', () => {
        expect(ciConfigPlugin.matchFile('scripts/deploy.yml', 'deploy.yml')).toBe(false);
        expect(ciConfigPlugin.matchFile('kubernetes/deployment.yaml', 'deployment.yaml')).toBe(false);
    });

    // ── Security: no false positives on common files ──────────────────────────

    test('does NOT match package.json', () => {
        expect(ciConfigPlugin.matchFile('package.json', 'package.json')).toBe(false);
    });

    test('does NOT match Dockerfile', () => {
        expect(ciConfigPlugin.matchFile('Dockerfile', 'Dockerfile')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — presence-detection semantics
// ═══════════════════════════════════════════════════════════════════════════════

describe('ciConfigPlugin.extract', () => {
    const GITLAB_CI_CONTENT = `
stages:
  - build
  - test
  - deploy

build-job:
  stage: build
  script:
    - make build
`.trim();

    const GH_ACTIONS_CONTENT = `
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make test
`.trim();

    test('returns zero entities for GitLab CI file (presence-only plugin)', () => {
        const result = ciConfigPlugin.extract(GITLAB_CI_CONTENT, ctx);
        expect(result.entities).toHaveLength(0);
    });

    test('returns zero entities for GitHub Actions file', () => {
        const ghCtx = { ...ctx, relativePath: '.github/workflows/ci.yml', basename: 'ci.yml' };
        const result = ciConfigPlugin.extract(GH_ACTIONS_CONTENT, ghCtx);
        expect(result.entities).toHaveLength(0);
    });

    test('summary mentions the detected file path', () => {
        const result = ciConfigPlugin.extract(GITLAB_CI_CONTENT, ctx);
        expect(result.summary).toContain('.gitlab-ci.yml');
    });

    test('returns zero entities even for empty CI file', () => {
        const result = ciConfigPlugin.extract('', ctx);
        expect(result.entities).toHaveLength(0);
    });

    test('managedLabels is empty (no new node labels created)', () => {
        // The StructuralFile node is created by the plugin-manager, not by this plugin.
        // This ensures the reconciliation/tombstoning system does not touch CI config files.
        expect(ciConfigPlugin.managedLabels).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration invariant: StructuralFile creation guarantee
// ═══════════════════════════════════════════════════════════════════════════════

describe('StructuralFile creation invariant [GPT P1-a regression]', () => {
    // The plugin-manager skips a file if matchingPlugins.length === 0.
    // Without ciConfigPlugin, .gitlab-ci.yml would be discovered by the glob
    // but skipped, and NO StructuralFile would be created — breaking gp-005.
    //
    // This test verifies the contract: ciConfigPlugin.matchFile MUST return true
    // for both supported CI file types, guaranteeing the plugin-manager will call
    // mergeStructuralFile() and create the (Repository)-[:HAS_CONFIG]->(StructuralFile).

    test('at least one plugin matches .gitlab-ci.yml', () => {
        // Simulating plugin-manager filter: matchingPlugins.length must be > 0
        const plugins = [ciConfigPlugin];
        const matchingPlugins = plugins.filter(p =>
            p.matchFile('.gitlab-ci.yml', '.gitlab-ci.yml'),
        );
        expect(matchingPlugins.length).toBeGreaterThan(0);
    });

    test('at least one plugin matches .github/workflows/ci.yml', () => {
        const plugins = [ciConfigPlugin];
        const matchingPlugins = plugins.filter(p =>
            p.matchFile('.github/workflows/ci.yml', 'ci.yml'),
        );
        expect(matchingPlugins.length).toBeGreaterThan(0);
    });
});
