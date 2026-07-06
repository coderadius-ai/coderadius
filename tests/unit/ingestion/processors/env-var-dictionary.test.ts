import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractEnvVarDictionary } from '../../../../src/ingestion/processors/infra-manifest-resolver.js';
import { resolveMessageChannelName } from '../../../../src/ingestion/processors/code-pipeline/interpret/message-channel.js';
import type { EnvVarBinding } from '../../../../src/ingestion/processors/infra-manifest-resolver.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeYaml(relPath: string, content: string): void {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-envvar-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// extractEnvVarDictionary
// ═════════════════════════════════════════════════════════════════════════════

describe('extractEnvVarDictionary', () => {

    it('extracts literal env vars from Helm values-production.yaml', () => {
        writeYaml('helm/values-production.yaml', `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: api
          env:
            - name: DB_NAME
              value: "payments"
            - name: QUEUE_NAME
              value: "orders.created"
            - name: REDIS_URL
              value: "redis://cache:6379"
`);
        const dict = extractEnvVarDictionary(tmpDir);
        // The dict also includes YAML leaf values from the deployment template structure,
        // so check specific entries rather than exact size.
        expect(dict.get('DB_NAME')?.value).toBe('payments');
        expect(dict.get('QUEUE_NAME')?.value).toBe('orders.created');
        expect(dict.get('REDIS_URL')?.value).toBe('redis://cache:6379');
        // Production file = confidence 1.0
        expect(dict.get('DB_NAME')?.confidence).toBe(1.0);
    });

    it('skips Go template values', () => {
        writeYaml('helm/values-production.yaml', `
spec:
  containers:
    - env:
        - name: DB_HOST
          value: "{{ .Values.global.database.host }}"
        - name: DB_NAME
          value: "payments"
`);
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.has('DB_HOST')).toBe(false);
        expect(dict.get('DB_NAME')?.value).toBe('payments');
    });

    it('skips secretKeyRef / valueFrom entries', () => {
        writeYaml('helm/values-production.yaml', `
spec:
  containers:
    - env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: password
        - name: APP_NAME
          value: "my-service"
`);
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.has('DB_PASSWORD')).toBe(false);
        expect(dict.get('APP_NAME')?.value).toBe('my-service');
    });

    it('skips shell variable interpolations', () => {
        writeYaml('helm/values-production.yaml', `
spec:
  containers:
    - env:
        - name: EXPANDED_VAR
          value: "\${DB_NAME}"
        - name: LITERAL_VAR
          value: "actual-value"
`);
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.has('EXPANDED_VAR')).toBe(false);
        expect(dict.get('LITERAL_VAR')?.value).toBe('actual-value');
    });

    it('extracts nested YAML leaf values (Helm base values)', () => {
        writeYaml('helm/values.yaml', `
global:
  channels:
    topics:
      shipmentBundleV2:
        topicId: Order-ShipmentBundleV2
      save:
        topicId: Order-Save
`);
        const dict = extractEnvVarDictionary(tmpDir);
        // Dot-path keys in SCREAMING_SNAKE
        const saveKey = 'GLOBAL.CHANNELS.TOPICS.SAVE.TOPIC_ID';
        const bundleKey = 'GLOBAL.CHANNELS.TOPICS.SHIPMENT_BUNDLE_V2.TOPIC_ID';
        expect(dict.get(saveKey)?.value).toBe('Order-Save');
        expect(dict.get(bundleKey)?.value).toBe('Order-ShipmentBundleV2');
        // Base values file = confidence 0.7
        expect(dict.get(saveKey)?.confidence).toBe(0.7);
    });

    it('discovers .charts/*/values.yaml via dynamic globs', () => {
        writeYaml('.charts/event-consumer/values.yaml', `
global:
  channels:
    topics:
      save:
        topicId: Order-Save
`);
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.size).toBeGreaterThan(0);
        const saveBinding = [...dict.entries()].find(([, v]) => v.value === 'Order-Save');
        expect(saveBinding).toBeDefined();
        expect(saveBinding![1].sourceFile).toContain('.charts/event-consumer/values.yaml');
    });

    it('handles Docker Compose environment as object', () => {
        writeYaml('docker-compose.yml', `
version: "3"
services:
  api:
    image: api:latest
    environment:
      DATABASE_URL: "postgres://user:pass@db:5432/mydb"
      REDIS_HOST: "redis"
`);
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.get('DATABASE_URL')?.value).toBe('postgres://user:pass@db:5432/mydb');
        expect(dict.get('REDIS_HOST')?.value).toBe('redis');
    });

    it('handles Docker Compose environment as array', () => {
        writeYaml('docker-compose.prod.yml', `
version: "3"
services:
  worker:
    image: worker:latest
    environment:
      - QUEUE_URL=amqp://rabbit:5672
      - WORKER_COUNT=5
`);
        // Array of "KEY=VALUE" strings are not name/value objects, so they
        // should NOT be extracted (we only handle { name:, value: } format)
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.has('QUEUE_URL')).toBe(false);
    });

    it('highest-confidence wins on key collision', () => {
        writeYaml('helm/values.yaml', `
spec:
  containers:
    - env:
        - name: APP_NAME
          value: "base-value"
`);
        writeYaml('helm/values-production.yaml', `
spec:
  containers:
    - env:
        - name: APP_NAME
          value: "prod-value"
`);
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.get('APP_NAME')?.value).toBe('prod-value');
        expect(dict.get('APP_NAME')?.confidence).toBe(1.0);
    });

    it('skips empty values', () => {
        writeYaml('helm/values-production.yaml', `
spec:
  containers:
    - env:
        - name: EMPTY_VAR
          value: ""
        - name: REAL_VAR
          value: "hello"
`);
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.has('EMPTY_VAR')).toBe(false);
        expect(dict.get('REAL_VAR')?.value).toBe('hello');
    });

    it('assigns lower confidence to base values files vs production', () => {
        writeYaml('.charts/api/values.yaml', `
global:
  appName: my-service
`);
        const dict = extractEnvVarDictionary(tmpDir);
        // Base values.yaml (no env tag) = confidence 0.7 (below production's 1.0)
        const entry = dict.get('GLOBAL.APP_NAME');
        expect(entry).toBeDefined();
        expect(entry!.confidence).toBe(0.7);
    });

    it('returns empty map when no files found', () => {
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.size).toBe(0);
    });

    // ─── Helm Go Template Resolution ─────────────────────────────────────────

    it('resolves Go template env vars against leaf bindings from base values', () => {
        // Base values.yaml with nested topic config (the physical values)
        writeYaml('.charts/event-consumer/values.yaml', `
global:
  messageBus:
    topics:
      orderCreated:
        topicId: Acme-OrderCreated
      orderUpdated:
        topicId: Acme-OrderUpdated
`);
        // Deployment template with Go template references
        writeYaml('.charts/event-consumer/values-production.yaml', `
spec:
  containers:
    - env:
        - name: ORDER_TOPIC_CREATED
          value: '{{ $.Values.global.messageBus.topics.orderCreated.topicId }}'
        - name: ORDER_TOPIC_UPDATED
          value: '{{ .Values.global.messageBus.topics.orderUpdated.topicId }}'
        - name: NODE_ENV
          value: production
`);
        const dict = extractEnvVarDictionary(tmpDir);

        // Go template env vars should be resolved to the physical topic names
        expect(dict.get('ORDER_TOPIC_CREATED')?.value).toBe('Acme-OrderCreated');
        expect(dict.get('ORDER_TOPIC_UPDATED')?.value).toBe('Acme-OrderUpdated');

        // Direct literal env vars should still work
        expect(dict.get('NODE_ENV')?.value).toBe('production');
    });

    it('Go template resolution does not overwrite direct literal values', () => {
        // A file where the env var is defined directly with a literal
        writeYaml('helm/values-production.yaml', `
spec:
  containers:
    - env:
        - name: MY_VAR
          value: "direct-value"
`);
        // A Helm base values that could theoretically conflict
        writeYaml('helm/values.yaml', `
global:
  myVar: "template-value"
`);
        const dict = extractEnvVarDictionary(tmpDir);
        // The direct literal should win — template resolution skips existing keys
        expect(dict.get('MY_VAR')?.value).toBe('direct-value');
    });

    it('resolves Go template with pipe operators (| quote)', () => {
        writeYaml('.charts/api/values.yaml', `
global:
  config:
    apiKey: my-secret-key
`);
        writeYaml('.charts/api/values-production.yaml', `
spec:
  containers:
    - env:
        - name: API_KEY
          value: '{{ $.Values.global.config.apiKey | quote }}'
`);
        const dict = extractEnvVarDictionary(tmpDir);
        expect(dict.get('API_KEY')?.value).toBe('my-secret-key');
    });

    it('unresolvable Go template paths are silently skipped', () => {
        // No base values.yaml — the template path has nowhere to resolve to
        writeYaml('helm/values-production.yaml', `
spec:
  containers:
    - env:
        - name: MISSING_TOPIC
          value: '{{ $.Values.global.nonexistent.path }}'
`);
        const dict = extractEnvVarDictionary(tmpDir);
        // Should NOT appear in the dict (not resolved, and the template was skipped)
        expect(dict.has('MISSING_TOPIC')).toBe(false);
    });

    it('end-to-end: resolveMessageChannelName works with template-resolved dict', () => {
        writeYaml('.charts/event-consumer/values.yaml', `
global:
  messageBus:
    topics:
      save:
        topicId: Acme-OrderSave
`);
        writeYaml('.charts/event-consumer/values-production.yaml', `
spec:
  containers:
    - env:
        - name: MY_TOPIC_SAVE
          value: '{{ $.Values.global.messageBus.topics.save.topicId }}'
`);
        const dict = extractEnvVarDictionary(tmpDir);

        // The graph-writer calls resolveMessageChannelName with camelCase names
        // from the LLM. If the LLM extracts "myTopicSave", it should resolve:
        //   myTopicSave → MY_TOPIC_SAVE → Acme-OrderSave
        expect(resolveMessageChannelName('myTopicSave', dict)).toBe('Acme-OrderSave');
        expect(resolveMessageChannelName('MY_TOPIC_SAVE', dict)).toBe('Acme-OrderSave');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveMessageChannelName
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveMessageChannelName', () => {
    function makeDict(entries: Record<string, string>): Map<string, EnvVarBinding> {
        const dict = new Map<string, EnvVarBinding>();
        for (const [key, value] of Object.entries(entries)) {
            dict.set(key.toUpperCase(), { value, sourceFile: 'test.yaml', confidence: 1.0 });
        }
        return dict;
    }

    it('direct match (uppercase)', () => {
        const dict = makeDict({ 'APP_CHANNEL_SAVE': 'Order-Save' });
        expect(resolveMessageChannelName('APP_CHANNEL_SAVE', dict)).toBe('Order-Save');
    });

    it('direct match (case-insensitive)', () => {
        const dict = makeDict({ 'APP_CHANNEL_SAVE': 'Order-Save' });
        expect(resolveMessageChannelName('app_channel_save', dict)).toBe('Order-Save');
    });

    it('camelCase to SCREAMING_SNAKE conversion', () => {
        const dict = makeDict({ 'APP_CHANNEL_SAVE': 'Order-Save' });
        expect(resolveMessageChannelName('appChannelSave', dict)).toBe('Order-Save');
    });

    it('PascalCase to SCREAMING_SNAKE conversion', () => {
        const dict = makeDict({ 'APP_CHANNEL_SHIPMENT_BUNDLE_V2': 'Order-ShipmentBundleV2' });
        expect(resolveMessageChannelName('AppChannelShipmentBundleV2', dict)).toBe('Order-ShipmentBundleV2');
    });

    it('no match returns original name', () => {
        const dict = makeDict({ 'OTHER_VAR': 'other-value' });
        expect(resolveMessageChannelName('ha.notifications', dict)).toBe('ha.notifications');
    });

    it('empty dict returns original name', () => {
        const dict = new Map<string, EnvVarBinding>();
        expect(resolveMessageChannelName('anyName', dict)).toBe('anyName');
    });

    it('already-resolved names pass through (not double-resolved)', () => {
        const dict = makeDict({ 'TOPIC_NAME': 'Order-Save' });
        // "Order-Save" is NOT an env var key, so it should pass through
        expect(resolveMessageChannelName('Order-Save', dict)).toBe('Order-Save');
    });
});
