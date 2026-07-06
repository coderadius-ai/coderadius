import { describe, it, expect } from 'vitest';
import { RepoHintsSchema } from '../../../src/config/repo-hints.js';

describe('RepoHintsSchema — messageBrokers', () => {
    it('accepts a minimal RabbitMQ broker declaration', () => {
        const parsed = RepoHintsSchema.parse({
            messageBrokers: [
                { id: 'rmq-prod-eu', provider: 'rabbitmq', host: 'rmq.eu.internal' },
            ],
        });
        expect(parsed.messageBrokers).toHaveLength(1);
        expect(parsed.messageBrokers[0].id).toBe('rmq-prod-eu');
        expect(parsed.messageBrokers[0].provider).toBe('rabbitmq');
    });

    it('defaults to empty array when omitted', () => {
        const parsed = RepoHintsSchema.parse({});
        expect(parsed.messageBrokers).toEqual([]);
    });

    it('accepts every supported provider', () => {
        const providers = [
            'rabbitmq', 'kafka', 'pubsub', 'sqs', 'sns', 'azure-service-bus',
            'nats', 'pulsar', 'redis-streams', 'mqtt', 'mosquitto', 'zeromq',
            'symfony-messenger',
        ] as const;
        for (const provider of providers) {
            const parsed = RepoHintsSchema.parse({
                messageBrokers: [{ id: `broker-${provider}`, provider }],
            });
            expect(parsed.messageBrokers[0].provider).toBe(provider);
        }
    });

    it('rejects unknown provider', () => {
        const result = RepoHintsSchema.safeParse({
            messageBrokers: [{ id: 'bogus', provider: 'nope' }],
        });
        expect(result.success).toBe(false);
    });

    it('accepts vhost, env, region, cluster, fingerprint override', () => {
        const parsed = RepoHintsSchema.parse({
            messageBrokers: [{
                id: 'rmq-prod-eu',
                provider: 'rabbitmq',
                host: 'rmq.eu.internal',
                port: 5672,
                vhost: '/prod',
                env: 'prod',
                region: 'eu-west-1',
                cluster: 'rmq-cluster-1',
                fingerprint: 'custom8x',
            }],
        });
        const b = parsed.messageBrokers[0];
        expect(b.vhost).toBe('/prod');
        expect(b.env).toBe('prod');
        expect(b.region).toBe('eu-west-1');
        expect(b.cluster).toBe('rmq-cluster-1');
        expect(b.fingerprint).toBe('custom8x');
        expect(b.port).toBe(5672);
    });
});

describe('RepoHintsSchema — message_channels.mirrors', () => {
    it('accepts a cross-broker mirror declaration', () => {
        const parsed = RepoHintsSchema.parse({
            messageBrokers: [
                { id: 'rmq-eu', provider: 'rabbitmq', host: 'eu.rmq' },
                { id: 'rmq-us', provider: 'rabbitmq', host: 'us.rmq' },
            ],
            message_channels: {
                mirrors: [
                    {
                        logical: 'OrderCreated',
                        physical: [
                            { broker: 'rmq-eu', channel: 'acme.orders', kind: 'topic' },
                            { broker: 'rmq-us', channel: 'acme.orders', kind: 'topic' },
                        ],
                    },
                ],
            },
        });
        expect(parsed.message_channels.mirrors).toHaveLength(1);
        expect(parsed.message_channels.mirrors[0].physical).toHaveLength(2);
        // Default kind is 'topic'
        expect(parsed.message_channels.mirrors[0].kind).toBe('topic');
    });

    it('defaults mirrors to [] when omitted', () => {
        const parsed = RepoHintsSchema.parse({});
        expect(parsed.message_channels.mirrors).toEqual([]);
    });

    it('rejects mirrors with empty physical array', () => {
        const result = RepoHintsSchema.safeParse({
            message_channels: {
                mirrors: [{ logical: 'X', physical: [] }],
            },
        });
        expect(result.success).toBe(false);
    });

    it('rejects mirror physical entry with unknown kind', () => {
        const result = RepoHintsSchema.safeParse({
            message_channels: {
                mirrors: [{
                    logical: 'X',
                    physical: [{ broker: 'b', channel: 'c', kind: 'stream' as never }],
                }],
            },
        });
        expect(result.success).toBe(false);
    });

    it('preserves legacy aliases field alongside mirrors', () => {
        const parsed = RepoHintsSchema.parse({
            message_channels: {
                aliases: [{ from: 'foo.alias', name: 'Foo', channelKind: 'topic' }],
                mirrors: [{
                    logical: 'OrderCreated',
                    physical: [{ broker: 'b', channel: 'c', kind: 'topic' }],
                }],
            },
        });
        expect(parsed.message_channels.aliases).toHaveLength(1);
        expect(parsed.message_channels.mirrors).toHaveLength(1);
    });
});
