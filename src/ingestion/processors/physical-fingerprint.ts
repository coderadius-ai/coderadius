import crypto from 'node:crypto';
import { areUrnsTransparent, buildTransparentIdentity } from '../../utils/urn-transparency.js';

export type PhysicalFamily = 'rdbms' | 'document' | 'kv' | 'timeseries' | 'broker' | 'queue' | 'object';

export interface PhysicalEndpoint {
    family: PhysicalFamily;
    technology: string;
    host: string;
    port: number;
    logicalName: string;
    schemaOrNs?: string;
    fingerprint: string;
}

const TECH_ALIASES: Record<string, string> = {
    mariadb: 'mysql',
    postgresql: 'postgres',
    psql: 'postgres',
    mongo: 'mongodb',
    'mongodb+srv': 'mongodb',
    rabbit: 'rabbitmq',
    'gcp-pubsub': 'pubsub',
};

const TECH_FAMILY: Record<string, PhysicalFamily> = {
    mysql: 'rdbms',
    postgres: 'rdbms',
    sqlserver: 'rdbms',
    oracle: 'rdbms',
    mongodb: 'document',
    redis: 'kv',
    memcached: 'kv',
    influxdb: 'timeseries',
    victoriametrics: 'timeseries',
    questdb: 'timeseries',
    prometheus: 'timeseries',
    kafka: 'broker',
    rabbitmq: 'broker',
    pubsub: 'broker',
    sqs: 'queue',
    s3: 'object',
    gcs: 'object',
};

const DEFAULT_PORTS: Record<string, number> = {
    mysql: 3306,
    postgres: 5432,
    sqlserver: 1433,
    oracle: 1521,
    mongodb: 27017,
    redis: 6379,
    memcached: 11211,
    influxdb: 8086,
    victoriametrics: 8428,
    questdb: 8812,
    prometheus: 9090,
    kafka: 9092,
    rabbitmq: 5672,
    pubsub: 443,
    sqs: 443,
    s3: 443,
    gcs: 443,
};

export function canonicalizeTechnology(tech: string): string {
    const lower = (tech ?? '').trim().toLowerCase();
    return TECH_ALIASES[lower] ?? lower;
}

export function familyFor(tech: string): PhysicalFamily | undefined {
    return TECH_FAMILY[canonicalizeTechnology(tech)];
}

export function defaultPort(tech: string): number {
    return DEFAULT_PORTS[canonicalizeTechnology(tech)] ?? 0;
}

export function normalizeHost(host: string): string {
    if (!host) return '';
    let h = host.trim();
    // Strip IPv6 brackets
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    // IDN decode (URL parser does it via .hostname)
    try {
        const u = new URL(`http://${h}`);
        h = u.hostname;
    } catch {
        // not a parseable host; keep raw
    }
    // strip trailing dot (FQDN abs)
    if (h.endsWith('.')) h = h.slice(0, -1);
    return h.toLowerCase();
}

export function normalizeDbName(tech: string, name: string): string {
    if (!name) return '';
    let n = name.trim();
    // strip surrounding quotes/backticks
    n = n.replace(/^[`'"]|[`'"]$/g, '');
    // URL-decode (e.g. %20)
    try { n = decodeURIComponent(n); } catch { /* ignore */ }
    // strip leading/trailing slashes
    n = n.replace(/^\/+|\/+$/g, '');
    return n.toLowerCase();
}

// Loopback / local-network hosts — common in monoliths (`localhost`,
// `127.0.0.1`), Docker-Compose (`mysql`, `db`, `postgres`), and Docker-
// Desktop tunnels (`host.docker.internal`). They DO bind in-repo (the
// table↔datastore relationship is real on the originating cluster) but
// they MUST NOT fingerprint-weld: two repos that both point to
// `localhost` or `mysql` are not the same database.
const LOCAL_NETWORK_HOSTS = new Set([
    'localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal',
    'db', 'database', 'postgres', 'mysql', 'mariadb', 'mongo', 'mongodb',
    'redis', 'kafka', 'rabbitmq',
]);

const SENTINEL_VALUES = new Set([
    '<host>', 'your-host', 'xxx', 'changeme', 'replaceme',
    '<dbname>', 'your-database', 'your-db',
]);

/**
 * "Drop entirely" predicate — used at extraction time
 * (connection-extractors/registry.ts). The only values that aren't real
 * hosts: empty, sentinel placeholders, unresolved env templates. Loopback
 * and Docker-Compose service names are explicitly NOT in this set —
 * they're valid binding targets for the originating repo. Dropping them
 * here would break monoliths whose entire DB topology lives behind
 * `DB_HOST=127.0.0.1` or `DB_HOST=mysql`.
 */
export function isUnbindableHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    if (!h) return true;
    if (SENTINEL_VALUES.has(h)) return true;
    if (h.includes('${') || h.includes('%env') || h.includes('process.env') || h.includes('{{')) return true;
    return false;
}

/**
 * "Skip fingerprint" predicate — used inside `buildPhysicalEndpoint` only.
 * Adds loopback and service-name hosts on top of the unbindable set:
 * those bind in-repo but cannot participate in cross-repo welding because
 * the literal `localhost` / `mysql` is not stable across repositories.
 */
export function isUnfingerprintableHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    if (isUnbindableHost(h)) return true;
    if (LOCAL_NETWORK_HOSTS.has(h)) return true;
    return false;
}

/**
 * Backwards-compat alias. New call sites that mean "skip fingerprint"
 * should use isUnfingerprintableHost; sites that mean "drop the hint
 * entirely" should use isUnbindableHost.
 */
export const isUnusableHost = isUnfingerprintableHost;

export function isUnusableLogicalName(name: string): boolean {
    const n = name.trim().toLowerCase();
    if (!n) return true;
    if (SENTINEL_VALUES.has(n)) return true;
    if (n.includes('${') || n.includes('%env') || n.includes('process.env') || n.includes('{{')) return true;
    return false;
}

export function buildPhysicalEndpoint(raw: {
    technology: string;
    host: string;
    port?: number | null;
    logicalName: string;
    schemaOrNs?: string;
}): PhysicalEndpoint | null {
    const technology = canonicalizeTechnology(raw.technology);
    const family = familyFor(technology);
    if (!family) return null;

    const host = normalizeHost(raw.host ?? '');
    if (isUnfingerprintableHost(host)) return null;

    const logicalName = normalizeDbName(technology, raw.logicalName ?? '');
    if (isUnusableLogicalName(logicalName)) return null;

    const port = raw.port && raw.port > 0 ? raw.port : defaultPort(technology);

    const schemaOrNs = raw.schemaOrNs ? raw.schemaOrNs.trim().toLowerCase() : undefined;

    const fingerprint = areUrnsTransparent()
        ? buildTransparentIdentity([host, port, logicalName, schemaOrNs])
        : crypto.createHash('sha256').update(
            `${family}|${technology}|${host}:${port}|${logicalName}|${schemaOrNs ?? ''}`,
          ).digest('hex').slice(0, 16);

    return { family, technology, host, port, logicalName, schemaOrNs, fingerprint };
}
