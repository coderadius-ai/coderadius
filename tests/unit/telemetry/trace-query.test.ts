/**
 * Unit Tests — trace-query.ts
 *
 * Tests the streaming JSONL query API:
 *   - findByFunction() — matches by target or data.functionName
 *   - findByFile() — matches by target or data.filePath
 *   - findDroppedFunctions() — only DROP, REJECT, FAIL actions
 *   - findSurprises() — only sanitizer/llm/persist DROP|FAIL
 *   - extractPrompt() — returns only the SEND event for a function
 *   - All functions stream-safe: empty/missing/malformed JSONL
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    findByFunction,
    findByFile,
    findDroppedFunctions,
    findSurprises,
    extractPrompt,
    findByStage,
} from '../../../src/telemetry/trace-query.js';
import type { TraceEvent } from '../../../src/telemetry/trace-collector.js';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function writeJsonl(name: string, events: TraceEvent[]): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    return p;
}

function evt(overrides: Partial<TraceEvent> & Pick<TraceEvent, 'stage' | 'action' | 'target' | 'reason'>): TraceEvent {
    return { ts: new Date().toISOString(), ...overrides };
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const EVENTS: TraceEvent[] = [
    // File A, function processPayment
    evt({ stage: 'filter', action: 'PASS', target: 'urn:fn:processPayment', reason: 'gate 1', data: { filePath: 'src/payment.ts', functionName: 'processPayment', gate: 1 } }),
    evt({ stage: 'llm', action: 'SEND', target: 'urn:fn:processPayment', reason: 'sent', data: { filePath: 'src/payment.ts', functionName: 'processPayment', codeChunk: 'function processPayment() { return db.save(); }' } }),
    evt({ stage: 'llm', action: 'RECEIVE', target: 'urn:fn:processPayment', reason: 'has_io=true', data: { filePath: 'src/payment.ts', functionName: 'processPayment', tokens: { in: 200, out: 30 } } }),
    evt({ stage: 'sanitizer', action: 'DROP', target: 'infra:Database:postgres', reason: 'generic name', data: { filePath: 'src/payment.ts', functionName: 'processPayment' } }),
    evt({ stage: 'persist', action: 'WRITE', target: 'urn:fn:processPayment', reason: 'written to graph', data: { filePath: 'src/payment.ts', functionName: 'processPayment' } }),

    // File B, function fetchUser
    evt({ stage: 'filter', action: 'DROP', target: 'urn:fn:fetchUser', reason: 'all gates failed', data: { filePath: 'src/user.ts', functionName: 'fetchUser' } }),

    // File A, function validateInput — no IO
    evt({ stage: 'filter', action: 'PASS', target: 'urn:fn:validateInput', reason: 'gate 1', data: { filePath: 'src/payment.ts', functionName: 'validateInput', gate: 1 } }),
    evt({ stage: 'llm', action: 'REJECT', target: 'urn:fn:validateInput', reason: 'has_io=false', data: { filePath: 'src/payment.ts', functionName: 'validateInput' } }),

    // File C, function crashingFn — LLM FAIL
    evt({ stage: 'llm', action: 'FAIL', target: 'urn:fn:crashingFn', reason: 'empty response after retry', data: { filePath: 'src/service.ts', functionName: 'crashingFn' } }),

    // Discovery-level events (should not match function queries)
    evt({ stage: 'discovery', action: 'INCLUDE', target: 'src/payment.ts', reason: 'included' }),
    evt({ stage: 'discovery', action: 'EXCLUDE', target: 'src/payment.test.ts', reason: 'test file' }),
];

// ═════════════════════════════════════════════════════════════════════════════

describe('trace-query', () => {

    // ─────────────────────────────────────────────────────────────────────────
    // 1. findByFunction()
    // ─────────────────────────────────────────────────────────────────────────

    describe('findByFunction()', () => {
        it('returns all events matching the function name in target', async () => {
            const jsonl = writeJsonl('fn-target.jsonl', EVENTS);
            const results = await findByFunction(jsonl, 'processPayment');

            expect(results.length).toBeGreaterThanOrEqual(3);
            expect(results.every(e =>
                e.target.toLowerCase().includes('processpayment') ||
                (e.data?.functionName as string)?.toLowerCase().includes('processpayment')
            )).toBe(true);
        });

        it('matches via data.functionName (not just target)', async () => {
            const events = [
                evt({ stage: 'sanitizer', action: 'DROP', target: 'infra:Database:some-table', reason: 'hallucinated', data: { filePath: 'src/a.ts', functionName: 'mySpecialFn' } }),
            ];
            const jsonl = writeJsonl('fn-datamatch.jsonl', events);
            const results = await findByFunction(jsonl, 'mySpecialFn');

            expect(results).toHaveLength(1);
            expect(results[0].data?.functionName).toBe('mySpecialFn');
        });

        it('is case-insensitive', async () => {
            const jsonl = writeJsonl('fn-case.jsonl', EVENTS);
            const upper = await findByFunction(jsonl, 'PROCESSPAYMENT');
            const lower = await findByFunction(jsonl, 'processpayment');
            expect(upper.length).toBe(lower.length);
            expect(upper.length).toBeGreaterThan(0);
        });

        it('returns empty array when function not found', async () => {
            const jsonl = writeJsonl('fn-notfound.jsonl', EVENTS);
            const results = await findByFunction(jsonl, 'nonExistentFunction');
            expect(results).toHaveLength(0);
        });

        it('returns empty array for a missing file', async () => {
            const results = await findByFunction('/tmp/nonexistent.trace.jsonl', 'anything');
            expect(results).toHaveLength(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. findByFile()
    // ─────────────────────────────────────────────────────────────────────────

    describe('findByFile()', () => {
        it('returns all events for a specific file path', async () => {
            const jsonl = writeJsonl('by-file.jsonl', EVENTS);
            const results = await findByFile(jsonl, 'src/payment.ts');

            expect(results.length).toBeGreaterThan(0);
            expect(results.every(e =>
                e.target.toLowerCase().includes('payment') ||
                (e.data?.filePath as string)?.toLowerCase().includes('payment')
            )).toBe(true);
        });

        it('does not return events for other files', async () => {
            const jsonl = writeJsonl('by-file-filter.jsonl', EVENTS);
            const results = await findByFile(jsonl, 'src/user.ts');

            // Should only get events with filePath matching user.ts
            expect(results.every(e =>
                e.target.toLowerCase().includes('user') ||
                (e.data?.filePath as string)?.includes('user.ts')
            )).toBe(true);
        });

        it('is case-insensitive', async () => {
            const jsonl = writeJsonl('by-file-case.jsonl', EVENTS);
            const lower = await findByFile(jsonl, 'src/payment.ts');
            const upper = await findByFile(jsonl, 'SRC/PAYMENT.TS');
            expect(lower.length).toBe(upper.length);
        });

        it('returns empty array for a missing file', async () => {
            const results = await findByFile('/tmp/nonexistent.jsonl', 'src/any.ts');
            expect(results).toHaveLength(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. findDroppedFunctions()
    // ─────────────────────────────────────────────────────────────────────────

    describe('findDroppedFunctions()', () => {
        it('returns DROP, REJECT, and FAIL events', async () => {
            const jsonl = writeJsonl('dropped.jsonl', EVENTS);
            const results = await findDroppedFunctions(jsonl);

            const actions = results.map(e => e.action);
            expect(actions).toContain('DROP');
            expect(actions).toContain('REJECT');
            expect(actions).toContain('FAIL');
        });

        it('does NOT return INCLUDE, PASS, WRITE, RECEIVE events', async () => {
            const jsonl = writeJsonl('dropped-exclusive.jsonl', EVENTS);
            const results = await findDroppedFunctions(jsonl);

            const allowedActions = new Set(['DROP', 'REJECT', 'FAIL']);
            expect(results.every(e => allowedActions.has(e.action))).toBe(true);
        });

        it('returns empty array when no drops exist', async () => {
            const events = [
                evt({ stage: 'filter', action: 'PASS', target: 'fn:x', reason: 'gate 1' }),
                evt({ stage: 'persist', action: 'WRITE', target: 'fn:x', reason: 'ok' }),
            ];
            const jsonl = writeJsonl('no-drops.jsonl', events);
            const results = await findDroppedFunctions(jsonl);
            expect(results).toHaveLength(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. findSurprises()
    // ─────────────────────────────────────────────────────────────────────────

    describe('findSurprises()', () => {
        it('returns sanitizer DROPs (non-obvious)', async () => {
            const jsonl = writeJsonl('surprises.jsonl', EVENTS);
            const results = await findSurprises(jsonl);

            expect(results.some(e => e.stage === 'sanitizer' && e.action === 'DROP')).toBe(true);
        });

        it('returns LLM FAILs (non-obvious)', async () => {
            const jsonl = writeJsonl('surprises-llm.jsonl', EVENTS);
            const results = await findSurprises(jsonl);

            expect(results.some(e => e.stage === 'llm' && e.action === 'FAIL')).toBe(true);
        });

        it('does NOT return filter DROPs (obvious / expected)', async () => {
            const jsonl = writeJsonl('surprises-nofilter.jsonl', EVENTS);
            const results = await findSurprises(jsonl);

            expect(results.every(e => e.stage !== 'filter')).toBe(true);
        });

        it('does NOT return LLM REJECTs (has_io=false is expected)', async () => {
            const jsonl = writeJsonl('surprises-noreject.jsonl', EVENTS);
            const results = await findSurprises(jsonl);

            expect(results.every(e => e.action !== 'REJECT')).toBe(true);
        });

        it('returns empty array when no surprises exist', async () => {
            const events = [
                evt({ stage: 'filter', action: 'PASS', target: 'fn:x', reason: 'gate 1' }),
                evt({ stage: 'llm', action: 'RECEIVE', target: 'fn:x', reason: 'has_io=true' }),
            ];
            const jsonl = writeJsonl('no-surprises.jsonl', events);
            const results = await findSurprises(jsonl);
            expect(results).toHaveLength(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. extractPrompt()
    // ─────────────────────────────────────────────────────────────────────────

    describe('extractPrompt()', () => {
        it('returns the SEND event for the specified function', async () => {
            const jsonl = writeJsonl('prompt.jsonl', EVENTS);
            const result = await extractPrompt(jsonl, 'processPayment');

            expect(result).not.toBeNull();
            expect(result!.stage).toBe('llm');
            expect(result!.action).toBe('SEND');
        });

        it('includes the codeChunk in the returned event data', async () => {
            const jsonl = writeJsonl('prompt-code.jsonl', EVENTS);
            const result = await extractPrompt(jsonl, 'processPayment');

            expect(result!.data?.codeChunk).toContain('processPayment');
        });

        it('returns null when the function has no SEND event', async () => {
            const jsonl = writeJsonl('prompt-nosend.jsonl', EVENTS);
            const result = await extractPrompt(jsonl, 'fetchUser'); // was DROPped at filter

            expect(result).toBeNull();
        });

        it('returns null for a non-existent function', async () => {
            const jsonl = writeJsonl('prompt-notfound.jsonl', EVENTS);
            const result = await extractPrompt(jsonl, 'doesNotExist');
            expect(result).toBeNull();
        });

        it('returns null for a missing JSONL file', async () => {
            const result = await extractPrompt('/tmp/ghost.jsonl', 'anyFn');
            expect(result).toBeNull();
        });

        it('returns only the FIRST SEND event (not RECEIVE or REJECT)', async () => {
            const jsonl = writeJsonl('prompt-firstonly.jsonl', EVENTS);
            const result = await extractPrompt(jsonl, 'processPayment');

            expect(result!.action).toBe('SEND');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. findByStage()
    // ─────────────────────────────────────────────────────────────────────────

    describe('findByStage()', () => {
        it('returns only events for the requested stage', async () => {
            const jsonl = writeJsonl('by-stage.jsonl', EVENTS);
            const results = await findByStage(jsonl, 'llm');

            expect(results.length).toBeGreaterThan(0);
            expect(results.every(e => e.stage === 'llm')).toBe(true);
        });

        it('returns all sanitizer events', async () => {
            const jsonl = writeJsonl('by-stage-sanitizer.jsonl', EVENTS);
            const results = await findByStage(jsonl, 'sanitizer');

            expect(results.every(e => e.stage === 'sanitizer')).toBe(true);
        });

        it('returns empty array for a stage with no events', async () => {
            const events = [evt({ stage: 'discovery', action: 'INCLUDE', target: 'x', reason: 'ok' })];
            const jsonl = writeJsonl('by-stage-empty.jsonl', events);
            const results = await findByStage(jsonl, 'persist');
            expect(results).toHaveLength(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Robustness — malformed JSONL
    // ─────────────────────────────────────────────────────────────────────────

    describe('Robustness', () => {
        it('skips malformed lines and returns only valid events', async () => {
            const p = path.join(tmpDir, 'malformed.jsonl');
            const goodEvent: TraceEvent = evt({ stage: 'filter', action: 'PASS', target: 'urn:fn:foo', reason: 'gate 1', data: { functionName: 'foo' } });
            fs.writeFileSync(p, [
                'not json at all',
                JSON.stringify(goodEvent),
                '{broken',
                '',
            ].join('\n'));

            const results = await findByFunction(p, 'foo');
            expect(results).toHaveLength(1);
            expect(results[0].action).toBe('PASS');
        });

        it('returns empty array for a completely malformed JSONL file', async () => {
            const p = path.join(tmpDir, 'all-bad.jsonl');
            fs.writeFileSync(p, 'line1\nline2\n\n');
            const results = await findDroppedFunctions(p);
            expect(results).toHaveLength(0);
        });

        it('handles an empty file without crashing', async () => {
            const p = path.join(tmpDir, 'empty.jsonl');
            fs.writeFileSync(p, '');
            const results = await findByStage(p, 'llm');
            expect(results).toHaveLength(0);
        });
    });
});
