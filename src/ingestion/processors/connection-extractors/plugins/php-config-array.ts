import path from 'node:path';
import type { BrokerConnectionHint, ConnectionExtractor, PhysicalEndpointHint, RepoCtx } from '../types.js';
import { parsePhpReturnConfig, type PhpConfigParseOptions } from '../../../core/languages/php/config-array.js';
import { buildAccessorValueHook } from '../env-accessor-scanner.js';
import { parseHostPortVhost } from '../env-var-resolver.js';
import { getEnvAccessors, loadRepoHints } from '../../../../config/repo-hints.js';
import { defineHeuristic } from '../../../core/heuristics.js';
import { aggregateSyntaxes, classifyTemplate } from '../template-syntax.js';
import { doctrineDriverToTech } from './doctrine.js';

/**
 * PHP config-array datastore plugin.
 *
 * Reads `return [...]` PHP config files (Laminas/Mezzio autoload, Symfony
 * config-as-PHP) for the two published doctrine connection shapes:
 *
 *   (a) doctrine-orm-module:
 *       return ['doctrine' => ['connection' => [
 *           'orm_default' => [
 *               'driverClass' => \Doctrine\DBAL\Driver\PDOMySql\Driver::class,
 *               'params' => ['host' => ..., 'port' => ..., 'dbname' => ...],
 *           ],
 *       ]]];
 *
 *   (b) Symfony dbal expressed as a PHP array:
 *       return ['doctrine' => ['dbal' => ['connections' => [
 *           'default' => ['driver' => 'pdo_pgsql', 'host' => ..., 'dbname' => ...],
 *       ]]]];
 *
 * Accessor-wrapped values (`EnvVault::fetch('KEY', 'default')`, declared via
 * coderadius.yaml `envAccessors`) are translated to `${KEY:-default}` shell
 * templates by the parser hook; the orchestrator's `applyResolution` resolves
 * them against the repo env map (which already carries the harvested
 * accessor defaults).
 *
 * Technology resolution is contract-first: `driverClass` FQCN (`::class`
 * literal, use-alias aware) or PDO driver token. A connection with an
 * EXPLICIT but unknown driver is skipped — never guessed over a declared
 * driver. Only a driver-less host+dbname pair falls back to the declared
 * convention-guess below.
 */

const PHP_DOCTRINE_DEFAULT_TECH_HEURISTIC = defineHeuristic({
    id: 'php-doctrine-default-tech',
    class: 'convention-guess',
    emits: "Datastore technology 'mysql' when a doctrine PHP config declares host+dbname without any driver",
    surfacedBy: 'hint confidence medium + Datastore needsReview downstream',
    value: 'mysql' as const,
});

/** Published Doctrine DBAL driver FQCNs (both pre-3.x and 3.x layouts). */
const DRIVER_CLASS_TO_TECH: Record<string, string> = {
    'Doctrine\\DBAL\\Driver\\PDO\\MySQL\\Driver': 'mysql',
    'Doctrine\\DBAL\\Driver\\PDOMySql\\Driver': 'mysql',
    'Doctrine\\DBAL\\Driver\\Mysqli\\Driver': 'mysql',
    'Doctrine\\DBAL\\Driver\\PDO\\PgSQL\\Driver': 'postgres',
    'Doctrine\\DBAL\\Driver\\PDOPgSql\\Driver': 'postgres',
    'Doctrine\\DBAL\\Driver\\PDO\\SQLite\\Driver': 'sqlite',
    'Doctrine\\DBAL\\Driver\\PDOSqlite\\Driver': 'sqlite',
    'Doctrine\\DBAL\\Driver\\PDO\\SQLSrv\\Driver': 'sqlserver',
    'Doctrine\\DBAL\\Driver\\SQLSrv\\Driver': 'sqlserver',
    'Doctrine\\DBAL\\Driver\\PDO\\OCI\\Driver': 'oracle',
    'Doctrine\\DBAL\\Driver\\OCI8\\Driver': 'oracle',
};

const CANDIDATE_PATH_RE = /(^|\/)config\/.*\.php$/i;
/** `use Foo\Bar;` / `use Foo\Bar as Baz;` — published PHP import syntax. */
const USE_STATEMENT_RE = /^\s*use\s+\\?([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;/gm;
const TEMPLATE_KEY_RE = /\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}/g;

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Map of alias → FQCN from the file's `use` statements (default alias = tail). */
function extractUseAliases(content: string): Map<string, string> {
    const out = new Map<string, string>();
    USE_STATEMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = USE_STATEMENT_RE.exec(content)) !== null) {
        const fqcn = m[1];
        const alias = m[2] ?? fqcn.split('\\').pop()!;
        out.set(alias, fqcn);
    }
    return out;
}

