import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import boxen from 'boxen';
import chalk from 'chalk';
import { logger } from '../../../utils/logger.js';
import { printHeader } from '../../ui/logo.js';
import { configManager } from '../../../config/index.js';
import { telemetryCollector } from '../../../telemetry/index.js';
import { countByQualityTier } from '../../../graph/queries/grounding.js';

export type IngestListrRenderer = 'default' | 'simple';

export type IngestNextStep = {
    command: string;
    description: string;
};

export type IngestTraceArtifacts = {
    reportPath: string;
    rawJsonlPath?: string;
};

export function resolveIngestListrRenderer(opts: {
    verbose?: boolean;
    isLargeScan?: boolean;
}): IngestListrRenderer {
    if (opts.verbose || opts.isLargeScan) return 'simple';
    return 'default';
}

export function shouldEmitTaskOutput(_renderer: IngestListrRenderer, _verbose?: boolean): boolean {
    return true;
}

export function printIngestHeader(title: string, scope: string, targetStr: string, sessionId?: string) {
    const aiConfig = configManager.getAiConfig('ingest');
    const regionTag = aiConfig.location
        ? `  ${chalk.dim(`(${aiConfig.location})`)}`
        : '';
    const llmInfo = `${aiConfig.provider} / ${aiConfig.model}${regionTag}`;
    const embeddingInfo = `${aiConfig.embeddingModel}${regionTag}`;

    // Feed model info to telemetry for cost estimation (LLM + embedding)
    telemetryCollector.setModel(aiConfig.provider, aiConfig.model, embeddingInfo);

    const labels = [];
    if (sessionId) {
        labels.push({ label: 'Session ID', value: sessionId });
    }

    labels.push(
        { label: 'Target', value: targetStr },
        { label: 'Scope', value: scope },
        { label: 'Inference', value: llmInfo },
        { label: 'Embeddings', value: embeddingInfo }
    );

    printHeader(title);

    const labelColumnWidth = 12;
    labels.forEach(item => {
        logger.log(`   ${chalk.dim(item.label.padEnd(labelColumnWidth))} : ${chalk.cyan(item.value)}`);
    });
    logger.log('');
}

export function renderIngestCompletion(opts: {
    title: string;
    nextSteps: IngestNextStep[];
    trace?: IngestTraceArtifacts;
}): string {
    const commandWidth = Math.max(...opts.nextSteps.map(step => step.command.length));
    const lines = [
        chalk.green.bold(opts.title),
        '',
        chalk.dim('Next steps'),
        ...opts.nextSteps.map(step => {
            const command = chalk.cyan(step.command.padEnd(commandWidth));
            return `  ${command}  ${chalk.dim(step.description)}`;
        }),
    ];

    if (opts.trace) {
        const traceRows = [
            { label: 'Report', value: formatDisplayPath(opts.trace.reportPath) },
            ...(opts.trace.rawJsonlPath ? [{ label: 'JSONL', value: formatDisplayPath(opts.trace.rawJsonlPath) }] : []),
        ];
        const labelWidth = Math.max(...traceRows.map(row => row.label.length));

        lines.push(
            '',
            chalk.dim('Artifacts'),
            ...traceRows.map(row => `  ${chalk.dim(row.label.padEnd(labelWidth))}  ${chalk.underline(row.value)}`),
        );
    }

    return boxen(lines.join('\n'), {
        padding: { top: 1, bottom: 1, left: 2, right: 2 },
        margin: { top: 1, bottom: 1 },
        borderStyle: 'round',
        borderColor: 'gray',
    });
}

export async function renderGroundingBreakdown(): Promise<string | null> {
    const breakdowns = await countByQualityTier();
    const populated = breakdowns.filter(b => b.total > 0);
    if (populated.length === 0) return null;

    const tiers = ['exact', 'high', 'medium', 'low', 'speculative'] as const;
    const tierWidths = [5, 4, 6, 3, 11];
    const labelWidth = Math.max(...populated.map(b => b.label.length), 6);

    const dim = chalk.dim;
    const sep = dim(' │ ');
    const rule = dim('  ' + '─'.repeat(78));

    const header = '  '
        + dim('Entity'.padEnd(labelWidth))
        + sep
        + tiers.map((t, i) => dim(t.padStart(tierWidths[i]))).join(sep)
        + sep
        + dim('review');

    const rows = populated.map(b => {
        const cells = tiers.map((t, i) => {
            const v = b.tiers[t];
            const s = String(v).padStart(tierWidths[i]);
            return v > 0 ? chalk.cyan(s) : dim(s);
        });
        const review = b.needsReview > 0
            ? chalk.yellow(String(b.needsReview).padStart(6))
            : dim(String(0).padStart(6));
        return '  ' + chalk.cyan(b.label.padEnd(labelWidth)) + sep + cells.join(sep) + sep + review;
    });

    return [
        '',
        chalk.bold('  GROUNDING'),
        rule,
        header,
        ...rows,
    ].join('\n');
}

function formatDisplayPath(filePath: string): string {
    const home = os.homedir();
    if (filePath === home) return '~';
    if (filePath.startsWith(home + path.sep)) {
        return '~' + filePath.slice(home.length);
    }
    return filePath;
}

function readPathsFromFile(filePath: string, cwd: string): string[] {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');

    return content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
}

/**
 * Resolve source targets for ingest commands from:
 * - positional arguments
 * - --paths-file <file>
 * - "@file" pseudo-arguments inside positional paths
 *
 * Files are newline-based lists (1 target per line). Empty lines and lines
 * starting with "#" are ignored.
 */
export function resolveIngestSourcePaths(
    paths: string[] | undefined,
    opts: { pathsFile?: string } = {},
    cwd = process.cwd(),
): string[] {
    const raw = paths && paths.length > 0 ? [...paths] : [];
    const hasExplicitInput = raw.length > 0 || Boolean(opts.pathsFile);
    const out: string[] = [];

    for (const item of raw) {
        if (item.startsWith('@') && item.length > 1) {
            out.push(...readPathsFromFile(item.slice(1), cwd));
            continue;
        }
        out.push(item);
    }

    if (opts.pathsFile) {
        out.push(...readPathsFromFile(opts.pathsFile, cwd));
    }

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of out) {
        if (!seen.has(item)) {
            seen.add(item);
            deduped.push(item);
        }
    }

    if (deduped.length > 0) return deduped;
    if (hasExplicitInput) {
        throw new Error('No source targets resolved from arguments. Check --paths-file/@file contents.');
    }
    return [cwd];
}
