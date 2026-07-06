import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import type { BrokerConnectionHint, ConnectionExtractor, PhysicalEndpointHint, RepoCtx } from './types.js';
import { brokerProviderDefaultPort, buildRepoEnvMap, resolveTemplates, type RepoEnvMap } from './env-var-resolver.js';
import { scanCodeReferencedEnvVars } from './code-env-scanner.js';
import { scanCodeAccessorEnvVars } from './env-accessor-scanner.js';
import { getEnvAccessors, loadRepoHints } from '../../../config/repo-hints.js';
import { typeormExtractor } from './plugins/typeorm.js';
import { doctrineDriverToTech, doctrineExtractor } from './plugins/doctrine.js';
import { defineHeuristic } from '../../core/heuristics.js';
import { nestjsConfigExtractor } from './plugins/nestjs-config.js';
import { phpConfigArrayExtractor } from './plugins/php-config-array.js';
import { parseDsn, parseHttpUrlHostPort } from './dsn-parser.js';
import {
    buildPhysicalEndpoint,
    canonicalizeTechnology,
    defaultPort,
    isUnbindableHost,
    isUnusableLogicalName,
} from '../physical-fingerprint.js';

export const CONNECTION_EXTRACTORS: ConnectionExtractor[] = [
    typeormExtractor,
    doctrineExtractor,
    nestjsConfigExtractor,
    phpConfigArrayExtractor,
].sort((a, b) => b.priority - a.priority);

/**
 * `DB_SCHEMA` / `DATABASE_SCHEMA` env-key naming → assume MySQL. The KEY
 * NAME is a customer free choice (Doctrine convention, not a contract), so
 * the default is a declared convention-guess, never a silent inline branch.
 */
const DB_SCHEMA_DEFAULT_TECH_HEURISTIC = defineHeuristic({
    id: 'db-schema-default-tech',
    class: 'convention-guess',
    emits: "Datastore technology 'mysql' when only DB_SCHEMA/DATABASE_SCHEMA names the database",
    surfacedBy: 'connection-hint confidence + Datastore needsReview downstream',
    value: 'mysql' as const,
});

interface ScanCandidate {
    absPath: string;
    relPath: string;
    basename: string;
}

function* walkRepo(repoPath: string, maxDepth = 6): Generator<ScanCandidate> {
    const stack: Array<{ dir: string; depth: number }> = [{ dir: repoPath, depth: 0 }];
    const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'tmp', '.cache', 'coverage', '.next', '.turbo']);
    while (stack.length) {
        const { dir, depth } = stack.pop()!;
        if (depth > maxDepth) continue;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            if (ent.name.startsWith('.git')) continue;
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue;
                stack.push({ dir: abs, depth: depth + 1 });
                continue;
            }
            if (!ent.isFile()) continue;
            const lower = ent.name.toLowerCase();
            const rel = path.relative(repoPath, abs).replace(/\\/g, '/');
            // Union of plugin-declared discovery predicates: the walker
            // carries zero framework filename knowledge (each extractor owns
            // its own config-file shapes via `candidateFile`).
            if (CONNECTION_EXTRACTORS.some(x => x.candidateFile(rel, lower))) {
                yield { absPath: abs, relPath: rel, basename: ent.name };
            }
        }
    }
}

