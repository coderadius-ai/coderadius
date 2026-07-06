import dotenv from 'dotenv';
import { logger } from '../src/utils/logger.js';

// 1. Load .env file
const result = dotenv.config();

if (result.error) {
    console.warn('⚠️ [Vitest Setup] No .env file found. Tests will rely on existing environment variables.');
}

// NOTE: We prioritize project-local configuration (.env) over global user settings
// (~/.coderadius/config/settings.json) to ensure reproducible dev/test environments.
// If certain variables (like GOOGLE_APPLICATION_CREDENTIALS) are missing from .env
// but required by the SDK, tests may fail unless they are set in the shell.

// 2. ALWAYS force Memgraph to use the Test DB during Vitest runs to prevent wiping dev DB.
//    In CI the service container already listens on the correct port — skip the rewrite.
if (!process.env.CI && (!process.env.MEMGRAPH_URI || process.env.MEMGRAPH_URI === 'bolt://localhost:7687')) {
    process.env.MEMGRAPH_URI = 'bolt://localhost:7688';
    // Override credentials to match the test container (docker-compose.test.yml)
    process.env.MEMGRAPH_USER = 'coderadius';
    process.env.MEMGRAPH_PASSWORD = 'coderadius';
}

// 2b. Hermetic LLM surface: the sink classifier is NOT replay-wired; a
//    snapshot-key miss fires LIVE Vertex calls inside tests AND shifts the
//    taint context of downstream prompts (invalidating the unified-analyzer
//    replay caches). Force-disable for every vitest run.
process.env.CODERADIUS_SINK_CLASSIFIER_MODE ??= 'disabled';

// 3. Silence the application logger during unit tests.
//    All ⚠ warn / ✖ error lines that modules emit internally are noise during
//    test runs. Set VERBOSE_TESTS=1 to restore full output for debugging.
if (!process.env.VERBOSE_TESTS) {
    logger.setSilent(true);
}

if (process.env.VERBOSE_TESTS || process.env.CI) {
    console.log('✅ [Vitest Setup] Environment initialized from .env (if present).');
    console.log('   - GOOGLE_VERTEX_PROJECT:', process.env.GOOGLE_VERTEX_PROJECT || '(not set)');
    console.log('   - GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS || '(not set)');
}

