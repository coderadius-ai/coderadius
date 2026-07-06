/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Eval Suite — HelmEnvExtractor LLM Quality (Golden Dataset)
 *
 * Evaluation tests validating the HelmEnvExtractorAgent against real-world
 * Helm values and Kubernetes manifest patterns. LLM responses are cached
 * via withReplay() for sub-second replay runs.
 *
 * Modes (EVAL_LLM_MODE env var):
 *   replay  — Cached LLM outputs, deterministic, ~1s (default/CI)
 *   live    — Real LLM calls, saves to cache (~60s)
 *   refresh — Real LLM calls, overwrites cache (~60s)
 *
 * Run with:
 *   EVAL_LLM_MODE=replay bun vitest run tests/eval/agents/helm-env-extractor.eval.test.ts
 *
 * Timeout: 60s per test (LLM call overhead in live/refresh)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getHelmEnvExtractorAgent, HelmEnvExtractionSchema } from '../../../src/ai/agents/helm-env-extractor.js';
import { withReplay } from '../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../helpers/llm-replay-cache.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface HelmEvalCase {
    /** Short human-readable name */
    name: string;
    /** Relative file path (passed prepended to content, used for prod detection) */
    filePath: string;
    /** File content (realistic YAML/manifest) */
    content: string;
    /** Expected isProduction value */
    expectedIsProduction: boolean;
    /** dbName values that MUST appear in bindings (case-sensitive) */
    mustExtract?: string[];
    /** dbName values that MUST NOT appear in bindings */
    mustNotExtract?: string[];
    /** If true, bindings must be empty [] */
    expectEmptyBindings?: boolean;

}

// ─── Golden Dataset ──────────────────────────────────────────────────────────

