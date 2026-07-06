import { describe, expect, it } from 'vitest';
import {
    resolveCallerBaseUrl,
    deriveEnvironmentFromSource,
} from '../../../../src/ingestion/processors/caller-base-url-resolver';
import type { RepoEnvMap } from '../../../../src/ingestion/processors/connection-extractors/env-var-resolver';

function makeEnv(entries: Record<string, { value: string; sourceFile: string }>): RepoEnvMap {
    const vars = new Map();
    for (const [k, v] of Object.entries(entries)) {
        vars.set(k, { value: v.value, sourceFile: v.sourceFile, confidence: 'high' as const });
    }
    return { vars };
}

describe('resolveCallerBaseUrl — env-var → caller URL', () => {
    it('TS process.env.X → resolves to base URL', () => {
        const env = makeEnv({
            PAYMENT_URL: { value: 'https://payment.acme.example.com/v2', sourceFile: '.env.production' },
        });
        const code = `const url = process.env.PAYMENT_URL + '/quote'; fetch(url);`;
        const r = resolveCallerBaseUrl(code, env);
        expect(r).not.toBeNull();
        expect(r!.canonicalUrl).toBe('https://payment.acme.example.com/v2');
        expect(r!.sourceEnvKey).toBe('PAYMENT_URL');
        expect(r!.environment).toBe('production');
    });

    it('TS bracket form process.env["X"]', () => {
        const env = makeEnv({
            ORDERS_URL: { value: 'https://orders.acme.example.com', sourceFile: '.env' },
        });
        const code = `const u = process.env['ORDERS_URL']; fetch(u + '/list');`;
        const r = resolveCallerBaseUrl(code, env);
        expect(r!.sourceEnvKey).toBe('ORDERS_URL');
        expect(r!.environment).toBe('unknown');
    });

    it('PHP \\getenv("X")', () => {
        const env = makeEnv({
            PRICING_ENGINE_URL: { value: 'https://acme.example.com/v1', sourceFile: '.env.production' },
        });
        const code = `<?php $url = \\getenv('PRICING_ENGINE_URL'); curl_init($url . '/quote');`;
        const r = resolveCallerBaseUrl(code, env);
        expect(r!.canonicalUrl).toBe('https://acme.example.com/v1');
        expect(r!.sourceEnvKey).toBe('PRICING_ENGINE_URL');
    });

    it('Go os.Getenv("X")', () => {
        const env = makeEnv({
            BACKEND_URL: { value: 'https://backend.acme.example.com', sourceFile: 'helm/values-production.yaml' },
        });
        const code = `url := os.Getenv("BACKEND_URL"); resp, _ := http.Post(url + "/orders", ...)`;
        const r = resolveCallerBaseUrl(code, env);
        expect(r!.canonicalUrl).toBe('https://backend.acme.example.com');
        expect(r!.environment).toBe('production');
    });

    it('Python os.environ["X"]', () => {
        const env = makeEnv({
            SHIPPING_URL: { value: 'https://shipping.acme.example.com/v3', sourceFile: '.env.staging' },
        });
        const code = `url = os.environ["SHIPPING_URL"]; httpx.post(url + "/dispatch")`;
        const r = resolveCallerBaseUrl(code, env);
        expect(r!.canonicalUrl).toBe('https://shipping.acme.example.com/v3');
        expect(r!.environment).toBe('staging');
    });

    it('returns null when env-var key is not in the env map', () => {
        const env = makeEnv({});
        const code = `const u = process.env.MISSING_KEY;`;
        expect(resolveCallerBaseUrl(code, env)).toBeNull();
    });

    it('returns null when env-var value is not a valid URL', () => {
        const env = makeEnv({
            FOO: { value: 'not-a-url', sourceFile: '.env' },
        });
        const code = `const u = process.env.FOO;`;
        expect(resolveCallerBaseUrl(code, env)).toBeNull();
    });

    it('returns null when no env-var reference is found', () => {
        const env = makeEnv({
            PAYMENT_URL: { value: 'https://payment.acme.example.com', sourceFile: '.env' },
        });
        const code = `function plainBusinessLogic() { return 42; }`;
        expect(resolveCallerBaseUrl(code, env)).toBeNull();
    });

    it('picks the FIRST resolvable env-var when multiple are referenced', () => {
        const env = makeEnv({
            FIRST_URL: { value: 'https://first.acme.example.com', sourceFile: '.env' },
            SECOND_URL: { value: 'https://second.acme.example.com', sourceFile: '.env' },
        });
        const code = `const a = process.env.FIRST_URL; const b = process.env.SECOND_URL;`;
        const r = resolveCallerBaseUrl(code, env);
        expect(r!.sourceEnvKey).toBe('FIRST_URL');
    });
});

describe('deriveEnvironmentFromSource', () => {
    it('production-tagged files', () => {
        expect(deriveEnvironmentFromSource('.env.production')).toBe('production');
        expect(deriveEnvironmentFromSource('helm/values-production.yaml')).toBe('production');
        expect(deriveEnvironmentFromSource('.charts/prod/values.yml')).toBe('production');
    });

    it('staging', () => {
        expect(deriveEnvironmentFromSource('.env.staging')).toBe('staging');
        expect(deriveEnvironmentFromSource('helm/values-staging.yaml')).toBe('staging');
    });

    it('dev / qa / test → dev', () => {
        expect(deriveEnvironmentFromSource('.env.dev')).toBe('dev');
        expect(deriveEnvironmentFromSource('.env.qa')).toBe('dev');
        expect(deriveEnvironmentFromSource('helm/values-canary.yaml')).toBe('dev');
    });

    it('local / override', () => {
        expect(deriveEnvironmentFromSource('.env.local')).toBe('local');
        expect(deriveEnvironmentFromSource('docker-compose.override.yml')).toBe('local');
    });

    it('plain .env / docker-compose.yml → unknown', () => {
        expect(deriveEnvironmentFromSource('.env')).toBe('unknown');
        expect(deriveEnvironmentFromSource('docker-compose.yml')).toBe('unknown');
    });
});
