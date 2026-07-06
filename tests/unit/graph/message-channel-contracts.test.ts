import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/graph/mutations/_run', () => ({
    run: vi.fn().mockResolvedValue({ records: [] }),
    groundingParams: () => ({}),
    groundingWriteClause: () => '',
}));

import { run } from '../../../src/graph/mutations/_run.js';
import {
    deleteOrphanMessageChannels,
    linkChannelToSchema,
    linkFunctionToBroker,
    mergeMessageChannelWithKind,
} from '../../../src/graph/mutations/data-contracts.js';
import { buildUrn } from '../../../src/graph/urn.js';
import { MessageChannelSchema } from '../../../src/graph/domain.js';
import { DEPENDENCY_RELS } from '../../../src/graph/constants.js';
import { GRAPH_SCHEMA } from '../../../src/graph/schema.js';

const mockRun = vi.mocked(run);

beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({ records: [] } as any);
});

describe('MessageChannel graph contract', () => {
    it('accepts PubSub topic/subscription metadata on MessageChannel', () => {
        const parsed = MessageChannelSchema.parse({
            id: buildUrn('channel', 'topic', 'Platform-SampleUser'),
            name: 'Platform-SampleUser',
            technology: 'pubsub',
            resolved_via: 'di_registry',
            channelKind: 'topic',
            schemaFormat: 'avro',
            schemaPath: './schemas/SampleUser.avsc',
        });

        expect(parsed.channelKind).toBe('topic');
        expect(parsed.schemaFormat).toBe('avro');
        expect(parsed.schemaPath).toBe('./schemas/SampleUser.avsc');
    });

    it('registers ROUTES_TO as architectural dependency relationship', () => {
        expect(DEPENDENCY_RELS).toContain('ROUTES_TO');
        // Schema doc string now annotates ROUTES_TO with its binding properties;
        // assert the substring rather than exact text.
        expect(GRAPH_SCHEMA.relationships.some(r =>
            r.includes('(MessageChannel)') && r.includes(':ROUTES_TO') && r.endsWith('->(MessageChannel)'),
        )).toBe(true);
        expect(GRAPH_SCHEMA.relationships).toContain('(MessageChannel)-[:HAS_SCHEMA]->(DataStructure)');
    });
});

describe('MessageChannel mutations', () => {
    const PROV = { source: 'ast' as const, quality: 'exact' as const, evidence: { extractors: ['test@v1'] } };

    it('merges a topic with kinded URN and schema metadata', async () => {
        await mergeMessageChannelWithKind(
            'Platform-SampleUser',
            'topic',
            'pubsub',
            'abc123',
            {
                schemaPath: './schemas/SampleUser.avsc',
                schemaFormat: 'avro',
                grounding: PROV,
            },
        );

        expect(mockRun).toHaveBeenCalledTimes(1);
        const params = mockRun.mock.calls[0][1] as any;
        expect(params).toMatchObject({
            urn: buildUrn('channel', 'topic', 'Platform-SampleUser'),
            name: 'Platform-SampleUser',
            channelKind: 'topic',
            technology: 'pubsub',
            schemaPath: './schemas/SampleUser.avsc',
            schemaFormat: 'avro',
            commitHash: 'abc123',
        });
    });

    it('merges a subscription with sub URN segment', async () => {
        await mergeMessageChannelWithKind(
            'Platform-SampleUser-FiscalCodeSubscription',
            'subscription',
            'pubsub',
            'abc123',
            { grounding: PROV },
        );

        const params = mockRun.mock.calls[0][1] as any;
        expect(params.urn).toBe(buildUrn('channel', 'sub', 'Platform-SampleUser-FiscalCodeSubscription'));
        expect(params.channelKind).toBe('subscription');
    });


    // ── Gotcha #1: identity-aware MERGE on ROUTES_TO ────────────────────────
    // AMQP allows multiple bindings (src → tgt) with different routing keys.
    // The MERGE pattern MUST embed the binding-key in the relationship pattern
    // so two distinct bindings produce two distinct edges instead of collapsing.





    it('links a channel to its message payload schema', async () => {
        const channelUrn = buildUrn('channel', 'topic', 'Platform-SampleUser');
        const schemaUrn = buildUrn('schema', 'message_payload', 'Platform.SampleUser');

        await linkChannelToSchema(channelUrn, schemaUrn, 'abc123');

        const [query, params] = mockRun.mock.calls[0] as [string, any];
        expect(query).toContain('HAS_SCHEMA');
        expect(params).toMatchObject({ channelUrn, schemaUrn, commitHash: 'abc123' });
    });

    it('links functions to kinded topic/subscription nodes when channelKind is provided', async () => {
        await linkFunctionToBroker(
            'cr:function:test:ts:Publisher.publish',
            'Platform-SampleUser',
            'PUBLISHES_TO',
            'abc123',
            'topic',
        );

        const params = mockRun.mock.calls[0][1] as any;
        expect(params.brokerUrn).toBe(buildUrn('channel', 'topic', 'Platform-SampleUser'));
        expect(params.channelKind).toBe('topic');
    });

    it('soft-tombstones orphan message channels while preserving active subscription links', async () => {
        await deleteOrphanMessageChannels('abc123');

        expect(mockRun).toHaveBeenCalledTimes(1);
        const [query, params] = mockRun.mock.calls[0] as [string, any];
        expect(query).toContain('SET ch.valid_to_commit = $commitHash');
        expect(query).toContain('PUBLISHES_TO');
        expect(query).toContain('LISTENS_TO');
        expect(query).toContain('ROUTES_TO');
        expect(query).toContain('[:ROUTES_TO*0..]');
        expect(query).toContain('relationships(path)');
        expect(query).toContain('nodes(path)');
        expect(query).toContain('count(path) AS activePaths');
        expect(query).not.toContain('outgoing:ROUTES_TO');
        expect(query).not.toContain('count(DISTINCT topic)');
        expect(params.commitHash).toBe('abc123');
    });
});
