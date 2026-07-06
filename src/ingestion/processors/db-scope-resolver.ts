import crypto from 'node:crypto';
import type { RepoHints } from '../../config/repo-hints.js';
import { logger } from '../../utils/logger.js';
import type { PhysicalEndpointHint } from './connection-extractors/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DataContainer Scope Resolution (URN identity — NEVER auto-discovered)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the URN scope for a DataContainer node.
 *
 * Two-tier resolution (per AD-2):
 *   1. Manual override: if a `databases[]` entry in coderadius.yaml matches
 *      this table name (exact or glob), use that entry's `id` as scope.
 *   2. Fallback: use the qualified repo name as scope.
 *
 * CRITICAL INVARIANT: This function is the SOLE authority on DataContainer URN scope.
 * Auto-discovery signals (P1/P2/P3) NEVER flow through this function.
 * They feed resolveDatastoreBinding() instead, which controls Datastore STORED_IN
 * edges without affecting DataContainer identity.
 *
 * Iteration is strictly top-to-bottom over the YAML array — first match wins.
 * This is structurally guaranteed by iterating `databases[]` directly.
 *
 * Used by:
 *   - graph-writer.ts (live ingest path)
 *   - edge-reconciler.ts (edge reconciliation)
 *   - ephemeral-extractor.ts (eval path)
 *
 * @param tableName   The raw table name (e.g. "quotes_archive")
 * @param qualifiedRepoName  The full repo name (e.g. "acme/shop")
 * @param repoHints   Parsed coderadius.yaml configuration
 * @returns {{ scope: string; scopeSource: 'manual_override' | 'repo_fallback' }}
 */
export function resolveContainerScope(
    tableName: string,
    qualifiedRepoName: string,
    repoHints: RepoHints,
): { scope: string; scopeSource: 'manual_override' | 'repo_fallback' } {
    const databases = repoHints.databases ?? [];
    for (const db of databases) {
        if (!db.tables || db.tables.length === 0) continue;
        for (const pattern of db.tables) {
            if (matchesTableGlob(pattern, tableName)) {
                return { scope: db.id, scopeSource: 'manual_override' };
            }
        }
    }

    return { scope: qualifiedRepoName, scopeSource: 'repo_fallback' };
}

/**
 * Simple glob matching for table name patterns.
 * Supports:
 *   - exact: "orders" → matches only "orders"
 *   - prefix: "wp_*" → matches "wp_posts", "wp_options"
 *   - suffix: "*_logs" → matches "audit_logs", "event_logs"
 *   - wildcard: "*" → matches everything
 *
 * Case-insensitive comparison.
 */