/** `driverClass` value (FQCN or use-alias) → canonical technology. */
function driverClassToTech(value: string, aliases: Map<string, string>): string | undefined {
    const fqcn = value.includes('\\') ? value : aliases.get(value) ?? value;
    return DRIVER_CLASS_TO_TECH[fqcn];
}

function accessorParseOpts(ctx: RepoCtx): PhpConfigParseOptions | undefined {
    const hook = buildAccessorValueHook(getEnvAccessors(loadRepoHints(ctx.repoPath)));
    return hook ? { accessorValue: hook } : undefined;
}

interface RawConnection {
    alias: string;
    params: Dict;
    driverClass?: string;
    driverToken?: string;
}

/** Shape (a): `doctrine.connection.<name>.{driverClass, params{...}}`. */
function readOrmModuleConnections(doctrine: Dict): RawConnection[] {
    const out: RawConnection[] = [];
    const conns = asDict(doctrine.connection);
    for (const [alias, raw] of Object.entries(conns ?? {})) {
        const dict = asDict(raw);
        if (!dict) continue;
        const params = asDict(dict.params) ?? {};
        out.push({
            alias,
            params,
            driverClass: asString(dict.driverClass) ?? asString(params.driverClass),
            driverToken: asString(params.driver),
        });
    }
    return out;
}

/** Shape (b): `doctrine.dbal.connections.<name>.{driver, host, dbname, ...}`. */
function readDbalPhpConnections(doctrine: Dict): RawConnection[] {
    const out: RawConnection[] = [];
    const conns = asDict(asDict(doctrine.dbal)?.connections);
    for (const [alias, raw] of Object.entries(conns ?? {})) {
        const params = asDict(raw);
        if (!params) continue;
        out.push({ alias, params, driverToken: asString(params.driver) });
    }
    return out;
}

/**
 * Resolve the connection's technology. Contract sources first (driverClass
 * FQCN, PDO token); an EXPLICIT unknown driver is never guessed over; the
 * mysql convention-guess applies only to fully driver-less connections.
 */
function resolveTech(
    conn: RawConnection,
    aliases: Map<string, string>,
): { tech: string; confidence: 'high' | 'medium' } | null {
    if (conn.driverClass) {
        const tech = driverClassToTech(conn.driverClass, aliases);
        return tech ? { tech, confidence: 'high' } : null;
    }
    if (conn.driverToken) {
        const tech = doctrineDriverToTech(conn.driverToken.toLowerCase());
        return tech ? { tech, confidence: 'high' } : null;
    }
    return { tech: PHP_DOCTRINE_DEFAULT_TECH_HEURISTIC.value, confidence: 'medium' };
}

function hintFor(conn: RawConnection, aliases: Map<string, string>, sourceFile: string): PhysicalEndpointHint | null {
    const host = asString(conn.params.host);
    const dbName = asString(conn.params.dbname);
    if (!host || !dbName) return null;
    const resolved = resolveTech(conn, aliases);
    if (!resolved) return null;

    const port = conn.params.port;
    const portTemplate = asString(port);
    return {
        technology: resolved.tech,
        host,
        port: typeof port === 'number' ? port : 0,
        portTemplate,
        dbName,
        connectionAlias: conn.alias,
        sourceFile,
        confidence: resolved.confidence,
        templateSyntax: aggregateSyntaxes([host, dbName, portTemplate]),
    };
}

/** All template keys referenced anywhere under the doctrine subtree. */
function harvestTemplateKeys(value: unknown, into: Set<string>): void {
    if (typeof value === 'string') {
        TEMPLATE_KEY_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TEMPLATE_KEY_RE.exec(value)) !== null) into.add(m[1]);
        return;
    }
    if (Array.isArray(value)) {
        for (const v of value) harvestTemplateKeys(v, into);
        return;
    }
    const dict = asDict(value);
    if (dict) for (const v of Object.values(dict)) harvestTemplateKeys(v, into);
}

function parseDoctrineSection(content: string, ctx: RepoCtx): Dict | null {
    // Cheap pre-gate before the tree-sitter parse: the content signature is
    // the recognizer, the filename only shortlists candidates.
    if (!content.includes('doctrine')) return null;
    const config = asDict(parsePhpReturnConfig(content, accessorParseOpts(ctx)));
    return asDict(config?.doctrine);
}

// ─── Broker connections (s4 config-declared lane) ───────────────────────────

/**
 * Vhost policy (explicit, see BrokerConnectionHint):
 *   key absent → contractual AMQP default '/' ;  '' → '/' ;
 *   literal/template string → kept (template resolved by the registry) ;
 *   unresolvable expression (null) → the WHOLE connection is dropped.
 * Returns `null` for "drop".
 */
