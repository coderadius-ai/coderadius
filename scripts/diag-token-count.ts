/**
 * Counts tokens for the production system prompt with/without PHP hints
 * and for one user prompt extracted from a trace SEND event. Uses Vertex's
 * countTokens API so the numbers are exact for the target model.
 */

import { readFileSync } from 'node:fs';
import { configManager } from '../src/config/index.js';
import { buildAnalyzerInstructions } from '../src/ai/agents/unified-analyzer.js';
import { getLanguagePlugin } from '../src/ingestion/core/languages/registry.js';
import { GoogleAuth } from 'google-auth-library';

async function countTokens(modelId: string, project: string, location: string, system: string, prompt: string): Promise<{ system: number; prompt: number; total: number }> {
    // Vertex global endpoint resolver
    const endpoint = location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
    const url = `${endpoint}/v1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:countTokens`;

    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const token = (await client.getAccessToken()).token;

    async function call(body: object): Promise<number> {
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`countTokens ${res.status}: ${await res.text()}`);
        }
        const j = (await res.json()) as { totalTokens?: number };
        return j.totalTokens ?? 0;
    }

    const sysTok = await call({ contents: [{ role: 'user', parts: [{ text: system }] }] });
    const promptTok = await call({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    const totalTok = await call({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    return { system: sysTok, prompt: promptTok, total: totalTok };
}

async function main() {
    const args = process.argv.slice(2);
    const get = (k: string) => {
        const i = args.findIndex((a) => a === `--${k}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const tracePath = get('trace') ?? '';
    const fnName = get('fn') ?? '';
    const modelId = get('model') ?? 'gemini-2.5-flash-lite';

    if (!tracePath || !fnName) {
        console.error('usage: --trace <path> --fn <functionName> [--model <id>]');
        process.exit(2);
    }

    // Find user prompt for fn
    const lines = readFileSync(tracePath, 'utf-8').split('\n');
    let codeChunk = '', imports: string[] = [], filePath = '';
    for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.stage === 'llm' && ev.action === 'SEND' && ev.data?.functionName === fnName) {
            codeChunk = ev.data.codeChunk;
            imports = ev.data.imports ?? [];
            filePath = ev.data.filePath;
            break;
        }
    }
    if (!codeChunk) throw new Error('No SEND event found');

    const userPrompt = `Analyze the following function. First determine if it performs external I/O. If yes, extract its intent, infrastructure dependencies, and capabilities.
Function name: ${fnName}
File path: ${filePath}
Language: php

--- DI Context (use this to resolve infrastructure names) ---
File imports:
${imports.join('\n')}
--- End DI Context ---

\`\`\`
${codeChunk}
\`\`\``;

    const sysWith = buildAnalyzerInstructions('fast', getLanguagePlugin('php')?.promptHints?.());
    const sysWithout = buildAnalyzerInstructions('fast');

    const cfg = configManager.getAiConfig('ingest');
    if (!cfg.project || !cfg.location) throw new Error('no vertex config');

    console.log(`# fn=${fnName}  model=${modelId}`);
    console.log(`# system char counts:  with-hints=${sysWith.length}   without-hints=${sysWithout.length}   delta=${sysWith.length - sysWithout.length}`);
    console.log(`# user prompt char count: ${userPrompt.length}`);
    console.log('');

    const tWith = await countTokens(modelId, cfg.project, cfg.location, sysWith, userPrompt);
    const tWithout = await countTokens(modelId, cfg.project, cfg.location, sysWithout, userPrompt);

    console.log('Token counts (Vertex countTokens API):');
    console.log(`  with PHP hints   :  system=${String(tWith.system).padStart(5)}  user=${String(tWith.prompt).padStart(5)}  total=${String(tWith.total).padStart(5)}`);
    console.log(`  without PHP hints:  system=${String(tWithout.system).padStart(5)}  user=${String(tWithout.prompt).padStart(5)}  total=${String(tWithout.total).padStart(5)}`);
    console.log(`  delta (hints add):  system=${tWith.system - tWithout.system}  total=${tWith.total - tWithout.total}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