function applyResolution(hint: PhysicalEndpointHint, env: RepoEnvMap): PhysicalEndpointHint {
    const trail: string[] = [];
    let unresolved = false;

    const resolveField = (raw: string | number | undefined): { value: string; ok: boolean } => {
        if (raw === undefined || raw === null) return { value: '', ok: false };
        const s = typeof raw === 'string' ? raw : String(raw);
        if (!s) return { value: '', ok: false };
        const r = resolveTemplates(s, hint.templateSyntax, env);
        if (!r.resolved) unresolved = true;
        trail.push(...r.trail);
        return { value: r.value, ok: r.resolved };
    };

    const host = resolveField(hint.host).value;
    const dbName = resolveField(hint.dbName).value;
    // Port resolution: prefer portTemplate (env-var reference from plugins
    // like nestjs-config), then numeric port, then technology default.
    let port: number;
    if (hint.portTemplate) {
        const ptRes = resolveTemplates(hint.portTemplate, hint.templateSyntax, env);
        if (!ptRes.resolved) unresolved = true;
        trail.push(...ptRes.trail);
        port = parseInt(ptRes.value || '', 10);
        if (!Number.isFinite(port) || port <= 0) port = 0; // fall through to default below
    } else {
        const portRaw = hint.port ? String(hint.port) : '';
        const portRes = portRaw ? resolveTemplates(portRaw, hint.templateSyntax, env) : { value: '', resolved: true, trail: [] };
        if (!portRes.resolved) unresolved = true;
        trail.push(...portRes.trail);
        port = parseInt(portRes.value || '', 10);
    }
    if (!Number.isFinite(port) || port <= 0) port = defaultPort(hint.technology) || 0;

    const schemaOrNs = hint.schemaOrNs ? resolveField(hint.schemaOrNs).value : undefined;

    return {
        ...hint,
        host,
        dbName,
        port,
        schemaOrNs,
        isTemplate: unresolved,
        resolutionTrail: trail.length ? Array.from(new Set(trail)) : undefined,
    };
}

export interface PhysicalHintsResult {
    hints: PhysicalEndpointHint[];
    /** Raw unresolved hints (kept for diagnostics, never used for welding). */
    droppedTemplate: PhysicalEndpointHint[];
    envMap: RepoEnvMap;
    /**
     * Every env-var key consumed by the datastore extraction (plugin
     * classifications — including hint-less ones — DSN patterns, tech trios,
     * template references inside emitted hints). Downstream lanes (broker s0
     * host-shape) subtract this set: the extractors' own matchers are the
     * single source of truth, never a parallel regex.
     */
    claimedEnvKeys: Set<string>;
}

/** Env-key references inside template strings (the three template contracts). */
const TEMPLATE_KEY_PATTERNS = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /%env\((?:[a-z]+:)*([A-Z_][A-Z0-9_]*)\)%/g,
    /\$\{([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}/g,
];

function harvestTemplateEnvKeys(text: string | undefined, into: Set<string>): void {
    if (!text) return;
    for (const re of TEMPLATE_KEY_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) into.add(m[1]);
    }
}

