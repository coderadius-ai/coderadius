import yaml from 'js-yaml';
import { logger } from '../../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedSchemaField {
    name: string;
    type: string;
    required: boolean;
}

export interface ParsedBodySchema {
    /** Name from `$ref` target if present, else null (caller may generate a synthetic name). */
    name: string | null;
    fields: ParsedSchemaField[];
}

export interface ParsedEndpoint {
    path: string;
    method: string;
    operationId: string | null;
    summary: string;
    /** Request body schema (from `requestBody.content.application/json.schema`). */
    requestSchema?: ParsedBodySchema;
    /** Response body schema (preferring `200`/`201`/`default`, then `responses[*]`). */
    responseSchema?: ParsedBodySchema;
}

export interface ParsedOpenAPISpec {
    title: string;
    version: string;
    endpoints: ParsedEndpoint[];
    serverUrls: string[];
}

// ─── HTTP methods recognized in OpenAPI paths ────────────────────────────────

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'] as const;

// ─── JSON Schema → flat fields ──────────────────────────────────────────────

type AnyObj = Record<string, unknown>;

/** Resolve `$ref: '#/components/schemas/X'` against the OpenAPI document root. */
function resolveRef(doc: AnyObj, ref: string): { schema: AnyObj; name: string } | null {
    if (!ref.startsWith('#/')) return null;
    const parts = ref.slice(2).split('/');
    let cur: unknown = doc;
    for (const part of parts) {
        if (!cur || typeof cur !== 'object') return null;
        cur = (cur as AnyObj)[part];
    }
    if (!cur || typeof cur !== 'object') return null;
    return { schema: cur as AnyObj, name: parts[parts.length - 1] };
}

/**
 * Render a JSON Schema property's TYPE annotation as a compact string for
 * the `DataField.type` column. Examples:
 *   { type: 'string' }                           → 'string'
 *   { $ref: '#/components/schemas/Foo' }         → 'Foo'
 *   { type: 'array', items: { type: 'string' } } → 'Array<string>'
 *   { type: 'array', items: { $ref: '...Foo' } } → 'Array<Foo>'
 *   { type: 'object' }                           → 'object'
 */
function renderType(prop: AnyObj | undefined): string {
    if (!prop || typeof prop !== 'object') return 'unknown';
    if (typeof prop.$ref === 'string') {
        const parts = (prop.$ref as string).split('/');
        return parts[parts.length - 1] || 'object';
    }
    if (prop.type === 'array') {
        const items = prop.items as AnyObj | undefined;
        return `Array<${renderType(items)}>`;
    }
    if (typeof prop.type === 'string') return prop.type;
    return 'object';
}

/**
 * Flatten a JSON Schema (object) into depth-1 fields. Follows ONE `$ref`
 * hop at the top level so a body declared as `{ $ref: '#/components/schemas/X' }`
 * surfaces X's properties (and we get X's name for `ParsedBodySchema.name`).
 * Top-level arrays surface as a single virtual `_root` field with the
 * array type as the declared shape.
 *
 * Returns null when the schema is unparseable / empty.
 */
function flattenSchema(doc: AnyObj, schema: AnyObj | undefined): ParsedBodySchema | null {
    if (!schema || typeof schema !== 'object') return null;

    let name: string | null = null;
    let resolved: AnyObj = schema;

    if (typeof resolved.$ref === 'string') {
        const ref = resolveRef(doc, resolved.$ref);
        if (!ref) return null;
        name = ref.name;
        resolved = ref.schema;
    }

    if (resolved.type === 'array') {
        return {
            name,
            fields: [{ name: '_root', type: renderType(resolved), required: false }],
        };
    }

    if (resolved.type === 'object' || (resolved.properties && !resolved.type)) {
        const properties = (resolved.properties as AnyObj | undefined) ?? {};
        const requiredSet = new Set<string>(
            Array.isArray(resolved.required) ? (resolved.required as string[]) : [],
        );
        const fields: ParsedSchemaField[] = [];
        for (const [propName, propSchema] of Object.entries(properties)) {
            if (!propSchema || typeof propSchema !== 'object') continue;
            fields.push({
                name: propName,
                type: renderType(propSchema as AnyObj),
                required: requiredSet.has(propName),
            });
        }
        if (fields.length === 0 && !name) return null;
        return { name, fields };
    }

    // Scalar top-level body: rare but legal.
    return { name, fields: [{ name: '_root', type: renderType(resolved), required: false }] };
}

