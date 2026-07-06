import { describe, it, expect, beforeEach } from 'vitest';
import { symfonyMessengerPlugin } from '../../../../src/ingestion/structural/plugins/messaging/symfony-messenger.plugin.js';
import { clearMessageBrokerRegistry, registerBrokerDeclaration } from '../../../../src/ingestion/core/messaging/broker-registry.js';
import type { PluginContext } from '../../../../src/ingestion/structural/types.js';

const ctx: PluginContext = {
    relativePath: 'config/packages/messenger.yaml',
    absolutePath: '/tmp/fake/config/packages/messenger.yaml',
    repoName: 'acme/order-svc',
    repoUrn: 'cr:repository:acme/order-svc',
    scopeManager: {} as any,
};

beforeEach(() => clearMessageBrokerRegistry());

describe('symfonyMessengerPlugin.matchFile', () => {
    it('matches messenger.yaml at the canonical location', () => {
        expect(symfonyMessengerPlugin.matchFile('config/packages/messenger.yaml', 'messenger.yaml')).toBe(true);
    });
    it('matches env-specific overlay messenger.yaml', () => {
        expect(symfonyMessengerPlugin.matchFile('config/packages/prod/messenger.yaml', 'messenger.yaml')).toBe(true);
    });
    it('matches .yml variant', () => {
        expect(symfonyMessengerPlugin.matchFile('config/packages/messenger.yml', 'messenger.yml')).toBe(true);
    });
    it('ignores unrelated yaml', () => {
        expect(symfonyMessengerPlugin.matchFile('config/packages/security.yaml', 'security.yaml')).toBe(false);
    });
});

describe('symfonyMessengerPlugin.extract', () => {
    it('emits transport channels, logical channels and MANIFESTS_AS edges', () => {
        const yaml = `
framework:
  messenger:
    transports:
      inventory: 'amqp://rabbit.example.com:5672/prod'
      async-doctrine: 'doctrine://default'
    routing:
      'Acme\\\\Inventory\\\\Message\\\\OrderRequested': inventory
      'Acme\\\\Inventory\\\\Message\\\\OrderUpdated': [inventory, async-doctrine]
`;
        const result = symfonyMessengerPlugin.extract(yaml, ctx);

        // Meta-broker
        const metaBroker = result.entities.find(e =>
            e.labels.includes('MessageBroker') && e.properties.provider === 'symfony-messenger');
        expect(metaBroker).toBeDefined();

        // 2 transport channels (scope='transport')
        const transportChannels = result.entities.filter(e =>
            e.labels.includes('MessageChannel') && e.properties.scope === 'transport');
        expect(transportChannels).toHaveLength(2);

        // 2 logical channels (scope='logical') for the 2 message classes
        const logicalChannels = result.entities.filter(e =>
            e.labels.includes('MessageChannel') && e.properties.scope === 'logical');
        expect(logicalChannels).toHaveLength(2);

        // OrderUpdated logical channel has MANIFESTS_AS to both transports
        const updatedLogical = logicalChannels.find(e => (e.properties.name as string).endsWith('OrderUpdated'))!;
        const manifestsToTransports = updatedLogical.edges!.filter(e =>
            e.type === 'MANIFESTS_AS' && e.targetUrn.startsWith('cr:channel:transport:'));
        expect(manifestsToTransports).toHaveLength(2);

        // The inventory transport must have BACKED_BY to the physical AMQP channel
        const inventoryTransport = transportChannels.find(e => e.properties.name === 'inventory')!;
        const backedBy = inventoryTransport.edges!.find(e => e.type === 'BACKED_BY');
        expect(backedBy).toBeDefined();
        expect(backedBy!.targetUrn).toContain('cr:channel:queue:inventory@');

        // A physical RabbitMQ broker entity must be present
        const amqpBroker = result.entities.find(e =>
            e.labels.includes('MessageBroker') && e.properties.provider === 'rabbitmq');
        expect(amqpBroker).toBeDefined();
        expect(amqpBroker!.properties.host).toBe('rabbit.example.com');
    });

    it('honors a customer-declared broker (declaredVia=coderadius.yaml, confidence=1)', () => {
        registerBrokerDeclaration({
            id: 'rmq-prod',
            provider: 'rabbitmq',
            host: 'rabbit.example.com',
            port: 5672,
            vhost: '/prod',
            env: 'prod',
        });
        const yaml = `
framework:
  messenger:
    transports:
      inventory: 'amqp://rabbit.example.com:5672/prod'
    routing:
      'Acme\\\\Foo\\\\BarMessage': inventory
`;
        const result = symfonyMessengerPlugin.extract(yaml, ctx);
        const amqpBroker = result.entities.find(e =>
            e.labels.includes('MessageBroker') && e.properties.provider === 'rabbitmq');
        expect(amqpBroker).toBeDefined();
        expect(amqpBroker!.properties.declaredVia).toBe('coderadius.yaml');
        expect(amqpBroker!.properties.confidence).toBe(1.0);
        expect(amqpBroker!.properties.env).toBe('prod');
    });

    it('emits transport without BACKED_BY when DSN is fully placeholder', () => {
        const yaml = `
framework:
  messenger:
    transports:
      inventory: 'amqp://%env(RMQ_USER)%:%env(RMQ_PASS)%@%env(RMQ_HOST)%/'
    routing: {}
`;
        const result = symfonyMessengerPlugin.extract(yaml, ctx);
        const inventory = result.entities.find(e =>
            e.labels.includes('MessageChannel') && e.properties.name === 'inventory')!;
        const backedBy = inventory.edges!.find(e => e.type === 'BACKED_BY');
        expect(backedBy).toBeUndefined();
    });

    it('returns empty when YAML has no messenger block', () => {
        expect(symfonyMessengerPlugin.extract('framework:\n  doctrine: {}', ctx).entities).toHaveLength(0);
        expect(symfonyMessengerPlugin.extract('not valid:\n  yaml\n  -:\n', ctx).entities).toEqual([]);
    });

    it('does not crash when transports value is a structured object instead of string', () => {
        const yaml = `
framework:
  messenger:
    transports:
      inventory:
        dsn: 'amqp://rabbit/prod'
        options: { queue: { name: 'acme.orders' } }
    routing: {}
`;
        const result = symfonyMessengerPlugin.extract(yaml, ctx);
        const inventory = result.entities.find(e =>
            e.labels.includes('MessageChannel') && e.properties.name === 'inventory');
        expect(inventory).toBeDefined();
    });
});
