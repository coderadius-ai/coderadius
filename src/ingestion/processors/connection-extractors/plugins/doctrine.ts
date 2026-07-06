import path from 'node:path';
import yaml from 'js-yaml';
import type { ConnectionExtractor, PhysicalEndpointHint, RepoCtx, TemplateSyntax } from '../types.js';
import { parseDsn } from '../dsn-parser.js';
import { aggregateSyntaxes, classifyTemplate } from '../template-syntax.js';

/**
 * Doctrine config plugin.
 *
 * Targets:
 *   - config/packages/doctrine.yaml
 *   - config/packages/{env}/doctrine.yaml
 *   - config/doctrine.yaml
 *
 * Parses `doctrine.dbal.connections.<alias>.{url,host,port,dbname,driver,server_version}`
 * and `doctrine.orm.entity_managers.<alias>.{connection,mappings}` to bind entities
 * (PSR-4 namespace prefixes) to a connection alias.
 *
 * Symfony config commonly uses `%env(resolve:VAR)%` for the URL. The plugin returns
 * the literal template — the orchestrator owns env-var resolution.
 */

const PATH_RE = /\/?config\/(packages\/(?:[^/]+\/)?)?doctrine\.ya?ml$/;
/** Repo-relative discovery shape (boundary-anchored `config/` segment). */
const CANDIDATE_PATH_RE = /(^|\/)config\/(packages\/(?:[^/]+\/)?)?doctrine\.ya?ml$/;

const DRIVER_TO_TECH: Record<string, string> = {
    'pdo_mysql': 'mysql', 'mysqli': 'mysql', 'mysql': 'mysql',
    'pdo_pgsql': 'postgres', 'pgsql': 'postgres', 'postgres': 'postgres', 'postgresql': 'postgres',
    'pdo_sqlsrv': 'sqlserver', 'sqlsrv': 'sqlserver',
    'pdo_oci': 'oracle', 'oci8': 'oracle',
    'pdo_sqlite': 'sqlite', 'sqlite3': 'sqlite',
    'mongodb': 'mongodb',
};

/**
 * Doctrine/PDO driver token → canonical technology (exact-token lookup).
 * Exported for the env-var synthesis lane in the registry: PDO driver
 * grammar (`pdo_mysql`, `mysqli`, `oci8`, ...) is PHP-ecosystem knowledge
 * and lives in THIS plugin; the agnostic registry only canonicalizes
 * cross-language technology words.
 */
export function doctrineDriverToTech(token: string): string | undefined {
    return DRIVER_TO_TECH[token];
}


interface DbalConnection {
    alias: string;
    url?: string;
    host?: string;
    port?: number | string;
    dbname?: string;
    driver?: string;
    serverVersion?: string;
    schema?: string;
}

interface EntityManager {
    alias: string;
    connection: string;
    mappingPrefixes: string[];
}

function parseUrlValue(url: string): { tech?: string; host?: string; port?: number; dbname?: string; schemaOrNs?: string } {
    // Templates are deferred to the orchestrator's env-var resolution pass.
    if (classifyTemplate(url) !== 'none') return {};
    const parsed = parseDsn(url);
    if (!parsed) return {};
    return {
        tech: parsed.technology,
        host: parsed.host,
        port: parsed.port ?? undefined,
        dbname: parsed.dbName,
        schemaOrNs: parsed.schemaOrNs,
    };
}

function readConnections(doc: any): DbalConnection[] {
    const out: DbalConnection[] = [];
    const dbal = doc?.doctrine?.dbal;
    if (!dbal) return out;

    if (dbal.connections && typeof dbal.connections === 'object') {
        for (const [alias, conn] of Object.entries<any>(dbal.connections)) {
            out.push({
                alias,
                url: conn?.url,
                host: conn?.host,
                port: conn?.port,
                dbname: conn?.dbname,
                driver: conn?.driver,
                serverVersion: conn?.server_version,
                schema: conn?.schema_filter ?? conn?.schema,
            });
        }
    } else if (dbal.url || dbal.host || dbal.dbname || dbal.driver) {
        // single-connection shorthand
        out.push({
            alias: 'default',
            url: dbal.url,
            host: dbal.host,
            port: dbal.port,
            dbname: dbal.dbname,
            driver: dbal.driver,
            serverVersion: dbal.server_version,
            schema: dbal.schema_filter ?? dbal.schema,
        });
    }
    return out;
}

