/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit Tests — EvalManifest + EvalScorer
 *
 * Tests the deterministic scoring engine (zero Neo4j, zero LLM).
 * Validates Zod schema parsing, precision/recall math, negative detection,
 * and symbol resolution scoring.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { EvalManifestSchema, loadManifest } from '../../eval/types/eval-manifest.js';
import {
    scoreNodes,
    checkNegatives,
    scoreSymbols,
    assembleReport,
} from '../../eval/scorers/eval-scorer.js';

// ─── Manifest Schema ─────────────────────────────────────────────────────────

describe('EvalManifestSchema', () => {
    it('should parse a minimal valid manifest', () => {
        const result = EvalManifestSchema.safeParse({
            fixture: 'test',
            expected_nodes: { Service: ['order-service'] },
        });
        expect(result.success).toBe(true);
        expect(result.data!.fixture).toBe('test');
    });

    it('should default empty arrays for optional fields', () => {
        const result = EvalManifestSchema.parse({ fixture: 'test' });
        expect(result.expected_edges).toEqual([]);
        expect(result.expected_symbols).toEqual([]);
        expect(result.negative_nodes).toEqual({});
        expect(result.negative_patterns).toEqual({});
    });

    it('should reject manifests without a fixture name', () => {
        const result = EvalManifestSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('should parse expected_symbols correctly', () => {
        const result = EvalManifestSchema.parse({
            fixture: 'test',
            expected_symbols: [
                { diKey: 'billing.sender', resolvedTo: 'billing.events', source: 'config.php' },
            ],
        });
        expect(result.expected_symbols).toHaveLength(1);
        expect(result.expected_symbols[0].diKey).toBe('billing.sender');
    });

    it('should parse all three edge types', () => {
        const result = EvalManifestSchema.parse({
            fixture: 'test',
            expected_edges: [
                { from: 'svc-a', rel: 'DEPENDS_ON', to: 'svc-b' },
                { from_function: 'OrderService.handle', rel: 'WRITES', to: 'orders' },
                { from_service: 'order-service', rel: 'READS', to: 'users' },
            ],
        });
        expect(result.expected_edges).toHaveLength(3);
    });

    it('should load the real microservices manifest from disk', () => {
        const manifestPath = path.resolve(
            import.meta.dirname, '..', '..', 'fixtures', 'microservices', 'expected.graph.yaml'
        );
        const manifest = loadManifest(manifestPath);
        expect(manifest.fixture).toBe('microservices');
        expect(manifest.expected_symbols.length).toBeGreaterThan(0);
        expect(Object.keys(manifest.expected_nodes)).toContain('Service');
    });
});

// ─── Node Scoring ────────────────────────────────────────────────────────────

describe('scoreNodes', () => {
    it('should compute perfect recall and precision when graph matches manifest', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            expected_nodes: {
                Service: ['a', 'b', 'c'],
            },
        });

        const graphNodes = new Map([['Service', ['a', 'b', 'c']]]);
        const scores = scoreNodes(manifest, graphNodes);

        expect(scores).toHaveLength(1);
        expect(scores[0].recall).toBe(1.0);
        expect(scores[0].precision).toBe(1.0);
        expect(scores[0].falseNegatives).toEqual([]);
        expect(scores[0].falsePositives).toEqual([]);
    });

    it('should detect false negatives (missing from graph)', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            expected_nodes: {
                Service: ['a', 'b', 'c'],
            },
        });

        const graphNodes = new Map([['Service', ['a', 'b']]]);  // 'c' missing
        const scores = scoreNodes(manifest, graphNodes);

        expect(scores[0].recall).toBeCloseTo(2 / 3);
        expect(scores[0].falseNegatives).toEqual(['c']);
    });

    it('should detect false positives (extra in graph)', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            expected_nodes: {
                Service: ['a'],
            },
        });

        const graphNodes = new Map([['Service', ['a', 'b', 'c']]]);
        const scores = scoreNodes(manifest, graphNodes);

        expect(scores[0].precision).toBeCloseTo(1 / 3);
        expect(scores[0].falsePositives).toEqual(['b', 'c']);
    });

    it('should handle empty graph for a category', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            expected_nodes: { Service: ['a'] },
        });

        const graphNodes = new Map<string, string[]>();
        const scores = scoreNodes(manifest, graphNodes);

        expect(scores[0].recall).toBe(0);
        expect(scores[0].falseNegatives).toEqual(['a']);
    });
});

// ─── Negative Detection ──────────────────────────────────────────────────────

