/**
 * Decomposes the production system + user prompt of unified-analyzer.ts into
 * its constituent blocks and reports char + Vertex-token counts per block.
 *
 * Goal: answer "where do hints/envs/configs live, and what's stable for
 * Vertex prefix caching?" without guessing.
 *
 * Modes:
 *   (default)            system-prompt section breakdown + optional-block caps
 *   --trace X --fn Y     one SEND event sample, exact per-block Vertex tokens
 *   --corpus X           aggregate ALL SEND events of a trace JSONL: per-section
 *                        p50/p95/sum char distribution grouped by language, plus
 *                        empirical token calibration from paired RECEIVE/REJECT
 *                        events. Uses the sectionChars field stamped on SEND
 *                        events; legacy traces without it fall back to a
 *                        partial reconstruction from the raw SEND fields.
 */

import { readFileSync } from 'node:fs';
import { configManager } from '../src/config/index.js';
import { buildAnalyzerInstructions, PROMPT_SECTION_NAMES } from '../src/ai/agents/unified-analyzer.js';
import { getLanguagePlugin } from '../src/ingestion/core/languages/registry.js';
import { GoogleAuth } from 'google-auth-library';

interface Section {
    name: string;
    where: 'system' | 'user';
    cacheable: 'YES' | 'PER-LANG' | 'PER-REPO' | 'PER-FILE' | 'PER-CALL';
    contributesTo: 'instructions' | 'context';
    chars: number;
    tokens?: number;
    maxChars?: number;
    note?: string;
}

