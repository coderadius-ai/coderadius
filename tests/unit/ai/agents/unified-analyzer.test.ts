import { describe, it, expect } from 'vitest';
import {
    DeepUnifiedAnalysisSchema,
    buildAnalyzerInstructions,
} from '../../../../src/ai/agents/unified-analyzer.js';

describe('UnifiedAnalysisSchema (Mongo-Gate DB Names)', () => {
    it('should pass generic database names through unchanged (dropping happens in graph-writer)', () => {
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Connects to DB',
            infrastructure: [
                { name: 'mongodb', type: 'Database' },
                { name: 'mongo', type: 'Database' },
                { name: 'postgres', type: 'Database' },
                { name: 'redis', type: 'Cache' },
            ],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);

        // Generic names now pass through the schema unchanged.
        // The GENERIC_INFRA_NAMES drop filter in graph-writer.ts
        // handles filtering at persistence time.
        expect(result.infrastructure[0].name).toBe('mongodb');
        expect(result.infrastructure[1].name).toBe('mongo');
        expect(result.infrastructure[2].name).toBe('postgres');
        expect(result.infrastructure[3].name).toBe('redis');
    });

    it('should allow valid logical database/collection names', () => {
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Reads users',
            infrastructure: [
                { name: 'users_collection', type: 'Database' },
                { name: 'order-events', type: 'MessageChannel' },
                { name: 'my-service-db', type: 'Database' },
            ],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);

        expect(result.infrastructure[0].name).toBe('users_collection');
        expect(result.infrastructure[1].name).toBe('order-events');
        expect(result.infrastructure[2].name).toBe('my-service-db');
    });

    it('should drop infrastructure entries with unknown type instead of coercing to Process', () => {
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Does I/O',
            infrastructure: [
                { name: 'orders', type: 'Database' },
                { name: 'mystery-resource', type: 'CompletelyUnknownType' },
            ],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0]).toMatchObject({ name: 'orders', type: 'Database' });
    });

    it('should preserve valid infrastructure entries when one item is malformed', () => {
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Reads data',
            infrastructure: [
                { name: 'users', type: 'Database' },
                { type: 'Database' } as any,
            ],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);
        expect(result.infrastructure).toHaveLength(1);
        expect(result.infrastructure[0]).toMatchObject({ name: 'users', type: 'Database' });
    });

    it('should preserve hostname for full URLs and dedupe normalized calls', () => {
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Calls external APIs',
            infrastructure: [],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [
                { method: 'get', path: 'https://api.example.com/v1/users' },
                { method: 'GET', path: 'https://api.example.com//v1/users' },
                { method: 'POST', path: '${dynamicPath}' },
            ],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);
        expect(result.emergent_api_calls).toHaveLength(1);
        expect(result.emergent_api_calls[0]).toMatchObject({ method: 'GET', path: 'api.example.com/v1/users' });
    });

    it('should normalize and dedupe GraphQL operations by operation+operationName', () => {
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Handles GraphQL calls',
            infrastructure: [],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [
                // Same root field, lowercase vs uppercase \u2014 normalizeApiPath uppercases op token
                { method: 'POST', path: 'GRAPHQL query user', api_kind: 'graphql' },
                { method: 'POST', path: 'GRAPHQL QUERY user', api_kind: 'graphql' },
                // Subscription with null method \u2014 must NOT be dropped by dedupeApiCalls
                { method: null,   path: 'GRAPHQL SUBSCRIPTION onOrderUpdate', api_kind: 'graphql' },
            ],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);
        expect(result.emergent_api_calls).toHaveLength(2);
        // GraphQL invariant: method is forced to null at the schema layer
        // (consistent with the Cypher layer, which nullifies method for all
        // apiKind='graphql' operations) regardless of what the LLM emitted.
        expect(result.emergent_api_calls[0]).toMatchObject({ method: null, path: 'GRAPHQL QUERY user' });
        expect(result.emergent_api_calls[1]).toMatchObject({ method: null, path: 'GRAPHQL SUBSCRIPTION onOrderUpdate' });
    });

    it('should preserve versioned paths with mid-path template params through normalize+dedupe', () => {
        // Pins that the deterministic layer never drops /api/v2/... paths with
        // a {param} mid-path: the lossless-path eval failure was an LLM
        // omission (prompt rule), NOT a transform bug. Guard against the
        // transform regressing into one.
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Payment client with two endpoints',
            infrastructure: [],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [
                { method: 'POST', path: '/api/v1/charge' },
                { method: 'GET', path: '/api/v2/payments/{paymentId}/status' },
            ],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);
        expect(result.emergent_api_calls).toHaveLength(2);
        expect(result.emergent_api_calls.map(c => c.path)).toEqual([
            '/api/v1/charge',
            '/api/v2/payments/{paymentId}/status',
        ]);
    });

    it('should force method=null and api_kind=graphql on GraphQL calls regardless of LLM output', () => {
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Handles GraphQL calls',
            infrastructure: [],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [
                // LLM violated the prompt rule: subscription with a method.
                { method: 'POST', path: 'GRAPHQL SUBSCRIPTION orderUpdated', api_kind: 'graphql' },
                // Canonical GQL path but api_kind defaulted/mislabelled as rest:
                // the path regex must still classify it and coerce api_kind.
                { method: 'GET', path: 'graphql query user', api_kind: 'rest' },
                // True REST call: untouched by the GraphQL invariant.
                { method: 'GET', path: '/api/search', api_kind: 'rest' },
            ],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);
        expect(result.emergent_api_calls).toHaveLength(3);

        const sub = result.emergent_api_calls.find(c => c.path.includes('SUBSCRIPTION'));
        expect(sub).toMatchObject({ method: null, api_kind: 'graphql' });

        const query = result.emergent_api_calls.find(c => c.path.includes('QUERY'));
        expect(query).toMatchObject({ method: null, api_kind: 'graphql', path: 'GRAPHQL QUERY user' });

        const rest = result.emergent_api_calls.find(c => c.path === '/api/search');
        expect(rest).toMatchObject({ method: 'GET', api_kind: 'rest' });
    });

    it('should truncate hallucinated GQL paths with spaces in operationName (space bug regression)', () => {
        // 'GRAPHQL QUERY get user' — LLM hallucination, space in identifier.
        // normalizeApiPath takes only parts[2] ('get'), discarding 'user'.
        // Both entries normalize to 'GRAPHQL QUERY get' → dedupe to 1 entry.
        // Key and stored path are always consistent (no mismatch).
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Calls GraphQL',
            infrastructure: [],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [
                { method: 'POST', path: 'GRAPHQL QUERY get user', api_kind: 'graphql' },
                { method: 'POST', path: 'GRAPHQL QUERY get',      api_kind: 'graphql' },
            ],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);
        expect(result.emergent_api_calls).toHaveLength(1);
        expect(result.emergent_api_calls[0]).toMatchObject({ path: 'GRAPHQL QUERY get' });
    });

    it('should drop GQL paths with invalid format (no operationName)', () => {
        const input = {
            _reasoning: 'test',
            has_io: true,
            intent: 'Calls GraphQL',
            infrastructure: [],
            capabilities: [],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [
                { method: 'POST', path: 'GRAPHQL QUERY',  api_kind: 'graphql' }, // missing operationName
                { method: 'POST', path: 'GRAPHQL',         api_kind: 'graphql' }, // missing op + name
                { method: 'POST', path: 'GRAPHQL QUERY validOp', api_kind: 'graphql' }, // valid
            ],
        };

        const result = DeepUnifiedAnalysisSchema.parse(input);
        expect(result.emergent_api_calls).toHaveLength(1);
        expect(result.emergent_api_calls[0]).toMatchObject({ path: 'GRAPHQL QUERY validOp' });
    });
});

