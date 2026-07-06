// ═══════════════════════════════════════════════════════════════════════════════
// Trace Query — On-Demand JSONL Querying
//
// Streams a .trace.jsonl file and filters events by function, file, or stage.
// Safe on any JSONL size (uses readline, not full load).
//
// Usage (programmatic):
//   const events = await findByFunction('path.trace.jsonl', 'processPayment');
//   const prompt = await extractPrompt('path.trace.jsonl', 'processPayment');
//
// Usage (CLI — future):
//   npx trace-query --function "processPayment" --stage llm session.trace.jsonl
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import readline from 'node:readline';
import type { TraceEvent, TraceStage } from './trace-collector.js';

/**
 * Find all events for a specific function (by name substring match).
 * Returns the full event timeline including raw LLM prompts/responses.
 */
export async function findByFunction(jsonlPath: string, funcName: string): Promise<TraceEvent[]> {
    const events: TraceEvent[] = [];
    const lowerName = funcName.toLowerCase();

    await streamJsonl(jsonlPath, (event) => {
        const targetMatch = event.target.toLowerCase().includes(lowerName);
        const dataMatch = (event.data?.functionName as string | undefined)?.toLowerCase().includes(lowerName);
        if (targetMatch || dataMatch) {
            events.push(event);
        }
    });

    return events;
}

/**
 * Find all events for a specific file path (substring match).
 */
export async function findByFile(jsonlPath: string, filePath: string): Promise<TraceEvent[]> {
    const events: TraceEvent[] = [];
    const lowerPath = filePath.toLowerCase();

    await streamJsonl(jsonlPath, (event) => {
        const targetMatch = event.target.toLowerCase().includes(lowerPath);
        const dataMatch = (event.data?.filePath as string | undefined)?.toLowerCase().includes(lowerPath);
        if (targetMatch || dataMatch) {
            events.push(event);
        }
    });

    return events;
}

/**
 * Find all DROP, REJECT, and FAIL events (functions that didn't make it through).
 */
export async function findDroppedFunctions(jsonlPath: string): Promise<TraceEvent[]> {
    const events: TraceEvent[] = [];

    await streamJsonl(jsonlPath, (event) => {
        if (event.action === 'DROP' || event.action === 'REJECT' || event.action === 'FAIL') {
            events.push(event);
        }
    });

    return events;
}

/**
 * Find "surprise" drops — functions dropped at non-obvious stages
 * (Sanitizer, LLM failure, Graph Write failure).
 * These are the highest-value debugging targets.
 */
export async function findSurprises(jsonlPath: string): Promise<TraceEvent[]> {
    const surpriseStages = new Set<TraceStage>(['sanitizer', 'llm', 'persist']);
    const surpriseActions = new Set(['DROP', 'FAIL']);
    const events: TraceEvent[] = [];

    await streamJsonl(jsonlPath, (event) => {
        if (surpriseStages.has(event.stage) && surpriseActions.has(event.action)) {
            events.push(event);
        }
    });

    return events;
}

/**
 * Extract the raw LLM prompt for a specific function.
 * Returns the full SEND event data (including codeChunk, imports, etc.),
 * which can be pasted directly into Gemini for debugging.
 */
export async function extractPrompt(jsonlPath: string, funcName: string): Promise<TraceEvent | null> {
    const lowerName = funcName.toLowerCase();
    let result: TraceEvent | null = null;

    await streamJsonl(jsonlPath, (event) => {
        if (result) return; // already found

        if (event.stage === 'llm' && event.action === 'SEND') {
            const targetMatch = event.target.toLowerCase().includes(lowerName);
            const dataMatch = (event.data?.functionName as string | undefined)?.toLowerCase().includes(lowerName);
            if (targetMatch || dataMatch) {
                result = event;
            }
        }
    });

    return result;
}

/**
 * Filter events by pipeline stage.
 */
export async function findByStage(jsonlPath: string, stage: TraceStage): Promise<TraceEvent[]> {
    const events: TraceEvent[] = [];

    await streamJsonl(jsonlPath, (event) => {
        if (event.stage === stage) {
            events.push(event);
        }
    });

    return events;
}

// ─── Internal Stream Helper ──────────────────────────────────────────────────

async function streamJsonl(jsonlPath: string, callback: (event: TraceEvent) => void): Promise<void> {
    if (!fs.existsSync(jsonlPath)) return;

    const fileStream = fs.createReadStream(jsonlPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const event: TraceEvent = JSON.parse(line);
            callback(event);
        } catch {
            // skip malformed lines
        }
    }
}
