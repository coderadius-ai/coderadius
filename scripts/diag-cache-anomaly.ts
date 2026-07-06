/**
 * Read-only diagnosis of the Vertex implicit-cache anomaly.
 *
 * Observed: large ingestion runs show 17-27% cache rates while a small run
 * shows 55%. This script tests four hypotheses against trace JSONLs already
 * on disk, without any LLM call:
 *
 *   (a) AIMD cold-burst — cache rate as a function of call order: if the
 *       first parallel burst misses and the rate climbs later, ramp-up is
 *       the driver.
 *   (b) Prefix instability — the longest common prefix (LCP) of the leading
 *       user-prompt blocks across consecutive calls: if per-file blocks vary
 *       call-to-call, the common prefix collapses to the system prompt.
 *   (c) Under-minimum prefix — distribution of cached-token values: if warm
 *       calls cache a uniform amount ≈ system-prompt size, the cache never
 *       extends into user blocks; if many calls have cached=0 despite a
 *       stable system prompt, the implicit cache is being evicted/missed.
 *   (d) Per-language agent fragmentation — distinct languages in the run
 *       splitting traffic across `${mode}:${language}` system prompts.
 *
 * Usage: bun run scripts/diag-cache-anomaly.ts <trace.jsonl> [more traces...]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildAnalyzerInstructions } from '../src/ai/agents/unified-analyzer.js';
import { getLanguagePlugin } from '../src/ingestion/core/languages/registry.js';

interface SendRec {
    ts: number;
    target: string;
    lang: string;
    filePath: string;
    leading: string; // reconstructed leading user blocks (pre-"Function name:")
}

interface CallRec {
    ts: number;
    target: string;
    lang: string;
    in: number;
    out: number;
    cached: number;
}

function inferLanguageFromPath(filePath: string | undefined): string {
    if (!filePath) return 'unknown';
    if (/\.php$/.test(filePath)) return 'php';
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return 'typescript';
    if (/\.go$/.test(filePath)) return 'go';
    if (/\.py$/.test(filePath)) return 'python';
    return 'unknown';
}

/**
 * Reconstruct the user-prompt prefix that precedes the per-function header,
 * from the raw fields present on SEND events. customKnowledge / entityTable /
 * clientBinding are not logged: customKnowledge is per-repo constant (does
 * not add variance); the other two are an accepted approximation.
 */
function reconstructLeading(d: Record<string, any>): string {
    const framework = typeof d.frameworkSignalContext === 'string' ? d.frameworkSignalContext : '';
    const constants = typeof d.classConstantsContext === 'string' ? d.classConstantsContext : '';
    const sections: string[] = [];
    if (Array.isArray(d.imports) && d.imports.length > 0) sections.push(`File imports:\n${d.imports.join('\n')}`);
    if (typeof d.constructorSource === 'string' && d.constructorSource) {
        sections.push(`Class constructor (for DI resolution):\n\`\`\`\n${d.constructorSource}\n\`\`\``);
    }
    if (Array.isArray(d.classProperties) && d.classProperties.length > 0) {
        sections.push(`Class property types:\n${d.classProperties.join('\n')}`);
    }
    const di = sections.length > 0
        ? `\n\n--- DI Context (use this to resolve infrastructure names) ---\n${sections.join('\n\n')}\n--- End DI Context ---\n`
        : '';
    return `${framework}${constants}${di}`;
}

function lcpLength(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
}

function pct(n: number, d: number): string {
    return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
}

