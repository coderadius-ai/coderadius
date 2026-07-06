/**
 * Secret scrubber for raw decorator text injected into LLM prompts.
 *
 * Language-agnostic: this scrubs sensitive key/value pairs out of arbitrary
 * decorator/annotation text by key-name regex. It has no TS/PHP grammar
 * knowledge, so it lives in the agnostic core and is consumed by the framework
 * signal overlay (which any language plugin can feed). Producers in the
 * language plugins surface the raw decorator text; this core helper is the last
 * line of defence before that text reaches the LLM prompt.
 *
 * Why this exists
 * ---------------
 * The framework-signal context surfaces the raw decorator AST text (e.g.
 * `@QueueConsumer({ queueName: 'orders' })`) so that the LLM can recover the
 * channel name when a custom-wrapper decorator is not registered in
 * `coderadius.yaml`. Customer codebases occasionally hard-code credentials,
 * tokens, or other secrets directly inside decorator arguments (typical in
 * dev / staging configs that slip into production source trees, e.g.
 * `@Consumer({ queue: 'orders', password: 'dev123' })`).
 *
 * Truncation at 200 chars is not a defence — the secret may sit at the start
 * of the argument list. We sanitize **before** truncation by replacing the
 * value attached to a known-sensitive key with `[REDACTED]`.
 *
 * Scope: defence-in-depth. The customer's source code is already streamed to
 * the LLM as the code chunk, so this scrubber does not eliminate the attack
 * surface — it limits **amplification** through the framework-signal context
 * specifically.
 *
 * False positives: we scrub by **key name**, not by entropy. Innocuous names
 * like `passwordPolicy` (no `=` / `:` after the keyword) are left alone.
 */

// Sensitive keys (case-insensitive). The word boundary `\b` prevents matching
// inside longer identifiers (e.g. `passwordPolicy.minLength` does not match
// because the keyword is followed by `Policy`, not an assignment operator).
const SENSITIVE_KEYS = [
    'password', 'passwd', 'pwd',
    'secret', 'secrets',
    'token', 'tokens', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
    'apikey', 'api_key',
    'auth', 'authorization', 'bearer',
    'credential', 'credentials',
    'private_key', 'privatekey',
    'client_secret', 'clientsecret',
];

const KEY_ALTERNATION = SENSITIVE_KEYS.join('|');

// Matches `<key><sep><value>` where:
//   <key>   = one of the sensitive keys (case-insensitive, word-bounded)
//   <sep>   = optional whitespace + `:` | `=` | `=>` (TS/JS object literal /
//             assignment / arrow record / YAML-ish)
//   <value> = single- or double-quoted string, OR a non-whitespace token
//             until the next `,` `)` `}` `]` ` ` (best-effort)
const SECRET_RE = new RegExp(
    String.raw`\b(${KEY_ALTERNATION})\b(\s*(?::|=>|=)\s*)(?:` +
    String.raw`(['"\x60])([^'"\x60]*)\3` +     // quoted value
    String.raw`|([^,\s)}\]]+)` +                  // unquoted token
    String.raw`)`,
    'gi',
);

const REDACT = '[REDACTED]';

/**
 * Scrub sensitive-key/value pairs from a raw decorator text.
 *
 * Examples:
 *   `@Consumer({ queue: 'orders', password: 'abc123' })`
 *     → `@Consumer({ queue: 'orders', password: '[REDACTED]' })`
 *   `@Auth(token=Bearer xyz)`
 *     → `@Auth(token=[REDACTED] xyz)`   // token replaced; subsequent literal kept
 *   `@Inject('passwordPolicy')`
 *     → unchanged (no `:` / `=` after `password`)
 */
export function scrubDecoratorSecrets(text: string): string {
    return text.replace(SECRET_RE, (_, key: string, sep: string, _quote, _quoted, _unquoted) => {
        const isQuoted = typeof _quote === 'string';
        if (isQuoted) {
            return `${key}${sep}${_quote}${REDACT}${_quote}`;
        }
        return `${key}${sep}${REDACT}`;
    });
}
