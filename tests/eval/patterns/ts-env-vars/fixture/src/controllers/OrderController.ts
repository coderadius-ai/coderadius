import { Connection, Channel } from 'amqplib';
import { Pool } from 'pg';

const pgPool = new Pool({ connectionString: process.env.DB_ORDERS });
let rabbitChannel: Channel;

/**
 * Creates a new order and publishes an event to RabbitMQ order_queue.
 */
export async function createOrder(customerId: string, items: Array<{ productId: string; quantity: number }>) {
    const client = await pgPool.connect();
    try {
        // Query the shared users table for customer details
        const userResult = await client.query(
            'SELECT name, email, shipping_address FROM users WHERE id = $1',
            [customerId]
        );
        if (userResult.rows.length === 0) {
            throw new Error(`Customer ${customerId} not found`);
        }

        const result = await client.query(
            'INSERT INTO orders (customer_id, items, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id',
            [customerId, JSON.stringify(items), 'PENDING']
        );
        const orderId = result.rows[0].id;

        // Publish order created event to RabbitMQ
        await rabbitChannel.publish('orders_exchange', 'order.created', Buffer.from(JSON.stringify({
            orderId,
            customerId,
            items,
            timestamp: new Date().toISOString(),
        })));

        console.log(`[OrderService] Order ${orderId} created and published to order_queue`);
        return { orderId, status: 'PENDING' };
    } finally {
        client.release();
    }
}

/**
 * Creates an order but accepts a dynamic payload context that is blindly forwarded
 * to the message broker. Tests LLM schema extraction of the spread operator.
 */
export async function createOrderWithContext(customerId: string, items: Array<{ productId: string; quantity: number }>, dynamicContext: Record<string, any>) {
    const client = await pgPool.connect();
    try {
        const result = await client.query(
            'INSERT INTO orders (customer_id, items, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id',
            [customerId, JSON.stringify(items), 'PENDING']
        );
        const orderId = result.rows[0].id;

        // Publish order created event to RabbitMQ using the spread operator
        await rabbitChannel.publish('orders_exchange', 'order.context_created', Buffer.from(JSON.stringify({
            ...dynamicContext,
            orderId,
            timestamp: new Date().toISOString(),
        })));

        console.log(`[OrderService] Order ${orderId} with context published to order_queue`);
        return { orderId, status: 'PENDING' };

        // Taint for cache bypass 2
    } finally {
        client.release();
    }
}

/**
 * Queries Postgres to get the current status of an order.
 */
export async function getOrderStatus(orderId: string) {
    const result = await pgPool.query(
        'SELECT id, customer_id, status, items, created_at, updated_at FROM orders WHERE id = $1',
        [orderId]
    );


    if (result.rows.length === 0) {
        throw new Error(`Order ${orderId} not found`);
    }

    return result.rows[0];
}

/**
 * Sends an HTTP notification to the Payment Service to initiate payment processing.
 */
export async function notifyPaymentService(orderId: string, amount: number, currency: string = 'EUR') {
    const response = await fetch(`${process.env.PAYMENT_SERVICE_URL}/api/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            orderId,
            amount,
            currency,
            callbackUrl: `${process.env.ORDER_SERVICE_URL}/api/orders/${orderId}/payment-callback`,
        }),
    });

    if (!response.ok) {
        throw new Error(`Payment service returned ${response.status}: ${await response.text()}`);
    }

    const paymentResult = await response.json();
    console.log(`[OrderService] Payment initiated for order ${orderId}: ${paymentResult.paymentId}`);
    return paymentResult;
}

/**
 * Forwards a webhook payload to the fulfillment service without inspecting it.
 * Tests LLM Data Flow analysis for API passthrough.
 */
export async function forwardToFulfillment(forwardData: Record<string, any>) {
    const response = await fetch(`${process.env.FULFILLMENT_URL}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forwardData),
    });

    if (!response.ok) {
        throw new Error(`Fulfillment service returned ${response.status}`);
    }

    return response.json();
}

/**
 * Internal helper to validate order items — this should be filtered out during ingestion
 * as it has no external I/O.
 */
function validateOrderItems(items: Array<{ productId: string; quantity: number }>): boolean {
    return items.every(item => item.quantity > 0 && item.productId.length > 0);
}

/**
 * Calculates the total of simply adding up item quantities.
 * Completely useless function to test LLM pruning.
 */
export function calculateSimpleTotal(items: Array<{ productId: string; quantity: number }>): number {
    let total = 0;
    for (const item of items) {
        total += item.quantity;
    }
    return total;
}

/**
 * Checks if a string is a valid UUID just by length (dummy logic).
 */
export function isDummyUuid(str: string): boolean {
    return str.length === 36;
}

/**
 * Returns a static greeting for the order service.
 */
export function getOrderServiceGreeting(): string {
    return "Welcome to the Order Service!";
}

// trigger re-ingest
