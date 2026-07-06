/**
 * URL normalization helpers for the global resolver URL-match welder.
 *
 * Two concerns:
 *   - canonicalizeBaseUrl: produce a stable URN-keyable representation of a
 *     base URL by lowercasing the host, stripping default ports, and removing
 *     the trailing slash.
 *   - joinBaseUrlAndPath: combine a deployment's base URL with an endpoint's
 *     relative path, handling the case where the endpoint path already
 *     incorporates the base path (avoiding `/v2/v2/orders` duplicates).
 */

export interface ParsedBaseUrl {
    scheme: string;
    host: string;
    port?: number;
    basePath?: string;
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

/**
 * Parse a base URL into its canonical components.
 *
 * Strips:
 *   - user:pass credentials
 *   - default ports (`:80` on http, `:443` on https)
 *   - trailing slashes from basePath
 *
 * Returns `null` when the input is not a valid http(s) URL.
 */
export function parseBaseUrl(raw: string): ParsedBaseUrl | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const m = /^(https?):\/\/(.+)$/i.exec(trimmed);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    let rest = m[2];
    // strip credentials
    const atIdx = rest.lastIndexOf('@');
    if (atIdx >= 0) rest = rest.slice(atIdx + 1);
    // split host[:port] / basePath
    let hostAndPort = rest;
    let basePath = '';
    const cutCandidates = ['/', '?', '#']
        .map(c => rest.indexOf(c))
        .filter(i => i >= 0);
    if (cutCandidates.length > 0) {
        const cut = Math.min(...cutCandidates);
        hostAndPort = rest.slice(0, cut);
        basePath = rest.slice(cut);
    }
    let host = hostAndPort;
    let port: number | undefined;
    const pm = /^(.+?):([0-9]{1,5})$/.exec(hostAndPort);
    if (pm) {
        host = pm[1];
        port = parseInt(pm[2], 10);
    }
    host = host.toLowerCase();
    if (!host) return null;
    // drop default port for the scheme
    if (port !== undefined && DEFAULT_PORTS[scheme] === port) port = undefined;
    // normalize basePath: strip query/fragment, drop trailing slashes (a lone '/' collapses to empty)
    const qIdx = basePath.indexOf('?');
    if (qIdx >= 0) basePath = basePath.slice(0, qIdx);
    const hIdx = basePath.indexOf('#');
    if (hIdx >= 0) basePath = basePath.slice(0, hIdx);
    while (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
    return { scheme, host, port, basePath: basePath || undefined };
}

/**
 * Canonical form of a base URL: `scheme://host[:port][basePath]`.
 *
 * Empty / invalid → returns the raw input lowercased and trimmed so the
 * caller can still use it as a key in degraded scenarios (though no welding
 * tier will match it).
 */
export function canonicalizeBaseUrl(raw: string): string {
    const parsed = parseBaseUrl(raw);
    if (!parsed) return raw.trim().toLowerCase();
    const portPart = parsed.port !== undefined ? `:${parsed.port}` : '';
    return `${parsed.scheme}://${parsed.host}${portPart}${parsed.basePath ?? ''}`;
}

/**
 * Robust base + path join.
 *
 * Handles 4 cases:
 *   1. base = 'https://a.com/v2', path = '/orders' → 'https://a.com/v2/orders'
 *   2. base = 'https://a.com/v2', path = '/v2/orders' → 'https://a.com/v2/orders'
 *      (path already includes basePath; avoid `/v2/v2/orders`)
 *   3. base = 'https://a.com', path = '/orders' → 'https://a.com/orders'
 *   4. base = 'https://a.com/', path = 'orders' → 'https://a.com/orders'
 *
 * The decision rule for case (2): if `parseBaseUrl(base).basePath` is a
 * prefix of `path`, the path already starts with the basePath and we treat
 * the path as host-absolute.
 */
export function joinBaseUrlAndPath(base: string, path: string): string {
    const parsed = parseBaseUrl(base);
    if (!parsed) {
        // Degraded: best-effort concatenation
        const baseTrim = base.replace(/\/+$/, '');
        const pathTrim = path.startsWith('/') ? path : '/' + path;
        return baseTrim + pathTrim;
    }
    const portPart = parsed.port !== undefined ? `:${parsed.port}` : '';
    const origin = `${parsed.scheme}://${parsed.host}${portPart}`;
    const basePath = parsed.basePath ?? '';

    // Normalise path leading slash
    const normalizedPath = path.startsWith('/') ? path : '/' + path;

    // Case 2: path already includes the basePath as prefix (with a segment boundary)
    if (basePath && (normalizedPath === basePath || normalizedPath.startsWith(basePath + '/'))) {
        return origin + normalizedPath;
    }

    // Case 1/3/4: concatenate basePath + path
    return origin + basePath + normalizedPath;
}
