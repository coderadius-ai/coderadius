import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crossplanePubsubPlugin } from '../../../../src/ingestion/structural/plugins/contrib/crossplane-pubsub.plugin.js';
import type { PluginContext } from '../../../../src/ingestion/structural/types.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';
import { clearRepoHintsCache } from '../../../../src/config/repo-hints.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ═════════════════════════════════════════════════════════════════════════════
// Crossplane PubSub Plugin — Unit Tests
//
// All fixtures use anonymized e-commerce domain names (PaymentService, etc.)
// ═════════════════════════════════════════════════════════════════════════════

function makeContext(relativePath: string, absolutePath: string): PluginContext {
    return {
        relativePath,
        absolutePath,
        repoName: 'acme/payment-service',
        repoUrn: 'cr:repository:acme/payment-service',
        scopeManager: new ScopeManager(path.dirname(absolutePath)),
    };
}

// ── matchFile ────────────────────────────────────────────────────────────────

describe('crossplane-pubsub — matchFile', () => {
    it('should match .charts/templates/*.yaml', () => {
        expect(crossplanePubsubPlugin.matchFile('.charts/templates/topic.yaml', 'topic.yaml')).toBe(true);
    });

    it('should match charts/templates/*.yaml', () => {
        expect(crossplanePubsubPlugin.matchFile('charts/templates/subscription.yaml', 'subscription.yaml')).toBe(true);
    });

    it('should match helm/templates/*.yml', () => {
        expect(crossplanePubsubPlugin.matchFile('helm/templates/claim.yml', 'claim.yml')).toBe(true);
    });

    it('should match nested chart paths like charts/my-svc/templates/*.yaml', () => {
        expect(crossplanePubsubPlugin.matchFile('charts/my-svc/templates/topic.yaml', 'topic.yaml')).toBe(true);
    });

    it('should match non-template YAML files (duck typing)', () => {
        expect(crossplanePubsubPlugin.matchFile('config/services.yaml', 'services.yaml')).toBe(true);
    });

    it('should match values.yaml (duck typing)', () => {
        expect(crossplanePubsubPlugin.matchFile('.charts/values.yaml', 'values.yaml')).toBe(true);
    });

    it('should NOT match non-YAML files', () => {
        expect(crossplanePubsubPlugin.matchFile('.charts/templates/README.md', 'README.md')).toBe(false);
    });
});

// ── extract — Topic Claim ────────────────────────────────────────────────────

describe('crossplane-pubsub — extract TopicClaim', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pubsub-test-'));
    });

    it('should extract a topic MessageChannel from a TopicClaim template', () => {
        // Create values.yaml
        const valuesDir = path.join(tmpDir, '.charts');
        const templatesDir = path.join(valuesDir, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(valuesDir, 'values.yaml'), `
global:
  configuration:
    TOPIC_NAME: Platform-PaymentCompleted
    GOOGLE_CLOUD_PROJECT: acme-platform
`);

        const templatePath = path.join(templatesDir, 'topic.yaml');
        const content = `apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicClaim
metadata:
  name: {{ $.Release.Name }}-{{ $.Values.global.configuration.TOPIC_NAME | lower }}
spec:
  projectId: {{ $.Values.global.configuration.GOOGLE_CLOUD_PROJECT }}
  topicId: {{ $.Values.global.configuration.TOPIC_NAME }}`;

        const ctx = makeContext('.charts/templates/topic.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);

        expect(result.entities).toHaveLength(1);
        const topic = result.entities[0];
        expect(topic.labels).toEqual(['MessageChannel']);
        expect(topic.properties.name).toBe('Platform-PaymentCompleted');
        expect(topic.properties.channelKind).toBe('topic');
        expect(topic.properties.technology).toBe('pubsub');
        expect(topic.properties.discoverySource).toBe('crossplane');
        expect(topic.id).toBe('cr:channel:topic:Platform-PaymentCompleted');
    });

    it('should create PROVISIONS edge from Service to Topic when ownerService is set', () => {
        const valuesDir = path.join(tmpDir, '.charts');
        const templatesDir = path.join(valuesDir, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(valuesDir, 'values.yaml'), `
global:
  configuration:
    TOPIC_NAME: Platform-PaymentCompleted
`);

        const templatePath = path.join(templatesDir, 'topic.yaml');
        const content = `apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicClaim
metadata:
  name: my-topic
spec:
  topicId: {{ $.Values.global.configuration.TOPIC_NAME }}`;

        const ctx: PluginContext = {
            relativePath: '.charts/templates/topic.yaml',
            absolutePath: templatePath,
            repoName: 'acme/payment-service',
            repoUrn: 'cr:repository:acme/payment-service',
            ownerService: 'payment-service',
            scopeManager: new ScopeManager(path.dirname(templatePath)),
        };
        const result = crossplanePubsubPlugin.extract(content, ctx);

        expect(result.entities).toHaveLength(1);
        const topic = result.entities[0];

        // Must use DEFINES for StructuralFile→Entity (not PROVISIONS)
        expect(topic.relationshipType).toBe('DEFINES');

        // Must create a governance edge: Service → PROVISIONS → Topic
        expect(topic.edges).toHaveLength(1);
        expect(topic.edges![0]).toEqual({
            sourceUrn: 'cr:service:acme/payment-service:payment-service',
            targetUrn: 'cr:channel:topic:Platform-PaymentCompleted',
            type: 'PROVISIONS',
        });
    });
});

