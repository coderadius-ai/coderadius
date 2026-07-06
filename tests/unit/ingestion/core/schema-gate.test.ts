import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mayContainSchemas } from '../../../../src/ingestion/core/schema-gate.js';
import fs from 'node:fs';

vi.mock('node:fs');

describe('Schema Gate — mayContainSchemas()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── Declarative Extensions (Fast Pass) ───────────────────────────────

    it('should pass .prisma files via declarative extension', () => {
        expect(mayContainSchemas(null, 'schema.prisma', 'unknown')).toBe(true);
    });

    it('should pass .sql files via declarative extension', () => {
        expect(mayContainSchemas(null, 'migrations/001.sql', 'unknown')).toBe(true);
    });

    // .graphql files are intentionally EXCLUDED from the declarative extension fast-pass.
    // They are processed by graphql-schema-extractor.ts (graphql-js based SDL parser),
    // not by the generic LLM schema extractor. This prevents SDL type definitions from being
    // sent to the wrong pipeline expecting class/interface structures.
    it('should NOT pass .graphql files via declarative extension (handled by graphql-schema-extractor)', () => {
        expect(mayContainSchemas(null, 'schema.graphql', 'unknown')).toBe(false);
    });

    it('should NOT pass .gql files via declarative extension (handled by graphql-schema-extractor)', () => {
        expect(mayContainSchemas(null, 'schema.gql', 'unknown')).toBe(false);
    });

    // ── Content Fast Pass (Drizzle/Zod/ORM patterns) ─────────────────────

    it('should pass files containing pgTable() — Drizzle ORM', () => {
        vi.mocked(fs.readFileSync).mockReturnValue(`
            export const orders = pgTable('orders', {
                id: uuid('id').primaryKey(),
                customerId: text('customer_id').notNull(),
            });
        `);
        expect(mayContainSchemas(null, 'OrderSchema.ts', 'typescript')).toBe(true);
    });

    it('should pass files containing z.object() — Zod schema', () => {
        vi.mocked(fs.readFileSync).mockReturnValue(`
            export const OrderEventSchema = z.object({
                orderId: z.string().uuid(),
                customerId: z.string(),
            });
        `);
        expect(mayContainSchemas(null, 'OrderSchema.ts', 'typescript')).toBe(true);
    });

    it('should pass files containing z.array() — Zod array schema', () => {
        vi.mocked(fs.readFileSync).mockReturnValue(`
            export const ItemsSchema = z.array(z.object({ id: z.string() }));
        `);
        expect(mayContainSchemas(null, 'items.ts', 'typescript')).toBe(true);
    });

    it('should pass files containing z.enum() — Zod enum schema', () => {
        vi.mocked(fs.readFileSync).mockReturnValue(`
            export const StatusEnum = z.enum(['active', 'inactive', 'pending']);
        `);
        expect(mayContainSchemas(null, 'status.ts', 'typescript')).toBe(true);
    });

    it('should pass files containing rabbitChannel.publish — message payload', () => {
        vi.mocked(fs.readFileSync).mockReturnValue(`
            await rabbitChannel.publish('exchange', 'key', Buffer.from(JSON.stringify(payload)));
        `);
        expect(mayContainSchemas(null, 'publisher.ts', 'typescript')).toBe(true);
    });

    // ── AST Structural Check ─────────────────────────────────────────────

    it('should pass when AST contains interface_declaration (TypeScript)', () => {
        const mockRoot = {
            type: 'program',
            children: [{ type: 'interface_declaration', children: [] }],
        } as any;
        // No content patterns to match
        vi.mocked(fs.readFileSync).mockReturnValue('const x = 1;');
        expect(mayContainSchemas(mockRoot, 'types.ts', 'typescript')).toBe(true);
    });

    it('should pass when AST contains class_declaration (PHP)', () => {
        const mockRoot = {
            type: 'program',
            children: [{ type: 'class_declaration', children: [] }],
        } as any;
        vi.mocked(fs.readFileSync).mockReturnValue('$x = 1;');
        expect(mayContainSchemas(mockRoot, 'Entity.php', 'php')).toBe(true);
    });

    // ── Negative Cases ───────────────────────────────────────────────────

    it('should NOT pass files with only pure functions and no schema patterns', () => {
        const mockRoot = {
            type: 'program',
            children: [
                { type: 'function_declaration', children: [] },
                { type: 'lexical_declaration', children: [] },
            ],
        } as any;
        vi.mocked(fs.readFileSync).mockReturnValue(`
            function add(a, b) { return a + b; }
            const greeting = "hello";
        `);
        expect(mayContainSchemas(mockRoot, 'utils.ts', 'typescript')).toBe(false);
    });
});
