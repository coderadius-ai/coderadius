/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit Tests — HelmEnvExtractor: isProdFilePath + HelmEnvExtractionSchema
 *
 * These tests cover the deterministic parts of the HelmEnvExtractor:
 *  - isProdFilePath(): path-based production environment detection
 *  - HelmEnvExtractionSchema: Zod validation of LLM output (simulated)
 *
 * Zero LLM calls — safe for CI. Fast (<100ms).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import { isProdFilePath, HelmEnvExtractionSchema } from '../../../../src/ai/agents/helm-env-extractor.js';

// ─── isProdFilePath ───────────────────────────────────────────────────────────

describe('isProdFilePath', () => {

    // ── Definitive PRODUCTION paths ──────────────────────────────────────────

    describe('returns true for clear production paths', () => {
        const prodPaths = [
            'helm/values-prod.yaml',
            'helm/values-production.yaml',
            'helm/values.prod.yaml',
            'helm/values.production.yml',
            'k8s/overlays/production/configmap.yaml',
            'k8s/overlays/prod/deployment.yaml',
            'deploy/production/values.yaml',
            'environments/prod/values.yaml',
            'infra/production/deployment.yaml',
            'charts/myapp/values-prd.yaml',
            'k8s/live/secrets.yaml',
        ];

        it.each(prodPaths)('"%s" → true', (p) => {
            expect(isProdFilePath(p)).toBe(true);
        });
    });

    // ── Definitive NON-PRODUCTION paths ─────────────────────────────────────

    describe('returns false for clear non-production paths', () => {
        const nonProdPaths = [
            'helm/values-dev.yaml',
            'helm/values-development.yaml',
            'helm/values-staging.yaml',
            'helm/values-stage.yaml',
            'helm/values-test.yaml',
            'helm/values-testing.yaml',
            'helm/values-local.yaml',
            'k8s/overlays/staging/configmap.yaml',
            'k8s/overlays/dev/deployment.yaml',
            'environments/qa/values.yaml',
            'environments/uat/values.yaml',
            'deploy/ci/values.yaml',
            'deploy/sandbox/values.yaml',
            'helm/values-preview.yaml',
            'helm/values.example.yaml',
            'helm/values.sample.yaml',
            'helm/values.template.yaml',
        ];

        it.each(nonProdPaths)('"%s" → false', (p) => {
            expect(isProdFilePath(p)).toBe(false);
        });
    });

    // ── AMBIGUOUS paths (let LLM decide) ────────────────────────────────────

    describe('returns null for ambiguous paths', () => {
        const ambiguousPaths = [
            'helm/values.yaml',                // base values — could be anything
            'values.yaml',                     // repo root — no environment signal
            'k8s/deployment.yaml',             // no env suffix
            'k8s/configmap.yaml',
            'docker-compose.yaml',
            'config/database.yaml',
            'infrastructure/values.yml',
            'helm/values.defaults.yaml',
        ];

        it.each(ambiguousPaths)('"%s" → null', (p) => {
            expect(isProdFilePath(p)).toBeNull();
        });
    });

    // ── Edge cases ───────────────────────────────────────────────────────────

    describe('edge cases', () => {
        it('is case-insensitive ("Values-PROD.yaml")', () => {
            expect(isProdFilePath('helm/Values-PROD.yaml')).toBe(true);
        });

        it('is case-insensitive ("Values-DEV.yaml")', () => {
            expect(isProdFilePath('helm/Values-DEV.yaml')).toBe(false);
        });

        it('"production" in a segment does NOT false-positive on "not-production"', () => {
            expect(isProdFilePath('helm/values-production-backup.yaml')).toBe(true);
        });

        it('deeply nested path: "k8s/clusters/eu-west/prod/apps/payments/values.yaml"', () => {
            expect(isProdFilePath('k8s/clusters/eu-west/prod/apps/payments/values.yaml')).toBe(true);
        });

        it('Kustomize overlay structure: "overlays/production/kustomization.yaml"', () => {
            expect(isProdFilePath('overlays/production/kustomization.yaml')).toBe(true);
        });

        it('Kustomize dev overlay: "overlays/development/kustomization.yaml"', () => {
            expect(isProdFilePath('overlays/development/kustomization.yaml')).toBe(false);
        });

        // ── Regression: segment-based fix for repo/org name false negatives ──

        it('REGRESSION: repo named "reporting-ci" must NOT block values-prod.yaml', () => {
            // OLD BUG: /\\bci\\b/ matched "reporting-ci" as if it were a CI directory
            expect(isProdFilePath('reporting-ci/helm/values-prod.yaml')).toBe(true);
        });

        it('REGRESSION: repo named "social-media-ci-monitoring" must NOT block values-prod.yaml', () => {
            expect(isProdFilePath('social-media-ci-monitoring/helm/values-prod.yaml')).toBe(true);
        });

        it('REGRESSION: repo named "qa-automation-service" must NOT block values-prod.yaml', () => {
            // OLD BUG: /\\bqa\\b/ matched "qa-automation-service" as a QA environment
            expect(isProdFilePath('qa-automation-service/helm/values-prod.yaml')).toBe(true);
        });

        it('REGRESSION: repo named "developer-tools" must NOT block values-prod.yaml', () => {
            expect(isProdFilePath('developer-tools/helm/values-prod.yaml')).toBe(true);
        });

        it('SAFE: standalone "ci" directory segment IS a CI environment', () => {
            expect(isProdFilePath('deploy/ci/values.yaml')).toBe(false);
        });

        it('SAFE: standalone "qa" directory segment IS a QA environment', () => {
            expect(isProdFilePath('environments/qa/values.yaml')).toBe(false);
        });

        it('SAFE: dev filename signal wins even inside a production directory', () => {
            // An override file named values-dev.yaml inside a production chart is non-prod
            expect(isProdFilePath('charts/myapp/production/values-dev.yaml')).toBe(false);
        });
    });
});

