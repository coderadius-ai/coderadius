import path from 'node:path';
import type { ConnectionExtractor, PhysicalEndpointHint, RepoCtx, TemplateSyntax } from '../types.js';

const FILES = new Set([
    'data-source.ts', 'data-source.js',
    'ormconfig.ts', 'ormconfig.js', 'ormconfig.json',
    'typeorm.config.ts', 'typeorm.config.js',
    'app-data-source.ts', 'app.data-source.ts',
]);

const TYPE_TO_TECH: Record<string, string> = {
    mysql: 'mysql', mariadb: 'mysql',
    postgres: 'postgres', postgresql: 'postgres',
    cockroachdb: 'postgres',
    mongodb: 'mongodb',
    sqlserver: 'sqlserver', mssql: 'sqlserver',
    sqlite: 'sqlite', better_sqlite3: 'sqlite',
    oracle: 'oracle',
};

interface DataSourceLiteral {
    type?: string;
    host?: string;
    port?: number | string;
    database?: string;
    schema?: string;
    name?: string;
    entities?: string[];
    raw: string;
}

const STRING_RE = /(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/;
const TEMPLATE_RE = /process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*['"][A-Za-z_][A-Za-z0-9_]*['"]\s*\])/;

function takeStringOrTemplate(src: string): string | undefined {
    const trimmed = src.trim();
    // Order matters: a process.env['VAR'] template contains a string literal that would
    // otherwise hijack STRING_RE; check the template form first.
    const tm = trimmed.match(TEMPLATE_RE);
    if (tm) return tm[0];
    const sm = STRING_RE.exec(trimmed);
    if (sm) return sm[1] ?? sm[2] ?? sm[3];
    return undefined;
}

function takeNumberOrTemplate(src: string): number | string | undefined {
    const t = src.trim();
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (TEMPLATE_RE.test(t)) return t.match(TEMPLATE_RE)![0];
    return undefined;
}

function takeEntities(src: string): string[] | undefined {
    const t = src.trim();
    if (!t.startsWith('[')) return undefined;
    // crude — match identifiers inside the array literal up to the matching bracket
    let depth = 0;
    let end = -1;
    for (let i = 0; i < t.length; i++) {
        if (t[i] === '[') depth++;
        else if (t[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return undefined;
    const inner = t.slice(1, end);
    const ids = Array.from(inner.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)).map(m => m[1]);
    return ids.length ? Array.from(new Set(ids)) : undefined;
}

/**
 * Parse an object literal passed to `new DataSource({...})` or `createConnection({...})`
 * or default-export of `ormconfig.ts`. Crude but resilient — extracts only the keys we care about.
 */
function extractDataSourceLiterals(content: string): DataSourceLiteral[] {
    const out: DataSourceLiteral[] = [];

    // Find all object literals that look like a DataSource config
    const TRIGGER = /(?:new\s+DataSource\s*\(|createConnection\s*\(|TypeOrmModule\.forRoot\s*\(|export\s+default\s+|module\.exports\s*=\s*)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = TRIGGER.exec(content)) !== null) {
        const start = m.index + m[0].length - 1; // points at the `{`
        // find the matching closing brace (depth-aware, skip strings)
        let depth = 0;
        let inStr: string | null = null;
        let i = start;
        for (; i < content.length; i++) {
            const c = content[i];
            if (inStr) {
                if (c === inStr && content[i - 1] !== '\\') inStr = null;
                continue;
            }
            if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
        }
        const block = content.slice(start, i);
        const pickValue = (key: string): string | undefined => {
            const re = new RegExp(`\\b${key}\\s*:\\s*([^,\\n]+(?:\\([^)]*\\))?(?:\\[[^\\]]*\\])?[^,\\n]*)`, 'i');
            const km = re.exec(block);
            if (!km) return undefined;
            return km[1].replace(/[,;]\s*$/, '').trim();
        };
        const lit: DataSourceLiteral = { raw: block };
        const tRaw = pickValue('type');
        if (tRaw) lit.type = takeStringOrTemplate(tRaw);
        const hRaw = pickValue('host');
        if (hRaw) lit.host = takeStringOrTemplate(hRaw);
        const pRaw = pickValue('port');
        if (pRaw) lit.port = takeNumberOrTemplate(pRaw);
        const dRaw = pickValue('database');
        if (dRaw) lit.database = takeStringOrTemplate(dRaw);
        const sRaw = pickValue('schema');
        if (sRaw) lit.schema = takeStringOrTemplate(sRaw);
        const nRaw = pickValue('name');
        if (nRaw) lit.name = takeStringOrTemplate(nRaw);
        // entities array: scan for `entities:` then capture `[...]`
        const eIdx = block.search(/\bentities\s*:/);
        if (eIdx >= 0) {
            const after = block.slice(eIdx).replace(/^[^[]*/, '');
            lit.entities = takeEntities(after);
        }
        out.push(lit);
    }
    return out;
}

function classifyTemplate(value: string | undefined): TemplateSyntax {
    if (!value) return 'none';
    if (TEMPLATE_RE.test(value)) return 'js-template';
    return 'none';
}

export const typeormExtractor: ConnectionExtractor = {
    name: 'typeorm',
    priority: 80,
    candidateFile(_relPath, lowerBasename) {
        return FILES.has(lowerBasename);
    },
    matches(_absPath, basename) {
        return FILES.has(basename.toLowerCase());
    },
    extract(absPath, content, _ctx: RepoCtx): PhysicalEndpointHint[] {
        const literals = extractDataSourceLiterals(content);
        const out: PhysicalEndpointHint[] = [];
        for (const lit of literals) {
            if (!lit.type || !lit.host || !lit.database) continue;
            const tech = TYPE_TO_TECH[(typeof lit.type === 'string' ? lit.type.toLowerCase() : '')] ?? '';
            if (!tech) continue;

            const portValue = typeof lit.port === 'number'
                ? lit.port
                : (typeof lit.port === 'string' ? 0 : 0);

            // Determine template syntax: any of host/db/port template-bearing → js-template
            let syntax: TemplateSyntax = 'none';
            for (const v of [lit.host, lit.database, typeof lit.port === 'string' ? lit.port : undefined, lit.schema]) {
                if (classifyTemplate(v) === 'js-template') { syntax = 'js-template'; break; }
            }

            out.push({
                technology: tech,
                host: lit.host,
                port: portValue,
                dbName: lit.database,
                schemaOrNs: lit.schema,
                connectionAlias: lit.name,
                sourceFile: path.basename(absPath),
                confidence: 'high',
                templateSyntax: syntax,
                entityBindings: lit.entities,
            });
        }
        return out;
    },
};