async function vertexCountTokens(modelId: string, project: string, location: string, text: string): Promise<number> {
    const endpoint = location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
    const url = `${endpoint}/v1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:countTokens`;
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const token = (await client.getAccessToken()).token;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }),
    });
    if (!res.ok) throw new Error(`countTokens ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { totalTokens?: number }).totalTokens ?? 0;
}

function splitSystemBySection(system: string): Array<{ name: string; chars: number; sample: string }> {
    // Sections are delimited by XML-like tags (<core_directive>...</core_directive>).
    // PHP_PROMPT_HINTS sits at the very end inside <php_rules>.
    // The leading "You are an expert code analysis engine..." is the preamble.
    const sections: Array<{ name: string; chars: number; sample: string }> = [];
    const tagRegex = /<(?<tag>[a-z_]+)>([\s\S]*?)<\/\k<tag>>/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(system)) !== null) {
        if (match.index > cursor) {
            const between = system.slice(cursor, match.index);
            if (between.trim().length > 0) {
                sections.push({ name: '(prose between tags)', chars: between.length, sample: between.trim().slice(0, 60) });
            }
        }
        sections.push({
            name: `<${match.groups!.tag}>`,
            chars: match[0].length,
            sample: match[2].trim().slice(0, 60),
        });
        cursor = match.index + match[0].length;
    }
    if (cursor < system.length) {
        const tail = system.slice(cursor);
        if (tail.trim().length > 0) {
            sections.push({ name: '(prose tail)', chars: tail.length, sample: tail.trim().slice(0, 60) });
        }
    }
    return sections;
}

// ─── Corpus aggregation ──────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
    return sorted[idx];
}

/** Partial reconstruction for legacy traces without sectionChars. */
function reconstructLegacySections(d: Record<string, any>): Record<string, number> {
    return {
        sourceCode: typeof d.codeChunk === 'string' ? d.codeChunk.length : 0,
        di_imports: Array.isArray(d.imports) ? d.imports.join('\n').length : 0,
        di_constructorSource: typeof d.constructorSource === 'string' ? d.constructorSource.length : 0,
        di_classProperties: Array.isArray(d.classProperties) ? d.classProperties.join('\n').length : 0,
        taint: typeof d.taintContext === 'string' ? d.taintContext.length : 0,
        resolvedInvocation: typeof d.resolvedInvocationContext === 'string' ? d.resolvedInvocationContext.length : 0,
        classConstants: typeof d.classConstantsContext === 'string' ? d.classConstantsContext.length : 0,
        frameworkSignal: typeof d.frameworkSignalContext === 'string' ? d.frameworkSignalContext.length : 0,
    };
}

function inferLanguageFromPath(filePath: string | undefined): string {
    if (!filePath) return 'unknown';
    if (/\.php$/.test(filePath)) return 'php';
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return 'typescript';
    if (/\.go$/.test(filePath)) return 'go';
    if (/\.py$/.test(filePath)) return 'python';
    return 'unknown';
}

function aggregateCorpus(tracePath: string): void {
    const lines = readFileSync(tracePath, 'utf-8').split('\n');

    // language → section → values per call
    const byLang = new Map<string, Map<string, number[]>>();
    // language → paired token totals from RECEIVE/REJECT events
    const tokensByLang = new Map<string, { calls: number; in: number; out: number; cached: number }>();
    const langOfFn = new Map<string, string>();
    let sendCount = 0;
    let withSectionChars = 0;
    let legacyCount = 0;

    for (const line of lines) {
        if (!line.trim()) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.stage !== 'llm') continue;

        if (j.action === 'SEND') {
            sendCount++;
            const d = j.data ?? {};
            const lang: string = d.language ?? inferLanguageFromPath(d.filePath);
            if (j.target) langOfFn.set(j.target, lang);

            let sections: Record<string, number>;
            if (d.sectionChars && typeof d.sectionChars === 'object') {
                withSectionChars++;
                sections = d.sectionChars;
            } else {
                legacyCount++;
                sections = reconstructLegacySections(d);
            }

            let perSection = byLang.get(lang);
            if (!perSection) { perSection = new Map(); byLang.set(lang, perSection); }
            for (const [name, value] of Object.entries(sections)) {
                if (typeof value !== 'number') continue;
                let arr = perSection.get(name);
                if (!arr) { arr = []; perSection.set(name, arr); }
                arr.push(value);
            }
        } else if ((j.action === 'RECEIVE' || j.action === 'REJECT') && j.data?.tokens) {
            const lang = langOfFn.get(j.target) ?? 'unknown';
            let t = tokensByLang.get(lang);
            if (!t) { t = { calls: 0, in: 0, out: 0, cached: 0 }; tokensByLang.set(lang, t); }
            t.calls++;
            t.in += j.data.tokens.in ?? 0;
            t.out += j.data.tokens.out ?? 0;
            t.cached += j.data.tokens.cached ?? 0;
        }
    }

    console.log('# ════════════════════════════════════════════════════════════════════');
    console.log(`# CORPUS — ${tracePath}`);
    console.log(`# SEND events: ${sendCount} (sectionChars: ${withSectionChars}, legacy reconstruction: ${legacyCount})`);
    console.log('# ════════════════════════════════════════════════════════════════════');
    if (legacyCount > 0) {
        console.log('# NOTE: legacy events lack customKnowledge/entityTable/typeDefs/graphqlDoc/');
        console.log('#       clientBinding/diContext-combined; their sums are LOWER BOUNDS.');
    }

    const blockNames = new Set<string>(PROMPT_SECTION_NAMES as readonly string[]);

    for (const [lang, perSection] of [...byLang.entries()].sort((a, b) => b[1].size - a[1].size)) {
        const calls = Math.max(...[...perSection.values()].map((v) => v.length), 0);
        const totalChars = [...perSection.entries()]
            .filter(([name]) => blockNames.has(name))
            .reduce((acc, [, v]) => acc + v.reduce((a, b) => a + b, 0), 0);

        console.log('');
        console.log(`## language=${lang} (${calls} calls, user-prompt block total ≈ ${(totalChars / 1000).toFixed(0)}K chars)`);
        console.log('   section                    nonzero    p50ch    p95ch       sum   share%');

        const rows = [...perSection.entries()].sort(
            (a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0),
        );
        for (const [name, values] of rows) {
            const sorted = [...values].sort((a, b) => a - b);
            const sum = values.reduce((a, b) => a + b, 0);
            const nonzero = values.filter((v) => v > 0).length;
            const isBlock = blockNames.has(name);
            const share = isBlock && totalChars > 0 ? `${((sum / totalChars) * 100).toFixed(1)}%` : '(detail)';
            console.log(
                `   ${name.padEnd(26)} ${String(nonzero).padStart(7)} ${String(percentile(sorted, 0.5)).padStart(8)} ${String(percentile(sorted, 0.95)).padStart(8)} ${String(sum).padStart(9)}  ${share.padStart(7)}`,
            );
        }

        const t = tokensByLang.get(lang);
        if (t && t.calls > 0) {
            const cacheRate = t.in > 0 ? ((t.cached / t.in) * 100).toFixed(1) : '0';
            console.log(`   tokens (paired ${t.calls} calls): in=${t.in} out=${t.out} cached=${t.cached} (cache rate ${cacheRate}%)`);
            console.log(`   per call: in=${Math.round(t.in / t.calls)} out=${Math.round(t.out / t.calls)} cached=${Math.round(t.cached / t.calls)}; user chars/call=${calls > 0 ? Math.round(totalChars / calls) : 0}`);
        }
    }
    console.log('');
}

