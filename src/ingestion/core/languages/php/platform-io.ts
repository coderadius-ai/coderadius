/**
 * PHP platform-local I/O builtins (`error_log()`, `syslog()`, `openlog()`)
 * write to the local logging facility, never to a broker. The LLM
 * occasionally extracts them as MessageChannel names; the sanitizer drops
 * them via the `LanguagePlugin.recognizesPlatformIoBuiltin` hook.
 *
 * Source-evidence required (memory rule: no name-only blocklist): the
 * builtin must appear as a CALL after stripping string literals and
 * comments, so a `// error_log()` inside a comment or string cannot mask —
 * nor fake — a real call. PHP builtins are case-insensitive.
 */

const PLATFORM_LOG_BUILTIN_RE = /^(?:error_log|syslog|openlog)$/i;
const PLATFORM_LOG_CALL_RE = /\b(?:error_log|syslog|openlog)\s*\(/i;

/**
 * Minimal lexical scanner that masks PHP string literals and comments
 * (`//`, `/* … *​/`, `#`) with whitespace so source-evidence guards cannot
 * be spoofed by a call-looking fragment inside a literal.
 * Out of scope: heredoc/nowdoc (`<<<EOT … EOT;`), nested PHP-in-HTML.
 * Offsets are preserved (chars replaced by spaces / kept newlines) so regex
 * position-based reasoning still works on the cleaned output.
 */
export function stripPhpStringsAndComments(src: string): string {
    let out = '';
    let i = 0;
    let inSingle = false, inDouble = false;
    let inLineComment = false, inBlockComment = false;
    while (i < src.length) {
        const c = src[i], next = src[i + 1];
        if (inLineComment) {
            if (c === '\n') { out += '\n'; inLineComment = false; }
            else out += ' ';
            i++; continue;
        }
        if (inBlockComment) {
            if (c === '*' && next === '/') { out += '  '; i += 2; inBlockComment = false; continue; }
            out += (c === '\n' ? '\n' : ' '); i++; continue;
        }
        if (inSingle) {
            if (c === '\\' && next !== undefined) { out += '  '; i += 2; continue; }
            if (c === "'") { out += "'"; inSingle = false; i++; continue; }
            out += (c === '\n' ? '\n' : ' '); i++; continue;
        }
        if (inDouble) {
            if (c === '\\' && next !== undefined) { out += '  '; i += 2; continue; }
            if (c === '"') { out += '"'; inDouble = false; i++; continue; }
            out += (c === '\n' ? '\n' : ' '); i++; continue;
        }
        if (c === '/' && next === '/') { inLineComment = true; out += '  '; i += 2; continue; }
        if (c === '/' && next === '*') { inBlockComment = true; out += '  '; i += 2; continue; }
        // PHP supports `#` line comments (in addition to `//` and `/* */`).
        if (c === '#') { inLineComment = true; out += ' '; i++; continue; }
        if (c === "'") { inSingle = true; out += "'"; i++; continue; }
        if (c === '"') { inDouble = true; out += '"'; i++; continue; }
        out += c; i++;
    }
    return out;
}

export function phpRecognizesPlatformIoBuiltin(name: string, sourceCode: string): boolean {
    if (!PLATFORM_LOG_BUILTIN_RE.test(name)) return false;
    return PLATFORM_LOG_CALL_RE.test(stripPhpStringsAndComments(sourceCode));
}
