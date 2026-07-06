/**
 * Schema Contract Ingestion — deterministic Avro/Protobuf/JSON Schema parsing.
 *
 * Creates DataStructure + DataField nodes and links them to SourceFile
 * during the structural pass (Pass 0). This ensures that when the code
 * pipeline (Pass 1-2) encounters a MessageChannel with a schemaPath,
 * it can look up the pre-existing DataStructure by SourceFile path match
 * — eliminating phantom stubs and guaranteeing URN consistency.
 *
 * Currently supports:
 *   - Avro (.avsc) — full recursive type system (records, unions, enums,
 *                     logical types, arrays, maps, named type references)
 *
 * Future:
 *   - Protobuf (.proto)
 *   - JSON Schema (.json with $schema key)
 */
import path from 'node:path';
import fs from 'node:fs';
import { discoverSpecFiles } from '../core/source-resolver.js';
import { mergeEmergentSchema } from '../../graph/mutations/data-contracts.js';
import { linkRepositoryContainsSourceFile, linkServiceOwnsSourceFile, mergeSourceFileStub } from '../../graph/mutations/merkle.js';
import { logger } from '../../utils/logger.js';
import { traceCollector } from '../../telemetry/index.js';
import type { ResolvedRepo } from '../../graph/types.js';
import { getQualifiedRepoName } from '../../graph/urn.js';
import { astGrounding } from '../../graph/grounding.js';

const commitHash = 'SYSTEM';

/**
 * Determine the owning service for a spec file based on its absolute path.
 */
