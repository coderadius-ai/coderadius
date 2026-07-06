import path from 'node:path';
import type { ConnectionExtractor, PhysicalEndpointHint, RepoCtx, TemplateSyntax } from '../types.js';

/**
 * NestJS Config Extractor Plugin
 *
 * Extracts database connection metadata from NestJS `registerAs` configuration
 * files that validate environment variables through Zod schemas.
 *
 * Problem this solves:
 *   NestJS apps commonly use `schema.parse(process.env)` instead of direct
 *   `process.env.DATABASE_HOST` access. The code-env-scanner (regex-based)
 *   misses these indirect references, causing the env-var trio synthesizer
 *   to skip the database hint entirely — breaking cross-repo DataContainer
 *   welding.
 *
 * Strategy:
 *   1. Match `*.config.ts` / `*.config.js` files containing `registerAs`.
 *   2. Extract env-var key names from `z.object({...})` schema definitions.
 *   3. Classify keys into database connection roles (host, port, dbName, tech).
 *   4. Emit `PhysicalEndpointHint[]` with `templateSyntax: 'js-template'`
 *      and the env-var names wrapped as `process.env.X` template references.
 *   5. The orchestrator resolves these templates against the env map (which
 *      already contains values from Helm/docker-compose/.env files).
 *
 * Design:
 *   - Pure plugin — implements the `ConnectionExtractor` contract.
 *   - No framework-specific logic leaks into the core pipeline.
 *   - All classification is based on env-var NAMING conventions (DATABASE_HOST,
 *     DB_NAME, etc.), not on framework API shapes.
 *   - Every helper function is exported for unit testing.
 */

// ─── Zod Schema Key Extraction ───────────────────────────────────────────────

/**
 * Extract env-var key names from Zod `z.object({...})` blocks in source code.
 *
 * Handles common Zod patterns:
 *   - `z.object({ FOO: z.string(), BAR: z.number() })`
 *   - `z.object({ FOO: z.literal('mysql') })`
 *   - `z.object({ FOO: z.string().optional() })`
 *   - `z.object({ FOO: z.string().min(1).default('x') })`
 *
 * Does NOT attempt full AST parsing — uses a robust regex strategy:
 *   1. Locate `z.object(` triggers.
 *   2. Extract the balanced `{...}` block via depth-counting.
 *   3. Scan for `KEY_NAME:` property definitions within the block.
 *
 * @param content  Source file contents (TypeScript or JavaScript)
 * @returns Array of `ZodSchemaBlock` — one per `z.object({...})` found
 */
export interface ZodSchemaBlock {
    /** All uppercase env-var key names found in this z.object block. */
    keys: string[];
    /** Map of key → literal value extracted from `z.literal('value')`. */
    literals: Map<string, string>;
}

