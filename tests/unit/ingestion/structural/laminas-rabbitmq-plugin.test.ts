import { describe, it, expect, beforeEach } from 'vitest';
import { laminasRabbitmqPlugin } from '../../../../src/ingestion/structural/plugins/messaging/laminas-rabbitmq.plugin.js';
import { clearMessageBrokerRegistry } from '../../../../src/ingestion/core/messaging/broker-registry.js';
import type { PluginContext } from '../../../../src/ingestion/structural/types.js';

const ctx: PluginContext = {
    relativePath: 'config/autoload/rabbitmq.global.php',
    absolutePath: '/tmp/fake/config/autoload/rabbitmq.global.php',
    repoName: 'acme/order-svc',
    repoUrn: 'cr:repository:acme/order-svc',
    scopeManager: {} as any,
};

beforeEach(() => clearMessageBrokerRegistry());

const FULL_SHAPE_A = `<?php
return [
    'rabbitmq' => [
        'connection' => [
            'default' => [
                'host' => Secret::read('RABBITMQ_HOST', 'rabbitmq'),
                'port' => 5672,
                'vhost' => '/',
            ],
        ],
        'producer' => [
            'order_events' => [
                'connection' => 'default',
                'exchange' => ['type' => 'fanout', 'name' => 'acme.order-events-exchange'],
                'queue' => ['name' => 'acme.order-events'],
            ],
            'metrics_only' => [
                'connection' => 'default',
                'exchange' => ['type' => 'fanout', 'name' => 'acme.metrics-exchange'],
            ],
        ],
        'consumer' => [
            'import_shipments' => [
                'connection' => 'default',
                'exchange' => ['name' => 'acme.renewals-import', 'type' => 'fanout'],
                'queue' => ['name' => 'acme.renewals-import', 'routing_keys' => ['acme.renewal.created']],
            ],
        ],
    ],
];
`;

describe('laminasRabbitmqPlugin.matchFile', () => {
    it('matches any .php file (permissive — content signature is the gate)', () => {
        expect(laminasRabbitmqPlugin.matchFile('config/autoload/rabbitmq.global.php', 'rabbitmq.global.php')).toBe(true);
        expect(laminasRabbitmqPlugin.matchFile('src/Anything.php', 'Anything.php')).toBe(true);
    });
    it('rejects non-php files', () => {
        expect(laminasRabbitmqPlugin.matchFile('config/rabbitmq.json', 'rabbitmq.json')).toBe(false);
        expect(laminasRabbitmqPlugin.matchFile('config/rabbitmq.yaml', 'rabbitmq.yaml')).toBe(false);
    });
});

describe('laminasRabbitmqPlugin contentSignatures', () => {
    const matches = (content: string) =>
        (laminasRabbitmqPlugin.contentSignatures ?? []).every(re => re.test(content));

    it('requires rabbitmq AND (producer OR consumer) AND exchange', () => {
        expect(matches(FULL_SHAPE_A)).toBe(true);
    });
    it('does not match a file missing the producer/consumer keyword', () => {
        const noProducer = `<?php return ['rabbitmq' => ['connection' => ['default' => []]]];`;
        expect(matches(noProducer)).toBe(false);
    });
    it('does not match a file missing the exchange keyword', () => {
        const noExchange = `<?php return ['rabbitmq' => ['producer' => ['x' => ['queue' => ['name' => 'q']]]]];`;
        expect(matches(noExchange)).toBe(false);
    });
});

