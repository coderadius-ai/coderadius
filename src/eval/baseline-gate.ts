// ═══════════════════════════════════════════════════════════════════════════════
// Blast Evaluation Engine: Baseline Gate
//
// Pure decision helpers for `cr blast` safety guardrails. They live in this
// module so the CLI handler (`src/cli/commands/evaluate/blast.ts`) can stay a
// thin orchestrator and the guardrail logic is unit-testable without mocking
// the runtime.
//
//   - evaluateBaselineGate: fail fast when the target repository is not in
//     the master graph, unless the user passes --allow-unknown-baseline.
//   - shouldRunGitFallback: gate the second LLM pass (git-recovered baseline).
//     Only meaningful when SOME files are in the graph but a few are missing.
//   - formatPreflightSummary: human-readable cost preview before the LLM kicks
//     in, so the developer does not mistake long-running LLM calls for a hang.
// ═══════════════════════════════════════════════════════════════════════════════

export interface BaselineGateInput {
    knownFiles: ReadonlyArray<string>;
    allowUnknownBaseline: boolean;
    qualifiedRepoName: string;
    repoRoot: string;
}

export type BaselineGateResult =
    | { proceed: true; warning?: string }
    | { proceed: false; exitCode: number; message: string };

export function evaluateBaselineGate(input: BaselineGateInput): BaselineGateResult {
    if (input.knownFiles.length > 0) {
        return { proceed: true };
    }

    if (!input.allowUnknownBaseline) {
        return {
            proceed: false,
            exitCode: 2,
            message:
                `[cr blast] Repository "${input.qualifiedRepoName}" has no baseline in the master graph.\n` +
                `            Run \`cr analyze code --repo ${input.repoRoot}\` first to build the baseline.\n` +
                `            To proceed anyway at reduced accuracy, re-run with --allow-unknown-baseline.`,
        };
    }

    return {
        proceed: true,
        warning:
            `[cr blast] Repository "${input.qualifiedRepoName}" is absent from the master graph; ` +
            `running in --allow-unknown-baseline mode. Confidence will be LOW.`,
    };
}

export interface GitFallbackGateInput {
    knownFilesCount: number;
    unknownFilesCount: number;
    hasFilesFlag: boolean;
}

export function shouldRunGitFallback(input: GitFallbackGateInput): boolean {
    if (input.hasFilesFlag) return false;
    if (input.unknownFilesCount === 0) return false;
    // The fallback is for PARTIAL gaps. When the repo is fully unsynced
    // the fallback just doubles LLM cost for no net benefit (the gate above
    // is expected to have aborted by then; this is the defense-in-depth).
    if (input.knownFilesCount === 0) return false;
    return true;
}

// ANSI dim wrapper (only applied when stdout is a TTY).
const isTty = process.stdout.isTTY ?? false;
const dim = (s: string): string => (isTty ? `\x1b[2m${s}\x1b[0m` : s);

export function formatPreflightSummary(fileCount: number): string {
    const noun = fileCount === 1 ? 'changed file' : 'changed files';
    return dim(`  Analyzing ${fileCount} ${noun} via LLM...`);
}