const goldenDataset: HelmEvalCase[] = [

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 1: Happy Path — literal values that MUST be extracted
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'Helm values-prod.yaml: flat env with literal POSTGRES_DB',
        filePath: 'helm/values-prod.yaml',
        content: `
replicaCount: 3
image:
  repository: acme/payments-api
  tag: "1.2.0"

env:
  POSTGRES_DB: payments
  POSTGRES_HOST: db.prod.acme.internal
  POSTGRES_PORT: "5432"
  REDIS_URL: redis://cache.prod.acme.internal:6379
`,
        expectedIsProduction: true,
        mustExtract: ['payments'],
        mustNotExtract: ['db.prod.acme.internal', 'redis://cache.prod.acme.internal:6379'],
    },

    {
        name: 'K8s Deployment prod: explicit value: field (happy path)',
        filePath: 'k8s/deployments/production/payments-api.yaml',
        content: `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
spec:
  template:
    spec:
      containers:
        - name: payments-api
          env:
            - name: POSTGRES_DB
              value: "billing"
            - name: APP_ENV
              value: "production"
            - name: LOG_LEVEL
              value: "info"
`,
        expectedIsProduction: true,
        mustExtract: ['billing'],
        mustNotExtract: ['payments-api', 'info', 'production'],
    },

    {
        name: 'Helm values-production.yaml: nested database.name key',
        filePath: 'chart/values-production.yaml',
        content: `
database:
  host: postgres.prod.internal
  port: 5432
  name: orders
  user: orders_service
  sslMode: require

cache:
  host: redis.prod.internal
  db: 1
`,
        expectedIsProduction: true,
        mustExtract: ['orders'],
        mustNotExtract: ['postgres.prod.internal', 'orders_service'],
    },

    {
        name: 'Kustomize production overlay ConfigMap with DB_NAME',
        filePath: 'k8s/overlays/production/configmap.yaml',
        content: `
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DB_NAME: "inventory"
  DB_HOST: "postgres-primary.prod.cluster.local"
  CACHE_TTL: "300"
  FEATURE_FLAGS: "new_checkout=true"
`,
        expectedIsProduction: true,
        mustExtract: ['inventory'],
        mustNotExtract: ['postgres-primary.prod.cluster.local', '300'],
    },

    {
        name: 'Helm prod values: multiple databases (mysql + mongo)',
        filePath: 'helm/values-prod.yaml',
        content: `
mysql:
  database: crm_legacy
  host: mysql-prod.acme.internal
  port: 3306

mongodb:
  database: events_store
  host: mongo-prod.acme.internal
  port: 27017
`,
        expectedIsProduction: true,
        mustExtract: ['crm_legacy', 'events_store'],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 2: Trap 1 — Go/Helm Template injection → MUST be rejected
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'TRAP: Go template {{ .Values.global.dbName }} must NOT be extracted',
        filePath: 'helm/values-prod.yaml',
        content: `
database:
  name: "{{ .Values.global.dbName }}"
  host: "{{ .Values.global.dbHost }}"
  port: 5432

env:
  POSTGRES_DB: "{{ .Values.database.name | default \"main\" }}"
`,
        expectedIsProduction: true,
        expectEmptyBindings: true,
        mustNotExtract: ['{{ .Values.global.dbName }}', '{{ .Values.database.name | default "main" }}', 'main'],
    },

    {
        name: 'TRAP: Helm include template must NOT be extracted',
        filePath: 'helm/values-production.yaml',
        content: `
database:
  name: '{{ include "app.fullDbName" . }}'
  credentials: '{{ .Release.Name }}-db-secret'
`,
        expectedIsProduction: true,
        expectEmptyBindings: true,
    },

    {
        name: 'TRAP: Mixed — one template value, one literal → extract only the literal',
        filePath: 'helm/values-prod.yaml',
        content: `
env:
  POSTGRES_DB: reporting           # literal — should extract
  MYSQL_DATABASE: "{{ .Values.legacyDb.name }}"   # template — should NOT extract
`,
        expectedIsProduction: true,
        mustExtract: ['reporting'],
        mustNotExtract: ['{{ .Values.legacyDb.name }}'],
    },

    {
        name: 'TRAP: Shell variable interpolation ${DB_NAME} must NOT be extracted',
        filePath: 'k8s/overlays/production/configmap.yaml',
        content: `
apiVersion: v1
kind: ConfigMap
data:
  DB_NAME: "\${DB_NAME}"
  POSTGRES_DB: "$(POSTGRES_DATABASE)"
  APP_CONFIG: "database=\${APP_DB_NAME}"
`,
        expectedIsProduction: true,
        expectEmptyBindings: true,
        mustNotExtract: ['${DB_NAME}', '$(POSTGRES_DATABASE)'],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 3: Trap 2 — secretKeyRef / configMapKeyRef → MUST be rejected
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'TRAP: secretKeyRef for POSTGRES_DB — must return empty bindings',
        filePath: 'k8s/deployments/production/api.yaml',
        content: `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: api
          env:
            - name: POSTGRES_DB
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: dbname
            - name: POSTGRES_HOST
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: host
`,
        expectedIsProduction: true,
        expectEmptyBindings: true,
        mustNotExtract: ['db-credentials', 'dbname'],
    },

    {
        name: 'TRAP: configMapKeyRef for DB_NAME — must return empty bindings',
        filePath: 'k8s/overlays/production/deployment.yaml',
        content: `
env:
  - name: DB_NAME
    valueFrom:
      configMapKeyRef:
        name: database-config
        key: database
  - name: DB_HOST
    valueFrom:
      configMapKeyRef:
        name: database-config
        key: host
`,
        expectedIsProduction: true,
        expectEmptyBindings: true,
        mustNotExtract: ['database-config', 'database'],
    },

    {
        name: 'TRAP: Mixed secretKeyRef + literal → extract only the literal',
        filePath: 'k8s/overlays/prod/deployment.yaml',
        content: `
env:
  - name: POSTGRES_DB
    value: "analytics"               # literal — should extract
  - name: POSTGRES_PASSWORD
    valueFrom:
      secretKeyRef:                  # secret — should NOT cause any extraction of key name
        name: db-secret
        key: password
`,
        expectedIsProduction: true,
        mustExtract: ['analytics'],
        mustNotExtract: ['db-secret', 'password'],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 4: Trap 3 — Generic/ambiguous names → MUST be rejected
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'TRAP: Generic name "main" — must be rejected even in prod file',
        filePath: 'helm/values-prod.yaml',
        content: `
env:
  DB_NAME: main
  POSTGRES_DB: "main"
  DATABASE: app
`,
        expectedIsProduction: true,
        expectEmptyBindings: true,
        mustNotExtract: ['main', 'app'],
    },

    {
        name: 'TRAP: Generic name "db" — must be rejected',
        filePath: 'k8s/overlays/production/configmap.yaml',
        content: `
data:
  DB_NAME: db
  POSTGRES_DB: postgres
  MYSQL_DATABASE: mysql
`,
        expectedIsProduction: true,
        expectEmptyBindings: true,
        mustNotExtract: ['db', 'postgres', 'mysql'],
    },

    {
        name: 'Borderline: specific-enough name "subscriptions" — should be accepted',
        filePath: 'helm/values-prod.yaml',
        content: `
env:
  POSTGRES_DB: subscriptions
`,
        expectedIsProduction: true,
        mustExtract: ['subscriptions'],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 5: Non-production files → MUST return isProduction=false, bindings=[]
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'NON-PROD: values-dev.yaml with real db name — must be ignored',
        filePath: 'helm/values-dev.yaml',
        content: `
env:
  POSTGRES_DB: payments
  DB_HOST: localhost
  DB_PORT: "5432"
`,
        expectedIsProduction: false,
        expectEmptyBindings: true,
    },

    {
        name: 'NON-PROD: values-staging.yaml — must be ignored',
        filePath: 'helm/values-staging.yaml',
        content: `
database:
  name: payments_staging
  host: db.staging.acme.internal
`,
        expectedIsProduction: false,
        expectEmptyBindings: true,
    },

    {
        name: 'NON-PROD: values.example.yaml — must be ignored',
        filePath: 'helm/values.example.yaml',
        content: `
# Copy and customize for your environment
database:
  name: my-service-db
  host: localhost
`,
        expectedIsProduction: false,
        expectEmptyBindings: true,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 6: Ambiguous files (bare values.yaml) — LLM decides from content
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'AMBIGUOUS: bare values.yaml with ENVIRONMENT=production signal',
        filePath: 'helm/values.yaml',
        content: `
environment: production

database:
  name: billing
  host: db.prod.acme.internal
  port: 5432

replicaCount: 3
`,
        expectedIsProduction: true,
        mustExtract: ['billing'],

    },

    {
        name: 'AMBIGUOUS: bare values.yaml with no environment signal — should be ignored',
        filePath: 'helm/values.yaml',
        content: `
# Default values — override per environment
database:
  name: "{{ .Values.database.name }}"
  host: localhost
  port: 5432
replicaCount: 1
`,
        expectedIsProduction: false,
        expectEmptyBindings: true,

    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 7: Non-Helm IaC formats
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'Docker Compose production override (docker-compose.prod.yml)',
        filePath: 'docker-compose.prod.yml',
        content: `
version: "3.8"
services:
  api:
    environment:
      - POSTGRES_DB=reporting
      - POSTGRES_HOST=db.prod.internal
      - REDIS_URL=redis://cache.prod.internal:6379
`,
        expectedIsProduction: true,
        mustExtract: ['reporting'],
        mustNotExtract: ['db.prod.internal'],
    },

    {
        name: 'ArgoCD Application with env overrides (production namespace)',
        filePath: 'gitops/production/payments-app.yaml',
        content: `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-api
  namespace: argocd
spec:
  source:
    helm:
      values: |
        database:
          name: payments
          host: payments-db.prod.internal
  destination:
    namespace: production
`,
        expectedIsProduction: true,
        mustExtract: ['payments'],

    },

    {
        name: 'K8s StatefulSet with MYSQL_DATABASE in prod namespace',
        filePath: 'k8s/statefulsets/production/mysql.yaml',
        content: `
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: mysql
          env:
            - name: MYSQL_DATABASE
              value: "ecommerce"
            - name: MYSQL_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mysql-secret
                  key: root-password
`,
        expectedIsProduction: true,
        mustExtract: ['ecommerce'],
        mustNotExtract: ['mysql-secret', 'root-password'],
    },
];

