import { describe, expect, it } from 'vitest';
import {
    synthesizeHttpEndpoints,
    type RepoEnvMap,
} from '../../../../src/ingestion/processors/connection-extractors/env-var-resolver';

function makeEnv(entries: Record<string, string>): RepoEnvMap {
    const vars = new Map<string, { value: string; sourceFile: string; confidence: 'high' | 'medium' | 'low' }>();
    for (const [k, v] of Object.entries(entries)) {
        vars.set(k, { value: v, sourceFile: '.env', confidence: 'high' });
    }
    return { vars };
}

describe('synthesizeHttpEndpoints — base URL detection from env vars', () => {
    it('emits a hint for *_URL with full https:// value', () => {
        const env = makeEnv({ PAYMENT_URL: 'https://payment.acme.example.com' });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(1);
        const h = hints[0]!;
        expect(h.technology).toBe('http');
        expect(h.host).toBe('payment.acme.example.com');
        expect(h.baseUrl).toBe('https://payment.acme.example.com');
        expect(h.alias).toBe('payment');
        expect(h.sourceEnvKey).toBe('PAYMENT_URL');
        expect(h.isInferredScheme).toBeFalsy();
        expect(h.isTemplate).toBe(false);
    });

    it('strips path + query from baseUrl + still records host', () => {
        const env = makeEnv({ ORDERS_URL: 'https://orders.acme.example.com/v1/quote?debug=1' });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.host).toBe('orders.acme.example.com');
        // The hint preserves the original baseUrl so downstream callers
        // can attribute the exact endpoint they consume.
        expect(hints[0]!.baseUrl.startsWith('https://orders.acme.example.com')).toBe(true);
    });

    it('strips user:pass credentials before storing host/baseUrl', () => {
        const env = makeEnv({ ORDERS_URL: 'https://user:secret@orders.acme.example.com' });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.host).toBe('orders.acme.example.com');
        expect(hints[0]!.baseUrl).not.toContain('secret');
        expect(hints[0]!.baseUrl).not.toContain('user:');
    });

    it('handles bare host (no scheme) — emits hint with isInferredScheme=true', () => {
        const env = makeEnv({ INVENTORY_HOST: 'inventory.acme.example.com' });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(1);
        const h = hints[0]!;
        expect(h.host).toBe('inventory.acme.example.com');
        expect(h.baseUrl).toBe('https://inventory.acme.example.com');
        expect(h.isInferredScheme).toBe(true);
        expect(h.alias).toBe('inventory');
    });

    it('bare host with port → captures port', () => {
        const env = makeEnv({ ORDERS_HOST: 'orders.acme.example.com:8080' });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.host).toBe('orders.acme.example.com');
        expect(hints[0]!.port).toBe(8080);
    });

    it('non-URL value is rejected (no http(s):// and not a hostname pattern)', () => {
        const env = makeEnv({ NOT_A_URL: 'hello world' });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(0);
    });

    it('value matching a port number alone is rejected', () => {
        const env = makeEnv({ FOO_PORT: '4000' });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(0);
    });

    it('loopback hosts (localhost, 127.x.x.x) are dropped — they never represent an ExternalAPI', () => {
        const env = makeEnv({
            MOCK_URL: 'http://localhost:8081',
            LOOPBACK_URL: 'http://127.0.0.1:9000',
        });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(0);
    });

    it('compose service names (single-label hosts) are dropped — they refer to in-network sidecars', () => {
        // PRICING_ENGINE_HOST=http://pricing-engine:8080 (a docker-compose service)
        // is not an external API; it routinely refers to a sibling container.
        const env = makeEnv({
            PRICING_ENGINE_HOST: 'http://pricing-engine:8080',
            APP_HOST: 'http://app',
        });
        const hints = synthesizeHttpEndpoints(env);
        expect(hints).toHaveLength(0);
    });

    it('only env-var names ending in URL/HOST/ENDPOINT/API/BASE_URL are considered', () => {
        const env = makeEnv({
            ORDERS_URL: 'https://orders.acme.example.com',
            ORDERS_BASE_URL: 'https://api.orders.acme.example.com',
            ORDERS_ENDPOINT: 'https://endpoint.acme.example.com',
            ORDERS_HOST: 'host.acme.example.com',
            ORDERS_API: 'https://api.acme.example.com',
            ORDERS_NAME: 'orders',           // ignored
            ORDERS_TIMEOUT: '3000',           // ignored
        });
        const hints = synthesizeHttpEndpoints(env);
        const keys = hints.map(h => h.sourceEnvKey).sort();
        expect(keys).toEqual([
            'ORDERS_API', 'ORDERS_BASE_URL', 'ORDERS_ENDPOINT', 'ORDERS_HOST', 'ORDERS_URL',
        ]);
    });

    it('alias derives correctly from env var name (drops trailing _URL/_HOST/etc.)', () => {
        const env = makeEnv({
            PRIMARY_BASE_URL: 'https://primary.acme.example.com',
            SECONDARY_API: 'https://secondary.acme.example.com',
        });
        const hints = synthesizeHttpEndpoints(env);
        const byKey = new Map(hints.map(h => [h.sourceEnvKey, h]));
        expect(byKey.get('PRIMARY_BASE_URL')!.alias).toBe('primary');
        expect(byKey.get('SECONDARY_API')!.alias).toBe('secondary');
    });

    it('tech-prefix blacklist rejects RABBITMQ_HOST / MEMCACHED_HOST / MYSQL_HOST / INFLUXDB_HOST', () => {
        // Regression: these belong to the datastore / message-broker family
        // and must NOT pollute the :ExternalAPI bucket.
        const env = makeEnv({
            RABBITMQ_HOST: 'rabbitmq.service.example',
            MEMCACHED_HOST: 'memcached',
            MYSQL_HOST: 'mysql-primary.service.example',
            INFLUXDB_HOST: 'influxdb.service.example',
            DB_HOST: 'postgres-primary.service.example',
            // Sanity: a real external API still emits.
            PAYMENT_URL: 'https://payment.acme.example.com',
        });
        const hints = synthesizeHttpEndpoints(env);
        const keys = hints.map(h => h.sourceEnvKey);
        expect(keys).toEqual(['PAYMENT_URL']);
    });

    it('deduplicates by (host, alias)', () => {
        const env = makeEnv({
            ORDERS_URL: 'https://orders.acme.example.com',
            ORDERS_HOST: 'orders.acme.example.com',  // same host + same derived alias
        });
        const hints = synthesizeHttpEndpoints(env);
        // Only one hint should remain; the higher-confidence URL form wins.
        expect(hints).toHaveLength(1);
        expect(hints[0]!.sourceEnvKey).toBe('ORDERS_URL');
    });

    it('propagates the env-file sourceFile onto the hint (env-label input for S1.1 Part A)', () => {
        // The deployment environment is derived downstream from this sourceFile
        // (inferEnvironmentFromPath). Pin that the hint actually carries it so a
        // `.env.production`-sourced URL can be labelled production, not null.
        const vars = new Map<string, { value: string; sourceFile: string; confidence: 'high' | 'medium' | 'low' }>();
        vars.set('PAYMENT_URL', { value: 'https://payment.acme.example.com', sourceFile: '.env.production', confidence: 'high' });
        const hints = synthesizeHttpEndpoints({ vars });
        expect(hints).toHaveLength(1);
        expect(hints[0]!.sourceFile).toBe('.env.production');
    });
});