export function extractAllPhysicalHints(repoPath: string): PhysicalHintsResult {
    // Declared env-accessor wrappers (coderadius.yaml `envAccessors`): their
    // call sites contribute code-referenced KEYS (visibility gate below) and
    // literal DEFAULT values (weakest env source, appended last). Accessor
    // keys are NOT claimed — claiming is for datastore-consumed keys only; a
    // broker host read through a wrapper must still reach the candidate lanes.
    const accessors = getEnvAccessors(loadRepoHints(repoPath));
    const accessorDefaults = scanCodeAccessorEnvVars(repoPath, accessors).defaults;
    const envMap = buildRepoEnvMap(repoPath, { accessorDefaults });
    const ctx: RepoCtx = { repoPath };
    const claimedEnvKeys = new Set<string>();

    const raw: PhysicalEndpointHint[] = [];
    for (const cand of walkRepo(repoPath)) {
        let content: string;
        try {
            const stats = fs.statSync(cand.absPath);
            if (stats.size > 512 * 1024) continue;
            content = fs.readFileSync(cand.absPath, 'utf8');
        } catch { continue; }
        for (const plugin of CONNECTION_EXTRACTORS) {
            if (!plugin.matches(cand.absPath, cand.basename)) continue;
            try {
                raw.push(...plugin.extract(cand.absPath, content, ctx));
                for (const key of plugin.claimEnvKeys?.(cand.absPath, content, ctx) ?? []) {
                    claimedEnvKeys.add(key);
                }
            } catch (e) {
                logger.debug(`[connection-extractors] ${plugin.name} threw on ${cand.relPath}: ${(e as Error).message}`);
            }
        }
    }

    // Synthesize hints directly from env-var trios (e.g. DATABASE_HOST + DATABASE_NAME).
    // Many customer repos rely on Helm/values.yaml or .env files alone — without an
    // ORM-level config file. The trios here let the orchestrator emit a hint anyway.
    //
    // The synthesizer is gated by `codeReferenced` — the set of env-var names
    // actually read by the analyzed repo's source code. Vars that exist in
    // deployment manifests (docker-compose sidecars, helm bundles) but are
    // never consumed by code are skipped, preventing phantom Datastore
    // identities for sidecar / unrelated services.
    const codeReferenced = scanCodeReferencedEnvVars(repoPath, accessors);
    raw.push(...synthesizeFromEnvTrios(envMap, codeReferenced, claimedEnvKeys));

    // Template references inside emitted hints are consumed keys too
    // (e.g. doctrine yaml `%env(DB_HOST)%`, typeorm `process.env.PG_HOST`).
    for (const hint of raw) {
        harvestTemplateEnvKeys(hint.host, claimedEnvKeys);
        harvestTemplateEnvKeys(hint.portTemplate, claimedEnvKeys);
        harvestTemplateEnvKeys(hint.dbName, claimedEnvKeys);
        harvestTemplateEnvKeys(hint.technology, claimedEnvKeys);
        for (const key of hint.resolutionTrail ?? []) claimedEnvKeys.add(key);
    }

    // Resolution pass — orchestrator owns this step
    const resolved = raw.map(h => applyResolution(h, envMap));

    // Filter unusable hints: only drop what isn't a real host at all —
    // empty values, sentinel placeholders, unresolved env templates.
    // Loopback (`localhost`, `127.0.0.1`) and Docker-Compose service
    // names (`mysql`, `db`, ...) ARE kept here: they bind in-repo. Their
    // exclusion from cross-repo fingerprint welding is enforced later
    // inside `buildPhysicalEndpoint` via `isUnfingerprintableHost`.
    const dropped: PhysicalEndpointHint[] = [];
    const usable: PhysicalEndpointHint[] = [];
    for (const h of resolved) {
        if (h.isTemplate) { dropped.push(h); continue; }
        if (isUnbindableHost(h.host)) { dropped.push(h); continue; }
        if (isUnusableLogicalName(h.dbName)) { dropped.push(h); continue; }
        h.technology = canonicalizeTechnology(h.technology);
        if (!h.port || h.port <= 0) h.port = defaultPort(h.technology);
        usable.push(h);
    }

    // Dedup by fingerprint, keep highest confidence.
    //
    // Hints whose host can't be fingerprint-welded across repos (loopback,
    // Docker-Compose service names) get a null fingerprint from
    // buildPhysicalEndpoint. We still emit them — they bind in-repo — but
    // they're routed through a separate non-dedupable bucket so two such
    // hints with the same shape don't silently collapse.
    const byFp = new Map<string, PhysicalEndpointHint>();
    const unfingerprinted: PhysicalEndpointHint[] = [];
    for (const h of usable) {
        const fp = buildPhysicalEndpoint({
            technology: h.technology,
            host: h.host,
            port: h.port,
            logicalName: h.dbName,
            schemaOrNs: h.schemaOrNs,
        });
        if (!fp) {
            unfingerprinted.push(h);
            continue;
        }
        const key = fp.fingerprint;
        const existing = byFp.get(key);
        if (!existing) byFp.set(key, h);
        else if (rank(h.confidence) > rank(existing.confidence)) byFp.set(key, h);
    }

    return {
        hints: [...byFp.values(), ...unfingerprinted],
        droppedTemplate: dropped,
        envMap,
        claimedEnvKeys,
    };
}

function rank(c: 'high' | 'medium' | 'low'): number {
    return c === 'high' ? 3 : c === 'medium' ? 2 : 1;
}

/**
 * Resolve a broker-connection hint's templated fields against the env map.
 * Host or vhost left unresolved → the WHOLE hint is dropped (never a partial
 * broker identity). Missing port falls back to the provider's published
 * default so config-declared identities converge with the s1 scheme lane.
 */
