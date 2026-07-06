import { describe, it, expect, beforeEach } from 'vitest';
import {
    clearMessageBrokerRegistry,
    computeBrokerFingerprint,
    getBrokerById,
    getBrokerByFingerprint,
    listMirrors,
    listRegisteredBrokers,
    makeBrokerUrn,
    registerBrokerDeclaration,
    registerMirror,
} from '../../../../../src/ingestion/core/messaging/broker-registry.js';

beforeEach(() => clearMessageBrokerRegistry());

describe('computeBrokerFingerprint', () => {
    it('is stable for identical inputs', () => {
        const a = computeBrokerFingerprint({ provider: 'rabbitmq', host: 'x', port: 5672, vhost: '/' });
        const b = computeBrokerFingerprint({ provider: 'rabbitmq', host: 'x', port: 5672, vhost: '/' });
        expect(a).toBe(b);
    });

    it('produces different fingerprints for different brokers (same name, diff host)', () => {
        const a = computeBrokerFingerprint({ provider: 'rabbitmq', host: 'eu.rmq', port: 5672 });
        const b = computeBrokerFingerprint({ provider: 'rabbitmq', host: 'us.rmq', port: 5672 });
        expect(a).not.toBe(b);
    });

    it('honors customer override', () => {
        const fp = computeBrokerFingerprint({ provider: 'rabbitmq', host: 'x', override: 'CUSTOM' });
        expect(fp).toBe('CUSTOM');
    });

    it('is exactly 8 chars when not overridden', () => {
        const fp = computeBrokerFingerprint({ provider: 'kafka', host: 'k.example' });
        expect(fp).toHaveLength(8);
    });

    it('changes when vhost differs even if host is identical', () => {
        const a = computeBrokerFingerprint({ provider: 'rabbitmq', host: 'r', vhost: '/prod' });
        const b = computeBrokerFingerprint({ provider: 'rabbitmq', host: 'r', vhost: '/staging' });
        expect(a).not.toBe(b);
    });
});

describe('makeBrokerUrn', () => {
    it('omits root vhost', () => {
        expect(makeBrokerUrn('rabbitmq', 'abc', '/')).toBe('cr:broker:rabbitmq:abc');
    });

    it('appends slug for named vhost', () => {
        expect(makeBrokerUrn('rabbitmq', 'abc', '/prod')).toBe('cr:broker:rabbitmq:abc:prod');
    });
});

describe('registerBrokerDeclaration', () => {
    it('stores a broker indexed by id and fingerprint', () => {
        const reg = registerBrokerDeclaration({
            id: 'rmq-prod-eu', provider: 'rabbitmq', host: 'eu.rmq', port: 5672, vhost: '/prod',
        });
        expect(getBrokerById('rmq-prod-eu')).toBe(reg);
        expect(getBrokerByFingerprint(reg.fingerprint)).toBe(reg);
        expect(reg.urn).toBe(`cr:broker:rabbitmq:${reg.fingerprint}:prod`);
    });

    it('preserves declared metadata on the registered entry', () => {
        const reg = registerBrokerDeclaration({
            id: 'rmq-prod-eu',
            provider: 'rabbitmq',
            host: 'eu.rmq',
            port: 5672,
            vhost: '/prod',
            env: 'prod',
            region: 'eu-west-1',
            cluster: 'rmq-cluster-1',
        });
        expect(reg.env).toBe('prod');
        expect(reg.region).toBe('eu-west-1');
        expect(reg.cluster).toBe('rmq-cluster-1');
    });

    it('strict isolation: two brokers same name diff host get distinct URNs', () => {
        const a = registerBrokerDeclaration({ id: 'eu', provider: 'rabbitmq', host: 'eu.rmq' });
        const b = registerBrokerDeclaration({ id: 'us', provider: 'rabbitmq', host: 'us.rmq' });
        expect(a.urn).not.toBe(b.urn);
        expect(listRegisteredBrokers()).toHaveLength(2);
    });
});

describe('registerMirror', () => {
    it('keeps registered mirrors in insertion order', () => {
        registerMirror({
            logical: 'OrderCreated',
            kind: 'topic',
            physical: [
                { broker: 'eu', channel: 'acme.orders', kind: 'topic' },
                { broker: 'us', channel: 'acme.orders', kind: 'topic' },
            ],
        });
        registerMirror({
            logical: 'PaymentSettled',
            kind: 'topic',
            physical: [
                { broker: 'eu', channel: 'acme.payments', kind: 'topic' },
            ],
        });
        const all = listMirrors();
        expect(all).toHaveLength(2);
        expect(all[0].logical).toBe('OrderCreated');
        expect(all[1].logical).toBe('PaymentSettled');
    });

    it('clearMessageBrokerRegistry wipes brokers and mirrors', () => {
        registerBrokerDeclaration({ id: 'x', provider: 'kafka' });
        registerMirror({ logical: 'X', kind: 'topic', physical: [{ broker: 'x', channel: 'y', kind: 'topic' }] });
        clearMessageBrokerRegistry();
        expect(listRegisteredBrokers()).toHaveLength(0);
        expect(listMirrors()).toHaveLength(0);
    });
});
