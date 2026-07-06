import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DeepUnifiedAnalysisSchema } from '../../src/ai/agents/unified-analyzer.js';
import {
    deleteOrphanMessageChannels,
    linkChannelToSchema,
    linkFunctionToBroker,
    mergeEmergentSchema,
    mergeMessageChannelWithKind,
} from '../../src/graph/mutations/data-contracts.js';
import { seedRoutesTo } from './_helpers/delta-seeds.js';
import { buildUrn } from '../../src/graph/urn.js';
import { closeNeo4j, getNeo4jSession, initSchema } from '../../src/graph/neo4j.js';
import { reconcileEdges } from '../../src/ingestion/processors/code-pipeline/edge-reconciler.js';
import type { RepoHints } from '../../src/config/repo-hints.js';

const repoHints: RepoHints = {
    databases: [],
    decorators: [],
    hints: [],
    message_channels: { aliases: [] },
};

async function cypher<T = Record<string, unknown>>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const session = getNeo4jSession();
    try {
        const result = await session.run(query, params);
        return result.records.map(r => r.toObject() as T);
    } finally {
        await session.close();
    }
}

async function createFunction(id: string, name: string, commitHash: string) {
    await cypher(
        `MERGE (f:Function {id: $id})
         ON CREATE SET f.name = $name, f.valid_from_commit = $commitHash, f.createdAt = timestamp()
         SET f.valid_to_commit = null`,
        { id, name, commitHash },
    );
}

function pubsubAnalysis(infrastructure: Array<{ name: string; operation: 'READS' | 'WRITES'; channelKind: 'topic' | 'subscription' }>) {
    return DeepUnifiedAnalysisSchema.parse({
        _reasoning: 'test',
        has_io: infrastructure.length > 0,
        intent: 'pubsub temporal integration',
        infrastructure: infrastructure.map(infra => ({ ...infra, type: 'MessageChannel' })),
        capabilities: [],
        produced_payloads: [],
        consumed_payloads: [],
        emergent_api_calls: [],
    });
}

