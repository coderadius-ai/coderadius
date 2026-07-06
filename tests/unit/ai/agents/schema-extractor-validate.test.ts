/**
 * Unit test — `validateSchemas` (post-LLM safety net) MUST drop schemas
 * whose `name` is a class fully-qualified name (FQCN) instead of a table
 * name.
 *
 * Real-world bug (orchestrator, 2026-05-16):
 *   `classes/Entity/SupplierRenewals.php` declares a Doctrine entity with
 *   `#[ORM\Table(name: '<actual-table>')]`. The LLM occasionally returns
 *   the entity class FQCN (`Entity\SupplierRenewals`) as the schema name
 *   instead of reading the `name` attribute. Table names NEVER contain
 *   backslashes in any SQL dialect — the value is unbindable to any
 *   DataContainer and pollutes the schema inventory.
 *
 * Mitigation strategy: drop schemas whose name contains `\` as a
 * defense-in-depth filter on top of the prompt instructions. The legitimate
 * extraction loss (a Doctrine entity that the prompt failed on) is
 * preferable to a graph-wide FQCN-named ghost node that no welder can bind.
 */

import { describe, it, expect } from 'vitest';
import { validateSchemas } from '../../../../src/ai/agents/schema-extractor.js';

describe('validateSchemas — FQCN drop (Doctrine entity class names)', () => {
    it('drops database_table whose name is a PHP FQCN (contains backslash)', () => {
        const input = [
            { name: 'Entity\\SupplierRenewals', type: 'database_table' as const, fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false },
            { name: 'supplier_renewals', type: 'database_table' as const, fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false },
        ];
        const out = validateSchemas(input);
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('supplier_renewals');
    });

    it('drops message_payload whose name is a Java/C# FQCN', () => {
        const input = [
            { name: 'com.acme.orders.OrderCreated', type: 'message_payload' as const, fields: [{ name: 'orderId', type: 'string', required: true }], has_dynamic_keys: false },
            { name: 'OrderCreated', type: 'message_payload' as const, fields: [{ name: 'orderId', type: 'string', required: true }], has_dynamic_keys: false },
        ];
        const out = validateSchemas(input);
        // Both pass the existing filters; the FQCN drop must catch the first.
        const names = out.map(s => s.name);
        expect(names).toContain('OrderCreated');
        expect(names).not.toContain('com.acme.orders.OrderCreated');
    });

    it('preserves names with single dots that are NOT FQCN (e.g. namespaced table prefixes)', () => {
        // Some SQL dialects allow `schema.table` (Postgres, SQL Server). One dot
        // is ambiguous — keep it. The drop targets MULTI-segment FQCN (3+ parts
        // with dots, or anything with backslash) where the entity class
        // interpretation is unambiguous.
        const input = [
            { name: 'public.orders', type: 'database_table' as const, fields: [{ name: 'id', type: 'int', required: true }], has_dynamic_keys: false },
        ];
        const out = validateSchemas(input);
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('public.orders');
    });
});