function resolveBrokerConnectionHint(hint: BrokerConnectionHint, env: RepoEnvMap): BrokerConnectionHint | null {
    const resolveField = (raw: string): string | null => {
        if (hint.templateSyntax === 'none') return raw;
        const r = resolveTemplates(raw, hint.templateSyntax, env);
        return r.resolved && r.value.trim().length > 0 ? r.value : null;
    };

    const host = resolveField(hint.host);
    if (!host) return null;
    const resolvedVhost = hint.vhost !== undefined ? resolveField(hint.vhost) : undefined;
    if (hint.vhost !== undefined && resolvedVhost === null) return null;
    const vhost = resolvedVhost ?? undefined;

    let port = hint.port;
    if (port === undefined && hint.portTemplate) {
        const resolved = resolveField(hint.portTemplate);
        const n = resolved ? parseInt(resolved, 10) : NaN;
        if (Number.isFinite(n) && n > 0) port = n;
    }
    if (port === undefined) port = brokerProviderDefaultPort(hint.provider);

    return { ...hint, host, vhost: vhost === '' ? '/' : vhost, port, portTemplate: undefined };
}

/**
 * Broker CONNECTIONS declared by config files (s4 lane). Same walk as the
 * datastore pass; broker env keys are NEVER claimed (see the accessor-keys
 * comment in extractAllPhysicalHints) — dedup against the env lanes happens
 * via candidate identity (serviceUrn, host, port, vhost) + provider rank.
 */
export function extractAllBrokerConnectionHints(repoPath: string, env: RepoEnvMap): BrokerConnectionHint[] {
    const ctx: RepoCtx = { repoPath };
    const out: BrokerConnectionHint[] = [];
    for (const cand of walkRepo(repoPath)) {
        let content: string;
        try {
            const stats = fs.statSync(cand.absPath);
            if (stats.size > 512 * 1024) continue;
            content = fs.readFileSync(cand.absPath, 'utf8');
        } catch { continue; }
        for (const plugin of CONNECTION_EXTRACTORS) {
            if (!plugin.extractBrokers || !plugin.matches(cand.absPath, cand.basename)) continue;
            try {
                for (const hint of plugin.extractBrokers(cand.absPath, content, ctx)) {
                    const resolved = resolveBrokerConnectionHint(hint, env);
                    if (resolved) out.push(resolved);
                }
            } catch (e) {
                logger.debug(`[connection-extractors] ${plugin.name}.extractBrokers threw on ${cand.relPath}: ${(e as Error).message}`);
            }
        }
    }
    return out;
}

function deriveAliasFromDsnKey(key: string): string {
    // PRIMARY_DATABASE_URL → 'primary', READ_DB_URL → 'read', DATABASE_URL → 'default'
    const lc = key.toLowerCase();
    const m = /^([a-z][a-z0-9_]+?)_(?:database|db)_url$/.exec(lc);
    if (m) return m[1];
    return 'default';
}

// ─────────────────────────────────────────────────────────────────────────────
// Env-var trio synthesis
//
// Some customers ship neither a TypeORM data-source.ts nor a Doctrine YAML —
// they rely on framework-level env-var injection (NestJS registerAs, Helm,
// docker-compose). For those, recognize standard naming triples and emit a
// PhysicalEndpointHint directly from the env-map.
// ─────────────────────────────────────────────────────────────────────────────

