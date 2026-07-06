/**
 * Canonicalize a flat list of `PhysicalEndpointHint`s into logical
 * `DatastoreIdentity`s by collapsing env variants of the same database.
 *
 * Two hints belong to the same logical identity when:
 *   - they share `connectionAlias` (case-insensitive), OR
 *   - their `dbName` is equal modulo a recognised env-suffix (`-dev`, `_prod`,
 *     `-staging`, `-test`, `_local`).
 *
 * Hints with totally different `dbName` roots and no shared alias yield
 * separate identities — this is the common case for repos that legitimately
 * own multiple logical databases (e.g. `orders` and `payments`).
 *
 * For each identity, a deterministic ranker picks the canonical hint:
 *   helm/k8s prod manifest > .env.production > docker-compose > .env.local > rest.
 *   DNS-shaped host (contains `.`) outranks service-name within the same tier.
 *
 * Pure function, no I/O. Deterministic. Idempotent.
 */

import type { PhysicalEndpointHint } from './types.js';
import type { DatastoreIdentity, EnvironmentVariant } from '../db-scope-resolver.js';
import { familyFor, canonicalizeTechnology } from '../physical-fingerprint.js';

// ─── Suffix stripping ────────────────────────────────────────────────────────

const ENV_SUFFIX_RE = /(?:[-_](?:dev|development|prod|production|staging|stage|test|local|qa|uat))$/i;

/**
 * Strip a recognised env suffix from a dbName. Conservative: only matches
 * end-of-string `-dev` / `_prod` style suffixes, never substring. `orders_v2`
 * / `payments_archive` / `users-api` stay untouched.
 */
export function stripEnvSuffix(dbName: string): string {
    return dbName.replace(ENV_SUFFIX_RE, '');
}

/** Infer the environment class from a dbName / sourceFile combo. */
export function inferEnvironment(
    dbName: string,
    sourceFile: string,
): EnvironmentVariant['environment'] {
    // `\b` is unreliable here because `_` counts as a word char, so use
    // explicit non-alphanumeric boundaries via lookbehind/lookahead.
    const lc = `${dbName} ${sourceFile}`.toLowerCase();
    if (/(?<![a-z0-9])(?:prod|production)(?![a-z0-9])/.test(lc)) return 'production';
    if (/(?<![a-z0-9])(?:staging|stage)(?![a-z0-9])/.test(lc)) return 'staging';
    if (/(?<![a-z0-9])(?:dev|development)(?![a-z0-9])/.test(lc) || lc.includes('docker-compose')) return 'development';
    if (/(?<![a-z0-9])(?:test|qa|uat)(?![a-z0-9])/.test(lc)) return 'test';
    return 'unknown';
}

// ─── Identity grouping ───────────────────────────────────────────────────────

/**
 * Compute the identity key for grouping. Lowercase. Always derived from
 * `stripEnvSuffix(dbName)` — the dbName modulo env suffix is the most stable
 * signal of "same logical database" across deployment surfaces.
 *
 * Why NOT `connectionAlias`-first:
 *   - In Helm production manifests `connectionAlias` is typically absent.
 *   - In docker-compose it carries env-var-prefix names like `assi` / `self`.
 *   - When both exist for the same logical DB, alias-first grouping splits
 *     prod and dev variants apart (helm has alias=undefined, docker has
 *     alias='assi' → two identities for what is one logical DB).
 *
 * The dbName-stripped path collapses `orders` (helm) + `orders-dev` (docker)
 * into the same identity regardless of alias. Different logical DBs
 * (`orders` vs `payments`) keep their own dbName roots, so they stay
 * separate.
 *
 * `connectionAlias` is still preserved on the canonical hint and used by
 * downstream callers (resolver / LLM agent) for context, but no longer drives
 * identity boundaries.
 *
 * Schemaless families (timeseries, kv) are the exception: they have no logical-
 * database identity boundary. A timeseries store's schema/bucket or a kv slot is
 * frequently named after the app (e.g. INFLUXDB_SCHEMA=<app>), so keying on
 * dbName collapses the store onto an unrelated RDBMS of the same name and lets
 * the timeseries technology overwrite it (corrupting the relational store and
 * stranding its tables). These are identified by technology instead — the store
 * instance is the unit of interest for blast radius.
 */
