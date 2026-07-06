import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gitlabCiPlugin } from '../../../src/ingestion/structural/plugins/gitlabci.plugin.js';
import type { PluginContext } from '../../../src/ingestion/structural/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
        relativePath: '.gitlab-ci.yml',
        absolutePath: '/repo/.gitlab-ci.yml',
        basename: '.gitlab-ci.yml',
        repoName: 'acme/order-service',
        ownerService: 'order-service',
        ...overrides,
    };
}

function extract(content: string, ctxOverrides: Partial<PluginContext> = {}) {
    const result = gitlabCiPlugin.extract(content, makeCtx(ctxOverrides));
    return {
        result,
        entity: result.entities[0],
        props: result.entities[0]?.properties,
    };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const COMPLIANT_PIPELINE = `
stages:
  - build
  - test
  - deploy

include:
  - project: 'devops/acme-ci-toolkit'
    ref: main
    file: '/templates/base.yml'

workflow:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == "main"'

build-job:
  stage: build
  script: [make build]

test-unit:
  stage: test
  script: [make test]

deploy-review:
  stage: deploy
  script: [make deploy]
  environment:
    name: review/$CI_COMMIT_REF_NAME
    url: https://review.example.com

deploy-prod:
  stage: deploy
  script: [make deploy-prod]
  environment: production
`.trim();

const NO_TOOLKIT_PIPELINE = `
stages:
  - build
  - deploy

build-job:
  stage: build
  script: [composer install]

deploy-prod:
  stage: deploy
  script: [make deploy]
  environment: production
  only:
    - main
`.trim();

const MINIMAL_PIPELINE = `
build:
  script: [echo "hello"]
`.trim();

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.matchFile', () => {
    test('matches .gitlab-ci.yml at repo root', () => {
        expect(gitlabCiPlugin.matchFile('.gitlab-ci.yml', '.gitlab-ci.yml')).toBe(true);
    });

    test('matches .gitlab-ci.yml in subdirectory', () => {
        expect(gitlabCiPlugin.matchFile('services/api/.gitlab-ci.yml', '.gitlab-ci.yml')).toBe(true);
    });

    test('matches .gitlab-ci.yaml (both extensions accepted)', () => {
        expect(gitlabCiPlugin.matchFile('.gitlab-ci.yaml', '.gitlab-ci.yaml')).toBe(true);
    });

    test('does NOT match github workflows YAML', () => {
        expect(gitlabCiPlugin.matchFile('.github/workflows/ci.yml', 'ci.yml')).toBe(false);
    });

    test('does NOT match arbitrary YAML files', () => {
        expect(gitlabCiPlugin.matchFile('docker-compose.yml', 'docker-compose.yml')).toBe(false);
        expect(gitlabCiPlugin.matchFile('config.yaml', 'config.yaml')).toBe(false);
    });

    test('does NOT match Dockerfile or package.json', () => {
        expect(gitlabCiPlugin.matchFile('Dockerfile', 'Dockerfile')).toBe(false);
        expect(gitlabCiPlugin.matchFile('package.json', 'package.json')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — basic invariants
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — basic invariants', () => {
    test('produces exactly one CIPipeline entity', () => {
        const { result } = extract(COMPLIANT_PIPELINE);
        expect(result.entities).toHaveLength(1);
        expect(result.entities[0]!.labels).toContain('CIPipeline');
    });

    test('entity relationshipType is DEFINES', () => {
        const { entity } = extract(COMPLIANT_PIPELINE);
        expect(entity!.relationshipType).toBe('DEFINES');
    });

    test('managedLabels contains CIPipeline', () => {
        expect(gitlabCiPlugin.managedLabels).toContain('CIPipeline');
    });

    test('URN follows cr:cipipeline:{repoName}:gitlab-ci:{filePath} schema', () => {
        const { entity } = extract(COMPLIANT_PIPELINE);
        expect(entity!.id).toBe('cr:cipipeline:acme/order-service:gitlab-ci:.gitlab-ci.yml');
    });

    test('tool property is always gitlab-ci', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['tool']).toBe('gitlab-ci');
    });

    test('_sourcePath matches relativePath', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['_sourcePath']).toBe('.gitlab-ci.yml');
    });

    test('_ownerService is propagated from context', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['_ownerService']).toBe('order-service');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — stages
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — stages', () => {
    test('extracts declared stages as comma-separated string', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['stages']).toBe('build,test,deploy');
    });

    test('falls back to GitLab defaults when stages is absent', () => {
        const { props } = extract(MINIMAL_PIPELINE);
        // Default GitLab stages: .pre, build, test, deploy, .post
        expect(props!['stages']).toContain('build');
        expect(props!['stages']).toContain('test');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — job count
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — job count', () => {
    test('counts only job keys (excludes reserved keywords)', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        // Jobs: build-job, test-unit, deploy-review, deploy-prod = 4
        expect(props!['jobCount']).toBe(4);
    });

    test('counts single job in minimal pipeline', () => {
        const { props } = extract(MINIMAL_PIPELINE);
        expect(props!['jobCount']).toBe(1);
    });

    test('excludes reserved keys: stages, variables, workflow, include, default, image, services, cache, before_script, after_script', () => {
        const content = `
stages: [test]
variables:
  FOO: bar
workflow:
  rules: []
include: []
default:
  image: alpine
build:
  script: [echo "job"]
`.trim();
        const { props } = extract(content);
        expect(props!['jobCount']).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — includes
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — includes', () => {
    test('extracts project: include ref', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['includes']).toContain('devops/acme-ci-toolkit');
    });

    test('extracts local: include ref', () => {
        const content = `
include:
  - local: '/templates/base.yml'
build:
  script: [echo]
`.trim();
        const { props } = extract(content);
        expect(props!['includes']).toContain('/templates/base.yml');
    });

    test('extracts remote: include ref', () => {
        const content = `
include:
  - remote: 'https://example.com/ci-templates/base.yml'
build:
  script: [echo]
`.trim();
        const { props } = extract(content);
        expect(props!['includes']).toContain('https://example.com/ci-templates/base.yml');
    });

    test('extracts template: include ref', () => {
        const content = `
include:
  - template: 'Security/SAST.gitlab-ci.yml'
build:
  script: [echo]
`.trim();
        const { props } = extract(content);
        expect(props!['includes']).toContain('Security/SAST.gitlab-ci.yml');
    });

    test('extracts component: include ref (GitLab 16.0+)', () => {
        const content = `
include:
  - component: 'gitlab.com/devops/ci-components/sast@v1.2'
build:
  script: [echo]
`.trim();
        const { props } = extract(content);
        expect(props!['includes']).toContain('gitlab.com/devops/ci-components/sast@v1.2');
    });

    test('handles scalar string include (not array)', () => {
        const content = `
include: '/templates/base.yml'
build:
  script: [echo]
`.trim();
        const { props } = extract(content);
        expect(props!['includes']).toContain('/templates/base.yml');
    });

    test('returns empty string when no includes block', () => {
        const { props } = extract(NO_TOOLKIT_PIPELINE);
        expect(props!['includes']).toBe('');
    });

    test('comma-separates multiple includes', () => {
        const content = `
include:
  - project: 'devops/toolkit'
  - local: '/templates/sast.yml'
build:
  script: [echo]
`.trim();
        const { props } = extract(content);
        const parts = (props!['includes'] as string).split(',');
        expect(parts).toContain('devops/toolkit');
        expect(parts).toContain('/templates/sast.yml');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — MR pipeline detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — hasMergeRequestPipeline', () => {
    test('is true when pipeline uses merge_request_event source', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['hasMergeRequestPipeline']).toBe(true);
    });

    test('is true when $CI_MERGE_REQUEST_IID is referenced', () => {
        const content = `
build:
  script: [echo $CI_MERGE_REQUEST_IID]
`.trim();
        const { props } = extract(content);
        expect(props!['hasMergeRequestPipeline']).toBe(true);
    });

    test('is false when pipeline only runs on main branch push', () => {
        const { props } = extract(NO_TOOLKIT_PIPELINE);
        expect(props!['hasMergeRequestPipeline']).toBe(false);
    });

    test('is false for minimal pipeline with no workflow rules', () => {
        const { props } = extract(MINIMAL_PIPELINE);
        expect(props!['hasMergeRequestPipeline']).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — test/deploy stage detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — stage classification', () => {
    test('hasTestStage is true when test stage is declared', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['hasTestStage']).toBe(true);
    });

    test('hasTestStage is true based on job name containing "lint"', () => {
        const content = `
build:
  script: [make build]
lint:
  script: [make lint]
`.trim();
        const { props } = extract(content);
        expect(props!['hasTestStage']).toBe(true);
    });

    test('hasTestStage is false when no test-related stage or job name exists', () => {
        const { props } = extract(NO_TOOLKIT_PIPELINE);
        expect(props!['hasTestStage']).toBe(false);
    });

    test('hasDeployStage is true when deploy stage is declared', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['hasDeployStage']).toBe(true);
    });

    test('hasDeployStage is true based on job name containing "release"', () => {
        const content = `
release-production:
  script: [make release]
`.trim();
        const { props } = extract(content);
        expect(props!['hasDeployStage']).toBe(true);
    });

    test('hasDeployStage is false for build-only pipeline', () => {
        const content = `
stages: [build]
build-job:
  stage: build
  script: [make build]
`.trim();
        const { props } = extract(content);
        expect(props!['hasDeployStage']).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — environments
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — environments', () => {
    test('extracts scalar environment name', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['environments']).toContain('production');
    });

    test('extracts object environment name', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['environments']).toContain('review/$CI_COMMIT_REF_NAME');
    });

    test('hasReviewEnvironment is true when environment name contains "review"', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['hasReviewEnvironment']).toBe(true);
    });

    test('hasReviewEnvironment is false when only production environment exists', () => {
        const { props } = extract(NO_TOOLKIT_PIPELINE);
        expect(props!['hasReviewEnvironment']).toBe(false);
    });

    test('deduplicates environments across multiple jobs', () => {
        const content = `
deploy-a:
  script: [echo]
  environment: production
deploy-b:
  script: [echo]
  environment: production
`.trim();
        const { props } = extract(content);
        const envs = (props!['environments'] as string).split(',').filter(Boolean);
        expect(envs.filter(e => e === 'production')).toHaveLength(1);
    });

    test('returns empty string when no environments defined', () => {
        const { props } = extract(MINIMAL_PIPELINE);
        expect(props!['environments']).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — error handling', () => {
    test('returns empty entities for malformed YAML', () => {
        const { result } = extract('{ invalid: yaml: content: [');
        expect(result.entities).toHaveLength(0);
        expect(result.summary).toContain('parse error');
    });

    test('returns empty entities for empty file', () => {
        const { result } = extract('');
        expect(result.entities).toHaveLength(0);
        expect(result.summary).toContain('empty');
    });

    test('returns empty entities when YAML root is not an object', () => {
        const { result } = extract('- item1\n- item2');
        expect(result.entities).toHaveLength(0);
    });

    test('parses YAML with GitLab-specific !reference tags without crashing', () => {
        const content = `
include:
  - project: "acme/devops-hat"
    file: "src/.gitlab-ci-v3.yml"
  - "/.ci/.custom-variables.yml"

"Build Dependencies":
  stage: Dependencies
  interruptible: true
  extends:
    - .custom_variables
  rules:
    - !reference [.skip_job_if_flag_is_true, rules]
    - !reference [.not_in_release_branch, rules]
    - when: on_success
  script:
    - npm ci
    - npm run build

"Test":
  extends:
    - .test_npm
  rules:
    - !reference [.skip_job_if_flag_is_true, rules]
  script:
    - npm run test:ci

"Deploy Review":
  extends:
    - .deploy_review
  environment:
    name: review
    url: https://review.example.com
    auto_stop_in: 5 days

"Deploy Production":
  extends:
    - .deploy_production
  environment:
    name: production
    url: https://prod.example.com
`.trim();
        const { result, props } = extract(content);
        expect(result.entities).toHaveLength(1);
        expect(props!['jobCount']).toBe(4);
        expect(props!['includes']).toContain('acme/devops-hat');
        expect(props!['hasTestStage']).toBe(true);
        expect(props!['hasDeployStage']).toBe(true);
        expect(props!['environments']).toContain('production');
        expect(props!['environments']).toContain('review');
    });

    test('parses YAML with merge keys (<<: *anchor) without crashing', () => {
        const content = `
stages:
  - Build
  - Deploy

.trigger_variables: &trigger_variables
  STANDARD_SHIPPING_HOST_NAME: "standard-shipping-feature"
  ENABLE_ACME: "false"

"Build App":
  stage: Build
  script: [npm ci]

"E2E Trigger Feature":
  stage: Deploy
  variables:
    <<: *trigger_variables
    ENABLE_ACME: "true"
  script: [echo "trigger"]
  environment: staging
`.trim();
        const { result, props } = extract(content);
        expect(result.entities).toHaveLength(1);
        expect(props!['jobCount']).toBe(3);
        expect(props!['hasDeployStage']).toBe(true);
        expect(props!['environments']).toContain('staging');
    });

    test('parses complex real-world GitLab CI with quoted job names, extends, and multiple environments', () => {
        const content = `
stages:
  - Test
  - Build
  - Deploy
  - Post-deploy

variables:
  DOCKER_DRIVER: overlay2

cache:
  paths:
    - vendor/

before_script:
  - cp docker-compose.override.gitlab.yml docker-compose.override.yml

"Unit Tests":
  stage: Test
  script: [make test-unit]

"Functional Tests":
  stage: Test
  tags:
    - xlarge
  script: [make test-functional]

include:
  - local: ci/build-docker.yml
  - local: ci/deploy-backend.yml
  - local: ci/post-deploy.yml
`.trim();
        const { result, props } = extract(content);
        expect(result.entities).toHaveLength(1);
        expect(props!['jobCount']).toBe(2);
        expect(props!['stages']).toBe('Test,Build,Deploy,Post-deploy');
        expect(props!['hasTestStage']).toBe(true);
        expect(props!['includes']).toContain('ci/build-docker.yml');
        expect(props!['includes']).toContain('ci/deploy-backend.yml');
    });

    test('parses YAML with mixed !reference and regular rules in same job', () => {
        const content = `
"Deploy Canary":
  extends:
    - .deploy_canary
  rules:
    - !reference [.not_on_release_branch_merge, rules]
    - !reference [.only_master_rules_manual, rules]
  allow_failure: true
  environment: canary
  script: [make deploy-canary]

"Stop Review":
  extends:
    - .stop_review
  environment:
    name: review-env
    action: stop
  script: [make stop]
`.trim();
        const { result, props } = extract(content);
        expect(result.entities).toHaveLength(1);
        expect(props!['jobCount']).toBe(2);
        expect(props!['environments']).toContain('canary');
        expect(props!['environments']).toContain('review-env');
        expect(props!['hasReviewEnvironment']).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — triggers
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — triggers', () => {
    test('detects push trigger from CI_COMMIT_BRANCH reference', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['triggers']).toContain('push');
    });

    test('detects merge_request trigger', () => {
        const { props } = extract(COMPLIANT_PIPELINE);
        expect(props!['triggers']).toContain('merge_request');
    });

    test('detects schedule trigger', () => {
        const content = `
build:
  script: [make build]
  only:
    variables:
      - $CI_PIPELINE_SOURCE == "schedule"
`.trim();
        const { props } = extract(content);
        expect(props!['triggers']).toContain('schedule');
    });

    test('detects tag trigger from CI_COMMIT_TAG reference', () => {
        const content = `
deploy-prod:
  stage: deploy
  script: [make deploy]
  rules:
    - if: $CI_COMMIT_TAG
`.trim();
        const { props } = extract(content);
        expect(props!['triggers']).toContain('tag');
    });

    test('does NOT add tag trigger when CI_COMMIT_TAG is absent', () => {
        const content = `
build:
  script: [make build]
`.trim();
        const { props } = extract(content);
        expect(props!['triggers']).not.toContain('tag');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — scriptTokens
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — scriptTokens', () => {
    test('collects unique first-words from all script: lines', () => {
        const content = `
build:
  before_script: [yarn install]
  script:
    - yarn run build
    - yarn run test
test:
  script: [npm test]
`.trim();
        const { props } = extract(content);
        const tokens = (props!['scriptTokens'] as string).split(',').filter(Boolean);
        expect(tokens).toContain('yarn');
        expect(tokens).toContain('npm');
        // 'yarn' should appear once despite multiple occurrences
        expect(tokens.filter(t => t === 'yarn')).toHaveLength(1);
    });

    test('strips env-var prefixes like FOO=bar before the command', () => {
        const content = `
job:
  script:
    - NODE_ENV=production yarn build
`.trim();
        const { props } = extract(content);
        const tokens = (props!['scriptTokens'] as string).split(',').filter(Boolean);
        expect(tokens).toContain('yarn');
        expect(tokens).not.toContain('NODE_ENV=production');
    });

    test('skips comment-only and blank lines', () => {
        const content = `
job:
  script:
    - "# just a comment"
    - ""
    - make build
`.trim();
        const { props } = extract(content);
        const tokens = (props!['scriptTokens'] as string).split(',').filter(Boolean);
        expect(tokens).toEqual(['make']);
    });

    test('captures tokens from before_script and after_script too', () => {
        const content = `
job:
  before_script: [bash setup.sh]
  script: [echo main]
  after_script: [cleanup.sh]
`.trim();
        const { props } = extract(content);
        const tokens = (props!['scriptTokens'] as string).split(',').filter(Boolean);
        expect(tokens.sort()).toEqual(['bash', 'cleanup.sh', 'echo'].sort());
    });

    test('returns empty scriptTokens for pipeline with no script blocks', () => {
        const content = `
stages: [build]
`.trim();
        const { props } = extract(content);
        expect(props!['scriptTokens']).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — GitLab Components (include: - component:)
// ═══════════════════════════════════════════════════════════════════════════════

describe('gitlabCiPlugin.extract — CI Components (GitLab)', () => {
    test('emits a CIComponent entity per declared component: with tool=gitlab-ci', () => {
        const content = `
include:
  - component: gitlab.example.com/components/node/runner@main
    inputs:
      stage: test
      node_version: "20-alpine"
build:
  script: [make build]
`.trim();
        const { result } = extract(content);
        const components = result.entities.filter(e => e.labels[0] === 'CIComponent');
        expect(components).toHaveLength(1);
        const c = components[0];
        expect(c.id).toBe('cr:cicomponent:gitlab-ci:gitlab.example.com:components/node:runner@main');
        expect(c.properties.tool).toBe('gitlab-ci');
        expect(c.properties.host).toBe('gitlab.example.com');
        expect(c.properties.projectPath).toBe('components/node');
        expect(c.properties.name).toBe('runner');
        expect(c.properties.ref).toBe('main');
        expect(c.properties.templateUrl).toBe(
            'https://gitlab.example.com/components/node/-/raw/main/templates/runner/template.yml',
        );
        expect(c.properties.fetchStatus).toBe('skipped');
        expect(c.relationshipType).toBe('INCLUDES_COMPONENT');
    });

    test('serializes inputs map as JSON on the component node', () => {
        const content = `
include:
  - component: gitlab.example.com/c/n/r@main
    inputs:
      stage: deploy
      env: prod
`.trim();
        const { result } = extract(content);
        const components = result.entities.filter(e => e.labels[0] === 'CIComponent');
        expect(components[0].properties.inputsJson).toBe('{"stage":"deploy","env":"prod"}');
    });

    test('does NOT emit components for non-component includes', () => {
        const content = `
include:
  - project: 'devops/acme-ci-toolkit'
    ref: main
    file: '/templates/base.yml'
  - local: '/templates/local.yml'
  - remote: 'https://example.com/ci.yml'
`.trim();
        const { result } = extract(content);
        const components = result.entities.filter(e => e.labels[0] === 'CIComponent');
        expect(components).toHaveLength(0);
    });

    test('deduplicates the same component declared twice', () => {
        const content = `
include:
  - component: gitlab.example.com/c/n/r@main
  - component: gitlab.example.com/c/n/r@main
`.trim();
        const { result } = extract(content);
        const components = result.entities.filter(e => e.labels[0] === 'CIComponent');
        expect(components).toHaveLength(1);
    });

    test('emits separate nodes for different refs of the same component', () => {
        const content = `
include:
  - component: gitlab.example.com/c/n/r@v1
  - component: gitlab.example.com/c/n/r@v2
`.trim();
        const { result } = extract(content);
        const components = result.entities.filter(e => e.labels[0] === 'CIComponent');
        expect(components).toHaveLength(2);
        const refs = components.map(c => c.properties.ref).sort();
        expect(refs).toEqual(['v1', 'v2']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fixture: order-service (compliant)
// ═══════════════════════════════════════════════════════════════════════════════

const ORDER_FIXTURE_PATH = path.resolve(
    import.meta.dirname,
    '../../../tests/fixtures/microservices/order-service/.gitlab-ci.yml',
);
const ORDER_FIXTURE_CONTENT = fs.readFileSync(ORDER_FIXTURE_PATH, 'utf-8');
const ORDER_FIXTURE_PROPS = extract(ORDER_FIXTURE_CONTENT, { repoName: 'order/order-service' }).props;

describe('gitlabCiPlugin — order-service fixture (compliant)', () => {

    test('detects toolkit include', () => {
        expect(ORDER_FIXTURE_PROPS!['includes']).toContain('acme-ci-toolkit');
    });

    test('hasMergeRequestPipeline is true', () => {
        expect(ORDER_FIXTURE_PROPS!['hasMergeRequestPipeline']).toBe(true);
    });

    test('hasTestStage is true', () => {
        expect(ORDER_FIXTURE_PROPS!['hasTestStage']).toBe(true);
    });

    test('hasReviewEnvironment is true', () => {
        expect(ORDER_FIXTURE_PROPS!['hasReviewEnvironment']).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fixture: payment-service (non-compliant)
// ═══════════════════════════════════════════════════════════════════════════════

const PAYMENT_FIXTURE_PATH = path.resolve(
    import.meta.dirname,
    '../../../tests/fixtures/microservices/payment-service/.gitlab-ci.yml',
);
const PAYMENT_FIXTURE_CONTENT = fs.readFileSync(PAYMENT_FIXTURE_PATH, 'utf-8');
const PAYMENT_FIXTURE_PROPS = extract(PAYMENT_FIXTURE_CONTENT, { repoName: 'order/payment-service' }).props;

describe('gitlabCiPlugin — payment-service fixture (non-compliant)', () => {
    test('includes is empty (no toolkit)', () => {
        expect(PAYMENT_FIXTURE_PROPS!['includes']).toBe('');
    });

    test('hasMergeRequestPipeline is false', () => {
        expect(PAYMENT_FIXTURE_PROPS!['hasMergeRequestPipeline']).toBe(false);
    });

    test('hasTestStage is false', () => {
        expect(PAYMENT_FIXTURE_PROPS!['hasTestStage']).toBe(false);
    });
});
