import { describe, it, expect } from 'vitest';
import { RepoHintsSchema, resolveMessageChannelAlias } from '../../../src/config/repo-hints.js';

// ═════════════════════════════════════════════════════════════════════════════
// coderadius.yaml Schema Validation — Unit Tests
//
// Tests that the Zod schema correctly validates, defaults, and rejects
// the 4 top-level configuration blocks: packages, decorators, databases, hints.
// ═════════════════════════════════════════════════════════════════════════════

describe('RepoHintsSchema — packages', () => {
    it('should accept valid packages block', () => {
        const result = RepoHintsSchema.parse({
            packages: {
                analyze: ['@acme/messaging'],
                ignore: ['@sentry/node'],
            },
        });

        expect(result.packages!.analyze).toEqual(['@acme/messaging']);
        expect(result.packages!.ignore).toEqual(['@sentry/node']);
    });

    it('should default empty arrays when packages is provided with no children', () => {
        const result = RepoHintsSchema.parse({ packages: {} });
        expect(result.packages!.analyze).toEqual([]);
        expect(result.packages!.ignore).toEqual([]);
    });

    it('should allow missing packages (optional)', () => {
        const result = RepoHintsSchema.parse({});
        expect(result.packages).toBeUndefined();
    });
});

describe('RepoHintsSchema — decorators', () => {
    it('should accept valid decorators', () => {
        const result = RepoHintsSchema.parse({
            decorators: [
                { name: 'MessageConsumer', kind: 'message-consumer', args: ['routingKey'] },
                { name: 'CustomScheduled', kind: 'scheduled-job', args: ['cron'] },
            ],
        });

        expect(result.decorators).toHaveLength(2);
        expect(result.decorators[0].name).toBe('MessageConsumer');
        expect(result.decorators[0].kind).toBe('message-consumer');
    });

    it('should reject invalid kind enum value', () => {
        expect(() => RepoHintsSchema.parse({
            decorators: [{ name: 'Test', kind: 'invalid-kind' }],
        })).toThrow();
    });

    it('should default args to standard message consumer keys', () => {
        const result = RepoHintsSchema.parse({
            decorators: [{ name: 'MyConsumer', kind: 'message-consumer' }],
        });
        expect(result.decorators[0].args).toEqual([
            'routingKey', 'queue', 'name', 'topic',
        ]);
    });

    it('should accept all three decorator kinds', () => {
        const result = RepoHintsSchema.parse({
            decorators: [
                { name: 'A', kind: 'message-consumer' },
                { name: 'B', kind: 'http-route' },
                { name: 'C', kind: 'scheduled-job' },
            ],
        });
        expect(result.decorators).toHaveLength(3);
    });

    it('should default to empty array when not provided', () => {
        const result = RepoHintsSchema.parse({});
        expect(result.decorators).toEqual([]);
    });
});

describe('RepoHintsSchema — databases', () => {
    it('should accept valid databases', () => {
        const result = RepoHintsSchema.parse({
            databases: [
                { id: 'main-mysql', technology: 'mysql', tables: ['orders', 'users'] },
                { id: 'redis-cache', technology: 'redis' },
            ],
        });

        expect(result.databases).toHaveLength(2);
        expect(result.databases[0].id).toBe('main-mysql');
        expect(result.databases[0].tables).toEqual(['orders', 'users']);
        expect(result.databases[1].tables).toEqual([]); // default
    });

    it('should default shared to false', () => {
        const result = RepoHintsSchema.parse({
            databases: [{ id: 'db', technology: 'postgres' }],
        });
        expect(result.databases[0].shared).toBe(false);
    });

    it('should accept shared: true', () => {
        const result = RepoHintsSchema.parse({
            databases: [{ id: 'shared-db', technology: 's3', shared: true }],
        });
        expect(result.databases[0].shared).toBe(true);
    });
});

describe('RepoHintsSchema — hints', () => {
    it('should accept valid hints', () => {
        const result = RepoHintsSchema.parse({
            hints: [
                {
                    patterns: ['MessageEmitterService', 'emitEvent'],
                    description: 'Wrapper RabbitMQ. emit*() = WRITES MessageChannel.',
                },
            ],
        });

        expect(result.hints).toHaveLength(1);
        expect(result.hints[0].patterns).toEqual(['MessageEmitterService', 'emitEvent']);
    });

    it('should default to empty array when not provided', () => {
        const result = RepoHintsSchema.parse({});
        expect(result.hints).toEqual([]);
    });
});

describe('RepoHintsSchema — message_channels', () => {
    it('accepts explicit message channel aliases', () => {
        const result = RepoHintsSchema.parse({
            message_channels: {
                aliases: [
                    {
                        from: 'data_backbone.topics.sample_user',
                        name: 'Platform-SampleUser',
                        channelKind: 'topic',
                        technology: 'pubsub',
                        schemaPath: './schemas/SampleUser.avsc',
                        schemaFormat: 'avro',
                    },
                    {
                        from: 'data_backbone.subscriptions.sample_user',
                        name: 'Platform-SampleUserSubscription',
                        channelKind: 'subscription',
                        topic: 'Platform-SampleUser',
                    },
                ],
            },
        });

        expect(result.message_channels.aliases).toHaveLength(2);
        expect(resolveMessageChannelAlias(result, 'data_backbone.topics.sample_user')?.name).toBe('Platform-SampleUser');
        expect(resolveMessageChannelAlias(result, 'missing')).toBeUndefined();
    });

    it('defaults aliases to empty array', () => {
        const result = RepoHintsSchema.parse({});
        expect(result.message_channels.aliases).toEqual([]);
    });
});

describe('RepoHintsSchema — empty config', () => {
    it('should accept empty object with all defaults', () => {
        const result = RepoHintsSchema.parse({});
        expect(result.decorators).toEqual([]);
        expect(result.databases).toEqual([]);
        expect(result.hints).toEqual([]);
        expect(result.message_channels.aliases).toEqual([]);
        expect(result.packages).toBeUndefined();
    });
});
