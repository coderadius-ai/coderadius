/**
 * Capture the wire request sent to Vertex for one batch structured-output call.
 * Logs generationConfig (responseSchema/responseMimeType) and whether the
 * prompt carries an injected JSON-schema instruction.
 *
 * Usage: bun scripts/diag-wire-capture.ts
 */
import { getAnalyzerStrategy, BatchedFastAnalysisSchema } from '../src/ai/agents/unified-analyzer.js';

const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (/generateContent|streamGenerateContent/.test(url) && init?.body) {
        try {
            const body = JSON.parse(init.body);
            const gc = body.generationConfig ?? {};
            console.log('=== WIRE REQUEST ===');
            console.log('url:', url.replace(/projects\/[^/]+/, 'projects/<redacted>').slice(0, 160));
            console.log('responseMimeType:', gc.responseMimeType);
            console.log('responseSchema present:', gc.responseSchema !== undefined);
            if (gc.responseSchema) {
                const item = gc.responseSchema?.properties?.analyses?.items;
                console.log('responseSchema analyses.items.properties:', Object.keys(item?.properties ?? {}));
                console.log('responseSchema infra items:', JSON.stringify(item?.properties?.infrastructure?.items)?.slice(0, 400));
            }
            const allText = JSON.stringify(body.contents ?? '') + JSON.stringify(body.systemInstruction ?? '');
            console.log('prompt mentions json schema instruction:', /respond with a json object|json schema|"type"\s*:\s*"string"/i.test(allText));
            console.log('====================');
        } catch (e) {
            console.log('(wire capture parse failed)', (e as Error).message);
        }
    }
    return origFetch(input, init);
}) as typeof fetch;

const agent = await getAnalyzerStrategy('semantic', 'php', true);
const prompt = 'Analyze EACH function below independently. Return one "analyses" array entry per function.\n\nLanguage: php\n===== FUNCTION 1 of 1 — function_key: "1" =====\nFunction name: Acme\\Demo.run\nFile path: src/Demo.php\n```\nfunction run(\\PDO $db) { return $db->query("SELECT * FROM app_account"); }\n```';
const res = await agent.generate(prompt, {
    structuredOutput: { schema: BatchedFastAnalysisSchema },
    modelSettings: { maxRetries: 0, temperature: 0 },
    abortSignal: AbortSignal.timeout(90_000),
});
console.log('text:', (res.text ?? '').slice(0, 300));
console.log('object infra:', JSON.stringify((res.object as any)?.analyses?.[0]?.infrastructure));
