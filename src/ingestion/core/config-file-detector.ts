import path from 'node:path';

/**
 * DB-config-specific basename patterns.
 * Applied to path.basename() only — no fullPath regex to avoid monorepo noise.
 *
 * Sources: Symfony (doctrine.yaml), Laravel (database.php), TypeORM (ormconfig.json),
 *          Sequelize (config/database.js), Knex (knexfile.ts).
 *
 * NOTE: Prisma uses "schema.prisma" which has NO double extension.
 *       It is matched by DB_CONFIG_BASENAME_EXACT below, not by extension filtering.
 */
export const DB_CONFIG_BASENAME_EXT = /^(database|db|doctrine|eloquent|datasource|orm|ormconfig|persistence|knexfile)\.(php|yaml|yml|xml|ts|js|json)$/i;

/**
 * Exact basename match for config files with non-standard naming conventions.
 * Currently: Prisma's `schema.prisma` (no double extension).
 */
export const DB_CONFIG_BASENAME_EXACT = /^schema\.prisma$/i;

/**
 * Parent directory check: ONLY matches files whose immediate parent dir is a
 * DB-specific infrastructure directory.
 *
 * Restricted to avoid matching all files under generic Symfony/Laravel 'config/'
 * directories (services.yaml, routing.yaml, security.yaml, etc. would also pass
 * an unrestricted 'config/' pattern).
 *
 * Allowed parents: 'doctrine', 'database', 'db', 'datasource'
 * NOT included: 'config' (too broad), 'persistence' (too broad)
 *
 * Examples that pass:
 *   doctrine/database.yaml         ← basename match
 *   db/connections.json            ← config-like basename in 'db'
 *   src/datasource/config.xml      ← config-like basename in 'datasource'
 *
 * Examples that DO NOT pass:
 *   config/services.yaml           ← 'config' is excluded
 *   config/packages/messenger.yaml ← 'config' is excluded (handled by BROKER_CONFIG_PATTERNS)
 */
export const DB_CONFIG_PARENT_DIR = /(?:^|\/)(?:doctrine|database|db|datasource)\/(?:config|connections?|settings|parameters|datasources?|database|db)\.(php|yaml|yml|xml|ts|js|json|toml|ini|conf)$/i;

/**
 * Returns true if the given file path (relative to repo root) is a DB config file
 * that should be included in config symbol extraction.
 *
 * This function is the single source of truth for DB config detection.
 * Used by both the ingestion scout (code-ingestion.workflow.ts) and the
 * eval path (symbol-registry-loader.ts) to prevent drift.
 */
export function isDbConfigFile(filePath: string): boolean {
    const base = path.basename(filePath);
    return DB_CONFIG_BASENAME_EXT.test(base)
        || DB_CONFIG_BASENAME_EXACT.test(base)
        || DB_CONFIG_PARENT_DIR.test(filePath);
}

// ─── Broker / Messaging Config Detection ─────────────────────────────────────

/**
 * Broker/messaging config file patterns — infrastructure wiring (AMQP, Kafka, RabbitMQ).
 *
 * These detect config files that define DI service key → physical topic/queue mappings.
 * Without this, the SymbolRegistry never learns that 'payment.completed.publisher'
 * should resolve to 'payment.completed.v2'.
 *
 * Previously this logic lived only in symbol-registry-loader.ts (eval/CI path),
 * causing the production ingestion scout to miss Symfony services.php files.
 */
export const BROKER_CONFIG_PATTERNS: RegExp[] = [
    /services\.(xml|yaml|php)$/i,
    /\bamqp/i,
    /rabbit/i,
    /kafka/i,
    /messaging/i,
    /bus\.(yaml|xml|php)$/i,
    /\.env(\.example)?$/i,
    /config\/(packages|services)\//i,
    /messenger\.(yaml|xml|php)$/i,
];

const BROKER_CONFIG_EXT = /\.(xml|yaml|yml|php|json|conf|ini|toml)$/i;
const ENV_BASENAME = /^\.env(?:\.|$)/i;

/**
 * Returns true if the given file path matches a broker/messaging config pattern.
 */
export function isBrokerConfigFile(filePath: string): boolean {
    const base = path.basename(filePath);
    if (!ENV_BASENAME.test(base) && !BROKER_CONFIG_EXT.test(base)) return false;
    return BROKER_CONFIG_PATTERNS.some(p => p.test(filePath));
}

/**
 * Unified config file detection: returns true for both DB and broker config files.
 * Use this in the ingestion scout to ensure ALL infrastructure config files
 * are included in the ConfigSymbolExtractor target list.
 */
export function isConfigFile(filePath: string): boolean {
    return isDbConfigFile(filePath) || isBrokerConfigFile(filePath);
}
