import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { telemetryCollector } from '../../telemetry/index.js';
import { Agent } from '@mastra/core/agent';
import { getModel } from '../models/provider.js';
import { getAllSupportedExtensions } from '../../ingestion/core/languages/registry.js';
import { withCongestionControl } from '../../utils/congestion-control.js';
import type { AIMDSemaphore } from '../../utils/aimd-semaphore.js';
import {
    extractPhpDoctrineTableNames,
    buildDoctrineTableLookup,
    resolveDoctrineTableName,
} from '../../ingestion/core/languages/php/doctrine-table-names.js';

// ─── Response Schema ─────────────────────────────────────────────────────────

export const DataFieldExtractionSchema = z.object({
    name: z.string().describe('The field/column name'),
    type: z.string().describe('The field type (string, int, uuid, boolean, timestamp, etc.)'),
    required: z.boolean().default(true).describe('Whether the field is required (true) or optional/nullable (false)'),
});

export const DataSchemaExtractionSchema = z.object({
    name: z.string().describe('The physical table name (e.g., "case_file_documents", NOT the TS variable name) or the event name'),
    type: z.enum(['database_table', 'message_payload']).describe('Whether this is a DB table or a message/event payload'),
    fields: z.array(DataFieldExtractionSchema).describe('The fields/columns of the schema'),
    has_dynamic_keys: z.boolean().default(false).describe(
        'Set to true ONLY if the schema contains dynamic/runtime-generated keys ' +
        '(e.g., spread operators like ...obj, PHP foreach building keys, computed property names). ' +
        'This flags the schema as "open" with potentially untracked fields.',
    ),
});

export const DataSchemaResponseSchema = z.object({
    schemas: z.array(DataSchemaExtractionSchema).describe('Extracted schemas. Empty array [] if none found.'),
});

export type DataSchemaResponse = z.infer<typeof DataSchemaResponseSchema>;
export type DataSchemaExtraction = z.infer<typeof DataSchemaExtractionSchema>;

// ─── Post-LLM Validation ────────────────────────────────────────────────────

/**
 * Verb-prefix pattern that strongly indicates a function name, not a data structure.
 * Examples: createOrder, runBatchProcessor, spawnRecursiveWorker, calculateDiscount,
 *           isValidAddress, getOrderStatus, handlePayment, fetchUsers, validateInput.
 */
const FUNCTION_NAME_PATTERN = /^(create|run|spawn|calculate|is|get|set|process|handle|fetch|validate|check|format|parse|build|make|do|execute|find|update|delete|remove|save|load|init|start|stop|send|receive|dispatch|notify|mark|convert|apply|render|transform|compile|merge|split|filter|sort|map|reduce|emit|trigger|fire|invoke|call|resolve|reject|cancel|abort|retry|reset|flush|drain|poll|ping|test|mock|stub|assert|verify|sanitize|normalize|serialize|deserialize|encode|decode|encrypt|decrypt|sign|hash|log|print|dump|trace|debug|warn|throw|catch|try)[A-Z_]/;

/**
 * Matches file extensions — schemas should never be named after files.
 * Built dynamically from the plugin registry + universal config/infra extensions.
 * Adding a new language plugin automatically includes its extension here.
 */
function buildFileExtensionPattern(): RegExp {
    const pluginExts = getAllSupportedExtensions().map(e => e.replace('.', ''));
    // Universal non-code extensions that are never schema names
    const universalExts = ['sql', 'yaml', 'yml', 'json', 'xml', 'html', 'css', 'sh', 'bash'];
    const allExts = [...new Set([...pluginExts, ...universalExts])];
    return new RegExp(`\\.(${allExts.join('|')})$`, 'i');
}

const FILE_EXTENSION_PATTERN = buildFileExtensionPattern();

/**
 * Post-LLM validation: filter out false-positive schemas that passed through
 * despite prompt instructions. This is a deterministic safety net.
 */