// ─── HelmEnvExtractionSchema ─────────────────────────────────────────────────

describe('HelmEnvExtractionSchema', () => {

    describe('valid LLM outputs (happy path)', () => {
        it('accepts a single valid binding', () => {
            const result = HelmEnvExtractionSchema.safeParse({
                bindings: [{ dbName: 'payments', sourceKey: 'POSTGRES_DB' }],
                isProduction: true,
            });
            expect(result.success).toBe(true);
            expect(result.data!.bindings).toHaveLength(1);
            expect(result.data!.bindings[0].dbName).toBe('payments');
        });

        it('accepts multiple bindings (multiple DB tech in same file)', () => {
            const result = HelmEnvExtractionSchema.safeParse({
                bindings: [
                    { dbName: 'billing', sourceKey: 'POSTGRES_DB' },
                    { dbName: 'sessions', sourceKey: 'REDIS_DB' },
                ],
                isProduction: true,
            });
            expect(result.success).toBe(true);
            expect(result.data!.bindings).toHaveLength(2);
        });

        it('accepts empty bindings (non-prod file or no DB config)', () => {
            const result = HelmEnvExtractionSchema.safeParse({
                bindings: [],
                isProduction: false,
            });
            expect(result.success).toBe(true);
            expect(result.data!.bindings).toHaveLength(0);
        });

        it('accepts nested sourceKey path', () => {
            const result = HelmEnvExtractionSchema.safeParse({
                bindings: [{ dbName: 'inventory', sourceKey: 'database.name' }],
                isProduction: true,
            });
            expect(result.success).toBe(true);
        });
    });

    describe('schema rejects invalid LLM outputs', () => {
        it('fails when bindings is missing (not optional)', () => {
            const result = HelmEnvExtractionSchema.safeParse({
                isProduction: true,
            });
            expect(result.success).toBe(false);
        });

        it('fails when isProduction is missing', () => {
            const result = HelmEnvExtractionSchema.safeParse({
                bindings: [],
            });
            expect(result.success).toBe(false);
        });

        it('fails when dbName is missing from a binding', () => {
            const result = HelmEnvExtractionSchema.safeParse({
                bindings: [{ sourceKey: 'POSTGRES_DB' }],
                isProduction: true,
            });
            expect(result.success).toBe(false);
        });

        it('fails when sourceKey is missing from a binding', () => {
            const result = HelmEnvExtractionSchema.safeParse({
                bindings: [{ dbName: 'payments' }],
                isProduction: true,
            });
            expect(result.success).toBe(false);
        });
    });
});
