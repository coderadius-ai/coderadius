// ═══════════════════════════════════════════════════════════════════════════════
// Execution Trace Collector — Streaming JSONL Singleton
//
// Non-blocking, zero-accumulation tracing for the ingestion pipeline.
// Each trace() call does a stream.write() of a single JSON line to disk.
// Memory usage: near zero. Event loop: unblocked.
//
// Usage:
//   traceCollector.enable(sessionId);       // opens WriteStream
//   traceCollector.trace({ ... });          // non-blocking append
//   await traceCollector.finalize();        // flush + generate Markdown
//
// When disabled (default): every method is a no-op on line 1.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TraceStage =
    | 'source'
    | 'discovery'
    | 'analysis'
    | 'filter'
    | 'llm'
    | 'sanitizer'
    | 'persist'
    | 'contract'
    | 'resolution';

export type TraceAction =
    | 'INCLUDE'
    | 'EXCLUDE'
    | 'PASS'
    | 'DROP'
    | 'CACHE_HIT'
    | 'STATIC'
    | 'SEND'
    | 'RECEIVE'
    | 'REJECT'
    | 'BATCH_SEND'
    | 'BATCH_RECEIVE'
    | 'FAIL'
    | 'TRANSFORM'
    | 'WRITE'
    | 'DELETE'
    | 'RETRY'
    | 'FALLBACK'
    | 'CONCURRENCY'
    | 'INFO';

export interface TraceEvent {
    /** ISO timestamp */
    ts: string;
    /** Pipeline stage */
    stage: TraceStage;
    /** What happened */
    action: TraceAction;
    /** Full path or URN of the target (file, function, resource) */
    target: string;
    /** Human-readable reason */
    reason: string;
    /** Structured payload — varies by stage */
    data?: Record<string, any>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TRACES_DIR = paths.traces;
const MAX_SESSIONS = 20;

// ─── Trace Value Redaction ───────────────────────────────────────────────────
// Dual-layer: key-based (catches named secrets) + value-based (catches DSNs).
// Prevents leakage of passwords, tokens, connection strings in trace files.

/** Key names that indicate a secret value. */
const SECRET_KEY_PATTERN = /password|secret|token|key|pass|credential|auth|cert/i;

/**
 * Value-level DSN pattern — no ^ anchor.
 * Matches DSNs embedded anywhere in the value: leading whitespace, quotes,
 * JSON array context ('["postgres://..."]'), HTTP Authorization headers.
 *
 * Length-bounded ({1,256}) on user/password segments for defensive hardening.
 * Note: this regex is NOT vulnerable to catastrophic backtracking (ReDoS)
 * because [^:] and [^@] create unambiguous partition points separated by
 * the `:` literal. Backtracking is O(n) linear. The bounds are a fail-faster
 * optimization, not a security fix.
 */
const SECRET_VALUE_PATTERN = /(?:postgres|mysql|redis|mongodb|amqp|amqps):\/\/[^:]{1,256}:[^@]{1,256}@/i;

/** Max characters for non-redacted values in trace output. */
const MAX_VALUE_LENGTH = 4096;

/**
 * Redact a single key-value pair for trace output.
 * Exported for unit testing.
 */
export function redactValue(key: string, value: string): string {
    if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED:key]';
    if (SECRET_VALUE_PATTERN.test(value)) return '[REDACTED:dsn]';
    if (value.length > MAX_VALUE_LENGTH) return value.slice(0, MAX_VALUE_LENGTH) + '…';
    return value;
}

/**
 * Recursively walk a trace data object and redact sensitive values.
 */