// ─── Test Runner ─────────────────────────────────────────────────────────────

// ─── LLM Replay Cache ────────────────────────────────────────────────────────
// Bump when HelmEnvExtractionSchema fields change.
const SCHEMA_VERSION = 'v1.0.0-helm-env';
await withReplay(getHelmEnvExtractorAgent(), SCHEMA_VERSION);

describe('HelmEnvExtractor Eval Suite', () => {

    beforeAll(() => {
        console.log(`[LLM Replay] Mode: ${EVAL_LLM_MODE}`);
    });

    it.each(goldenDataset)('$name', async ({ filePath, content, expectedIsProduction, mustExtract, mustNotExtract, expectEmptyBindings }) => {
        const agent = getHelmEnvExtractorAgent();

        const response = await agent.generate(
            `File: ${filePath}\n\n${content}`,
            {
                structuredOutput: { schema: HelmEnvExtractionSchema },
                modelSettings: { maxRetries: 2, temperature: 0 },
                abortSignal: AbortSignal.timeout(60_000),
            },
        );

        const result = response.object;
        if (!result) {
            throw new Error(`Agent returned null for "${filePath}"`);
        }

        const extractedNames = result.bindings.map(b => b.dbName);
        const fail = (msg: string) => {
            const detail = `\n  file: ${filePath}\n  bindings: ${JSON.stringify(result.bindings)}\n  isProduction: ${result.isProduction}`;
            throw new Error(`${msg}${detail}`);
        };

        // ── isProduction assertion ───────────────────────────────────────────
        if (result.isProduction !== expectedIsProduction) {
            fail(`Expected isProduction=${expectedIsProduction}, got ${result.isProduction}`);
        }

        // ── Empty bindings assertion ─────────────────────────────────────────
        if (expectEmptyBindings && result.bindings.length > 0) {
            fail(`Expected empty bindings[], got: ${JSON.stringify(extractedNames)}`);
        }

        // ── mustExtract assertions ───────────────────────────────────────────
        if (mustExtract) {
            for (const expected of mustExtract) {
                if (!extractedNames.includes(expected)) {
                    fail(`Expected "${expected}" in bindings but got: ${JSON.stringify(extractedNames)}`);
                }
            }
        }

        // ── mustNotExtract assertions ────────────────────────────────────────
        if (mustNotExtract) {
            for (const forbidden of mustNotExtract) {
                const match = extractedNames.find(n => n.toLowerCase().includes(forbidden.toLowerCase()));
                if (match) {
                    fail(`Forbidden value "${forbidden}" found in bindings as "${match}"`);
                }
            }
        }
    });
});