/** Pick `application/json` first, else fall back to the first content entry. */
function pickMediaSchema(content: AnyObj | undefined): AnyObj | undefined {
    if (!content || typeof content !== 'object') return undefined;
    const json = content['application/json'];
    if (json && typeof json === 'object' && (json as AnyObj).schema) {
        return (json as AnyObj).schema as AnyObj;
    }
    for (const media of Object.values(content)) {
        if (media && typeof media === 'object' && (media as AnyObj).schema) {
            return (media as AnyObj).schema as AnyObj;
        }
    }
    return undefined;
}

/** Pick the response schema: prefer 200/201/2xx/default, then any. */
function pickResponseSchema(responses: AnyObj | undefined): AnyObj | undefined {
    if (!responses || typeof responses !== 'object') return undefined;
    const PREFERRED = ['200', '201', '202', '2XX', 'default'];
    for (const code of PREFERRED) {
        const r = responses[code];
        if (r && typeof r === 'object') {
            const s = pickMediaSchema((r as AnyObj).content as AnyObj | undefined);
            if (s) return s;
        }
    }
    for (const r of Object.values(responses)) {
        if (r && typeof r === 'object') {
            const s = pickMediaSchema((r as AnyObj).content as AnyObj | undefined);
            if (s) return s;
        }
    }
    return undefined;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse an OpenAPI (v3) or Swagger (v2) specification file.
 * Returns structured spec data or null if the file is not a valid spec.
 */
export function parseOpenAPISpec(fileContent: string, filePath: string): ParsedOpenAPISpec | null {
    let doc: Record<string, unknown>;

    try {
        // Try YAML first (also handles JSON since JSON is valid YAML)
        doc = yaml.load(fileContent) as Record<string, unknown>;
    } catch {
        try {
            doc = JSON.parse(fileContent) as Record<string, unknown>;
        } catch (err) {
            logger.warn(`[OpenAPI] Failed to parse ${filePath}: ${(err as Error).message}`);
            return null;
        }
    }

    if (!doc || typeof doc !== 'object') {
        return null;
    }

    // Validate it's an OpenAPI/Swagger spec
    const isOpenAPI = typeof doc.openapi === 'string';
    const isSwagger = typeof doc.swagger === 'string';
    if (!isOpenAPI && !isSwagger) {
        return null;
    }

    // Extract info
    const info = doc.info as Record<string, unknown> | undefined;
    const title = (info?.title as string) || 'Untitled API';
    const version = (info?.version as string) || '0.0.0';

    // Extract server URLs (OpenAPI 3.x: servers[], Swagger 2.x: host + basePath)
    const serverUrls: string[] = [];
    if (isOpenAPI && Array.isArray(doc.servers)) {
        for (const server of doc.servers) {
            if (server && typeof server === 'object' && typeof (server as Record<string, unknown>).url === 'string') {
                serverUrls.push((server as Record<string, unknown>).url as string);
            }
        }
    } else if (isSwagger && typeof doc.host === 'string') {
        const scheme = Array.isArray(doc.schemes) && doc.schemes.length > 0 ? doc.schemes[0] : 'https';
        const basePath = typeof doc.basePath === 'string' ? doc.basePath : '';
        serverUrls.push(`${scheme}://${doc.host}${basePath}`);
    }

    // Extract endpoints from paths
    const paths = doc.paths as Record<string, Record<string, unknown>> | undefined;
    const endpoints: ParsedEndpoint[] = [];

    if (paths && typeof paths === 'object') {
        for (const [pathStr, pathItem] of Object.entries(paths)) {
            if (!pathItem || typeof pathItem !== 'object') continue;

            for (const method of HTTP_METHODS) {
                const operation = pathItem[method] as Record<string, unknown> | undefined;
                if (!operation || typeof operation !== 'object') continue;

                // Extract request/response body schemas (deterministic, depth-1).
                const requestBody = operation.requestBody as AnyObj | undefined;
                const requestMediaSchema = pickMediaSchema(requestBody?.content as AnyObj | undefined);
                const requestSchema = flattenSchema(doc, requestMediaSchema) ?? undefined;

                const responseMediaSchema = pickResponseSchema(operation.responses as AnyObj | undefined);
                const responseSchema = flattenSchema(doc, responseMediaSchema) ?? undefined;

                endpoints.push({
                    path: pathStr,
                    method: method.toUpperCase(),
                    operationId: (operation.operationId as string) || null,
                    summary: (operation.summary as string) || `${method.toUpperCase()} ${pathStr}`,
                    requestSchema,
                    responseSchema,
                });
            }
        }
    }

    return { title, version, endpoints, serverUrls };
}
