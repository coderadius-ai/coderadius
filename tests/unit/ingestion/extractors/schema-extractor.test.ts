import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { ingestSchemaFiles, resolveAvroType, parseAvroSchema } from '../../../../src/ingestion/extractors/schema-extractor.js';
import type { ResolvedAvroField } from '../../../../src/ingestion/extractors/schema-extractor.js';
import type { ResolvedRepo } from '../../../../src/graph/types.js';

// ── Mock the graph queries module ────────────────────────────────────────────
vi.mock('../../../../src/graph/mutations/data-contracts.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeEmergentSchema: vi.fn(),
}));
vi.mock('../../../../src/graph/mutations/merkle.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mergeSourceFileStub: vi.fn(),
    linkServiceOwnsSourceFile: vi.fn(),
    linkRepositoryContainsSourceFile: vi.fn(),
}));

// ── Mock the source-resolver (discoverSpecFiles) ─────────────────────────────
vi.mock('../../../../src/ingestion/core/source-resolver.js', () => ({
    discoverSpecFiles: vi.fn(),
}));

import { mergeEmergentSchema } from '../../../../src/graph/mutations/data-contracts.js';
import { mergeSourceFileStub, linkServiceOwnsSourceFile, linkRepositoryContainsSourceFile } from '../../../../src/graph/mutations/merkle.js';
import { discoverSpecFiles } from '../../../../src/ingestion/core/source-resolver.js';

const FIXTURES_AVRO = path.resolve(__dirname, '../../../fixtures/avro');

const mockRepo: ResolvedRepo = {
    name: 'test-avro-repo',
    path: FIXTURES_AVRO,
    origin: 'local',
    branch: 'main',
    commit: 'abc123',
};

