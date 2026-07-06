/**
 * Bug X follow-up — deterministic Doctrine `#[ORM\Table(name: ...)]`
 * extraction. Recovers the real table name when the LLM emits the entity
 * FQCN (`Entity\SupplierRenewals`) instead of the SQL identifier.
 */
import { describe, it, expect } from 'vitest';
import {
    extractPhpDoctrineTableNames,
    buildDoctrineTableLookup,
    resolveDoctrineTableName,
} from '../../../../../src/ingestion/core/languages/php/doctrine-table-names.js';

describe('extractPhpDoctrineTableNames', () => {
    it('PHP 8 attribute single-quoted', () => {
        const src = `<?php
            namespace Acme\\Orders\\Entity;
            #[ORM\\Entity]
            #[ORM\\Table(name: 'supplier_renewals')]
            class SupplierRenewals {}
        `;
        expect(extractPhpDoctrineTableNames(src)).toEqual([
            { className: 'SupplierRenewals', tableName: 'supplier_renewals' },
        ]);
    });

    it('PHP 8 attribute double-quoted', () => {
        const src = `<?php #[ORM\\Table(name: "orders")] class Order {}`;
        expect(extractPhpDoctrineTableNames(src)).toEqual([
            { className: 'Order', tableName: 'orders' },
        ]);
    });

    it('Table attribute with extra args after name', () => {
        const src = `<?php
            #[ORM\\Table(name: 'invoices', indexes: [new ORM\\Index(columns: ['id'])])]
            class Invoice {}
        `;
        expect(extractPhpDoctrineTableNames(src)).toEqual([
            { className: 'Invoice', tableName: 'invoices' },
        ]);
    });

    it('Legacy docblock annotation', () => {
        const src = `<?php
            /**
             * @ORM\\Entity
             * @ORM\\Table(name="legacy_users")
             */
            class LegacyUser {}
        `;
        expect(extractPhpDoctrineTableNames(src)).toEqual([
            { className: 'LegacyUser', tableName: 'legacy_users' },
        ]);
    });

    it('Multiple entities in one file', () => {
        const src = `<?php
            #[ORM\\Table(name: 'orders')] class Order {}
            #[ORM\\Table(name: 'invoices')] class Invoice {}
        `;
        expect(extractPhpDoctrineTableNames(src)).toEqual([
            { className: 'Order', tableName: 'orders' },
            { className: 'Invoice', tableName: 'invoices' },
        ]);
    });

    it('Class without Table attribute is skipped', () => {
        const src = `<?php class Plain {} #[ORM\\Table(name: 'x')] class X {}`;
        expect(extractPhpDoctrineTableNames(src)).toEqual([
            { className: 'X', tableName: 'x' },
        ]);
    });
});

describe('resolveDoctrineTableName', () => {
    const lookup = buildDoctrineTableLookup([
        { className: 'SupplierRenewals', tableName: 'supplier_renewals' },
        { className: 'Order', tableName: 'orders' },
    ]);

    it('resolves exact plain name', () => {
        expect(resolveDoctrineTableName('SupplierRenewals', lookup)).toBe('supplier_renewals');
    });

    it('resolves PHP FQCN', () => {
        expect(resolveDoctrineTableName('Acme\\Orders\\Entity\\SupplierRenewals', lookup))
            .toBe('supplier_renewals');
    });

    it('resolves last-segment of FQCN with dots (Java/C#)', () => {
        expect(resolveDoctrineTableName('com.acme.entity.Order', lookup)).toBe('orders');
    });

    it('returns null when no match', () => {
        expect(resolveDoctrineTableName('Unknown', lookup)).toBeNull();
        expect(resolveDoctrineTableName('Some\\Other\\Thing', lookup)).toBeNull();
    });

    it('empty lookup returns null', () => {
        expect(resolveDoctrineTableName('SupplierRenewals', new Map())).toBeNull();
    });
});
