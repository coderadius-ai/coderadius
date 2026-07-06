/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Eval Suite — ConfigSymbolExtractor Accuracy (Golden Dataset)
 *
 * Tests the ConfigSymbolExtractor LLM agent against known config files from
 * the microservices fixture. Each test case sends a real config file to the
 * LLM and verifies exact DI binding extraction.
 *
 * Architecture:
 *   - Uses withReplay() for deterministic, sub-second replay runs
 *   - Golden dataset from real microservice config files
 *   - Assertions verify both positive (must extract) and negative (must NOT extract) bindings
 *
 * Modes (EVAL_LLM_MODE env var):
 *   replay  — Cached LLM outputs, deterministic, ~1s (default/CI)
 *   live    — Real LLM calls, saves to cache
 *   refresh — Real LLM calls, overwrites cache
 *
 * Run with:
 *   EVAL_LLM_MODE=replay bun vitest run tests/eval/agents/config-symbol-extractor.eval.test.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigSymbolExtractionSchema, type ConfigSymbolExtractionResult } from '../../../src/ai/agents/config-symbol-extractor.js';
import { getMastra } from '../../../src/ai/mastra/index.js';
import type { Agent } from '@mastra/core/agent';
import { withReplay } from '../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../helpers/llm-replay-cache.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExpectedBinding {
    diKey: string;
    physicalName: string;
    technology?: string;
    category?: 'di_service' | 'env_var' | 'constant' | 'config_value';
}

interface GoldenTestCase {
    /** Human-readable label for the test */
    label: string;
    /** Path relative to the microservices fixture root */
    relPath: string;
    /** Minimum number of bindings expected */
    minBindings: number;
    /** Exact bindings that MUST appear in the output */
    requiredBindings: ExpectedBinding[];
    /** DI keys that MUST NOT appear in the output (false positive guard) */
    forbiddenDiKeys?: string[];
}

// ─── Golden Dataset Definition ───────────────────────────────────────────────

const FIXTURE_ROOT = path.resolve(import.meta.dirname, '../../fixtures/microservices');

const GOLDEN_CASES: GoldenTestCase[] = [
    // ── services.php: Symfony DI container with 4 infrastructure bindings ──
    {
        label: 'payment-service/config/services.php — Symfony DI container',
        relPath: 'payment-service/config/services.php',
        minBindings: 3,
        requiredBindings: [
            {
                diKey: 'payment.completed.publisher',
                physicalName: 'payment.completed.v2',
                technology: 'rabbitmq',
                category: 'di_service',
            },
            {
                diKey: 'refund.initiated.publisher',
                physicalName: 'refund.initiated',
                technology: 'rabbitmq',
                category: 'di_service',
            },
            {
                diKey: 'notredeemable.publisher',
                physicalName: 'loyalty.not_redeemable',
                technology: 'rabbitmq',
                category: 'di_service',
            },
            {
                diKey: 'order.events.consumer',
                physicalName: 'order.confirmed',
                technology: 'rabbitmq',
                category: 'di_service',
            },
        ],
        forbiddenDiKeys: [
            // Connection setup is NOT an infrastructure binding
            'amqp.connection',
            // Class names must not leak
            'PaymentEventPublisher',
            'RefundEventPublisher',
            'NotRedeemablePublisher',
            'OrderEventsConsumer',
            // Exchange names must NOT be extracted as physicalName
            'payments_exchange',
            'loyalty_exchange',
        ],
    },

    // ── AmqpConfig.php: Symfony Messenger message→routing_key map ──
    {
        label: 'logistics-routing-service/src/Messenger/AmqpConfig.php — Messenger routing',
        relPath: 'logistics-routing-service/src/Messenger/AmqpConfig.php',
        minBindings: 3,
        requiredBindings: [
            {
                diKey: 'SaveRequestedMessage',
                physicalName: 'fulfillment.shipment.save.requested',
                technology: 'rabbitmq',
            },
            {
                diKey: 'ShipmentSavedMessage',
                physicalName: 'logistics.fulfillment.shipment.saved',
                technology: 'rabbitmq',
            },
            {
                diKey: 'ShipmentUpdatedMessage',
                physicalName: 'logistics.fulfillment.shipment.updated',
                technology: 'rabbitmq',
            },
        ],
        forbiddenDiKeys: [
            // FQCN must not leak — only short class names
            'Fulfillment\\Messenger\\Message\\ShipmentSavedMessage',
            'Fulfillment\\Messenger\\Message\\SaveRequestedMessage',
        ],
    },
];