function computeIdentityKey(hint: PhysicalEndpointHint): string {
    const family = familyFor(hint.technology);
    if (family === 'timeseries' || family === 'kv') {
        return canonicalizeTechnology(hint.technology);
    }
    return stripEnvSuffix(hint.dbName).toLowerCase();
}

// ─── Canonical-hint ranking ──────────────────────────────────────────────────

const SOURCE_TIER_PATTERNS: Array<{ tier: number; matcher: RegExp }> = [
    // Tier 0 (best): production helm / k8s manifests.
    { tier: 0, matcher: /(?:^|\/)(?:\.?helm|\.?charts?|chart)\/.*?(?:prod|production)/i },
    { tier: 0, matcher: /(?:^|\/)(?:\.?k8s|deploy(?:ment)?s?)\/.*?(?:prod|production)/i },
    // Tier 1: env files marked production.
    { tier: 1, matcher: /(?:^|\/)\.env\.production$/i },
    { tier: 1, matcher: /(?:^|\/)\.env\.prod$/i },
    // Tier 2: any helm/k8s manifest (non-prod-marked).
    { tier: 2, matcher: /(?:^|\/)(?:\.?helm|\.?charts?|chart|\.?k8s)\//i },
    // Tier 3: docker-compose (dev surface).
    { tier: 3, matcher: /(?:^|\/)docker-compose(?:\..+)?\.ya?ml$/i },
    // Tier 4: generic env files.
    { tier: 4, matcher: /(?:^|\/)\.env(?:\..+)?$/i },
];

function sourceFileTier(sourceFile: string): number {
    for (const { tier, matcher } of SOURCE_TIER_PATTERNS) {
        if (matcher.test(sourceFile)) return tier;
    }
    return 5; // unknown source — lowest priority
}

function isDnsShapedHost(host: string): boolean {
    // Real DNS: contains a dot AND is not a sentinel like `<host>` or `localhost`.
    if (!host.includes('.')) return false;
    if (host === 'localhost' || host.startsWith('127.')) return false;
    if (host.includes('${') || host.includes('{{')) return false;
    return true;
}

/**
 * Rank hints within an identity group and pick the canonical one.
 * Lower tier wins; DNS-shaped host breaks ties; alphabetical sourceFile
 * breaks remaining ties (deterministic).
 */
function pickCanonical(group: PhysicalEndpointHint[]): PhysicalEndpointHint {
    if (group.length === 1) return group[0];
    return [...group].sort((a, b) => {
        const ta = sourceFileTier(a.sourceFile);
        const tb = sourceFileTier(b.sourceFile);
        if (ta !== tb) return ta - tb;
        const da = isDnsShapedHost(a.host) ? 0 : 1;
        const db = isDnsShapedHost(b.host) ? 0 : 1;
        if (da !== db) return da - db;
        return a.sourceFile.localeCompare(b.sourceFile);
    })[0];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Group hints into canonical identities. Order of input is preserved for
 * hints that don't get grouped; identities are returned in the order their
 * canonical hint first appears.
 */
export function canonicalizeDatastoreIdentities(
    hints: readonly PhysicalEndpointHint[],
): DatastoreIdentity[] {
    if (hints.length === 0) return [];

    // 1. Group by identity key.
    const groups = new Map<string, PhysicalEndpointHint[]>();
    const insertionOrder: string[] = [];
    for (const hint of hints) {
        const key = computeIdentityKey(hint);
        if (!groups.has(key)) {
            groups.set(key, []);
            insertionOrder.push(key);
        }
        groups.get(key)!.push(hint);
    }

    // 2. For each group, pick canonical + materialise environments.
    const identities: DatastoreIdentity[] = [];
    for (const key of insertionOrder) {
        const group = groups.get(key)!;
        const picked = pickCanonical(group);
        // Preserve the DSN-scheme provenance across env variants: if ANY variant
        // came from an unambiguous datastore DSN, the identity is high-confidence.
        const canonical = group.some(h => h.viaDsnScheme) && !picked.viaDsnScheme
            ? { ...picked, viaDsnScheme: true }
            : picked;
        const environments: EnvironmentVariant[] = group.map(h => ({
            environment: inferEnvironment(h.dbName, h.sourceFile),
            host: h.host,
            port: h.port,
            dbName: h.dbName,
            sourceFile: h.sourceFile,
        }));
        identities.push({
            identityKey: key,
            canonicalHint: canonical,
            environments,
        });
    }

    return identities;
}
