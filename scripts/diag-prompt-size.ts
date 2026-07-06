/**
 * diag-prompt-size.ts — repeatable token-size harness for the analyzer prompt.
 *
 * Measures the STATIC per-call prompt weight (systemInstruction + responseSchema)
 * for every (mode, language) the unified-analyzer serves. Re-run after each
 * reduction stage and diff against the Stage-0 baseline to track progress toward
 * the ~600 tok/call target.
 *
 *   bun run scripts/diag-prompt-size.ts
 *
 * Token estimate uses chars/4 (stable proxy; absolute Vertex tokens differ
 * slightly but the ratio and trend are what matter here).
 */
import { z } from 'zod';
import {
    buildAnalyzerInstructions,
    FastUnifiedAnalysisSchema,
    DeepUnifiedAnalysisSchema,
} from '../src/ai/agents/unified-analyzer.js';
import { getLanguagePlugin } from '../src/ingestion/core/languages/registry.js';

const LANGS = ['typescript', 'php', 'go', 'python'] as const;
const estTok = (s: string) => Math.round(s.length / 4);

function schemaChars(schema: z.ZodTypeAny): number {
    try {
        // Zod v4 native JSON-schema (what the AI SDK serializes into generationConfig.responseSchema)
        const json = (z as unknown as { toJSONSchema: (s: z.ZodTypeAny) => unknown }).toJSONSchema(schema);
        return JSON.stringify(json).length;
    } catch {
        return -1; // converter rejected (transforms/catch); caller falls back to describe-sum
    }
}

/** Recursively sum every `.describe()` string in the schema tree — the Stage-4 trim metric. */
function describeChars(node: unknown, seen = new Set<unknown>()): number {
    if (!node || typeof node !== 'object' || seen.has(node)) return 0;
    seen.add(node);
    let total = 0;
    const def = (node as { _def?: Record<string, unknown> })._def ?? (node as { def?: Record<string, unknown> }).def;
    const desc = (node as { description?: string }).description ?? (def?.description as string | undefined);
    if (typeof desc === 'string') total += desc.length;
    // Walk object shape, array element, and wrapped inner types across zod v3/v4 layouts.
    const shape = (node as { shape?: Record<string, unknown> }).shape
        ?? (typeof def?.shape === 'function' ? (def.shape as () => Record<string, unknown>)() : def?.shape);
    if (shape && typeof shape === 'object') for (const v of Object.values(shape)) total += describeChars(v, seen);
    for (const k of ['element', 'innerType', 'in', 'out', 'schema', 'type']) {
        if (def?.[k]) total += describeChars(def[k], seen);
    }
    return total;
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);

console.log('\n=== Analyzer static prompt size (systemInstruction) ===');
console.log(`${pad('mode:language', 22)}${padL('sys_chars', 11)}${padL('sys_tok~', 10)}`);
const rows: Array<{ key: string; sysTok: number }> = [];
for (const mode of ['fast', 'deep'] as const) {
    for (const lang of LANGS) {
        const hints = getLanguagePlugin(lang)?.promptHints?.() ?? '';
        const sys = buildAnalyzerInstructions(mode, hints);
        rows.push({ key: `${mode}:${lang}`, sysTok: estTok(sys) });
        console.log(`${pad(`${mode}:${lang}`, 22)}${padL(sys.length, 11)}${padL(estTok(sys), 10)}`);
    }
}

// Ground-truth responseSchema char counts captured from real Vertex request bodies
// (tests/eval/.llm-cache request.body.generationConfig.responseSchema). Stage-0 baseline.
const SCHEMA_GROUND_TRUTH_CHARS = { fast: 7845, deep: 10010 } as const;

console.log('\n=== responseSchema size (sent every call, uncacheable) ===');
console.log(`${pad('mode', 22)}${padL('json_chars', 11)}${padL('json_tok~', 10)}${padL('describe_chars', 16)}`);
for (const [name, schema] of [['fast', FastUnifiedAnalysisSchema], ['deep', DeepUnifiedAnalysisSchema]] as const) {
    const converted = schemaChars(schema);
    const chars = converted >= 0 ? converted : SCHEMA_GROUND_TRUTH_CHARS[name];
    const tag = converted >= 0 ? '' : ' (trace ground-truth)';
    console.log(`${pad(name, 22)}${padL(chars, 11)}${padL(estTok('x'.repeat(chars)), 10)}${padL(describeChars(schema), 16)}${tag}`);
}

console.log('\n=== per-call STATIC total (sys + schema) ===');
const fastSchemaTok = estTok('x'.repeat(SCHEMA_GROUND_TRUTH_CHARS.fast));
const deepSchemaTok = estTok('x'.repeat(SCHEMA_GROUND_TRUTH_CHARS.deep));
for (const r of rows) {
    const total = r.sysTok + (r.key.startsWith('fast') ? fastSchemaTok : deepSchemaTok);
    console.log(`${pad(r.key, 22)}${padL(total + ' tok', 12)}`);
}
console.log('\nTarget endpoint: ~600 tok/call.\n');
