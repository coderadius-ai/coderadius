// ═══════════════════════════════════════════════════════════════════════════════
// Doctrine Migrations Plugin — DDL-declared tables as DataContainers
//
// doctrine/migrations version files carry the authoritative schema history:
// `$this->addSql('CREATE TABLE …')`. Tables declared here are real schema
// facts (grounding ast/exact) even when no live code path touches them —
// exactly the population the function-level extraction can never see.
//
// Emission policy:
//   CREATE TABLE / ALTER TABLE / RENAME … TO → emit (the table exists)
//   DROP TABLE / index names                 → never emit
//
// The URN/scope mirror the default dbScope convention of the code pipeline
// (qualified repo name), so a table found BOTH here and via live code merges
// onto one node.
// ═══════════════════════════════════════════════════════════════════════════════

import type { PluginContext, StructuralEntity, StructuralExtractionResult, StructuralPlugin } from '../types.js';
import { buildUrn } from '../../../graph/urn.js';
import { isUnsafeContainerName } from '../../core/name-safety.js';

const MIGRATION_FILE_RE = /^Version\d+.*\.php$/;
const MIGRATIONS_DIR_RE = /(^|\/)migrations(\/|$)/i;

/** SQL-string statements that prove a table EXISTS. Group 1 = table name. */
const TABLE_FACT_RES: RegExp[] = [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/gi,
    /ALTER\s+TABLE\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/gi,
    /RENAME\s+TABLE\s+[`"]?[A-Za-z_][A-Za-z0-9_]*[`"]?\s+TO\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/gi,
];

/** Pull the SQL payloads out of addSql('…') / addSql("…") calls.
 *  The `s` flag lets `.` span newlines: real-world DDL strings are multiline. */
const ADD_SQL_RE = /addSql\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/gs;

/** Heredoc/nowdoc bodies (`<<<SQL … SQL`): migrations commonly assign bulk DDL
 *  to a variable and pass it to addSql($sql). Published PHP string syntax. */
const HEREDOC_RE = /<<<['"]?(\w+)['"]?\r?\n([\s\S]*?)\r?\n\s*\1\b/g;

function scanSqlForTables(sql: string, names: Set<string>): void {
    for (const re of TABLE_FACT_RES) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(sql)) !== null) {
            const name = m[1];
            if (!isUnsafeContainerName(name)) names.add(name);
        }
    }
}

function collectTableNames(content: string): string[] {
    const names = new Set<string>();
    for (const re of [ADD_SQL_RE, HEREDOC_RE]) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(content)) !== null) {
            scanSqlForTables(match[2], names);
        }
    }
    return [...names];
}

function toEntity(name: string, qualifiedRepo: string, sourcePath: string): StructuralEntity {
    return {
        id: buildUrn('datacontainer', qualifiedRepo, name),
        labels: ['DataContainer'],
        properties: {
            name,
            scope: qualifiedRepo,
            evidence_extractors: ['doctrine-migrations@v1'],
            // Provenance hook: findStructuralFileUrn() resolves the defining
            // StructuralFile from this, which creates the DEFINES edge the
            // orphan-GC liveness check counts. Without it the table is reaped
            // at the end of every code-pipeline run.
            _sourcePath: sourcePath,
        },
        relationshipType: 'DEFINES',
    };
}

export const doctrineMigrationsPlugin: StructuralPlugin = {
    name: 'doctrine-migrations',
    label: 'Doctrine Migrations',
    managedLabels: ['DataContainer'],

    // Published doctrine/migrations API surface — never customer naming.
    contentSignatures: [
        /extends\s+AbstractMigration/,
        /use\s+Doctrine\\Migrations\\AbstractMigration/,
    ],

    discoveryGlobs: ['**/[Mm]igrations/Version*.php'],

    matchFile(relativePath: string, basename: string): boolean {
        return MIGRATION_FILE_RE.test(basename) && MIGRATIONS_DIR_RE.test(relativePath);
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        const qualifiedRepo = context.repoUrn.replace(/^cr:repository:/, '');
        const entities = collectTableNames(content).map((n) => toEntity(n, qualifiedRepo, context.relativePath));
        return {
            entities,
            summary: entities.length > 0
                ? `${entities.length} table(s) declared by ${context.relativePath}`
                : 'no table facts',
        };
    },
};
