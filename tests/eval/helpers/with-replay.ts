/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * withReplay — Agent-Level LLM Interception for Eval Tests
 *
 * Wraps a Mastra Agent's generate() method with cache-backed replay logic
 * using vi.spyOn. The interception is at the agent level (NOT the function
 * level) so that all post-LLM pipeline code (dedup, reconciliation,
 * normalization inside analyzeFunction()) is still exercised in replay mode.
 *
 * Usage:
 *   import { withReplay } from '../helpers/with-replay.js';
 *   import { getDeepAnalyzerAgent } from '../../../src/ai/agents/unified-analyzer.js';
 *
 *   const SCHEMA_VERSION = 'v1.0.0-deep-unified';
 *   withReplay(getDeepAnalyzerAgent(), SCHEMA_VERSION);
 *
 * The agent singleton is mutated in-place — all downstream callers
 * (including analyzeFunction()) automatically use the cache.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { LLMReplayCache, EVAL_LLM_MODE } from './llm-replay-cache.js';
import crypto from 'node:crypto';
import {
    getAnalyzerStrategy,
    getFallbackAnalyzerStrategy,
    getFastAnalyzerAgent,
    getDeepAnalyzerAgent,
    getFastFallbackAnalyzerAgent,
    getDeepFallbackAnalyzerAgent,
} from '../../../src/ai/agents/unified-analyzer.js';
import { getAllPlugins } from '../../../src/ingestion/core/languages/registry.js';

/**
 * Wrap a Mastra Agent with LLM replay cache logic.
 *
 * @param agent         The Mastra Agent singleton to wrap
 * @param schemaVersion Manual version string — bump when the agent's Zod output schema changes.
 *                      Do NOT use JSON.stringify(schema.shape) — Zod internals don't serialize.
 * @returns The same agent instance (mutated via vi.spyOn)
 */
export async function withReplay(agent: Agent, schemaVersion: string): Promise<Agent> {
    // Mastra exposes the system prompt via the async getInstructions() method;
    // the bare `agent.instructions` property is ALWAYS undefined. Hashing the
    // property (the historical code) hashed '' for every agent, so the cache
    // key never changed when the prompt changed and replay silently served
    // stale-prompt responses. A prompt-compression pass surfaced the bug:
    // hash the real text.
    const instructions = await agent.getInstructions();
    const instructionsText = typeof instructions === 'string' ? instructions : JSON.stringify(instructions);
    if (!instructionsText || instructionsText === 'undefined') {
        throw new Error(`[LLM Replay] Agent "${agent.id}" returned empty instructions — cache key would not gate prompt changes`);
    }
    const instructionsHash = crypto.createHash('sha256')
        .update(instructionsText)
        .digest('hex').slice(0, 8);

    const cache = new LLMReplayCache(agent.id, instructionsHash, schemaVersion);

    // Capture the REAL generate BEFORE vi.spyOn replaces it.
    // Verified: Mastra Agent.generate is a regular async class method (no Proxy,
    // no getter). .bind(agent) correctly preserves `this` for internal calls
    // like #validateRequestContext and getDefaultOptions.
    const originalGenerate = agent.generate.bind(agent);

    // Idempotency guard: wrapping an already-wrapped agent would chain spies
    // (the "originalGenerate" captured above would itself be a spy) and, in
    // live/refresh mode, double-save every response. wireUnifiedAnalyzerReplay
    // can be called from multiple test files in the same worker.
    if ((agent as any).__replayWired) return agent;
    (agent as any).__replayWired = true;

    vi.spyOn(agent, 'generate').mockImplementation(async (prompt: any, opts?: any) => {
        // Mastra accepts string | CoreMessage[]. CodeRadius agents always pass
        // a plain string prompt (built from chunk.name + source + context —
        // all deterministic, no UUIDs/timestamps). The JSON.stringify fallback
        // is purely defensive for future-proofing.
        const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
        const { hit, key, response } = cache.lookup(promptStr);

        if (EVAL_LLM_MODE === 'replay') {
            if (!hit) {
                if (process.env.REPLAY_MISS_DUMP_DIR) {
                    const fs = await import('node:fs');
                    fs.appendFileSync(
                        `${process.env.REPLAY_MISS_DUMP_DIR}/miss-${agent.id.replace(/[^a-z0-9-]/gi, '_')}-${key}.txt`,
                        promptStr,
                    );
                }
                throw new Error(
                    `[LLM Replay] Cache miss for agent="${agent.id}", key="${key}". ` +
                    `Run with EVAL_LLM_MODE=refresh to populate the cache.`,
                );
            }
            return response;
        }

        // live or refresh — call the real LLM via the saved reference
        const result = await originalGenerate(prompt, opts);
        cache.save(promptStr, key, result, (agent as any).model?.modelId ?? 'unknown');
        return result;
    });

    return agent;
}