// ── extract — Subscription Claim ─────────────────────────────────────────────

describe('crossplane-pubsub — extract SubscriptionClaim', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pubsub-test-'));
    });

    it('should extract subscription + topic + ROUTES_TO edge', () => {
        const valuesDir = path.join(tmpDir, '.charts');
        const templatesDir = path.join(valuesDir, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(valuesDir, 'values.yaml'), `
global:
  configuration:
    SUBSCRIPTION_NAME: payment-notifications
    TOPIC_NAME: Platform-PaymentCompleted
    GOOGLE_CLOUD_PROJECT: acme-platform
`);

        const templatePath = path.join(templatesDir, 'subscription.yaml');
        const content = `apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicSubscriptionClaim
metadata:
  name: {{ $.Release.Name }}-{{ $.Values.global.configuration.SUBSCRIPTION_NAME }}
spec:
  projectId: {{ $.Values.global.configuration.GOOGLE_CLOUD_PROJECT }}
  topicId: {{ $.Values.global.configuration.TOPIC_NAME }}`;

        const ctx = makeContext('.charts/templates/subscription.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);

        expect(result.entities).toHaveLength(2);

        // First entity: the topic (auto-created)
        const topic = result.entities[0];
        expect(topic.properties.name).toBe('Platform-PaymentCompleted');
        expect(topic.properties.channelKind).toBe('topic');
        expect(topic.id).toBe('cr:channel:topic:Platform-PaymentCompleted');

        // Second entity: the subscription with ROUTES_TO edge
        const sub = result.entities[1];
        expect(sub.properties.name).toBe('payment-notifications');
        expect(sub.properties.channelKind).toBe('subscription');
        expect(sub.id).toBe('cr:channel:sub:payment-notifications');

        // Verify ROUTES_TO edge
        expect(sub.edges).toHaveLength(1);
        expect(sub.edges![0]).toEqual({
            sourceUrn: 'cr:channel:sub:payment-notifications',
            targetUrn: 'cr:channel:topic:Platform-PaymentCompleted',
            type: 'ROUTES_TO',
        });

        // Summary should mention both
        expect(result.summary).toContain('payment-notifications');
        expect(result.summary).toContain('Platform-PaymentCompleted');
    });

    it('should create Service → PROVISIONS → Subscription edge when ownerService is set', () => {
        const valuesDir = path.join(tmpDir, '.charts');
        const templatesDir = path.join(valuesDir, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(valuesDir, 'values.yaml'), `
global:
  configuration:
    SUBSCRIPTION_NAME: order-notifications
    TOPIC_NAME: Platform-OrderCreated
`);

        const templatePath = path.join(templatesDir, 'subscription.yaml');
        const content = `apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicSubscriptionClaim
metadata:
  name: {{ $.Release.Name }}-{{ $.Values.global.configuration.SUBSCRIPTION_NAME }}
spec:
  topicId: {{ $.Values.global.configuration.TOPIC_NAME }}`;

        const ctx: PluginContext = {
            relativePath: '.charts/templates/subscription.yaml',
            absolutePath: templatePath,
            repoName: 'acme/mono',
            repoUrn: 'cr:repository:acme/mono',
            ownerService: 'notification-service',
            scopeManager: new ScopeManager(path.dirname(templatePath)),
        };
        const result = crossplanePubsubPlugin.extract(content, ctx);

        const sub = result.entities[1];

        // Should have TWO edges: inter-entity + governance
        expect(sub.edges).toHaveLength(2);

        // 1. Subscription → Topic (inter-entity, infra-level)
        expect(sub.edges![0]).toEqual({
            sourceUrn: 'cr:channel:sub:order-notifications',
            targetUrn: 'cr:channel:topic:Platform-OrderCreated',
            type: 'ROUTES_TO',
        });

        // 2. Service → Subscription (governance/ownership — NOT in topology)
        expect(sub.edges![1]).toEqual({
            sourceUrn: 'cr:service:acme/mono:notification-service',
            targetUrn: 'cr:channel:sub:order-notifications',
            type: 'PROVISIONS',
        });
    });
});
// ── extract — Silent No-Op ───────────────────────────────────────────────────

