import { describe, it, expect } from 'vitest';
import { phpRecognizesPlatformIoBuiltin } from '../../../../../../src/ingestion/core/languages/php/platform-io.js';

// ═════════════════════════════════════════════════════════════════════════════
// PHP platform-I/O builtin recognition (plugin-owned grammar)
//
// `error_log()`, `syslog()`, `openlog()` write to the local logging facility,
// never to a broker. Source-evidence required (a real CALL after stripping
// strings/comments), no name-only blocklist. PHP builtins are
// case-insensitive. This is PHP grammar: it lives in the PHP plugin, the
// sanitizer consumes it via the LanguagePlugin hook.
// ═════════════════════════════════════════════════════════════════════════════

describe('phpRecognizesPlatformIoBuiltin', () => {
    it('recognizes a real error_log call', () => {
        expect(phpRecognizesPlatformIoBuiltin('error_log', 'error_log("hi", 0);')).toBe(true);
    });

    it('recognizes sibling builtins (syslog, openlog)', () => {
        expect(phpRecognizesPlatformIoBuiltin('syslog', 'syslog(LOG_INFO, "ok");')).toBe(true);
        expect(phpRecognizesPlatformIoBuiltin('openlog', 'openlog("id", LOG_PID, LOG_USER);')).toBe(true);
    });

    it('is case-insensitive on name and call (PHP builtin dispatch)', () => {
        expect(phpRecognizesPlatformIoBuiltin('Error_Log', 'Error_Log("hi");')).toBe(true);
    });

    it('rejects non-builtin names regardless of source', () => {
        expect(phpRecognizesPlatformIoBuiltin('acme.report.created', 'error_log("hi");')).toBe(false);
    });

    it('rejects when the source has no call (name-only is not evidence)', () => {
        expect(phpRecognizesPlatformIoBuiltin('error_log', 'doSomething();')).toBe(false);
    });

    it('is not spoofed by // line comments', () => {
        expect(phpRecognizesPlatformIoBuiltin('error_log', '// calls error_log() in some legacy path')).toBe(false);
    });

    it('is not spoofed by /* */ block comments', () => {
        expect(phpRecognizesPlatformIoBuiltin('error_log', '/* error_log("x"); */ doSomething();')).toBe(false);
    });

    it('is not spoofed by # line comments', () => {
        expect(phpRecognizesPlatformIoBuiltin('error_log', '# calls error_log() somewhere')).toBe(false);
    });

    it('is not spoofed by string literals, but a real call alongside them fires', () => {
        expect(phpRecognizesPlatformIoBuiltin(
            'error_log',
            '$msg = "see // error_log(...) for details";',
        )).toBe(false);
        expect(phpRecognizesPlatformIoBuiltin(
            'error_log',
            '$msg = "see // error_log(...) for details"; error_log("real call");',
        )).toBe(true);
    });
});
