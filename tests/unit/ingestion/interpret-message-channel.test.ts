import { describe, it, expect } from 'vitest';
import {
    interpretMessageChannel,
    resolveMessageChannelName,
    type MessageChannelInfraItem,
    type MessageChannelInterpretContext,
} from '../../../src/ingestion/processors/code-pipeline/interpret/message-channel.js';
import { buildMessageChannelUrn } from '../../../src/graph/mutations/data-contracts.js';
import type { EnvVarBinding } from '../../../src/ingestion/processors/infra-manifest-resolver.js';
import type { GraphDelta, EdgeUpsert, NodeUpsert } from '../../../src/graph/write-model/delta.js';

// interpretMessageChannel pins the decision logic extracted
// from persistFunction's MessageChannel case — env-var name resolution, yaml
// alias resolution, grounding precedence (groundingForInfra), routingKey edge
// identity, subscription→topic sibling routing, schema-link intents.

const FN_ID = 'acme/inventory:src/orders.php:publishOrder';
const COMMIT = 'commit-ch-1';

function ctx(over: Partial<MessageChannelInterpretContext> = {}): MessageChannelInterpretContext {
    return {
        functionId: FN_ID,
        commitHash: COMMIT,
        repoHints: { databases: [], decorators: [], hints: [] },
        envVarDict: new Map<string, EnvVarBinding>(),
        ...over,
    };
}

function item(over: Partial<MessageChannelInfraItem> = {}): MessageChannelInfraItem {
    return { name: 'order-events', operation: 'WRITES', channelKind: 'topic', ...over };
}

function nodes(delta: GraphDelta, label: string): NodeUpsert[] {
    return delta.nodes.filter(n => n.label === label);
}

function edges(delta: GraphDelta, type: string): EdgeUpsert[] {
    return delta.edges.filter(e => e.type === type);
}

describe('interpretMessageChannel — basic publish', () => {
    const { delta, traces, schemaLinks } = interpretMessageChannel(item({ technology: 'rabbitmq' }), ctx());
    const chUrn = buildMessageChannelUrn('order-events', 'topic');

    it('emits the logical MessageChannel with mutation-parity props', () => {
        const [ch] = nodes(delta, 'MessageChannel');
        expect(ch.urn).toBe(chUrn);
        expect(ch.propsOnce).toEqual({ name: 'order-events', valid_from_commit: COMMIT });
        expect(ch.props).toMatchObject({
            valid_to_commit: null, channelKind: 'topic', technology: 'rabbitmq', scope: 'logical',
        });
        expect(ch.grounding.source).toBe('llm');
        expect(ch.grounding.quality).toBe('medium');
    });

    it('WRITES → PUBLISHES_TO with routingKey (null) in the edge identity', () => {
        const [pub] = edges(delta, 'PUBLISHES_TO');
        expect(pub.from).toEqual({ label: 'Function', urn: FN_ID });
        expect(pub.to).toEqual({ label: 'MessageChannel', urn: chUrn });
        expect(pub.keyProps).toEqual({ routingKey: null });
        expect(pub.propsOnce).toEqual({ valid_from_commit: COMMIT });
        expect(pub.props).toEqual({ valid_to_commit: null });
    });

    it('no schema path → no schema-link intents; WRITE trace emitted', () => {
        expect(schemaLinks).toEqual([]);
        expect(traces.some(t => t.action === 'WRITE' && t.target === 'channel:order-events')).toBe(true);
    });
});

describe('interpretMessageChannel — operations and edge metadata', () => {
    it('READS → LISTENS_TO carrying consumerGroup', () => {
        const { delta } = interpretMessageChannel(
            item({ operation: 'READS', consumerGroup: 'inventory-workers' }),
            ctx(),
        );
        const [listens] = edges(delta, 'LISTENS_TO');
        expect(listens.props).toMatchObject({ consumerGroup: 'inventory-workers' });
        expect(edges(delta, 'PUBLISHES_TO')).toHaveLength(0);
    });

    it('routingKey participates in the edge identity; partitionKey rides as a prop on publish', () => {
        const { delta } = interpretMessageChannel(
            item({ routingKey: 'order.created', partitionKey: 'orderId' }),
            ctx(),
        );
        const [pub] = edges(delta, 'PUBLISHES_TO');
        expect(pub.keyProps).toEqual({ routingKey: 'order.created' });
        expect(pub.props).toMatchObject({ partitionKey: 'orderId' });
    });
});