describe('laminasRabbitmqPlugin.extract — shape A', () => {
    it('emits exchanges (kind exchange) and queues (kind queue) with literal names', () => {
        const result = laminasRabbitmqPlugin.extract(FULL_SHAPE_A, ctx);

        const channels = result.entities.filter(e => e.labels.includes('MessageChannel'));
        const exchanges = channels.filter(e => e.properties.channelKind === 'exchange');
        const queues = channels.filter(e => e.properties.channelKind === 'queue');

        const exchangeNames = exchanges.map(e => e.properties.name).sort();
        const queueNames = queues.map(e => e.properties.name).sort();

        expect(exchangeNames).toEqual([
            'acme.metrics-exchange',
            'acme.order-events-exchange',
            'acme.renewals-import',
        ]);
        expect(queueNames).toEqual([
            'acme.order-events',
            'acme.renewals-import',
        ]);

        for (const ch of channels) {
            expect(ch.properties.technology).toBe('rabbitmq');
            expect(ch.properties.discoverySource).toBe('config');
            expect(ch.properties.scope).toBe('physical');
        }
    });

    it('emits an exchange-only entity for a producer without a queue', () => {
        const result = laminasRabbitmqPlugin.extract(FULL_SHAPE_A, ctx);
        const metrics = result.entities.filter(e =>
            e.labels.includes('MessageChannel') && e.properties.name === 'acme.metrics-exchange');
        expect(metrics).toHaveLength(1);
        expect(metrics[0].properties.channelKind).toBe('exchange');
        // No queue should carry the metrics name.
        const metricsQueue = result.entities.filter(e =>
            e.properties.channelKind === 'queue' && e.properties.name === 'acme.metrics-exchange');
        expect(metricsQueue).toHaveLength(0);
    });

    it('skips entries whose exchange/queue names are non-literal (Secret::read → null)', () => {
        const dynamic = `<?php
return [
    'rabbitmq' => [
        'producer' => [
            'dyn' => [
                'exchange' => ['type' => 'fanout', 'name' => Secret::read('EXCHANGE_NAME')],
                'queue' => ['name' => getenv('QUEUE_NAME')],
            ],
        ],
    ],
];
`;
        const result = laminasRabbitmqPlugin.extract(dynamic, ctx);
        const channels = result.entities.filter(e => e.labels.includes('MessageChannel'));
        expect(channels).toHaveLength(0);
    });

    it('returns empty for a php file without the content signatures', () => {
        const unrelated = `<?php return ['doctrine' => ['orm' => []]];`;
        const result = laminasRabbitmqPlugin.extract(unrelated, ctx);
        expect(result.entities).toHaveLength(0);
    });

    it('emits channels WITHOUT a broker node when no host literal is available', () => {
        const result = laminasRabbitmqPlugin.extract(FULL_SHAPE_A, ctx);
        const brokers = result.entities.filter(e => e.labels.includes('MessageBroker'));
        expect(brokers).toHaveLength(0);
        // Channels still have no brokerUrn binding (host was Secret::read → unresolved).
        const channels = result.entities.filter(e => e.labels.includes('MessageChannel'));
        for (const ch of channels) {
            expect(ch.properties.brokerUrn ?? null).toBeNull();
        }
    });
});

describe('connectionRef (channel ↔ connection binding keys, B5)', () => {
    it('stamps connectionRef from the entry connection and _repoUrn from the context', () => {
        const result = laminasRabbitmqPlugin.extract(FULL_SHAPE_A, ctx);
        const channels = result.entities.filter(e => e.labels.includes('MessageChannel'));
        expect(channels.length).toBeGreaterThan(0);
        for (const ch of channels) {
            expect(ch.properties.connectionRef).toBe('default');
            expect(ch.properties._repoUrn).toBe('cr:repository:acme/order-svc');
        }
    });

    it('uses the declared connection name per entry, defaulting to "default" when absent', () => {
        const multi = `<?php
return [
    'rabbitmq' => [
        'producer' => [
            'notifications_out' => [
                'connection' => 'notifications',
                'exchange' => ['type' => 'topic', 'name' => 'acme.notifications'],
            ],
            'legacy_out' => [
                'exchange' => ['type' => 'fanout', 'name' => 'acme.legacy'],
            ],
        ],
    ],
];
`;
        const result = laminasRabbitmqPlugin.extract(multi, ctx);
        const byName = new Map(result.entities
            .filter(e => e.labels.includes('MessageChannel'))
            .map(e => [e.properties.name, e.properties.connectionRef]));
        expect(byName.get('acme.notifications')).toBe('notifications');
        expect(byName.get('acme.legacy')).toBe('default');
    });
});

describe('provenance for orphan-GC liveness', () => {
    it('every emitted channel carries _sourcePath = the config file path', async () => {
        const { laminasRabbitmqPlugin } = await import('../../../../src/ingestion/structural/plugins/messaging/laminas-rabbitmq.plugin.js');
        const content = `<?php
return ['rabbitmq' => ['producer' => ['order_events' => [
    'connection' => 'default',
    'exchange' => ['type' => 'fanout', 'name' => 'acme.order-events-exchange'],
]]]];`;
        const ctx = {
            relativePath: 'config/autoload/rabbitmq.global.php',
            absolutePath: '/tmp/fake/config/autoload/rabbitmq.global.php',
            repoName: 'acme/orders', repoUrn: 'cr:repository:acme/orders',
            scopeManager: {},
        };
        const result = laminasRabbitmqPlugin.extract(content, ctx as never);
        const channels = result.entities.filter((e: { labels: string[] }) => e.labels.includes('MessageChannel'));
        expect(channels.length).toBeGreaterThan(0);
        for (const c of channels) {
            expect(c.properties._sourcePath).toBe('config/autoload/rabbitmq.global.php');
        }
    });
});
