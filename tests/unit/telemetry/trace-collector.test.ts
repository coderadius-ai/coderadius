/**
 * Unit Tests — TraceCollector
 *
 * Tests the streaming JSONL trace collector:
 *   - No-op behavior when disabled
 *   - enable() creates JSONL file via WriteStream
 *   - trace() appends one JSON line per call
 *   - Convenience stage methods set the correct stage field
 *   - Session-based rotation: deletes .jsonl + .md pairs, keeps ≤ 20 sessions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TraceCollector } from '../../../src/telemetry/trace-collector.js';

// Each test gets its own isolated temp directory to avoid cross-test pollution
let tmpDir: string;
let collector: TraceCollector;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
    collector = new TraceCollector(tmpDir);
});

afterEach(async () => {
    // End any open stream to prevent handle leaks
    const c = collector as any;
    if (c.stream) {
        await new Promise<void>(res => c.stream.end(res));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function flush(c: TraceCollector): Promise<void> {
    const s = (c as any).stream as fs.WriteStream | null;
    if (s) await new Promise<void>(res => s.end(res));
}

function readLines(c: TraceCollector): string[] {
    const p = c.getJsonlPath();
    if (!p || !fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
}

// ═════════════════════════════════════════════════════════════════════════════

describe('TraceCollector', () => {

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Disabled state (before enable())
    // ─────────────────────────────────────────────────────────────────────────

    describe('Disabled state', () => {
        it('isEnabled() returns false before enable()', () => {
            expect(collector.isEnabled()).toBe(false);
        });

        it('trace() is a no-op when disabled — does not throw and writes nothing', () => {
            expect(() =>
                collector.trace({ ts: new Date().toISOString(), stage: 'filter', action: 'DROP', target: 'test', reason: 'no stream' })
            ).not.toThrow();
            expect(collector.getJsonlPath()).toBeNull();
        });

        it('getJsonlPath() returns null when disabled', () => {
            expect(collector.getJsonlPath()).toBeNull();
        });

        it('finalize() returns null when disabled', async () => {
            const result = await collector.finalize();
            expect(result).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. enable()
    // ─────────────────────────────────────────────────────────────────────────

    describe('enable()', () => {
        it('creates the JSONL file on disk', async () => {
            collector.enable('test-session-001');

            // Wait for the WriteStream to open (file creation is async)
            await new Promise<void>(res => (collector as any).stream.once('open', res));

            expect(collector.isEnabled()).toBe(true);
            const jsonlPath = collector.getJsonlPath();
            expect(jsonlPath).not.toBeNull();
            expect(jsonlPath).toMatch(/\.trace\.jsonl$/);
            expect(fs.existsSync(jsonlPath!)).toBe(true);
        });

        it('creates the traces directory if it does not exist', async () => {
            const deepDir = path.join(tmpDir, 'a', 'b', 'c');
            const c = new TraceCollector(deepDir);
            c.enable('nested-session');

            // Wait for the WriteStream to open so it doesn't race with rmSync in afterEach
            await new Promise<void>(res => (c as any).stream.once('open', res));

            expect(fs.existsSync(deepDir)).toBe(true);
            await new Promise<void>(res => (c as any).stream.end(res));
        });

        it('embeds the first 8 chars of sessionId in the filename', () => {
            collector.enable('abcdefgh-1234-5678-abcd');

            const filename = path.basename(collector.getJsonlPath()!);
            expect(filename).toContain('abcdefgh');
        });

        it('writes to a custom directory when overrideDir is passed to enable()', async () => {
            const customDir = path.join(tmpDir, 'custom-output');
            // collector was created with tmpDir but we override at enable() time
            collector.enable('override-test', customDir);

            await new Promise<void>(res => (collector as any).stream.once('open', res));

            const jsonlPath = collector.getJsonlPath()!;
            expect(jsonlPath).toContain('custom-output');
            expect(fs.existsSync(jsonlPath)).toBe(true);
            // Must NOT be in the original tmpDir root
            expect(path.dirname(jsonlPath)).toBe(customDir);
        });

        it('filename contains an ISO-like timestamp', () => {
            collector.enable('timestamp-test');

            const filename = path.basename(collector.getJsonlPath()!);
            // e.g. "2026-04-09T19-00-00_timestam.trace.jsonl"
            expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_/);
        });

        it('isEnabled() returns true after enable()', () => {
            collector.enable('enabled-check');
            expect(collector.isEnabled()).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. trace() — line format
    // ─────────────────────────────────────────────────────────────────────────

    describe('trace()', () => {
        it('writes one JSON line per trace() call', async () => {
            collector.enable('write-test');

            collector.trace({ ts: '2026-01-01T00:00:00.000Z', stage: 'discovery', action: 'INCLUDE', target: 'src/a.ts', reason: 'included' });
            collector.trace({ ts: '2026-01-01T00:00:01.000Z', stage: 'filter', action: 'DROP', target: 'urn:fn:1', reason: 'all gates failed', data: { gate: null } });
            collector.trace({ ts: '2026-01-01T00:00:02.000Z', stage: 'llm', action: 'SEND', target: 'urn:fn:1', reason: 'sent' });

            await flush(collector);
            const lines = readLines(collector);

            expect(lines).toHaveLength(3);
        });

        it('each line is parseable as JSON with required fields', async () => {
            collector.enable('json-valid-test');

            for (let i = 0; i < 5; i++) {
                collector.trace({ ts: new Date().toISOString(), stage: 'persist', action: 'WRITE', target: `fn:${i}`, reason: 'ok' });
            }

            await flush(collector);
            const lines = readLines(collector);

            expect(lines).toHaveLength(5);
            for (const line of lines) {
                expect(() => JSON.parse(line)).not.toThrow();
                const evt = JSON.parse(line);
                expect(evt).toHaveProperty('ts');
                expect(evt).toHaveProperty('stage', 'persist');
                expect(evt).toHaveProperty('action', 'WRITE');
                expect(evt).toHaveProperty('target');
                expect(evt).toHaveProperty('reason');
            }
        });

        it('preserves the data payload in the JSON line', async () => {
            collector.enable('data-payload-test');

            collector.trace({
                ts: new Date().toISOString(),
                stage: 'filter',
                action: 'DROP',
                target: 'fn:x',
                reason: 'all gates failed',
                data: { gate: 5, gateName: 'DI Alias', taintStatus: 'tainted', functionName: 'processPayment' }
            });

            await flush(collector);
            const lines = readLines(collector);
            const evt = JSON.parse(lines[0]);

            expect(evt.data.gate).toBe(5);
            expect(evt.data.gateName).toBe('DI Alias');
            expect(evt.data.taintStatus).toBe('tainted');
            expect(evt.data.functionName).toBe('processPayment');
        });

        it('records are separated by newlines (JSONL format)', async () => {
            collector.enable('newline-test');
            collector.trace({ ts: '2026-01-01T00:00:00Z', stage: 'analysis', action: 'INFO', target: 'file.ts', reason: 'parsed' });
            collector.trace({ ts: '2026-01-01T00:00:01Z', stage: 'analysis', action: 'INFO', target: 'file.ts', reason: 'parsed2' });

            await flush(collector);
            const raw = fs.readFileSync(collector.getJsonlPath()!, 'utf-8');
            expect(raw.endsWith('\n')).toBe(true);
            expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Convenience stage methods
    // ─────────────────────────────────────────────────────────────────────────

    describe('Convenience stage methods', () => {
        it.each([
            ['traceDiscovery', 'discovery'],
            ['traceFilter', 'filter'],
            ['traceAnalysis', 'analysis'],
            ['traceLLM', 'llm'],
            ['traceSanitizer', 'sanitizer'],
            ['tracePersist', 'persist'],
            ['traceContract', 'contract'],
            ['traceResolution', 'resolution'],
        ] as const)('%s() writes an event with stage="%s"', async (method, expectedStage) => {
            collector.enable('stage-method-test');
            (collector as any)[method]('INFO', 'target:x', 'reason');

            await flush(collector);
            const lines = readLines(collector);

            expect(lines).toHaveLength(1);
            const evt = JSON.parse(lines[0]);
            expect(evt.stage).toBe(expectedStage);
            expect(evt.target).toBe('target:x');
        });

        it('convenience methods also write data payload when provided', async () => {
            collector.enable('convenience-data-test');
            collector.traceFilter('PASS', 'fn:y', 'gate 1 passed', { gate: 1, gateName: 'UseCase Entrypoint', functionName: 'myFn' });

            await flush(collector);
            const evt = JSON.parse(readLines(collector)[0]);

            expect(evt.stage).toBe('filter');
            expect(evt.action).toBe('PASS');
            expect(evt.data.gate).toBe(1);
            expect(evt.data.functionName).toBe('myFn');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Session-based rotation
    // ─────────────────────────────────────────────────────────────────────────

    describe('Session rotation', () => {
        function makeSessionPair(dir: string, prefix: string): void {
            fs.writeFileSync(path.join(dir, `${prefix}.trace.jsonl`), '');
            fs.writeFileSync(path.join(dir, `${prefix}.trace.md`), '');
        }

        it('evicts the oldest session pair when existing sessions exceed 20', () => {
            // Create 21 sessions with sortable timestamp prefixes
            for (let i = 1; i <= 21; i++) {
                const ts = `2026-01-${String(i).padStart(2, '0')}T00-00-00`;
                makeSessionPair(tmpDir, `${ts}_sess${String(i).padStart(2, '0')}`);
            }

            // enable() triggers rotateOldSessions() — oldest (day 01) should be evicted
            collector.enable('trigger-rotation');

            const oldest_jsonl = path.join(tmpDir, '2026-01-01T00-00-00_sess01.trace.jsonl');
            const oldest_md = path.join(tmpDir, '2026-01-01T00-00-00_sess01.trace.md');
            expect(fs.existsSync(oldest_jsonl)).toBe(false);
            expect(fs.existsSync(oldest_md)).toBe(false);
        });

        it('evicts BOTH .jsonl and .md for the same session', () => {
            for (let i = 1; i <= 21; i++) {
                const ts = `2026-02-${String(i).padStart(2, '0')}T00-00-00`;
                makeSessionPair(tmpDir, `${ts}_pair${String(i).padStart(2, '0')}`);
            }

            collector.enable('pair-eviction-check');

            const jsonl = path.join(tmpDir, '2026-02-01T00-00-00_pair01.trace.jsonl');
            const md = path.join(tmpDir, '2026-02-01T00-00-00_pair01.trace.md');
            expect(fs.existsSync(jsonl)).toBe(false);
            expect(fs.existsSync(md)).toBe(false);
        });

        it('does NOT evict sessions when total is exactly 20', () => {
            for (let i = 1; i <= 20; i++) {
                const ts = `2026-03-${String(i).padStart(2, '0')}T00-00-00`;
                makeSessionPair(tmpDir, `${ts}_keep${String(i).padStart(2, '0')}`);
            }

            collector.enable('no-eviction-at-20');

            // All 20 original sessions must survive
            for (let i = 1; i <= 20; i++) {
                const ts = `2026-03-${String(i).padStart(2, '0')}T00-00-00`;
                const jsonl = path.join(tmpDir, `${ts}_keep${String(i).padStart(2, '0')}.trace.jsonl`);
                expect(fs.existsSync(jsonl)).toBe(true);
            }
        });

        it('only evicts the single oldest session when 21 exist (not more)', () => {
            for (let i = 1; i <= 21; i++) {
                const ts = `2026-04-${String(i).padStart(2, '0')}T00-00-00`;
                makeSessionPair(tmpDir, `${ts}_s${String(i).padStart(2, '0')}`);
            }

            collector.enable('single-eviction-check');

            // The second-oldest (day 02) must NOT be evicted
            const second = path.join(tmpDir, '2026-04-02T00-00-00_s02.trace.jsonl');
            expect(fs.existsSync(second)).toBe(true);
        });

        it('does not crash when the traces directory is empty', () => {
            // tmpDir created fresh in beforeEach — no sessions present
            expect(() => collector.enable('empty-dir-test')).not.toThrow();
        });

        it('ignores non-trace files during rotation', () => {
            // Create stray files that don't match the *.trace.{jsonl,md} pattern
            fs.writeFileSync(path.join(tmpDir, 'README.md'), 'not a trace');
            fs.writeFileSync(path.join(tmpDir, 'some.json'), '{}');
            for (let i = 1; i <= 21; i++) {
                const ts = `2026-05-${String(i).padStart(2, '0')}T00-00-00`;
                makeSessionPair(tmpDir, `${ts}_x${String(i).padStart(2, '0')}`);
            }

            collector.enable('stray-files-test');

            // Stray files should be untouched
            expect(fs.existsSync(path.join(tmpDir, 'README.md'))).toBe(true);
            expect(fs.existsSync(path.join(tmpDir, 'some.json'))).toBe(true);
        });
    });
});
