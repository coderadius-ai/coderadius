import { defineConfig, mergeConfig, configDefaults } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';
import evalConfig from './vitest.eval.config';

/**
 * Deterministic Pattern Configuration
 *
 * Runs ONLY the deterministic eval/patterns (full static pipeline, zero LLM,
 * zero DB) so they can join the fast, hermetic `make test` suite. Pattern files
 * that import the LLM replay machinery (`with-replay` / `llm-replay-cache`) are
 * excluded dynamically — they need a complete committed `.llm-cache` to replay
 * and otherwise hard-fail on cache miss, so they remain in `test-eval-golden`.
 *
 * Self-maintaining: a new LLM-dependent pattern that imports the replay helper
 * is auto-excluded; a new pure-static pattern is auto-included. No per-file tags.
 */
const PATTERNS_DIR = path.resolve(process.cwd(), 'tests/eval/patterns');
// An eval test is LLM-dependent if it imports the replay machinery OR calls the
// LLM analyzer directly. A single directory may hold BOTH a deterministic and an
// LLM test file (e.g. php-dynamic-sql), so exclusion is per-FILE, not per-dir.
const LLM_DEP_RE = /llm-replay-cache|with-replay|unified-analyzer|analyzeFunction/;

const llmPatternExcludes: string[] = [];
function collectLlmFiles(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { collectLlmFiles(full); continue; }
        if (!entry.name.endsWith('.eval.test.ts')) continue;
        if (LLM_DEP_RE.test(fs.readFileSync(full, 'utf8'))) {
            llmPatternExcludes.push(path.relative(process.cwd(), full));
        }
    }
}
collectLlmFiles(PATTERNS_DIR);

export default mergeConfig(evalConfig, defineConfig({
    test: {
        include: ['tests/eval/patterns/**/*.eval.test.ts'],
        exclude: [...configDefaults.exclude, ...llmPatternExcludes],
    },
}));
