/**
 * Diagnostic: replays a unified-analyzer prompt that failed in a trace through
 * the EXACT same code path (analyzeFunction → Mastra Agent → @ai-sdk/google-vertex
 * → Vertex), so the response goes through the same schema converter and the same
 * agentic loop as production. Prints:
 *
 *   - response.finishReason          (Mastra/AI SDK unified enum)
 *   - response.text                  (raw text if any)
 *   - response.object                (parsed structured output if any)
 *   - response.error                 (SDK / validation error)
 *   - response.providerMetadata.google.safetyRatings / .blockReason  (if surfaced)
 *
 * If finishReason='content-filter' with non-empty safetyRatings → safety block.
 * If finishReason='stop' but object=undefined → schema-validation failure.
 * If finishReason='tripwire' / abort-error → Mastra agentic-loop hang (likely
 * triggered by something the model returned that the SDK kept retrying).
 *
 * Parameterised — no customer paths or names are hardcoded. Reads the SEND event
 * for the given function from the supplied trace JSONL.
 *
 * Usage:
 *   bun run scripts/diag-vertex-safety-block.ts \
 *       --trace ~/.coderadius/traces/<run>.trace.jsonl \
 *       --fn '<functionName>' \
 *       [--mode deep|fast]        # which schema; default deep (contracts)
 *       [--model <id>]            # default gemini-3.1-flash-lite (production)
 *       [--language php]          # used to pick the language-specific agent
 *       [--timeout-ms N]          # default 60000 (deep) / 45000 (fast)
 *       [--compare]               # run primary AND fallback model side-by-side
 */

import { readFileSync } from 'node:fs';
import { configManager } from '../src/config/index.js';
import { getLanguagePlugin } from '../src/ingestion/core/languages/registry.js';
import {
    analyzeFunction,
    DeepUnifiedAnalysisSchema,
    FastUnifiedAnalysisSchema,
    buildAnalyzerInstructions,
    getFastAnalyzerAgent,
    getDeepAnalyzerAgent,
    getFastFallbackAnalyzerAgent,
    getDeepFallbackAnalyzerAgent,
} from '../src/ai/agents/unified-analyzer.js';
import type { CodeChunk } from '../src/graph/types.js';

interface SendEvent {
    data: {
        filePath: string;
        functionName: string;
        codeChunk: string;
        imports?: string[];
        resolvedInvocationContext?: string;
        promptLength?: number;
    };
}

function findSendEvent(tracePath: string, fnName: string): SendEvent {
    const lines = readFileSync(tracePath, 'utf-8').split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.stage === 'llm' && j.action === 'SEND' && j.data?.functionName === fnName) {
            return j as SendEvent;
        }
    }
    throw new Error(`no SEND event for fn="${fnName}" in ${tracePath}`);
}