describe('interpretMessageChannel — name resolution', () => {
    it('env-var dictionary resolves the channel name and demotes grounding via fallback', () => {
        const envVarDict = new Map<string, EnvVarBinding>([
            ['MY_TOPIC_NAME', { value: 'Acme-OrderCreated', sourceFile: '.env.production', confidence: 0.9 }],
        ]);
        const { delta, logs } = interpretMessageChannel(item({ name: 'myTopicName' }), ctx({ envVarDict }));

        const [ch] = nodes(delta, 'MessageChannel');
        expect(ch.urn).toBe(buildMessageChannelUrn('Acme-OrderCreated', 'topic'));
        expect(ch.grounding.evidence.fallbacksApplied).toContain('env-var-stem-normalize');
        expect(logs.some(l => l.message.includes('Acme-OrderCreated'))).toBe(true);
    });

    it('yaml alias renames the channel and carries tags + schema format inferred from path', () => {
        const hints = {
            databases: [], decorators: [], hints: [],
            message_channels: {
                aliases: [{
                    from: 'order-events',
                    name: 'acme.order.events',
                    channelKind: 'topic',
                    schemaPath: 'schemas/order_created.avsc',
                    tags: ['orders'],
                }],
            },
        } as MessageChannelInterpretContext['repoHints'];
        const { delta, schemaLinks } = interpretMessageChannel(item(), ctx({ repoHints: hints }));

        const [ch] = nodes(delta, 'MessageChannel');
        expect(ch.urn).toBe(buildMessageChannelUrn('acme.order.events', 'topic'));
        expect(ch.props).toMatchObject({ schemaPath: 'schemas/order_created.avsc', schemaFormat: 'avro', tags: ['orders'] });
        expect(schemaLinks).toEqual([
            { channelName: 'acme.order.events', channelUrn: ch.urn, schemaPath: 'schemas/order_created.avsc' },
        ]);
    });
});

describe('interpretMessageChannel — subscription routing', () => {
    it('a subscription with a topic emits the sibling topic node and a ROUTES_TO edge', () => {
        const hints = {
            databases: [], decorators: [], hints: [],
            message_channels: {
                aliases: [{
                    from: 'order-sub',
                    name: 'order-subscription',
                    channelKind: 'subscription',
                    topic: 'acme.order.events',
                }],
            },
        } as MessageChannelInterpretContext['repoHints'];
        const { delta } = interpretMessageChannel(item({ name: 'order-sub' }), ctx({ repoHints: hints }));

        const channels = nodes(delta, 'MessageChannel');
        expect(channels.map(c => c.urn).sort()).toEqual([
            buildMessageChannelUrn('order-subscription', 'subscription'),
            buildMessageChannelUrn('acme.order.events', 'topic'),
        ].sort());

        const [routes] = edges(delta, 'ROUTES_TO');
        expect(routes.from.urn).toBe(buildMessageChannelUrn('order-subscription', 'subscription'));
        expect(routes.to.urn).toBe(buildMessageChannelUrn('acme.order.events', 'topic'));
        expect(routes.keyProps).toEqual({ bindingKey: '' });
    });
});

describe('interpretMessageChannel — grounding precedence', () => {
    it('explicit infra.grounding wins; source=ast routes to framework-signal overlay', () => {
        const explicit = {
            source: 'ast' as const, quality: 'exact' as const,
            evidence: { extractors: ['di-binding-resolver@v1'] },
        };
        const withExplicit = interpretMessageChannel(item({ grounding: explicit }), ctx());
        expect(nodes(withExplicit.delta, 'MessageChannel')[0].grounding.evidence.extractors).toEqual(['di-binding-resolver@v1']);

        const fromOverlay = interpretMessageChannel(item({ source: 'ast' }), ctx());
        expect(nodes(fromOverlay.delta, 'MessageChannel')[0].grounding.evidence.extractors).toEqual(['framework-signal-overlay@v1']);
    });

    it('resolved_via promotes the LLM default to composite', () => {
        const { delta } = interpretMessageChannel(item({ resolved_via: 'di-registry' }), ctx());
        expect(nodes(delta, 'MessageChannel')[0].grounding.source).toBe('composite');
    });
});

describe('resolveMessageChannelName (moved from graph-writer)', () => {
    const dict = new Map<string, EnvVarBinding>([
        ['MY_TOPIC_NAME', { value: 'Acme-OrderCreated', sourceFile: '.env', confidence: 0.9 }],
    ]);

    it('resolves direct uppercase and camelCase names; passes unknown through', () => {
        expect(resolveMessageChannelName('MY_TOPIC_NAME', dict)).toBe('Acme-OrderCreated');
        expect(resolveMessageChannelName('myTopicName', dict)).toBe('Acme-OrderCreated');
        expect(resolveMessageChannelName('other', dict)).toBe('other');
    });
});