export function matchesTableGlob(pattern: string, tableName: string): boolean {
    const p = pattern.toLowerCase();
    const t = tableName.toLowerCase();

    if (p === '*') return true;
    if (p === t) return true;
    if (p.startsWith('*') && p.endsWith('*')) {
        return t.includes(p.slice(1, -1));
    }
    if (p.endsWith('*')) {
        return t.startsWith(p.slice(0, -1));
    }
    if (p.startsWith('*')) {
        return t.endsWith(p.slice(1));
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Datastore Binding Resolution (infrastructure linkage — auto-discoverable)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Auto-discovered connection string hint.
 * Extracted ONE-TIME per repo from .env, application.yml, config files, etc.
 */
export interface ConnectionStringHint {
    /** sha256_trunc8(host:port/dbName) — stable, cross-repo fingerprint */
    endpointKey: string;
    /** Database name extracted from the connection string */
    dbName: string;
    /** Technology identifier: 'mongodb', 'postgres', 'mysql', 'redis', etc. */
    technology: string;
    /** Raw host — only persisted if allowPlainTextHosts is true */
    host: string;
    /** Port number (defaults applied per technology) */
    port: number;
    /** Relative path of the source file */
    sourceFile: string;
    /** Confidence level: prod files = high, .example/.sample = medium */
    confidence: 'high' | 'medium';
}

/** Auto-discovered infrastructure manifest hint (Docker Compose, Helm, K8s). */
export interface InfraManifestHint {
    dbName: string;
    technology: string;
    sourceFile: string;
    confidence: 'high' | 'medium';
}

/** Auto-discovered config file environment variable hint. */
export interface ConfigFileHint {
    dbName: string;
    /** Technology — MUST be explicit. If absent, this hint is NOT usable. */
    technology?: string;
    sourceFile: string;
}

/**
 * One environment variant of a logical Datastore (e.g. the dev `mysql` host
 * for the same logical DB whose production host is `mysql-prod.acme.com`).
 *
 * Stamped on `Datastore.environments[]` so the UI can show "this DB has
 * production + development surfaces" without polluting the topology with
 * extra Datastore nodes.
 */
export interface EnvironmentVariant {
    /** Inferred env class — 'production' / 'staging' / 'development' / 'unknown'. */
    environment: 'production' | 'staging' | 'development' | 'test' | 'unknown';
    host: string;
    port: number;
    /** Raw dbName from the hint (with env-suffix preserved, e.g. 'orders-dev'). */
    dbName: string;
    sourceFile: string;
}

/**
 * A canonical logical Datastore identity, produced by collapsing hints that
 * represent the same database across environments (`orders` helm-prod +
 * `orders-dev` docker → one identity, two `environments[]`).
 *
 * Identities are the unit consumed by `resolveDatastoreBinding`: they replace
 * the raw `connHints` array. A repo with two truly different DBs (e.g.
 * `orders` and `payments`) yields two identities; a repo whose only variation
 * is across envs yields one.
 */
export interface DatastoreIdentity {
    /**
     * Stable identity key used for grouping (lowercase dbName-stripped of env
     * suffix, or `connectionAlias`). Used as the Datastore URN suffix.
     */
    identityKey: string;
    /**
     * The "main" hint — the one whose host/port/sourceFile is shown in the
     * graph as the canonical Datastore representation. Pick deterministically:
     * helm-prod manifest > .env.production > docker-compose > .env.local.
     */
    canonicalHint: PhysicalEndpointHint;
    /** All env variants (≥ 1, including the canonical one). */
    environments: EnvironmentVariant[];
}

/** Audit trail for why a particular Datastore was bound to a given DC. */
export type BindingReason =
    | 'sole-candidate'           // single canonical identity in scope, no ambiguity
    | 'p0-yaml'                  // declared in coderadius.yaml databases[]
    | 'llm-assignment'           // multiple identities, LLM picked this one
    | 'env-canonical-default';   // multiple identities, LLM disabled/failed → fallback to canonical-prod

/**
 * Result of resolveDatastoreBinding(): identifies which Datastore
 * to link via STORED_IN, plus optional cross-repo endpoint data.
 *
 * CRITICAL: This does NOT change DataContainer URN identity.
 *           An error here creates incorrect edges (reversible with re-ingest),
 *           NOT false structural merges (which are irreversible).
 *
 * Multi-identity scopes: the binding gate may now return MULTIPLE candidates
 * (one per canonical identity). The graph-writer creates each Datastore node
 * but defers the per-table STORED_IN choice to the LLM-assignment step,
 * which writes a single edge per DC with the chosen `bindingReason`.
 */
export interface DatastoreBinding {
    /** Logical Datastore ID (e.g. "archive_mongodb", "main-mysql") */
    datastoreId: string;
    /** Technology: 'mongodb' | 'postgres' | 'mysql' | 'redis' | 'cache' | ... */
    technology: string;
    /** true ONLY when declared in coderadius.yaml. Auto-discovery: always false. */
    shared: boolean;
    /** Cross-repo endpoint fingerprint. Present only for P1 (connection string). */
    endpointKey?: string;
    /** Which resolution tier produced this binding — for audit/debugging. */
    bindingSource: 'yaml_datastores' | 'connection_string' | 'infra_manifest' | 'config_file';
    /** Confidence in this specific binding (0..1). Stamped on the STORED_IN edge. */
    confidence: number;
    /** Why this binding was chosen — stamped on the STORED_IN edge. */
    bindingReason: BindingReason;
    /** Multi-environment metadata — stamped on the Datastore node. */
    environments?: EnvironmentVariant[];
    /** @internal — raw connection hint for the writer to extract host for DatabaseEndpoint */
    _rawConnHint?: ConnectionStringHint;
}

/** Technology mapping for infra types that don't have explicit YAML config. */
const INFRA_TYPE_TO_TECH: Record<string, string> = {
    'Cache': 'cache',
    'ObjectStorage': 'object-storage',
};

/** Family classification used by the binding compatibility gate. */
export type KindFamily = 'rdbms' | 'document' | 'kv' | 'timeseries' | 'broker' | 'queue' | 'object';

/**
 * Single source of truth for the universe of kind families.
 *
 * Consumers iterate this list to compute family-vs-family compatibility (e.g.
 * `pruneIncompatibleStoredInEdges` in `data-contracts.ts` builds an
 * incompatibility map by inverting `familyForTechnology` over this set).
 */
export const ALL_KIND_FAMILIES: readonly KindFamily[] = [
    'rdbms', 'document', 'kv', 'timeseries', 'broker', 'queue', 'object',
];

/**
 * Single source of truth for technology → family mapping.
 *
 * Adding a new technology here AUTOMATICALLY propagates to:
 *   - `resolveDatastoreBinding` kindFamily gate (this file).
 *   - `pruneIncompatibleStoredInEdges` Cypher rules (data-contracts.ts).
 *
 * Both consumers derive their incompatibility set from this function via the
 * exported `ALL_KIND_FAMILIES` and `ALL_KNOWN_TECHS` helpers — there is no
 * duplicated tech list anywhere else. A unit test asserts that every entry
 * in `ALL_KNOWN_TECHS` resolves to a non-null family here.
 */
export function familyForTechnology(tech: string | undefined): KindFamily | null {
    if (!tech) return null;
    const t = tech.toLowerCase();
    if (t === 'mysql' || t === 'mariadb' || t === 'postgres' || t === 'postgresql'
        || t === 'sqlserver' || t === 'mssql' || t === 'oracle' || t === 'sqlite') return 'rdbms';
    if (t === 'mongodb' || t === 'mongo' || t === 'couchdb' || t === 'documentdb') return 'document';
    if (t === 'redis' || t === 'memcached' || t === 'dynamodb') return 'kv';
    if (t === 'influxdb' || t === 'victoriametrics' || t === 'questdb' || t === 'prometheus') return 'timeseries';
    if (t === 'kafka' || t === 'rabbitmq' || t === 'pubsub') return 'broker';
    if (t === 'sqs' || t === 'sns') return 'queue';
    if (t === 's3' || t === 'gcs' || t === 'object-storage') return 'object';
    return null;
}

/**
 * Universe of technology identifiers that `familyForTechnology` recognises.
 *
 * Used to materialise the "incompatible techs per family" map at run-time
 * (Cypher prune mutation). Must stay in sync with `familyForTechnology`;
 * the unit invariant test enforces this.
 */
export const ALL_KNOWN_TECHS: readonly string[] = [
    // rdbms
    'mysql', 'mariadb', 'postgres', 'postgresql', 'sqlserver', 'mssql', 'oracle', 'sqlite',
    // document
    'mongodb', 'mongo', 'couchdb', 'documentdb',
    // kv
    'redis', 'memcached', 'dynamodb',
    // timeseries
    'influxdb', 'victoriametrics', 'questdb', 'prometheus',
    // broker
    'kafka', 'rabbitmq', 'pubsub',
    // queue
    'sqs', 'sns',
    // object
    's3', 'gcs', 'object-storage',
];

/** Predicate: does this hint's tech family match the requested kind family? */
function matchesKindFamily(hintTech: string | undefined, kindFamily: KindFamily | undefined): boolean {
    if (!kindFamily) return true;            // no constraint → accept any
    const fam = familyForTechnology(hintTech);
    if (!fam) return false;                  // hint without recognisable tech is opaque — refuse
    return fam === kindFamily;
}

/**
 * Resolve which Datastore should be linked to a DataContainer via STORED_IN.
 *
 * Uses a 4-tier fail-closed cascade:
 *   P0: YAML datastores[] (manual config, highest authority)
 *   P1: Connection string hints (auto-discovered, high precision)
 *   P2: Infrastructure manifest hints (Docker Compose, Helm)
 *   P3: Config file env var hints (lowest trust, requires explicit technology)
 *
 * CRITICAL INVARIANT: Does NOT change DataContainer URN identity.
 * resolveContainerScope() remains the sole authority on URN scope.
 *
 * Fail-closed on ambiguity: if multiple hints match at any tier, returns null
 * rather than guessing (prevents false Datastore linkage).
 *
 * Kind-family gate: when `kindFamily` is supplied (set by ORM extractors that
 * have deterministic structural evidence — `@ORM\Table` → `'rdbms'`, Mongoose
 * `Schema` → `'document'`), every connection hint must belong to a compatible
 * tech family. Mismatched hints are filtered out BEFORE counting, so a single
 * `mongodb` connection cannot bind a Doctrine table just because it's the
 * only auto-discovered connection.
 *
 * @param tableName   Table name (for Database), or null (Cache/ObjectStorage)
 * @param infraType   'Database' | 'Cache' | 'ObjectStorage'
 * @param repoHints   Parsed coderadius.yaml — P0 source
 * @param envVarHint  Secondary signal from inferDatastoreFromEnvVars() (TS/JS repos)
 * @param identities  Canonical Datastore identities (auto-discovered, env variants collapsed)
 * @param kindFamily  Coarse family classification of the DataContainer (when known)
 *
 * @returns Array of `DatastoreBinding`s. Empty array means fail-closed (no
 * candidate). Single-element array means an unambiguous binding (write
 * STORED_IN immediately). Multi-element array means ambiguity that must be
 * resolved per-table by the LLM-assignment step (graph-writer creates each
 * Datastore node but defers the STORED_IN choice).
 */
export function resolveDatastoreBinding(
    tableName: string | null,
    infraType: string,
    repoHints: RepoHints,
    envVarHint: { name: string; technology: string } | null,
    identities?: readonly DatastoreIdentity[],
    kindFamily?: KindFamily,
): DatastoreBinding[] {

    // ── P0: YAML datastores[] — existing manual config, highest authority ──
    const yamlBinding = _selectFromYamlDatastores(tableName, infraType, repoHints, envVarHint);
    if (yamlBinding) {
        if (kindFamily && !matchesKindFamily(yamlBinding.technology, kindFamily)) {
            logger.debug(`[DatastoreBinding] P0 yaml binding rejected: tech="${yamlBinding.technology}" not compatible with kindFamily="${kindFamily}"`);
            return [];
        }
        return [yamlBinding];
    }

    // ── Auto-discovery ──────────────────────────────────────────────────────
    if (!identities || identities.length === 0) return [];

    // Cache auto-promotion (S1.2 policy): a discovered kv cache (redis,
    // memcached) connection becomes a Datastore on its own, mirroring the
    // Database path's rdbms auto-promotion below. ObjectStorage stays
    // yaml-only — a connection string is a database/cache endpoint, never an
    // S3 bucket.
    if (infraType === 'Cache') {
        return _pickAutoPromoted(identities.filter(
            id => familyForTechnology(id.canonicalHint.technology) === 'kv',
        ));
    }
    if (infraType !== 'Database') return [];

    // Database: filter identities by kindFamily compatibility (or default-RDBMS
    // guard when caller didn't supply one).
    //
    // Default-RDBMS guard: every structural extractor that recognises a
    // non-RDBMS resource (Mongoose `@Schema({collection})`, MongoDB ODM
    // `#[Document]`, Doctrine MongoDB driver, Redis client) emits an explicit
    // kindFamily — so the absence of kindFamily on a Database entry is
    // overwhelmingly an unannotated SQL access. The guard keeps a single
    // mongo hint from silently binding every Doctrine table when the LLM
    // path didn't carry a family signal.
    const candidates = identities.filter(id => {
        const tech = id.canonicalHint.technology;
        if (kindFamily) return matchesKindFamily(tech, kindFamily);
        const fam = familyForTechnology(tech);
        return fam === null || fam === 'rdbms';
    });
    return _pickAutoPromoted(candidates);
}

/**
 * Reduce a family-filtered candidate set to bindings: single → sole-candidate;
 * multiple → all (env-canonical-default), deferring the per-resource choice to
 * the LLM-assignment step. High-confidence canonical hints win when present.
 */
function _pickAutoPromoted(candidates: readonly DatastoreIdentity[]): DatastoreBinding[] {
    if (candidates.length === 0) return [];
    const highConf = candidates.filter(id => id.canonicalHint.confidence === 'high');
    const usable = highConf.length > 0 ? highConf : candidates;
    if (usable.length === 1) {
        return [_identityToBinding(usable[0], 'sole-candidate', 0.95)];
    }
    return usable.map(id => _identityToBinding(id, 'env-canonical-default', 0.5));
}

/** Convert a canonical identity into a single binding tuple. */
function _identityToBinding(
    identity: DatastoreIdentity,
    bindingReason: BindingReason,
    confidence: number,
): DatastoreBinding {
    const h = identity.canonicalHint;
    const port = h.port || 0;
    const endpointKey = (h.host && port && h.dbName)
        ? computeEndpointKey(h.host, port, h.dbName)
        : undefined;
    const _rawConnHint: ConnectionStringHint | undefined = endpointKey
        ? {
            endpointKey,
            dbName: h.dbName,
            technology: h.technology,
            host: h.host,
            port,
            sourceFile: h.sourceFile,
            confidence: h.confidence === 'low' ? 'medium' : h.confidence,
        }
        : undefined;
    return {
        datastoreId: identity.identityKey,
        technology: h.technology,
        shared: false,
        endpointKey,
        bindingSource: 'connection_string',
        confidence,
        bindingReason,
        environments: [...identity.environments],
        _rawConnHint,
    };
}

/**
 * Stable cross-repo physical fingerprint for a `:DatabaseEndpoint`.
 *
 * `sha256(host:port/dbName)` truncated to 16 hex. Case-insensitive on host
 * and dbName so two repos that point at the same endpoint converge to the
 * same key. Identity-only: never carries credentials. The graph-writer pairs
 * it with the environment segment (`buildDatabaseEndpointUrn`) so the same
 * physical endpoint observed in two environments yields two distinct nodes.
 */
/** Known env-var prefixes that hint at a database technology. */
const DATASTORE_ENV_PATTERNS: Array<{ pattern: RegExp; name: string; technology: string }> = [
    { pattern: /^(POSTGRES|PG|PGHOST|DATABASE_URL)/i, name: 'postgres', technology: 'postgres' },
    { pattern: /^MYSQL/i, name: 'mysql', technology: 'mysql' },
    { pattern: /^MONGO/i, name: 'mongodb', technology: 'mongodb' },
    { pattern: /^REDIS/i, name: 'redis', technology: 'redis' },
    { pattern: /^S3_|^AWS_S3/i, name: 's3', technology: 's3' },
];

/**
 * Infer a Datastore hint from the function's env var names.
 * Returns the first matched datastore or null.
 */
export function inferDatastoreFromEnvVars(envVarNames: string[]): { name: string; technology: string } | null {
    for (const env of envVarNames) {
        for (const p of DATASTORE_ENV_PATTERNS) {
            if (p.pattern.test(env)) {
                return { name: p.name, technology: p.technology };
            }
        }
    }
    return null;
}

export function computeEndpointKey(host: string, port: number, dbName: string): string {
    const raw = `${host.toLowerCase()}:${port}/${dbName.toLowerCase()}`;
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

/**
 * P0: Select Datastore from YAML datastores[] config.
 * This is the existing selectDatastoreHint logic, moved and renamed.
 */
function _selectFromYamlDatastores(
    tableName: string | null,
    infraType: string,
    repoHints: RepoHints,
    envVarHint: { name: string; technology: string } | null,
): DatastoreBinding | null {
    const hints = repoHints.databases ?? [];
    if (hints.length === 0) return null;

    // Table-based routing (Database case)
    if (tableName) {
        const byTable = hints.filter(h =>
            h.tables.some(p => matchesTableGlob(p, tableName)),
        );
        if (byTable.length === 1) {
            return { datastoreId: byTable[0].id, technology: byTable[0].technology,
                     shared: byTable[0].shared, bindingSource: 'yaml_datastores',
                     confidence: 1.0, bindingReason: 'p0-yaml' };
        }
        if (byTable.length > 1) {
            logger.error(
                `[Datastore] Table "${tableName}" matches multiple hints: ` +
                `${byTable.map(h => h.id).join(', ')}. Skipping Datastore linkage.`,
            );
            return null;
        }
    }

    // Infra-type match via technology family
    const techFamily = INFRA_TYPE_TO_TECH[infraType];
    if (techFamily) {
        const byTech = hints.filter(h => h.technology === techFamily);
        if (byTech.length === 1) {
            return { datastoreId: byTech[0].id, technology: byTech[0].technology,
                     shared: byTech[0].shared, bindingSource: 'yaml_datastores',
                     confidence: 1.0, bindingReason: 'p0-yaml' };
        }
    }

    // Env-var hint secondary signal
    if (envVarHint) {
        const byEnvTech = hints.filter(h => h.technology === envVarHint.technology);
        if (byEnvTech.length === 1) {
            return { datastoreId: byEnvTech[0].id, technology: byEnvTech[0].technology,
                     shared: byEnvTech[0].shared, bindingSource: 'yaml_datastores',
                     confidence: 1.0, bindingReason: 'p0-yaml' };
        }
    }

    // Single catch-all: if there's only one hint with no table patterns, it's the default
    if (hints.length === 1 && hints[0].tables.length === 0) {
        return { datastoreId: hints[0].id, technology: hints[0].technology,
                 shared: hints[0].shared, bindingSource: 'yaml_datastores',
                 confidence: 1.0, bindingReason: 'p0-yaml' };
    }

    return null;
}

/**
 * Given multiple high-confidence connection hints, attempt to narrow by infraType.
 * Returns null if still ambiguous.
 */
function _filterByTechnology(
    hints: ConnectionStringHint[],
    infraType: string,
): ConnectionStringHint | null {
    // Map infraType → expected connection technology
    const infraToConnTech: Record<string, string> = {
        'Database': '', // ambiguous — could be any DB
        'Cache': 'redis',
        'ObjectStorage': 's3',
    };

    const expectedTech = infraToConnTech[infraType];
    if (!expectedTech) return null;

    const matched = hints.filter(h => h.technology === expectedTech);
    if (matched.length === 1) return matched[0];
    return null;
}
