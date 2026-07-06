import type { CodeChunk } from '../../../../graph/types.js';
import type { EntitySchemaDefinition, StaticInfraResult } from '../types.js';

export function extractTypeScriptStaticInfra(chunk: CodeChunk): StaticInfraResult | null {
    if (chunk.name.endsWith('::__route_handler')) {
        const prefix = chunk.name.slice(0, -'::__route_handler'.length);
        const spaceIdx = prefix.indexOf(' ');
        if (spaceIdx === -1) return null;

        const method = prefix.slice(0, spaceIdx);
        const routePath = prefix.slice(spaceIdx + 1);
        const framework = inferFrameworkFromFilepath(chunk.filepath);

        return {
            has_io: true,
            intent: `${framework} route handler: ${method} ${routePath}`,
            infrastructure: [],
            capabilities: ['http-handler'],
            emergent_api_calls: [{
                method,
                path: routePath,
                direction: 'INBOUND',
                framework,
            }],
        };
    }

    if (chunk.name.endsWith('::__server_action')) {
        const prefix = chunk.name.slice(0, -'::__server_action'.length);
        const spaceIdx = prefix.indexOf(' ');
        if (spaceIdx === -1) return null;

        const routePath = prefix.slice(spaceIdx + 1);

        return {
            has_io: true,
            intent: `Next.js Server Action: POST ${routePath}`,
            infrastructure: [],
            capabilities: ['http-handler', 'server-action'],
            emergent_api_calls: [{
                method: 'POST',
                path: routePath,
                direction: 'INBOUND',
                framework: 'nextjs-action',
            }],
        };
    }

    if (chunk.name.endsWith('::__message_handler')) {
        const channel = chunk.name.slice(0, -'::__message_handler'.length);
        if (channel.length === 0) return null;

        return {
            has_io: true,
            intent: `Message consumer: listens to ${channel}`,
            infrastructure: [{
                name: channel,
                type: 'MessageChannel',
                operation: 'READS',
            }],
            capabilities: ['message-consumer'],
            emergent_api_calls: [],
        };
    }

    if (chunk.name.endsWith('::__class_metadata')) {
        const symbolName = chunk.name.slice(0, -'::__class_metadata'.length);
        const meta = extractTableMetadata(chunk.sourceCode, symbolName);
        if (!meta) return null;

        const fields = meta.kindFamily === 'rdbms' ? extractTypeOrmColumns(chunk.sourceCode) : [];

        return {
            has_io: true,
            intent: `ORM model/entity ${symbolName} maps to ${meta.name}`,
            infrastructure: [{
                name: meta.name,
                type: 'Database',
                operation: 'MAPS_TO',
                ...(meta.kindFamily ? { kindFamily: meta.kindFamily } : {}),
            }],
            capabilities: ['orm-entity'],
            emergent_api_calls: [],
            entity_schemas: [{ name: meta.name, fields }],
        };
    }

    return null;
}

// ─── Column extraction ────────────────────────────────────────────────────────

/**
 * Parse TypeORM-style `@Column(...)` decorators out of a class-metadata
 * chunk's source. Supports three signatures:
 *
 *     @Column({ name: 'x', type: 'bigint', nullable: false })
 *     @Column('legacy_id', { type: 'integer' })
 *     @Column()       // column name defaults to the property name
 *
 * When `name` is absent, falls back to the following property name
 * (`createdAt: number;` → `createdAt`). Deterministic; no AST walker.
 */
