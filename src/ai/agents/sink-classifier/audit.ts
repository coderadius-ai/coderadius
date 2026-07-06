// ═══════════════════════════════════════════════════════════════════════════════
// Sink Classifier Audit Log — append-only JSONL for compliance trails.
//
// Every resolution emits one record per package describing WHY a decision was
// taken (which layer, what evidence). SOC2/ISO audits require a durable trail
// of automated security-relevant decisions.
//
// Rotation: when the active log exceeds 100 MB it is moved to .1, .2, ... up
// to .5; the oldest is discarded. Rotation is best-effort — a failure to
// rotate must NEVER block the pipeline, so all I/O errors are swallowed.
//
// ─── Known limitations (V1) ─────────────────────────────────────────────────
// Custom rotation reinvents the wheel. Two concrete gaps:
//   1. No file locking — two CLI processes rotating concurrently can corrupt
//      the cascade (one renames .3→.4 while the other appends to .3).
//   2. fs.appendFile during rotation is not strictly serialized.
//
// Known limitation: before the classifier ships with `mode: 'enabled'` as
// default, this module should be replaced with `winston-daily-rotate-file`
// (or rotation delegated to OS `logrotate`). For V1 — opt-in, single-process
// per repo — the corruption window is negligible.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { paths } from '../../../config/paths.js';

const DEFAULT_LOG_PATH = paths.logs.sinkClassifierAudit;
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_GENERATIONS = 5;

export interface AuditEntry {
    /** ISO 8601 timestamp. */
    ts: string;
    repo: string;
    package: string;
    ecosystem?: string;
    decision: 'sink' | 'ignore';
    source: 'user.ignore' | 'user.analyze' | 'hardcoded' | 'llm' | 'privacy';
    sinkType?: string;
    confidence?: number;
    reason?: string;
}

export class SinkAuditLog {
    constructor(private readonly logPath: string = DEFAULT_LOG_PATH) {}

    async append(entries: AuditEntry[] | Iterable<AuditEntry>): Promise<void> {
        const items = [...entries];
        if (items.length === 0) return;
        const dir = path.dirname(this.logPath);
        try {
            await fs.mkdir(dir, { recursive: true });
            await this.maybeRotate();
            const lines = items.map(e => JSON.stringify(e)).join('\n') + '\n';
            await fs.appendFile(this.logPath, lines, 'utf-8');
        } catch (err) {
            logger.warn(`[SinkAudit] append failed: ${(err as Error).message}`);
        }
    }

    private async maybeRotate(): Promise<void> {
        try {
            if (!existsSync(this.logPath)) return;
            const stat = statSync(this.logPath);
            if (stat.size < MAX_BYTES) return;

            // Cascade rotate: .4 → .5, .3 → .4, ..., active → .1
            for (let i = MAX_GENERATIONS - 1; i >= 1; i--) {
                const src = `${this.logPath}.${i}`;
                const dst = `${this.logPath}.${i + 1}`;
                if (existsSync(src)) {
                    try { await fs.rename(src, dst); } catch { /* swallow */ }
                }
            }
            try { await fs.rename(this.logPath, `${this.logPath}.1`); } catch { /* swallow */ }
        } catch (err) {
            logger.warn(`[SinkAudit] rotation failed: ${(err as Error).message}`);
        }
    }
}

export const sinkAuditLog = new SinkAuditLog();
