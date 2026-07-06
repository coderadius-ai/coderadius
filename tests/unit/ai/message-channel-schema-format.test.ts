import { describe, expect, it } from 'vitest';

import { FastUnifiedAnalysisSchema } from '../../../src/ai/agents/unified-analyzer.js';

describe('MessageChannel schema format inference', () => {
    it('defaults schemaFormat to avro for .avsc schema paths', () => {
        const parsed = FastUnifiedAnalysisSchema.parse({
            _reasoning: 'test',
            has_io: true,
            intent: 'publish user event',
            infrastructure: [
                {
                    name: 'Platform-SampleUser',
                    type: 'MessageChannel',
                    operation: 'WRITES',
                    channelKind: 'topic',
                    schemaPath: ' ./schemas/SampleUser.avsc ',
                },
            ],
            capabilities: [],
            emergent_api_calls: [],
        });

        expect(parsed.infrastructure[0].schemaPath).toBe('./schemas/SampleUser.avsc');
        expect(parsed.infrastructure[0].schemaFormat).toBe('avro');
    });

    it('defaults schemaFormat to protobuf for .proto schema paths', () => {
        const parsed = FastUnifiedAnalysisSchema.parse({
            _reasoning: 'test',
            has_io: true,
            intent: 'publish payment event',
            infrastructure: [
                {
                    name: 'payment.completed',
                    type: 'MessageChannel',
                    operation: 'WRITES',
                    channelKind: 'topic',
                    schemaPath: './schemas/payment.completed.proto',
                },
            ],
            capabilities: [],
            emergent_api_calls: [],
        });

        expect(parsed.infrastructure[0].schemaFormat).toBe('protobuf');
    });

    it('keeps explicit schemaFormat when provided', () => {
        const parsed = FastUnifiedAnalysisSchema.parse({
            _reasoning: 'test',
            has_io: true,
            intent: 'publish contract event',
            infrastructure: [
                {
                    name: 'contract.updated',
                    type: 'MessageChannel',
                    operation: 'WRITES',
                    channelKind: 'topic',
                    schemaPath: './schemas/contract.avsc',
                    schemaFormat: 'json-schema',
                },
            ],
            capabilities: [],
            emergent_api_calls: [],
        });

        expect(parsed.infrastructure[0].schemaFormat).toBe('json-schema');
    });
});
