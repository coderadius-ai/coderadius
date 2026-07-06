/**
 * Shared registry for `kind: graphql-client` decorators declared in
 * `coderadius.yaml`. Language plugins (PHP, TypeScript, …) consult this
 * registry at critical-invocation / static-supplement extraction time and,
 * on match, emit a `ClientBinding{protocol:'graphql', clientKind:'sdk'}`
 * deterministically — replacing the LLM matchmaker fallback for opaque SDK
 * wrappers like `OrdersClient::post(token, query, variables)`.
 *
 * The registry is intentionally language-agnostic. The PHP plugin compares
 * the configured class name against PHP receiver FQCNs; the TS plugin will
 * do the same with module-qualified names. Both sides canonicalise `\\`,
 * `\` and `/` to a single backslash before comparison.
 */

export interface GraphQLClientDecorator {
    /** Canonicalised class name with `\` separators (no leading `\`). */
    className: string;
    /** Method name (case-sensitive — methods on real classes are case-sensitive in PHP/TS). */
    methodName: string;
    /** Parameter name carrying the GraphQL operation document. */
    queryArg: string;
    /** Parameter name carrying the variables map. */
    variablesArg: string;
}

const REGISTRY = new Map<string, GraphQLClientDecorator>();

/**
 * Canonicalise a path/namespace separator string: `My\\NS\\Cls` and
 * `My/NS/Cls` and `My\NS\Cls` all become `My\NS\Cls`. Leading separators
 * are stripped. Trailing separators trimmed.
 */
export function canonicaliseClassRef(raw: string): string {
    if (!raw) return '';
    let s = raw.replace(/\//g, '\\');
    // Collapse runs of backslashes (covers escape ambiguity from YAML/JSON)
    s = s.replace(/\\+/g, '\\');
    // Strip leading and trailing separators
    s = s.replace(/^\\+|\\+$/g, '');
    return s;
}

/**
 * Parse a decorator `name` of the form `<ClassRef>::<method>` into its
 * canonical components. Returns null if the name is not in the expected
 * shape.
 */
export function parseGraphQLClientName(name: string): { className: string; methodName: string } | null {
    if (!name) return null;
    const idx = name.lastIndexOf('::');
    if (idx <= 0 || idx >= name.length - 2) return null;
    const className = canonicaliseClassRef(name.slice(0, idx));
    const methodName = name.slice(idx + 2).trim();
    if (!className || !methodName) return null;
    return { className, methodName };
}

/**
 * Register a graphql-client decorator from coderadius.yaml. The `args`
 * array carries the parameter names for [queryArg, variablesArg]. Defaults
 * to `['query', 'variables']` if absent. Idempotent on identical entries.
 */
export function registerGraphQLClientDecorator(name: string, args: string[] = ['query', 'variables']): void {
    const parsed = parseGraphQLClientName(name);
    if (!parsed) return;
    const queryArg = args[0] ?? 'query';
    const variablesArg = args[1] ?? 'variables';
    const key = `${parsed.className}::${parsed.methodName}`.toLowerCase();
    REGISTRY.set(key, {
        className: parsed.className,
        methodName: parsed.methodName,
        queryArg,
        variablesArg,
    });
}

export function clearGraphQLClientDecorators(): void {
    REGISTRY.clear();
}

/**
 * Look up a decorator entry by (resolved class FQCN, method name). The
 * receiver may be a fully-qualified class (`AcmeShop\Inventory\OrdersClient`) or
 * a short class name visible via `use` statements (`OrdersClient`). The
 * registry matches when the configured className is either:
 *   - exactly equal (case-insensitive) to the receiver, OR
 *   - a suffix of the receiver after canonicalisation (so a configured
 *     `My\NS\Cls` matches a receiver `Vendor\My\NS\Cls`), OR
 *   - the configured value is a bare classname and equals the receiver's
 *     last segment (so `OrdersClient` matches `Foo\Bar\OrdersClient`).
 */
export function matchGraphQLClientDecorator(
    receiverClass: string | null | undefined,
    methodName: string,
): GraphQLClientDecorator | null {
    if (!receiverClass || !methodName) return null;
    if (REGISTRY.size === 0) return null;
    const recv = canonicaliseClassRef(receiverClass).toLowerCase();
    const recvLast = recv.split('\\').pop() ?? recv;
    const method = methodName;

    for (const dec of REGISTRY.values()) {
        if (dec.methodName !== method) continue;
        const cfg = dec.className.toLowerCase();
        if (cfg === recv) return dec;
        // Configured FQCN is a suffix of receiver (vendor-prefixed namespaces)
        if (recv.endsWith('\\' + cfg)) return dec;
        // Configured bare classname matches receiver's last segment
        if (!cfg.includes('\\') && cfg === recvLast) return dec;
    }
    return null;
}

/**
 * Class-only membership check: is `receiverClass` itself a registered
 * graphql-client wrapper class (any method)? Used by static-supplement
 * extractors to suppress ClientBinding emission from *inside* the wrapper's
 * own method bodies — the wrapper IS the SDK boundary, so its internal HTTP
 * plumbing (e.g. PSR-18 calls) is an implementation detail, not a separate
 * outbound dependency. Same matching rules as `matchGraphQLClientDecorator`
 * minus the method-name constraint.
 */
export function isRegisteredGraphQLClientClass(receiverClass: string | null | undefined): boolean {
    if (!receiverClass || REGISTRY.size === 0) return false;
    const recv = canonicaliseClassRef(receiverClass).toLowerCase();
    const recvLast = recv.split('\\').pop() ?? recv;
    for (const dec of REGISTRY.values()) {
        const cfg = dec.className.toLowerCase();
        if (cfg === recv) return true;
        if (recv.endsWith('\\' + cfg)) return true;
        if (!cfg.includes('\\') && cfg === recvLast) return true;
    }
    return false;
}

/**
 * Public read-only view of registered decorators. Useful for diagnostics
 * and tests.
 */
export function listGraphQLClientDecorators(): readonly GraphQLClientDecorator[] {
    return [...REGISTRY.values()];
}
