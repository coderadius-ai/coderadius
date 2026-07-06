import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../../graph/types.js';
import type { EntitySchemaDefinition, StaticInfraResult } from '../types.js';

const ORM_DOCBLOCK_PATTERNS = [
    /@ORM\\(Entity|Table|Document|MappedSuperclass|Embeddable)/i,
    /@(Entity|Document|ApiResource|Resource)\b/i,
    /@MongoDB\\(Document|EmbeddedDocument)/i,
];

const ORM_ATTRIBUTE_PATTERNS = [
    /ORM\\(Entity|Table|Document|MappedSuperclass|Embeddable)/i,
    /^ApiResource$/i,
    /MongoDB\\(Document|EmbeddedDocument)/i,
];

const ORM_BASE_CLASSES = new Set([
    'Model', 'Authenticatable', 'Pivot',
    'AbstractEntity', 'MappedSuperclass',
]);

export function detectOrmEntity(classNode: Parser.SyntaxNode): boolean {
    let previous = classNode.previousSibling;
    while (previous && previous.type === 'comment') {
        const previousText = previous.text;
        if (ORM_DOCBLOCK_PATTERNS.some(pattern => pattern.test(previousText))) {
            return true;
        }
        previous = previous.previousSibling;
    }

    for (const child of classNode.children) {
        if (child.type !== 'attribute_list') continue;
        for (const group of child.children) {
            if (group.type !== 'attribute_group') continue;
            for (const attribute of group.children) {
                if (attribute.type !== 'attribute') continue;
                const attrName = attribute.children.find(candidate =>
                    candidate.type === 'name' || candidate.type === 'qualified_name',
                )!.text;
                if (ORM_ATTRIBUTE_PATTERNS.some(pattern => pattern.test(attrName))) {
                    return true;
                }
            }
        }
    }

    const baseClause = classNode.children.find(child => child.type === 'base_clause');
    if (!baseClause) return false;

    const baseText = baseClause.text.replace(/^extends\s+/, '');
    const baseClassName = baseText.slice(baseText.lastIndexOf('\\') + 1).trim();
    return ORM_BASE_CLASSES.has(baseClassName);
}

export function extractClassMetadata(classNode: Parser.SyntaxNode): string | null {
    if (!detectOrmEntity(classNode)) return null;

    const parts: string[] = ['// ORM entity'];

    const classComments: string[] = [];
    let previous = classNode.previousSibling;
    while (previous && previous.type === 'comment') {
        classComments.unshift(previous.text);
        previous = previous.previousSibling;
    }
    if (classComments.length > 0) {
        parts.push(classComments.join('\n'));
    }

    for (const child of classNode.children) {
        if (child.type === 'attribute_list') {
            parts.push(child.text);
        }
    }

    const className = classNode.childForFieldName('name')!.text;
    let classLine = `class ${className}`;
    const baseClause = classNode.children.find(child => child.type === 'base_clause');
    if (baseClause) classLine += ` ${baseClause.text}`;
    const interfaceClause = classNode.children.find(child => child.type === 'class_interface_clause');
    if (interfaceClause) classLine += ` ${interfaceClause.text}`;
    parts.push(classLine);

    const body = classNode.childForFieldName('body');
    if (body) {
        for (const member of body.children) {
            if (member.type !== 'property_declaration' && member.type !== 'const_declaration') continue;

            const memberComments: string[] = [];
            let memberPrev = member.previousSibling;
            while (memberPrev && memberPrev.type === 'comment') {
                memberComments.unshift(memberPrev.text);
                memberPrev = memberPrev.previousSibling;
            }

            if (memberComments.length > 0) {
                parts.push(memberComments.join('\n'));
            }
            parts.push(member.text);
        }
    }

    return parts.join('\n');
}

export function extractClassNameFromChunkName(chunkName: string): string | null {
    const metaSuffix = '::__class_metadata';
    if (!chunkName.endsWith(metaSuffix)) return null;
    const qualifiedName = chunkName.slice(0, -metaSuffix.length);
    const segments = qualifiedName.split('\\');
    return segments[segments.length - 1] || null;
}

export function toSnakeCase(name: string): string {
    return name
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .replace(/([a-z\d])([A-Z])/g, '$1_$2')
        .toLowerCase();
}

export function naivePluralize(word: string): string {
    if (word.endsWith('y') && !word.endsWith('ey') && !word.endsWith('oy') && !word.endsWith('ay')) {
        return word.slice(0, -1) + 'ies';
    }
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z') || word.endsWith('sh') || word.endsWith('ch')) {
        return word + 'es';
    }
    return word + 's';
}