// ─── Unified-analyzer wiring (generic + per-language agents) ─────────────────

/** Bump when the corresponding Zod output schema changes (NOT on prompt-text
 *  changes — those are captured by the instructions hash in the cache key). */
export const UNIFIED_SCHEMA_VERSION_FAST = 'v1.0.0-fast-unified';
export const UNIFIED_SCHEMA_VERSION_DEEP = 'v1.0.0-deep-unified';

/**
 * Wire the replay cache into EVERY agent `analyzeFunction()` can resolve.
 *
 * `analyzeFunction` does NOT use the generic fast/deep singletons when the
 * language plugin exposes `promptHints()` — it routes through
 * `getAnalyzerStrategy(scanMode, language)` to a per-language agent
 * (`fast:php-unified-analyzer-agent`, `deep:typescript-...`). All four
 * built-in plugins ship promptHints, so wrapping only the generic singletons
 * (the historical wiring) intercepts NOTHING: every eval ran a live LLM call
 * in every mode — replay included — silently, since the per-language split.
 *
 * This helper wraps the generic singletons (defensive: languages without
 * hints fall back to them) plus the fast+deep per-language agent of every
 * registered plugin. `getAnalyzerStrategy` memoizes per (mode, language), so
 * the instances wrapped here are the exact instances analyzeFunction uses.
 */
export async function wireUnifiedAnalyzerReplay(): Promise<void> {
    await withReplay(getFastAnalyzerAgent(), UNIFIED_SCHEMA_VERSION_FAST);
    await withReplay(getDeepAnalyzerAgent(), UNIFIED_SCHEMA_VERSION_DEEP);
    // Fallback agents MUST be wrapped too: in replay mode a cache miss on the
    // primary throws, analyzeFunction catches it as an "empty response" and
    // retries on the fallback agent — which, unwrapped, would silently run a
    // live LLM call and mask the miss. Wrapped, the fallback misses as well
    // and the test fails visibly (the correct replay semantics).
    await withReplay(getFastFallbackAnalyzerAgent(), UNIFIED_SCHEMA_VERSION_FAST);
    await withReplay(getDeepFallbackAnalyzerAgent(), UNIFIED_SCHEMA_VERSION_DEEP);
    for (const plugin of getAllPlugins()) {
        if (!plugin.promptHints) continue;
        await withReplay(await getAnalyzerStrategy('semantic', plugin.language), UNIFIED_SCHEMA_VERSION_FAST);
        await withReplay(await getAnalyzerStrategy('contracts', plugin.language), UNIFIED_SCHEMA_VERSION_DEEP);
        await withReplay(await getFallbackAnalyzerStrategy('semantic', plugin.language), UNIFIED_SCHEMA_VERSION_FAST);
        await withReplay(await getFallbackAnalyzerStrategy('contracts', plugin.language), UNIFIED_SCHEMA_VERSION_DEEP);
        // Stage 2: the slim io-confirmed agents are distinct instances (separate
        // cache key + instructionsHash), so they need their own replay wrapping.
        await withReplay(await getAnalyzerStrategy('semantic', plugin.language, true), UNIFIED_SCHEMA_VERSION_FAST);
        await withReplay(await getAnalyzerStrategy('contracts', plugin.language, true), UNIFIED_SCHEMA_VERSION_DEEP);
        await withReplay(await getFallbackAnalyzerStrategy('semantic', plugin.language, true), UNIFIED_SCHEMA_VERSION_FAST);
        await withReplay(await getFallbackAnalyzerStrategy('contracts', plugin.language, true), UNIFIED_SCHEMA_VERSION_DEEP);
    }
}
