import { describe, it, expect } from 'vitest';
import { extractOrmMetadataStaticInfra } from '../../../../src/ingestion/core/languages/php/orm-static.ts';
import type { CodeChunk } from '../../../../src/graph/types.js';

// ─── PHP ORM column extractor (Doctrine annotation + PHP-8 attribute) ────────
//
// Pins column-level extraction so the blast tool can surface
// `Column renamed: order_ref -> order_ref2`-style findings instead of phantom
// table-mapping changes.

function makeMetadataChunk(source: string, className = 'Order'): CodeChunk {
    return {
        name: `Acme\\Entity\\${className}::__class_metadata`,
        filepath: 'src/Entity/Order.php',
        sourceCode: source,
        startLine: 1,
        startColumn: 1,
        endLine: source.split('\n').length,
        endColumn: 1,
        envVars: [],
    } as CodeChunk;
}

describe('extractOrmMetadataStaticInfra — column schemas', () => {
    it('extracts columns from Doctrine docblock annotations with explicit name=', () => {
        const src = `
            /**
             * @ORM\\Table(name="orders")
             * @ORM\\Entity()
             */
            class Order {
                /**
                 * @ORM\\Column(name="id", type="bigint", nullable=false)
                 */
                protected $id;

                /**
                 * @ORM\\Column(name="customer_id", type="integer", nullable=false)
                 */
                protected $customerId;

                /**
                 * @ORM\\Column(name="total", type="decimal", nullable=true)
                 */
                protected $total;
            }
        `;
        const result = extractOrmMetadataStaticInfra(makeMetadataChunk(src));
        expect(result).not.toBeNull();
        const schemas = result!.entity_schemas;
        expect(schemas).toHaveLength(1);
        expect(schemas![0].name).toBe('orders');
        expect(schemas![0].fields).toEqual([
            { name: 'id', type: 'bigint', required: true },
            { name: 'customer_id', type: 'integer', required: true },
            { name: 'total', type: 'decimal', required: false },
        ]);
    });

    it('extracts columns from PHP-8 attribute syntax', () => {
        const src = `
            #[ORM\\Table(name: "orders")]
            #[ORM\\Entity]
            class Order {
                #[ORM\\Column(name: "id", type: "bigint", nullable: false)]
                protected $id;

                #[ORM\\Column(name: "customer_id", type: "integer")]
                protected $customerId;
            }
        `;
        const result = extractOrmMetadataStaticInfra(makeMetadataChunk(src));
        expect(result).not.toBeNull();
        expect(result!.entity_schemas).toEqual([{
            name: 'orders',
            fields: [
                { name: 'id', type: 'bigint', required: true },
                { name: 'customer_id', type: 'integer', required: true },
            ],
        }]);
    });

    it('falls back to property name when @ORM\\Column lacks name=', () => {
        const src = `
            /**
             * @ORM\\Table(name="orders")
             * @ORM\\Entity()
             */
            class Order {
                /**
                 * @ORM\\Column(type="bigint")
                 */
                protected $createdAt;
            }
        `;
        const result = extractOrmMetadataStaticInfra(makeMetadataChunk(src));
        expect(result!.entity_schemas![0].fields).toEqual([
            { name: 'createdAt', type: 'bigint', required: true },
        ]);
    });

    it('infers required=true when nullable attribute is missing', () => {
        const src = `
            /**
             * @ORM\\Table(name="orders")
             * @ORM\\Entity()
             */
            class Order {
                /**
                 * @ORM\\Column(name="id", type="bigint")
                 */
                protected $id;
            }
        `;
        const result = extractOrmMetadataStaticInfra(makeMetadataChunk(src));
        expect(result!.entity_schemas![0].fields[0].required).toBe(true);
    });

    it('emits an entity_schemas entry even when no columns are detected (table-only entity)', () => {
        // Entity declares the table but has no extractable columns. Producing
        // an empty schemas array (rather than undefined) keeps the diff
        // contract uniform: HAS_SCHEMA edge always exists for ORM entities.
        const src = `
            /**
             * @ORM\\Table(name="orders")
             * @ORM\\Entity()
             */
            class Order {}
        `;
        const result = extractOrmMetadataStaticInfra(makeMetadataChunk(src));
        expect(result).not.toBeNull();
        expect(result!.entity_schemas).toEqual([{ name: 'orders', fields: [] }]);
    });

    it('omits entity_schemas when chunk is not an ORM entity', () => {
        const src = `
            class PlainController {
                public function index() {}
            }
        `;
        const result = extractOrmMetadataStaticInfra(makeMetadataChunk(src, 'PlainController'));
        // Not an ORM entity → existing behaviour: return null entirely.
        expect(result).toBeNull();
    });
});