function vhostOf(dict: Dict): string | null {
    if (!('vhost' in dict)) return '/';
    if (typeof dict.vhost !== 'string') return null;
    return dict.vhost === '' ? '/' : dict.vhost;
}

/** Shape: oldsound/laminas `rabbitmq.connection.<name>{host,port,vhost}`. */
function laminasBrokerHints(config: Dict, sourceFile: string): BrokerConnectionHint[] {
    const conns = asDict(asDict(config.rabbitmq)?.connection);
    const out: BrokerConnectionHint[] = [];
    for (const [connectionName, raw] of Object.entries(conns ?? {})) {
        const dict = asDict(raw);
        const host = dict ? asString(dict.host) : undefined;
        if (!dict || !host) continue;
        const vhost = vhostOf(dict);
        if (vhost === null) continue;
        const portTemplate = asString(dict.port);
        const syntax = aggregateSyntaxes([host, vhost, portTemplate]);
        out.push({
            provider: 'rabbitmq',
            providerSource: 'declared',
            host,
            port: typeof dict.port === 'number' ? dict.port : undefined,
            portTemplate,
            vhost,
            connectionName,
            sourceType: 'config',
            templateSyntax: syntax,
            sourceFile,
            confidence: syntax === 'none' ? 'high' : 'medium',
        });
    }
    return out;
}

/**
 * Shape: messenger transports with a LITERAL amqp DSN. Template-bearing DSNs
 * are skipped (env-lane citizens, resolved via s1 when their env value
 * resolves); a bare `amqp://` carries no host and is dropped.
 */
function messengerBrokerHints(config: Dict, sourceFile: string): BrokerConnectionHint[] {
    const messenger = asDict(config.messenger) ?? asDict(asDict(config.symfony)?.messenger);
    const transports = asDict(messenger?.transports);
    const out: BrokerConnectionHint[] = [];
    for (const [connectionName, raw] of Object.entries(transports ?? {})) {
        const dsn = asString(asDict(raw)?.dsn);
        if (!dsn || classifyTemplate(dsn) !== 'none') continue;
        const scheme = dsn.startsWith('amqps://') ? 'amqps' : dsn.startsWith('amqp://') ? 'amqp' : null;
        if (!scheme) continue;
        const parsed = parseHostPortVhost(dsn, scheme);
        if (!parsed?.host) continue;
        out.push({
            provider: 'rabbitmq',
            providerSource: 'declared',
            host: parsed.host,
            port: parsed.port ?? (scheme === 'amqps' ? 5671 : 5672),
            vhost: decodeURIComponent(parsed.vhost ?? '') || '/',
            connectionName,
            sourceType: 'config',
            templateSyntax: 'none',
            sourceFile,
            confidence: 'high',
        });
    }
    return out;
}

export const phpConfigArrayExtractor: ConnectionExtractor = {
    name: 'php-config-array',
    priority: 75,

    candidateFile(relPath, _lowerBasename) {
        return CANDIDATE_PATH_RE.test(relPath);
    },

    matches(absPath, _basename) {
        return CANDIDATE_PATH_RE.test(absPath.replace(/\\/g, '/'));
    },

    extract(absPath, content, ctx: RepoCtx): PhysicalEndpointHint[] {
        const doctrine = parseDoctrineSection(content, ctx);
        if (!doctrine) return [];

        const aliases = extractUseAliases(content);
        const sourceFile = path.relative(ctx.repoPath, absPath);
        const out: PhysicalEndpointHint[] = [];
        for (const conn of [...readOrmModuleConnections(doctrine), ...readDbalPhpConnections(doctrine)]) {
            const hint = hintFor(conn, aliases, sourceFile);
            if (hint) out.push(hint);
        }
        return out;
    },

    claimEnvKeys(_absPath, content, ctx: RepoCtx): string[] {
        const doctrine = parseDoctrineSection(content, ctx);
        if (!doctrine) return [];
        // Keys referenced anywhere under the DATASTORE subtree are
        // datastore-consumed (claimed even when the hint is dropped). Broker
        // sections (rabbitmq, messenger) are deliberately NOT claimed — see
        // the registry comment: broker keys must reach the candidate lanes.
        const keys = new Set<string>();
        harvestTemplateKeys(doctrine.connection, keys);
        harvestTemplateKeys(asDict(doctrine.dbal)?.connections, keys);
        return [...keys];
    },

    extractBrokers(absPath, content, ctx: RepoCtx): BrokerConnectionHint[] {
        if (!content.includes('rabbitmq') && !content.includes('messenger')) return [];
        const config = asDict(parsePhpReturnConfig(content, accessorParseOpts(ctx)));
        if (!config) return [];
        const sourceFile = path.relative(ctx.repoPath, absPath);
        return [
            ...laminasBrokerHints(config, sourceFile),
            ...messengerBrokerHints(config, sourceFile),
        ];
    },
};
