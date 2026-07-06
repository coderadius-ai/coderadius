import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// Unit Tests: backstage-extractor.ts (pure discovery)
// ═══════════════════════════════════════════════════════════════════════════════

vi.mock('glob', () => ({
    glob: vi.fn(),
}));

vi.mock('node:fs', () => ({
    default: {
        readFileSync: vi.fn(),
        existsSync: vi.fn(),
    },
}));

import { discoverBackstageComponents } from '../../../../src/ingestion/extractors/backstage-extractor.js';
import { glob } from 'glob';
import fs from 'node:fs';

const mockGlob = vi.mocked(glob);
const mockReadFileSync = vi.mocked(fs.readFileSync);

describe('discoverBackstageComponents', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('discovers Components and maps to DiscoveredComponent format', async () => {
        mockGlob.mockResolvedValue(['/repo/api/catalog-info.yaml'] as any);
        mockReadFileSync.mockReturnValue(`apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-api
  description: The main API
spec:
  type: service
  lifecycle: production
  owner: group:default/team-platform
  system: core-system
  dependsOn:
    - component:default/helper-lib
    - component:external-svc`);

        const result = await discoverBackstageComponents([{ name: 'my-repo', path: '/repo' }]);

        expect(result.components).toHaveLength(1);
        const comp = result.components[0];
        expect(comp.name).toBe('my-api');
        expect(comp.description).toBe('The main API');
        expect(comp.owner).toBe('team-platform');
        expect(comp.system).toBe('core-system');
        expect(comp.dependsOn).toEqual(['helper-lib', 'external-svc']);
        expect(comp.source).toBe('backstage');
    });

    it('discovers System and Domain as auxiliary entities', async () => {
        mockGlob.mockResolvedValue(['/repo/catalog-info.yaml'] as any);
        mockReadFileSync.mockReturnValue(`apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: core-system
  description: The core system
spec:
  domain: commerce`);

        const result = await discoverBackstageComponents([{ name: 'my-repo', path: '/repo' }]);

        expect(result.components).toHaveLength(0);
        expect(result.auxiliaryEntities).toHaveLength(1);
        expect(result.auxiliaryEntities[0]).toEqual({
            kind: 'System',
            name: 'core-system',
            description: 'The core system',
            domain: 'commerce',
        });
    });

    it('skips Scaffolder templates with Nunjucks markers', async () => {
        mockGlob.mockResolvedValue(['/repo/template.yaml'] as any);
        mockReadFileSync.mockReturnValue(`apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: \${{ values.name }}
spec:
  type: service`);

        const result = await discoverBackstageComponents([{ name: 'my-repo', path: '/repo' }]);
        expect(result.components).toHaveLength(0);
    });

    it('parses metadata.links into DiscoveredComponent.links', async () => {
        mockGlob.mockResolvedValue(['/repo/catalog-info.yaml'] as any);
        mockReadFileSync.mockReturnValue(`apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: orders-api
  links:
    - url: https://acme.atlassian.net/jira/software/c/projects/ORD/boards/3
      title: Jira Board
      icon: dashboard
    - url: https://slack.com/app_redirect?channel=alerts-orders
      title: '#alerts-orders'
      icon: slack
spec:
  type: service
  owner: group:default/team-orders`);

        const result = await discoverBackstageComponents([{ name: 'my-repo', path: '/repo' }]);

        expect(result.components).toHaveLength(1);
        const comp = result.components[0];
        expect(comp.links).toHaveLength(2);
        expect(comp.links?.[0]).toEqual({
            url: 'https://acme.atlassian.net/jira/software/c/projects/ORD/boards/3',
            title: 'Jira Board',
            icon: 'dashboard',
            type: undefined,
        });
        expect(comp.links?.[1]).toEqual({
            url: 'https://slack.com/app_redirect?channel=alerts-orders',
            title: '#alerts-orders',
            icon: 'slack',
            type: undefined,
        });
    });

    it('handles missing metadata.links gracefully (undefined)', async () => {
        mockGlob.mockResolvedValue(['/repo/catalog-info.yaml'] as any);
        mockReadFileSync.mockReturnValue(`apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: minimal-svc
spec:
  type: service`);

        const result = await discoverBackstageComponents([{ name: 'my-repo', path: '/repo' }]);
        expect(result.components).toHaveLength(1);
        expect(result.components[0].links).toBeUndefined();
    });

    it('extracts catalogMeta with providesApis, consumesApis, lifecycle', async () => {
        mockGlob.mockResolvedValue(['/repo/catalog-info.yaml'] as any);
        mockReadFileSync.mockReturnValue(`apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: orders-api
  namespace: acme
  labels:
    tier: critical
    team: commerce
  tags:
    - typescript
    - grpc
  links:
    - url: https://acme.com/docs
      title: Docs
spec:
  type: service
  lifecycle: production
  owner: group:default/team-orders
  system: ecommerce
  providesApis:
    - api:default/orders-rest
    - api:acme/orders-grpc
  consumesApis:
    - api:default/payments-api`);

        const result = await discoverBackstageComponents([{ name: 'my-repo', path: '/repo' }]);
        expect(result.components).toHaveLength(1);
        const meta = result.components[0].catalogMeta;
        expect(meta).toBeDefined();
        expect(meta!.kind).toBe('Component');
        expect(meta!.namespace).toBe('acme');
        expect(meta!.entityRef).toBe('component:acme/orders-api');
        expect(meta!.lifecycle).toBe('production');
        expect(meta!.providesApis).toEqual(['orders-rest', 'orders-grpc']);
        expect(meta!.consumesApis).toEqual(['payments-api']);
        expect(meta!.labels).toEqual({ tier: 'critical', team: 'commerce' });
        expect(meta!.tags).toEqual(['typescript', 'grpc']);
        expect(meta!.links).toHaveLength(1);
        expect(meta!.links![0].url).toBe('https://acme.com/docs');
    });

    it('defaults namespace to "default" when not specified', async () => {
        mockGlob.mockResolvedValue(['/repo/catalog-info.yaml'] as any);
        mockReadFileSync.mockReturnValue(`apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: simple-svc
spec:
  type: service`);

        const result = await discoverBackstageComponents([{ name: 'my-repo', path: '/repo' }]);
        const meta = result.components[0].catalogMeta;
        expect(meta!.namespace).toBe('default');
        expect(meta!.entityRef).toBe('component:default/simple-svc');
    });

    it('builds residual specJson excluding first-class fields', async () => {
        mockGlob.mockResolvedValue(['/repo/catalog-info.yaml'] as any);
        mockReadFileSync.mockReturnValue(`apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: custom-svc
spec:
  type: service
  owner: team-platform
  lifecycle: production
  subcomponentOf: parent-svc`);

        const result = await discoverBackstageComponents([{ name: 'my-repo', path: '/repo' }]);
        const meta = result.components[0].catalogMeta;
        expect(meta!.specJson).toBeDefined();
        const residual = JSON.parse(meta!.specJson!);
        expect(residual.subcomponentOf).toBe('parent-svc');
        expect(residual.type).toBeUndefined();
        expect(residual.owner).toBeUndefined();
        expect(residual.lifecycle).toBeUndefined();
    });
});
