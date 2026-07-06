/**
 * PHP DI-token injection recognition.
 *
 * Used by `buildClientBindingContext` to decide whether a deterministically
 * resolved client binding (registered via the static-supplements path) is
 * actually injected into the analyzed unit's enclosing class.
 *
 * PHP convention: type-hinted constructor parameters and class properties.
 * The pipeline pre-computes `classProperties` as `"this->propName: TypeName"`
 * lines (see `extractPhpClassPropertyAliases` in `imports.ts`); we match on
 * the type segment.
 *
 * The token registered by the static-supplements path is an FQCN like
 * `Acme\Inventory\InventoryGqlClient`. We compare the FQCN's short name
 * (last `\`-separated segment) against the property's type. The full FQCN
 * resolution already happened upstream when the binding was emitted — by
 * the time we get here, "the receiver class with that short name in this
 * class is exactly the registered one" is the right assumption. Same-short-
 * name collisions in the same class would also share semantics.
 */

function shortNameOf(fqcn: string): string {
    const idx = fqcn.lastIndexOf('\\');
    return idx >= 0 ? fqcn.slice(idx + 1) : fqcn;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function phpRecognizesInjectedToken(
    token: string,
    _constructorSource: string,
    classProperties: readonly string[],
): boolean {
    if (!token || classProperties.length === 0) return false;
    const short = shortNameOf(token);
    if (!short) return false;

    // Property line shape: "this->client: InventoryGqlClient"
    // Match the type segment after the last colon, allowing leading `\` and
    // trailing whitespace.
    const typeRe = new RegExp(`:\\s*\\\\?[A-Za-z0-9_\\\\]*?\\b${escapeRegex(short)}\\b\\s*$`);
    return classProperties.some(line => typeRe.test(line));
}
