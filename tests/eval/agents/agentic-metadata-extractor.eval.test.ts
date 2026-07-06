/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Eval Suite — AgenticMetadataExtractor: cross-repo vs intra-repo architecture
 *
 * Pins the behaviour change that lets agent-readiness distinguish context files
 * documenting CROSS-SERVICE topology (the high-value, agent-blind-spot signal)
 * from those describing only this repo's INTERNAL design.
 *
 *   - A guide that documents inter-service topology (publishes/consumes events,
 *     calls other services) MUST be tagged 'cross-repo-architecture'.
 *   - A guide describing only internal layering (hexagonal, DDD, SOLID) MUST be
 *     tagged 'architecture' and MUST NOT be tagged 'cross-repo-architecture'.
 *
 * Modes (EVAL_LLM_MODE env var):
 *   replay  — Cached LLM outputs, deterministic (default/CI). Hard-fail on miss.
 *   live    — Real LLM calls, saves to cache.
 *   refresh — Real LLM calls, overwrites cache.
 *
 * Seed the cache once (real LLM):
 *   EVAL_LLM_MODE=refresh bun vitest run tests/eval/agents/agentic-metadata-extractor.eval.test.ts --config vitest.eval.config.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AgenticMetadataExtractionSchema, type AgenticMetadata } from '../../../src/ai/agents/agentic-metadata-extractor.js';
import { getMastra } from '../../../src/ai/mastra/index.js';
import type { Agent } from '@mastra/core/agent';
import { withReplay } from '../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../helpers/llm-replay-cache.js';

// Bump when AgenticMetadataExtractionSchema changes (prompt-text changes are
// captured automatically by the instructions hash in the cache key).
const SCHEMA_VERSION = 'v1.0.0-agentic-metadata';

interface MetadataCase {
    label: string;
    name: string;
    configType: string;
    content: string;
    mustInclude: string[];
    mustExclude?: string[];
}

const CASES: MetadataCase[] = [
    {
        label: 'cross-service topology -> cross-repo-architecture',
        name: 'CLAUDE.md',
        configType: 'agent_instructions',
        content: [
            '# acme/orders-service — Agent Guide',
            '',
            '## Service topology',
            'This service is the upstream order intake. After persisting an order it',
            'publishes `order.created` to RabbitMQ, consumed by `acme/shipping-service`',
            'and `acme/notification-service`. For payment authorization it calls',
            '`acme/payment-service` over gRPC (`POST /v1/charges`); a declined charge',
            'emits `payment.failed`, which this service consumes to cancel the order.',
            'Inventory levels are read synchronously from `acme/inventory-service` REST.',
            '',
            '## Internal layout',
            'Hexagonal: `src/domain` (entities), `src/application` (use cases),',
            '`src/adapters` (inbound/outbound ports).',
        ].join('\n'),
        mustInclude: ['cross-repo-architecture'],
    },
    {
        label: 'internal layering only -> architecture, NOT cross-repo',
        name: 'CLAUDE.md',
        configType: 'agent_instructions',
        content: [
            '# acme/catalog-service — Agent Guide',
            '',
            '## Architecture',
            'Clean architecture with strict layering. `src/domain` holds entities and',
            'value objects with no framework imports. `src/application` orchestrates use',
            'cases. `src/infrastructure` implements repositories. Dependencies point',
            'inward (dependency inversion). Follow SOLID and keep cyclomatic complexity',
            'low. Domain-driven design: aggregates guard their invariants.',
        ].join('\n'),
        mustInclude: ['architecture'],
        mustExclude: ['cross-repo-architecture'],
    },
];

describe('AgenticMetadataExtractor — cross-repo vs intra-repo', () => {
    let agent: Agent;

    beforeAll(async () => {
        agent = getMastra().getAgent('agenticMetadataExtractorAgent');
        await withReplay(agent, SCHEMA_VERSION);
        console.log(`[AgenticMetadata Eval] Mode: ${EVAL_LLM_MODE}`);
    });

    for (const tc of CASES) {
        describe(tc.label, () => {
            let result: AgenticMetadata;

            beforeAll(async () => {
                const response = await agent.generate(
                    `Config name: ${tc.name}\nConfig type: ${tc.configType}\n\n${tc.content}`,
                    {
                        structuredOutput: { schema: AgenticMetadataExtractionSchema },
                        modelSettings: { maxRetries: 0, temperature: 0 },
                        abortSignal: AbortSignal.timeout(30_000),
                    },
                );
                result = response.object!;
            }, 60_000);

            it('classifies the file as agentic content', () => {
                expect(result.isAgenticContent).toBe(true);
            });

            for (const topic of tc.mustInclude) {
                it(`includes topic: ${topic}`, () => {
                    expect(
                        result.topics,
                        `Expected '${topic}' in topics, got [${result.topics.join(', ')}]`,
                    ).toContain(topic);
                });
            }

            for (const topic of tc.mustExclude ?? []) {
                it(`does NOT include topic: ${topic}`, () => {
                    expect(
                        result.topics,
                        `Expected '${topic}' absent, got [${result.topics.join(', ')}]`,
                    ).not.toContain(topic);
                });
            }
        });
    }
});