function extractRouteStaticInfra(chunk: CodeChunk): StaticInfraResult | null {
    const routePart = chunk.name.replace(/::__route_handler$/, '');
    const spaceIndex = routePart.indexOf(' ');
    if (spaceIndex === -1) return null;

    const method = routePart.slice(0, spaceIndex);
    const routePath = routePart.slice(spaceIndex + 1);
    const frameworkMatch = chunk.sourceCode.match(/\/\*\s*([^:]+)\s+route:/);
    const framework = frameworkMatch ? frameworkMatch[1].trim() : 'php';

    return {
        has_io: true,
        intent: `${framework} HTTP ${method} endpoint at ${routePath}`,
        infrastructure: [],
        capabilities: ['http-handler'],
        emergent_api_calls: [{
            direction: 'INBOUND',
            method,
            path: routePath,
            framework,
        }],
    };
}

export function extractOrmMetadataStaticInfra(chunk: CodeChunk): StaticInfraResult | null {
    const source = chunk.sourceCode;
    const isEloquent = /extends\s+(Model|Authenticatable|Pivot)\b/.test(source);
    const isDoctrine = /@ORM\\|ORM\\Entity|ORM\\Table/i.test(source);
    const isMongoDB = /@MongoDB\\|MongoDB\\Document|#\[Document/i.test(source);

    let tableName: string | null = null;
    let framework = 'ORM';

    if (isDoctrine || isMongoDB) {
        const tableMatch = source.match(/@ORM\\Table\s*\([\s\S]*?name\s*=\s*["']([^"']+)["']/i)
            || source.match(/#\[ORM\\Table\s*\([\s\S]*?name\s*[:=]\s*["']([^"']+)["']/i)
            || source.match(/ORM\\Table\s*\([\s\S]*?name\s*[:=]\s*["']([^"']+)["']/i);
        if (tableMatch) {
            tableName = tableMatch[1];
            framework = 'Doctrine';
        }

        if (!tableName && isMongoDB) {
            const collectionMatch = source.match(/Document\s*\(\s*collection\s*[:=]\s*["']([^"']+)["']/i);
            if (collectionMatch) {
                tableName = collectionMatch[1];
                framework = 'MongoDB ODM';
            }
        }

        if (!tableName && isDoctrine) {
            const className = extractClassNameFromChunkName(chunk.name);
            if (className) {
                tableName = toSnakeCase(className);
                framework = 'Doctrine';
            }
        }
    }

    if (isEloquent) {
        const tableMatch = source.match(/\$table\s*=\s*["']([^"']+)["']/);
        if (tableMatch) {
            tableName = tableMatch[1];
            framework = 'Eloquent';
        }

        if (!tableName) {
            const collectionMatch = source.match(/\$collection\s*=\s*["']([^"']+)["']/);
            if (collectionMatch) {
                tableName = collectionMatch[1];
                framework = 'Eloquent';
            }
        }

        if (!tableName) {
            const className = extractClassNameFromChunkName(chunk.name);
            if (className) {
                tableName = naivePluralize(toSnakeCase(className));
                framework = 'Eloquent';
            }
        }
    }

    if (!tableName) return null;

    const fields = isDoctrine ? extractDoctrineColumns(source) : [];

    return {
        has_io: true,
        intent: `${framework} entity mapped to table '${tableName}'`,
        infrastructure: [{
            name: tableName,
            type: 'Database',
            operation: 'MAPS_TO',
            // Doctrine ORM and Laravel Eloquent are relational-only:
            // signal `rdbms` so the binding layer refuses to attach this
            // entity to a non-RDBMS Datastore (e.g. an unrelated MongoDB
            // connection that happens to be the only high-confidence hint
            // discovered in the repo).
            kindFamily: 'rdbms',
        }],
        capabilities: ['orm-entity'],
        emergent_api_calls: [],
        entity_schemas: [{ name: tableName, fields }],
    };
}

// ─── Column extraction ────────────────────────────────────────────────────────

interface ColumnHit {
    /** Index in the source where the `@ORM\Column` / `#[ORM\Column]` block starts. */
    startIndex: number;
    /** Index where the matched annotation ends, used to find the following property. */
    afterIndex: number;
    /** Explicit `name=` / `name:` value from the annotation, if any. */
    explicitName: string | null;
    /** Explicit `type=` / `type:` value, default `'string'`. */
    type: string;
    /** Explicit `nullable=` / `nullable:` value, default `false` (NOT NULL). */
    nullable: boolean;
}

/**
 * Parse `@ORM\Column(...)` docblock annotations and `#[ORM\Column(...)]`
 * PHP-8 attributes out of an ORM entity's class-metadata source. When the
 * annotation lacks `name=` (or `name:`), the column name falls back to the
 * subsequent property name (e.g. `protected $createdAt` → `createdAt`).
 *
 * Deterministic; no AST traversal. Robust to multi-line annotations and to
 * the order of `name`, `type`, `nullable` arguments.
 */
function extractDoctrineColumns(source: string): EntitySchemaDefinition['fields'] {
    const fields: EntitySchemaDefinition['fields'] = [];
    const seen = new Set<string>();

    // Match either the docblock form (`@ORM\Column(...)`) or the attribute
    // form (`#[ORM\Column(...)]`). The body capture is non-greedy and
    // multi-line aware via [\s\S].
    const columnRe = /(?:@ORM\\Column\s*\(([\s\S]*?)\)|#\[ORM\\Column\s*\(([\s\S]*?)\)\s*\])/g;
    const nextPropertyRe = /(?:public|protected|private)(?:\s+(?:readonly|static))?\s+(?:[^$;{]*?)\$([a-zA-Z_][a-zA-Z0-9_]*)/;

    let match: RegExpExecArray | null;
    while ((match = columnRe.exec(source)) !== null) {
        const body = (match[1] ?? match[2] ?? '');
        const afterIndex = match.index + match[0].length;

        // Find the next property declaration after this annotation. Stops at
        // the next `@ORM\Column` annotation to avoid jumping past sibling
        // properties that have a docblock with no `@ORM\Column`.
        const remainder = source.slice(afterIndex);
        const nextColumnIdx = remainder.search(/(?:@ORM\\Column|#\[ORM\\Column)/);
        const window = nextColumnIdx === -1 ? remainder : remainder.slice(0, nextColumnIdx);
        const propMatch = window.match(nextPropertyRe);
        const propertyName = propMatch ? propMatch[1] : null;

        const explicitName = body.match(/\bname\s*[:=]\s*["']([^"']+)["']/i)?.[1] ?? null;
        const type = body.match(/\btype\s*[:=]\s*["']([^"']+)["']/i)?.[1] ?? 'string';
        const nullable = /\bnullable\s*[:=]\s*true\b/i.test(body);

        const columnName = explicitName ?? propertyName;
        if (!columnName) continue;
        if (seen.has(columnName)) continue;
        seen.add(columnName);

        fields.push({ name: columnName, type, required: !nullable });
    }

    return fields;
}

function inferChannelKindFromServiceId(
    serviceId: string,
): 'topic' | 'subscription' | null {
    const normalized = serviceId.toLowerCase();
    if (/(^|[._-])subscriptions?([._-]|$)/.test(normalized)) return 'subscription';
    if (/(^|[._-])topics?([._-]|$)/.test(normalized)) return 'topic';
    return null;
}

function extractSymfonyAutowireMessageChannelStaticInfra(rootNode: Parser.SyntaxNode, chunk: CodeChunk): StaticInfraResult | null {
    const propertyToService = new Map<string, string>();
    const source = rootNode.text;
    const autowireRegex = /#\[\s*Autowire\s*\(\s*service\s*:\s*['"]([^'"]+)['"][\s\S]*?\)\s*\]\s*(?:public|protected|private)\s+[^$;)]+?\$(\w+)/g;

    for (const match of source.matchAll(autowireRegex)) {
        const serviceId = match[1]?.trim();
        const propertyName = match[2]?.trim();
        if (!serviceId || !propertyName) continue;
        propertyToService.set(propertyName, serviceId);
    }

    if (propertyToService.size === 0) return null;

    const infrastructure: StaticInfraResult['infrastructure'] = [];
    for (const [propertyName, serviceId] of propertyToService.entries()) {
        const receiver = `\\$this->${propertyName}->`;
        const writes = new RegExp(`${receiver}(publish|send|emit|dispatch)\\s*\\(`).test(chunk.sourceCode);
        const reads = new RegExp(`${receiver}(pull|consume|subscribe|receive|listen)\\s*\\(`).test(chunk.sourceCode);
        if (!writes && !reads) continue;

        const operation = reads ? 'READS' : 'WRITES';
        const channelKind = inferChannelKindFromServiceId(serviceId);
        if (!channelKind) continue;

        infrastructure.push({
            name: serviceId,
            type: 'MessageChannel',
            operation,
            channelKind,
        });
    }

    if (infrastructure.length === 0) return null;

    return {
        has_io: true,
        intent: 'Symfony Autowire message channel interaction',
        infrastructure,
        capabilities: infrastructure.some(infra => infra.operation === 'WRITES')
            ? ['message-publisher']
            : ['message-consumer'],
        emergent_api_calls: [],
    };
}

export function extractPhpStaticInfra(chunk: CodeChunk): StaticInfraResult | null {
    return extractPhpStaticInfraFromRoot(null, chunk);
}

export function extractPhpStaticInfraFromRoot(rootNode: Parser.SyntaxNode | null, chunk: CodeChunk): StaticInfraResult | null {
    if (chunk.name.endsWith('::__route_handler')) {
        return extractRouteStaticInfra(chunk);
    }

    if (!chunk.name.endsWith('::__class_metadata')) {
        return rootNode ? extractSymfonyAutowireMessageChannelStaticInfra(rootNode, chunk) : null;
    }

    return extractOrmMetadataStaticInfra(chunk);
}
