import { describe, it, expect, beforeEach } from 'vitest';
import { rabbitmqConfigPlugin } from '../../../../src/ingestion/structural/plugins/messaging/rabbitmq-config.plugin.js';
import { clearMessageBrokerRegistry, registerBrokerDeclaration } from '../../../../src/ingestion/core/messaging/broker-registry.js';
import type { PluginContext } from '../../../../src/ingestion/structural/types.js';

const ctx: PluginContext = {
    relativePath: 'rabbitmq/definitions.json',
    absolutePath: '/tmp/fake/rabbitmq/definitions.json',
    repoName: 'acme/order-svc',
    repoUrn: 'cr:repository:acme/order-svc',
    scopeManager: {} as any,
};

beforeEach(() => clearMessageBrokerRegistry());

describe('rabbitmqConfigPlugin.matchFile', () => {
    it('matches rabbitmq-definitions.json', () => {
        expect(rabbitmqConfigPlugin.matchFile('rabbitmq/rabbitmq-definitions.json', 'rabbitmq-definitions.json')).toBe(true);
    });
    it('matches definitions.json under rabbitmq/', () => {
        expect(rabbitmqConfigPlugin.matchFile('rabbitmq/definitions.json', 'definitions.json')).toBe(true);
    });
    it('matches rabbitmq.conf', () => {
        expect(rabbitmqConfigPlugin.matchFile('.docker/dev/rabbitmq/rabbitmq.conf', 'rabbitmq.conf')).toBe(true);
    });
    it('accepts any .json filename — content recognition happens via contentSignatures', () => {
        // The plugin discovery moved from filename-based to content-based:
        // matchFile permissively accepts any JSON (and rabbitmq.conf), and the
        // contentSignatures (exchanges/queues/bindings regex) filter out
        // unrelated JSON. This means a Management API export named
        // `custom_definitions.json` or `prod-rabbit.json` is picked up by
        // content, without the plugin having to enumerate every possible name.
        expect(rabbitmqConfigPlugin.matchFile('foo.json', 'foo.json')).toBe(true);
        expect(rabbitmqConfigPlugin.matchFile('custom_definitions.json', 'custom_definitions.json')).toBe(true);
        // Non-JSON, non-conf is rejected (e.g. yaml goes to other plugins).
        expect(rabbitmqConfigPlugin.matchFile('foo.yaml', 'foo.yaml')).toBe(false);
    });
});

