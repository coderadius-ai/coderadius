import { describe, it, expect } from 'vitest';
import {
    canonicalNodeName,
    type SnapshotNodeProps,
} from '../../eval/scorers/graph-snapshot.js';

const ep = (over: Partial<SnapshotNodeProps>): SnapshotNodeProps => ({
    name: '/orders/{orderId}',
    method: 'GET',
    path: '/orders/{orderId}',
    apiKind: 'rest',
    operation: null,
    operationName: null,
    ...over,
});

describe('canonicalNodeName', () => {
    describe('fixture mode (legacy eval-graph behavior, byte-identical)', () => {
        it('returns n.name verbatim for REST endpoints', () => {
            expect(canonicalNodeName('APIEndpoint', ep({}), 'fixture'))
                .toBe('/orders/{orderId}');
        });

        it('reconstructs the synthetic GRAPHQL label when operation + operationName exist', () => {
            const props = ep({ apiKind: 'graphql', operation: 'query', operationName: 'order', name: 'order' });
            expect(canonicalNodeName('APIEndpoint', props, 'fixture'))
                .toBe('GRAPHQL query order');
        });

        it('falls back to n.name for graphql endpoints missing operationName', () => {
            const props = ep({ apiKind: 'graphql', operation: 'query', operationName: null, name: 'order' });
            expect(canonicalNodeName('APIEndpoint', props, 'fixture'))
                .toBe('order');
        });

        it('preserves case for non-endpoint labels (existing manifests are case-sensitive)', () => {
            expect(canonicalNodeName('MessageChannel', { name: 'OrderCreated' }, 'fixture'))
                .toBe('OrderCreated');
        });
    });

    describe('field mode (live-graph assessment)', () => {
        it('endpoints become "METHOD path" with params normalized to {}', () => {
            const props = ep({ method: 'get', path: '/vouchers/{uuidVoucher}/status' });
            expect(canonicalNodeName('APIEndpoint', props, 'field'))
                .toBe('GET /vouchers/{}/status');
        });

        it('missing method becomes ANY', () => {
            const props = ep({ method: null, path: '/saveRecording' });
            expect(canonicalNodeName('APIEndpoint', props, 'field'))
                .toBe('ANY /saverecording');
        });

        it('strips trailing slash but keeps root', () => {
            expect(canonicalNodeName('APIEndpoint', ep({ method: 'POST', path: '/send/' }), 'field'))
                .toBe('POST /send');
            expect(canonicalNodeName('APIEndpoint', ep({ method: 'GET', path: '/' }), 'field'))
                .toBe('GET /');
        });

        it('falls back to name when path is absent', () => {
            const props = ep({ path: null, name: '/invoice/{referenceId}', method: 'GET' });
            expect(canonicalNodeName('APIEndpoint', props, 'field'))
                .toBe('GET /invoice/{}');
        });

        it('graphql endpoints keep the synthetic label in field mode too', () => {
            const props = ep({ apiKind: 'graphql', operation: 'mutation', operationName: 'saveOrder', name: 'saveOrder' });
            expect(canonicalNodeName('APIEndpoint', props, 'field'))
                .toBe('GRAPHQL mutation saveOrder');
        });

        it('containers are lowercased and stripped of backticks/quotes', () => {
            expect(canonicalNodeName('DataContainer', { name: '`Acme_Payments`' }, 'field'))
                .toBe('acme_payments');
        });

        it('channels are lowercased (graph mixes case, manifests are generated lowercase)', () => {
            expect(canonicalNodeName('MessageChannel', { name: 'Acme_Template' }, 'field'))
                .toBe('acme_template');
        });

        it('generic labels are lowercased and trimmed', () => {
            expect(canonicalNodeName('Service', { name: '  orders-service ' }, 'field'))
                .toBe('orders-service');
        });
    });

    describe('MessageBroker identity (provider + vhost)', () => {
        // Brokers carry no `name` property: without a dedicated branch the
        // snapshot reads null for every broker and the label asserts nothing
        // (vacuous recall, invisible FPs). Identity = provider + vhost: both
        // are config-literal grounded; the HOST is env-dependent (helm/compose
        // values differ per environment) so it is excluded from the identity.

        it('field mode: provider + vhost', () => {
            expect(canonicalNodeName('MessageBroker', { name: null, provider: 'rabbitmq', vhost: 'orders' }, 'field'))
                .toBe('rabbitmq orders');
        });

        it('vhost-less brokers (pub/sub) collapse to the provider alone', () => {
            expect(canonicalNodeName('MessageBroker', { name: null, provider: 'google-cloud-pubsub', vhost: null }, 'field'))
                .toBe('google-cloud-pubsub');
        });

        it('root vhost "/" is preserved (a real AMQP vhost, not noise)', () => {
            expect(canonicalNodeName('MessageBroker', { name: null, provider: 'rabbitmq', vhost: '/' }, 'field'))
                .toBe('rabbitmq /');
        });

        it('field mode lowercases the identity', () => {
            expect(canonicalNodeName('MessageBroker', { name: null, provider: 'RabbitMQ', vhost: 'Orders' }, 'field'))
                .toBe('rabbitmq orders');
        });

        it('fixture mode preserves case', () => {
            expect(canonicalNodeName('MessageBroker', { name: null, provider: 'RabbitMQ', vhost: 'Orders' }, 'fixture'))
                .toBe('RabbitMQ Orders');
        });

        it('provider-less broker yields the empty identity (visible as a defect, not hidden)', () => {
            expect(canonicalNodeName('MessageBroker', { name: null, provider: null, vhost: null }, 'field'))
                .toBe('');
        });
    });
});
