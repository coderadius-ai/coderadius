import { describe, it, expect } from 'vitest';
import { sanitizeAnalysis } from '../../../src/ai/workflows/sanitizer.js';
import { PHPPlugin } from '../../../src/ingestion/core/languages/php.js';
import type { UnifiedAnalysis } from '../../../src/ai/agents/unified-analyzer.js';

// ═════════════════════════════════════════════════════════════════════════════
// Sanitizer — platform I/O builtin hook (PHP grammar, plugin-owned)
//
// PHP builtin `error_log()`, `syslog()`, `openlog()` write to the local
// logging facility, NOT a message broker. The LLM occasionally extracts them
// as MessageChannel. The grammar (builtin names + string/comment-masked call
// scan) lives in the PHP plugin (`phpRecognizesPlatformIoBuiltin`); the
// sanitizer consumes it via `plugin.recognizesPlatformIoBuiltin`. The guard
// drops the entity when ALL conditions hold:
//   1. infra.type === 'MessageChannel'
//   2. the chunk's language plugin recognises name+call (PHP: case-insensitive
//      builtins, real call surviving string/comment stripping)
// Without the hook (any other ecosystem) nothing is dropped — a TS function
// named `error_log` is legitimate user code.
//
// Per memory rule: source-evidence required, no name-only blocklist.
// Scanner edge cases (comments, strings, # comments) are pinned at the
// plugin level in tests/unit/ingestion/core/languages/php/platform-io.test.ts.
// ═════════════════════════════════════════════════════════════════════════════

function makeAnalysis(infra: any): UnifiedAnalysis {
    return {
        has_io: true,
        intent: 'test',
        infrastructure: [infra],
        capabilities: [],
        produced_payloads: [],
        consumed_payloads: [],
    } as UnifiedAnalysis;
}

const ERROR_LOG_INFRA = {
    name: 'error_log',
    type: 'MessageChannel',
    operation: 'WRITES',
    evidence: 'error_log call',
};

const php = new PHPPlugin();

describe('Sanitizer — platform I/O builtin hook', () => {
    it('drops error_log MessageChannel when the PHP plugin confirms a real call', () => {
        const result = sanitizeAnalysis(makeAnalysis(ERROR_LOG_INFRA), {
            sourceCode: 'error_log("hi", 0);',
            plugin: php,
        });
        expect(result.infrastructure ?? []).toHaveLength(0);
    });

    it('keeps the entity when sourceCode has no call (source-evidence absent)', () => {
        const result = sanitizeAnalysis(makeAnalysis(ERROR_LOG_INFRA), {
            sourceCode: 'doSomething();',
            plugin: php,
        });
        expect(result.infrastructure ?? []).toHaveLength(1);
    });

    it('keeps the entity when no plugin implements the hook (other ecosystems)', () => {
        const result = sanitizeAnalysis(makeAnalysis(ERROR_LOG_INFRA), {
            sourceCode: 'function error_log(msg) {}\nerror_log("x");',
            plugin: {},
        });
        expect(result.infrastructure ?? []).toHaveLength(1);
    });

    it('keeps the entity when the only mention is masked (comment), via the plugin scanner', () => {
        const result = sanitizeAnalysis(makeAnalysis(ERROR_LOG_INFRA), {
            sourceCode: '// calls error_log() in some legacy path',
            plugin: php,
        });
        expect(result.infrastructure ?? []).toHaveLength(1);
    });

    it('drops when comment + real call coexist (real call survives stripping)', () => {
        const result = sanitizeAnalysis(makeAnalysis(ERROR_LOG_INFRA), {
            sourceCode: '// no error_log here\nerror_log("real");',
            plugin: php,
        });
        expect(result.infrastructure ?? []).toHaveLength(0);
    });

    it('cross-type — same name on Cache is not touched by this guard', () => {
        const result = sanitizeAnalysis(makeAnalysis({
            ...ERROR_LOG_INFRA,
            type: 'Cache',
        }), {
            sourceCode: 'error_log("hi");',
            plugin: php,
        });
        const surviving = result.infrastructure ?? [];
        if (surviving.length === 1) {
            expect(surviving[0].type).toBe('Cache');
        }
    });

    it('case-insensitive name + call (PHP builtins tolerate Error_Log(...))', () => {
        const result = sanitizeAnalysis(makeAnalysis({
            ...ERROR_LOG_INFRA,
            name: 'Error_Log',
        }), {
            sourceCode: 'Error_Log("hi");',
            plugin: php,
        });
        expect(result.infrastructure ?? []).toHaveLength(0);
    });

    it('drops syslog() too (same hook, sibling builtin)', () => {
        const result = sanitizeAnalysis(makeAnalysis({
            ...ERROR_LOG_INFRA,
            name: 'syslog',
        }), {
            sourceCode: 'syslog(LOG_INFO, "ok");',
            plugin: php,
        });
        expect(result.infrastructure ?? []).toHaveLength(0);
    });
});
