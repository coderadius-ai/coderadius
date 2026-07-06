/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit — inferEnvironmentFromPath (S1.1 Part A, cheap env-label)
 *
 * Pins the shared `:APIDeployment` environment classifier now that it is also
 * wired into the env-var API synthesis (service-host-to-dependency-resolver).
 * Conservative by design: only unambiguous tokens classify; plain `.env` and
 * `.env.prod` intentionally stay `unknown` (the latter avoids the `product`/
 * `prod` substring false positive on arbitrary hosts/paths).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import { inferEnvironmentFromPath } from '../../../../src/ingestion/processors/api-deployment-resolver.js';

describe('inferEnvironmentFromPath', () => {
    it('classifies production env/helm surfaces', () => {
        expect(inferEnvironmentFromPath('.env.production')).toBe('production');
        expect(inferEnvironmentFromPath('helm/values-production.yaml')).toBe('production');
        expect(inferEnvironmentFromPath('helm/values-prod.yaml')).toBe('production');
    });

    it('classifies staging surfaces', () => {
        expect(inferEnvironmentFromPath('.env.staging')).toBe('staging');
        expect(inferEnvironmentFromPath('helm/values-staging.yaml')).toBe('staging');
    });

    it('classifies development surfaces', () => {
        expect(inferEnvironmentFromPath('.env.development')).toBe('dev');
        expect(inferEnvironmentFromPath('docker-compose.dev.yml')).toBe('dev');
    });

    it('classifies local surfaces', () => {
        expect(inferEnvironmentFromPath('.env.local')).toBe('local');
    });

    it('falls back to unknown for unmarked surfaces (conservative)', () => {
        expect(inferEnvironmentFromPath('.env')).toBe('unknown');
        expect(inferEnvironmentFromPath('.env.example')).toBe('unknown');
        // `.env.prod` is intentionally NOT matched (substring-safety trade-off):
        // the higher-priority `.env.production` is the one that carries the label.
        expect(inferEnvironmentFromPath('.env.prod')).toBe('unknown');
    });
});