export function validateSchemas(schemas: DataSchemaExtraction[]): DataSchemaExtraction[] {
    return schemas.filter(schema => {
        // 1. Reject opaque-only schemas (single _opaque_reference field = no useful info)
        if (schema.fields.length === 1 && schema.fields[0].name === '_opaque_reference') {
            logger.debug(`[SchemaExtractor:Validate] Rejected opaque-only schema: "${schema.name}"`);
            return false;
        }

        // 2. Reject function-named schemas (verbs as prefixes)
        if (FUNCTION_NAME_PATTERN.test(schema.name)) {
            logger.debug(`[SchemaExtractor:Validate] Rejected function-named schema: "${schema.name}"`);
            return false;
        }

        // 3. Reject file-path schemas (contain file extensions)
        if (FILE_EXTENSION_PATTERN.test(schema.name)) {
            logger.debug(`[SchemaExtractor:Validate] Rejected file-path schema: "${schema.name}"`);
            return false;
        }

        // 4. Reject schemas with 0 fields (empty extractions)
        if (schema.fields.length === 0) {
            logger.debug(`[SchemaExtractor:Validate] Rejected empty schema: "${schema.name}"`);
            return false;
        }

        // 5. Reject schemas whose name is a class fully-qualified name (FQCN)
        //    instead of a table/event name. The LLM occasionally returns the
        //    Doctrine entity class FQCN (`Entity\SupplierRenewals`) instead
        //    of the table name declared in `#[ORM\Table(name: ...)]`. Same
        //    pattern in Java/C# message payloads (`com.acme.orders.OrderCreated`).
        //    Table names NEVER contain backslashes; multi-segment dotted names
        //    (3+ parts) are unambiguous FQCNs (1-dot schemas like `public.orders`
        //    are legitimate SQL `schema.table` and are preserved).
        if (schema.name.includes('\\') || (schema.name.match(/\./g) ?? []).length >= 2) {
            logger.debug(`[SchemaExtractor:Validate] Rejected FQCN-shaped schema: "${schema.name}"`);
            return false;
        }

        return true;
    });
}

// ─── Agent ───────────────────────────────────────────────────────────────────

let _schemaExtractorAgent: Agent | null = null;
export function getSchemaExtractorAgent(): Agent {
    if (!_schemaExtractorAgent) {
        _schemaExtractorAgent = new Agent({
            id: 'schema-extractor-agent',
            name: 'Data Schema Extractor',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: `You are an expert Data Engineering code parser.

<core_directive>
Analyze the provided source code and extract concrete data structures: database table definitions (e.g., Drizzle, TypeORM, Prisma, Knex) or event/message payloads (e.g., Zod schemas, TypeScript interfaces, type aliases, decorator-based DTO classes).
You must return only the JSON structure requested by the tool schema.
</core_directive>

<extraction_rules>
- Extract ONLY concrete data structures: physical database tables, explicit message payloads, or event contracts.
- TypeScript decorator-based DTO/schema classes ARE valid data structures when the decorators give concrete schema facts.
  Relevant examples:
  - Swagger/Nest: \`@ApiProperty\`, \`@ApiPropertyOptional\`
  - GraphQL/type-graphql: \`@ObjectType\`, \`@InputType\`, \`@ArgsType\`, \`@Field\`
  - Validation/serialization: \`@IsOptional\`, \`@IsEnum\`, \`@Expose\`, \`@Exclude\`, \`@Type(() => NestedDto)\`
  Use these decorators to infer field names, optionality, aliases, nested DTO references, enum-like fields, and visibility.
- **IMPORTANT**: If an API endpoint or controller function destructures a request body (e.g. \`const { merchant_id, ...rest } = req.body\`), extract that implicit payload as a \`message_payload\` schema named after the endpoint or function.
- Do NOT extract utility types, generic helpers, or internal-only interfaces.
- CRITICAL FOR DATABASE TABLES: Extract exactly the PHYSICAL table name (usually the exact string passed to the table constructor like \`table("my_physical_name", ...)\`). Do NOT use the TypeScript variable name.
- For each valid schema, extract ALL fields along with their structural types.
- Normalize types to simple names: string, int, uuid, boolean, timestamp, text, json, float, enum, array.
- Determine if a field is \`required\` (true) or optional/nullable (false), abstracting the language-specific idioms:
  - TS: \`?\` property, \`Partial<T>\`, \`| undefined\`, \`z.optional()\` -> false
  - PHP: \`?type\`, \`= null\` default -> false
  - SQL/ORM: \`NOT NULL\`, \`.notNull()\` -> true, otherwise false
  - Default assumption: true
- Handling Dynamic Payloads (e.g., Spread Operators, Metaprogramming, API Passthrough):
  - If a payload is built dynamically (e.g. \`{ ...dynamicContext, orderId }\` or iterating \`$$var\`), you MUST extract ONLY the fields whose names are explicitly hardcoded (like \`orderId\`).
  - Do NOT invent or hallucinate keys for the dynamic portion. If a JSON table column contains dynamic keys, just extract the column itself as type \`json\`.
  - Do NOT create pattern fields (like \`ext_*\`) or placeholder fields (like \`dynamic_keys\`). Only emit concrete fields.
  - IMPORTANT: Set \`has_dynamic_keys: true\` on the schema to flag it as containing dynamic/untracked fields.
- If a field explicitly references another table (foreign key), use the format "fk:table_name".
- If no valid schemas are found in the source code, return an empty array.
</extraction_rules>

<critical_exclusions>
THESE ARE NOT DATA STRUCTURES. Do NOT extract them:

1. **Function/Method Parameter Signatures**: A function like \`calculateDiscount(orderType: string, cartData: array, customerData: array)\` defines a function's INPUT parameters, NOT a data structure. The same applies to \`isValidAddress(address: {street, city, zip})\`, \`dispatchToWarehouse(orderId, items)\`, etc. These are implementation details, not contracts.

2. **Script/Binary Names from exec/spawn/shell_exec**: If you see \`exec("php process_company.php")\` or \`spawn("node worker.js")\`, the script name is infrastructure, NOT a data payload. Do NOT create a schema for it.

3. **Internal Method Names**: Method names like \`spawnCompanyScript\`, \`runBatchProcessor\`, \`calculateShippingCost\` are function identifiers. They are NOT message payloads or data structures.

4. **Generic Return Types**: \`Promise<any>\`, \`Promise<void>\`, \`unknown\`, \`any\`, generic \`T\`, or unresolved type references are NOT schemas. Skip them entirely.

5. **Pure Helper/Utility Functions**: Functions that perform only in-memory computation (formatting, validation, arithmetic) with NO I/O have no associated data contract. Do NOT extract their signatures.

In summary: extract DECLARATIONS of data shapes (interfaces, types, Zod schemas, ORM tables, destructured request bodies), NOT the parameter lists of functions.
</critical_exclusions>`,
            model: getModel('ingest'),
        });
    }
    return _schemaExtractorAgent;
}

