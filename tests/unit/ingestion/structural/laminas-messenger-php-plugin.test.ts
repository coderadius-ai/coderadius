import { describe, it, expect, beforeEach } from 'vitest';
import { laminasMessengerPhpPlugin } from '../../../../src/ingestion/structural/plugins/messaging/laminas-messenger-php.plugin.js';
import { clearMessageBrokerRegistry } from '../../../../src/ingestion/core/messaging/broker-registry.js';
import type { PluginContext } from '../../../../src/ingestion/structural/types.js';

const ctx: PluginContext = {
    relativePath: 'config/autoload/messenger.global.php',
    absolutePath: '/tmp/fake/config/autoload/messenger.global.php',
    repoName: 'acme/order-svc',
    repoUrn: 'cr:repository:acme/order-svc',
    scopeManager: {} as any,
};

beforeEach(() => clearMessageBrokerRegistry());

const SHAPE_B_WRAPPED = `<?php
return [
    'symfony' => [
        'messenger' => [
            'transports' => [
                'messenger.transport.async' => [
                    'dsn' => 'amqp://',
                    'options' => [
                        'exchange' => ['name' => 'acme.messenger_normal'],
                        'queues' => ['acme.messenger_normal' => []],
                    ],
                ],
                'messenger.transport.sync' => 'sync://',
            ],
        ],
    ],
];
`;

const SHAPE_B_UNWRAPPED = `<?php
return [
    'messenger' => [
        'transports' => [
            'messenger.transport.high' => [
                'dsn' => 'amqp://',
                'options' => [
                    'exchange' => ['name' => 'acme.messenger_high'],
                    'queues' => ['acme.messenger_high' => [], 'acme.messenger_high_retry' => []],
                ],
            ],
        ],
    ],
];
`;

describe('laminasMessengerPhpPlugin.matchFile', () => {
    it('matches any .php file (permissive)', () => {
        expect(laminasMessengerPhpPlugin.matchFile('config/autoload/messenger.global.php', 'messenger.global.php')).toBe(true);
    });
    it('rejects non-php', () => {
        expect(laminasMessengerPhpPlugin.matchFile('config/messenger.yaml', 'messenger.yaml')).toBe(false);
    });
});

describe('laminasMessengerPhpPlugin contentSignatures', () => {
    const matches = (content: string) =>
        (laminasMessengerPhpPlugin.contentSignatures ?? []).every(re => re.test(content));

    it('matches the wrapped and unwrapped messenger shapes', () => {
        expect(matches(SHAPE_B_WRAPPED)).toBe(true);
        expect(matches(SHAPE_B_UNWRAPPED)).toBe(true);
    });
    it('does not match a file without messenger transports', () => {
        expect(matches(`<?php return ['doctrine' => []];`)).toBe(false);
    });
});

describe('laminasMessengerPhpPlugin.extract — shape B', () => {
    it('emits exchange + queue channels for an amqp array transport (wrapped)', () => {
        const result = laminasMessengerPhpPlugin.extract(SHAPE_B_WRAPPED, ctx);
        const channels = result.entities.filter(e => e.labels.includes('MessageChannel'));
        const exchanges = channels.filter(e => e.properties.channelKind === 'exchange');
        const queues = channels.filter(e => e.properties.channelKind === 'queue');

        expect(exchanges.map(e => e.properties.name)).toEqual(['acme.messenger_normal']);
        expect(queues.map(e => e.properties.name)).toEqual(['acme.messenger_normal']);

        for (const ch of channels) {
            expect(ch.properties.technology).toBe('rabbitmq');
            expect(ch.properties.discoverySource).toBe('config');
        }
    });

    it('never emits the transport DI id as a channel', () => {
        const result = laminasMessengerPhpPlugin.extract(SHAPE_B_WRAPPED, ctx);
        const names = result.entities
            .filter(e => e.labels.includes('MessageChannel'))
            .map(e => e.properties.name as string);
        expect(names).not.toContain('messenger.transport.async');
        expect(names).not.toContain('messenger.transport.sync');
    });

    it('skips string transports (sync://) entirely', () => {
        const result = laminasMessengerPhpPlugin.extract(SHAPE_B_WRAPPED, ctx);
        const names = result.entities
            .filter(e => e.labels.includes('MessageChannel'))
            .map(e => e.properties.name as string);
        // Only the async transport produced channels; sync produced nothing.
        expect(names.sort()).toEqual(['acme.messenger_normal', 'acme.messenger_normal']);
    });

    it('supports the unwrapped shape and multiple queues', () => {
        const result = laminasMessengerPhpPlugin.extract(SHAPE_B_UNWRAPPED, ctx);
        const channels = result.entities.filter(e => e.labels.includes('MessageChannel'));
        const exchanges = channels.filter(e => e.properties.channelKind === 'exchange');
        const queues = channels.filter(e => e.properties.channelKind === 'queue').map(e => e.properties.name).sort();

        expect(exchanges.map(e => e.properties.name)).toEqual(['acme.messenger_high']);
        expect(queues).toEqual(['acme.messenger_high', 'acme.messenger_high_retry']);
    });

    it('skips transports without amqp options', () => {
        const noAmqp = `<?php
return [
    'messenger' => [
        'transports' => [
            'messenger.transport.doctrine' => ['dsn' => 'doctrine://default'],
        ],
    ],
];
`;
        const result = laminasMessengerPhpPlugin.extract(noAmqp, ctx);
        expect(result.entities.filter(e => e.labels.includes('MessageChannel'))).toHaveLength(0);
    });

    it('returns empty for a php file without the content signatures', () => {
        expect(laminasMessengerPhpPlugin.extract(`<?php return ['app' => []];`, ctx).entities).toHaveLength(0);
    });
});

describe('connectionRef (channel ↔ connection binding keys, B5)', () => {
    it('stamps the transport name as connectionRef and _repoUrn from the context', () => {
        const result = laminasMessengerPhpPlugin.extract(SHAPE_B_WRAPPED, ctx);
        const channels = result.entities.filter(e => e.labels.includes('MessageChannel'));
        expect(channels.length).toBeGreaterThan(0);
        for (const ch of channels) {
            expect(ch.properties.connectionRef).toBe('messenger.transport.async');
            expect(ch.properties._repoUrn).toBe('cr:repository:acme/order-svc');
        }
    });

    it('each transport channels carry THEIR transport name', () => {
        const result = laminasMessengerPhpPlugin.extract(SHAPE_B_UNWRAPPED, ctx);
        const channels = result.entities.filter(e => e.labels.includes('MessageChannel'));
        for (const ch of channels) {
            expect(ch.properties.connectionRef).toBe('messenger.transport.high');
        }
    });
});
