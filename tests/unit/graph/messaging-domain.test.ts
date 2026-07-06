import { describe, it, expect } from 'vitest';
import { buildBrokerUrn } from '../../../src/graph/urn.js';
import {
    buildMessageChannelUrn,
} from '../../../src/graph/mutations/data-contracts.js';
import { compileAmqpTopicPattern } from '../../../src/ingestion/core/messaging/amqp-topic-pattern.js';
import { MessageBrokerSchema, MessageChannelSchema } from '../../../src/graph/domain.js';

describe('buildBrokerUrn', () => {
    it('builds a base URN without vhost', () => {
        expect(buildBrokerUrn('rabbitmq', 'abc12345')).toBe('cr:broker:rabbitmq:abc12345');
    });

    it('appends a vhost slug, stripping leading slash', () => {
        expect(buildBrokerUrn('rabbitmq', 'abc12345', '/prod')).toBe('cr:broker:rabbitmq:abc12345:prod');
    });

    it('omits root-slash vhost (default RabbitMQ vhost)', () => {
        expect(buildBrokerUrn('rabbitmq', 'abc12345', '/')).toBe('cr:broker:rabbitmq:abc12345');
        expect(buildBrokerUrn('rabbitmq', 'abc12345', '')).toBe('cr:broker:rabbitmq:abc12345');
    });

    it('sanitises nested vhost (slash, colon)', () => {
        expect(buildBrokerUrn('pulsar', 'fp', '/tenant/ns')).toBe('cr:broker:pulsar:fp:tenant-ns');
        expect(buildBrokerUrn('rabbitmq', 'fp', '/foo:bar')).toBe('cr:broker:rabbitmq:fp:foo-bar');
    });

    it('produces distinct URNs across providers with same fingerprint', () => {
        const a = buildBrokerUrn('rabbitmq', 'shared');
        const b = buildBrokerUrn('kafka', 'shared');
        expect(a).not.toBe(b);
    });
});

describe('buildMessageChannelUrn with broker fingerprint', () => {
    it('produces legacy URN when fingerprint omitted', () => {
        expect(buildMessageChannelUrn('acme.orders', 'topic')).toBe('cr:channel:topic:acme.orders');
    });

    it('appends @broker8 when fingerprint provided', () => {
        expect(buildMessageChannelUrn('acme.orders', 'topic', 'abc12345')).toBe(
            'cr:channel:topic:acme.orders@abc12345',
        );
    });

    it('keeps the same legacy mapping subscription → sub', () => {
        expect(buildMessageChannelUrn('acme.inv.orders', 'subscription', 'fp1')).toBe(
            'cr:channel:sub:acme.inv.orders@fp1',
        );
    });

    it('strict isolation: same name on different brokers yields different URNs', () => {
        const a = buildMessageChannelUrn('orders', 'topic', 'fp-eu');
        const b = buildMessageChannelUrn('orders', 'topic', 'fp-us');
        expect(a).not.toBe(b);
    });
});

describe('compileAmqpTopicPattern', () => {
    it('exact key (no wildcard) yields anchored literal regex, isPattern=false', () => {
        const r = compileAmqpTopicPattern('acme.order.created');
        expect(r.isPattern).toBe(false);
        const re = new RegExp(r.regex);
        expect(re.test('acme.order.created')).toBe(true);
        expect(re.test('acme.order.created.v2')).toBe(false);
        expect(re.test('acme.order')).toBe(false);
    });

    it('# wildcard matches zero or more dotted segments', () => {
        const r = compileAmqpTopicPattern('acme.order.#');
        expect(r.isPattern).toBe(true);
        const re = new RegExp(r.regex);
        expect(re.test('acme.order')).toBe(true);          // zero segments
        expect(re.test('acme.order.created')).toBe(true);   // one segment
        expect(re.test('acme.order.created.v2')).toBe(true); // multiple segments
        expect(re.test('acme.invoice.paid')).toBe(false);   // wrong prefix
    });

    it('* wildcard matches exactly one segment', () => {
        const r = compileAmqpTopicPattern('*.order.created');
        expect(r.isPattern).toBe(true);
        const re = new RegExp(r.regex);
        expect(re.test('acme.order.created')).toBe(true);
        expect(re.test('foo.order.created')).toBe(true);
        expect(re.test('foo.bar.order.created')).toBe(false);
        expect(re.test('.order.created')).toBe(false);
    });

    it('escapes regex metacharacters in the literal portions', () => {
        const r = compileAmqpTopicPattern('acme$plus+.event');
        expect(r.isPattern).toBe(false);
        const re = new RegExp(r.regex);
        expect(re.test('acme$plus+.event')).toBe(true);
        expect(re.test('acmeplusXevent')).toBe(false);
    });
});

describe('MessageBrokerSchema', () => {
    it('accepts a minimal RabbitMQ broker', () => {
        const parsed = MessageBrokerSchema.parse({
            id: 'cr:broker:rabbitmq:abc12345',
            provider: 'rabbitmq',
            fingerprint: 'abc12345',
            declaredVia: 'coderadius.yaml',
        });
        expect(parsed.provider).toBe('rabbitmq');
    });

    it('accepts a fully-populated Kafka broker', () => {
        const parsed = MessageBrokerSchema.parse({
            id: 'cr:broker:kafka:def67890',
            provider: 'kafka',
            fingerprint: 'def67890',
            declaredVia: 'config',
            cluster: 'prod-eu',
            host: 'kafka-1.example.com',
            port: 9092,
            region: 'eu-west-1',
            env: 'prod',
            confidence: 0.95,
        });
        expect(parsed.confidence).toBe(0.95);
    });

    it('rejects unknown provider', () => {
        const result = MessageBrokerSchema.safeParse({
            id: 'cr:broker:nope:1',
            provider: 'nope',
            fingerprint: 'x',
            declaredVia: 'config',
        });
        expect(result.success).toBe(false);
    });
});

describe('MessageChannelSchema scope/broker extensions', () => {
    it('accepts legacy channel without scope/brokerUrn', () => {
        const parsed = MessageChannelSchema.parse({
            id: 'cr:channel:topic:acme.orders',
            name: 'acme.orders',
            channelKind: 'topic',
        });
        expect(parsed.name).toBe('acme.orders');
    });

    it('accepts physical channel bound to a broker', () => {
        const parsed = MessageChannelSchema.parse({
            id: 'cr:channel:topic:acme.orders@fp1',
            name: 'acme.orders',
            channelKind: 'topic',
            scope: 'physical',
            brokerUrn: 'cr:broker:rabbitmq:fp1',
            durable: true,
            autoDelete: false,
        });
        expect(parsed.scope).toBe('physical');
        expect(parsed.brokerUrn).toBe('cr:broker:rabbitmq:fp1');
    });

    it('rejects an unknown scope', () => {
        const result = MessageChannelSchema.safeParse({
            id: 'cr:channel:topic:x',
            name: 'x',
            scope: 'bogus',
        });
        expect(result.success).toBe(false);
    });
});
