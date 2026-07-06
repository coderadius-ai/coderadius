// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine: Report Generator
//
// Step 6 (final) of the In-Memory Graph Overlay pipeline.
//
// Generates the GuardrailReport in two output modes:
//
//   1. Markdown (default): A structured Markdown document suitable for
//      injection as a PR comment (via `gh pr comment` or `glab mr note`).
//      Uses a table + explicit severity labels for maximum readability.
//
//   2. JSON (--json flag): A machine-readable GuardrailReport for CI
//      pipelines that prefer structured data over rendered text.
//
//   3. TTY mode: When stdout is a TTY (developer running locally), the
//      Markdown is printed with ANSI color codes for a premium terminal UX.
//      This is the "Terraform Plan" UX model.
//
// This module does NOT write to any file; it returns a string.
// The CLI command is responsible for writing to stdout or --output <file>.
// ═══════════════════════════════════════════════════════════════════════════════

import type { GuardrailReport, GuardrailFinding, FindingSeverity } from './types.js';

// ─── TTY detection ────────────────────────────────────────────────────────────

const IS_TTY = process.stdout.isTTY ?? false;

// ANSI color helpers (used in TTY mode only)
const ansi = {
    red: (s: string) => IS_TTY ? `\x1b[31m${s}\x1b[0m` : s,
    yellow: (s: string) => IS_TTY ? `\x1b[33m${s}\x1b[0m` : s,
    blue: (s: string) => IS_TTY ? `\x1b[34m${s}\x1b[0m` : s,
    green: (s: string) => IS_TTY ? `\x1b[32m${s}\x1b[0m` : s,
    bold: (s: string) => IS_TTY ? `\x1b[1m${s}\x1b[0m` : s,
    dim: (s: string) => IS_TTY ? `\x1b[2m${s}\x1b[0m` : s,
    cyan: (s: string) => IS_TTY ? `\x1b[36m${s}\x1b[0m` : s,
};

// ─── Severity formatting ──────────────────────────────────────────────────────

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
    DANGER:  'DANGER',
    WARNING: 'WARNING',
    INFO:    'INFO',
};

// Small marker glyphs printed alongside the severity word. They give the
// finding header a visual anchor without resorting to brackets or boxes.
const SEVERITY_MARKER: Record<FindingSeverity, string> = {
    DANGER:  '✕',
    WARNING: '▲',
    INFO:    '●',
};

function plural(n: number, singular: string, pluralForm = singular + 's'): string {
    return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Format a wall-clock duration for the LLM summary line.
 *   < 1s     → "<1s"
 *   < 60s    → "3.6s"
 *   < 1h     → "3m 32s"
 *   else     → "1h 12m"
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 3600) {
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m}m ${s}s`;
    }
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${m}m`;
}

/**
 * Format a token count compactly for the LLM summary line.
 *   < 1k     → "850"
 *   < 1M     → "17.0k"
 *   else     → "1.2M"
 */
