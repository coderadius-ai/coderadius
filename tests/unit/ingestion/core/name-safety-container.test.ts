import { describe, it, expect } from 'vitest';
import {
    isCodeExpressionName,
    isStorageTypeOrTransportToken,
    isDiServiceLocatorKey,
    isUnsafeContainerName,
    splitCloudObjectName,
} from '../../../../src/ingestion/core/name-safety.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DataContainer name-safety predicates (Phase 1).
//
// A :DataContainer is the logical unit of data WITHIN a Datastore — not only
// RDBMS tables / Mongo collections, but also object-storage buckets, KV
// keyspaces, filesystem paths. The fix must drop LEAKED names (the storage
// mechanism word itself, DI service-locator keys) while preserving legitimate
// non-table containers (real buckets, keyspaces, qualified collections).
//
// These predicates are shared by BOTH provenances: the LLM sanitizer and the
// static-bypass validator (which currently skips the sanitizer entirely).
// ═══════════════════════════════════════════════════════════════════════════════

describe('isStorageTypeOrTransportToken', () => {
    it('flags bare storage-mechanism / transport tokens (the type echoed as a container)', () => {
        for (const t of ['filesystem', 'file_system', 'file-system', 'disk', 'tmpfs',
                          'sftp', 'ftp', 'ftps', 'scp', 'smb', 'nfs', 'webdav',
                          'local_filesystem', 'local_storage']) {
            expect(isStorageTypeOrTransportToken(t), t).toBe(true);
        }
    });

    it('is case/whitespace-folded but EXACT-token (never substring)', () => {
        expect(isStorageTypeOrTransportToken('  SFTP ')).toBe(true);
        expect(isStorageTypeOrTransportToken('FileSystem')).toBe(true);
    });

    it('GUARDRAIL: a real container that merely CONTAINS a mechanism word survives', () => {
        for (const t of ['sftp-incoming', 'sftp_audit', 'file_imports', 'acme-sftp-incoming',
                         'user_files', 'disk_usage_log', 'order_files']) {
            expect(isStorageTypeOrTransportToken(t), t).toBe(false);
        }
    });
});

describe('isDiServiceLocatorKey', () => {
    it('flags dotted service-locator keys whose final segment is a handle/client suffix', () => {
        for (const k of ['archive.mongodb.client', 'acme-orders.mongodb.client',
                         'payment.connection',
                         'shipping.registry', 'billing.factory']) {
            expect(isDiServiceLocatorKey(k), k).toBe(true);
        }
    });

    it('GUARDRAIL: qualified data identifiers (schema.table, db.collection) survive', () => {
        for (const k of ['order_lines', 'inventory.orders', 'order.events',
                         'public.users', 'acme.shipments', 'payment.events']) {
            expect(isDiServiceLocatorKey(k), k).toBe(false);
        }
    });
});

describe('isUnsafeContainerName', () => {
    it('drops every leak class (type token, DI key, system db, generic tech, property name, template)', () => {
        for (const n of ['filesystem', 'sftp', 'archive.mongodb.client', 'admin', 'information_schema',
                         'mongodb', 'keyFilePath', '${TABLE}', 'config/avro/save.avsc']) {
            expect(isUnsafeContainerName(n), n).toBe(true);
        }
    });

    it('GUARDRAIL: legitimate containers survive — real tables, collections, buckets, keyspaces', () => {
        for (const n of ['catalog_customer', 'order_lines', 'quote_draft',
                         'order.events', 'acme-uploads', 'sftp-incoming']) {
            expect(isUnsafeContainerName(n), n).toBe(false);
        }
    });

    it('GUARDRAIL: cloud object-storage names are EXEMPT (buckets are valid containers)', () => {
        // Phase 3 repairs the name; Phase 1 must not delete it.
        expect(isUnsafeContainerName('googlecloudstorage.marketing')).toBe(false);
        expect(isUnsafeContainerName('s3.acme-invoices')).toBe(false);
    });

    it('drops code-expression-shaped names (array access echoed as a container)', () => {
        expect(isUnsafeContainerName("queueOptions['name']")).toBe(true);
        expect(isUnsafeContainerName('$row[\'table\']')).toBe(true);
    });

    it('uses source evidence when provided (DI handle key with no SQL context is unsafe)', () => {
        expect(isUnsafeContainerName('archive.mongodb.client', {
            sourceCode: "$this->mongo = $container->get('archive.mongodb.client');",
        })).toBe(true);
        // A real table with SQL context stays safe even though it is dotted-looking.
        expect(isUnsafeContainerName('order_lines', {
            sourceCode: 'SELECT * FROM order_lines WHERE id = ?',
        })).toBe(false);
    });
});

describe('isCodeExpressionName', () => {
    it('flags names shaped like runtime access/operator expressions', () => {
        for (const n of [
            "queueOptions['name']",   // bracket access, single-quote (the failing eval case)
            'opts["topic"]',          // bracket access, double-quote
            '$row[\'id\']',           // sigil + bracket
            'rows[0]',                // numeric index
            '$this->queueName',       // PHP arrow + sigil
            'this->table',            // arrow without sigil
            "config.get('queue')",    // call parens
            'repo.find()',            // empty-args call
            '${tablePrefix}',         // JS/PHP template sigil
        ]) {
            expect(isCodeExpressionName(n), n).toBe(true);
        }
    });

    it('GUARDRAIL: physical names and legit dynamic stubs survive (curly braces are NOT expressions)', () => {
        for (const n of [
            'booking_slot_{type}',                  // dynamic-SQL stub (pinned by php-dynamic-sql)
            'shipment_log_{carrierType}',           // dynamic-SQL stub
            '{providerId}_common.php',              // templated filename (handled by other guards)
            'validation_error_log',                 // snake_case collection
            'order_lines',                          // snake_case table
            'order.created',                        // dotted routing key
            'logistics.fulfillment.shipment.saved', // deep routing key
            'inventory.orders',                     // schema-qualified table
            's3.acme-invoices',                     // cloud bucket
            'user_files',                           // table containing a mechanism word
            'save-ready',                           // kebab channel
        ]) {
            expect(isCodeExpressionName(n), n).toBe(false);
        }
    });
});

describe('splitCloudObjectName', () => {
    it('splits <provider>.<bucket> into the bare bucket + canonical tech', () => {
        expect(splitCloudObjectName('gcs.acme-invoices')).toEqual({ bucket: 'acme-invoices', technology: 'gcs' });
        expect(splitCloudObjectName('googlecloudstorage.marketing')).toEqual({ bucket: 'marketing', technology: 'gcs' });
        expect(splitCloudObjectName('s3.events-archive')).toEqual({ bucket: 'events-archive', technology: 's3' });
        expect(splitCloudObjectName('cloudflarer2.assets')).toEqual({ bucket: 'assets', technology: 'r2' });
    });

    it('captures the bucket even when it is named like its provider (s3.s3 → bucket s3)', () => {
        expect(splitCloudObjectName('s3.s3')).toEqual({ bucket: 's3', technology: 's3' });
    });

    it('returns null for non-bucket names (schema-qualified table, DI key, plain)', () => {
        expect(splitCloudObjectName('inventory.orders')).toBeNull();
        expect(splitCloudObjectName('archive.mongodb.client')).toBeNull(); // dotted tail not [\\w-]+$
        expect(splitCloudObjectName('order_lines')).toBeNull();
        expect(splitCloudObjectName('s3.my.bucket')).toBeNull(); // dotted bucket not matched (unchanged)
    });
});
