#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════════════════════════
// eval-trend — Eval Report Trend Tracker
//
// Reads eval history (.eval-history.jsonl) or JSON reports from
// tests/eval/reports/ and prints a time-ordered, deduplicated trend table
// showing precision, recall, regressions, and edge coverage across eval runs.
//
// Usage:
//   npx tsx tests/eval/scripts/eval-trend.ts
//   npx tsx tests/eval/scripts/eval-trend.ts --json          # machine-readable
//   npx tsx tests/eval/scripts/eval-trend.ts --last 5        # last N runs
//   npx tsx tests/eval/scripts/eval-trend.ts --fixture foo   # filter by fixture
//   npx tsx tests/eval/scripts/eval-trend.ts --all           # show all (no dedup)
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import type { EvalReport } from '../scorers/eval-scorer.js';

const REPORTS_DIR = path.resolve(import.meta.dirname, '..', 'reports');
const HISTORY_PATH = path.join(REPORTS_DIR, '.eval-history.jsonl');

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const showAll = args.includes('--all');
const lastN = (() => {
    const idx = args.indexOf('--last');
    return idx >= 0 ? parseInt(args[idx + 1], 10) : Infinity;
})();
const fixtureFilter = (() => {
    const idx = args.indexOf('--fixture');
    return idx >= 0 ? args[idx + 1] : undefined;
})();

// ─── Row Model ───────────────────────────────────────────────────────────────

interface TrendRow {
    /** ISO timestamp */
    timestamp: string;
    /** HH:MM local time */
    time: string;
    /** YYYY-MM-DD */
    date: string;
    fixture: string;
    model: string;
    commit: string;
    version: string;
    precision: number;
    recall: number;
    edgeCoverage: number;
    symbolResolution: number;
    regressions: number;
    /** How many consecutive runs had the same metrics (1 = unique, N = collapsed) */
    count: number;
}

// ─── Load from JSONL (preferred — has commit info) ───────────────────────────

interface HistoryEntry {
    timestamp: string;
    commit: string;
    fixture: string;
    model: string;
    precision: number;
    recall: number;
    edgeCoverage: number;
    symbolResolution: number;
    regressions: number;
}

function loadFromHistory(): TrendRow[] | null {
    if (!fs.existsSync(HISTORY_PATH)) return null;

    const lines = fs.readFileSync(HISTORY_PATH, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0);

    if (lines.length === 0) return null;

    return lines.map(line => {
        const e = JSON.parse(line) as HistoryEntry;
        return historyToRow(e);
    });
}

function historyToRow(e: HistoryEntry): TrendRow {
    const d = new Date(e.timestamp);
    return {
        timestamp: e.timestamp,
        time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        date: e.timestamp.split('T')[0],
        fixture: e.fixture,
        model: e.model && e.model !== 'unknown' ? e.model : '—',
        commit: e.commit || '—',
        version: '—',
        precision: e.precision,
        recall: e.recall,
        edgeCoverage: e.edgeCoverage,
        symbolResolution: e.symbolResolution,
        regressions: e.regressions,
        count: 1,
    };
}

// ─── Fallback: Load from JSON reports ────────────────────────────────────────

function loadFromReports(): TrendRow[] {
    if (!fs.existsSync(REPORTS_DIR)) return [];

    const files = fs.readdirSync(REPORTS_DIR)
        .filter(f => f.endsWith('.json') && f.startsWith('eval-'))
        .sort();

    return files.map(f => {
        const content = fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8');
        const r = JSON.parse(content) as EvalReport;
        return reportToRow(r, f);
    });
}

