// ═══════════════════════════════════════════════════════════════════════════════
// Sink Classifier — public entry point.
//
// Pipeline: privacy filter → cache lookup → batched LLM call → anti-
// hallucination → cache write → return validated classifications.
//
// Fail-soft: if anything goes wrong, returns whatever could be classified
// from cache + an empty list for misses. The caller falls back to hardcoded.
// ═══════════════════════════════════════════════════════════════════════════════

import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { getModel } from '../../models/provider.js';
import { withCongestionControl } from '../../../utils/congestion-control.js';
import { telemetryCollector } from '../../../telemetry/index.js';
import { logger } from '../../../utils/logger.js';

import {
    SINK_CLASSIFIER_SCHEMA_VERSION,
    SinkClassifierOutputSchema,
    type ClassifiedPackage,
    type ClassifierInput,
    type ValidationContext,
} from './schema.js';
import { SINK_CLASSIFIER_INSTRUCTIONS, buildBatchPrompt } from './prompt.js';
import {
    createCacheBackend,
    computeCacheKey,
    computeModelFingerprint,
    type SinkCacheBackend,
    type CacheEntry,
} from './cache/index.js';
import { ClassifierBudget, type BudgetLimits, type ModelPricingLite } from './budget.js';
import { filterForLLM, type PrivacyConfig, DEFAULT_PRIVACY_CONFIG } from './privacy.js';
import { detectTyposquat } from './typosquat.js';

export interface ClassifierOptions {
    /** disabled = no LLM, enabled = cache→LLM, force-refresh = ignore cache. */
    mode: 'disabled' | 'enabled' | 'force-refresh';
    confidenceThreshold: number;
    maxPackagesPerBatch: number;
    timeoutMs: number;
    budget: BudgetLimits;
    privacy: PrivacyConfig;
    /** Hardcoded sinks/ignores for cross-checking against LLM (drift detection). */
    hardcodedSinks: Set<string>;
    hardcodedIgnores: Set<string>;
    /** Optional pricing for cost calculation in budget. */
    pricing?: ModelPricingLite;
    /** Optional override for cache backend (tests). */
    cacheBackend?: SinkCacheBackend;
    abortSignal?: AbortSignal;
}

export interface ClassifierResult {
    classifications: ClassifiedPackage[];
    drift: Array<{ name: string; kind: string; detail?: string }>;
    budgetSnapshot: ReturnType<ClassifierBudget['snapshot']>;
}

let _agent: Agent | null = null;

/**
 * Lazy singleton — exported so eval tests can wrap `agent.generate` with the
 * shared `withReplay()` cache. Production code should not need this directly.
 */
export function getSinkClassifierAgent(): Agent {
    if (!_agent) {
        _agent = new Agent({
            id: 'sink-classifier',
            name: 'Sink Classifier',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: SINK_CLASSIFIER_INSTRUCTIONS,
            model: getModel('ingest'),
        });
    }
    return _agent;
}

/**
 * Reset the cached singleton agent. Used by tests after mocking model
 * providers; safe to call between runs.
 */
export function resetSinkClassifierAgent(): void {
    _agent = null;
}

/**
 * Validate one classification against anti-hallucination rules.
 * Mutates ctx.driftLog when relevant.
 */
function validateClassification(
    c: ClassifiedPackage,
    ctx: ValidationContext,
): { ok: true } | { ok: false; reason: 'hallucination' | 'no-evidence' | 'typosquat' | 'low-confidence' } {
    if (!ctx.inputSet.has(c.name)) {
        return { ok: false, reason: 'hallucination' };
    }
    if (c.confidence < ctx.confidenceThreshold) {
        return { ok: false, reason: 'low-confidence' };
    }
    if (c.evidence.length === 0 && c.confidence < 0.95) {
        return { ok: false, reason: 'no-evidence' };
    }
    const squat = detectTyposquat(c.name);
    if (squat && c.sinkType !== 'NotASink') {
        ctx.driftLog.push({
            name: c.name,
            kind: 'typosquat',
            detail: `1-edit from '${squat}', refused as sink`,
        });
        return { ok: false, reason: 'typosquat' };
    }
    if (ctx.hardcodedSinks.has(c.name) && c.sinkType === 'NotASink') {
        ctx.driftLog.push({
            name: c.name,
            kind: 'hardcoded_disagrees',
            detail: 'hardcoded says sink, llm says NotASink — keeping hardcoded',
        });
        return { ok: false, reason: 'hallucination' };
    }
    return { ok: true };
}

