/**
 * TypeScript DI-token injection recognition.
 *
 * Used by `buildClientBindingContext` to decide whether a deterministically
 * resolved client binding (registered via the static-supplements path) is
 * actually injected into the analyzed unit's constructor.
 *
 * TypeScript convention: NestJS / Angular-style `@Inject(<token>)` parameter
 * decorator. Tokens are typically opaque DI symbols (`CLIENT$TOKEN`) or
 * provider classes; the regex accepts whatever string was registered.
 */

const TOKEN_RE_CACHE = new Map<string, RegExp>();

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenRegex(token: string): RegExp {
    let cached = TOKEN_RE_CACHE.get(token);
    if (!cached) {
        cached = new RegExp(`@Inject\\(\\s*${escapeRegex(token)}\\s*\\)`);
        TOKEN_RE_CACHE.set(token, cached);
    }
    return cached;
}

export function typescriptRecognizesInjectedToken(
    token: string,
    constructorSource: string,
    _classProperties: readonly string[],
): boolean {
    if (!token || !constructorSource) return false;
    return tokenRegex(token).test(constructorSource);
}