export function extractZodSchemaKeys(content: string): ZodSchemaBlock[] {
    const blocks: ZodSchemaBlock[] = [];

    // Find all z.object( triggers — handles z.object, z.strictObject, etc.
    const TRIGGER = /z\.(?:object|strictObject)\s*\(\s*\{/g;
    let m: RegExpExecArray | null;

    while ((m = TRIGGER.exec(content)) !== null) {
        const braceStart = m.index + m[0].length - 1; // points at `{`
        const block = extractBalancedBraces(content, braceStart);
        if (!block) continue;

        const keys: string[] = [];
        const literals = new Map<string, string>();

        // Scan for property keys: UPPER_CASE_NAME followed by `:`.
        // Only capture SCREAMING_SNAKE env-var names — lowercase names are
        // typically Zod helper aliases, not env vars.
        const KEY_RE = /\b([A-Z][A-Z0-9_]{1,})\s*:\s*z\.([\w.()'"]+)/g;
        let km: RegExpExecArray | null;
        while ((km = KEY_RE.exec(block)) !== null) {
            const keyName = km[1];
            keys.push(keyName);

            // Extract literal value from z.literal('value') if present.
            const zodExpr = km[2];
            const litMatch = zodExpr.match(/^literal\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            if (litMatch) {
                literals.set(keyName, litMatch[1]);
            }
        }

        if (keys.length > 0) {
            blocks.push({ keys, literals });
        }
    }

    return blocks;
}

/**
 * Extract the content of a balanced `{...}` block from a starting position.
 *
 * Handles nested braces and string literals (single, double, backtick).
 *
 * @param content  Source code
 * @param start    Index of the opening `{`
 * @returns The block content (including braces), or null if unbalanced
 */
function extractBalancedBraces(content: string, start: number): string | null {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = start; i < content.length; i++) {
        const c = content[i];
        if (inStr) {
            if (c === inStr && content[i - 1] !== '\\') inStr = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return content.slice(start, i + 1);
        }
    }
    return null;
}

// ─── Database Key Classification ─────────────────────────────────────────────

/**
 * Connection role classification for env-var keys.
 *
 * Only `host` + `dbName` are required for a usable hint.
 * `technology` and `port` are optional (the orchestrator applies defaults).
 */
export interface ClassifiedDatabaseKeys {
    /** Env-var name for the host (e.g. 'DATABASE_HOST') */
    hostKey: string;
    /** Env-var name for the database/schema name (e.g. 'DATABASE_NAME') */
    dbNameKey: string;
    /** Env-var name for the port, if found */
    portKey?: string;
    /** Env-var name for the technology/driver, if found */
    technologyKey?: string;
    /** Literal technology value if extracted from z.literal (e.g. 'mysql') */
    technologyLiteral?: string;
}

/** Role-detection patterns for env-var naming conventions. */
const ROLE_MATCHERS: Record<string, RegExp> = {
    host:       /^(?:.*_)?HOST(?:NAME)?$/i,
    port:       /^(?:.*_)?PORT$/i,
    dbName:     /^(?:.*_)?(?:DATABASE|DB|DBNAME|DB_NAME|SCHEMA|NAME)$/i,
    technology: /^(?:.*_)?(?:TYPE|DRIVER|DB_TYPE|DATABASE_TYPE)$/i,
};

/** Keys that should never be classified as dbName even if they match. */
const DBNAME_EXCLUSIONS = /(?:USER|PASS|PASSWORD|SECRET|TOKEN|POOL|SIZE|TIMEOUT|SSL|AUTH|KEY|CERT)$/i;

/**
 * Classify a set of env-var key names into database connection roles.
 *
 * Uses naming-convention heuristics (SCREAMING_SNAKE patterns) to detect
 * which key serves which role. Returns `null` when the minimum required
 * pair (host + dbName) cannot be identified.
 *
 * Multiple database "groups" in the same schema (e.g. MYSQL_HOST + MONGO_HOST)
 * are NOT split — the caller typically gets one z.object per config file,
 * and each file configures one database connection.
 *
 * @param keys     Env-var key names from a single z.object block
 * @param literals Map of key → literal value from z.literal() (for technology)
 * @returns Classified roles, or null if insufficient keys
 */
export function classifyDatabaseKeys(
    keys: string[],
    literals: Map<string, string>,
): ClassifiedDatabaseKeys | null {
    let hostKey: string | undefined;
    let dbNameKey: string | undefined;
    let portKey: string | undefined;
    let technologyKey: string | undefined;

    for (const key of keys) {
        if (!hostKey && ROLE_MATCHERS.host.test(key)) {
            hostKey = key;
        } else if (!technologyKey && ROLE_MATCHERS.technology.test(key)) {
            technologyKey = key;
        } else if (!portKey && ROLE_MATCHERS.port.test(key)) {
            // Avoid matching APP_PORT (non-DB ports) — require a DB-ish prefix.
            if (/^(?:DATABASE|DB|MYSQL|MONGO|POSTGRES|PG|REDIS|TYPEORM)/i.test(key) || keys.some(k => ROLE_MATCHERS.host.test(k))) {
                portKey = key;
            }
        } else if (!dbNameKey && ROLE_MATCHERS.dbName.test(key) && !DBNAME_EXCLUSIONS.test(key)) {
            dbNameKey = key;
        }
    }

    // Minimum viable: must have host AND dbName
    if (!hostKey || !dbNameKey) return null;

    const result: ClassifiedDatabaseKeys = { hostKey, dbNameKey };
    if (portKey) result.portKey = portKey;
    if (technologyKey) {
        result.technologyKey = technologyKey;
        const lit = literals.get(technologyKey);
        if (lit) result.technologyLiteral = lit;
    }

    return result;
}

// ─── Hint Assembly ───────────────────────────────────────────────────────────

/** Known TypeORM type values → canonical technology name. */
const TYPE_TO_TECH: Record<string, string> = {
    mysql: 'mysql', mariadb: 'mysql',
    postgres: 'postgres', postgresql: 'postgres',
    mongodb: 'mongodb', mongo: 'mongodb',
    sqlserver: 'sqlserver', mssql: 'sqlserver',
    sqlite: 'sqlite',
    oracle: 'oracle',
    redis: 'redis',
};

/**
 * Assemble `PhysicalEndpointHint[]` from classified database keys.
 *
 * Each key is emitted as a `process.env.KEY_NAME` template reference.
 * The orchestrator's env-var resolution pass will substitute the actual
 * values from the repo's env map (Helm, docker-compose, .env files).
 *
 * When the technology is available as a z.literal (e.g. `z.literal('mysql')`),
 * the value is used directly instead of a template reference.
 *
 * @param classified  Classified connection roles
 * @param sourceFile  Relative path to the config file (for audit trail)
 * @returns Array of PhysicalEndpointHints (0 or 1 element)
 */
export function buildHintsFromClassified(
    classified: ClassifiedDatabaseKeys,
    sourceFile: string,
): PhysicalEndpointHint[] {
    // Technology: prefer literal, fallback to template reference
    let technology: string;
    if (classified.technologyLiteral) {
        const mapped = TYPE_TO_TECH[classified.technologyLiteral.toLowerCase()];
        technology = mapped ?? classified.technologyLiteral.toLowerCase();
    } else if (classified.technologyKey) {
        technology = `process.env.${classified.technologyKey}`;
    } else {
        // Without ANY technology signal, we can't produce a useful hint.
        // The orchestrator would reject it during fingerprinting.
        // Conservative: skip rather than guess.
        return [];
    }

    return [{
        technology,
        host: `process.env.${classified.hostKey}`,
        port: 0, // resolved by orchestrator from portTemplate or defaultPort
        portTemplate: classified.portKey ? `process.env.${classified.portKey}` : undefined,
        dbName: `process.env.${classified.dbNameKey}`,
        sourceFile,
        confidence: 'medium',
        templateSyntax: 'js-template' as TemplateSyntax,
        isTemplate: undefined, // set by orchestrator
    }];
}

// ─── Plugin Definition ───────────────────────────────────────────────────────

/**
 * NestJS Config Connection Extractor.
 *
 * Priority: 60 (below typeorm/doctrine at 80 — those have direct config
 * evidence; this is a heuristic fallback for apps that use dynamic module
 * registration with Zod-validated process.env).
 *
 * matches():
 *   File must be `*.config.ts` or `*.config.js`. The content-level check
 *   (registerAs + z.object) happens inside extract() to avoid reading
 *   file content twice.
 *
 * extract():
 *   1. Quick bail: skip if content doesn't contain both `registerAs` and
 *      `z.object` — no expensive parsing for unrelated config files.
 *   2. Extract Zod schema blocks → classify keys → build hints.
 */
export const nestjsConfigExtractor: ConnectionExtractor = {
    name: 'nestjs-config',
    priority: 60,

    candidateFile(_relPath: string, lowerBasename: string): boolean {
        return /\.config\.[tj]s$/.test(lowerBasename);
    },

    matches(_absPath: string, basename: string): boolean {
        return /\.config\.[tj]s$/.test(basename);
    },

    extract(absPath: string, content: string, ctx: RepoCtx): PhysicalEndpointHint[] {
        // Quick bail: both signals must be present for this to be a NestJS
        // Zod-validated config file.
        if (!content.includes('registerAs') || !content.includes('z.object')) {
            return [];
        }

        const blocks = extractZodSchemaKeys(content);
        const relPath = path.relative(ctx.repoPath, absPath).replace(/\\/g, '/');
        const hints: PhysicalEndpointHint[] = [];

        for (const block of blocks) {
            const classified = classifyDatabaseKeys(block.keys, block.literals);
            if (!classified) continue;
            hints.push(...buildHintsFromClassified(classified, relPath));
        }

        return hints;
    },

    claimEnvKeys(_absPath: string, content: string): string[] {
        if (!content.includes('registerAs') || !content.includes('z.object')) {
            return [];
        }
        // A successful CLASSIFICATION consumes the keys even when no hint can
        // be emitted (missing technology signal): the datastore lane has
        // recognized them, so they must never leak into other lanes (broker
        // s0 host-shape) as false candidates.
        const claimed: string[] = [];
        for (const block of extractZodSchemaKeys(content)) {
            const classified = classifyDatabaseKeys(block.keys, block.literals);
            if (!classified) continue;
            claimed.push(classified.hostKey, classified.dbNameKey);
            if (classified.portKey) claimed.push(classified.portKey);
            if (classified.technologyKey) claimed.push(classified.technologyKey);
        }
        return claimed;
    },
};