describe('checkNegatives', () => {
    it('should find exact negative violations', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            negative_nodes: {
                MessageChannel: ['rabbitmq', 'kafka'],
            },
        });

        const graphNodes = new Map([['MessageChannel', ['order.created', 'rabbitmq']]]);
        const violations = checkNegatives(manifest, graphNodes);

        expect(violations).toHaveLength(1);
        expect(violations[0].violatingName).toBe('rabbitmq');
        expect(violations[0].matchType).toBe('exact');
    });

    it('should find pattern violations', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            negative_patterns: {
                DataContainer: ['.*\\$.*'],  // No PHP variables
            },
        });

        const graphNodes = new Map([['DataContainer', ['orders', '$table_name']]]);
        const violations = checkNegatives(manifest, graphNodes);

        expect(violations).toHaveLength(1);
        expect(violations[0].violatingName).toBe('$table_name');
        expect(violations[0].matchType).toBe('pattern');
    });

    it('should return empty array when no violations exist', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            negative_nodes: {
                MessageChannel: ['rabbitmq'],
            },
        });

        const graphNodes = new Map([['MessageChannel', ['order.created', 'payment.v2']]]);
        const violations = checkNegatives(manifest, graphNodes);

        expect(violations).toHaveLength(0);
    });

    it('should be case-insensitive for exact negatives', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            negative_nodes: {
                MessageChannel: ['MessageBus'],
            },
        });

        const graphNodes = new Map([['MessageChannel', ['messagebus']]]);
        const violations = checkNegatives(manifest, graphNodes);

        expect(violations).toHaveLength(1);
    });
});

// ─── Symbol Scoring ──────────────────────────────────────────────────────────

describe('scoreSymbols', () => {
    it('should report all resolved when physical names exist and DI keys are gone', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            expected_symbols: [
                { diKey: 'billing.sender', resolvedTo: 'billing.events.v2' },
                { diKey: 'order.publisher', resolvedTo: 'order.created' },
            ],
        });

        const channelNames = new Set(['billing.events.v2', 'order.created', 'other.channel']);
        const score = scoreSymbols(manifest, channelNames);

        expect(score.expectedCount).toBe(2);
        expect(score.resolvedCount).toBe(2);
        expect(score.unresolvedDiKeys).toEqual([]);
        expect(score.missingPhysicalNames).toEqual([]);
    });

    it('should detect unresolved DI keys still in graph', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            expected_symbols: [
                { diKey: 'billing.sender', resolvedTo: 'billing.events.v2' },
            ],
        });

        // DI key survived as a MessageChannel (bad!)
        const channelNames = new Set(['billing.events.v2', 'billing.sender']);
        const score = scoreSymbols(manifest, channelNames);

        expect(score.unresolvedDiKeys).toEqual(['billing.sender']);
    });

    it('should detect missing physical names', () => {
        const manifest = EvalManifestSchema.parse({
            fixture: 'test',
            expected_symbols: [
                { diKey: 'billing.sender', resolvedTo: 'billing.events.v2' },
            ],
        });

        const channelNames = new Set(['other.channel']);
        const score = scoreSymbols(manifest, channelNames);

        expect(score.resolvedCount).toBe(0);
        expect(score.missingPhysicalNames).toEqual(['billing.sender → billing.events.v2']);
    });
});

// ─── Report Assembly ─────────────────────────────────────────────────────────

describe('assembleReport', () => {
    it('should compute aggregate precision and recall', () => {
        const report = assembleReport({
            fixture: 'test',
            cliVersion: '1.0.0',
            llmModel: 'gemini-2.0',
            nodeScores: [
                {
                    category: 'Service',
                    expectedCount: 3,
                    actualCount: 3,
                    truePositives: ['a', 'b', 'c'],
                    falsePositives: [],
                    falseNegatives: [],
                    precision: 1.0,
                    recall: 1.0,
                },
                {
                    category: 'DataContainer',
                    expectedCount: 4,
                    actualCount: 3,
                    truePositives: ['x', 'y', 'z'],
                    falsePositives: ['extra'],
                    falseNegatives: ['missing'],
                    precision: 0.75,
                    recall: 0.75,
                },
            ],
            edgeResult: { expectedCount: 5, foundCount: 4, missingEdges: ['a->b'] },
            symbolScore: { expectedCount: 2, resolvedCount: 2, unresolvedDiKeys: [], missingPhysicalNames: [] },
            negativeViolations: [],
        });

        // 6 TP, 1 FP, 1 FN
        expect(report.aggregatePrecision).toBeCloseTo(6 / 7);
        expect(report.aggregateRecall).toBeCloseTo(6 / 7);
        expect(report.criticalRegressionCount).toBe(0);
    });
});
