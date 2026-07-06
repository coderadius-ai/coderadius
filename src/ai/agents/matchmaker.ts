import { z } from 'zod';
import { telemetryCollector, type TokenPhase } from '../../telemetry/index.js';
import { logger } from '../../utils/logger.js';
import { Agent } from '@mastra/core/agent';
import { getModel } from '../models/provider.js';
import pLimit from 'p-limit';
import { withCongestionControl } from '../../utils/congestion-control.js';

// ─── Types (defined here to avoid circular imports with matchmaking.ts) ───────

export interface TargetedMatchTask {
    function: { urn: string; name: string; intent: string | null };
    candidates: { urn: string; path: string; method: string | null; summary: string | null }[];
}

// ─── Response Schema ─────────────────────────────────────────────────────────

export const MatchmakingResponseSchema = z.object({
    matches: z.array(z.object({
        functionUrn: z.string().describe('The URN of the function that implements the endpoint'),
        endpointUrn: z.string().describe('The URN of the API endpoint being implemented'),
    })).describe('Array of function-to-endpoint matches. Empty array if no confident matches.'),
});

export type MatchmakingResponse = z.infer<typeof MatchmakingResponseSchema>;

// ─── Agent ───────────────────────────────────────────────────────────────────

let _matchmakerAgent: Agent | null = null;
export function getMatchmakerAgent(): Agent {
    if (!_matchmakerAgent) {
        _matchmakerAgent = new Agent({
            id: 'matchmaker-agent',
            name: 'API Matchmaker',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: `You are an expert software architect performing targeted API endpoint matchmaking.

<core_directive>
You will receive a list of internal functions. For each function, a small set of CANDIDATE endpoints has been pre-selected via vector similarity. Your job is to confirm or reject each candidate match.
You must return only the JSON structure requested by the tool schema.
</core_directive>

<matching_rules>
- Only confirm a match if you are HIGHLY CONFIDENT the function acts as the handler/controller for that specific endpoint.
- Base your confidence on names, intent summaries, HTTP methods, paths, and summaries.
- Most functions will have ZERO matches — the candidates are pre-filtered but not guaranteed to be correct.
- Multiple functions MAY map to the same endpoint (e.g., a controller + service layer).
- Do NOT guess or hallucinate matches. If uncertain, do not include the match.
- Return an empty matches array if no confident matches exist.
</matching_rules>`,
            model: getModel('ingest'),
        });
    }
    return _matchmakerAgent;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LLM_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Matchmaking Function ────────────────────────────────────────────────────

/**
 * V2 Targeted Matchmaking — accepts pre-batched groups of TargetedMatchTasks.
 * Each batch contains ~20 functions, each with their own Top-K candidate endpoints.
 * Processes batches in parallel with p-limit concurrency control.
 *
 * @param batches - Array of batches, where each batch is an array of { function, candidates[] }
 * @returns Flat array of confirmed { functionUrn, endpointUrn } matches
 */
export async function matchFunctionsToEndpoints(
    batches: TargetedMatchTask[][],
    phase: TokenPhase = 'endpoint_matchmaking',
): Promise<MatchmakingResponse['matches']> {
    if (batches.length === 0) return [];

    const allMatches: MatchmakingResponse['matches'] = [];

    const createLimit = (pLimit as any).default || pLimit;
    const limit = createLimit(5);

    const matchPromises = batches.map((batch, index) => limit(async () => {
        // Build a targeted prompt where each function has its own candidate list
        const sections = batch.map(task => {
            const candidateLines = task.candidates.map(c =>
                `    - URN: ${c.urn} | ${c.method} ${c.path} | Summary: ${c.summary ?? 'none'}`
            ).join('\n');
            return `FUNCTION: ${task.function.name}
  URN: ${task.function.urn}
  Intent: ${task.function.intent ?? 'unknown'}
  Candidate Endpoints:
${candidateLines}`;
        }).join('\n\n');

        const prompt = `For each function below, determine if ANY of its candidate endpoints is a confident match.

${sections}

Return only high-confidence matches. An empty matches array is acceptable.`;

        logger.debug(`[Matchmaker] Prompt (batch ${index + 1}/${batches.length}):\n${prompt}`);

        // ── Retry loop (transient transport failures only) ──────────────────
        // Mastra's own maxRetries is disabled (we own retry/backoff), so this
        // loop re-issues the request only when generate() THROWS — a transient
        // network/5xx error a retry can clear.
        //
        // It deliberately does NOT retry when generate() RESOLVES with an empty
        // object (response.object === undefined): Mastra returns that on a
        // timeout-signal abort, a content-filter block, or genuinely empty model
        // output. Re-issuing the identical temperature-0 prompt to the same model
        // would almost certainly repeat the empty result (see unified-analyzer.ts),
        // so we drop the batch immediately rather than burn two more 60s timeouts.
        // The batch's functions just get no L3 endpoint links; their L1 exact
        // matches are unaffected.
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const startTime = telemetryCollector.startTimer();
                const response = await withCongestionControl(() => getMatchmakerAgent().generate(prompt, {
                    structuredOutput: {
                        schema: MatchmakingResponseSchema,
                    },
                    modelSettings: {
                        maxRetries: 0, // Disabled: we control retries ourselves
                        temperature: 0,
                    },
                    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
                }));

                const duration = telemetryCollector.stopTimer(startTime);
                telemetryCollector.addLLMTime(duration);
                telemetryCollector.addTokensForPhase(phase, response.usage);

                const parsed = MatchmakingResponseSchema.safeParse(response.object);
                if (!parsed.success) {
                    logger.warn(
                        `[Matchmaker] Batch ${index + 1} returned no usable object ` +
                        `(finishReason=${response.finishReason ?? 'n/a'}) — skipping its L3 matches.`
                    );
                    return [];
                }

                logger.debug(`[Matchmaker] Response (batch ${index + 1}): ${JSON.stringify(parsed.data)}`);
                return parsed.data.matches;

            } catch (err) {
                logger.warn(
                    `[Matchmaker] Exception on batch ${index + 1}, attempt ${attempt}/${MAX_RETRIES}: ${(err as Error).message}`
                );
                if (attempt < MAX_RETRIES) {
                    await sleep(attempt * 500);
                    continue;
                }
                logger.error(`[Matchmaker] Batch ${index + 1} exhausted ${MAX_RETRIES} retries after exception — skipping.`);
                return [];
            }
        }

        // Should never reach here, but TypeScript needs a return path
        return [];
    }));

    const results = await Promise.all(matchPromises);
    for (const result of results) {
        allMatches.push(...result);
    }

    return allMatches;
}
