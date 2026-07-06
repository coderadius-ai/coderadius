import { describe, test, expect, vi, beforeEach } from 'vitest';
import { containerImagePlugin } from '../../../src/ingestion/structural/plugins/container-image.plugin.js';
import type { PluginContext } from '../../../src/ingestion/structural/types.js';

// ─── Mock fs for Helm values resolution (we don't want disk I/O in tests) ────
vi.mock('node:fs', () => ({
    default: {
        readFileSync: vi.fn(() => ''),
        existsSync: vi.fn(() => false),
    },
}));

// ─── Shared test context ──────────────────────────────────────────────────────

function makeCtx(relativePath: string): PluginContext {
    return {
        relativePath,
        absolutePath: `/repo/${relativePath}`,
        repoName: 'acme/my-service',
        repoUrn: 'cr:repository:acme/my-service',
        ownerService: 'my-service',
        scopeManager: { isPathAllowed: () => true } as any,
    };
}

function extract(content: string, relativePath = 'docker-compose.yml') {
    return containerImagePlugin.extract(content, makeCtx(relativePath));
}

function entities(content: string, relativePath = 'docker-compose.yml') {
    return extract(content, relativePath).entities;
}

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('containerImagePlugin.matchFile', () => {
    test('matches docker-compose.yml', () => {
        expect(containerImagePlugin.matchFile('docker-compose.yml', 'docker-compose.yml')).toBe(true);
    });

    test('matches docker-compose.prod.yml', () => {
        expect(containerImagePlugin.matchFile('docker-compose.prod.yml', 'docker-compose.prod.yml')).toBe(true);
    });

    test('matches values.yaml in helm dir', () => {
        expect(containerImagePlugin.matchFile('charts/my-svc/values.yaml', 'values.yaml')).toBe(true);
    });

    test('matches k8s deployment.yaml', () => {
        expect(containerImagePlugin.matchFile('k8s/deployment.yaml', 'deployment.yaml')).toBe(true);
    });

    test('does NOT match .gitlab-ci.yml', () => {
        expect(containerImagePlugin.matchFile('.gitlab-ci.yml', '.gitlab-ci.yml')).toBe(false);
    });

    test('does NOT match GitHub Actions workflow', () => {
        expect(containerImagePlugin.matchFile('.github/workflows/ci.yml', 'ci.yml')).toBe(false);
    });

    test('does NOT match coderadius.yaml', () => {
        expect(containerImagePlugin.matchFile('coderadius.yaml', 'coderadius.yaml')).toBe(false);
    });

    test('does NOT match renovate config', () => {
        expect(containerImagePlugin.matchFile('.renovaterc.yaml', '.renovaterc.yaml')).toBe(false);
    });

    test('does NOT match Dockerfile', () => {
        expect(containerImagePlugin.matchFile('Dockerfile', 'Dockerfile')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Docker Compose extraction
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docker Compose extraction', () => {
    test('single service with image', () => {
        const content = `
services:
  db:
    image: postgres:15
`.trim();
        const result = entities(content);
        expect(result).toHaveLength(1);
        expect(result[0]!.properties.name).toBe('postgres');
        expect(result[0]!.properties.tag).toBe('15');
        expect(result[0]!.relationshipType).toBe('USES_IMAGE');
        expect(result[0]!.relationshipProperties).toEqual({ context: 'infrastructure', scope: 'unknown' });
    });

    test('multiple services with images', () => {
        const content = `
services:
  db:
    image: postgres:15
  cache:
    image: redis:7-alpine
  web:
    build: .
`.trim();
        const result = entities(content);
        expect(result).toHaveLength(2);
        expect(result.map(e => e.properties.name)).toContain('postgres');
        expect(result.map(e => e.properties.name)).toContain('redis');
    });

    test('production scope from filename', () => {
        const content = `
services:
  db:
    image: postgres:15
`.trim();
        const result = entities(content, 'docker-compose.prod.yml');
        expect(result[0]!.relationshipProperties!.scope).toBe('production');
    });

    test('development scope from override filename', () => {
        const content = `
services:
  debug:
    image: busybox:latest
`.trim();
        const result = entities(content, 'docker-compose.override.yml');
        expect(result[0]!.relationshipProperties!.scope).toBe('development');
    });

    test('service without image (build only) is skipped', () => {
        const content = `
services:
  app:
    build: .
    ports:
      - 3000:3000
`.trim();
        const result = entities(content);
        expect(result).toHaveLength(0);
    });

    test('same image in two services is deduplicated (TG-2)', () => {
        const content = `
services:
  primary:
    image: postgres:15
  replica:
    image: postgres:15
`.trim();
        const result = entities(content);
        expect(result).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Kubernetes extraction
// ═══════════════════════════════════════════════════════════════════════════════

describe('Kubernetes workload extraction', () => {
    test('Deployment with single container', () => {
        const content = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: node:20-alpine
`.trim();
        const result = entities(content, 'k8s/deployment.yaml');
        expect(result).toHaveLength(1);
        expect(result[0]!.properties.name).toBe('node');
        expect(result[0]!.properties.tag).toBe('20-alpine');
    });

    test('Deployment with initContainers', () => {
        const content = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      initContainers:
        - name: migrate
          image: flyway/flyway:10
      containers:
        - name: app
          image: node:20-alpine
`.trim();
        const result = entities(content, 'k8s/deployment.yaml');
        expect(result).toHaveLength(2);
        expect(result.map(e => e.properties.name)).toContain('flyway/flyway');
        expect(result.map(e => e.properties.name)).toContain('node');
    });

    test('StatefulSet is recognized', () => {
        const content = `
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:15
`.trim();
        const result = entities(content, 'k8s/statefulset.yaml');
        expect(result).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Helm values extraction
// ═══════════════════════════════════════════════════════════════════════════════

describe('Helm values extraction', () => {
    test('simple image string in values', () => {
        const content = `
image: nginx:stable
replicas: 3
`.trim();
        const result = entities(content, 'charts/my-svc/values.yaml');
        expect(result).toHaveLength(1);
        expect(result[0]!.properties.name).toBe('nginx');
        expect(result[0]!.properties.tag).toBe('stable');
    });

    test('nested image object with repository + tag', () => {
        const content = `
image:
  repository: nginx
  tag: stable
  pullPolicy: IfNotPresent
`.trim();
        const result = entities(content, 'charts/my-svc/values.yaml');
        expect(result).toHaveLength(1);
        expect(result[0]!.properties.name).toBe('nginx');
        expect(result[0]!.properties.tag).toBe('stable');
    });

    test('deeply nested image under service key', () => {
        const content = `
frontend:
  image:
    repository: react-app
    tag: v2.1.0
backend:
  image:
    repository: api-server
    tag: v3.0.1
`.trim();
        const result = entities(content, 'charts/my-app/values.yaml');
        expect(result).toHaveLength(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TG-3: Unresolved variable filtering
// ═══════════════════════════════════════════════════════════════════════════════

describe('unresolved variable filtering (TG-3)', () => {
    test('image with shell variable is dropped', () => {
        const content = `
services:
  db:
    image: postgres:$POSTGRES_VERSION
`.trim();
        const result = entities(content);
        expect(result).toHaveLength(0);
    });

    test('image with ${} variable is dropped', () => {
        const content = `
services:
  app:
    image: \${REGISTRY}/app:\${TAG}
`.trim();
        const result = entities(content);
        expect(result).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Non-matching files
// ═══════════════════════════════════════════════════════════════════════════════

describe('non-matching files', () => {
    test('YAML without services/kind/values returns empty', () => {
        const content = `
name: my-config
settings:
  timeout: 30
  image: some-value
`.trim();
        const result = extract(content, 'config.yaml');
        expect(result.entities).toHaveLength(0);
    });

    test('empty YAML returns empty', () => {
        expect(extract('---\n', 'docker-compose.yml').entities).toHaveLength(0);
    });

    test('malformed YAML returns empty', () => {
        expect(extract('{{{{{{', 'docker-compose.yml').entities).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// URN generation
// ═══════════════════════════════════════════════════════════════════════════════

describe('URN generation', () => {
    test('follows cr:dockerimage:{name}:{tag} schema', () => {
        const content = `
services:
  db:
    image: myregistry.com/org/postgres:15-alpine
`.trim();
        const result = entities(content);
        expect(result[0]!.id).toBe('cr:dockerimage:myregistry.com/org/postgres:15-alpine');
    });
});