function reportToRow(r: EvalReport, filename: string): TrendRow {
    const d = new Date(r.timestamp);
    const edgePct = r.edgeResult.expectedCount > 0
        ? r.edgeResult.foundCount / r.edgeResult.expectedCount
        : 1.0;
    const symPct = r.symbolScore.expectedCount > 0
        ? r.symbolScore.resolvedCount / r.symbolScore.expectedCount
        : 1.0;

    // Extract commit from filename if available (eval-fixture-YYYY-MM-DD_HH-MM-SS.json)
    const commitGuess = '—';

    return {
        timestamp: r.timestamp,
        time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        date: r.timestamp.split('T')[0],
        fixture: r.fixture,
        model: r.llmModel && r.llmModel !== 'unknown' ? r.llmModel : '—',
        commit: commitGuess,
        version: r.cliVersion || '—',
        precision: r.aggregatePrecision,
        recall: r.aggregateRecall,
        edgeCoverage: edgePct,
        symbolResolution: symPct,
        regressions: r.criticalRegressionCount,
        count: 1,
    };
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function metricsKey(r: TrendRow): string {
    return `${r.fixture}|${r.precision}|${r.recall}|${r.edgeCoverage}|${r.symbolResolution}|${r.regressions}`;
}

function deduplicateRows(rows: TrendRow[]): TrendRow[] {
    if (rows.length === 0) return [];

    const result: TrendRow[] = [];
    let current = { ...rows[0] };
    current.count = 1;

    for (let i = 1; i < rows.length; i++) {
        if (metricsKey(rows[i]) === metricsKey(current)) {
            current.count++;
            // Keep the latest timestamp/commit
            current.timestamp = rows[i].timestamp;
            current.time = rows[i].time;
            current.date = rows[i].date;
            current.commit = rows[i].commit !== '—' ? rows[i].commit : current.commit;
        } else {
            result.push(current);
            current = { ...rows[i] };
            current.count = 1;
        }
    }
    result.push(current);
    return result;
}

// ─── Delta Formatting ────────────────────────────────────────────────────────

function fmtPct(n: number): string {
    return (n * 100).toFixed(1) + '%';
}

function fmtDelta(curr: number, prev: number): string {
    const diff = (curr - prev) * 100;
    if (Math.abs(diff) < 0.05) return '   ';
    const sign = diff > 0 ? '▲' : '▼';
    return `${sign}${Math.abs(diff).toFixed(1).padStart(2)}`;
}

// ─── Table Renderer ──────────────────────────────────────────────────────────

function printTable(rows: TrendRow[]): void {
    const W = 115;
    const SEP = '═'.repeat(W);
    const THIN = '─'.repeat(W - 4);
    const log = (s: string) => console.log(s);

    log('');
    log(`  ${SEP}`);
    log(`  CodeRadius Eval Trend Report`);
    log(`  Generated: ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}    Reports: ${rows.length} unique runs`);
    log(`  ${SEP}`);
    log('');

    // Header
    log(
        '  ' +
        '#'.padEnd(4) +
        'Date'.padEnd(13) +
        'Time'.padEnd(7) +
        'Commit'.padEnd(10) +
        'Fixture'.padEnd(16) +
        'Precision'.padEnd(13) +
        'Δ'.padEnd(5) +
        'Recall'.padEnd(10) +
        'Δ'.padEnd(5) +
        'Edges'.padEnd(9) +
        'Symbols'.padEnd(9) +
        'Regr'.padEnd(5) +
        'Runs',
    );
    log(`  ${THIN}`);

    let lastDate = '';
    let prevRow: TrendRow | null = null;

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];

        // Day separator
        if (r.date !== lastDate && lastDate !== '') {
            log(`  ${'·'.repeat(W - 4)}`);
        }
        lastDate = r.date;

        const precDelta = prevRow ? fmtDelta(r.precision, prevRow.precision) : '   ';
        const recDelta = prevRow ? fmtDelta(r.recall, prevRow.recall) : '   ';
        const regrFlag = r.regressions > 0 ? ' ❌' : '';
        const countStr = r.count > 1 ? `×${r.count}` : '';

        log(
            '  ' +
            String(i + 1).padEnd(4) +
            r.date.padEnd(13) +
            r.time.padEnd(7) +
            r.commit.slice(0, 7).padEnd(10) +
            r.fixture.padEnd(16) +
            fmtPct(r.precision).padEnd(13) +
            precDelta.padEnd(5) +
            fmtPct(r.recall).padEnd(10) +
            recDelta.padEnd(5) +
            fmtPct(r.edgeCoverage).padEnd(9) +
            fmtPct(r.symbolResolution).padEnd(9) +
            String(r.regressions).padEnd(5) +
            countStr +
            regrFlag,
        );

        prevRow = r;
    }

    // ─── Summary ─────────────────────────────────────────────────────────
    if (rows.length >= 2) {
        const first = rows[0];
        const last = rows[rows.length - 1];

        log('');
        log(`  ─── Overall Trend (first → latest) ────────────────────────────────────`);

        const summaryLine = (label: string, getter: (r: TrendRow) => number) => {
            const f = getter(first);
            const l = getter(last);
            const arrow = l > f ? '▲' : l < f ? '▼' : '═';
            log(`  ${label.padEnd(14)} ${fmtPct(f).padStart(7)} → ${fmtPct(l).padStart(7)}  ${arrow}`);
        };

        summaryLine('Precision:', r => r.precision);
        summaryLine('Recall:', r => r.recall);
        summaryLine('Edges:', r => r.edgeCoverage);
        summaryLine('Symbols:', r => r.symbolResolution);
        log(`  ${'Regressions:'.padEnd(14)} ${String(first.regressions).padStart(7)} → ${String(last.regressions).padStart(7)}`);

        // Best metrics achieved
        const bestPrec = Math.max(...rows.map(r => r.precision));
        const bestRecall = Math.max(...rows.map(r => r.recall));
        log('');
        log(`  ─── Best Achieved ──────────────────────────────────────────────────────`);
        log(`  Precision:    ${fmtPct(bestPrec)}    Recall:    ${fmtPct(bestRecall)}`);
    }

    log(`  ${SEP}`);
    log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

// Prefer JSONL history (has commit info), fall back to JSON reports
let rows = loadFromHistory() ?? loadFromReports();

if (rows.length === 0) {
    console.log('No eval data found.');
    console.log(`  Checked: ${HISTORY_PATH}`);
    console.log(`           ${REPORTS_DIR}/*.json`);
    console.log('  Run the eval suite first: make eval-graph');
    process.exit(0);
}

// Filter
if (fixtureFilter) {
    rows = rows.filter(r => r.fixture === fixtureFilter);
}

// Deduplicate consecutive identical metric runs (unless --all)
if (!showAll) {
    rows = deduplicateRows(rows);
}

// Limit
if (lastN < rows.length) {
    rows = rows.slice(-lastN);
}

// Output
if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
} else {
    printTable(rows);
}