function chunk<T>(arr: T[], size: number): T[][] {
    if (size <= 0) return [arr];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function trackSeenVersion(seen: string[], lockedVersion: string | undefined): string[] {
    if (!lockedVersion) return seen;
    if (seen.includes(lockedVersion)) return seen;
    return [...seen, lockedVersion];
}

/**
 * Public API: classify a list of packages and return validated results.
 *
 * Always succeeds (never throws). On unrecoverable failure returns whatever
 * classifications were produced from cache + an empty list otherwise — the
 * caller is responsible for falling back to the hardcoded layer.
 */
export async function classifyPackages(
    packages: ClassifierInput[],
    options: ClassifierOptions,
): Promise<ClassifierResult> {
    if (options.mode === 'disabled' || packages.length === 0) {
        return {
            classifications: [],
            drift: [],
            budgetSnapshot: new ClassifierBudget(options.budget).snapshot(),
        };
    }

    const dedup = new Map<string, ClassifierInput>();
    for (const p of packages) {
        const key = `${p.ecosystem}|${p.name}`;
        if (!dedup.has(key)) dedup.set(key, p);
    }
    const inputs = [...dedup.values()];

    const driftLog: Array<{ name: string; kind: string; detail?: string }> = [];
    const accepted = new Map<string, ClassifiedPackage>();
    const budget = new ClassifierBudget(options.budget);
    const backend = options.cacheBackend ?? createCacheBackend('file');
    const { provider, model } = telemetryCollector.getActiveModel();
    const fingerprint = computeModelFingerprint(provider || 'unknown', model || 'unknown');

    // Layer 1: privacy filter
    const filtered = filterForLLM(inputs, options.privacy);
    if (filtered.deniedNames.length > 0) {
        telemetryCollector.incrementSinkClassifierCounter(
            'PrivacyFiltered',
            filtered.deniedNames.length,
        );
        for (const decision of filtered.deniedDecisions) {
            accepted.set(decision.name, decision);
        }
    }

    // Layer 2: cache lookup (skip on force-refresh)
    const llmCandidates: ClassifierInput[] = [];
    if (options.mode === 'force-refresh') {
        llmCandidates.push(...filtered.sentToLLM);
    } else {
        for (const pkg of filtered.sentToLLM) {
            const key = computeCacheKey(pkg.name, pkg.ecosystem, fingerprint);
            try {
                const hit = await backend.lookup(key);
                if (hit) {
                    telemetryCollector.incrementSinkClassifierCounter('CacheHits');
                    if (!accepted.has(pkg.name)) accepted.set(pkg.name, hit.classification);
                } else {
                    telemetryCollector.incrementSinkClassifierCounter('CacheMisses');
                    llmCandidates.push(pkg);
                }
            } catch (err) {
                logger.debug(`[SinkClassifier] cache lookup failed for ${pkg.name}: ${(err as Error).message}`);
                llmCandidates.push(pkg);
            }
        }
    }

    if (llmCandidates.length === 0) {
        return {
            classifications: collectAcceptedWithDrift(accepted, driftLog, options),
            drift: driftLog,
            budgetSnapshot: budget.snapshot(),
        };
    }

    // Layer 3: batched LLM calls with budget enforcement
    const batches = chunk(llmCandidates, options.maxPackagesPerBatch);
    const validationCtx: ValidationContext = {
        inputSet: new Set(llmCandidates.map(p => p.name)),
        confidenceThreshold: options.confidenceThreshold,
        hardcodedSinks: options.hardcodedSinks,
        hardcodedIgnores: options.hardcodedIgnores,
        driftLog,
    };

    for (const batch of batches) {
        if (budget.tripped()) {
            telemetryCollector.incrementSinkClassifierCounter('BudgetTripped');
            break;
        }
        // Optimistic estimate: assume ~50 input tokens per name + 100 output tokens per classification
        const estTokens = batch.length * (50 + 100);
        if (!budget.canConsume(estTokens)) {
            telemetryCollector.incrementSinkClassifierCounter('BudgetTripped');
            break;
        }

        const llmOutputs = await callLLM(batch, options).catch(err => {
            logger.warn(`[SinkClassifier] LLM batch failed: ${(err as Error).message}`);
            telemetryCollector.incrementSinkClassifierCounter('FallbackHardcoded');
            return null;
        });

        if (!llmOutputs) continue;

        budget.consume(llmOutputs.inputTokens, llmOutputs.outputTokens, options.pricing);

        for (const c of llmOutputs.classifications) {
            const v = validateClassification(c, validationCtx);
            if (!v.ok) {
                if (v.reason === 'hallucination') {
                    telemetryCollector.incrementSinkClassifierCounter('RejectedHallucination');
                } else if (v.reason === 'typosquat') {
                    telemetryCollector.incrementSinkClassifierCounter('RejectedTyposquat');
                } else {
                    telemetryCollector.incrementSinkClassifierCounter('RejectedNoEvidence');
                }
                continue;
            }
            telemetryCollector.incrementSinkClassifierCounter('Accepted');
            accepted.set(c.name, c);

            // Persist (including NotASink — negative caching)
            const input = batch.find(p => p.name === c.name);
            if (input) {
                const key = computeCacheKey(c.name, input.ecosystem, fingerprint);
                const entry: CacheEntry = {
                    cacheKey: key,
                    name: c.name,
                    ecosystem: input.ecosystem,
                    schemaVersion: SINK_CLASSIFIER_SCHEMA_VERSION,
                    modelFingerprint: fingerprint,
                    classification: c,
                    seenVersions: trackSeenVersion([], input.lockedVersion),
                    timestamp: new Date().toISOString(),
                };
                try {
                    await backend.save(key, entry);
                } catch (err) {
                    logger.debug(`[SinkClassifier] cache save failed for ${c.name}: ${(err as Error).message}`);
                }
            }
        }
    }

    return {
        classifications: collectAcceptedWithDrift(accepted, driftLog, options),
        drift: driftLog,
        budgetSnapshot: budget.snapshot(),
    };
}

interface BatchOutput {
    classifications: ClassifiedPackage[];
    inputTokens: number;
    outputTokens: number;
}

async function callLLM(batch: ClassifierInput[], options: ClassifierOptions): Promise<BatchOutput> {
    const agent = getSinkClassifierAgent();
    const userPrompt = buildBatchPrompt(batch.map(p => p.name));
    const startTime = telemetryCollector.startTimer();
    telemetryCollector.incrementSinkClassifierCounter('LLMInvocations');

    const response = await withCongestionControl(() =>
        agent.generate(userPrompt, {
            structuredOutput: { schema: SinkClassifierOutputSchema as unknown as z.ZodType },
            modelSettings: { maxRetries: 0, temperature: 0 },
            abortSignal: options.abortSignal ?? AbortSignal.timeout(options.timeoutMs),
        } as any),
    );

    const duration = telemetryCollector.stopTimer(startTime);
    telemetryCollector.addLLMTime(duration);

    const usage = (response as any).usage ?? {};
    telemetryCollector.addTokensForPhase('sink_classification', usage);

    const inputTokens = (usage.promptTokens ?? usage.inputTokens ?? 0) as number;
    const outputTokens = (usage.completionTokens ?? usage.outputTokens ?? 0) as number;
    const obj = (response as any).object as { classifications: ClassifiedPackage[] } | undefined;

    return {
        classifications: obj?.classifications ?? [],
        inputTokens,
        outputTokens,
    };
}

function collectAcceptedWithDrift(
    accepted: Map<string, ClassifiedPackage>,
    driftLog: Array<{ name: string; kind: string; detail?: string }>,
    options: ClassifierOptions,
): ClassifiedPackage[] {
    // Drift: hardcoded says ignore, llm says sink (or vice versa)
    for (const [name, c] of accepted) {
        if (options.hardcodedIgnores.has(name) && c.sinkType !== 'Observability' && c.sinkType !== 'NotASink') {
            driftLog.push({
                name,
                kind: 'hardcoded_disagrees',
                detail: `hardcoded says ignore, llm says ${c.sinkType}`,
            });
            telemetryCollector.incrementSinkClassifierCounter('DriftDisagreements');
        } else if (
            !options.hardcodedSinks.has(name) &&
            c.sinkType !== 'NotASink' &&
            c.sinkType !== 'Observability'
        ) {
            telemetryCollector.incrementSinkClassifierCounter('DriftNewDiscoveries');
        }
    }
    return [...accepted.values()];
}