describe('rabbitmqConfigPlugin.extract — definitions.json', () => {
    it('emits MessageBroker + exchanges + queues + ROUTES_TO with isPattern', () => {
        const defs = {
            exchanges: [
                { name: 'acme.orders', type: 'topic', durable: true, vhost: '/' },
                { name: 'acme.dlx', type: 'direct', durable: true, vhost: '/' },
            ],
            queues: [
                { name: 'acme.inventory.orders', durable: true, vhost: '/' },
                { name: 'acme.audit', durable: false, auto_delete: true, vhost: '/' },
            ],
            bindings: [
                {
                    source: 'acme.orders',
                    destination: 'acme.inventory.orders',
                    destination_type: 'queue',
                    routing_key: 'acme.order.#',
                    vhost: '/',
                },
                {
                    source: 'acme.orders',
                    destination: 'acme.audit',
                    destination_type: 'queue',
                    routing_key: 'acme.order.created',
                    vhost: '/',
                },
            ],
        };
        const result = rabbitmqConfigPlugin.extract(JSON.stringify(defs), ctx);

        // MessageBroker entity emitted
        const broker = result.entities.find(e => e.labels.includes('MessageBroker'));
        expect(broker).toBeDefined();
        expect(broker!.properties.provider).toBe('rabbitmq');
        expect(typeof broker!.properties.fingerprint).toBe('string');

        // Exchange + queue entities, scope='physical', brokerUrn populated
        const exchanges = result.entities.filter(e =>
            e.labels.includes('MessageChannel') && (e.properties.channelKind === 'topic' || e.properties.channelKind === 'exchange'));
        const queues = result.entities.filter(e =>
            e.labels.includes('MessageChannel') && e.properties.channelKind === 'queue');
        expect(exchanges).toHaveLength(2);
        expect(queues).toHaveLength(2);
        for (const ent of [...exchanges, ...queues]) {
            expect(ent.properties.scope).toBe('physical');
            expect(ent.properties.brokerUrn).toBe(broker!.id);
        }

        // The topic exchange should carry HOSTED_ON + 2 ROUTES_TO edges
        const ordersExchange = exchanges.find(e => e.properties.name === 'acme.orders')!;
        const routes = ordersExchange.edges?.filter(e => e.type === 'ROUTES_TO') ?? [];
        expect(routes).toHaveLength(2);

        const patternRoute = routes.find(r => r.properties?.bindingKey === 'acme.order.#');
        expect(patternRoute).toBeDefined();
        expect(patternRoute!.properties!.isPattern).toBe(true);
        expect(patternRoute!.properties!.patternSyntax).toBe('amqp-topic');
        expect(patternRoute!.properties!.patternRegex).toBeDefined();
        expect(new RegExp(patternRoute!.properties!.patternRegex as string).test('acme.order.created')).toBe(true);

        const exactRoute = routes.find(r => r.properties?.bindingKey === 'acme.order.created');
        expect(exactRoute).toBeDefined();
        expect(exactRoute!.properties!.isPattern).toBe(false);
    });

    it('skips amq.default direct exchange (implicit AMQP)', () => {
        const defs = {
            exchanges: [{ name: 'amq.default', type: 'direct', vhost: '/' }],
            queues: [{ name: 'orders', vhost: '/' }],
            bindings: [],
        };
        const result = rabbitmqConfigPlugin.extract(JSON.stringify(defs), ctx);
        const channelEntities = result.entities.filter(e => e.labels.includes('MessageChannel'));
        // Only the queue should remain; amq.default exchange is skipped.
        expect(channelEntities).toHaveLength(1);
        expect(channelEntities[0].properties.name).toBe('orders');
    });

    it('matches a customer-declared broker when provided', () => {
        registerBrokerDeclaration({
            id: 'rmq-prod',
            provider: 'rabbitmq',
            host: 'rmq.prod.example.com',
            vhost: '/',
            env: 'prod',
        });
        const defs = {
            exchanges: [{ name: 'acme.orders', type: 'topic', vhost: '/' }],
            queues: [],
            bindings: [],
        };
        const result = rabbitmqConfigPlugin.extract(JSON.stringify(defs), ctx);
        const broker = result.entities.find(e => e.labels.includes('MessageBroker'));
        expect(broker).toBeDefined();
        expect(broker!.properties.declaredVia).toBe('coderadius.yaml');
        expect(broker!.properties.host).toBe('rmq.prod.example.com');
        expect(broker!.properties.confidence).toBe(1.0);
    });

    it('emits broker-only entity for a rabbitmq.conf presence file', () => {
        const result = rabbitmqConfigPlugin.extract(
            'listeners.tcp.default = 5672',
            { ...ctx, relativePath: '.docker/dev/rabbitmq/rabbitmq.conf' },
        );
        expect(result.entities).toHaveLength(1);
        expect(result.entities[0].labels).toEqual(['MessageBroker']);
        expect(result.entities[0].properties.declaredVia).toBe('inferred');
    });

    it('returns empty result for malformed JSON', () => {
        const result = rabbitmqConfigPlugin.extract('{not valid json', ctx);
        expect(result.entities).toHaveLength(0);
    });

    it('strict isolation: same exchange name in two files with different vhost stays distinct', () => {
        const defsProd = {
            exchanges: [{ name: 'orders', type: 'topic', vhost: '/prod' }],
            queues: [],
            bindings: [],
        };
        const defsStaging = {
            exchanges: [{ name: 'orders', type: 'topic', vhost: '/staging' }],
            queues: [],
            bindings: [],
        };
        const resultProd = rabbitmqConfigPlugin.extract(JSON.stringify(defsProd), { ...ctx, relativePath: 'rabbitmq/prod.json' });
        const resultStaging = rabbitmqConfigPlugin.extract(JSON.stringify(defsStaging), { ...ctx, relativePath: 'rabbitmq/staging.json' });

        const prodChannel = resultProd.entities.find(e => e.labels.includes('MessageChannel'))!;
        const stagingChannel = resultStaging.entities.find(e => e.labels.includes('MessageChannel'))!;
        expect(prodChannel.id).not.toBe(stagingChannel.id);
        expect(prodChannel.properties.brokerUrn).not.toBe(stagingChannel.properties.brokerUrn);
    });
});
