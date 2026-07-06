import fs from 'node:fs';
import path from 'node:path';
import { familyForTechnology, type KindFamily, type DatastoreIdentity } from './db-scope-resolver.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Standalone datastore promotion (high-confidence gate)
//
// A datastore whose I/O function is dropped by the taint gate (e.g. InfluxDB
// accessed through a wrapper) never reaches the per-function binding loop in
// graph-writer, so no `:Datastore` node is created — a blast-radius False
// Negative. This module decides which connection-hint identities are safe to
// materialise as standalone datastores.
//
// FP guard: a tech-named connection is promoted ONLY when it clears a
// high-confidence gate:
//   1. the technology resolves to a real datastore family (not broker/queue/
//      object/unknown), AND
//   2. EITHER a known client library for that technology is a declared
//      dependency, OR the hint came from an unambiguous datastore DSN scheme
//      (`mysql://`, `mongodb://`, …) which self-declares it is a datastore.
//
// A bare host/URL with no client library and no datastore scheme is refused —
// that is the line that keeps a generic `http(s)://` URL from becoming a node.
// ═══════════════════════════════════════════════════════════════════════════════

/** Families that represent a persistent datastore (promotable). Brokers/queues/
 *  object-storage are deliberately excluded — they are not "datastores" here. */
const PROMOTABLE_FAMILIES: ReadonlySet<KindFamily> = new Set<KindFamily>([
    'rdbms', 'document', 'kv', 'timeseries',
]);

/**
 * Technology → client-library package names that prove a real datastore
 * dependency. Declarative table (composer + npm names), extensible per store;
 * an unknown/incomplete entry fails SAFE (toward not-promoting, never an FP).
 */
export const DATASTORE_CLIENT_PACKAGES: Record<string, string[]> = {
    influxdb: ['influxdb/influxdb-php', 'influxdata/influxdb-client-php', '@influxdata/influxdb-client', 'influx'],
    mysql: ['doctrine/dbal', 'doctrine/orm', 'mysql2', 'mysql', 'sequelize', 'typeorm', 'knex'],
    postgres: ['doctrine/dbal', 'pg', 'pg-promise', 'postgres', 'sequelize', 'typeorm', 'knex'],
    mongodb: ['mongodb/mongodb', 'mongodb', 'mongoose'],
    redis: ['predis/predis', 'ext-redis', 'ioredis', 'redis'],
    memcached: ['ext-memcached', 'memcached', 'memjs'],
    victoriametrics: ['@influxdata/influxdb-client'],
    questdb: ['@questdb/nodejs-client', 'questdb'],
};

/** Does the repo declare a client library for `tech`? */
export function matchesDatastoreClient(tech: string, declaredPackages: ReadonlySet<string>): boolean {
    const clients = DATASTORE_CLIENT_PACKAGES[tech.toLowerCase()];
    if (!clients) return false;
    return clients.some(pkg => declaredPackages.has(pkg));
}

/**
 * Filter connection-hint identities down to the ones safe to materialise as
 * standalone datastores. See the module header for the high-confidence gate.
 */
export function selectPromotableDatastores(
    identities: readonly DatastoreIdentity[],
    declaredPackages: ReadonlySet<string>,
): DatastoreIdentity[] {
    return identities.filter(id => {
        const tech = id.canonicalHint.technology;
        const fam = familyForTechnology(tech);
        if (!fam || !PROMOTABLE_FAMILIES.has(fam)) return false;
        return id.canonicalHint.viaDsnScheme === true || matchesDatastoreClient(tech, declaredPackages);
    });
}

/**
 * Collect the package names a repo DECLARES as dependencies — the client-library
 * corroboration signal. Reads composer.json (require + require-dev) and
 * package.json (dependencies + devDependencies) at the repo root. Best-effort:
 * a missing/malformed manifest contributes nothing (fails safe).
 */
export function readDeclaredPackages(repoPath: string): Set<string> {
    const pkgs = new Set<string>();
    collectKeys(path.join(repoPath, 'composer.json'), ['require', 'require-dev'], pkgs);
    collectKeys(path.join(repoPath, 'package.json'), ['dependencies', 'devDependencies'], pkgs);
    return pkgs;
}

function collectKeys(file: string, sections: string[], out: Set<string>): void {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
        return;
    }
    for (const section of sections) {
        const block = parsed[section];
        if (block && typeof block === 'object') {
            for (const name of Object.keys(block as Record<string, unknown>)) out.add(name);
        }
    }
}