function pp(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function summarise(label: string, response: any, latencyMs: number) {
    console.log(`\n# ─── ${label} ─────────────────────────────────────────────`);
    console.log(`latency=${latencyMs}ms`);
    console.log(`finishReason: ${response?.finishReason ?? '(absent)'}`);
    console.log(`object: ${response?.object !== undefined ? 'PRESENT (valid structured output)' : 'undefined'}`);

    if (response?.error) {
        const err = response.error as Error;
        console.log(`error: ${err.name}: ${err.message}`);
    }

    const text = response?.text ?? '';
    if (text) {
        const preview = text.length > 500 ? `${text.slice(0, 500)}…[${text.length} chars total]` : text;
        console.log(`text:\n${preview}`);
    } else {
        console.log(`text: (empty)`);
    }

    // Vertex safety ratings + block reason surface through providerMetadata.google.
    const pm = response?.providerMetadata?.google;
    if (pm) {
        if (pm.blockReason) {
            console.log(`providerMetadata.google.blockReason = ${pm.blockReason}`);
        }
        if (pm.safetyRatings) {
            console.log(`providerMetadata.google.safetyRatings:`);
            for (const r of pm.safetyRatings) {
                const flag = r.blocked ? ' [BLOCKED]' : '';
                const cat = String(r.category ?? '').replace('HARM_CATEGORY_', '');
                console.log(`  ${cat.padEnd(22)} ${String(r.probability ?? '').padEnd(10)}${flag}`);
            }
        }
    }

    if (response?.usage) {
        const u = response.usage;
        console.log(`usage: total=${u.totalTokens ?? '?'} input=${u.inputTokens ?? '?'} output=${u.outputTokens ?? '?'}`);
    }
}

async function callAgent(agent: any, prompt: string, schema: any, timeoutMs: number) {
    const start = Date.now();
    try {
        const response = await agent.generate(prompt, {
            structuredOutput: { schema },
            modelSettings: { maxRetries: 0, temperature: 0 },
            abortSignal: AbortSignal.timeout(timeoutMs),
        });
        return { response, latencyMs: Date.now() - start, thrown: undefined };
    } catch (err) {
        return { response: undefined, latencyMs: Date.now() - start, thrown: err };
    }
}

async function main() {
    const args = process.argv.slice(2);
    const get = (k: string): string | undefined => {
        const i = args.findIndex((a) => a === `--${k}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const has = (k: string): boolean => args.includes(`--${k}`);

    const tracePath = get('trace');
    const fnName = get('fn');
    const mode = (get('mode') ?? 'deep') as 'fast' | 'deep';
    const language = get('language') ?? 'php';
    const compare = has('compare');
    const timeoutMs = Number(get('timeout-ms') ?? (mode === 'deep' ? 60_000 : 45_000));

    if (!tracePath || !fnName) {
        console.error('usage: --trace <path> --fn <functionName> [--mode fast|deep] [--language php] [--timeout-ms N] [--compare]');
        process.exit(2);
    }

    const cfg = configManager.getAiConfig('ingest');
    if (!cfg.project || !cfg.location) {
        throw new Error('Vertex project/location not configured (settings.json ai.providers.vertex).');
    }

    const ev = findSendEvent(tracePath, fnName);

    // Reconstruct the exact CodeChunk that the production pipeline built.
    const chunk: CodeChunk = {
        name: ev.data.functionName,
        filepath: ev.data.filePath,
        language,
        sourceCode: ev.data.codeChunk,
    } as CodeChunk;

    console.log('# ════════════════════════════════════════════════════════════════════');
    console.log('# DIAGNOSTIC: Vertex replay via Mastra (same path as unified-analyzer)');
    console.log('# ════════════════════════════════════════════════════════════════════');
    console.log(`trace        : ${tracePath}`);
    console.log(`function     : ${fnName}`);
    console.log(`mode         : ${mode}`);
    console.log(`language     : ${language}`);
    console.log(`timeoutMs    : ${timeoutMs}`);
    console.log(`configured model (primary) : ${cfg.model}`);

    // Build the FULL prompt exactly as analyzeFunction would, so we can also
    // show it on demand and have a stable artefact for the second-call branch.
    const plugin = getLanguagePlugin(language);
    const hints = plugin?.promptHints?.();
    const system = buildAnalyzerInstructions(mode, hints);
    console.log(`prompt sizes : system=${system.length}ch  user(approx)=${ev.data.codeChunk.length + (ev.data.resolvedInvocationContext?.length ?? 0)}ch`);

    const schema = mode === 'deep' ? DeepUnifiedAnalysisSchema : FastUnifiedAnalysisSchema;

    // Build the user prompt the same way analyzeFunction does. Easiest: actually
    // call analyzeFunction — it owns the construction. But analyzeFunction wraps
    // the call in withRateLimitRetry, telemetry, fallback, reconciliation — too
    // much. Instead, call agent.generate directly with the same prompt template.
    const sections: string[] = [];
    if (ev.data.imports && ev.data.imports.length > 0) {
        sections.push(`File imports:\n${ev.data.imports.join('\n')}`);
    }
    const contextBlock = sections.length > 0
        ? `\n\n--- DI Context (use this to resolve infrastructure names) ---\n${sections.join('\n\n')}\n--- End DI Context ---\n`
        : '';
    const resolvedBlock = ev.data.resolvedInvocationContext ?? '';
    const userPrompt = `Analyze the following function. First determine if it performs external I/O. If yes, extract its intent, infrastructure dependencies, and capabilities.
${contextBlock}
Function name: ${ev.data.functionName}
File path: ${ev.data.filePath}
Language: ${language}
${resolvedBlock}
\`\`\`
${ev.data.codeChunk}
\`\`\``;

    const primaryAgent = mode === 'deep' ? getDeepAnalyzerAgent() : getFastAnalyzerAgent();
    const fallbackAgent = mode === 'deep' ? getDeepFallbackAnalyzerAgent() : getFastFallbackAnalyzerAgent();

    const a = await callAgent(primaryAgent, userPrompt, schema, timeoutMs);
    if (a.thrown) {
        console.log(`\n# ─── A. primary (gemini-3.1-flash-lite via Mastra) ──────────────`);
        const e = a.thrown as Error;
        console.log(`latency=${a.latencyMs}ms`);
        console.log(`THROWN: ${e.name}: ${e.message}`);
    } else {
        summarise(`A. primary (${cfg.model ?? 'gemini-3.1-flash-lite'} via Mastra)`, a.response, a.latencyMs);
    }

    if (compare) {
        const b = await callAgent(fallbackAgent, userPrompt, schema, timeoutMs);
        if (b.thrown) {
            console.log(`\n# ─── B. fallback (fallback model via Mastra) ────────`);
            const e = b.thrown as Error;
            console.log(`latency=${b.latencyMs}ms`);
            console.log(`THROWN: ${e.name}: ${e.message}`);
        } else {
            summarise(`B. fallback (fallback model via Mastra)`, b.response, b.latencyMs);
        }
    }

    console.log('');
    console.log('# Mapping reference (@ai-sdk/google/dist/index.js:1329-1335):');
    console.log('#   STOP                → finishReason=stop');
    console.log('#   MAX_TOKENS          → finishReason=length');
    console.log('#   SAFETY|SPII|RECITATION|BLOCKLIST|PROHIBITED_CONTENT → finishReason=content-filter');
    console.log('#   abort signal fired or processor abort → finishReason=tripwire');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
