// ═══════════════════════════════════════════════════════════════════════════════
// Field-report renderer for live-graph assessments (scripts/assess-graph.ts).
//
// The legacy printReport targets tiny fixtures: it inlines short FN lists and
// omits FP lists above 5 items. On a field graph the FP list IS the finding,
// and FN lists run into the hundreds. This renderer:
//   - never omits names (wraps them within the terminal width instead)
//   - leads with a per-label scoreboard
//   - groups negative violations by label and match type (no duplicate
//     Regressions/Negatives lines)
//   - hides sections with nothing asserted (edges, symbols)
// Pure function (report → string): unit-tested in tests/unit/eval/.
// ═══════════════════════════════════════════════════════════════════════════════

import chalk from 'chalk';
import type { EvalReport, NodeScore, NegativeViolation } from './eval-scorer.js';

export interface RenderOptions {
    /** Target line width; lists wrap inside it. Default 100, clamped 80..140. */
    width?: number;
    /** Bolt URI shown in the header for context. */
    uri?: string;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function band(n: number): (s: string) => string {
    if (n >= 0.9) return chalk.green;
    if (n >= 0.7) return chalk.yellow;
    return chalk.red;
}

/** Comma-join names, wrapped at `width`, every line prefixed with `indent`. */
function wrapList(names: string[], indent: string, width: number): string[] {
    const lines: string[] = [];
    let current = indent;
    for (const name of names) {
        const piece = current === indent ? name : `, ${name}`;
        if (current.length + piece.length > width && current !== indent) {
            lines.push(current + ',');
            current = indent + name;
        } else {
            current += piece;
        }
    }
    if (current.trim().length > 0) lines.push(current);
    return lines;
}

function scoreboard(scores: NodeScore[], width: number): string[] {
    const labelWidth = Math.max(14, ...scores.map((s) => s.category.length));
    const header = `   ${'Label'.padEnd(labelWidth)} │ Precision │  Recall │   TP │   FP │   FN │ Graph`;
    const rule = `  ${'─'.repeat(Math.min(width - 2, header.length))}`;
    const rows = scores.map((s) => {
        const graphCount = s.truePositives.length + s.falsePositives.length;
        return `   ${s.category.padEnd(labelWidth)} │ ${band(s.precision)(pct(s.precision).padStart(9))} │ ${band(s.recall)(pct(s.recall).padStart(7))} │ ${String(s.truePositives.length).padStart(4)} │ ${String(s.falsePositives.length).padStart(4)} │ ${String(s.falseNegatives.length).padStart(4)} │ ${String(graphCount).padStart(5)}`;
    });
    return [chalk.bold('  SCOREBOARD'), rule, chalk.dim(header), rule, ...rows];
}

function errorBlocks(
    scores: NodeScore[],
    pick: (s: NodeScore) => string[],
    title: string,
    subtitle: string,
    color: (s: string) => string,
    width: number,
): string[] {
    const withErrors = scores.filter((s) => pick(s).length > 0);
    if (withErrors.length === 0) return [];
    const lines = [chalk.bold(`  ${title}`) + chalk.dim(`  ${subtitle}`)];
    for (const s of withErrors) {
        lines.push(color(`   ${s.category} (${pick(s).length})`));
        lines.push(...wrapList(pick(s).slice().sort(), '     ', width).map((l) => chalk.dim(l)));
    }
    return lines;
}

function violationsBlock(violations: NegativeViolation[], width: number): string[] {
    if (violations.length === 0) return [];
    const lines = [chalk.bold('  PINNED REGRESSIONS') + chalk.dim('  violated negative assertions')];
    const groups = new Map<string, string[]>();
    for (const v of violations) {
        const key = v.matchType === 'pattern'
            ? `${v.category} · pattern ${v.matchedPattern}`
            : `${v.category} · exact`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(v.violatingName);
    }
    for (const [key, names] of groups) {
        lines.push(chalk.red(`   ${key}: ${names.length}`));
        if (names.length <= 8) {
            lines.push(...wrapList(names.sort(), '     ', width).map((l) => chalk.dim(l)));
        }
    }
    return lines;
}

export function renderFieldReport(report: EvalReport, opts: RenderOptions = {}): string {
    const width = Math.min(140, Math.max(80, opts.width ?? 100));
    const rule = chalk.dim('  ' + '─'.repeat(width - 2));
    const out: string[] = [];

    out.push('');
    out.push(chalk.bold(`  ⬢ Graph Assessment — ${report.fixture}`));
    out.push(chalk.dim(`  ${report.timestamp.split('T')[0]} │ v${report.cliVersion}${opts.uri ? ` │ ${opts.uri}` : ''}`));
    out.push(rule);
    out.push('');
    out.push(...scoreboard(report.nodeScores, width));
    out.push('');

    const fp = errorBlocks(
        report.nodeScores, (s) => s.falsePositives,
        'FALSE POSITIVES', 'in the graph, denied by ground truth', chalk.red, width,
    );
    if (fp.length > 0) out.push(...fp, '');

    const fn = errorBlocks(
        report.nodeScores, (s) => s.falseNegatives,
        'FALSE NEGATIVES', 'expected by ground truth, missing from the graph', chalk.yellow, width,
    );
    if (fn.length > 0) out.push(...fn, '');

    const viol = violationsBlock(report.negativeViolations, width);
    if (viol.length > 0) out.push(...viol, '');

    if (report.edgeResult.expectedCount > 0) {
        out.push(chalk.bold('  EDGES'));
        out.push(`   verified ${report.edgeResult.foundCount}/${report.edgeResult.expectedCount}`);
        for (const m of report.edgeResult.missingEdges) out.push(chalk.yellow(`   missing: ${m}`));
        out.push('');
    }

    if (report.symbolScore.expectedCount > 0) {
        out.push(chalk.bold('  SYMBOL RESOLUTION'));
        out.push(`   resolved ${report.symbolScore.resolvedCount}/${report.symbolScore.expectedCount}`);
        for (const k of report.symbolScore.unresolvedDiKeys) out.push(chalk.red(`   DI key survives as channel: ${k}`));
        for (const m of report.symbolScore.missingPhysicalNames) out.push(chalk.yellow(`   missing physical: ${m}`));
        out.push('');
    }

    out.push(rule);
    const totalTp = report.nodeScores.reduce((n, s) => n + s.truePositives.length, 0);
    const totalFp = report.nodeScores.reduce((n, s) => n + s.falsePositives.length, 0);
    const totalFn = report.nodeScores.reduce((n, s) => n + s.falseNegatives.length, 0);
    const p = totalTp + totalFp > 0 ? totalTp / (totalTp + totalFp) : 1;
    const r = totalTp + totalFn > 0 ? totalTp / (totalTp + totalFn) : 1;
    out.push(`  Aggregate  precision ${band(p)(pct(p))} │ recall ${band(r)(pct(r))} │ violations ${report.negativeViolations.length > 0 ? chalk.red(String(report.negativeViolations.length)) : chalk.green('0')}`);
    out.push('');
    return out.join('\n');
}
