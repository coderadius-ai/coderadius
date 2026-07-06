/**
 * Unit test — `persistSchemas` MUST drop schemas whose `name` contains
 * unresolved template placeholders (`{tipo}`, `{type}`, etc.).
 *
 * Real-world bug (orchestrator, 2026-05-16): the structural / LLM schema
 * extractor leaked names like `quote_{kind}` and `res_quote_arch_{kind}`
 * into the graph as DataStructure(database_table) nodes. They are
 * unbindable (no DataContainer can match) and pollute the schema
 * inventory.
 *
 * `isUnresolvedTemplateName` is already applied to `produced_payloads` /
 * `consumed_payloads` in `graph-writer.ts:1010, 1069`, but NOT to the
 * structural `persistSchemas` path. This test pins the fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../src/graph/mutations/data-contracts.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeEmergentSchema: vi.fn(async () => ({ schemaUrn: 'cr:schema:test', fieldUrns: [] })),
}));

import { mergeEmergentSchema } from '../../../../../src/graph/mutations/data-contracts.js';
import { persistSchemas } from '../../../../../src/ingestion/processors/code-pipeline/graph-writer.js';
import type { ExtractedSchemaData } from '../../../../../src/ingestion/processors/code-pipeline/types.js';

describe('persistSchemas — unresolved template name filter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('drops database_table schemas with unresolved template placeholders', async () => {
        const schemaData: ExtractedSchemaData = {
            relativePath: 'src/Quotes/QuoteArchiveCommand.php',
            qualifiedRepoName: 'acme/orders',
            schemas: [
                { name: 'quote_{kind}', type: 'database_table', fields: [], has_dynamic_keys: false } as any,
                { name: 'res_quote_arch_{kind}', type: 'database_table', fields: [], has_dynamic_keys: false } as any,
                { name: 'orders', type: 'database_table', fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false } as any,
            ],
        };

        const count = await persistSchemas(schemaData, 'contracts');

        // Only the clean 'orders' schema should reach mergeEmergentSchema.
        // The two `{tipo}` templates are dropped before persistence.
        expect(mergeEmergentSchema).toHaveBeenCalledTimes(1);
        expect(mergeEmergentSchema).toHaveBeenCalledWith(
            expect.objectContaining({ schemaName: 'orders' }),
        );
        // The function still returns the count of CONSIDERED schemas
        // (drops are observable via mock, not via return value).
        expect(count).toBe(1);
    });

    it('drops message_payload schemas with unresolved template placeholders', async () => {
        const schemaData: ExtractedSchemaData = {
            relativePath: 'src/Quotes/QuoteService.php',
            qualifiedRepoName: 'acme/orders',
            schemas: [
                { name: 'quote_{type}', type: 'message_payload', fields: [], has_dynamic_keys: false } as any,
                { name: 'OrderCreated', type: 'message_payload', fields: [{ name: 'orderId', type: 'string', required: true }], has_dynamic_keys: false } as any,
            ],
        };

        await persistSchemas(schemaData, 'contracts');

        expect(mergeEmergentSchema).toHaveBeenCalledTimes(1);
        expect(mergeEmergentSchema).toHaveBeenCalledWith(
            expect.objectContaining({ schemaName: 'OrderCreated' }),
        );
    });

    it('preserves schemas with legitimate underscores (not template placeholders)', async () => {
        const schemaData: ExtractedSchemaData = {
            relativePath: 'src/Entity/User.php',
            qualifiedRepoName: 'acme/orders',
            schemas: [
                { name: 'fax_suppliers', type: 'database_table', fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false } as any,
                { name: 'user_session', type: 'database_table', fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false } as any,
            ],
        };

        await persistSchemas(schemaData, 'contracts');

        // Snake_case is fine — only `{...}` placeholders are dropped.
        expect(mergeEmergentSchema).toHaveBeenCalledTimes(2);
    });
});