/**
 * Rename schemas whose `name` is a Doctrine entity FQCN to the actual
 * table name declared in `#[ORM\Table(name: ...)]`. Runs only for PHP files;
 * a no-op when the file declares no Doctrine attributes.
 */
function renameFqcnSchemasViaDoctrineAttribute(
    schemas: DataSchemaExtraction[],
    sourceCode: string,
): DataSchemaExtraction[] {
    const pairs = extractPhpDoctrineTableNames(sourceCode);
    if (pairs.length === 0) return schemas;
    const lookup = buildDoctrineTableLookup(pairs);
    return schemas.map(schema => {
        if (schema.type !== 'database_table') return schema;
        const corrected = resolveDoctrineTableName(schema.name, lookup);
        if (corrected && corrected !== schema.name) {
            logger.debug(`[SchemaExtractor] Renamed FQCN "${schema.name}" → "${corrected}" via Doctrine Table attribute`);
            return { ...schema, name: corrected };
        }
        return schema;
    });
}

/**
 * Extract data schemas (DB tables, message payloads) from source code.
 * Returns extracted schemas or an empty array if none found.
 */
export async function extractDataSchema(
    sourceCode: string,
    fileName: string,
    frameworkSignalContext?: string,
    limiter?: AIMDSemaphore | null,
): Promise<DataSchemaExtraction[]> {
    try {
        const prompt = `Analyze the following source file and extract any database table definitions or message/event payload schemas.

File: ${fileName}

${frameworkSignalContext ? `${frameworkSignalContext}\n` : ''}

\`\`\`
${sourceCode}
\`\`\``;

        logger.debug(`[SchemaExtractor] Starting generate for ${fileName}`);
        const startTime = telemetryCollector.startTimer();
        const response = await withCongestionControl(() =>
            getSchemaExtractorAgent().generate(prompt, {
                structuredOutput: {
                    schema: DataSchemaResponseSchema,
                },
                modelSettings: {
                    maxRetries: 0,
                    temperature: 0,
                },
            }),
            { limiter },
        );
        const duration = telemetryCollector.stopTimer(startTime);
        logger.debug(`[SchemaExtractor] Finished generate for ${fileName} in ${Math.round(duration)}ms`);

        telemetryCollector.addLLMTime(duration);
        telemetryCollector.addTokensForPhase('schema_extraction', response.usage);

        const rawSchemas = (response.object.schemas ?? []) as DataSchemaExtraction[];

        // Deterministic Doctrine `#[ORM\Table(name: ...)]` rename pass: when
        // the LLM emits the entity FQCN (`Entity\SupplierRenewals`) instead
        // of the SQL identifier declared in the Table attribute
        // (`supplier_renewals`), recover the real table name from the source.
        // Runs BEFORE validateSchemas so the renamed schemas survive the
        // FQCN drop applied there.
        const isPhpFile = /\.php$/i.test(fileName);
        const renamed = isPhpFile ? renameFqcnSchemasViaDoctrineAttribute(rawSchemas, sourceCode) : rawSchemas;

        // Post-LLM validation: deterministic safety net
        const validatedSchemas = validateSchemas(renamed);
        const rejected = rawSchemas.length - validatedSchemas.length;
        if (rejected > 0) {
            logger.debug(`[SchemaExtractor] Filtered out ${rejected} false-positive schema(s) from ${fileName}`);
        }

        return validatedSchemas;
    } catch (err) {
        const msg = (err as Error).message.toLowerCase();
        if (msg.includes('credentials') || msg.includes('api key') || msg.includes('authentication') || msg.includes('unauthorized')) {
            throw err;
        }
        logger.error(`[SchemaExtractor] Failed to extract schemas from ${fileName}: ${(err as Error).message}`);
        return [];
    }
}
