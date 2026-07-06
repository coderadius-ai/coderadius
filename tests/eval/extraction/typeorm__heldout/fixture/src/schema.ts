import { pgTable, serial, varchar, integer } from 'drizzle-orm/pg-core';

// Drizzle ORM: pgTable('name', {...}) maps a table. Different ORM, different
// syntax (builder, not decorators) — proves the static entity path is not
// overfit to TypeORM's @Entity decorator.
export const shipments = pgTable('shipments', {
    id: serial('id').primaryKey(),
    carrier: varchar('carrier', { length: 64 }),
    weight: integer('weight'),
});

export const carriers = pgTable('carriers', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 128 }),
});
