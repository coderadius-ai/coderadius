import { z } from 'zod';

// Mock Drizzle-style functions mapping to SQL concepts
const pgTable = (name: string, schema: Record<string, any>) => ({ name, schema });
const text = (name: string) => ({ notNull: () => ({ default: (v: any) => ({}) }) });
const integer = (name: string) => ({ notNull: () => ({}) });
const uuid = (name: string) => ({ primaryKey: () => ({ defaultRandom: () => ({}) }) });
const timestamp = (name: string) => ({ notNull: () => ({ defaultNow: () => ({}) }) });
const jsonb = (name: string) => ({ notNull: () => ({}) });

/**
 * Case 5: Drizzle-style Database Table Definition
 * Tests the LLM's ability to abstract `.notNull()` into required=true, and absent .notNull() into required=false.
 */
export const orders = pgTable('orders', {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: text('customer_id').notNull(),
    status: text('status').notNull().default('PENDING'),
    items: jsonb('items').notNull(),
    shippingAddress: text('shipping_address'),    // nullable -> required: false
    notes: text('notes'),                         // nullable -> required: false
    totalAmount: integer('total_amount').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at'),           // nullable -> required: false
});

/**
 * Case 6: Zod Message Payload Definition
 * Tests the LLM's ability to abstract `.optional()` into required=false.
 */
export const OrderEventSchema = z.object({
    orderId: z.string().uuid(),                                // required
    customerId: z.string(),                                    // required
    items: z.array(z.object({
        productId: z.string(),
        quantity: z.number(),
    })),                                                       // required
    couponCode: z.string().optional(),                         // required: false
    giftMessage: z.string().optional(),                        // required: false
    priority: z.enum(['standard', 'express']).default('standard'), // required
    timestamp: z.string().datetime(),                          // required
});

export type OrderEvent = z.infer<typeof OrderEventSchema>;
