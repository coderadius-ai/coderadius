/**
 * Shared registry for `kind: http-client` decorators declared in
 * `coderadius.yaml`. Mirrors `graphql-client-registry.ts` for opaque HTTP
 * transport wrappers whose method takes a path-suffix argument and
 * concatenates it with a base URI on the receiver class.
 *
 * Example coderadius.yaml entry:
 *
 *   decorators:
 *     - name: "Acme\\Inventory\\OrdersClient::callMethod"
 *       kind: http-client
 *       pathArgIndex: 0
 *       httpMethod: POST
 *
 * Language plugins consult this registry at critical-invocation extraction
 * time. On match, the plugin emits an `APIEndpoint` (direction=OUTBOUND)
 * deterministically with the resolved path-suffix value, bypassing the LLM
 * so opaque wrappers always produce a node even when the LLM cannot infer
 * the call shape.
 *
 * The registry is intentionally language-agnostic. Class-name canonicalisation
 * matches `graphql-client-registry`: backslashes, forward slashes and double
 * backslashes all collapse to a single `\` separator.
 */

import { canonicaliseClassRef, parseGraphQLClientName } from './graphql-client-registry.js';

export type HttpClientHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface HttpClientDecorator {
    /** Canonicalised class name with `\` separators (no leading `\`). */
    className: string;
    /** Method name. Methods on real classes are case-sensitive in PHP/TS. */
    methodName: string;
    /** Zero-based positional index of the path-suffix argument. Defaults to 0. */
    pathArgIndex: number;
    /** HTTP method to stamp on the emitted APIEndpoint. Defaults to POST. */
    httpMethod: HttpClientHttpMethod;
}

const REGISTRY = new Map<string, HttpClientDecorator>();

/**
 * Register an http-client decorator from coderadius.yaml. Idempotent on
 * identical entries. Rejects malformed names silently (callers should
 * validate via the Zod schema upstream).
 */
export function registerHttpClientDecorator(
    name: string,
    pathArgIndex: number = 0,
    httpMethod: HttpClientHttpMethod = 'POST',
): void {
    // Reuse the parser from graphql-client-registry: both decorators target
    // a `<ClassRef>::<method>` selector with the same canonicalisation rules.
    const parsed = parseGraphQLClientName(name);
    if (!parsed) return;
    const key = `${parsed.className}::${parsed.methodName}`.toLowerCase();
    REGISTRY.set(key, {
        className: parsed.className,
        methodName: parsed.methodName,
        pathArgIndex,
        httpMethod,
    });
}

export function clearHttpClientDecorators(): void {
    REGISTRY.clear();
}

/**
 * Look up a decorator entry by (resolved class FQCN, method name).
 * Matches when the configured className is one of:
 *   - exactly equal (case-insensitive) to the receiver, OR
 *   - a suffix of the receiver after canonicalisation (configured
 *     `My\NS\Cls` matches a receiver `Vendor\My\NS\Cls`), OR
 *   - the configured value is a bare classname and equals the receiver's
 *     last segment (`OrdersClient` matches `Foo\Bar\OrdersClient`).
 */
export function matchHttpClientDecorator(
    receiverClass: string | null | undefined,
    methodName: string,
): HttpClientDecorator | null {
    if (!receiverClass || !methodName) return null;
    if (REGISTRY.size === 0) return null;
    const recv = canonicaliseClassRef(receiverClass).toLowerCase();
    const recvLast = recv.split('\\').pop() ?? recv;

    for (const dec of REGISTRY.values()) {
        if (dec.methodName !== methodName) continue;
        const cfg = dec.className.toLowerCase();
        if (cfg === recv) return dec;
        if (recv.endsWith('\\' + cfg)) return dec;
        if (!cfg.includes('\\') && cfg === recvLast) return dec;
    }
    return null;
}

/**
 * Class-only membership check: is `receiverClass` itself a registered
 * http-client wrapper class (any method)? Mirrors
 * `isRegisteredGraphQLClientClass` — see that function for the rationale
 * (wrapper-implementation suppression in static-supplement extractors).
 */
export function isRegisteredHttpClientClass(receiverClass: string | null | undefined): boolean {
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

/** Public read-only view of registered decorators. Useful for diagnostics and tests. */
export function listHttpClientDecorators(): readonly HttpClientDecorator[] {
    return [...REGISTRY.values()];
}