function redactTraceData(data: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
            result[key] = redactValue(key, value);
        } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = redactTraceData(value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

// ─── Collector ───────────────────────────────────────────────────────────────

export class TraceCollector {
    private stream: fs.WriteStream | null = null;
    private jsonlPath: string | null = null;
    private sessionId: string | null = null;
    private readonly tracesDir: string;

    constructor(tracesDir: string = TRACES_DIR) {
        this.tracesDir = tracesDir;
    }

    /**
     * Enable tracing for this session. Opens a WriteStream to a new JSONL file.
     * Also runs session-based rotation (keeps last 20 sessions).
     *
     * @param sessionId  Unique identifier for this session (usually a UUID).
     * @param overrideDir  Optional path to use instead of the default ~/.coderadius/traces/.
     */
    enable(sessionId: string, overrideDir?: string): void {
        this.sessionId = sessionId;
        const dir = overrideDir ? path.resolve(overrideDir) : this.tracesDir;

        fs.mkdirSync(dir, { recursive: true });
        this.rotateOldSessions(dir);

        const timestamp = this.formatTimestamp();
        const shortId = sessionId.substring(0, 8);
        const filename = `${timestamp}_${shortId}.trace.jsonl`;
        this.jsonlPath = path.join(dir, filename);

        this.stream = fs.createWriteStream(this.jsonlPath, { flags: 'a' });

        // Handle stream errors gracefully — don't crash the pipeline
        this.stream.on('error', (err) => {
            console.error(`[TraceCollector] Stream write error: ${err.message}`);
            this.stream = null;
        });
    }

    /**
     * Returns true if tracing is currently enabled.
     */
    isEnabled(): boolean {
        // stream may be null after a write error, but tracing is still "active"
        // for the session — events up to the error were captured on disk.
        return this.jsonlPath !== null;
    }

    /**
     * Write a single trace event to the JSONL file.
     * Non-blocking: uses stream.write(), not appendFileSync.
     * No-op when tracing is disabled.
     *
     * All values in event.data are passed through dual-layer redaction
     * before serialization to prevent secret leakage (DSNs, passwords, tokens).
     */
    trace(event: TraceEvent): void {
        if (!this.stream) return;
        if (event.data) {
            event = { ...event, data: redactTraceData(event.data) };
        }
        this.stream.write(JSON.stringify(event) + '\n');
    }

    // ─── Convenience Methods ─────────────────────────────────────────────
    // These wrap trace() with pre-filled stage/action for cleaner call sites.

    traceDiscovery(action: TraceAction, target: string, reason: string, data?: Record<string, any>): void {
        this.trace({ ts: new Date().toISOString(), stage: 'discovery', action, target, reason, data });
    }

    traceFilter(action: TraceAction, target: string, reason: string, data?: Record<string, any>): void {
        this.trace({ ts: new Date().toISOString(), stage: 'filter', action, target, reason, data });
    }

    traceAnalysis(action: TraceAction, target: string, reason: string, data?: Record<string, any>): void {
        this.trace({ ts: new Date().toISOString(), stage: 'analysis', action, target, reason, data });
    }

    traceLLM(action: TraceAction, target: string, reason: string, data?: Record<string, any>): void {
        this.trace({ ts: new Date().toISOString(), stage: 'llm', action, target, reason, data });
    }

    traceSanitizer(action: TraceAction, target: string, reason: string, data?: Record<string, any>): void {
        this.trace({ ts: new Date().toISOString(), stage: 'sanitizer', action, target, reason, data });
    }

    tracePersist(action: TraceAction, target: string, reason: string, data?: Record<string, any>): void {
        this.trace({ ts: new Date().toISOString(), stage: 'persist', action, target, reason, data });
    }

    traceContract(action: TraceAction, target: string, reason: string, data?: Record<string, any>): void {
        this.trace({ ts: new Date().toISOString(), stage: 'contract', action, target, reason, data });
    }

    traceResolution(action: TraceAction, target: string, reason: string, data?: Record<string, any>): void {
        this.trace({ ts: new Date().toISOString(), stage: 'resolution', action, target, reason, data });
    }

    /**
     * Finalize tracing: flush the WriteStream, generate the Markdown summary.
     * Returns the path to the generated Markdown file, or null if tracing was disabled.
     */
    async finalize(): Promise<string | null> {
        // jsonlPath is the canonical source of truth.
        // this.stream may be null if a write error silently killed it mid-session
        // (the error handler sets stream=null). In that case the JSONL file still
        // exists on disk with whatever was written up to the error — we can still
        // generate a Markdown summary from it.
        if (!this.jsonlPath) return null;

        const jsonlPath = this.jsonlPath;

        // Flush the stream only if it's still alive
        if (this.stream) {
            this.stream.end();
            await new Promise<void>((resolve) => {
                this.stream!.on('finish', resolve);
                this.stream!.on('error', resolve); // resolve anyway — file already on disk
            });
            this.stream = null;
        }

        // Generate the lightweight Markdown summary from whatever data landed on disk
        if (!fs.existsSync(jsonlPath)) return null;

        const { renderTraceSummary } = await import('./trace-renderer.js');
        const mdPath = jsonlPath.replace('.trace.jsonl', '.trace.md');
        await renderTraceSummary(jsonlPath, mdPath);

        return mdPath;
    }

    /**
     * Get the path to the current JSONL trace file.
     */
    getJsonlPath(): string | null {
        return this.jsonlPath;
    }

    // ─── Private Helpers ─────────────────────────────────────────────────

    /**
     * Format current time as a filename-safe timestamp.
     * Example: "2026-04-09T14-30-00"
     */
    private formatTimestamp(): string {
        return new Date().toISOString()
            .replace(/:/g, '-')
            .replace(/\.\d+Z$/, '')
            .replace('Z', '');
    }

    /**
     * Delete oldest sessions when the traces directory has more than MAX_SESSIONS.
     * Groups .jsonl and .md files by session prefix and deletes them as pairs.
     */
    private rotateOldSessions(dir: string = this.tracesDir): void {
        let files: string[];
        try {
            files = fs.readdirSync(dir);
        } catch {
            return; // directory doesn't exist yet
        }

        // Group by session prefix: "2026-04-09T14-30-00_abc123"
        const sessions = new Map<string, string[]>();
        for (const f of files) {
            const prefix = f.replace(/\.trace\.(jsonl|md)$/, '');
            if (prefix === f) continue; // not a trace file
            if (!sessions.has(prefix)) sessions.set(prefix, []);
            sessions.get(prefix)!.push(f);
        }

        // Sort by prefix (timestamp-based, oldest first)
        const sorted = [...sessions.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        // Delete oldest sessions if > MAX_SESSIONS
        while (sorted.length > MAX_SESSIONS) {
            const [, sessionFiles] = sorted.shift()!;
            for (const f of sessionFiles) {
                try {
                    fs.unlinkSync(path.join(dir, f));
                } catch {
                    // ignore deletion errors
                }
            }
        }
    }
}

// ─── Singleton Export ────────────────────────────────────────────────────────

export const traceCollector = new TraceCollector();
