/**
 * CLI Command: cr blast
 *
 * The main orchestrator for the Blast Evaluation Engine.
 * Implements the full In-Memory Graph Overlay pipeline:
 *
 *   1. GitDelta:         Detect changed files (git diff or explicit list)
 *   2. DbSnapshot:       Fetch current topology from master graph (READ-ONLY)
 *   3. SymbolRegistry:   Load hybrid registry (DB + re-extracted config files)
 *   4. EphemeralExtract: Run LLM on changed files WITHOUT writing to DB
 *   5. GraphDiff:        Compute topological delta in RAM (<1ms)
 *   6. BlastRadius:      Query master graph for downstream impact (READ-ONLY)
 *   7. Report:           Render Markdown/JSON to stdout or file
 *
 * UX Philosophy (Terraform Plan model):
 *   - When running on a TTY (developer locally): colored terminal output
 *   - When piped/redirected (CI): clean Markdown for `gh pr comment` injection
 *   - Exit code 1 on DANGER findings (blocks CI), 0 otherwise
 *   - Use --advisory to always exit 0 (advisory mode)
 */

import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { logger } from '../../../utils/logger.js';
import { buildReport, renderReport, type ReportFormat } from '../../../eval/report-generator.js';
import type { GuardrailReportBaseline } from '../../../eval/types.js';
import {
    evaluateBaselineGate,
    shouldRunGitFallback,
} from '../../../eval/baseline-gate.js';







export interface BlastPositional {
    repoPath?: string;
    headRef?: string;
}

/**
 * `cr blast <target>`: an existing directory is the repo to analyze;
 * anything else that resolves as a git ref becomes the head of the
 * comparison, so `cr blast feature/checkout` reads naturally (git-style
 * guessing, like `git checkout <thing>`). Unresolvable values fall
 * through as a path so the existing not-found error names them.
 */
export function classifyBlastPositional(
    arg: string | undefined,
    isDirectory: (p: string) => boolean,
    isGitRef: (ref: string) => boolean,
): BlastPositional {
    if (!arg) return {};
    if (isDirectory(arg)) return { repoPath: arg };
    if (isGitRef(arg)) return { headRef: arg };
    return { repoPath: arg };
}

