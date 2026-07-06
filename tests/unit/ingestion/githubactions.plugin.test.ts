import { describe, test, expect } from 'vitest';
import { githubActionsPlugin } from '../../../src/ingestion/structural/plugins/githubactions.plugin.js';
import type { PluginContext } from '../../../src/ingestion/structural/types.js';
import fs from 'node:fs';
import path from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
        relativePath: '.github/workflows/ci.yml',
        absolutePath: '/repo/.github/workflows/ci.yml',
        basename: 'ci.yml',
        repoName: 'acme/notification-service',
        ownerService: 'notification-service',
        ...overrides,
    };
}

function extract(content: string, ctxOverrides: Partial<PluginContext> = {}) {
    const result = githubActionsPlugin.extract(content, makeCtx(ctxOverrides));
    return {
        result,
        entity: result.entities[0],
        props: result.entities[0]?.properties,
    };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PR_WORKFLOW = `
name: CI Pipeline
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: make test
  deploy:
    name: Deploy Staging
    runs-on: ubuntu-latest
    needs: [test]
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - run: make deploy
`.trim();

const PUSH_ONLY_WORKFLOW = `
name: Deploy Only
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: make deploy
`.trim();

const REUSABLE_WORKFLOW = `
name: Reusable CI
on:
  workflow_call:
    inputs:
      environment:
        required: true
        type: string
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: myorg/shared-actions/build@v2
      - run: make build
`.trim();

const ARRAY_ON_WORKFLOW = `
on: [push, pull_request, workflow_dispatch]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: make lint
`.trim();

const SCALAR_ON_WORKFLOW = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make build
`.trim();

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.matchFile', () => {
    test('matches .github/workflows/ci.yml', () => {
        expect(githubActionsPlugin.matchFile('.github/workflows/ci.yml', 'ci.yml')).toBe(true);
    });

    test('matches .github/workflows/release.yaml', () => {
        expect(githubActionsPlugin.matchFile('.github/workflows/release.yaml', 'release.yaml')).toBe(true);
    });

    test('matches .github/workflows/deploy-prod.yml', () => {
        expect(githubActionsPlugin.matchFile('.github/workflows/deploy-prod.yml', 'deploy-prod.yml')).toBe(true);
    });

    test('does NOT match .gitlab-ci.yml', () => {
        expect(githubActionsPlugin.matchFile('.gitlab-ci.yml', '.gitlab-ci.yml')).toBe(false);
    });

    test('does NOT match .github/other/file.yml (not under workflows/)', () => {
        expect(githubActionsPlugin.matchFile('.github/other/file.yml', 'file.yml')).toBe(false);
    });

    test('does NOT match .github/workflows/something.json', () => {
        expect(githubActionsPlugin.matchFile('.github/workflows/something.json', 'something.json')).toBe(false);
    });

    test('does NOT match arbitrary YAML files', () => {
        expect(githubActionsPlugin.matchFile('docker-compose.yml', 'docker-compose.yml')).toBe(false);
        expect(githubActionsPlugin.matchFile('config.yaml', 'config.yaml')).toBe(false);
    });

    test('does NOT match package.json', () => {
        expect(githubActionsPlugin.matchFile('package.json', 'package.json')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — basic invariants
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.extract — basic invariants', () => {
    test('produces exactly one CIPipeline entity', () => {
        const { result } = extract(PR_WORKFLOW);
        expect(result.entities).toHaveLength(1);
        expect(result.entities[0]!.labels).toContain('CIPipeline');
    });

    test('entity relationshipType is DEFINES', () => {
        const { entity } = extract(PR_WORKFLOW);
        expect(entity!.relationshipType).toBe('DEFINES');
    });

    test('managedLabels contains CIPipeline', () => {
        expect(githubActionsPlugin.managedLabels).toContain('CIPipeline');
    });

    test('URN follows cr:cipipeline:{repoName}:github-actions:{filePath} schema', () => {
        const { entity } = extract(PR_WORKFLOW);
        expect(entity!.id).toBe(
            'cr:cipipeline:acme/notification-service:github-actions:.github/workflows/ci.yml',
        );
    });

    test('tool property is always github-actions', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['tool']).toBe('github-actions');
    });

    test('uses workflow name property when present', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['name']).toBe('CI Pipeline');
    });

    test('falls back to basename when workflow has no name', () => {
        const { props } = extract(ARRAY_ON_WORKFLOW);
        expect(props!['name']).toContain('ci.yml');
    });

    test('_sourcePath matches relativePath', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['_sourcePath']).toBe('.github/workflows/ci.yml');
    });

    test('_ownerService is propagated from context', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['_ownerService']).toBe('notification-service');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — triggers
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.extract — triggers', () => {
    test('extracts object-form triggers (push and pull_request)', () => {
        const { props } = extract(PR_WORKFLOW);
        const triggers = (props!['triggers'] as string).split(',');
        expect(triggers).toContain('push');
        expect(triggers).toContain('pull_request');
    });

    test('extracts array-form triggers', () => {
        const { props } = extract(ARRAY_ON_WORKFLOW);
        const triggers = (props!['triggers'] as string).split(',');
        expect(triggers).toContain('push');
        expect(triggers).toContain('pull_request');
        expect(triggers).toContain('workflow_dispatch');
    });

    test('extracts scalar-form trigger', () => {
        const { props } = extract(SCALAR_ON_WORKFLOW);
        expect(props!['triggers']).toBe('push');
    });

    test('handles workflow_call trigger (reusable workflows)', () => {
        const { props } = extract(REUSABLE_WORKFLOW);
        expect(props!['triggers']).toContain('workflow_call');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — MR pipeline detection (pull_request → hasMergeRequestPipeline)
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.extract — hasMergeRequestPipeline', () => {
    test('is true when pull_request trigger is present (object form)', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['hasMergeRequestPipeline']).toBe(true);
    });

    test('is true when pull_request trigger is in array form', () => {
        const { props } = extract(ARRAY_ON_WORKFLOW);
        expect(props!['hasMergeRequestPipeline']).toBe(true);
    });

    test('is true for pull_request_target trigger', () => {
        const content = `
on:
  pull_request_target:
    types: [opened, synchronize]
jobs:
  security-check:
    runs-on: ubuntu-latest
    steps:
      - run: echo "check"
`.trim();
        const { props } = extract(content);
        expect(props!['hasMergeRequestPipeline']).toBe(true);
    });

    test('is false when only push trigger (no pull_request)', () => {
        const { props } = extract(PUSH_ONLY_WORKFLOW);
        expect(props!['hasMergeRequestPipeline']).toBe(false);
    });

    test('is false for scalar push trigger', () => {
        const { props } = extract(SCALAR_ON_WORKFLOW);
        expect(props!['hasMergeRequestPipeline']).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — job count
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.extract — job count', () => {
    test('counts all jobs in the jobs: map', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['jobCount']).toBe(2); // test, deploy
    });

    test('counts single job', () => {
        const { props } = extract(PUSH_ONLY_WORKFLOW);
        expect(props!['jobCount']).toBe(1);
    });

    test('counts zero jobs for workflow with empty jobs block', () => {
        const content = `
on: push
jobs: {}
`.trim();
        const { props } = extract(content);
        expect(props!['jobCount']).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — reusable workflow includes (uses:)
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.extract — includes (uses refs)', () => {
    test('extracts marketplace action refs from step uses:', () => {
        const { props } = extract(REUSABLE_WORKFLOW);
        expect(props!['includes']).toContain('myorg/shared-actions/build@v2');
    });

    test('does NOT include local actions (starting with ./)', () => {
        const content = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ./local-action
      - uses: actions/checkout@v4
`.trim();
        const { props } = extract(content);
        const includes = props!['includes'] as string;
        expect(includes).not.toContain('./local-action');
        expect(includes).toContain('actions/checkout@v4');
    });

    test('returns empty includes when no uses: steps', () => {
        const { props } = extract(SCALAR_ON_WORKFLOW);
        expect(props!['includes']).toBe('');
    });

    test('deduplicates repeated action refs across multiple jobs', () => {
        const content = `
on: push
jobs:
  job1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  job2:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`.trim();
        const { props } = extract(content);
        const parts = (props!['includes'] as string).split(',').filter(Boolean);
        expect(parts.filter(p => p === 'actions/checkout@v4')).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — environments
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.extract — environments', () => {
    test('extracts scalar environment name', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['environments']).toContain('staging');
    });

    test('extracts object environment name', () => {
        const content = `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: review-app
      url: https://review.example.com
    steps:
      - run: make deploy
`.trim();
        const { props } = extract(content);
        expect(props!['environments']).toContain('review-app');
    });

    test('hasReviewEnvironment is false when only staging/production exist', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['hasReviewEnvironment']).toBe(false);
    });

    test('hasReviewEnvironment is true when environment name contains review', () => {
        const content = `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: review-branch
    steps:
      - run: make deploy
`.trim();
        const { props } = extract(content);
        expect(props!['hasReviewEnvironment']).toBe(true);
    });

    test('returns empty environments string when no environments defined', () => {
        const { props } = extract(SCALAR_ON_WORKFLOW);
        expect(props!['environments']).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — test/deploy stage detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.extract — stage classification', () => {
    test('hasTestStage is true when job is named "test"', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['hasTestStage']).toBe(true);
    });

    test('hasTestStage is true from step name containing "tests"', () => {
        const content = `
on: push
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - name: Run unit tests
        run: make test
`.trim();
        const { props } = extract(content);
        expect(props!['hasTestStage']).toBe(true);
    });

    test('hasTestStage is false when no test-related names', () => {
        const { props } = extract(PUSH_ONLY_WORKFLOW);
        expect(props!['hasTestStage']).toBe(false);
    });

    test('hasDeployStage is true when job is named "deploy"', () => {
        const { props } = extract(PR_WORKFLOW);
        expect(props!['hasDeployStage']).toBe(true);
    });

    test('hasDeployStage is false when only build jobs exist', () => {
        const content = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make build
`.trim();
        const { props } = extract(content);
        expect(props!['hasDeployStage']).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin.extract — error handling', () => {
    test('returns empty entities for malformed YAML', () => {
        const { result } = extract('{ invalid yaml [');
        expect(result.entities).toHaveLength(0);
        expect(result.summary).toContain('parse error');
    });

    test('returns empty entities for empty content', () => {
        const { result } = extract('');
        expect(result.entities).toHaveLength(0);
        expect(result.summary).toContain('empty');
    });

    test('returns empty entities when YAML root is not an object', () => {
        const { result } = extract('- foo\n- bar');
        expect(result.entities).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fixture: notification-service (compliant)
// ═══════════════════════════════════════════════════════════════════════════════

describe('githubActionsPlugin — notification-service fixture (compliant)', () => {
    const fixturePath = path.resolve(
        import.meta.dirname,
        '../../../tests/fixtures/microservices/notification-service/.github/workflows/ci.yml',
    );
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const { props } = extract(content, { repoName: 'order/notification-service' });

    test('workflow name is detected', () => {
        expect(props!['name']).toBe('CI');
    });

    test('hasMergeRequestPipeline is true', () => {
        expect(props!['hasMergeRequestPipeline']).toBe(true);
    });

    test('hasTestStage is true', () => {
        expect(props!['hasTestStage']).toBe(true);
    });

    test('hasDeployStage is true', () => {
        expect(props!['hasDeployStage']).toBe(true);
    });

    test('has staging environment', () => {
        expect(props!['environments']).toContain('staging');
    });

    test('jobCount is 3 (test, lint, deploy)', () => {
        expect(props!['jobCount']).toBe(3);
    });
});