// `defaultDbName` lets a tech with no logical-database concept (memcached) still
// synthesize a hint from a host-only trio: the trio loop requires a dbName, so
// without it a `MEMCACHED_HOST`/`MEMCACHED_SERVERS` value alone would be dropped.
const TECH_KEYWORDS: Array<{ tech: string; hostKeys: string[]; dbKeys: string[]; portKeys: string[]; defaultDbName?: string }> = [
    { tech: 'mysql',    hostKeys: ['MYSQL_HOST', 'MYSQL_HOSTS'],     dbKeys: ['MYSQL_DATABASE', 'MYSQL_DB', 'MYSQL_DBNAME'], portKeys: ['MYSQL_PORT'] },
    { tech: 'postgres', hostKeys: ['POSTGRES_HOST', 'POSTGRES_HOSTS', 'PGHOST'], dbKeys: ['POSTGRES_DB', 'POSTGRES_DATABASE', 'PGDATABASE'], portKeys: ['POSTGRES_PORT', 'PGPORT'] },
    // Mongo replica-sets commonly use the plural `MONGO_HOSTS`. As a fallback
    // for charts that don't set an explicit DBNAME, accept `MONGO_AUTHSOURCE`
    // (the auth db routinely doubles as the application db in Helm charts).
    { tech: 'mongodb',  hostKeys: ['MONGO_HOST', 'MONGO_HOSTS', 'MONGODB_HOST', 'MONGODB_HOSTS'], dbKeys: ['MONGO_DBNAME', 'MONGO_DATABASE', 'MONGO_DB', 'MONGO_AUTHSOURCE'], portKeys: ['MONGO_PORT', 'MONGODB_PORT'] },
    { tech: 'redis',    hostKeys: ['REDIS_HOST', 'REDIS_HOSTS'],     dbKeys: ['REDIS_DB'],     portKeys: ['REDIS_PORT'] },
    // Memcached has no logical DB; `MEMCACHED_SERVERS` carries `host:port`
    // verbatim (Laravel/Symfony convention), parsed by the trio's host:port split.
    { tech: 'memcached', hostKeys: ['MEMCACHED_HOST', 'MEMCACHED_HOSTS', 'MEMCACHED_SERVERS'], dbKeys: [], portKeys: ['MEMCACHED_PORT'], defaultDbName: 'memcached' },
    // InfluxDB: 1.x uses a logical database (INFLUXDB_SCHEMA/_DATABASE/_DB), 2.x a
    // bucket (INFLUXDB_BUCKET). defaultDbName lets a host-only trio still synthesize
    // a hint, mirroring memcached, so a metrics store is never silently dropped.
    { tech: 'influxdb', hostKeys: ['INFLUXDB_HOST', 'INFLUX_HOST'], dbKeys: ['INFLUXDB_SCHEMA', 'INFLUXDB_DATABASE', 'INFLUXDB_DB', 'INFLUXDB_BUCKET'], portKeys: ['INFLUXDB_PORT', 'INFLUX_PORT'], defaultDbName: 'influxdb' },
];

const PREFIXED_HOST_RE = /^(?:DB|DATABASE)(?:_([A-Z0-9]+))?_(?:HOST|HOSTNAME)$/;

// HTTP-API datastores expose their connection as a plain `http(s)://host:port`
// URL, so the technology is keyed on the env-var NAME, not the URL scheme
// (parseDsn is scheme-keyed and cannot classify them). Declarative table — a new
// HTTP-API store is one row, no per-tech branch. `defaultDbName` gives the
// logical identity a stable name (these stores have no path-segment db in the URL).
const HTTP_API_URL_TECH: Array<{ re: RegExp; tech: string; defaultDbName: string }> = [
    { re: /^INFLUX(?:DB)?_URL$/, tech: 'influxdb', defaultDbName: 'influxdb' },
];

/**
 * Variables that are likely to hold a complete connection-URL (DSN).
 * Order does not matter — every match is parsed independently.
 *
 * SECURITY: parseDsn() strips username/password by design. Credentials are
 * never returned, never logged, never enter the fingerprint.
 */
const DSN_KEY_PATTERNS: RegExp[] = [
    /^DATABASE_URL$/,
    /^DATABASE_URI$/,
    /^DB_URL$/,
    /^DB_URI$/,
    /^MONGO_URL$/, /^MONGO_URI$/, /^MONGODB_URL$/, /^MONGODB_URI$/,
    /^REDIS_URL$/, /^REDIS_URI$/,
    /^MEMCACHED_URL$/, /^MEMCACHED_URI$/,
    /^POSTGRES_URL$/, /^POSTGRES_URI$/, /^PGURL$/,
    /^MYSQL_URL$/, /^MYSQL_URI$/,
    /^INFLUXDB_URL$/, /^INFLUXDB_URI$/, /^INFLUX_URL$/,
    /^[A-Z][A-Z0-9_]+_DATABASE_URL$/,           // e.g. PRIMARY_DATABASE_URL, READ_DATABASE_URL
    /^[A-Z][A-Z0-9_]+_DB_URL$/,
    /^JDBC_URL$/, /^SPRING_DATASOURCE_URL$/,
];

