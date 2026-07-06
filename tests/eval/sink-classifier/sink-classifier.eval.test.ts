/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Eval Suite — Sink Classifier (Golden Dataset)
 *
 * Validates that the LLM-based sink classifier correctly classifies a curated
 * list of well-known packages across all SinkType categories.
 *
 * Architecture:
 *   - withReplay() wraps `getSinkClassifierAgent()` for deterministic playback
 *   - cacheBackend pinned to a tmpdir per test → no pollution of ~/.coderadius
 *   - snapshot dir overridden via env → no fast-path interference
 *   - Telemetry collector model is set so the cache key & fingerprint are stable
 *
 * Modes (EVAL_LLM_MODE env var):
 *   replay  — Cached LLM outputs, deterministic, ~1s (default/CI)
 *   live    — Real LLM calls, saves to cache
 *   refresh — Real LLM calls, overwrites cache
 *
 * Run with:
 *   bun vitest run tests/eval/sink-classifier --config vitest.eval.config.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    classifyPackages,
    getSinkClassifierAgent,
    resetSinkClassifierAgent,
} from '../../../src/ai/agents/sink-classifier/index.js';
import { SINK_CLASSIFIER_SCHEMA_VERSION } from '../../../src/ai/agents/sink-classifier/schema.js';
import { FileBackend } from '../../../src/ai/agents/sink-classifier/cache/file-backend.js';
import { telemetryCollector } from '../../../src/telemetry/index.js';
import { withReplay } from '../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../helpers/llm-replay-cache.js';
import {
    GOLDEN_CASES,
    ADVERSARIAL_TYPOSQUATS,
    AMBIGUOUS_INTERNAL,
    type GoldenCase,
} from './golden-dataset.js';
import type { ClassifiedPackage, ClassifierInput, SinkType } from '../../../src/ai/agents/sink-classifier/schema.js';
import type { SinkCacheBackend } from '../../../src/ai/agents/sink-classifier/cache/types.js';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let tmpRoot: string;
let snapshotRoot: string;
let isolatedBackend: SinkCacheBackend;

const HARDCODED_SINKS = new Set<string>(['axios', 'pg']);
const HARDCODED_IGNORES = new Set<string>(['dd-trace', 'winston']);

beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sink-eval-cache-'));
    snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sink-eval-snap-'));
    process.env.CODERADIUS_SNAPSHOT_DIR = snapshotRoot;
    process.env.CODERADIUS_TENANT_ID = 'eval';

    // Pin the active model so the model fingerprint is stable across runs.
    // This ensures cacheKeys are reproducible.
    telemetryCollector.setModel('eval-provider', 'eval-model');

    isolatedBackend = new FileBackend({ rootDir: tmpRoot, tenantId: 'eval' });

    // Reset singleton so withReplay sees a fresh agent (no stale spy from
    // earlier suites in the same Vitest worker).
    resetSinkClassifierAgent();
    await withReplay(getSinkClassifierAgent(), SINK_CLASSIFIER_SCHEMA_VERSION);

    console.log(`[SinkClassifier Eval] Mode: ${EVAL_LLM_MODE}`);
});

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    delete process.env.CODERADIUS_SNAPSHOT_DIR;
    delete process.env.CODERADIUS_TENANT_ID;
    resetSinkClassifierAgent();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expectedTypes(c: GoldenCase): SinkType[] {
    return Array.isArray(c.expected) ? c.expected : [c.expected];
}

function inputsForGolden(cases: GoldenCase[]): ClassifierInput[] {
    return cases.map(c => ({ name: c.name, ecosystem: c.ecosystem }));
}

async function classify(inputs: ClassifierInput[]): Promise<ClassifiedPackage[]> {
    const result = await classifyPackages(inputs, {
        mode: 'enabled',
        confidenceThreshold: 0.5,   // permissive for eval; we still assert ≥0.7 below
        maxPackagesPerBatch: 100,
        timeoutMs: 60_000,
        budget: { maxTokens: 1_000_000, maxUsd: 10 },
        privacy: { denyPatterns: [], allowPatterns: [], onDenied: 'classify_as_sink' },
        hardcodedSinks: HARDCODED_SINKS,
        hardcodedIgnores: HARDCODED_IGNORES,
        cacheBackend: isolatedBackend,
    });
    return result.classifications;
}

// ─── Suite — Golden Dataset Accuracy ─────────────────────────────────────────

