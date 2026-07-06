import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        testTimeout: 300_000,  // 5 minutes — ingestion with LLM calls takes time
        hookTimeout: 300_000,
        include: ['tests/**/*.test.ts'],
        setupFiles: ['./tests/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html', 'json-summary'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'tests/**'],
        },
        server: {
            deps: {
                // Inline zod so it is bundled by vite rather than loaded as a separate
                // ESM module. This prevents the race condition where vi.mock() hoisting
                // causes zod exports to be undefined during module initialization
                // (Zod v4 uses re-export chains that are sensitive to ESM load ordering).
                inline: ['zod'],
            },
        },
    },
});