function analyzeTrace(tracePath: string): void {
    const lines = readFileSync(tracePath, 'utf-8').split('\n');
    const sends: SendRec[] = [];
    const calls: CallRec[] = [];
    const langOfFn = new Map<string, string>();

    for (const line of lines) {
        if (!line.trim()) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.stage !== 'llm') continue;
        const ts = typeof j.ts === 'number' ? j.ts : Date.parse(j.ts) || 0;

        if (j.action === 'SEND') {
            const d = j.data ?? {};
            const lang = d.language ?? inferLanguageFromPath(d.filePath);
            langOfFn.set(j.target, lang);
            sends.push({ ts, target: j.target, lang, filePath: d.filePath ?? '', leading: reconstructLeading(d) });
        } else if ((j.action === 'RECEIVE' || j.action === 'REJECT') && j.data?.tokens) {
            calls.push({
                ts,
                target: j.target,
                lang: langOfFn.get(j.target) ?? 'unknown',
                in: j.data.tokens.in ?? 0,
                out: j.data.tokens.out ?? 0,
                cached: j.data.tokens.cached ?? 0,
            });
        }
    }

    if (calls.length === 0) {
        console.log(`\n# ${basename(tracePath)} — no LLM calls with token data, skipped`);
        return;
    }

    calls.sort((x, y) => x.ts - y.ts);
    const totalIn = calls.reduce((a, c) => a + c.in, 0);
    const totalCached = calls.reduce((a, c) => a + c.cached, 0);

    console.log('');
    console.log('# ════════════════════════════════════════════════════════════════════');
    console.log(`# ${basename(tracePath)}`);
    console.log(`# calls=${calls.length} in=${totalIn} cached=${totalCached} (overall cache rate ${pct(totalCached, totalIn)})`);
    console.log('# ════════════════════════════════════════════════════════════════════');

    // ── (a) Cold burst: cache rate per decile of call order ──────────────────
    console.log('\n## (a) cold-burst — cache rate by call-order decile');
    const decileSize = Math.max(1, Math.ceil(calls.length / 10));
    const decileRates: number[] = [];
    for (let dIdx = 0; dIdx < 10; dIdx++) {
        const slice = calls.slice(dIdx * decileSize, (dIdx + 1) * decileSize);
        if (slice.length === 0) break;
        const inSum = slice.reduce((a, c) => a + c.in, 0);
        const cachedSum = slice.reduce((a, c) => a + c.cached, 0);
        decileRates.push(inSum > 0 ? cachedSum / inSum : 0);
        console.log(`   decile ${dIdx + 1}: ${pct(cachedSum, inSum)} (${slice.length} calls)`);
    }
    const earlyRate = decileRates[0] ?? 0;
    const lateAvg = decileRates.slice(2).length > 0
        ? decileRates.slice(2).reduce((a, b) => a + b, 0) / decileRates.slice(2).length
        : 0;
    const coldBurstVerdict = lateAvg - earlyRate > 0.15
        ? 'SUPPORTED (rate climbs after warm-up)'
        : 'WEAK (rate roughly flat across the run)';
    console.log(`   verdict: ${coldBurstVerdict}`);

    // ── (c) cached-value distribution ─────────────────────────────────────────
    console.log('\n## (c) cached-token distribution (warm-call uniformity)');
    const zero = calls.filter((c) => c.cached === 0).length;
    const warm = calls.filter((c) => c.cached > 0).map((c) => c.cached).sort((a, b) => a - b);
    const buckets: Array<[string, (v: number) => boolean]> = [
        ['(0..1K]', (v) => v <= 1_000],
        ['(1K..2K]', (v) => v > 1_000 && v <= 2_000],
        ['(2K..3K]', (v) => v > 2_000 && v <= 3_000],
        ['(3K..4.5K]', (v) => v > 3_000 && v <= 4_500],
        ['>4.5K', (v) => v > 4_500],
    ];
    console.log(`   cached=0 : ${zero} calls (${pct(zero, calls.length)})  ← full cache misses`);
    for (const [label, fn] of buckets) {
        const n = warm.filter(fn).length;
        console.log(`   ${label.padEnd(9)}: ${n} calls (${pct(n, calls.length)})`);
    }
    if (warm.length > 0) {
        const p50 = warm[Math.floor(0.5 * (warm.length - 1))];
        const within5 = warm.filter((v) => Math.abs(v - p50) / p50 <= 0.05).length;
        console.log(`   warm p50=${p50}; ${pct(within5, warm.length)} of warm calls within ±5% of p50`);
        console.log(`   → uniform warm value ≈ prefix dies at a FIXED boundary (system prompt)`);
    }

    // System-prompt char estimate per language present in the run
    const langs = [...new Set(calls.map((c) => c.lang))];
    for (const lang of langs) {
        const hints = getLanguagePlugin(lang)?.promptHints?.();
        const sys = buildAnalyzerInstructions('fast', hints ?? undefined);
        console.log(`   system prompt (fast, ${lang}): ${sys.length} chars ≈ ${Math.round(sys.length / 4)} tok (chars/4)`);
    }

    // ── (b) prefix instability: LCP of leading blocks ─────────────────────────
    console.log('\n## (b) prefix instability — LCP of reconstructed leading user blocks');
    sends.sort((x, y) => x.ts - y.ts);
    const consecutiveLcp: number[] = [];
    for (let i = 1; i < sends.length; i++) {
        consecutiveLcp.push(lcpLength(sends[i - 1].leading, sends[i].leading));
    }
    const sameFileLcp: number[] = [];
    const byFile = new Map<string, SendRec[]>();
    for (const s of sends) {
        const arr = byFile.get(s.filePath) ?? [];
        arr.push(s);
        byFile.set(s.filePath, arr);
    }
    for (const group of byFile.values()) {
        for (let i = 1; i < group.length; i++) {
            sameFileLcp.push(lcpLength(group[0].leading, group[i].leading));
        }
    }
    const stat = (arr: number[]): string => {
        if (arr.length === 0) return 'n/a';
        const sorted = [...arr].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(0.5 * (sorted.length - 1))];
        const under256 = sorted.filter((v) => v < 256).length;
        return `pairs=${arr.length} p50=${p50}ch under-256ch=${pct(under256, arr.length)}`;
    };
    console.log(`   consecutive sends (cross-file): ${stat(consecutiveLcp)}`);
    console.log(`   within same file:               ${stat(sameFileLcp)}`);
    console.log('   → consecutive cross-file LCP ≈ 0 means every call breaks the prefix at');
    console.log('     the first per-file block; same-file LCP high means batching (L1) or');
    console.log('     file-ordered scheduling would restore cacheability.');
    const multiFnFiles = [...byFile.values()].filter((g) => g.length > 1).length;
    const avgPerFile = sends.length / Math.max(1, byFile.size);
    console.log(`   files with >1 LLM call: ${multiFnFiles}/${byFile.size} (avg ${avgPerFile.toFixed(2)} calls/file)`);

    // ── (d) language fragmentation ────────────────────────────────────────────
    console.log('\n## (d) language fragmentation');
    const callsPerLang = new Map<string, number>();
    for (const c of calls) callsPerLang.set(c.lang, (callsPerLang.get(c.lang) ?? 0) + 1);
    for (const [lang, n] of [...callsPerLang.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`   ${lang.padEnd(12)}: ${n} calls (${pct(n, calls.length)})`);
    }
    const dominant = Math.max(...callsPerLang.values());
    console.log(`   verdict: ${dominant / calls.length >= 0.95 ? 'WEAK (single agent dominates)' : 'POSSIBLE contributor (traffic split across agents)'}`);
}

const traces = process.argv.slice(2);
if (traces.length === 0) {
    console.error('usage: bun run scripts/diag-cache-anomaly.ts <trace.jsonl> [more...]');
    process.exit(1);
}
for (const t of traces) analyzeTrace(t);