function synthesizeFromEnvTrios(
    env: RepoEnvMap,
    codeReferenced: ReadonlySet<string>,
    claimedKeys?: Set<string>,
): PhysicalEndpointHint[] {
    const out: PhysicalEndpointHint[] = [];
    // When the scanner finds at least one referenced env var, gate every
    // get() on the set: deployment-only vars (sidecar containers,
    // unrelated services) are excluded. When the scanner finds zero
    // (e.g. binary-only repo or scanner failure), fall back to the
    // unfiltered behaviour so we don't break repos with dynamic
    // env-var name construction.
    const useCodeFilter = codeReferenced.size > 0;
    const get = (k: string): { value: string; conf: 'high'|'medium'|'low'; src: string } | undefined => {
        const e = env.vars.get(k);
        if (!e || !e.value || !e.value.trim()) return undefined;
        if (useCodeFilter && !codeReferenced.has(k)) return undefined;
        // Every key this extractor consumes is CLAIMED: downstream lanes
        // (broker s0 host-shape) subtract the set instead of re-implementing
        // the matching with a parallel regex.
        claimedKeys?.add(k);
        return { value: e.value, conf: e.confidence, src: e.sourceFile };
    };

    // 0. DSN-style single-variable URLs (DATABASE_URL, DB_URI, MONGO_URL, …).
    //    parseDsn() drops credentials at parse time — they never reach the hint.
    for (const [key, entry] of env.vars.entries()) {
        const isDsnKey = DSN_KEY_PATTERNS.some(re => re.test(key));
        const httpApi = HTTP_API_URL_TECH.find(e => e.re.test(key));
        if (!isDsnKey && !httpApi) continue;
        // CLAIM before the code filter: a datastore-shaped key is datastore
        // lane territory whether or not the scanner saw a code reference —
        // skipping EMISSION (phantom guard) must not leak the key to the
        // broker s0 lane.
        claimedKeys?.add(key);
        if (useCodeFilter && !codeReferenced.has(key)) continue;
        const parsed = parseDsn(entry.value);
        if (parsed) {
            out.push({
                technology: parsed.technology,
                host: parsed.host,
                port: parsed.port ?? 0,
                dbName: parsed.dbName,
                schemaOrNs: parsed.schemaOrNs,
                connectionAlias: deriveAliasFromDsnKey(key),
                sourceFile: entry.sourceFile,
                confidence: entry.confidence,
                templateSyntax: 'none',
                isTemplate: false,
                resolutionTrail: [key],
                // A recognized DSN scheme (mysql://, mongodb://, …) self-declares
                // this is a datastore — high-confidence for standalone promotion.
                viaDsnScheme: true,
            });
            continue;
        }
        // HTTP-API datastore: scheme is plain http(s), tech keyed on the var name.
        if (httpApi) {
            const hp = parseHttpUrlHostPort(entry.value);
            if (!hp) continue;
            out.push({
                technology: httpApi.tech,
                host: hp.host,
                port: hp.port || defaultPort(httpApi.tech),
                dbName: httpApi.defaultDbName,
                connectionAlias: deriveAliasFromDsnKey(key),
                sourceFile: entry.sourceFile,
                confidence: entry.confidence,
                templateSyntax: 'none',
                isTemplate: false,
                resolutionTrail: [key],
            });
        }
    }

    // 1. Tech-prefixed triples (MYSQL_HOST + MYSQL_DATABASE, etc.)
    for (const t of TECH_KEYWORDS) {
        const host = t.hostKeys.map(get).find(x => x);
        const db = t.dbKeys.map(get).find(x => x);
        // Techs with no logical DB (memcached) fall back to defaultDbName so a
        // host-only trio still yields a hint instead of being silently dropped.
        const dbValue = db?.value ?? t.defaultDbName;
        if (!host || !dbValue) continue;
        const portRaw = t.portKeys.map(get).find(x => x);
        // host may be in `host:port` or `host:port,host2:port2` form (Mongo
        // replica-set syntax). Take the first host segment and parse the
        // port if present.
        let hostValue = host.value.split(',')[0]?.trim() ?? host.value;
        let port = portRaw ? parseInt(portRaw.value, 10) || 0 : 0;
        const portMatch = hostValue.match(/^(.+?):(\d{1,5})$/);
        if (portMatch) {
            hostValue = portMatch[1];
            if (!port) port = parseInt(portMatch[2], 10) || 0;
        }
        out.push({
            technology: t.tech,
            host: hostValue, port, dbName: dbValue,
            sourceFile: host.src,
            confidence: host.conf,
            templateSyntax: 'none',
            isTemplate: false,
        });
    }

    // 2. Generic DATABASE_HOST + DATABASE_NAME(+TYPE) and DB_HOST + DB_SCHEMA / DB_NAME.
    //    DB_SCHEMA is a Doctrine/MySQL convention — same physical role as DB_NAME.
    let dbHostKey: string | null = null;
    let dbHost = get('DATABASE_HOST'); if (dbHost) dbHostKey = 'DATABASE_HOST';
    if (!dbHost) { dbHost = get('DB_HOST'); if (dbHost) dbHostKey = 'DB_HOST'; }

    let dbNameKey: string | null = null;
    let dbName = get('DATABASE_NAME'); if (dbName) dbNameKey = 'DATABASE_NAME';
    if (!dbName) { dbName = get('DB_NAME'); if (dbName) dbNameKey = 'DB_NAME'; }
    if (!dbName) { dbName = get('DATABASE_DBNAME'); if (dbName) dbNameKey = 'DATABASE_DBNAME'; }
    if (!dbName) { dbName = get('DB_SCHEMA'); if (dbName) dbNameKey = 'DB_SCHEMA'; }
    if (!dbName) { dbName = get('DATABASE_SCHEMA'); if (dbName) dbNameKey = 'DATABASE_SCHEMA'; }

    if (dbHost && dbName && dbNameKey) {
        const dbType = get('DATABASE_TYPE') || get('DB_TYPE') || get('DB_DRIVER') || get('DATABASE_DRIVER');
        const dbPortRaw = get('DATABASE_PORT') || get('DB_PORT');
        let host = dbHost.value;
        let port = dbPortRaw ? parseInt(dbPortRaw.value, 10) || 0 : 0;
        // host may contain ":port" — normalise.
        const portMatch = host.match(/^(.+?):(\d{1,5})$/);
        if (portMatch) {
            host = portMatch[1];
            if (!port) port = parseInt(portMatch[2], 10) || 0;
        }
        let tech = (dbType?.value || '').toLowerCase();
        // PHP PDO/driver tokens (pdo_mysql, mysqli, oci8, ...) are plugin
        // grammar: exact-token lookup owned by the doctrine plugin. The
        // substring branches below only canonicalize cross-language words.
        tech = doctrineDriverToTech(tech) ?? tech;
        if (tech.includes('mysql') || tech.includes('mariadb')) tech = 'mysql';
        else if (tech.includes('pgsql') || tech.includes('postgres')) tech = 'postgres';
        else if (tech.includes('mongo')) tech = 'mongodb';
        if (!tech && (dbNameKey === 'DB_SCHEMA' || dbNameKey === 'DATABASE_SCHEMA')) {
            tech = DB_SCHEMA_DEFAULT_TECH_HEURISTIC.value;
        }
        if (['mysql', 'postgres', 'mongodb', 'redis'].includes(tech)) {
            out.push({
                technology: tech,
                host, port, dbName: dbName.value,
                sourceFile: dbHost.src,
                confidence: dbHost.conf,
                templateSyntax: 'none',
                isTemplate: false,
            });
        }
    }

    // 3. Prefixed pattern: DB_<X>_HOST + DB_<X>_DBNAME (e.g. DB_PRIMARY_HOST + DB_PRIMARY_DBNAME).
    const seenPrefixes = new Set<string>();
    for (const k of env.vars.keys()) {
        const m = PREFIXED_HOST_RE.exec(k);
        if (!m) continue;
        const prefix = m[1] ?? '';
        if (seenPrefixes.has(prefix)) continue;
        seenPrefixes.add(prefix);
        const hostKey = prefix ? `DB_${prefix}_HOST` : 'DB_HOST';
        const hostnameKey = prefix ? `DB_${prefix}_HOSTNAME` : 'DB_HOSTNAME';
        const dbnameKey = prefix ? `DB_${prefix}_DBNAME` : 'DB_DBNAME';
        const databaseKey = prefix ? `DB_${prefix}_DATABASE` : 'DB_DATABASE';
        const driverKey = prefix ? `DB_${prefix}_DRIVER` : 'DB_DRIVER';
        const portKey = prefix ? `DB_${prefix}_PORT` : 'DB_PORT';

        const host = get(hostKey) ?? get(hostnameKey);
        const db = get(dbnameKey) ?? get(databaseKey);
        if (!host || !db) continue;
        const driver = get(driverKey);
        const portRaw = get(portKey);
        const port = portRaw ? parseInt(portRaw.value, 10) || 0 : 0;
        let tech = '';
        if (driver) {
            const v = driver.value.toLowerCase();
            if (v.includes('mysql')) tech = 'mysql';
            else if (v.includes('pgsql') || v.includes('postgres')) tech = 'postgres';
            else if (v.includes('mongo')) tech = 'mongodb';
        }
        if (!tech) tech = 'mysql'; // most common default for DB_<X>_* customer pattern; refined later if available
        out.push({
            technology: tech,
            host: host.value, port, dbName: db.value,
            connectionAlias: prefix.toLowerCase() || 'default',
            sourceFile: host.src,
            confidence: host.conf,
            templateSyntax: 'none',
            isTemplate: false,
        });
    }

    // 4. Suffix-grouped helm/k8s pattern: <TECH>_HOST(N|S)?_<SUFFIX> +
    //    companion dbName key (DATABASE / DBNAME / AUTHSOURCE).
    //
    //    Common when a repo connects to multiple logical clusters of the
    //    same technology — e.g. `MONGODB_HOST1_ARCHIVE` + `MONGODB_HOST1_IH`
    //    for two distinct Mongo replica-sets in production helm. The
    //    suffix doubles as connectionAlias so identities stay separate.
    //
    //    Replica-set host arrays (HOST1/HOST2/HOST3) collapse to the FIRST
    //    matched entry; physical-fingerprint suppression handles the
    //    cross-repo welding concern.
    const SUFFIX_HOST_RE = /^(MYSQL|MARIADB|POSTGRES|POSTGRESQL|PG|MONGO|MONGODB|REDIS)_HOSTS?(?:\d+)?_([A-Z][A-Z0-9_]*)$/;
    const techCanon: Record<string, string> = {
        MYSQL: 'mysql', MARIADB: 'mysql',
        POSTGRES: 'postgres', POSTGRESQL: 'postgres', PG: 'postgres',
        MONGO: 'mongodb', MONGODB: 'mongodb',
        REDIS: 'redis',
    };
    const suffixSeen = new Set<string>();
    for (const k of env.vars.keys()) {
        const m = SUFFIX_HOST_RE.exec(k);
        if (!m) continue;
        const techKey = m[1];
        const suffix = m[2];
        const groupKey = `${techCanon[techKey] ?? techKey}|${suffix}`;
        if (suffixSeen.has(groupKey)) continue;
        suffixSeen.add(groupKey);

        const hostEntry = get(k);
        if (!hostEntry) continue;
        const tech = techCanon[techKey];

        // Companion dbName key (technology-specific candidate ordering).
        const dbCandidates = [
            `${techKey}_DATABASE_${suffix}`,
            `${techKey}_DBNAME_${suffix}`,
            `${techKey}_DB_${suffix}`,
        ];
        if (tech === 'mongodb') {
            dbCandidates.push(`MONGODB_AUTHSOURCE_${suffix}`, `MONGO_AUTHSOURCE_${suffix}`);
        }
        let dbEntry: ReturnType<typeof get> | undefined;
        for (const dk of dbCandidates) {
            dbEntry = get(dk);
            if (dbEntry) break;
        }
        if (!dbEntry) continue;

        // Replica-set hosts may be comma-separated; take the first.
        let hostValue = hostEntry.value.split(',')[0]?.trim() ?? hostEntry.value;
        let port = 0;
        const portEntry = get(`${techKey}_PORT_${suffix}`) ?? get(`${techKey}_PORT1_${suffix}`);
        if (portEntry) port = parseInt(portEntry.value, 10) || 0;
        const portMatch = hostValue.match(/^(.+?):(\d{1,5})$/);
        if (portMatch) {
            hostValue = portMatch[1];
            if (!port) port = parseInt(portMatch[2], 10) || 0;
        }

        out.push({
            technology: tech,
            host: hostValue, port, dbName: dbEntry.value,
            connectionAlias: suffix.toLowerCase(),
            sourceFile: hostEntry.src,
            confidence: hostEntry.conf,
            templateSyntax: 'none',
            isTemplate: false,
        });
    }

    return out;
}
