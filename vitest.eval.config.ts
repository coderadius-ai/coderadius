import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Eval Test Configuration
 *
 * LLM evaluation tests (golden datasets) that do NOT require a database.
 * In replay mode (default), these run in ~2s using cached LLM outputs.
 *
 * Key differences from integration config:
 *   - fileParallelism: true — no DB contention, safe to parallelize
 *   - Shorter timeout — replay mode returns instantly
 *   - Scoped to tests/eval/
 */
export default mergeConfig(baseConfig, defineConfig({
    test: {
        fileParallelism: true,
        testTimeout: 120_000,   // 2 min — covers live/refresh LLM calls
        hookTimeout: 60_000,
        include: ['tests/eval/**/*.test.ts'],
    },
}));