describe('buildAnalyzerInstructions()', () => {
    it('includes fp-ts and repository rules in fast mode', () => {
        const instructions = buildAnalyzerInstructions('fast');

        expect(instructions).toContain('TE.tryCatch');
        expect(instructions).toContain('TaskEither');
        expect(instructions).toContain('Repository, Dao, Store');
    });

    it('includes negative examples for URL and token builders in deep mode', () => {
        const instructions = buildAnalyzerInstructions('deep');

        expect(instructions).toContain('Building a URL is not the same as calling it');
        expect(instructions).toContain('Functions that ONLY construct, build, or format URL');
        expect(instructions).toContain('Functions that ONLY read from or map over in-memory data structures');
    });
});

describe('buildAnalyzerInstructions() — prompt compression', () => {
    // CUT rules: violations are corrected deterministically downstream
    // (GENERIC_INFRA_NAMES, isNoisyBrokerName/BROKER_CLASS_SUFFIX,
    // isStorageTypeOrTransportToken). The prompt states principles; the
    // enumerated lists live only in name-safety.ts.
    it.each(['fast', 'deep'] as const)('no longer enumerates sanitizer-enforced reject terms (%s)', (mode) => {
        const instructions = buildAnalyzerInstructions(mode);

        // DB_RULES technology-name list → GENERIC_INFRA_NAMES
        expect(instructions).not.toContain('influxdb');
        expect(instructions).not.toContain('prisma, mongoose');
        // BROKER_RULES reject clause → isNoisyBrokerName + BROKER_CLASS_SUFFIX
        expect(instructions).not.toContain('PubSubClient');
        expect(instructions).not.toContain('google-cloud-pubsub');
        expect(instructions).not.toContain('event-bus');
        // INFRA generic-tech clauses → GENERIC_INFRA_NAMES + storage tokens
        expect(instructions).not.toContain('Do NOT use "s3"');
        expect(instructions).not.toContain('(mongodb, postgres, redis, rabbitmq, kafka, s3)');
    });

    it.each(['fast', 'deep'] as const)('keeps extraction-shaping principles intact (%s)', (mode) => {
        const instructions = buildAnalyzerInstructions(mode);

        // Behavioral rules with no post-hoc recovery — must survive any cut
        expect(instructions).toContain('<core_directive>');
        expect(instructions).toContain('<DYNAMIC>');
        expect(instructions).toContain('EVIDENCE');
        expect(instructions).toContain('CONCATENATION');
        expect(instructions).toContain('GRAPHQL QUERY');
        expect(instructions).toContain('{paymentId}');         // lossless mid-path params
        expect(instructions).toContain('<wrapper_detection>');
        expect(instructions).toContain('<anti_hallucination_guard>');
        // The kept half of the DB reject list (not deterministically enforced)
        expect(instructions).toContain('Repository/Repo/Service');
    });

    it('locks the compression budget to prevent re-bloat', () => {
        // Pre-L4 fast prompt: 11,339 chars. The cut list (filter-rules list
        // compression, DB tech-name clause, anti-hallucination examples 4→2,
        // broker reject line, infra generic-tech clauses) must keep the base
        // prompt under this ceiling; raising it requires an eval-gated PR.
        expect(buildAnalyzerInstructions('fast').length).toBeLessThan(10_500);
        expect(buildAnalyzerInstructions('deep').length).toBeLessThan(13_000);
    });
});
