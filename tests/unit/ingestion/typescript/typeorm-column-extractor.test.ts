import { describe, it, expect } from 'vitest';
import { extractTypeScriptStaticInfra } from '../../../../src/ingestion/core/languages/typescript/static-infra.ts';
import type { CodeChunk } from '../../../../src/graph/types.js';

// ─── TS TypeORM column extractor (@Column decorator) ─────────────────────────
//
// Mirrors the PHP @ORM\Column behaviour so the differ can detect column
// renames symmetrically across both languages on a shared physical table.

function makeMetadataChunk(source: string, className = 'OrderEntity'): CodeChunk {
    return {
        name: `${className}::__class_metadata`,
        filepath: 'src/orders.entity.ts',
        sourceCode: source,
        startLine: 1,
        startColumn: 1,
        endLine: source.split('\n').length,
        endColumn: 1,
        envVars: [],
    } as CodeChunk;
}

describe('extractTypeScriptStaticInfra — TypeORM column schemas', () => {
    it('extracts columns from @Column({ name, type, nullable }) decorators', () => {
        const src = `
            @Entity({ name: 'orders' })
            export class OrderEntity {
                @Column({ name: 'id', type: 'bigint', nullable: false })
                id: string;

                @Column({ name: 'customer_id', type: 'integer', nullable: false })
                customerId: number;

                @Column({ name: 'total', type: 'decimal', nullable: true })
                total: number;
            }
        `;
        const result = extractTypeScriptStaticInfra(makeMetadataChunk(src));
        expect(result).not.toBeNull();
        expect(result!.entity_schemas).toEqual([{
            name: 'orders',
            fields: [
                { name: 'id', type: 'bigint', required: true },
                { name: 'customer_id', type: 'integer', required: true },
                { name: 'total', type: 'decimal', required: false },
            ],
        }]);
    });

    it('falls back to property name when @Column lacks explicit name', () => {
        const src = `
            @Entity('orders')
            export class OrderEntity {
                @Column({ type: 'bigint' })
                createdAt: number;

                @Column()
                description!: string;
            }
        `;
        const result = extractTypeScriptStaticInfra(makeMetadataChunk(src));
        expect(result!.entity_schemas![0].fields).toEqual([
            { name: 'createdAt', type: 'bigint', required: true },
            { name: 'description', type: 'string', required: true },
        ]);
    });

    it('supports the positional @Column("name", { ... }) signature', () => {
        const src = `
            @Entity({ name: 'orders' })
            export class OrderEntity {
                @Column('legacy_id', { type: 'integer' })
                id: number;
            }
        `;
        const result = extractTypeScriptStaticInfra(makeMetadataChunk(src));
        expect(result!.entity_schemas![0].fields[0]).toEqual({
            name: 'legacy_id', type: 'integer', required: true,
        });
    });

    it('emits an entity_schemas entry even when no columns are detected', () => {
        const src = `
            @Entity({ name: 'orders' })
            export class OrderEntity {}
        `;
        const result = extractTypeScriptStaticInfra(makeMetadataChunk(src));
        expect(result!.entity_schemas).toEqual([{ name: 'orders', fields: [] }]);
    });

    it('falls back to no kindFamily when the entity decorator is ambiguous (no columns emitted)', () => {
        // When the TS heuristic infers a table name from the class symbol
        // alone (no @Entity / @Schema decorator matched), `kindFamily` is
        // undefined. We refuse to emit columns in that case: ambiguous ORM
        // detection should not pollute the schema layer with guessed fields.
        // (The framework-signal gate upstream prevents non-entity chunks
        // from reaching this extractor in production, so this guard is
        // defensive only.)
        const src = `
            export class UserModel {
                @Column({ name: 'whatever' })
                whatever!: string;
            }
        `;
        const result = extractTypeScriptStaticInfra(makeMetadataChunk(src, 'UserModel'));
        expect(result).not.toBeNull();
        expect(result!.entity_schemas).toEqual([{ name: 'user', fields: [] }]);
    });
});