export function formatTokenCount(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Compact LLM run summary in the same shape `analyze code` uses for task lines.
 *   `(3.6s · ↑ 17.0k · ↓ 3.2k tokens)`
 * Returns null when there were no LLM calls (e.g. report rendered before
 * Step 4, or tokensUsed not propagated).
 */
export function formatLlmSummary(input: { durationMs: number; tokensUsed?: { in: number; out: number; cached: number } | undefined }): string | null {
    const t = input.tokensUsed;
    if (!t || (t.in === 0 && t.out === 0)) return null;
    return `(${formatDuration(input.durationMs)} · ↑ ${formatTokenCount(t.in)} · ↓ ${formatTokenCount(t.out)} tokens)`;
}

/**
 * Phase-level completion line printed by the CLI right after the LLM call
 * returns. Same shape as `formatLlmSummary` but pre-wrapped in the standard
 * 2-space indent + dim style used by other pipeline status lines.
 *
 * Returns null when there's no LLM info to report (caller suppresses the
 * line entirely instead of printing a hollow "(0s)" stub).
 */
export function formatLlmPhaseDone(durationMs: number, tokensUsed?: { in: number; out: number; cached: number }): string | null {
    const summary = formatLlmSummary({ durationMs, tokensUsed });
    if (!summary) return null;
    const isTty = process.stdout.isTTY ?? false;
    const dim = (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s);
    return dim(`  ${summary}`);
}

function getResult(summary: GuardrailReport['summary']): { status: string; gate: string; decision: string; message: string } {
    if (summary.danger > 0) {
        return {
            status: 'FAIL',
            gate: 'BLOCK',
            decision: 'BLOCK MERGE',
            message: 'Blocking architectural impact detected.',
        };
    }

    if (summary.warning > 0) {
        return {
            status: 'REVIEW',
            gate: 'REVIEW',
            decision: 'REVIEW',
            message: 'Architectural warnings require review before merge.',
        };
    }

    return {
        status: 'PASS',
        gate: 'PASS',
        decision: 'ALLOW MERGE',
        message: 'No blocking architectural issues detected.',
    };
}

/**
 * Human-readable, category-aware noun for a graph node type. Used by
 * `buildReasonText` so the Decision/Reason header reads naturally instead of
 * leaking internal labels.
 */
function targetTypeNoun(targetType: string | undefined): string {
    switch (targetType) {
        case 'APIEndpoint': return 'endpoint';
        case 'MessageChannel': return 'message channel';
        case 'DataContainer': return 'table';
        case 'Cache': return 'cache';
        case 'Database': return 'database';
        case 'ObjectStorage': return 'object storage';
        case 'ExternalAPI': return 'external API';
        default: return 'dependency';
    }
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Synthesise a single-sentence reason that a manager / tech-lead can skim
 * to understand the gate decision without reading the per-finding sections.
 *
 * For DANGER findings we append an explicit note that the gate is driven by
 * the change TYPE (e.g. public contract break), not by the blast volume.
 * This prevents the natural reviewer reaction of "only 1 function, why
 * block?" when the count is intentionally small.
 */
function buildReasonText(report: GuardrailReport): string {
    const { summary, findings } = report;
    if (summary.danger === 0 && summary.warning === 0) {
        return 'No blocking architectural impact detected.';
    }
    if (summary.danger === 0) {
        return `${plural(summary.warning, 'architectural warning')} require review before merge.`;
    }

    const danger = findings.filter(f => f.severity === 'DANGER');
    let core: string;
    if (danger.length > 1) {
        core = `${plural(danger.length, 'breaking architectural change')} detected across the diff.`;
    } else {
        const f = danger[0];
        const edge = f.removedEdge ?? f.addedEdge;
        const noun = targetTypeNoun(edge?.targetType);
        if (f.category === 'renamed_dependency') {
            core = `${capitalize(noun)} target changed and downstream consumer(s) still depend on the previous version.`;
        } else if (f.category === 'breaking_change') {
            core = `${capitalize(noun)} removed but downstream consumer(s) still depend on it.`;
        } else {
            core = f.title;
        }
    }
    // Always remind the reader that the gate is type-driven, not count-driven.
    return `${core} Blocking by change type, not by volume.`;
}

function getTopSeverity(report: GuardrailReport): FindingSeverity | 'NONE' {
    if (report.summary.danger > 0) return 'DANGER';
    if (report.summary.warning > 0) return 'WARNING';
    if (report.summary.info > 0) return 'INFO';
    return 'NONE';
}

function getBlastCounts(report: GuardrailReport): { services: number; functions: number } {
    const seenServices = new Set<string>();
    const seenFunctions = new Set<string>();
    for (const f of report.findings) {
        if (f.severity !== 'DANGER') continue;
        for (const svc of f.affectedServices ?? []) {
            seenServices.add(svc.urn);
            for (const fn of svc.functions.filter(Boolean)) {
                seenFunctions.add(`${svc.urn}::${fn.name}::${fn.file ?? ''}`);
            }
        }
    }
    return { services: seenServices.size, functions: seenFunctions.size };
}

function getConfidence(report: GuardrailReport): { level: 'HIGH' | 'MEDIUM' | 'LOW'; reason: string } {
    const b = report.baseline;
    if (!b) return { level: 'HIGH', reason: 'no baseline metadata' };
    if (b.unknownFiles.length > 0) {
        return {
            level: 'LOW',
            reason: `${plural(b.unknownFiles.length, 'file')} absent from graph, removed deps may be under-reported`,
        };
    }
    if (b.gitFallbackFiles && b.gitFallbackFiles.length > 0) {
        return {
            level: 'MEDIUM',
            reason: `${plural(b.gitFallbackFiles.length, 'file')} reconstructed from git base`,
        };
    }
    return { level: 'HIGH', reason: 'all changed files present in baseline graph' };
}

function formatBlastRadius(counts: { services: number; functions: number }): string | null {
    if (counts.services === 0) return null;
    const fnText = counts.functions > 0 ? ` / ${plural(counts.functions, 'function')}` : '';
    return `${plural(counts.services, 'service')}${fnText} impacted`;
}

function getComparisonRef(report: GuardrailReport): string {
    return report.comparison?.ref ?? report.prRef;
}

function colorSeverity(severity: FindingSeverity, text: string): string {
    if (!IS_TTY) return text;
    switch (severity) {
        case 'DANGER':  return ansi.red(text);
        case 'WARNING': return ansi.yellow(text);
        case 'INFO':    return ansi.blue(text);
    }
}

function getWhyLabel(severity: FindingSeverity): string {
    return severity === 'DANGER' ? 'Why this is dangerous'
         : severity === 'WARNING' ? 'Why this matters'
         : 'Context';
}

function getBlockingTitles(report: GuardrailReport): string[] | null {
    if (report.summary.danger === 0) return null;
    return report.findings
        .filter(f => f.severity === 'DANGER')
        .map(f => f.title);
}

/**
 * Strip the `unknown/` org prefix that the URN-naming code injects when a
 * repository has no catalog entry. Cosmetic only: the URN-internal id keeps
 * the prefix for stability.
 */
export function displayRepoName(name: string): string {
    return name.startsWith('unknown/') ? name.slice('unknown/'.length) : name;
}

/**
 * Qualify a service name with its repository when ambiguous (monorepo or
 * generic names like "api", "worker"). Mirrors the dashboard convention
 * `<repo> / <name>` (packages/dashboard-ui/src/transformers/utils.ts).
 */
export function formatServiceLabel(svc: {
    name: string;
    repository?: { name: string; url: string | null } | null;
}): string {
    const repo = svc.repository?.name;
    if (!repo || repo === svc.name) return svc.name;
    return `${displayRepoName(repo)} / ${svc.name}`;
}

// ─── Markdown generation ─────────────────────────────────────────────────────

function renderFindingMarkdown(finding: GuardrailFinding, opts: { resolveFilePath?: ReportGeneratorOptions['resolveFilePath'] } = {}): string {
    const lines: string[] = [];
    const whyLabel = getWhyLabel(finding.severity);

    const badge = `**${SEVERITY_LABEL[finding.severity]}**`;
    lines.push(`### ${badge} · ${finding.title}`, '');

    // Multi-line whatChanged uses Markdown soft breaks (trailing 2 spaces).
    lines.push(`**What changed:** ${finding.whatChanged.replace(/\n/g, '  \n')}`, '');
    lines.push(`**${whyLabel}:** ${finding.rationale}`, '');

    if (finding.affectedServices && finding.affectedServices.length > 0) {
        lines.push('**Impacted downstream services:**');
        lines.push('');
        lines.push('| Service | Team | Repository | Impacted Functions |');
        lines.push('| :--- | :--- | :--- | :--- |');

        for (const service of finding.affectedServices) {
            const team = service.teamOwner ?? '-';
            const repo = service.repository
                ? (service.repository.url
                    ? `[${displayRepoName(service.repository.name)}](${service.repository.url})`
                    : displayRepoName(service.repository.name))
                : '-';
            const functions = service.functions.filter(Boolean);
            const funcs = functions.length > 0
                ? functions
                    .slice(0, 3)
                    .map(f => {
                        if (!f.file) return `\`${f.name}\``;
                        const url = opts.resolveFilePath?.(service.repository?.url ?? null, f.file);
                        const fileLink = url ? `[\`${f.file}\`](${url})` : `\`${f.file}\``;
                        return `\`${f.name}\` in ${fileLink}`;
                    })
                    .join('<br>')
                : '-';
            lines.push(`| \`${service.name}\` | ${team} | ${repo} | ${funcs} |`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function renderMarkdown(report: GuardrailReport, opts: { verbose?: boolean; resolveFilePath?: ReportGeneratorOptions['resolveFilePath'] } = {}): string {
    const lines: string[] = [];
    const { summary } = report;
    const result = getResult(summary);
    const comparisonRef = getComparisonRef(report);
    const blastCounts = getBlastCounts(report);
    const blastText = formatBlastRadius(blastCounts);
    const confidence = getConfidence(report);

    // ── Header ─────────────────────────────────────────────────────────────
    lines.push('## CodeRadius Blast Evaluation', '');

    // Decision + Reason: scannable for non-engineer reviewers (tech-lead skim).
    const reason = buildReasonText(report);
    lines.push(
        `**Decision:** ${result.decision} · ${summary.danger} danger, ${summary.warning} warning, ${summary.info} info  `,
        `**Reason:** ${reason}`,
        '',
    );

    if (report.repository) {
        lines.push(`**Repository:** ${displayRepoName(report.repository.name)}  `);
        if (opts.verbose) {
            lines.push(`**Repo path:** ${report.repository.path}  `);
        }
    }
    if (comparisonRef) {
        lines.push(`**Comparison:** ${comparisonRef}  `);
    }
    if (report.prRef && report.prRef !== comparisonRef) {
        lines.push(`**Intent:** ${report.prRef}  `);
    }
    if (opts.verbose && report.baseline) {
        const fallback = report.baseline.gitFallbackFiles?.length
            ? `, ${report.baseline.gitFallbackFiles.length} git fallback`
            : '';
        lines.push(
            `**Baseline:** ${report.baseline.source} (${report.baseline.knownFiles.length} known${fallback}, ${report.baseline.unknownFiles.length} unknown)  `,
        );
    }
    lines.push(
        `**Analyzed files:** ${report.changedFiles.length}  `,
        `**Duration:** ${(report.durationMs / 1000).toFixed(1)}s  `,
    );
    if (blastText) {
        lines.push(`**Blast radius:** ${blastText}  `);
    }
    lines.push(`**Confidence:** ${confidence.level} (${confidence.reason})`, '');

    if (report.baseline && report.baseline.unknownFiles.length > 0) {
        lines.push(
            `> Baseline coverage gap: ${plural(report.baseline.unknownFiles.length, 'changed file', 'changed files')} absent from the graph. Removed dependencies may be under-reported.`,
            '',
        );
    }

    // ── Analyzed Files ─────────────────────────────────────────────────────
    if (report.changedFiles.length > 0) {
        lines.push('<details>');
        lines.push(`<summary>Analyzed files (${report.changedFiles.length})</summary>`, '');
        for (const f of report.changedFiles) {
            lines.push(`- \`${f}\``);
        }
        lines.push('', '</details>', '');
    }

    // ── Findings ───────────────────────────────────────────────────────────
    // INFO findings are intentionally NOT rendered: in practice they erode
    // signal/noise ratio (often false-positive edge inferences) and aren't
    // actionable by definition. The count stays in the Decision line; the
    // JSON output keeps all findings for programmatic consumers.
    const visibleMd = report.findings.filter(f => f.severity !== 'INFO');
    if (visibleMd.length > 0) {
        lines.push('---', '');
        for (const finding of visibleMd) {
            lines.push(renderFindingMarkdown(finding, { resolveFilePath: opts.resolveFilePath }));
            lines.push('---', '');
        }
    } else if (report.findings.length === 0) {
        lines.push('*No findings to report.*', '');
    }

    // ── Why Blocked ────────────────────────────────────────────────────────
    // Render the title list only when 2+ DANGER findings (single one is just a
    // repeat of the title rendered above). The --advisory override hint is
    // intentionally omitted: it's covered by `cr impact --help` and the docs,
    // so it's noise in the per-run output.
    if (summary.danger > 1) {
        const blockingTitles = getBlockingTitles(report)!;
        lines.push('### Why blocked', '');
        for (const title of blockingTitles) {
            lines.push(`- ${title}`);
        }
        lines.push('');
    }

    // ── Footer ─────────────────────────────────────────────────────────────
    const llmSummary = formatLlmSummary({ durationMs: report.durationMs, tokensUsed: report.tokensUsed });
    const footerLine = llmSummary
        ? `<sub>Generated by [CodeRadius](https://coderadius.ai) · ${report.generatedAt} · ${llmSummary}</sub>`
        : `<sub>Generated by [CodeRadius](https://coderadius.ai) · ${report.generatedAt}</sub>`;
    lines.push('', footerLine);

    return lines.join('\n');
}

// ─── TTY (terminal) rendering — Linear-style minimal layout ──────────────────
//
// Three state-specific renderers (× breaking / ▲ watch / ✓ safe) emit a
// tight, indentation-driven output. Zero section labels; the visual
// hierarchy alone communicates the structure:
//
//   × breaking
//
//     <verdict verb>            (e.g. "<X> renamed")
//     <verdict consequence>     (e.g. "1 service still reads it")
//
//     <source file>
//       <source symbol>
//       → <new target>          (rename) | removed <name> (breaking_change)
//       <N> columns carried     (only for table-rename cascades)
//
//     <service name>
//       <entrypoint 1>
//       <entrypoint 2>
//
//     <repo>  <ref>  <N files>  <duration>
//
// Strict rule: red is used only on the top `×` + word; amber only on the
// top `▲` + word; green only on the top `✓` + word. Everything else is
// either default (content) or dim (metadata + file paths). No mid-dot
// separators outside the footer fallback. No `│` gutter, no box drawing,
// no em-dashes anywhere — `→` is the only allowed special glyph in body
// text (transformation indicator).

/**
 * Strip the protocol and the trailing `.git` suffix so URLs render as
 * compact, clickable identifiers (`github.com/owner/repo` instead of
 * `git@github.com:owner/repo.git`). Returns null when the input isn't a
 * recognisable git remote URL.
 */
export function normalizeGitUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    if (trimmed.length === 0) return null;
    // SSH form: git@github.com:owner/repo.git
    const ssh = trimmed.match(/^(?:ssh:\/\/)?[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;
    // HTTPS form: https://github.com/owner/repo.git
    const https = trimmed.match(/^https?:\/\/(?:[\w.-]+@)?([\w.-]+\/.+?)(?:\.git)?$/);
    if (https) return https[1];
    // Unknown shape: return as-is (better than swallowing the URL silently)
    return trimmed.replace(/\.git$/, '');
}

/**
 * Render a repository identifier: prefer the normalised remote URL when
 * available (bold path segment, dim host prefix so the eye lands on the
 * repo), fall back to the canonical short name otherwise. Use everywhere
 * a repo needs surface area: header strip + impacted-services block.
 */
function renderRepoIdentifier(name: string | undefined, url: string | null | undefined): string {
    const normalised = normalizeGitUrl(url ?? null);
    if (normalised) {
        const slash = normalised.indexOf('/');
        if (slash > 0) {
            return `${ansi.cyan(ansi.dim(normalised.slice(0, slash + 1)))}${ansi.cyan(ansi.bold(normalised.slice(slash + 1)))}`;
        }
        return ansi.cyan(ansi.bold(normalised));
    }
    return ansi.bold(displayRepoName(name ?? ''));
}

/**
 * Header strip at the top of every TTY output: repo URL (or name) + comparison
 * ref + file count + duration, all on one line. Replaces the previous
 * footer position so the reader's eye lands on the verdict immediately
 * after seeing the context.
 */
function renderHeaderStrip(report: GuardrailReport): string {
    const parts: string[] = [];
    if (report.repository) {
        parts.push(renderRepoIdentifier(report.repository.name, report.repository.url));
    }
    const comparison = getComparisonRef(report);
    if (comparison) parts.push(ansi.dim(comparison));
    parts.push(ansi.dim(`${report.changedFiles.length} ${report.changedFiles.length === 1 ? 'file' : 'files'}`));
    parts.push(ansi.dim(`${(report.durationMs / 1000).toFixed(1)}s`));
    const conf = getConfidence(report);
    if (conf.level !== 'HIGH') parts.push(ansi.yellow(conf.level));
    return `  ${parts.join(ansi.dim('  '))}`;
}

/**
 * Deduplicate `affectedServices` across all DANGER findings: each unique
 * service appears once with the union of impacted functions. Listing the
 * impacted services once at the top of the BLOCK output (instead of
 * repeating per finding) is the single biggest verbosity win.
 */
function collectUniqueImpact(report: GuardrailReport): Array<{
    name: string;
    teamOwner: string | null;
    repository: { name: string; url: string | null } | null;
    functions: Array<{ name: string; file: string | null }>;
}> {
    const byUrn = new Map<string, ReturnType<typeof collectUniqueImpact>[number]>();
    for (const f of report.findings) {
        if (f.severity !== 'DANGER') continue;
        for (const svc of f.affectedServices ?? []) {
            const existing = byUrn.get(svc.urn);
            if (!existing) {
                byUrn.set(svc.urn, {
                    name: svc.name,
                    teamOwner: svc.teamOwner,
                    repository: svc.repository ?? null,
                    functions: [...svc.functions.filter(Boolean)],
                });
                continue;
            }
            const seen = new Set(existing.functions.map(fn => `${fn.name}::${fn.file ?? ''}`));
            for (const fn of svc.functions.filter(Boolean)) {
                const key = `${fn.name}::${fn.file ?? ''}`;
                if (!seen.has(key)) {
                    existing.functions.push(fn);
                    seen.add(key);
                }
            }
        }
    }
    return [...byUrn.values()];
}

/**
 * Elide deeply-namespaced names so the layout reads more like prose and less
 * like a stack trace. Strategy: drop the middle namespace segments and keep
 * the first segment + the last segment (which carries the class + method).
 *
 *   AcmeShop\Shipping\Express\UpdateQuote\Command\AbstractUpdateQuoteWindowCommand.execute
 *   → AcmeShop\…\AbstractUpdateQuoteWindowCommand.execute
 *
 * Falls back to a tail-truncation when no namespace separator gives a
 * shorter result. Returns the input unchanged when it already fits.
 */
function elideQualifiedName(name: string, maxLen = 60): string {
    if (name.length <= maxLen) return name;

    // PHP namespace `\`
    const firstBackslash = name.indexOf('\\');
    const lastBackslash = name.lastIndexOf('\\');
    if (firstBackslash > 0 && lastBackslash > firstBackslash) {
        const head = name.slice(0, firstBackslash);
        const tail = name.slice(lastBackslash);
        const elided = `${head}\\…${tail}`;
        if (elided.length < name.length) return elided;
    }

    // TS dotted module path (`Foo.Bar.Quux::method` is rare; cover defensively)
    const firstDot = name.indexOf('.');
    const lastDot = name.lastIndexOf('.');
    if (firstDot > 0 && lastDot > firstDot) {
        const head = name.slice(0, firstDot);
        const tail = name.slice(lastDot);
        const elided = `${head}.…${tail}`;
        if (elided.length < name.length) return elided;
    }

    return name.slice(0, maxLen - 1) + '…';
}

/**
 * Two-line verdict that lifts the diff to the very top of the body so the
 * reader sees `<old> → <new>` at a glance (essential for spotting typos
 * like `order_records → order_record`):
 *
 *   line 1   `<old>  →  <new>`         (dim + cyan arrow + bold)
 *            or `removed <name>`       (for breaking_change)
 *   line 2   `<N> services still ...`  (the consequence)
 *
 * Falls back to `buildReasonText` for shapes the diff generator can't
 * pattern-match.
 */
function buildVerdictLines(report: GuardrailReport): string[] {
    const dangers = report.findings.filter(f => f.severity === 'DANGER');
    if (dangers.length === 1) {
        const f = dangers[0];
        const services = (f.affectedServices ?? []).length;
        if (f.category === 'renamed_dependency' && f.removedEdge?.targetName && f.addedEdge?.targetName) {
            const diff = `${ansi.dim(f.removedEdge.targetName)}  ${ansi.cyan('→')}  ${ansi.bold(f.addedEdge.targetName)}`;
            if (services > 0) {
                return [diff, `${plural(services, 'service')} still ${services === 1 ? 'reads' : 'read'} it`];
            }
            return [diff];
        }
        if (f.category === 'breaking_change' && f.removedEdge?.targetName) {
            const removed = `${ansi.dim('removed')}  ${ansi.bold(f.removedEdge.targetName)}`;
            if (services > 0) {
                return [removed, `${plural(services, 'consumer')} still ${services === 1 ? 'relies' : 'rely'} on it`];
            }
            return [removed];
        }
    }
    if (dangers.length > 1) {
        const seenSvcs = new Set<string>();
        for (const f of dangers) for (const svc of f.affectedServices ?? []) seenSvcs.add(svc.urn);
        return [
            `${plural(dangers.length, 'breaking change')} detected`,
            `${plural(seenSvcs.size, 'service')} would break`,
        ];
    }
    return [buildReasonText(report)];
}

/**
 * Strip the synthetic suffix that the language plugins use to flag class /
 * route metadata chunks; the suffix is implementation detail and would
 * leak noise into a layout that's supposed to read like prose.
 */
function cleanSymbolName(name: string | undefined): string | undefined {
    if (!name) return undefined;
    return name.replace(/::__class_metadata$/, '').replace(/::__route_handler$/, '');
}

/**
 * When the differ collapsed a table-rename cascade, the resolver appends
 * `(N columns inherited: ...)` to `whatChanged`. We surface just the count
 * in the body; the column list lives in `--json` for programmatic consumers.
 */
function extractCascadeCount(whatChanged: string | undefined): number | null {
    if (!whatChanged) return null;
    const m = whatChanged.match(/\((\d+)\s+columns?\s+inherited/);
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Per-finding body: source file + indented symbol + optional cascade count.
 * The `<old> → <new>` diff itself lives in the verdict lines above
 * (`buildVerdictLines`), so this block only carries the WHERE (file +
 * symbol) and the cascade scope, never the diff again.
 *
 * Colour budget: file path in dim cyan (code location), table context
 * (for column renames) in dim. Everything else monochrome so the verdict
 * diff stays the visual peak.
 */
function renderFindingBody(f: GuardrailFinding): string[] {
    const lines: string[] = [];
    const file = f.removedEdge?.sourceFile ?? f.addedEdge?.sourceFile;
    const sym = cleanSymbolName(f.removedEdge?.sourceName ?? f.addedEdge?.sourceName);

    if (file) lines.push(`  ${ansi.cyan(ansi.dim(file))}`);
    if (sym) lines.push(`    ${sym}`);

    // For column renames the verdict shows `customer_id → buyer_id` but not
    // the parent table — surface it here so the reader knows which table
    // the column belongs to.
    if (f.category === 'renamed_dependency' && f.removedEdge?.relType === 'HAS_FIELD') {
        const table = f.removedEdge?.sourceName;
        if (table) lines.push(`    ${ansi.dim(`in ${table}`)}`);
    }

    const cascade = extractCascadeCount(f.whatChanged);
    if (cascade !== null && cascade > 0) {
        lines.push(`    ${ansi.dim(`${cascade} columns carried`)}`);
    }

    return lines;
}

/**
 * Consumer block: service name + (when known) its remote URL on the same
 * line, indented entrypoints beneath. Files for each entrypoint are
 * dropped in the default view (the function name is grep-able; the file
 * lives in `cr blast --json` for programmatic consumers).
 */
function renderConsumers(report: GuardrailReport): string[] {
    const services = collectUniqueImpact(report);
    if (services.length === 0) return [];
    const lines: string[] = [];
    for (let s = 0; s < services.length; s++) {
        if (s > 0) lines.push('');
        const svc = services[s];
        lines.push(`  ${renderConsumerServiceHeader(svc)}`);
        for (const fn of svc.functions.slice(0, 5)) {
            lines.push(`    ${elideQualifiedName(fn.name)}`);
        }
        if (svc.functions.length > 5) {
            lines.push(`    ${ansi.dim(`+ ${svc.functions.length - 5} more`)}`);
        }
    }
    return lines;
}

/**
 * Render the header line of one consumer service entry. Handles four cases:
 *   - URL + svc name matches repo path tail  → URL only (bold path segment)
 *   - URL + svc name differs (monorepo)      → URL + dim svc suffix
 *   - no URL + svc name == repo name         → bold svc
 *   - no URL + svc name differs from repo    → dim "repo/" + bold svc
 */
function renderConsumerServiceHeader(svc: { name: string; repository: { name: string; url: string | null } | null }): string {
    const url = normalizeGitUrl(svc.repository?.url ?? null);
    const repoName = svc.repository?.name ? displayRepoName(svc.repository.name) : null;
    const repoTail = (url ?? repoName)?.split('/').pop() ?? null;
    const svcDiffersFromRepo = repoTail !== null && repoTail !== svc.name;

    if (url) {
        const display = renderRepoIdentifier(svc.repository?.name, svc.repository?.url);
        return svcDiffersFromRepo ? `${display}  ${ansi.dim(svc.name)}` : display;
    }
    if (repoName && svcDiffersFromRepo) {
        return `${ansi.dim(`${repoName}/`)}${ansi.bold(svc.name)}`;
    }
    return ansi.bold(svc.name);
}

function renderTtyBlocked(report: GuardrailReport): string {
    const lines: string[] = [];
    lines.push('');
    lines.push(renderHeaderStrip(report));
    lines.push('');
    lines.push(`${ansi.red('×')} ${ansi.red(ansi.bold('breaking'))}`);
    lines.push('');

    for (const v of buildVerdictLines(report)) {
        lines.push(`  ${v}`);
    }
    lines.push('');

    const dangers = report.findings.filter(f => f.severity === 'DANGER');
    for (let i = 0; i < dangers.length; i++) {
        if (i > 0) lines.push('');
        lines.push(...renderFindingBody(dangers[i]));
    }
    lines.push('');

    const consumers = renderConsumers(report);
    if (consumers.length > 0) {
        lines.push(...consumers);
        lines.push('');
    }

    // WARNINGs ride along compact when they accompany a BREAKING verdict.
    const warnings = report.findings.filter(f => f.severity === 'WARNING');
    for (const w of warnings) {
        lines.push(`  ${ansi.yellow('▲')} ${w.title}`);
    }
    if (warnings.length > 0) lines.push('');

    return lines.join('\n');
}

function renderTtyWarn(report: GuardrailReport): string {
    const lines: string[] = [];
    const warnings = report.findings.filter(f => f.severity === 'WARNING');

    lines.push('');
    lines.push(renderHeaderStrip(report));
    lines.push('');
    lines.push(`${ansi.yellow('▲')} ${ansi.yellow(ansi.bold('watch'))}`);
    lines.push('');
    lines.push(`  no downstream breaks`);
    lines.push(`  ${plural(warnings.length, 'signal')} to review`);
    lines.push('');

    for (const w of warnings) {
        lines.push(`  ${w.title}`);
    }
    lines.push('');

    return lines.join('\n');
}

function renderTtyPass(report: GuardrailReport): string {
    const lines: string[] = [];
    const fileCount = report.changedFiles.length;
    const summary = fileCount > 0
        ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}, no architectural impact`
        : 'no architectural impact';

    lines.push('');
    lines.push(renderHeaderStrip(report));
    lines.push('');
    lines.push(`${ansi.green('✓')} ${ansi.green(ansi.bold('safe'))}  ${ansi.dim(summary)}`);
    lines.push('');

    return lines.join('\n');
}

export function renderTty(report: GuardrailReport, opts: { verbose?: boolean; resolveFilePath?: ReportGeneratorOptions['resolveFilePath'] } = {}): string {
    // Verbose mode is a Phase B affordance; for now `--verbose` just shows
    // the same press-release layout (the gain is in the `--json` schema,
    // not in repainting the TTY twice).
    void opts;
    if (report.summary.danger > 0) return renderTtyBlocked(report);
    if (report.summary.warning > 0) return renderTtyWarn(report);
    return renderTtyPass(report);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type ReportFormat = 'markdown' | 'json' | 'auto';

export interface ReportGeneratorOptions {
    format?: ReportFormat;
    /** Re-include header info dropped in the default tight layout (Repo path, Baseline). */
    verbose?: boolean;
    /**
     * Optional: resolves a (serviceRepoName, relativeFile) pair to an absolute
     * path so the TTY render can show cmd-clickable paths. Returns null when
     * the repo can't be located locally; callers fall back to the relative
     * path. Built by the CLI via `makeFilePathResolver` (see file-path-resolver.ts).
     */
    resolveFilePath?: (serviceRepoName: string | null, relativeFile: string) => string | null;
}

/**
 * Serialize a GuardrailReport to a string.
 *
 * Format selection:
 *   - 'json': Machine-readable JSON.
 *   - 'markdown': GitHub/GitLab-flavored Markdown (for PR comments).
 *   - 'auto' (default): Markdown, but with ANSI colors if stdout is a TTY.
 */
export function renderReport(report: GuardrailReport, opts: ReportGeneratorOptions = {}): string {
    const format = opts.format ?? 'auto';

    if (format === 'json') {
        return JSON.stringify(report, null, 2);
    }

    if (format === 'auto' && IS_TTY) {
        return renderTty(report, { verbose: opts.verbose, resolveFilePath: opts.resolveFilePath });
    }

    return renderMarkdown(report, { verbose: opts.verbose, resolveFilePath: opts.resolveFilePath });
}

/**
 * Build the final GuardrailReport from findings + metadata.
 */
export function buildReport(params: {
    prRef: string;
    repository?: GuardrailReport['repository'];
    comparison?: GuardrailReport['comparison'];
    baseline?: GuardrailReport['baseline'];
    changedFiles: string[];
    findings: import('./types.js').GuardrailFinding[];
    blastRadiusScore: number;
    durationMs: number;
    tokensUsed?: GuardrailReport['tokensUsed'];
}): GuardrailReport {
    const { prRef, repository, comparison, baseline, changedFiles, findings, blastRadiusScore, durationMs, tokensUsed } = params;

    const danger = findings.filter(f => f.severity === 'DANGER').length;
    const warning = findings.filter(f => f.severity === 'WARNING').length;
    const info = findings.filter(f => f.severity === 'INFO').length;

    const partial: GuardrailReport = {
        prRef,
        ...(repository ? { repository } : {}),
        ...(comparison ? { comparison } : {}),
        ...(baseline ? { baseline } : {}),
        changedFiles,
        findings,
        summary: {
            danger,
            warning,
            info,
            blastRadiusScore,
            blastCounts: { services: 0, functions: 0 },
            confidence: { level: 'HIGH', reason: 'no baseline metadata' },
        },
        generatedAt: new Date().toISOString(),
        durationMs,
        ...(tokensUsed ? { tokensUsed } : {}),
    };

    partial.summary.blastCounts = getBlastCounts(partial);
    partial.summary.confidence = getConfidence(partial);

    return partial;
}