function resolveServiceForFile(
    absolutePath: string,
    serviceRoots: any[],
): string | undefined {
    let best: string | undefined;
    let bestLen = 0;

    for (const svc of serviceRoots) {
        const prefix = svc.path.endsWith(path.sep) ? svc.path : svc.path + path.sep;
        if (absolutePath.startsWith(prefix) && prefix.length > bestLen) {
            best = svc.name;
            bestLen = prefix.length;
        }
    }

    return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Recursive Avro Type Resolver
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A fully-resolved Avro field ready for graph persistence.
 * Nested record fields are flattened via dot-notation (e.g. "address.street").
 */
export interface ResolvedAvroField {
    name: string;
    type: string;
    required: boolean;
    logicalType?: string;
    enumSymbols?: string[];
    isArray?: boolean;
    isMap?: boolean;
    doc?: string;
    defaultValue?: string;
}

/** Avro primitive types that resolve to themselves. */
const AVRO_PRIMITIVES = new Set([
    'null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string',
]);

/**
 * Recursively resolve an Avro type definition into flat DataField entries.
 *
 * Handles the full Avro type system:
 *   - Primitives        → direct type string
 *   - Named references  → resolved via namedTypes registry
 *   - Records           → flattened with dot-notation prefix
 *   - Enums             → type "enum" with enumSymbols
 *   - Arrays            → inner type with isArray flag
 *   - Maps              → "map<valueType>" with isMap flag
 *   - Fixed             → type "fixed"
 *   - Unions            → null-union = optional, multi-union = pipe-delimited
 *   - Logical types     → logicalType property (decimal, timestamp-millis, uuid, etc.)
 *
 * @param avroType     The Avro type (string, object, or union array)
 * @param prefix       Dot-notation prefix from parent records (e.g. "address")
 * @param fieldName    The field name at this level
 * @param namedTypes   Registry of named types defined within the same schema file
 * @returns            Flat list of resolved fields
 */
export function resolveAvroType(
    avroType: any,
    prefix: string,
    fieldName: string,
    namedTypes: Map<string, any>,
): ResolvedAvroField[] {
    const fullName = prefix ? `${prefix}.${fieldName}` : fieldName;

    // ── String reference (primitive or named type) ───────────────────────
    if (typeof avroType === 'string') {
        if (AVRO_PRIMITIVES.has(avroType)) {
            return [{ name: fullName, type: avroType, required: true }];
        }
        // Named type reference — resolve from registry
        const resolved = namedTypes.get(avroType);
        if (resolved) {
            return resolveAvroType(resolved, prefix, fieldName, namedTypes);
        }
        // Unresolvable cross-file reference
        return [{ name: fullName, type: 'reference', required: true, doc: `Unresolved type: ${avroType}` }];
    }

    // ── Union (array of types) ──────────────────────────────────────────
    if (Array.isArray(avroType)) {
        return resolveAvroUnion(avroType, prefix, fieldName, namedTypes);
    }

    // ── Complex type (object with "type" key) ───────────────────────────
    if (typeof avroType === 'object' && avroType !== null) {
        const complexType = avroType.type;

        // Logical type annotation on a primitive
        if (avroType.logicalType) {
            const baseType = typeof complexType === 'string' ? complexType : 'bytes';
            return [{
                name: fullName,
                type: baseType,
                required: true,
                logicalType: avroType.logicalType,
            }];
        }

        switch (complexType) {
            case 'record': {
                // Register named type for cross-references within the same file
                if (avroType.name) {
                    namedTypes.set(avroType.name, avroType);
                }
                // Flatten nested record fields with dot-notation
                const nestedFields: ResolvedAvroField[] = [];
                if (Array.isArray(avroType.fields)) {
                    for (const nestedField of avroType.fields) {
                        if (!nestedField.name) continue;
                        const resolved = resolveAvroFieldEntry(nestedField, fullName, namedTypes);
                        nestedFields.push(...resolved);
                    }
                }
                return nestedFields;
            }

            case 'enum': {
                // Register named type for cross-references
                if (avroType.name) {
                    namedTypes.set(avroType.name, avroType);
                }
                return [{
                    name: fullName,
                    type: 'enum',
                    required: true,
                    enumSymbols: Array.isArray(avroType.symbols) ? avroType.symbols : [],
                    doc: avroType.doc,
                }];
            }

            case 'array': {
                // Resolve inner item type
                // Known limitation: if items is an anonymous record (no `name`),
                // resolveTypeLabel returns "record" and the nested fields are lost.
                // Supporting that shape would mean recursing via resolveAvroType and
                // emitting dot-notation children (e.g. "items[].sku") instead of a
                // single opaque field.
                const itemType = avroType.items;
                const resolvedItemType = resolveTypeLabel(itemType, namedTypes);
                return [{
                    name: fullName,
                    type: resolvedItemType,
                    required: true,
                    isArray: true,
                }];
            }

            case 'map': {
                // Resolve map value type
                const valueType = avroType.values;
                const resolvedValueType = resolveTypeLabel(valueType, namedTypes);
                return [{
                    name: fullName,
                    type: `map<${resolvedValueType}>`,
                    required: true,
                    isMap: true,
                }];
            }

            case 'fixed': {
                if (avroType.name) {
                    namedTypes.set(avroType.name, avroType);
                }
                return [{
                    name: fullName,
                    type: 'fixed',
                    required: true,
                    logicalType: avroType.logicalType,
                }];
            }

            default: {
                // Fallback for unknown complex types — treat as primitive if string
                if (typeof complexType === 'string' && AVRO_PRIMITIVES.has(complexType)) {
                    return [{
                        name: fullName,
                        type: complexType,
                        required: true,
                        logicalType: avroType.logicalType,
                    }];
                }
                // Truly unknown — emit as opaque
                return [{
                    name: fullName,
                    type: typeof complexType === 'string' ? complexType : 'unknown',
                    required: true,
                }];
            }
        }
    }

    // Fallback — should never reach here
    return [{ name: fullName, type: 'unknown', required: true }];
}

/**
 * Resolve an Avro union type.
 *
 * Special cases:
 *   - ["null", X]    → single field with required=false, type=resolved(X)
 *   - [X, "null"]    → same (null can be in any position)
 *   - [A, B, C]      → single field with type="A | B | C" (pipe-delimited)
 *   - ["null", A, B] → single field with required=false, type="A | B"
 */
function resolveAvroUnion(
    unionTypes: any[],
    prefix: string,
    fieldName: string,
    namedTypes: Map<string, any>,
): ResolvedAvroField[] {
    const fullName = prefix ? `${prefix}.${fieldName}` : fieldName;

    // Partition: null vs non-null branches
    const hasNull = unionTypes.some(t => t === 'null');
    const nonNullTypes = unionTypes.filter(t => t !== 'null');

    // Single non-null type in union → simple optional field
    if (nonNullTypes.length === 1) {
        const innerType = nonNullTypes[0];

        // If the inner type is a record → flatten with dot-notation, mark all as optional
        if (typeof innerType === 'object' && innerType !== null && innerType.type === 'record') {
            const nestedFields = resolveAvroType(innerType, prefix, fieldName, namedTypes);
            if (hasNull) {
                // Mark all nested fields as optional since the parent is nullable
                return nestedFields.map(f => ({ ...f, required: false }));
            }
            return nestedFields;
        }

        // Simple type resolution
        const resolvedFields = resolveAvroType(innerType, prefix, fieldName, namedTypes);
        if (hasNull) {
            return resolvedFields.map(f => ({ ...f, required: false }));
        }
        return resolvedFields;
    }

    // Multi-type union → pipe-delimited type string
    const typeLabels = nonNullTypes.map(t => resolveTypeLabel(t, namedTypes));
    return [{
        name: fullName,
        type: typeLabels.join(' | '),
        required: !hasNull,
    }];
}

/**
 * Resolve a single Avro field entry (field object with name, type, doc, default).
 * This is the entry point for each element in a record's `fields` array.
 */
function resolveAvroFieldEntry(
    field: any,
    parentPrefix: string,
    namedTypes: Map<string, any>,
): ResolvedAvroField[] {
    const resolved = resolveAvroType(field.type, parentPrefix, field.name, namedTypes);

    // Annotate with field-level metadata
    for (const r of resolved) {
        // Only annotate the "root" field (exact name match), not deeply nested children
        const expectedName = parentPrefix ? `${parentPrefix}.${field.name}` : field.name;
        if (r.name === expectedName) {
            if (field.doc && !r.doc) r.doc = field.doc;
            if (field.default !== undefined && r.defaultValue === undefined) {
                r.defaultValue = typeof field.default === 'string' ? field.default : JSON.stringify(field.default);
                // A field with an explicit default is effectively optional
                if (field.default === null) r.required = false;
            }
        }
    }

    return resolved;
}

/**
 * Get a human-readable type label for a type (without flattening records).
 * Used for array item types, map value types, and multi-union labels.
 */
function resolveTypeLabel(avroType: any, namedTypes: Map<string, any>): string {
    if (typeof avroType === 'string') {
        return avroType;
    }
    if (Array.isArray(avroType)) {
        // Inline union inside array/map — render as pipe-delimited
        const parts = avroType.filter((t: any) => t !== 'null').map((t: any) => resolveTypeLabel(t, namedTypes));
        const hasNull = avroType.includes('null');
        const label = parts.join(' | ');
        return hasNull ? `${label}?` : label;
    }
    if (typeof avroType === 'object' && avroType !== null) {
        if (avroType.logicalType) return avroType.logicalType;
        if (avroType.type === 'record') return avroType.name || 'record';
        if (avroType.type === 'enum') return avroType.name || 'enum';
        if (avroType.type === 'array') return `array<${resolveTypeLabel(avroType.items, namedTypes)}>`;
        if (avroType.type === 'map') return `map<${resolveTypeLabel(avroType.values, namedTypes)}>`;
        if (avroType.type === 'fixed') return avroType.name || 'fixed';
        if (typeof avroType.type === 'string') return avroType.type;
    }
    return 'unknown';
}

/**
 * Parse a top-level Avro schema and resolve all fields recursively.
 *
 * @param avro  The parsed JSON of an .avsc file
 * @returns     Flat array of resolved fields with dot-notation for nested records
 */
export function parseAvroSchema(avro: any): {
    fields: ResolvedAvroField[];
    namespace?: string;
    doc?: string;
} {
    const namedTypes = new Map<string, any>();

    // Register the top-level record itself as a named type
    if (avro.name) {
        namedTypes.set(avro.name, avro);
    }

    const fields: ResolvedAvroField[] = [];

    if (Array.isArray(avro.fields)) {
        for (const field of avro.fields) {
            if (!field.name) continue;
            const resolved = resolveAvroFieldEntry(field, '', namedTypes);
            fields.push(...resolved);
        }
    }

    return {
        fields,
        namespace: avro.namespace,
        doc: avro.doc,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Schema File Ingestion
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ingest schema contract files (Avro, Protobuf, etc.) from all repos.
 *
 * Creates DataStructure nodes with their fields, linked to SourceFile nodes,
 * so the code pipeline can discover them via SourceFile path matching.
 */
export async function ingestSchemaFiles(
    repos: ResolvedRepo[],
    serviceRoots: any[] = [],
    task?: { report: (msg: string) => void },
): Promise<{ schemasProcessed: number; errors: string[] }> {
    let schemasProcessed = 0;
    const errors: string[] = [];

    for (const repo of repos) {
        const specFiles = await discoverSpecFiles(repo.path);
        const avroFiles = specFiles.filter(f => path.extname(f).toLowerCase() === '.avsc');

        if (avroFiles.length === 0) continue;
        logger.debug(`[Schema] Found ${avroFiles.length} Avro schema(s) in ${repo.name}`);

        for (const specFile of avroFiles) {
            try {
                const relPath = path.relative(repo.path, specFile);
                const content = fs.readFileSync(specFile, 'utf-8');
                const avro = JSON.parse(content);

                const schemaName = avro.name || path.basename(specFile, '.avsc');

                // Recursively resolve all fields (nested records, unions, enums, etc.)
                const { fields, namespace, doc } = parseAvroSchema(avro);

                // Create DataStructure + DataField nodes, linked to SourceFile.
                // Uses mergeEmergentSchema which handles UPSERT correctly:
                //   - ON CREATE: freezes first-seen display name
                //   - ON MATCH: updates fields without duplication
                //   - Links SourceFile -[:DEFINES_SCHEMA]→ DataStructure
                // Pre-create the SourceFile node with a proper URN so that it doesn't get orphaned.
                // When mergeEmergentSchema runs `MERGE (sf:SourceFile {path: $filepath})`, it will
                // match this exact node because it has the path property set.
                await mergeSourceFileStub(getQualifiedRepoName(repo), relPath);

                await mergeEmergentSchema({
                    qualifiedRepoName: getQualifiedRepoName(repo),
                    filepath: relPath,
                    schemaName,
                    schemaType: 'message_payload',
                    fields,
                    commitHash,
                    namespace,
                    doc,
                    schemaFormat: 'avro',
                    grounding: astGrounding('avro-schema-extractor@v1'),
                });

                const ownerName = resolveServiceForFile(specFile, serviceRoots);
                logger.debug(`[Schema] Resolved owner for ${relPath} → ${ownerName ?? 'repository-fallback'}`);
                if (ownerName) {
                    await linkServiceOwnsSourceFile(getQualifiedRepoName(repo), ownerName, relPath, commitHash);
                } else {
                    await linkRepositoryContainsSourceFile(getQualifiedRepoName(repo), relPath, commitHash);
                }

                schemasProcessed++;
                traceCollector.traceContract('INCLUDE', relPath,
                    `parsed Avro schema: ${schemaName} (${fields.length} fields)`,
                    { schemaName, fieldCount: fields.length, namespace });

                if (task) task.report(`  Avro: ${relPath} → ${schemaName} (${fields.length} fields)`);
            } catch (err) {
                const msg = `[Schema] Skipped ${path.relative(repo.path, specFile)}: ${(err as Error).message}`;
                logger.debug(msg);
                errors.push(msg);
            }
        }
    }

    return { schemasProcessed, errors };
}