describe('crossplane-pubsub — silent no-op', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pubsub-test-'));
    });

    it('should return empty for a standard K8s Deployment', () => {
        const templatesDir = path.join(tmpDir, '.charts', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        const templatePath = path.join(templatesDir, 'deployment.yaml');

        const content = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  replicas: 3`;

        const ctx = makeContext('.charts/templates/deployment.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);
        expect(result.entities).toHaveLength(0);
    });

    it('should return empty for a ConfigMap', () => {
        const templatesDir = path.join(tmpDir, '.charts', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        const templatePath = path.join(templatesDir, 'configmap.yaml');

        const content = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DB_HOST: postgres.default.svc`;

        const ctx = makeContext('.charts/templates/configmap.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);
        expect(result.entities).toHaveLength(0);
    });

    it('should handle malformed YAML gracefully', () => {
        const templatesDir = path.join(tmpDir, '.charts', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        const templatePath = path.join(templatesDir, 'broken.yaml');

        const content = `{{- range .Values.topics }}
---
apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicClaim
  badly: indented: yaml: {{- end }}`;

        const ctx = makeContext('.charts/templates/broken.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);
        // Should not throw, just return empty
        expect(result.entities).toHaveLength(0);
    });

    it('should handle missing values.yaml gracefully', () => {
        // No values.yaml created — just templates dir
        const templatesDir = path.join(tmpDir, 'isolated-charts', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        const templatePath = path.join(templatesDir, 'topic.yaml');

        const content = `apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicClaim
metadata:
  name: my-topic
spec:
  topicId: HardcodedTopicName`;

        const ctx = makeContext('isolated-charts/templates/topic.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);

        // Should still extract the hardcoded topicId
        expect(result.entities).toHaveLength(1);
        expect(result.entities[0].properties.name).toBe('HardcodedTopicName');
    });
});

// ── extract — Configured CRD kinds (coderadius.yaml crossplane.crds) ─────────

describe('crossplane-pubsub — configured CRD kinds', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pubsub-test-'));
        clearRepoHintsCache();
    });

    it('should extract a custom claim kind declared in coderadius.yaml', () => {
        fs.writeFileSync(path.join(tmpDir, 'coderadius.yaml'), `
crossplane:
  crds:
    - kind: PlatformTopicClaim
      channelKind: topic
      nameField: spec.topicName
      technology: kafka
`);
        const templatesDir = path.join(tmpDir, '.charts', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        const templatePath = path.join(templatesDir, 'topic.yaml');

        const content = `apiVersion: messaging.acme.io/v1alpha1
kind: PlatformTopicClaim
metadata:
  name: inventory-topic
spec:
  topicName: Platform-InventoryUpdated`;

        const ctx = makeContext('.charts/templates/topic.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);

        expect(result.entities).toHaveLength(1);
        const topic = result.entities[0];
        expect(topic.properties.name).toBe('Platform-InventoryUpdated');
        expect(topic.properties.channelKind).toBe('topic');
        expect(topic.properties.technology).toBe('kafka');
        expect(topic.id).toBe('cr:channel:topic:Platform-InventoryUpdated');
    });

    it('should extract a custom subscription kind with ROUTES_TO linkage', () => {
        fs.writeFileSync(path.join(tmpDir, 'coderadius.yaml'), `
crossplane:
  crds:
    - kind: PlatformSubscriptionClaim
      channelKind: subscription
      nameField: spec.topicName
      topicField: spec.topicName
`);
        const templatesDir = path.join(tmpDir, '.charts', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        const templatePath = path.join(templatesDir, 'subscription.yaml');

        const content = `apiVersion: messaging.acme.io/v1alpha1
kind: PlatformSubscriptionClaim
metadata:
  name: shipping-notifications
spec:
  topicName: Platform-OrderShipped`;

        const ctx = makeContext('.charts/templates/subscription.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);

        expect(result.entities).toHaveLength(2);
        const sub = result.entities[1];
        expect(sub.properties.name).toBe('shipping-notifications');
        expect(sub.properties.channelKind).toBe('subscription');
        // technology defaults to pubsub when the declaration omits it
        expect(sub.properties.technology).toBe('pubsub');
        expect(sub.edges).toHaveLength(1);
        expect(sub.edges![0]).toEqual({
            sourceUrn: 'cr:channel:sub:shipping-notifications',
            targetUrn: 'cr:channel:topic:Platform-OrderShipped',
            type: 'ROUTES_TO',
        });
    });

    it('should let a configured entry override the default with the same kind', () => {
        fs.writeFileSync(path.join(tmpDir, 'coderadius.yaml'), `
crossplane:
  crds:
    - kind: AcmePubSubTopicClaim
      channelKind: topic
      nameField: spec.customTopicId
`);
        const templatesDir = path.join(tmpDir, '.charts', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        const templatePath = path.join(templatesDir, 'topic.yaml');

        const content = `apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicClaim
metadata:
  name: payment-topic
spec:
  topicId: WrongField
  customTopicId: Platform-PaymentCompleted`;

        const ctx = makeContext('.charts/templates/topic.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);

        expect(result.entities).toHaveLength(1);
        expect(result.entities[0].properties.name).toBe('Platform-PaymentCompleted');
    });

    it('should keep default kinds active alongside configured ones', () => {
        fs.writeFileSync(path.join(tmpDir, 'coderadius.yaml'), `
crossplane:
  crds:
    - kind: PlatformTopicClaim
      channelKind: topic
      nameField: spec.topicName
`);
        const templatesDir = path.join(tmpDir, '.charts', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        const templatePath = path.join(templatesDir, 'topics.yaml');

        const content = `apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicClaim
metadata:
  name: default-kind-topic
spec:
  topicId: Platform-OrderCreated
---
apiVersion: messaging.acme.io/v1alpha1
kind: PlatformTopicClaim
metadata:
  name: custom-kind-topic
spec:
  topicName: Platform-InventoryUpdated`;

        const ctx = makeContext('.charts/templates/topics.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);

        const names = result.entities.map(e => e.properties.name);
        expect(names).toContain('Platform-OrderCreated');
        expect(names).toContain('Platform-InventoryUpdated');
    });
});

// ── contentSignatures gate ────────────────────────────────────────────────────

describe('crossplane-pubsub — contentSignatures', () => {
    const signatures = crossplanePubsubPlugin.contentSignatures!;

    it('should match the default claim kinds', () => {
        expect(signatures.some(re => re.test('kind: AcmePubSubTopicClaim'))).toBe(true);
        expect(signatures.some(re => re.test('kind: AcmePubSubTopicSubscriptionClaim'))).toBe(true);
    });

    it('should match arbitrary configured claim kinds ending in Claim', () => {
        expect(signatures.some(re => re.test('kind: PlatformTopicClaim'))).toBe(true);
    });

    it('should NOT match non-claim kinds', () => {
        expect(signatures.some(re => re.test('kind: Deployment'))).toBe(false);
        expect(signatures.some(re => re.test('kind: ConfigMap'))).toBe(false);
    });
});

// ── source property for reconciliation safety ────────────────────────────────

describe('crossplane-pubsub — reconciliation safety', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pubsub-test-'));
    });

    it('should set source property on all emitted entities', () => {
        const valuesDir = path.join(tmpDir, '.charts');
        const templatesDir = path.join(valuesDir, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(valuesDir, 'values.yaml'), `
global:
  configuration:
    TOPIC_NAME: Platform-OrderCreated
`);
        const templatePath = path.join(templatesDir, 'topic.yaml');
        const content = `apiVersion: pubsub.acme.io/v1alpha1
kind: AcmePubSubTopicClaim
metadata:
  name: order-topic
spec:
  topicId: {{ $.Values.global.configuration.TOPIC_NAME }}`;

        const ctx = makeContext('.charts/templates/topic.yaml', templatePath);
        const result = crossplanePubsubPlugin.extract(content, ctx);

        for (const entity of result.entities) {
            expect(entity.properties.discoverySource).toBe('crossplane');
        }
    });
});