// ═════════════════════════════════════════════════════════════════════════════
// Unit Tests: resolveAvroType (Recursive Type Resolver)
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveAvroType — Recursive Type Resolver', () => {
    const namedTypes = new Map<string, any>();

    beforeEach(() => {
        namedTypes.clear();
    });

    it('should resolve primitive string types', () => {
        const result = resolveAvroType('string', '', 'name', namedTypes);
        expect(result).toEqual([{ name: 'name', type: 'string', required: true }]);
    });

    it('should resolve all Avro primitives', () => {
        for (const prim of ['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']) {
            const result = resolveAvroType(prim, '', 'field', namedTypes);
            expect(result[0].type).toBe(prim);
        }
    });

    it('should resolve union ["null", "string"] → optional string', () => {
        const result = resolveAvroType(['null', 'string'], '', 'email', namedTypes);
        expect(result).toEqual([{ name: 'email', type: 'string', required: false }]);
    });

    it('should resolve union ["string", "null"] → optional string (null at end)', () => {
        const result = resolveAvroType(['string', 'null'], '', 'email', namedTypes);
        expect(result).toEqual([{ name: 'email', type: 'string', required: false }]);
    });

    it('should resolve multi-type union ["null", "int", "string"] → pipe-delimited optional', () => {
        const result = resolveAvroType(['null', 'int', 'string'], '', 'priority', namedTypes);
        expect(result).toEqual([{
            name: 'priority',
            type: 'int | string',
            required: false,
        }]);
    });

    it('should resolve multi-type union without null → required pipe-delimited', () => {
        const result = resolveAvroType(['int', 'string', 'boolean'], '', 'value', namedTypes);
        expect(result).toEqual([{
            name: 'value',
            type: 'int | string | boolean',
            required: true,
        }]);
    });

    it('should resolve nested record → dot-notation flattening', () => {
        const recordType = {
            type: 'record',
            name: 'Address',
            fields: [
                { name: 'street', type: 'string' },
                { name: 'city', type: 'string' },
            ],
        };
        const result = resolveAvroType(recordType, '', 'shippingAddress', namedTypes);
        expect(result).toEqual([
            { name: 'shippingAddress.street', type: 'string', required: true },
            { name: 'shippingAddress.city', type: 'string', required: true },
        ]);
    });

    it('should resolve deeply nested records → multi-level dot-notation', () => {
        const recordType = {
            type: 'record',
            name: 'ContactInfo',
            fields: [
                { name: 'phone', type: 'string' },
                {
                    name: 'address',
                    type: {
                        type: 'record',
                        name: 'AddressInner',
                        fields: [
                            { name: 'street', type: 'string' },
                            { name: 'zip', type: 'string' },
                        ],
                    },
                },
            ],
        };
        const result = resolveAvroType(recordType, '', 'contact', namedTypes);
        expect(result).toEqual([
            { name: 'contact.phone', type: 'string', required: true },
            { name: 'contact.address.street', type: 'string', required: true },
            { name: 'contact.address.zip', type: 'string', required: true },
        ]);
    });

    it('should resolve nullable nested record → all children marked optional', () => {
        const unionType = [
            'null',
            {
                type: 'record',
                name: 'Billing',
                fields: [
                    { name: 'street', type: 'string' },
                    { name: 'city', type: 'string' },
                ],
            },
        ];
        const result = resolveAvroType(unionType, '', 'billing', namedTypes);
        expect(result).toEqual([
            { name: 'billing.street', type: 'string', required: false },
            { name: 'billing.city', type: 'string', required: false },
        ]);
    });

    it('should resolve enum type → type "enum" with enumSymbols array', () => {
        const enumType = {
            type: 'enum',
            name: 'OrderStatus',
            symbols: ['PENDING', 'CONFIRMED', 'SHIPPED'],
        };
        const result = resolveAvroType(enumType, '', 'status', namedTypes);
        expect(result).toEqual([{
            name: 'status',
            type: 'enum',
            required: true,
            enumSymbols: ['PENDING', 'CONFIRMED', 'SHIPPED'],
            doc: undefined,
        }]);
    });

    it('should resolve array type → isArray flag', () => {
        const arrayType = { type: 'array', items: 'string' };
        const result = resolveAvroType(arrayType, '', 'tags', namedTypes);
        expect(result).toEqual([{
            name: 'tags',
            type: 'string',
            required: true,
            isArray: true,
        }]);
    });

    it('should resolve map type → isMap flag with map<type>', () => {
        const mapType = { type: 'map', values: 'string' };
        const result = resolveAvroType(mapType, '', 'metadata', namedTypes);
        expect(result).toEqual([{
            name: 'metadata',
            type: 'map<string>',
            required: true,
            isMap: true,
        }]);
    });

    it('should resolve logical types (decimal, timestamp-millis, uuid)', () => {
        const decimalType = { type: 'bytes', logicalType: 'decimal', precision: 10, scale: 2 };
        const result = resolveAvroType(decimalType, '', 'amount', namedTypes);
        expect(result).toEqual([{
            name: 'amount',
            type: 'bytes',
            required: true,
            logicalType: 'decimal',
        }]);

        const timestampType = { type: 'long', logicalType: 'timestamp-millis' };
        const result2 = resolveAvroType(timestampType, '', 'createdAt', namedTypes);
        expect(result2).toEqual([{
            name: 'createdAt',
            type: 'long',
            required: true,
            logicalType: 'timestamp-millis',
        }]);
    });

    it('should resolve fixed type', () => {
        const fixedType = { type: 'fixed', name: 'MD5', size: 16 };
        const result = resolveAvroType(fixedType, '', 'checksum', namedTypes);
        expect(result).toEqual([{
            name: 'checksum',
            type: 'fixed',
            required: true,
            logicalType: undefined,
        }]);
    });

    it('should resolve named type references via registry', () => {
        // Register a named type
        namedTypes.set('OrderStatus', {
            type: 'enum',
            name: 'OrderStatus',
            symbols: ['ACTIVE', 'INACTIVE'],
        });
        const result = resolveAvroType('OrderStatus', '', 'status', namedTypes);
        expect(result).toEqual([{
            name: 'status',
            type: 'enum',
            required: true,
            enumSymbols: ['ACTIVE', 'INACTIVE'],
            doc: undefined,
        }]);
    });

    it('should handle unresolvable references gracefully', () => {
        const result = resolveAvroType('com.acme.SharedType', '', 'external', namedTypes);
        expect(result).toEqual([{
            name: 'external',
            type: 'reference',
            required: true,
            doc: 'Unresolved type: com.acme.SharedType',
        }]);
    });

    it('should use dot-notation prefix when provided', () => {
        const result = resolveAvroType('string', 'parent', 'child', namedTypes);
        expect(result).toEqual([{ name: 'parent.child', type: 'string', required: true }]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Unit Tests: parseAvroSchema (Full Schema Parsing)
// ═════════════════════════════════════════════════════════════════════════════

describe('parseAvroSchema — Full Schema Parsing', () => {
    it('should parse a simple flat schema', () => {
        const avro = {
            type: 'record',
            name: 'SimpleEvent',
            namespace: 'com.test',
            fields: [
                { name: 'id', type: 'string' },
                { name: 'count', type: 'int' },
            ],
        };
        const result = parseAvroSchema(avro);
        expect(result.namespace).toBe('com.test');
        expect(result.fields).toEqual([
            { name: 'id', type: 'string', required: true },
            { name: 'count', type: 'int', required: true },
        ]);
    });

    it('should parse the complex order fixture', () => {
        // Load from file to test real-world scenario
        const avro = JSON.parse(
            require('node:fs').readFileSync(
                path.join(FIXTURES_AVRO, 'schemas/order-complex.avsc'), 'utf-8')
        );

        const result = parseAvroSchema(avro);

        expect(result.namespace).toBe('com.acme.events');
        expect(result.doc).toBe('Emitted when a new order is placed');

        // Verify field extraction
        const fieldNames = result.fields.map(f => f.name);
        expect(fieldNames).toContain('orderId');
        expect(fieldNames).toContain('customerId');
        expect(fieldNames).toContain('amount');
        expect(fieldNames).toContain('status');
        expect(fieldNames).toContain('shippingAddress.street');
        expect(fieldNames).toContain('shippingAddress.city');
        expect(fieldNames).toContain('shippingAddress.zip');
        expect(fieldNames).toContain('tags');
        expect(fieldNames).toContain('metadata');
        expect(fieldNames).toContain('priority');
        expect(fieldNames).toContain('createdAt');

        // Verify specific field properties
        const findField = (name: string) => result.fields.find(f => f.name === name)!;

        // orderId — simple string
        expect(findField('orderId')).toEqual(
            expect.objectContaining({ type: 'string', required: true })
        );

        // amount — logical type decimal
        expect(findField('amount')).toEqual(
            expect.objectContaining({ type: 'bytes', required: true, logicalType: 'decimal' })
        );

        // status — enum
        const statusField = findField('status');
        expect(statusField.type).toBe('enum');
        expect(statusField.enumSymbols).toEqual(['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED']);

        // shippingAddress.zip — nullable nested field
        expect(findField('shippingAddress.zip')).toEqual(
            expect.objectContaining({ type: 'string', required: false })
        );

        // tags — array
        expect(findField('tags')).toEqual(
            expect.objectContaining({ type: 'string', required: true, isArray: true })
        );

        // metadata — nullable map
        expect(findField('metadata')).toEqual(
            expect.objectContaining({ type: 'map<string>', required: false, isMap: true })
        );

        // priority — multi-type union (null, int, string) → pipe-delimited
        expect(findField('priority')).toEqual(
            expect.objectContaining({ type: 'int | string', required: false })
        );

        // createdAt — logical type timestamp-millis
        expect(findField('createdAt')).toEqual(
            expect.objectContaining({ type: 'long', required: true, logicalType: 'timestamp-millis' })
        );
    });

    it('should parse the payment fixture with nullable nested records', () => {
        const avro = JSON.parse(
            require('node:fs').readFileSync(
                path.join(FIXTURES_AVRO, 'schemas/payment-processed.avsc'), 'utf-8')
        );

        const result = parseAvroSchema(avro);
        expect(result.namespace).toBe('com.acme.payments');

        const fieldNames = result.fields.map(f => f.name);

        // Nullable nested record — all child fields should be optional
        expect(fieldNames).toContain('billingAddress.street');
        expect(fieldNames).toContain('billingAddress.city');
        expect(fieldNames).toContain('billingAddress.country');

        const findField = (name: string) => result.fields.find(f => f.name === name)!;
        expect(findField('billingAddress.street').required).toBe(false);
        expect(findField('billingAddress.city').required).toBe(false);
        expect(findField('billingAddress.country').required).toBe(false);

        // Array of records — items renders as type label
        expect(findField('items')).toEqual(
            expect.objectContaining({ type: 'LineItem', isArray: true })
        );

        // UUID logical type
        expect(findField('transactionId')).toEqual(
            expect.objectContaining({ type: 'string', logicalType: 'uuid' })
        );

        // Fixed type
        expect(findField('checksum')).toEqual(
            expect.objectContaining({ type: 'fixed' })
        );
    });

    it('should handle field-level doc and default annotations', () => {
        const avro = {
            type: 'record',
            name: 'Annotated',
            fields: [
                { name: 'id', type: 'string', doc: 'Unique identifier' },
                { name: 'count', type: 'int', default: 0 },
                { name: 'label', type: ['null', 'string'], default: null },
            ],
        };
        const result = parseAvroSchema(avro);
        const findField = (name: string) => result.fields.find(f => f.name === name)!;

        expect(findField('id').doc).toBe('Unique identifier');
        expect(findField('count').defaultValue).toBe('0');
        expect(findField('label').required).toBe(false);
        expect(findField('label').defaultValue).toBe('null');
    });

    it('should handle schema with no namespace', () => {
        const avro = {
            type: 'record',
            name: 'NoNamespace',
            fields: [{ name: 'x', type: 'int' }],
        };
        const result = parseAvroSchema(avro);
        expect(result.namespace).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Integration Tests: ingestSchemaFiles (E2E with Mocked Graph)
// ═════════════════════════════════════════════════════════════════════════════

describe('Schema Extractor — Avro Ingestion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should parse valid Avro schemas and create DataStructure + DataField nodes', async () => {
        vi.mocked(discoverSpecFiles).mockResolvedValue([
            path.join(FIXTURES_AVRO, 'schemas/order-created.avsc'),
            path.join(FIXTURES_AVRO, 'schemas/user-updated.avsc'),
        ]);

        const result = await ingestSchemaFiles([mockRepo], []);

        expect(result.schemasProcessed).toBe(2);
        expect(result.errors).toHaveLength(0);

        // OrderCreated schema — now with enriched fields
        expect(mergeEmergentSchema).toHaveBeenCalledWith(expect.objectContaining({
            filepath: 'schemas/order-created.avsc',
            schemaName: 'OrderCreated',
            schemaType: 'message_payload',
            fields: expect.arrayContaining([
                expect.objectContaining({ name: 'orderId', type: 'string', required: true }),
                expect.objectContaining({ name: 'customerId', type: 'string', required: true }),
                expect.objectContaining({ name: 'amount', type: 'double', required: true }),
                expect.objectContaining({ name: 'currency', type: 'string', required: true }),
                expect.objectContaining({ name: 'createdAt', type: 'long', required: true }),
            ]),
            commitHash: 'SYSTEM',
            namespace: 'com.acme.events',
            schemaFormat: 'avro',
            grounding: expect.objectContaining({ source: 'ast', quality: 'exact' }),
        }));

        // UserUpdated schema
        expect(mergeEmergentSchema).toHaveBeenCalledWith(expect.objectContaining({
            filepath: 'schemas/user-updated.avsc',
            schemaName: 'UserUpdated',
            schemaType: 'message_payload',
            fields: expect.arrayContaining([
                expect.objectContaining({ name: 'userId', type: 'string', required: true }),
                expect.objectContaining({ name: 'updatedAt', type: 'long', required: true }),
            ]),
            commitHash: 'SYSTEM',
            namespace: 'com.acme.events',
            schemaFormat: 'avro',
            grounding: expect.objectContaining({ source: 'ast', quality: 'exact' }),
        }));
    });

    it('should resolve union ["null", "string"] as optional string (not JSON string)', async () => {
        vi.mocked(discoverSpecFiles).mockResolvedValue([
            path.join(FIXTURES_AVRO, 'schemas/user-updated.avsc'),
        ]);

        await ingestSchemaFiles([mockRepo], []);

        // The email field has union ["null", "string"] → should now be type "string", required false
        expect(mergeEmergentSchema).toHaveBeenCalledWith(expect.objectContaining({
            filepath: 'schemas/user-updated.avsc',
            schemaName: 'UserUpdated',
            schemaType: 'message_payload',
            fields: expect.arrayContaining([
                expect.objectContaining({ name: 'email', type: 'string', required: false }),
            ]),
            commitHash: 'SYSTEM',
            namespace: expect.any(String),
            schemaFormat: 'avro',
            grounding: expect.objectContaining({ source: 'ast', quality: 'exact' }),
        }));
    });

    it('should parse complex schema with nested records, enums, arrays, maps', async () => {
        vi.mocked(discoverSpecFiles).mockResolvedValue([
            path.join(FIXTURES_AVRO, 'schemas/order-complex.avsc'),
        ]);

        const result = await ingestSchemaFiles([mockRepo], []);

        expect(result.schemasProcessed).toBe(1);
        expect(result.errors).toHaveLength(0);

        // Verify mergeEmergentSchema was called with enriched metadata
        expect(mergeEmergentSchema).toHaveBeenCalledWith(expect.objectContaining({
            filepath: 'schemas/order-complex.avsc',
            schemaName: 'OrderCreated',
            schemaType: 'message_payload',
            fields: expect.arrayContaining([
                // Nested record → dot-notation
                expect.objectContaining({ name: 'shippingAddress.street', type: 'string', required: true }),
                expect.objectContaining({ name: 'shippingAddress.city', type: 'string', required: true }),
                expect.objectContaining({ name: 'shippingAddress.zip', type: 'string', required: false }),
                // Enum
                expect.objectContaining({ name: 'status', type: 'enum', enumSymbols: ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED'] }),
                // Array
                expect.objectContaining({ name: 'tags', type: 'string', isArray: true }),
                // Nullable map
                expect.objectContaining({ name: 'metadata', type: 'map<string>', isMap: true, required: false }),
                // Logical type
                expect.objectContaining({ name: 'amount', logicalType: 'decimal' }),
                expect.objectContaining({ name: 'createdAt', logicalType: 'timestamp-millis' }),
            ]),
            commitHash: 'SYSTEM',
            namespace: 'com.acme.events',
            doc: 'Emitted when a new order is placed',
            schemaFormat: 'avro',
            grounding: expect.objectContaining({ source: 'ast', quality: 'exact' }),
        }));
    });

    it('should skip malformed Avro files gracefully', async () => {
        vi.mocked(discoverSpecFiles).mockResolvedValue([
            path.join(FIXTURES_AVRO, 'schemas/malformed.avsc'),
        ]);

        const result = await ingestSchemaFiles([mockRepo], []);

        expect(result.schemasProcessed).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('malformed.avsc');
        expect(mergeEmergentSchema).not.toHaveBeenCalled();
    });

    it('should skip non-avsc files from discoverSpecFiles', async () => {
        vi.mocked(discoverSpecFiles).mockResolvedValue([
            path.join(FIXTURES_AVRO, 'openapi.yaml'),        // not .avsc
            path.join(FIXTURES_AVRO, 'schemas/order-created.avsc'),
        ]);

        const result = await ingestSchemaFiles([mockRepo], []);

        // Only the .avsc file should be processed
        expect(result.schemasProcessed).toBe(1);
        expect(mergeEmergentSchema).toHaveBeenCalledTimes(1);
    });

    it('should use Avro "name" field as schema name, not filename', async () => {
        vi.mocked(discoverSpecFiles).mockResolvedValue([
            path.join(FIXTURES_AVRO, 'schemas/order-created.avsc'),
        ]);

        await ingestSchemaFiles([mockRepo], []);

        // Schema name should be "OrderCreated" (from avro.name), not "order-created" (from filename)
        expect(mergeEmergentSchema).toHaveBeenCalledWith(expect.objectContaining({
            schemaName: 'OrderCreated',
            schemaType: 'message_payload',
            schemaFormat: 'avro',
            grounding: expect.objectContaining({ source: 'ast', quality: 'exact' }),
        }));
    });

    it('should handle empty discoverSpecFiles result', async () => {
        vi.mocked(discoverSpecFiles).mockResolvedValue([]);

        const result = await ingestSchemaFiles([mockRepo], []);

        expect(result.schemasProcessed).toBe(0);
        expect(result.errors).toHaveLength(0);
        expect(mergeEmergentSchema).not.toHaveBeenCalled();
    });
});