function isGitCommitRef(ref: string, cwd: string): boolean {
    try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
            cwd,
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

export function registerEvaluateBlastCommand(evaluate: Command): void {
    evaluate
        .command('blast [target]')
        .description('Predict blast radius of code changes. TARGET is a repo path, or a git branch/ref to use as --head')
        .option('--base <ref>', 'Target Git reference for the baseline topology', 'origin/main')
        .option('--head <ref>', 'Source Git reference containing the proposed changes', 'HEAD')
        .option('--files <paths>', 'Bypass source control to analyze an explicit, comma-separated list of files')
        .option('--repo-name <name>', 'Canonical identifier for the repository within the global graph')
        .option('-m, --intent <text>', 'Semantic context declaring the purpose of the mutation (enhances analysis precision)')
        .option('--output <file>', 'Direct structured output to a specified file path')
        .option('--format <fmt>', "Serialization format: 'auto' (tty-aware), 'markdown', or 'json'", 'auto')
        .option('--advisory', 'Execute in non-blocking mode (forces exit sequence 0 regardless of severity)')
        .option('--allow-unknown-baseline', 'Proceed even if the repository is absent from the master graph (confidence will be LOW, cost will be high)')
        .option('--verbose', 'Emit extended execution traces for the resolution pipeline')
        .action(async (target: string | undefined, opts: {
            base: string;
            head: string;
            files?: string;
            repoName?: string;
            intent?: string;
            output?: string;
            format: string;
            advisory?: boolean;
            allowUnknownBaseline?: boolean;
            verbose?: boolean;
        }, cmd: Command) => {
            const positional = classifyBlastPositional(
                target,
                p => fs.existsSync(p) && fs.statSync(p).isDirectory(),
                ref => isGitCommitRef(ref, process.cwd()),
            );
            if (positional.headRef) {
                if (cmd.getOptionValueSource('head') === 'cli') {
                    console.error(`[cr blast] Ambiguous: both a ref target ("${target}") and --head ("${opts.head}") were given. Use one.`);
                    process.exit(1);
                }
                opts.head = positional.headRef;
            }
            const repoPath = positional.repoPath;
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            const { configManager } = await import('../../../config/index.js');
            const { computeGitDelta } = await import('../../../eval/git-delta.js');
            const { fetchDbSnapshot } = await import('../../../eval/db-snapshot.js');
            const { loadHybridRegistry } = await import('../../../eval/symbol-registry-loader.js');
            const { extractEphemeralTopology } = await import('../../../eval/ephemeral-extractor.js');
            const { diffTopologySnapshots, isDeltaEmpty } = await import('../../../eval/graph-differ.js');
            const { resolveBlastRadius } = await import('../../../eval/blast-radius-resolver.js');
            const { buildReport, renderReport } = await import('../../../eval/report-generator.js');
            const { resolveLocalRepoOrg } = await import('../../../ingestion/core/source-resolver.js');
            const startMs = performance.now();

            if (opts.verbose) {
                process.env.LOG_LEVEL = 'debug';
            }

            // The new TTY layout (press-release model) opens directly with
            // the verdict line; no chatty pre-work banner. JSON / file output
            // is unaffected. The LLM run summary still prints inline below,
            // grouped with the work that produced it.
            const headlessOutput = opts.format === 'json' || !!opts.output;

            // ── Setup ───────────────────────────────────────────────────────
            const repoRoot = path.resolve(repoPath ?? process.cwd());
            const baseName = path.basename(repoRoot);
            const org = resolveLocalRepoOrg(repoRoot);
            const fallbackRepoName = opts.repoName ?? `${org ?? 'local'}/${baseName}`;
            const repoUrl = resolveRepoRemoteUrl(repoRoot);
            let qualifiedRepoName = fallbackRepoName;
            const prRef = opts.intent ?? `${opts.base}...${opts.head}`;
            let reportRepository = {
                name: qualifiedRepoName,
                path: repoRoot,
                url: repoUrl,
            };
            const reportComparison = {
                ref: `${opts.base}...${opts.head}`,
                baseRef: opts.base,
                headRef: opts.head,
            };

            if (!fs.existsSync(repoRoot)) {
                console.error(`[cr blast] Repository path not found: ${repoRoot}`);
                process.exit(1);
            }

            // ── Step 1: Git Delta ────────────────────────────────────────────
            let changedFiles: string[];
            try {
                if (opts.verbose) logger.debug('[Step 1/6] Computing git delta...');
                const delta = await computeGitDelta({
                    base: opts.base,
                    head: opts.head,
                    explicitFiles: opts.files,
                    repoRoot,
                });
                changedFiles = delta.changedFiles;

                if (changedFiles.length === 0) {
                    const msg = `No changed files detected between ${delta.base}...${delta.head}. ${delta.filteredCount > 0 ? `(${delta.filteredCount} file(s) excluded by .crignore)` : ''}`;
                    renderAndOutput('', opts, buildReport({
                        prRef,
                        repository: reportRepository,
                        comparison: reportComparison,
                        changedFiles: [],
                        findings: [],
                        blastRadiusScore: 0,
                        durationMs: performance.now() - startMs,
                    }));
                    await closeNeo4j();
                    process.exit(0);
                }

                if (opts.verbose) {
                    logger.debug(`[Step 1/6] ${changedFiles.length} changed file(s): ${changedFiles.join(', ')}`);
                }
            } catch (err) {
                console.error(`[cr blast] Git delta failed: ${(err as Error).message}`);
                process.exit(1);
            }

            if (!opts.repoName) {
                const graphRepoName = await resolveGraphRepoNameFromFiles(repoRoot, changedFiles);
                if (graphRepoName) {
                    qualifiedRepoName = graphRepoName;
                    reportRepository = { name: qualifiedRepoName, path: repoRoot, url: repoUrl };
                    if (opts.verbose) {
                        logger.debug(`[Setup] Resolved repository identity from graph: ${qualifiedRepoName}`);
                    }
                }
            }

            // ── Step 2: DB Snapshot ──────────────────────────────────────────
            try {
                if (opts.verbose) logger.debug('[Step 2/6] Fetching topology from master graph...');
                const { snapshots: currentSnapshots, knownFiles, unknownFiles } = await fetchDbSnapshot(changedFiles);
                let baseline: GuardrailReportBaseline = {
                    source: 'graph',
                    knownFiles,
                    unknownFiles,
                };

                if (opts.verbose) {
                    logger.debug(`[Step 2/6] DB snapshot: ${knownFiles.length} known, ${unknownFiles.length} new file(s)`);
                }

                // ── Step 2a: Pre-flight baseline-existence gate ──────────────
                const gateResult = evaluateBaselineGate({
                    knownFiles,
                    allowUnknownBaseline: opts.allowUnknownBaseline ?? false,
                    qualifiedRepoName,
                    repoRoot,
                });
                if (!gateResult.proceed) {
                    console.error(gateResult.message);
                    await closeNeo4j();
                    process.exit(gateResult.exitCode);
                }
                if (gateResult.warning) {
                    logger.warn(gateResult.warning);
                }

                // ── Step 3: Hybrid SymbolRegistry ────────────────────────────
                if (opts.verbose) logger.debug('[Step 3/6] Loading hybrid symbol registry...');
                const symbolRegistry = await loadHybridRegistry({
                    repoName: qualifiedRepoName,
                    repoRoot,
                    changedFiles,
                });

                if (shouldRunGitFallback({
                    knownFilesCount: knownFiles.length,
                    unknownFilesCount: unknownFiles.length,
                    hasFilesFlag: !!opts.files,
                })) {
                    const baseContents = loadGitBaseFileContents(repoRoot, opts.base, unknownFiles);
                    if (baseContents.size > 0) {
                        if (opts.verbose) {
                            logger.debug(`[Step 2/6] Git baseline fallback: ${baseContents.size} file(s) recovered from ${opts.base}`);
                        }

                        const baseTopology = await extractEphemeralTopology({
                            repoRoot,
                            repoName: qualifiedRepoName,
                            changedFiles: [...baseContents.keys()],
                            fileContents: baseContents,
                            symbolRegistry,
                            verbose: opts.verbose,
                        });

                        for (const [filePath, snapshot] of baseTopology.snapshots) {
                            currentSnapshots.set(filePath, snapshot);
                        }

                        const gitFallbackFiles = [...baseContents.keys()];
                        baseline = {
                            source: 'graph+git',
                            knownFiles: [...new Set([...knownFiles, ...gitFallbackFiles])],
                            gitFallbackFiles,
                            unknownFiles: unknownFiles.filter(file => !baseContents.has(file)),
                        };
                    }
                }

                // ── Step 4: Ephemeral LLM Extraction ─────────────────────────
                // Mono-line phase widget: "Analyzing N changed files via LLM..." is
                // printed without newline; when extraction returns we \r-overwrite
                // the same line with the completion summary.
                if (opts.verbose) logger.debug('[Step 4/6] Running ephemeral extraction (LLM)...');

                const isTty = process.stdout.isTTY ?? false;
                const fileNoun = changedFiles.length === 1 ? 'changed file' : 'changed files';
                const dimAnsi = (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s);
                if (!headlessOutput && isTty) {
                    process.stdout.write(dimAnsi(`  Analyzing ${changedFiles.length} ${fileNoun} via LLM...`));
                }

                const llmStartMs = performance.now();
                let llmResult: Awaited<ReturnType<typeof extractEphemeralTopology>>;
                try {
                    llmResult = await extractEphemeralTopology({
                        repoRoot,
                        repoName: qualifiedRepoName,
                        changedFiles,
                        symbolRegistry,
                        verbose: opts.verbose,
                    });
                } catch (err) {
                    if (!headlessOutput && isTty) process.stdout.write('\r\x1b[K');
                    throw err;
                }
                const { snapshots: proposedSnapshots, skippedFiles, tokensUsed } = llmResult;
                const llmDurationMs = performance.now() - llmStartMs;

                if (!headlessOutput) {
                    const { formatLlmSummary } = await import('../../../eval/report-generator.js');
                    const summary = formatLlmSummary({ durationMs: llmDurationMs, tokensUsed });
                    const text = `Analyzed ${changedFiles.length} ${fileNoun} via LLM${summary ? ` ${summary}` : ''}`;
                    if (isTty) {
                        process.stdout.write(`\r\x1b[K${dimAnsi('  ' + text)}\n`);
                    } else {
                        console.log(`  ${text}`);
                    }
                }

                if (opts.verbose) {
                    logger.debug(
                        `[Step 4/6] Extraction complete. Tokens: ${tokensUsed.in}in (${tokensUsed.cached}c)/${tokensUsed.out}out. ` +
                        `Skipped: ${skippedFiles.join(', ') || 'none'}`
                    );
                }

                // ── Step 5: Graph Diff ────────────────────────────────────────
                if (opts.verbose) logger.debug('[Step 5/6] Computing graph delta...');
                const delta = diffTopologySnapshots(currentSnapshots, proposedSnapshots, changedFiles);

                if (opts.verbose) {
                    logger.debug(
                        `[Step 5/6] Delta: +${delta.addedEdges.length} edges, ` +
                        `-${delta.removedEdges.length} edges, ` +
                        `+${delta.addedNodes.length} nodes, ` +
                        `-${delta.removedNodes.length} nodes`
                    );
                }

                // ── Step 6: Blast Radius ──────────────────────────────────────
                if (opts.verbose) logger.debug('[Step 6/6] Resolving blast radius...');

                let findings: any[] = [];
                let blastRadiusScore = 0;

                if (!isDeltaEmpty(delta)) {
                    const resolution = await resolveBlastRadius(delta);
                    findings = resolution.findings;
                    blastRadiusScore = resolution.blastRadiusScore;
                }

                const durationMs = performance.now() - startMs;

                // ── Build and render report ───────────────────────────────────
                const report = buildReport({
                    prRef,
                    repository: reportRepository,
                    comparison: reportComparison,
                    baseline,
                    changedFiles,
                    findings,
                    blastRadiusScore,
                    durationMs,
                    tokensUsed,
                });
                renderAndOutput(opts.output ?? '', opts, report);

                await closeNeo4j();

                // ── Exit code logic ───────────────────────────────────────────
                // Semantic codes so CI / agents can branch without parsing
                // the rendered text:
                //   0 = PASS         (no breaks, no signals)
                //   1 = WARN         (no breaks, at least one warning to triage)
                //   2 = BLOCK        (at least one downstream consumer will break)
                // `--advisory` forces 0 regardless (legacy override kept for the
                // teams that opted into "report-only" gates).
                process.exit(computeBlastExitCode(report.summary, opts));

            } catch (err) {
                console.error(`[cr blast] Analysis failed: ${(err as Error).message}`);
                if (opts.verbose) console.error((err as Error).stack);
                await closeNeo4j();
                process.exit(2);
            }
        });
}

// ─── Output helpers ──────────────────────────────────────────────────────────

/**
 * Compute the process exit code from a report summary + CLI options.
 * Exposed for unit testing so the policy can evolve without spawning the
 * full CLI in tests.
 *
 *   0  PASS  no breaks, no warnings
 *   1  WARN  no breaks, at least one warning to triage
 *   2  BLOCK at least one downstream consumer will break
 *
 * `--advisory` forces 0 regardless (legacy override).
 */
export function computeBlastExitCode(
    summary: { danger: number; warning: number },
    opts: { advisory?: boolean },
): 0 | 1 | 2 {
    if (opts.advisory) return 0;
    if (summary.danger > 0) return 2;
    if (summary.warning > 0) return 1;
    return 0;
}

/**
 * Resolve the `origin` remote URL of the local git repo at `repoRoot`.
 * Returns null when the repo has no remote, when git is unavailable, or
 * when the path is not a git working tree. The renderer surfaces this URL
 * in the header strip so the reader can click through to the codebase.
 */
export function resolveRepoRemoteUrl(repoRoot: string): string | null {
    try {
        const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
            cwd: repoRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return url.length > 0 ? url : null;
    } catch {
        return null;
    }
}

function renderAndOutput(outputFile: string, opts: { format: string; verbose?: boolean }, report: ReturnType<typeof buildReport>): void {
    const format = opts.format as ReportFormat;
    // Resolver builds Git-web URLs (GitHub/GitLab/Bitbucket) from
    // service.repository.url when present. When absent, callers fall back to
    // the relative path. Never produces absolute local paths.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { makeFilePathResolver } = require('../../../eval/file-path-resolver.js') as typeof import('../../../eval/file-path-resolver.js');
    const resolveFilePath = makeFilePathResolver();
    const rendered = renderReport(report, { format, verbose: opts.verbose, resolveFilePath });

    if (outputFile) {
        fs.writeFileSync(path.resolve(outputFile), rendered, 'utf-8');
        console.log(`[cr blast] Report written to: ${outputFile}`);
    } else {
        process.stdout.write(rendered + '\n');
    }
}

function loadGitBaseFileContents(repoRoot: string, baseRef: string, files: string[]): Map<string, string> {
    const contents = new Map<string, string>();

    for (const file of files) {
        try {
            const content = execFileSync('git', ['show', `${baseRef}:${file}`], {
                cwd: repoRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            contents.set(file, content);
        } catch {
            // File may be genuinely new at HEAD. Leave it unknown.
        }
    }

    return contents;
}

async function resolveGraphRepoNameFromFiles(repoRoot: string, changedFiles: string[]): Promise<string | null> {
    if (changedFiles.length === 0) return null;

    const { getMemgraphSession } = await import('../../../graph/neo4j.js');
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `
            UNWIND $files AS filePath
            MATCH (sf:SourceFile {path: filePath})
            WHERE sf.valid_to_commit IS NULL
              AND sf.id STARTS WITH 'cr:sourcefile:'
            RETURN sf.id AS id, filePath
            `,
            { files: changedFiles },
        );

        const counts = new Map<string, number>();
        for (const record of result.records) {
            const id = record.get('id') as string;
            const filePath = record.get('filePath') as string;
            const repoName = extractRepoNameFromSourceFileUrn(id, filePath);
            if (!repoName) continue;
            counts.set(repoName, (counts.get(repoName) ?? 0) + 1);
        }

        if (counts.size === 0) return null;

        const repoStem = path.basename(repoRoot).toLowerCase();
        return [...counts.entries()]
            .sort(([a, aCount], [b, bCount]) => {
                const aScore = aCount * 10 + (repoNameStem(a) === repoStem ? 1 : 0);
                const bScore = bCount * 10 + (repoNameStem(b) === repoStem ? 1 : 0);
                return bScore - aScore || a.localeCompare(b);
            })[0]?.[0] ?? null;
    } catch (err) {
        logger.debug(`[Setup] Failed to resolve repository identity from graph: ${(err as Error).message}`);
        return null;
    } finally {
        await session.close();
    }
}

function extractRepoNameFromSourceFileUrn(urn: string, filePath: string): string | null {
    const prefix = 'cr:sourcefile:';
    const suffix = `:${filePath}`;
    if (!urn.startsWith(prefix) || !urn.endsWith(suffix)) return null;
    return urn.slice(prefix.length, urn.length - suffix.length);
}

function repoNameStem(repoName: string): string {
    return repoName.split('/').at(-1)?.toLowerCase() ?? repoName.toLowerCase();
}