function extractTypeOrmColumns(source: string): EntitySchemaDefinition['fields'] {
    const fields: EntitySchemaDefinition['fields'] = [];
    const seen = new Set<string>();

    // `@Column` decorator with anything between `(` and the matching `)`.
    // Multi-line aware via [\s\S]. Excludes `@ColumnNonExistent` by anchoring
    // on the open-paren boundary.
    const decoratorRe = /@Column\s*\(([\s\S]*?)\)/g;
    // TS class property: `propName(?|!)?: type` or `propName(?|!)?;`. Skip
    // method declarations by requiring `:` or `;`/`=` after the name.
    const nextPropertyRe = /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+|readonly\s+)*\s*([a-zA-Z_$][\w$]*)\s*[!?]?\s*[:;=]/;

    let match: RegExpExecArray | null;
    while ((match = decoratorRe.exec(source)) !== null) {
        const body = match[1] ?? '';
        const afterIndex = match.index + match[0].length;

        const remainder = source.slice(afterIndex);
        const nextDecoratorIdx = remainder.search(/@Column\s*\(/);
        const window = nextDecoratorIdx === -1 ? remainder : remainder.slice(0, nextDecoratorIdx);
        const propMatch = window.match(nextPropertyRe);
        const propertyName = propMatch ? propMatch[1] : null;

        // Positional name: @Column('x', { ... }) — first arg is the column name.
        const positionalNameMatch = body.match(/^\s*['"`]([^'"`]+)['"`]/);
        const explicitName = body.match(/\bname\s*:\s*['"`]([^'"`]+)['"`]/)?.[1]
            ?? positionalNameMatch?.[1]
            ?? null;
        const type = body.match(/\btype\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? 'string';
        const nullable = /\bnullable\s*:\s*true\b/.test(body);

        const columnName = explicitName ?? propertyName;
        if (!columnName) continue;
        if (seen.has(columnName)) continue;
        seen.add(columnName);

        fields.push({ name: columnName, type, required: !nullable });
    }

    return fields;
}

interface OrmMatch {
    name: string;
    kindFamily?: 'rdbms' | 'document';
}

const ORM_PATTERNS: Array<{ re: RegExp; family: 'rdbms' | 'document' }> = [
    // Relational ORMs (TypeORM, MikroORM, EntitySchema, Drizzle): rdbms
    { re: /@Entity\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/, family: 'rdbms' },
    { re: /@Entity\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'rdbms' },
    { re: /@Entity\s*\(\s*\{\s*[\s\S]*?\btableName\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'rdbms' },
    { re: /@ViewEntity\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/, family: 'rdbms' },
    { re: /@ViewEntity\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'rdbms' },
    { re: /@Table\s*\(\s*\{[\s\S]*?\btableName\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'rdbms' },
    { re: /@Table\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/, family: 'rdbms' },
    { re: /new\s+EntitySchema\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'rdbms' },
    { re: /new\s+EntitySchema\s*\(\s*\{[\s\S]*?\btableName\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'rdbms' },
    { re: /\b(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`]([^'"`]+)['"`]/, family: 'rdbms' },
    // Document ODMs (Mongoose, Typegoose, NestJS Mongoose): document
    { re: /@Schema\s*\(\s*\{[\s\S]*?\bcollection\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'document' },
    { re: /@Collection\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/, family: 'document' },
    { re: /@Collection\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'document' },
    { re: /@modelOptions\s*\(\s*\{[\s\S]*?\bcollection\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/, family: 'document' },
    // Mongoose `model('Name', schema, 'collection')` — third arg is the collection name.
    { re: /\bmodel\s*\(\s*['"`][^'"`]+['"`]\s*,[\s\S]*?,\s*['"`]([^'"`]+)['"`]\s*\)/, family: 'document' },
];

export function extractTableMetadata(sourceCode: string, symbolName: string): OrmMatch | null {
    for (const { re, family } of ORM_PATTERNS) {
        const match = sourceCode.match(re);
        if (match?.[1]) return { name: match[1], kindFamily: family };
    }
    const fb = fallbackOrmName(symbolName);
    return fb ? { name: fb } : null;  // no kindFamily: ambiguous fallback
}

export function fallbackOrmName(symbolName: string): string | null {
    const stripped = symbolName
        .replace(/(?:Entity|TableSchema|Schema|Model)$/u, '')
        .replace(/\.(entity|model)$/iu, '');
    if (!stripped) return null;

    return stripped
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[.\-\s]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

export function inferFrameworkFromFilepath(filepath: string): string {
    const normalized = filepath.replace(/\\/g, '/');
    if (/(?:^|\/)app\/.*\/route\.[jt]s$/.test(normalized) || /(?:^|\/)app\/route\.[jt]s$/.test(normalized)) return 'Next.js App Router';
    if (/(?:^|\/)pages\/api\//.test(normalized)) return 'Next.js Pages Router';
    if (/(?:^|\/)src\/routes\/.*\+server\.[jt]s$/.test(normalized)) return 'SvelteKit';
    if (/(?:^|\/)server\/(routes|api)\//.test(normalized)) return 'Nuxt 3';
    return 'Unknown framework';
}
