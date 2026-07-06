import { describe, it, expect, beforeEach } from 'vitest';
import {
    parseAmqpDsn,
    resolveBrokerFromDsn,
    findDeclaredBrokerForDsn,
    makePhysicalChannelUrn,
    buildPhysicalChannelEntity,
    buildBrokerEntity,
} from '../../../../src/ingestion/structural/plugins/messaging/messaging-helpers.js';
import {
    clearMessageBrokerRegistry,
    registerBrokerDeclaration,
    listRegisteredBrokers,
} from '../../../../src/ingestion/core/messaging/broker-registry.js';

beforeEach(() => clearMessageBrokerRegistry());

describe('parseAmqpDsn', () => {
    it('parses a standard AMQP DSN with vhost', () => {
        const p = parseAmqpDsn('amqp://guest:guest@rabbit.example.com:5672/prod');
        expect(p).not.toBeNull();
        expect(p!.provider).toBe('rabbitmq');
        expect(p!.host).toBe('rabbit.example.com');
        expect(p!.port).toBe(5672);
        expect(p!.vhost).toBe('/prod');
        expect(p!.hasUnresolvedPlaceholders).toBe(false);
    });

    it('flags %env(...) placeholders without resolving them', () => {
        const p = parseAmqpDsn('amqp://%env(USER)%:%env(PASS)%@%env(RABBITMQ_HOST)%:5672/prod');
        expect(p).not.toBeNull();
        expect(p!.hasUnresolvedPlaceholders).toBe(true);
        // host had a placeholder, so the resolver leaves it undefined
        expect(p!.host).toBeUndefined();
        // port resolved as literal
        expect(p!.port).toBe(5672);
    });

    it('maps amqps:// to rabbitmq provider', () => {
        const p = parseAmqpDsn('amqps://rabbit.example.com');
        expect(p!.provider).toBe('rabbitmq');
    });

    it('maps kafka and kafka+ssl schemes', () => {
        expect(parseAmqpDsn('kafka://h:9092')!.provider).toBe('kafka');
        expect(parseAmqpDsn('kafka+ssl://h:9093')!.provider).toBe('kafka');
    });

    it('returns null for unknown schemes', () => {
        expect(parseAmqpDsn('http://nope')).toBeNull();
        expect(parseAmqpDsn('not-a-dsn')).toBeNull();
        expect(parseAmqpDsn('')).toBeNull();
    });

    it('normalizes empty vhost to root "/"', () => {
        const p = parseAmqpDsn('amqp://host/');
        expect(p!.vhost).toBe('/');
    });
});

describe('findDeclaredBrokerForDsn', () => {
    it('matches exact host+port+vhost', () => {
        registerBrokerDeclaration({
            id: 'eu', provider: 'rabbitmq', host: 'eu.rmq', port: 5672, vhost: '/prod',
        });
        registerBrokerDeclaration({
            id: 'us', provider: 'rabbitmq', host: 'us.rmq', port: 5672, vhost: '/prod',
        });
        const p = parseAmqpDsn('amqp://u:p@eu.rmq:5672/prod')!;
        const match = findDeclaredBrokerForDsn(p, listRegisteredBrokers());
        expect(match?.id).toBe('eu');
    });

    it('matches host-only when DSN missing port/vhost', () => {
        registerBrokerDeclaration({ id: 'eu', provider: 'rabbitmq', host: 'eu.rmq' });
        const p = parseAmqpDsn('amqp://eu.rmq')!;
        const match = findDeclaredBrokerForDsn(p, listRegisteredBrokers());
        expect(match?.id).toBe('eu');
    });

    it('falls back to single-provider shortcut when only one broker of the provider is declared', () => {
        registerBrokerDeclaration({ id: 'only', provider: 'rabbitmq', host: 'eu.rmq' });
        const p = parseAmqpDsn('amqp://other-host/')!;
        const match = findDeclaredBrokerForDsn(p, listRegisteredBrokers());
        expect(match?.id).toBe('only');
    });

    it('does not match across providers', () => {
        registerBrokerDeclaration({ id: 'eu', provider: 'rabbitmq', host: 'eu.rmq' });
        const p = parseAmqpDsn('kafka://eu.rmq:9092/')!;
        const match = findDeclaredBrokerForDsn(p, listRegisteredBrokers());
        expect(match).toBeUndefined();
    });

    it('returns undefined when ambiguous across multiple matching providers', () => {
        registerBrokerDeclaration({ id: 'eu', provider: 'rabbitmq', host: 'eu.rmq' });
        registerBrokerDeclaration({ id: 'us', provider: 'rabbitmq', host: 'us.rmq' });
        const p = parseAmqpDsn('amqp://unrelated-host/')!;
        const match = findDeclaredBrokerForDsn(p, listRegisteredBrokers());
        expect(match).toBeUndefined();
    });
});

