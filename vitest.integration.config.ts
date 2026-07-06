import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Integration Test Configuration
 * 
 * Integration tests share a single Memgraph database instance.
 * We MUST disable fileParallelism to prevent race conditions 
 * (e.g. one test clearing the DB while another is writing).
 */
export default mergeConfig(baseConfig, defineConfig({
    test: {
        fileParallelism: false,
        testTimeout: 300_000, // LLM calls can be slow; 5 min per test
        hookTimeout: 900_000, // Full ingestion pipeline (beforeAll) needs up to 15 min in refresh mode
        // Ensure we only run integration tests with this config if requested
        include: ['tests/integration/**/*.test.ts'],
    },
}));