async function main() {
    const args = process.argv.slice(2);
    const get = (k: string): string | undefined => {
        const i = args.findIndex((a) => a === `--${k}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const corpusPath = get('corpus') ?? '';
    if (corpusPath) {
        aggregateCorpus(corpusPath);
        return;
    }
    const tracePath = get('trace') ?? '';
    const fnName = get('fn') ?? '';
    const modelId = get('model') ?? 'gemini-2.5-flash-lite';
    const wantTokens = !args.includes('--no-tokens');

    const cfg = configManager.getAiConfig('ingest');
    if (wantTokens && (!cfg.project || !cfg.location)) {
        console.warn('# no Vertex config; skipping token counts');
    }

    const phpHints = getLanguagePlugin('php')?.promptHints?.();
    const sysWith = buildAnalyzerInstructions('fast', phpHints);
    const sysWithout = buildAnalyzerInstructions('fast');

    console.log('# ════════════════════════════════════════════════════════════════════');
    console.log('# SYSTEM PROMPT — sections (fast scan, PHP plugin hints)');
    console.log('# ════════════════════════════════════════════════════════════════════');

    const sysParts = splitSystemBySection(sysWith);
    let totalChars = 0;
    for (const p of sysParts) {
        totalChars += p.chars;
        let tokStr = '';
        if (wantTokens && cfg.project && cfg.location) {
            const tok = await vertexCountTokens(modelId, cfg.project, cfg.location, sysWith.slice(0, p.chars));
            tokStr = ''; // skip per-section tokens (cumulative would be misleading; just chars)
        }
        console.log(`  [${String(p.chars).padStart(5)} ch]  ${p.name.padEnd(28)} "${p.sample.replace(/\n/g, ' ')}…"`);
    }
    console.log(`  total chars: ${sysWith.length}, no-hints: ${sysWithout.length}, hints add: ${sysWith.length - sysWithout.length}`);

    if (wantTokens && cfg.project && cfg.location) {
        const tWith = await vertexCountTokens(modelId, cfg.project, cfg.location, sysWith);
        const tWithout = await vertexCountTokens(modelId, cfg.project, cfg.location, sysWithout);
        const tHints = await vertexCountTokens(modelId, cfg.project, cfg.location, phpHints ?? '');
        console.log(`  total tokens (Vertex countTokens, ${modelId}):`);
        console.log(`    with hints   : ${tWith}`);
        console.log(`    without hints: ${tWithout}`);
        console.log(`    hints alone  : ${tHints}`);
    }

    if (tracePath && fnName) {
        console.log('');
        console.log('# ════════════════════════════════════════════════════════════════════');
        console.log(`# USER PROMPT — sample for fn=${fnName}`);
        console.log('# ════════════════════════════════════════════════════════════════════');
        const lines = readFileSync(tracePath, 'utf-8').split('\n');
        let ev: any = null;
        for (const line of lines) {
            if (!line.trim()) continue;
            const j = JSON.parse(line);
            if (j.stage === 'llm' && j.action === 'SEND' && j.data?.functionName === fnName) {
                ev = j;
                break;
            }
        }
        if (!ev) {
            console.log(`(no SEND event for fn="${fnName}" in trace)`);
        } else {
            const d = ev.data;
            const blocks: Array<[string, string | undefined]> = [
                ['header', `Analyze the following function. First determine if it performs external I/O. If yes, extract its intent, infrastructure dependencies, and capabilities.\nFunction name: ${d.functionName}\nFile path: ${d.filePath}\nLanguage: php`],
                ['DI Context (imports/ctor/props)', d.imports ? `--- DI Context (use this to resolve infrastructure names) ---\nFile imports:\n${d.imports.join('\n')}\n--- End DI Context ---` : undefined],
                ['resolvedInvocationContext', d.resolvedInvocationContext],
                ['codeChunk (fenced)', `\`\`\`\n${d.codeChunk}\n\`\`\``],
            ];
            for (const [name, content] of blocks) {
                if (!content) {
                    console.log(`  [   - ch]  ${name.padEnd(40)} (not in trace)`);
                    continue;
                }
                const c = content.length;
                let t = '';
                if (wantTokens && cfg.project && cfg.location) {
                    const tok = await vertexCountTokens(modelId, cfg.project, cfg.location, content);
                    t = ` ${String(tok).padStart(5)} tok`;
                }
                console.log(`  [${String(c).padStart(5)} ch${t}]  ${name.padEnd(40)} "${content.slice(0, 60).replace(/\n/g, ' ')}…"`);
            }
        }
    }

    console.log('');
    console.log('# ════════════════════════════════════════════════════════════════════');
    console.log('# OPTIONAL USER-PROMPT BLOCKS (computed by pipeline, not in SEND log)');
    console.log('# Limits from truncateForPrompt() calls in unified-analyzer.ts');
    console.log('# ════════════════════════════════════════════════════════════════════');
    const optionalBlocks: Array<[string, number, string]> = [
        ['imports (per file)',          8000, 'PER-FILE — file imports list'],
        ['constructorSource',           8000, 'PER-CLASS — DI constructor signature'],
        ['classProperties',             6000, 'PER-CLASS — typed properties'],
        ['contextBlock (combined cap)', 18000, 'PER-FILE — sum of above, hard cap'],
        ['taintContextSummary',         6000, 'PER-FUNCTION — BFS reachability from sinks'],
        ['customKnowledge',             8000, 'PER-REPO — coderadius.yaml decorators'],
        ['resolvedTypeDefinitions',     4000, 'PER-FUNCTION — cross-file types (deep mode)'],
        ['entityTableContext',          3000, 'PER-FILE — ORM entity→table map'],
        ['frameworkSignalContext',      4000, 'PER-FILE — framework signals (Symfony etc)'],
        ['classConstantsContext',       2000, 'PER-FILE — AST-resolved string/number consts'],
        ['clientBindingContext',        2000, 'PER-CLASS — DI token recognition'],
        ['graphQLDocumentContext',      4000, 'PER-FUNCTION — GraphQL schema index'],
        ['resolvedInvocationContext',   3000, 'PER-FUNCTION — static value resolution'],
        ['sourceCode (fast cap)',       20000, 'PER-FUNCTION — code chunk'],
        ['sourceCode (deep cap)',       30000, 'PER-FUNCTION — code chunk (deep mode)'],
    ];
    for (const [name, cap, note] of optionalBlocks) {
        console.log(`  [≤${String(cap).padStart(5)} ch]  ${name.padEnd(40)} ${note}`);
    }
    console.log('');
    console.log('# theoretical worst-case user prompt = sum of caps ≈ 75K chars ≈ 19K tokens');
}

main().catch((e) => { console.error(e); process.exit(1); });