function readEntityManagers(doc: any): EntityManager[] {
    const out: EntityManager[] = [];
    const ems = doc?.doctrine?.orm?.entity_managers;
    if (!ems || typeof ems !== 'object') {
        // ORM with default entity manager: assume `default` connection
        if (doc?.doctrine?.orm) {
            out.push({ alias: 'default', connection: 'default', mappingPrefixes: [] });
        }
        return out;
    }
    for (const [alias, em] of Object.entries<any>(ems)) {
        const connection = em?.connection ?? alias;
        const mappingPrefixes: string[] = [];
        const mappings = em?.mappings;
        if (mappings && typeof mappings === 'object') {
            for (const m of Object.values<any>(mappings)) {
                if (typeof m?.prefix === 'string') mappingPrefixes.push(m.prefix);
            }
        }
        out.push({ alias, connection, mappingPrefixes });
    }
    return out;
}

export const doctrineExtractor: ConnectionExtractor = {
    name: 'doctrine',
    priority: 80,
    candidateFile(relPath, _lowerBasename) {
        return CANDIDATE_PATH_RE.test(relPath);
    },
    matches(absPath, _basename) {
        return PATH_RE.test(absPath.replace(/\\/g, '/'));
    },
    extract(absPath, content, _ctx: RepoCtx): PhysicalEndpointHint[] {
        let doc: any;
        try { doc = yaml.load(content); } catch { return []; }
        if (!doc) return [];

        const connections = readConnections(doc);
        const entityManagers = readEntityManagers(doc);
        // Reverse map: connectionAlias → entity prefixes (joined from all EMs that use it)
        const prefixesByConnection = new Map<string, string[]>();
        for (const em of entityManagers) {
            const arr = prefixesByConnection.get(em.connection) ?? [];
            arr.push(...em.mappingPrefixes);
            prefixesByConnection.set(em.connection, arr);
        }

        const out: PhysicalEndpointHint[] = [];
        for (const conn of connections) {
            // Resolve technology
            let tech: string | undefined;
            let host = conn.host;
            let port: number | string = conn.port ?? 0;
            let dbname = conn.dbname;
            let schemaOrNs = conn.schema;

            if (conn.driver) tech = DRIVER_TO_TECH[conn.driver.toLowerCase()];

            if (conn.url) {
                const parsed = parseUrlValue(conn.url);
                if (parsed.tech) tech = parsed.tech;
                if (parsed.host) host = parsed.host;
                if (parsed.port) port = parsed.port;
                if (parsed.dbname) dbname = parsed.dbname;
                if (parsed.schemaOrNs && !schemaOrNs) schemaOrNs = parsed.schemaOrNs;
            }

            // If url is template-bearing, take fields from it directly
            if (!host && conn.url) host = conn.url;
            if (!dbname && conn.url) dbname = conn.url;

            if (!tech || !host || !dbname) continue;

            const syntax = aggregateSyntaxes([conn.url, host, dbname, schemaOrNs, typeof port === 'string' ? port : undefined]);
            const prefixes = prefixesByConnection.get(conn.alias) ?? [];

            out.push({
                technology: tech,
                host: typeof host === 'string' ? host : '',
                port: typeof port === 'number' ? port : 0,
                dbName: typeof dbname === 'string' ? dbname : '',
                schemaOrNs: typeof schemaOrNs === 'string' ? schemaOrNs : undefined,
                connectionAlias: conn.alias,
                sourceFile: path.relative(_ctx.repoPath, absPath),
                confidence: 'high',
                templateSyntax: syntax,
                entityBindings: prefixes.length ? prefixes : undefined,
            });
        }
        return out;
    },
};
