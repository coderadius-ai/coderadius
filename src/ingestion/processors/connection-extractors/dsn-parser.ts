/**
 * Shared DSN/URL parser for connection strings.
 *
 * Handles single-variable connection-URL patterns like
 *   DATABASE_URL=postgres://user:secret@host:5432/dbname?sslmode=require
 *   MONGO_URL=mongodb+srv://user:secret@cluster.acme.net/myapp
 *   JDBC: jdbc:postgresql://host:5432/dbname
 *
 * Credentials (user:password) are parsed but DELIBERATELY DISCARDED — they
 * never enter the returned ParsedDsn and therefore never enter the physical
 * fingerprint. This is a hard security guarantee.
 *
 * The parser is shared by:
 *   - doctrine plugin (config/packages/doctrine.yaml `dbal.connections.<x>.url`)
 *   - the orchestrator's env-var trio synthesizer (DATABASE_URL / DB_URL / *_URL)
 */

const SCHEME_TO_TECH: Record<string, string> = {
    'mysql': 'mysql',
    'mariadb': 'mysql',
    'postgresql': 'postgres',
    'postgres': 'postgres',
    'mongodb': 'mongodb',
    'mongodb+srv': 'mongodb',
    'redis': 'redis',
    'rediss': 'redis',
    'memcached': 'memcached',
    'influxdb': 'influxdb',
    'sqlserver': 'sqlserver',
    'mssql': 'sqlserver',
};

const JDBC_TO_TECH: Record<string, string> = {
    'mysql': 'mysql',
    'mariadb': 'mysql',
    'postgresql': 'postgres',
    'postgres': 'postgres',
    'sqlserver': 'sqlserver',
    'mssql': 'sqlserver',
    'oracle': 'oracle',
};

const TEMPLATE_RE = /\$\{|process\.env|%env\(|\{\{/;

export interface ParsedDsn {
    technology: string;
    host: string;
    port: number | null;
    dbName: string;
    /** Postgres `schema` query param / Mongo `authSource` etc. */
    schemaOrNs?: string;
    /** Source scheme observed (for diagnostics — not for identity). */
    scheme: string;
}

/**
 * Parse a single connection-string value. Returns null on:
 *  - non-string / empty input
 *  - template-bearing strings (caller should resolve env vars first)
 *  - unsupported schemes
 *  - malformed URIs
 *  - missing host or dbName
 *
 * NEVER returns the password / username; the auth segment is stripped at parse
 * time and is not present anywhere in the returned object.
 */
export function parseDsn(raw: unknown): ParsedDsn | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;
    if (TEMPLATE_RE.test(value)) return null;

    // JDBC has its own prefix layer: jdbc:postgresql://...
    if (/^jdbc:/i.test(value)) return parseJdbc(value);

    // Standard URI: scheme://[auth@]host[:port][/path][?query]
    const m = /^([\w+]+):\/\/(?:[^/@\s]+@)?([^/?\s:]+)(?::(\d+))?(?:\/([^?\s]*))?(?:\?([^\s#]*))?/.exec(value);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const tech = SCHEME_TO_TECH[scheme];
    if (!tech) return null;

    const host = m[2];
    if (!host) return null;
    // Memcached has no port in the path convention; default to the well-known 11211.
    const port = m[3] ? parseInt(m[3], 10) : (tech === 'memcached' ? 11211 : null);

    let dbName = '';
    if (m[4]) {
        // path may be 'dbname' or 'dbname/extra' — take only the first segment.
        dbName = m[4].split('/')[0] ?? '';
    }

    // Redis: empty path is db index 0 (still a valid logical name).
    if (!dbName && tech === 'redis') dbName = '0';
    // Memcached has no logical database; use the technology as the stable
    // logical name so the identity is 'memcached' (matches the kv family).
    if (!dbName && tech === 'memcached') dbName = 'memcached';

    if (!dbName) return null;

    let schemaOrNs: string | undefined;
    if (m[5]) {
        const params = parseQuery(m[5]);
        // Postgres conventions
        schemaOrNs = params['currentSchema']
            || params['search_path']
            || params['schema']
            || params['authSource']                  // Mongo auth db, useful for namespace tracking
            || undefined;
    }

    return { technology: tech, host, port, dbName, schemaOrNs, scheme };
}

function parseJdbc(value: string): ParsedDsn | null {
    // jdbc:postgresql://host:port/db?currentSchema=...
    const m = /^jdbc:([\w]+):\/\/([^/:?\s]+)(?::(\d+))?(?:\/([^?\s]*))?(?:\?([^\s#]*))?/i.exec(value);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const tech = JDBC_TO_TECH[scheme];
    if (!tech) return null;
    const host = m[2];
    if (!host) return null;
    const port = m[3] ? parseInt(m[3], 10) : null;
    const dbName = (m[4] ?? '').split(';')[0]?.split('/')[0] ?? '';
    if (!dbName) return null;
    let schemaOrNs: string | undefined;
    if (m[5]) {
        const params = parseQuery(m[5]);
        schemaOrNs = params['currentSchema'] || params['schema'] || params['search_path'] || undefined;
    }
    return { technology: tech, host, port, dbName, schemaOrNs, scheme };
}

function parseQuery(qs: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of qs.split('&')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = part.slice(0, eq).trim();
        const v = part.slice(eq + 1).trim();
        if (!k) continue;
        try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
    return out;
}

/**
 * Parse only host:port from a plain http(s):// URL. Used for HTTP-API datastores
 * (InfluxDB v2, Prometheus, VictoriaMetrics, …) whose connection is a generic
 * `http(s)://host:port` URL — the technology is identified by the env-var NAME,
 * not the scheme, so `parseDsn` (scheme-keyed) cannot classify them. Templates
 * and non-http values return null. Credentials in the auth segment are dropped.
 */
export function parseHttpUrlHostPort(raw: unknown): { host: string; port: number } | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim();
    if (!v || TEMPLATE_RE.test(v)) return null;
    const m = /^https?:\/\/(?:[^/@\s]+@)?([^/?\s:]+)(?::(\d+))?/i.exec(v);
    if (!m || !m[1]) return null;
    return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 0 };
}

/**
 * Convenience predicate: is this value a recognized DSN/URL we can parse?
 * Useful in synth code that decides whether to descend into URL parsing or
 * keep the value as-is.
 */
export function looksLikeDsn(raw: unknown): boolean {
    if (typeof raw !== 'string') return false;
    const v = raw.trim();
    if (!v) return false;
    if (TEMPLATE_RE.test(v)) return false;
    return /^(jdbc:)?[\w+]+:\/\//.test(v);
}