describe('SinkClassifier — Golden Dataset', () => {
    let classifications: Map<string, ClassifiedPackage>;

    beforeAll(async () => {
        const inputs = inputsForGolden(GOLDEN_CASES);
        const out = await classify(inputs);
        classifications = new Map(out.map(c => [c.name, c]));
    }, 120_000);

    it('produces a classification for every golden package', () => {
        const missing = GOLDEN_CASES.filter(c => !classifications.has(c.name)).map(c => c.name);
        expect(missing, `Missing classifications for: ${missing.join(', ')}`).toEqual([]);
    });

    // Per-case assertions (one `it` per package for granular CI output).
    for (const tc of GOLDEN_CASES) {
        it(`[${tc.category}] ${tc.name} → ${expectedTypes(tc).join('|')}`, () => {
            const c = classifications.get(tc.name);
            expect(c, `no classification for ${tc.name}`).toBeDefined();
            const expected = expectedTypes(tc);
            expect(
                expected.includes(c!.sinkType),
                `${tc.name}: expected ${expected.join('|')} but got ${c!.sinkType} (confidence ${c!.confidence})`,
            ).toBe(true);
            expect(
                c!.confidence,
                `${tc.name}: confidence ${c!.confidence} below ${tc.minConfidence ?? 0.7}`,
            ).toBeGreaterThanOrEqual(tc.minConfidence ?? 0.7);
        });
    }

    it('hits ≥95% recall on canonical sink categories', () => {
        const sinkCases = GOLDEN_CASES.filter(c => {
            const ex = expectedTypes(c);
            return !ex.includes('NotASink') && !ex.includes('Observability');
        });
        const correct = sinkCases.filter(c => {
            const cl = classifications.get(c.name);
            return cl && expectedTypes(c).includes(cl.sinkType);
        });
        const recall = correct.length / sinkCases.length;
        expect(recall, `recall ${(recall * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.95);
    });

    it('keeps false-positive rate ≤2% on NotASink utilities', () => {
        const utilities = GOLDEN_CASES.filter(c => {
            const ex = expectedTypes(c);
            return ex.length === 1 && ex[0] === 'NotASink';
        });
        const falsePositives = utilities.filter(c => {
            const cl = classifications.get(c.name);
            return cl && cl.sinkType !== 'NotASink';
        });
        const fpRate = falsePositives.length / Math.max(1, utilities.length);
        expect(
            fpRate,
            `false positives: ${falsePositives.map(c => `${c.name}→${classifications.get(c.name)?.sinkType}`).join(', ')}`,
        ).toBeLessThanOrEqual(0.02);
    });
});

// ─── Suite — Anti-hallucination (adversarial) ────────────────────────────────

describe('SinkClassifier — Anti-hallucination', () => {
    it('rejects typosquats — none reach the resolved set as sinks', async () => {
        const inputs: ClassifierInput[] = ADVERSARIAL_TYPOSQUATS.map(name => ({
            name,
            ecosystem: 'npm',
        }));
        const result = await classify(inputs);
        // Typosquats may appear with NotASink (the LLM correctly identifies
        // them as suspicious) — but they MUST NOT appear as canonical sinks
        // (Database/Cache/etc.). The typosquat detector enforces this.
        const leaked = result.filter(c =>
            c.sinkType !== 'NotASink' && c.sinkType !== 'Observability',
        );
        expect(
            leaked.map(c => `${c.name}→${c.sinkType}`),
            `typosquats leaked as sinks: ${leaked.map(c => c.name).join(', ')}`,
        ).toEqual([]);
    }, 60_000);

    it('does not aggressively classify ambiguous internal packages as sinks', async () => {
        const inputs: ClassifierInput[] = AMBIGUOUS_INTERNAL.map(name => ({
            name,
            ecosystem: 'npm',
        }));
        const result = await classify(inputs);
        // For ambiguous internal-looking names with no concrete evidence, the
        // classifier should pick NotASink OR a non-canonical sink with low
        // confidence. We accept either, but reject high-confidence canonical
        // sinks (which would indicate over-confident guessing).
        for (const c of result) {
            if (c.sinkType !== 'NotASink' && c.sinkType !== 'Other' && c.confidence > 0.85) {
                expect.fail(
                    `${c.name}: classified as ${c.sinkType} with confidence ${c.confidence} — expected NotASink or low confidence`,
                );
            }
        }
    }, 60_000);
});