describe('PubSub MessageChannel graph integration', () => {
    beforeEach(async () => {
        await initSchema({ silent: true });
        await cypher('MATCH (n) DETACH DELETE n');
    });

    afterAll(async () => {
        await closeNeo4j();
    });

    it('persists topic/subscription/schema topology and temporal V1 to V2 lifecycle', async () => {
        const initialCommit = 'commit-1';
        const publisherMigrationCommit = 'commit-2';
        const consumerRemovalCommit = 'commit-3';

        const publisherFn = 'cr:function:publisher:ts:publishQuote';
        const consumerFn = 'cr:function:consumer:ts:consumeQuote';
        const topicV1 = 'order.created.quote.created';
        const topicV2 = 'order.created.quote.created.V2';
        const subV1 = 'order-created-quote-created-sub';
        const schemaName = 'MotorQuoteCreated';

        const topicV1Urn = buildUrn('channel', 'topic', topicV1);
        const topicV2Urn = buildUrn('channel', 'topic', topicV2);
        const subV1Urn = buildUrn('channel', 'sub', subV1);
        const schemaUrn = buildUrn('schema', 'message_payload', schemaName);

        await createFunction(publisherFn, 'publishQuote', initialCommit);
        await createFunction(consumerFn, 'consumeQuote', initialCommit);
        await mergeEmergentSchema({
            qualifiedRepoName: 'test/pubsub',
            filepath: 'schemas/MotorQuoteCreated.avsc',
            schemaName,
            schemaType: 'message_payload',
            fields: [{ name: 'quoteId', type: 'string', required: true }],
            hasDynamicKeys: false,
            commitHash: initialCommit,
        });
        await mergeMessageChannelWithKind(topicV1, 'topic', 'pubsub', initialCommit, { schemaPath: './schemas/MotorQuoteCreated.avsc', schemaFormat: 'avro' });
        await mergeMessageChannelWithKind(subV1, 'subscription', 'pubsub', initialCommit, { schemaPath: './schemas/MotorQuoteCreated.avsc', schemaFormat: 'avro' });
        await linkChannelToSchema(topicV1Urn, schemaUrn, initialCommit);
        await linkFunctionToBroker(publisherFn, topicV1, 'PUBLISHES_TO', initialCommit, 'topic');
        await linkFunctionToBroker(consumerFn, subV1, 'LISTENS_TO', initialCommit, 'subscription');
        await seedRoutesTo(subV1, topicV1, initialCommit);
        await deleteOrphanMessageChannels(initialCommit);

        const topology = await cypher<{ sub: string; topic: string; schema: string }>(
            `MATCH (sub:MessageChannel {id: $subV1Urn})-[r:ROUTES_TO]->(topic:MessageChannel {id: $topicV1Urn})
             MATCH (topic)-[hs:HAS_SCHEMA]->(schema:DataStructure {id: $schemaUrn})
             WHERE sub.valid_to_commit IS NULL
               AND topic.valid_to_commit IS NULL
               AND schema.valid_to_commit IS NULL
               AND r.valid_to_commit IS NULL
               AND hs.valid_to_commit IS NULL
             RETURN sub.channelKind AS sub, topic.channelKind AS topic, schema.type AS schema`,
            { subV1Urn, topicV1Urn, schemaUrn },
        );
        expect(topology).toEqual([{ sub: 'subscription', topic: 'topic', schema: 'message_payload' }]);

        await mergeMessageChannelWithKind(topicV2, 'topic', 'pubsub', publisherMigrationCommit, { schemaPath: './schemas/MotorQuoteCreatedV2.avsc', schemaFormat: 'avro' });
        await linkFunctionToBroker(publisherFn, topicV2, 'PUBLISHES_TO', publisherMigrationCommit, 'topic');
        await reconcileEdges(
            publisherFn,
            pubsubAnalysis([{ name: topicV2, operation: 'WRITES', channelKind: 'topic' }]),
            'org/publisher',
            publisherMigrationCommit,
            repoHints,
        );
        await deleteOrphanMessageChannels(publisherMigrationCommit);

        const afterPublisherMigration = await cypher<{ topicV1ValidTo: string | null; publisherV1ValidTo: string | null }>(
            `MATCH (topic:MessageChannel {id: $topicV1Urn})
             MATCH (:Function {id: $publisherFn})-[r:PUBLISHES_TO]->(topic)
             RETURN topic.valid_to_commit AS topicV1ValidTo, r.valid_to_commit AS publisherV1ValidTo`,
            { topicV1Urn, publisherFn },
        );
        expect(afterPublisherMigration).toEqual([{ topicV1ValidTo: null, publisherV1ValidTo: publisherMigrationCommit }]);

        await reconcileEdges(
            consumerFn,
            pubsubAnalysis([]),
            'org/consumer',
            consumerRemovalCommit,
            repoHints,
        );
        await deleteOrphanMessageChannels(consumerRemovalCommit);

        const finalState = await cypher<{ topicV1ValidTo: string | null; subV1ValidTo: string | null; topicV2ValidTo: string | null }>(
            `MATCH (topicV1:MessageChannel {id: $topicV1Urn})
             MATCH (subV1:MessageChannel {id: $subV1Urn})
             MATCH (topicV2:MessageChannel {id: $topicV2Urn})
             RETURN topicV1.valid_to_commit AS topicV1ValidTo,
                    subV1.valid_to_commit AS subV1ValidTo,
                    topicV2.valid_to_commit AS topicV2ValidTo`,
            { topicV1Urn, subV1Urn, topicV2Urn },
        );
        expect(finalState).toEqual([{ topicV1ValidTo: consumerRemovalCommit, subV1ValidTo: consumerRemovalCommit, topicV2ValidTo: null }]);
    });
});
