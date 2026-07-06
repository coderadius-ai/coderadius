/**
 * Unit Tests — renderTraceSummary (trace-renderer.ts)
 *
 * Tests the streaming JSONL → Markdown renderer:
 *   - Correct stage counter aggregation from event stream
 *   - Markdown header and summary table content
 *   - 🔴 Attention Required section (sanitizer/llm/persist drops only)
 *   - Per-file <details> blocks
 *   - Empty/malformed JSONL handling (no crash)
 *   - Prompt/response is NOT included in the Markdown output
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderTraceSummary } from '../../../src/telemetry/trace-renderer.js';
import type { TraceEvent } from '../../../src/telemetry/trace-collector.js';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function writeJsonl(filename: string, events: TraceEvent[]): string {
    const p = path.join(tmpDir, filename);
    const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(p, content, 'utf-8');
    return p;
}

function mdPath(jsonlPath: string): string {
    return jsonlPath.replace('.trace.jsonl', '.trace.md');
}

function makeFunctionId(filePath: string, functionName: string, location = 'L1:C1-L5:C1'): string {
    const modulePath = filePath.replace(/\.[jt]sx?$/, '');
    return `cr:function:test-repo:typescript:${modulePath}::${functionName}@${location}`;
}

function evt(overrides: Partial<TraceEvent> & Pick<TraceEvent, 'stage' | 'action' | 'target' | 'reason'>): TraceEvent {
    const data = overrides.data ? { ...overrides.data } : undefined;
    if (
        data &&
        typeof data.filePath === 'string' &&
        typeof data.functionName === 'string' &&
        typeof data.functionId !== 'string'
    ) {
        data.functionId = makeFunctionId(data.filePath, data.functionName);
    }
    return { ts: new Date().toISOString(), ...overrides, ...(data ? { data } : {}) };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('renderTraceSummary', () => {

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Basic output
    // ─────────────────────────────────────────────────────────────────────────

    describe('Basic output', () => {
        it('creates the Markdown file on disk', async () => {
            const jsonl = writeJsonl('basic.trace.jsonl', [
                evt({ stage: 'discovery', action: 'INCLUDE', target: 'src/a.ts', reason: 'ok' }),
            ]);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            expect(fs.existsSync(mdPath(jsonl))).toBe(true);
        });

        it('does not throw on an empty JSONL file', async () => {
            const jsonl = writeJsonl('empty.trace.jsonl', []);
            await expect(renderTraceSummary(jsonl, mdPath(jsonl))).resolves.not.toThrow();
            expect(fs.existsSync(mdPath(jsonl))).toBe(true);
        });

        it('does not throw on a JSONL file with malformed lines', async () => {
            const p = path.join(tmpDir, 'malformed.trace.jsonl');
            fs.writeFileSync(p, 'not json\n{"valid":"line","ts":"x","stage":"discovery","action":"INCLUDE","target":"f","reason":"r"}\n{bad\n');
            await expect(renderTraceSummary(p, mdPath(p))).resolves.not.toThrow();
        });

        it('output contains # header with session name', async () => {
            const jsonl = writeJsonl('mysession.trace.jsonl', [
                evt({ stage: 'discovery', action: 'INCLUDE', target: 'src/x.ts', reason: 'ok' }),
            ]);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');
            expect(md).toContain('# Execution Trace');
            expect(md).toContain('mysession');
        });

        it('output contains Summary table with all 5 stage rows', async () => {
            const jsonl = writeJsonl('summary-table.trace.jsonl', []);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');
            expect(md).toContain('Discovery');
            expect(md).toContain('Heuristic Filter');
            expect(md).toContain('LLM Extraction');
            expect(md).toContain('Sanitizer');
            expect(md).toContain('Graph Persist');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Stage counter aggregation
    // ─────────────────────────────────────────────────────────────────────────

    describe('Stage counter aggregation', () => {
        it('counts discovery INCLUDE, EXCLUDE, CACHE_HIT correctly', async () => {
            const jsonl = writeJsonl('discovery-counts.trace.jsonl', [
                evt({ stage: 'discovery', action: 'INCLUDE', target: 'src/a.ts', reason: 'ok' }),
                evt({ stage: 'discovery', action: 'INCLUDE', target: 'src/b.ts', reason: 'ok' }),
                evt({ stage: 'discovery', action: 'EXCLUDE', target: 'src/a.test.ts', reason: 'test file' }),
                evt({ stage: 'discovery', action: 'CACHE_HIT', target: 'repo/my-service', reason: 'hash unchanged' }),
            ]);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            // Discovery row: 4 in, 2 included, 1 excluded, 1 cache hit
            expect(md).toContain('2 included');
            expect(md).toContain('1 excluded');
            expect(md).toContain('1 cache hit');
        });

        it('counts filter PASS, DROP, CACHE_HIT correctly', async () => {
            const events: TraceEvent[] = [
                evt({ stage: 'filter', action: 'PASS', target: 'fn:x', reason: 'gate 1', data: { filePath: 'src/a.ts', functionName: 'foo', gate: 1, gateName: 'UseCase Entrypoint' } }),
                evt({ stage: 'filter', action: 'PASS', target: 'fn:y', reason: 'gate 4', data: { filePath: 'src/a.ts', functionName: 'bar', gate: 4, gateName: 'Tainted Symbol' } }),
                evt({ stage: 'filter', action: 'DROP', target: 'fn:z', reason: 'all gates failed', data: { filePath: 'src/a.ts', functionName: 'baz' } }),
                evt({ stage: 'filter', action: 'CACHE_HIT', target: 'fn:w', reason: 'hash unchanged' }),
            ];
            const jsonl = writeJsonl('filter-counts.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            expect(md).toContain('2 passed');
            expect(md).toContain('1 dropped');
            expect(md).toContain('1 cache hit');
        });

        it('counts LLM sent/received/rejected/failed correctly', async () => {
            const events: TraceEvent[] = [
                evt({ stage: 'llm', action: 'SEND', target: 'fn:a', reason: 'sent', data: { filePath: 'src/a.ts', functionName: 'a' } }),
                evt({ stage: 'llm', action: 'SEND', target: 'fn:b', reason: 'sent', data: { filePath: 'src/a.ts', functionName: 'b' } }),
                evt({ stage: 'llm', action: 'RECEIVE', target: 'fn:a', reason: 'has_io=true', data: { filePath: 'src/a.ts', functionName: 'a', tokens: { in: 100, out: 20 } } }),
                evt({ stage: 'llm', action: 'REJECT', target: 'fn:b', reason: 'has_io=false', data: { filePath: 'src/a.ts', functionName: 'b' } }),
                evt({ stage: 'llm', action: 'FAIL', target: 'fn:c', reason: 'empty response', data: { filePath: 'src/a.ts', functionName: 'c' } }),
                evt({ stage: 'llm', action: 'RETRY', target: 'fn:c', reason: 'retry 1' }),
            ];
            const jsonl = writeJsonl('llm-counts.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            expect(md).toContain('2 sent');
            expect(md).toContain('1 confirmed');
            expect(md).toContain('1 rejected');
            expect(md).toContain('1 failed');
            expect(md).toContain('1 retried');
        });

        it('counts sanitizer PASS, DROP, TRANSFORM correctly', async () => {
            const events: TraceEvent[] = [
                evt({ stage: 'sanitizer', action: 'PASS', target: 'infra:Database:orders', reason: 'ok', data: { filePath: 'src/a.ts', functionName: 'fn' } }),
                evt({ stage: 'sanitizer', action: 'DROP', target: 'infra:Database:postgres', reason: 'generic name', data: { filePath: 'src/a.ts', functionName: 'fn' } }),
                evt({ stage: 'sanitizer', action: 'TRANSFORM', target: 'infra:MessageChannel:payments-svc', reason: 'DI resolved', data: { filePath: 'src/a.ts', functionName: 'fn' } }),
            ];
            const jsonl = writeJsonl('sanitizer-counts.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            expect(md).toContain('1 passed');
            expect(md).toContain('1 dropped');
            expect(md).toContain('1 transformed');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Attention Required section
    // ─────────────────────────────────────────────────────────────────────────

    describe('Attention Required section', () => {
        it('includes "Attention Required" when sanitizer DROPs occur', async () => {
            const events: TraceEvent[] = [
                evt({ stage: 'sanitizer', action: 'DROP', target: 'infra:Database:unknown', reason: 'hallucinated table', data: { filePath: 'src/service.ts', functionName: 'getUser' } }),
            ];
            const jsonl = writeJsonl('attention-sanitizer.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');
            expect(md).toContain('Attention Required');
            expect(md).toContain('Sanitizer');
            expect(md).toContain('hallucinated table');
        });

        it('includes "Attention Required" when LLM FAILs occur', async () => {
            const events: TraceEvent[] = [
                evt({ stage: 'llm', action: 'FAIL', target: 'fn:processPayment', reason: 'empty response after retry', data: { filePath: 'src/payment.ts', functionName: 'processPayment' } }),
            ];
            const jsonl = writeJsonl('attention-llm.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');
            expect(md).toContain('Attention Required');
            expect(md).toContain('LLM');
        });

        it('does NOT include "Attention Required" when only filter DROPs occur', async () => {
            // Filter drops are expected/normal — not attention-worthy
            const events: TraceEvent[] = [
                evt({ stage: 'filter', action: 'DROP', target: 'fn:x', reason: 'no IO', data: { filePath: 'src/util.ts', functionName: 'helper' } }),
            ];
            const jsonl = writeJsonl('no-attention.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');
            expect(md).not.toContain('Attention Required');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Per-file details
    // ─────────────────────────────────────────────────────────────────────────

    describe('Per-file details', () => {
        it('creates a <details> block for each file that has events', async () => {
            const events: TraceEvent[] = [
                evt({ stage: 'filter', action: 'PASS', target: 'fn:x', reason: 'gate 1', data: { filePath: 'src/serviceA.ts', functionName: 'handlerA', gate: 1, gateName: 'UseCase Entrypoint' } }),
                evt({ stage: 'filter', action: 'PASS', target: 'fn:y', reason: 'gate 1', data: { filePath: 'src/serviceB.ts', functionName: 'handlerB', gate: 1, gateName: 'UseCase Entrypoint' } }),
            ];
            const jsonl = writeJsonl('per-file.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            expect(md).toContain('src/serviceA.ts');
            expect(md).toContain('src/serviceB.ts');
            expect(md).toContain('<details>');
        });

        it('includes function names in the function timeline table', async () => {
            const events: TraceEvent[] = [
                evt({ stage: 'filter', action: 'PASS', target: 'fn:x', reason: 'gate 1', data: { filePath: 'src/svc.ts', functionName: 'processOrder', gate: 1, gateName: 'UseCase Entrypoint' } }),
                evt({ stage: 'llm', action: 'RECEIVE', target: 'fn:x', reason: 'has_io=true', data: { filePath: 'src/svc.ts', functionName: 'processOrder', tokens: { in: 500, out: 40 } } }),
            ];
            const jsonl = writeJsonl('fn-timeline.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            expect(md).toContain('processOrder');
            expect(md).toContain('✅');
        });

        it('disambiguates duplicate function names in the same file using location suffixes', async () => {
            const events: TraceEvent[] = [
                evt({
                    stage: 'filter',
                    action: 'PASS',
                    target: makeFunctionId('src/svc.ts', 'anonymous', 'L10:C5-L12:C2'),
                    reason: 'gate 1',
                    data: {
                        filePath: 'src/svc.ts',
                        functionName: 'anonymous',
                        functionId: makeFunctionId('src/svc.ts', 'anonymous', 'L10:C5-L12:C2'),
                        gate: 1,
                        gateName: 'UseCase Entrypoint',
                    },
                }),
                evt({
                    stage: 'filter',
                    action: 'PASS',
                    target: makeFunctionId('src/svc.ts', 'anonymous', 'L20:C5-L22:C2'),
                    reason: 'gate 1',
                    data: {
                        filePath: 'src/svc.ts',
                        functionName: 'anonymous',
                        functionId: makeFunctionId('src/svc.ts', 'anonymous', 'L20:C5-L22:C2'),
                        gate: 1,
                        gateName: 'UseCase Entrypoint',
                    },
                }),
            ];
            const jsonl = writeJsonl('duplicate-names.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            expect(md).toContain('anonymous @L10:C5-L12:C2');
            expect(md).toContain('anonymous @L20:C5-L22:C2');
        });

        it('reads file path for analysis INFO events from target when data.filePath is missing', async () => {
            const events: TraceEvent[] = [
                evt({
                    stage: 'analysis',
                    action: 'INFO',
                    target: 'src/svc.ts',
                    reason: 'file parsed',
                    data: { functionsFound: 2, language: 'typescript' },
                }),
                evt({
                    stage: 'filter',
                    action: 'PASS',
                    target: 'fn:x',
                    reason: 'gate 1',
                    data: { filePath: 'src/svc.ts', functionName: 'processOrder', gate: 1, gateName: 'UseCase Entrypoint' },
                }),
            ];
            const jsonl = writeJsonl('analysis-target-path.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            expect(md).toContain('src/svc.ts — 2 found');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Raw prompt is NOT embedded in the Markdown
    // ─────────────────────────────────────────────────────────────────────────

    describe('Privacy / size constraints', () => {
        it('does NOT embed raw LLM prompts in the Markdown output', async () => {
            const largePrompt = 'x'.repeat(5000);
            const events: TraceEvent[] = [
                evt({ stage: 'llm', action: 'SEND', target: 'fn:secret', reason: 'sent', data: { filePath: 'src/a.ts', functionName: 'secret', codeChunk: largePrompt } }),
            ];
            const jsonl = writeJsonl('no-prompt.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            // The 5000-char code chunk must NOT appear in the Markdown
            expect(md).not.toContain('x'.repeat(100));
        });

        it('Markdown file is significantly smaller than the JSONL with large payloads', async () => {
            const events: TraceEvent[] = [];
            for (let i = 0; i < 50; i++) {
                events.push(evt({
                    stage: 'llm', action: 'SEND', target: `fn:${i}`, reason: 'sent',
                    data: { filePath: 'src/big.ts', functionName: `fn${i}`, codeChunk: 'a'.repeat(3000) }
                }));
                events.push(evt({
                    stage: 'llm', action: 'RECEIVE', target: `fn:${i}`, reason: 'has_io=true',
                    data: { filePath: 'src/big.ts', functionName: `fn${i}`, tokens: { in: 500, out: 40 } }
                }));
            }
            const jsonl = writeJsonl('size-check.trace.jsonl', events);
            await renderTraceSummary(jsonl, mdPath(jsonl));

            const jsonlSize = fs.statSync(jsonl).size;
            const mdSize = fs.statSync(mdPath(jsonl)).size;

            // Markdown should be dramatically smaller (not contain the 3000-byte code chunks)
            expect(mdSize).toBeLessThan(jsonlSize * 0.1);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Forensic JSONL tip
    // ─────────────────────────────────────────────────────────────────────────

    describe('Forensic query tip', () => {
        it('Markdown contains a jq debugging tip pointing to the JSONL file', async () => {
            const jsonl = writeJsonl('jq-tip.trace.jsonl', []);
            await renderTraceSummary(jsonl, mdPath(jsonl));
            const md = fs.readFileSync(mdPath(jsonl), 'utf-8');

            // Should contain a reference to querying the JSONL file directly
            expect(md).toContain('jq');
            expect(md).toContain(jsonl); // path to the raw JSONL
        });
    });
});