// ─── LLM Replay Cache ───────────────────────────────────────────────────────

const SCHEMA_VERSION = 'v1.0.0-config-symbol';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Soft match for physicalName: strips {ENV}/{SUFFIX} template parts for comparison. */
function normalizePhysicalName(name: string): string {
    return name
        .replace(/\{[^}]+\}/g, '')    // remove template vars like {ENV}
        .replace(/\.{2,}/g, '.')       // collapse double dots
        .replace(/^\.+|\.+$/g, '');    // trim leading/trailing dots
}

/** Check if an actual binding matches an expected binding (fuzzy on physicalName). */
function bindingMatches(
    actual: { diKey: string; physicalName: string; technology?: string; category?: string },
    expected: ExpectedBinding,
): boolean {
    // Exact diKey match
    if (actual.diKey !== expected.diKey) return false;

    // Physical name: try exact first, then normalized
    const physicalMatch =
        actual.physicalName === expected.physicalName ||
        normalizePhysicalName(actual.physicalName) === normalizePhysicalName(expected.physicalName);
    if (!physicalMatch) return false;

    // Technology: if expected specifies one, it must match
    if (expected.technology && actual.technology !== expected.technology) return false;

    return true;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('ConfigSymbolExtractor — Golden Dataset', () => {
    let extractorAgent: Agent;

    beforeAll(async () => {
        extractorAgent = getMastra().getAgent('configSymbolExtractorAgent');
        // Wire replay cache AFTER getting the agent singleton
        await withReplay(extractorAgent, SCHEMA_VERSION);
        console.log(`[ConfigSymbolExtractor Eval] Mode: ${EVAL_LLM_MODE}`);
    });

    for (const tc of GOLDEN_CASES) {
        describe(tc.label, () => {
            let result: ConfigSymbolExtractionResult;

            beforeAll(async () => {
                const absPath = path.join(FIXTURE_ROOT, tc.relPath);
                const content = fs.readFileSync(absPath, 'utf-8');

                const response = await extractorAgent.generate(
                    `File: ${tc.relPath}\n\n${content}`,
                    {
                        structuredOutput: { schema: ConfigSymbolExtractionSchema },
                        modelSettings: { maxRetries: 2, temperature: 0 },
                        abortSignal: AbortSignal.timeout(30_000),
                    },
                );

                result = response.object!;
            }, 60_000);

            it(`should extract at least ${tc.minBindings} bindings`, () => {
                expect(
                    result.bindings.length,
                    `Expected ≥${tc.minBindings} bindings, got ${result.bindings.length}: ${JSON.stringify(result.bindings.map(b => b.diKey))}`,
                ).toBeGreaterThanOrEqual(tc.minBindings);
            });

            for (const expected of tc.requiredBindings) {
                it(`should extract binding: ${expected.diKey} → ${expected.physicalName}`, () => {
                    const match = result.bindings.find(b => bindingMatches(b, expected));
                    if (!match) {
                        // Print all actual bindings for debugging
                        const actual = result.bindings.map(b =>
                            `  ${b.diKey} → ${b.physicalName} (${b.technology ?? '?'})`,
                        ).join('\n');
                        expect.fail(
                            `Missing binding: ${expected.diKey} → ${expected.physicalName}\n` +
                            `Actual bindings:\n${actual}`,
                        );
                    }
                });
            }

            if (tc.forbiddenDiKeys && tc.forbiddenDiKeys.length > 0) {
                it('should NOT extract forbidden DI keys (false positive guard)', () => {
                    const actualDiKeys = result.bindings.map(b => b.diKey);
                    const violations = tc.forbiddenDiKeys!.filter(fk =>
                        actualDiKeys.some(ak => ak === fk || ak.includes(fk)),
                    );
                    if (violations.length > 0) {
                        expect.fail(
                            `Forbidden DI keys found in output: [${violations.join(', ')}]\n` +
                            `All extracted: [${actualDiKeys.join(', ')}]`,
                        );
                    }
                });
            }

            it('should extract ONLY routing_key as physicalName, NEVER exchange names', () => {
                const exchangeLeaks = result.bindings.filter(b =>
                    b.physicalName.toLowerCase().includes('exchange'),
                );
                if (exchangeLeaks.length > 0) {
                    expect.fail(
                        `Exchange names leaked into physicalName: ${exchangeLeaks.map(b => `${b.diKey} → ${b.physicalName}`).join(', ')}`,
                    );
                }
            });
        });
    }
});