describe('resolveBrokerFromDsn', () => {
    it('prefers a declared broker (confidence 1.0)', () => {
        registerBrokerDeclaration({ id: 'eu', provider: 'rabbitmq', host: 'eu.rmq', vhost: '/prod' });
        const p = parseAmqpDsn('amqp://eu.rmq/prod')!;
        const r = resolveBrokerFromDsn(p, listRegisteredBrokers());
        expect(r).not.toBeNull();
        expect(r!.declaredVia).toBe('coderadius.yaml');
        expect(r!.confidence).toBe(1.0);
    });

    it('falls back to inferred when DSN is literal (confidence 0.9)', () => {
        const p = parseAmqpDsn('amqp://rabbit.example.com:5672/staging')!;
        const r = resolveBrokerFromDsn(p, []);
        expect(r).not.toBeNull();
        expect(r!.declaredVia).toBe('config');
        expect(r!.confidence).toBe(0.9);
        expect(r!.urn).toContain('cr:broker:rabbitmq:');
        expect(r!.urn).toContain(':staging');
    });

    it('returns null when DSN is fully unresolved and no broker declared', () => {
        const p = parseAmqpDsn('amqp://%env(USER)%:%env(PASS)%@%env(HOST)%/')!;
        const r = resolveBrokerFromDsn(p, []);
        expect(r).toBeNull();
    });

    it('emits a confidence=0.3 fingerprint when DSN has placeholders but host resolved', () => {
        // host literal but port placeholder
        const p = parseAmqpDsn('amqp://rabbit.example.com:%env(PORT)%/')!;
        const r = resolveBrokerFromDsn(p, []);
        expect(r).not.toBeNull();
        expect(r!.declaredVia).toBe('inferred');
        expect(r!.confidence).toBe(0.3);
    });
});

describe('makePhysicalChannelUrn', () => {
    it('appends @brokerFp8 and maps subscription→sub', () => {
        expect(makePhysicalChannelUrn('acme.orders', 'topic', 'abc12345')).toBe(
            'cr:channel:topic:acme.orders@abc12345',
        );
        expect(makePhysicalChannelUrn('orders-sub', 'subscription', 'abc12345')).toBe(
            'cr:channel:sub:orders-sub@abc12345',
        );
    });
});

describe('buildPhysicalChannelEntity', () => {
    it('emits MessageChannel entity with HOSTED_ON edge to broker', () => {
        const ent = buildPhysicalChannelEntity({
            channelName: 'acme.orders',
            channelKind: 'topic',
            brokerUrn: 'cr:broker:rabbitmq:abc12345',
            brokerFingerprint: 'abc12345',
            technology: 'rabbitmq',
            durable: true,
        });
        expect(ent.id).toBe('cr:channel:topic:acme.orders@abc12345');
        expect(ent.labels).toEqual(['MessageChannel']);
        expect(ent.properties.scope).toBe('physical');
        expect(ent.properties.brokerUrn).toBe('cr:broker:rabbitmq:abc12345');
        expect(ent.properties.durable).toBe(true);
        expect(ent.edges).toHaveLength(1);
        expect(ent.edges![0]).toEqual({
            sourceUrn: 'cr:channel:topic:acme.orders@abc12345',
            targetUrn: 'cr:broker:rabbitmq:abc12345',
            type: 'HOSTED_ON',
        });
    });
});

describe('buildBrokerEntity', () => {
    it('emits MessageBroker entity with declared properties', () => {
        const ent = buildBrokerEntity({
            urn: 'cr:broker:rabbitmq:abc12345',
            fingerprint: 'abc12345',
            provider: 'rabbitmq',
            host: 'rmq.eu',
            port: 5672,
            vhost: '/prod',
            env: 'prod',
            region: 'eu-west-1',
            declaredVia: 'coderadius.yaml',
            confidence: 1.0,
        });
        expect(ent.id).toBe('cr:broker:rabbitmq:abc12345');
        expect(ent.labels).toEqual(['MessageBroker']);
        expect(ent.properties.provider).toBe('rabbitmq');
        expect(ent.properties.host).toBe('rmq.eu');
    });
});
