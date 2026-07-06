import { describe, it, expect, beforeEach } from 'vitest';
import { buildBrokerEntity } from '../../../../src/ingestion/structural/plugins/messaging/messaging-helpers.js';
import {
    setUrnsTransparent,
    resetUrnTransparencyForTesting,
} from '../../../../src/utils/urn-transparency.js';

// ═════════════════════════════════════════════════════════════════════════════
// buildBrokerEntity — pure function, no DB. Pin host normalization +
// displayHost transparent/opaque branches without requiring Memgraph.
// ═════════════════════════════════════════════════════════════════════════════

describe('buildBrokerEntity (Fix P2.2)', () => {
    beforeEach(() => {
        resetUrnTransparencyForTesting();
    });

    const baseInput = {
        urn: 'cr:broker:rabbitmq:bbd7ed82',
        provider: 'rabbitmq' as const,
        fingerprint: 'bbd7ed82',
        declaredVia: 'inferred' as const,
        host: 'RabbitMQ.Prod.Acme.local.',  // mixed case + trailing dot
        port: 5672,
        vhost: 'InventoryVhost',
        confidence: 0.9,
    };

    it('opaque mode: normalizes host (lowercase, no trailing dot)', () => {
        setUrnsTransparent(false);
        const entity = buildBrokerEntity(baseInput);
        expect(entity.labels).toEqual(['MessageBroker']);
        expect(entity.properties.host).toBe('rabbitmq.prod.acme.local');
        expect(entity.properties.port).toBe(5672);
        expect(entity.properties.vhost).toBe('InventoryVhost');
    });

    it('opaque mode: emits displayHost=null and displayVhost=null as removal markers', () => {
        setUrnsTransparent(false);
        const entity = buildBrokerEntity(baseInput);
        // Keys present but null → generic structural merge writes `SET n.X = null`,
        // which Memgraph treats as removal. Avoids stale PII from a previous
        // transparent run.
        expect(entity.properties).toHaveProperty('displayHost');
        expect(entity.properties).toHaveProperty('displayVhost');
        expect(entity.properties.displayHost).toBeNull();
        expect(entity.properties.displayVhost).toBeNull();
    });

    it('transparent mode: preserves original host case + populates displayHost', () => {
        setUrnsTransparent(true);
        const entity = buildBrokerEntity(baseInput);
        // host stored canonical (lowercase) — dedup-stable across runs.
        expect(entity.properties.host).toBe('rabbitmq.prod.acme.local');
        // displayHost = original input, case preserved for UI debug.
        expect(entity.properties.displayHost).toBe('RabbitMQ.Prod.Acme.local.');
        expect(entity.properties.displayVhost).toBe('InventoryVhost');
    });

    it('null host input: normalizes to null without crash', () => {
        setUrnsTransparent(false);
        const entity = buildBrokerEntity({ ...baseInput, host: undefined } as any);
        expect(entity.properties.host).toBeNull();
        expect(entity.properties.displayHost).toBeNull();
    });

    it('idempotent: same input + same mode returns equivalent entity', () => {
        setUrnsTransparent(true);
        const e1 = buildBrokerEntity(baseInput);
        const e2 = buildBrokerEntity(baseInput);
        expect(e1).toEqual(e2);
    });

    it('mode toggle between calls: opaque then transparent yields different displayHost', () => {
        setUrnsTransparent(false);
        const eOpaque = buildBrokerEntity(baseInput);
        resetUrnTransparencyForTesting();
        setUrnsTransparent(true);
        const eTransparent = buildBrokerEntity(baseInput);
        expect(eOpaque.properties.displayHost).toBeNull();
        expect(eTransparent.properties.displayHost).toBe('RabbitMQ.Prod.Acme.local.');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// hostKind — meta-brokers (Symfony Messenger) store the repo name as their
// host. The repo name is a SYNTHETIC identity ('org/repo'), not a DNS host:
// URL-based normalizeHost would truncate 'acme/inventory-service' to 'acme'.
// Producers mark such hosts hostKind:'synthetic' to skip normalization.
// ═════════════════════════════════════════════════════════════════════════════

describe('buildBrokerEntity — hostKind', () => {
    beforeEach(() => {
        resetUrnTransparencyForTesting();
        setUrnsTransparent(false);
    });

    it('synthetic: preserves an org/repo host verbatim (no URL truncation)', () => {
        const entity = buildBrokerEntity({
            urn: 'cr:broker:symfony-messenger:abcd1234',
            provider: 'symfony-messenger' as const,
            fingerprint: 'abcd1234',
            declaredVia: 'config' as const,
            host: 'acme/inventory-service',
            hostKind: 'synthetic' as const,
            confidence: 1.0,
        });
        expect(entity.properties.host).toBe('acme/inventory-service');
    });

    it('network (default): still normalizes a real DNS host', () => {
        const entity = buildBrokerEntity({
            urn: 'cr:broker:rabbitmq:bbd7ed82',
            provider: 'rabbitmq' as const,
            fingerprint: 'bbd7ed82',
            declaredVia: 'inferred' as const,
            host: 'RabbitMQ.Prod.Acme.local.',
            confidence: 0.9,
        });
        expect(entity.properties.host).toBe('rabbitmq.prod.acme.local');
    });

    it('explicit network: behaves identically to the unset default', () => {
        const entity = buildBrokerEntity({
            urn: 'cr:broker:rabbitmq:bbd7ed82',
            provider: 'rabbitmq' as const,
            fingerprint: 'bbd7ed82',
            declaredVia: 'inferred' as const,
            host: 'RabbitMQ.Prod.Acme.local.',
            hostKind: 'network' as const,
            confidence: 0.9,
        });
        expect(entity.properties.host).toBe('rabbitmq.prod.acme.local');
    });
});
