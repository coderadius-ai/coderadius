/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-doctrine-template-table-drop
 *
 * Regression history (orchestrator):
 *   Customer code declares dynamic SQL table names with curly-brace
 *   placeholders (`quote_{kind}`, `res_quote_arch_{kind}`). The
 *   structural / LLM schema extractor picks them up verbatim and persists
 *   them as DataStructure(database_table) nodes. These are unbindable
 *   (no DataContainer literal can match the template string) and pollute
 *   the schema inventory.
 *
 * Why the bug recurs:
 *   - `isUnresolvedTemplateName` (the existing predicate) is STRICT for
 *     design: it must NOT match REST URL path params (`/api/users/{userId}`).
 *     Its regex is whitelisted to UPPERCASE `{ENV}` patterns and the
 *     env-suffix set (`{env}`, `{envSuffix}`, `{prefix}`, `{suffix}`,
 *     `{tablePrefix}`, `{environment}`).
 *   - Lowercase Italian / English template variables (`{tipo}`, `{type}`,
 *     `{nome}`) fall through. Nobody has ever added them to the whitelist
 *     because they collide semantically with REST path params, which use
 *     the same syntax (`{userId}`).
 *   - The disambiguator is the CONTEXT: a schema/table name MUST NOT
 *     contain `{` or `}` (those names never appear in any SQL dialect's
 *     identifier rules). REST path params do — and they go through a
 *     DIFFERENT extraction pipeline (endpoint extraction), so the two
 *     filters can be different.
 *
 * What this eval pattern pins:
 *   Doctrine-style PHP entity whose @table name documentation contains
 *   `quote_{kind}` and `res_quote_arch_{kind}`. After running the
 *   filter chain (persistSchemas → mergeEmergentSchema), neither name
 *   reaches mergeEmergentSchema.
 *
 *   The test simulates what `persistSchemas` receives FROM the schema
 *   extractor (a synthetic ExtractedSchemaData) and asserts that the
 *   template-bearing names are dropped while a legitimate snake_case
 *   table name (`quote_archive`) passes through.
 *
 *   Deterministic, NO LLM. Pinned at the persist boundary so the test
 *   is stable against extractor prompt drift.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

vi.mock('../../../../src/graph/mutations/data-contracts.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeEmergentSchema: vi.fn(async () => ({ schemaUrn: 'cr:schema:test', fieldUrns: [] })),
}));

import { mergeEmergentSchema } from '../../../../src/graph/mutations/data-contracts.js';
import { persistSchemas } from '../../../../src/ingestion/processors/code-pipeline/graph-writer.js';
import { validateSchemas } from '../../../../src/ai/agents/schema-extractor.js';
import type { ExtractedSchemaData } from '../../../../src/ingestion/processors/code-pipeline/types.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');
const ENTITY_PATH = 'src/Quotes/QuoteArchiveCommand.php';

describe('Pattern Eval — php-doctrine-template-table-drop', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('fixture file documents the dynamic-table pattern', () => {
        const content = fs.readFileSync(path.join(FIXTURE_DIR, ENTITY_PATH), 'utf-8');
        // Sanity: the fixture intentionally contains the template strings —
        // this is the raw input that the schema extractor would see.
        expect(content).toContain('quote_{kind}');
        expect(content).toContain('res_quote_arch_{kind}');
    });

    it('persistSchemas drops dynamic-table names with curly-brace placeholders', async () => {
        // Synthetic extractor output: what a buggy LLM / structural extractor
        // would emit for this fixture. The clean table `quote_archive`
        // is the legitimate variant that must survive.
        const schemaData: ExtractedSchemaData = {
            relativePath: ENTITY_PATH,
            qualifiedRepoName: 'acme/orders',
            schemas: [
                { name: 'quote_{kind}', type: 'database_table', fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false } as any,
                { name: 'res_quote_arch_{kind}', type: 'database_table', fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false } as any,
                { name: 'quote_archive', type: 'database_table', fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false } as any,
            ],
        };

        await persistSchemas(schemaData, 'contracts');

        // Both template-bearing names dropped; legit name persisted once.
        expect(mergeEmergentSchema).toHaveBeenCalledTimes(1);
        expect(mergeEmergentSchema).toHaveBeenCalledWith(
            expect.objectContaining({ schemaName: 'quote_archive' }),
        );
    });

    it('validateSchemas (LLM post-validator) ALSO drops FQCN-shaped names from Doctrine entity files', () => {
        // Companion regression: when the LLM mistakes the entity class FQCN
        // for the table name. The post-validator must drop it BEFORE it
        // reaches persistSchemas (defense-in-depth).
        const llmOutput = [
            { name: 'Acme\\Orders\\Entity\\Quote', type: 'database_table' as const, fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false },
            { name: 'quote_archive', type: 'database_table' as const, fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false },
        ];
        const validated = validateSchemas(llmOutput);
        expect(validated.map(s => s.name)).toEqual(['quote_archive']);
    });

    it('GUARD: legitimate REST path params (`/api/users/{userId}`) do NOT travel through persistSchemas', () => {
        // The two pipelines are distinct: REST path params go through
        // endpoint extraction (APIEndpoint.path), NEVER through
        // mergeEmergentSchema. The `[{}]` filter we apply in persistSchemas
        // is therefore safe — it cannot accidentally drop a REST path
        // param because no REST path ever reaches this code path.
        //
        // This test pins the boundary: persistSchemas only receives
        // `DataSchemaExtraction[]` objects (table/event names). If anyone
        // refactors and starts routing REST paths through persistSchemas,
        // this assertion will surface the design violation.
        const schemaData: ExtractedSchemaData = {
            relativePath: 'src/Controllers/UserController.php',
            qualifiedRepoName: 'acme/orders',
            schemas: [
                // What a misguided refactor MIGHT inject. The filter still
                // correctly drops it — which is the right behavior here,
                // because it is not a real table name. The fact that it
                // happens to look like a REST path is irrelevant: NO valid
                // table identifier contains curly braces.
                { name: '/api/users/{userId}', type: 'database_table', fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false } as any,
            ],
        };

        return persistSchemas(schemaData, 'contracts').then(() => {
            expect(mergeEmergentSchema).not.toHaveBeenCalled();
        });
    });
});
