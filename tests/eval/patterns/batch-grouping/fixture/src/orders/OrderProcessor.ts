import axios from 'axios';
import { Pool } from 'pg';
import { Channel } from 'amqplib';

/**
 * Processes storefront orders. Mirrors the PHP fixture shape: one class,
 * shared constructor DI, three I/O methods and two pure helpers.
 */
export class OrderProcessor {
    constructor(
        private readonly pool: Pool,
        private readonly channel: Channel,
    ) {}

    async persistOrder(orderId: string, total: number): Promise<void> {
        await this.pool.query(
            'INSERT INTO order_ledger (order_id, total, created_at) VALUES ($1, $2, NOW())',
            [orderId, total],
        );
    }

    async announceShipment(orderId: string): Promise<void> {
        const payload = Buffer.from(JSON.stringify({ orderId }));
        this.channel.publish('orders', 'orders.shipment.created', payload);
    }

    async fetchCarrierQuote(weightKg: number): Promise<number> {
        const response = await axios.get(`https://api.acme-carriers.com/v2/quotes/${weightKg}`);
        return response.data.price;
    }

    normalizeOrderId(orderId: string): string {
        return orderId.trim().toUpperCase();
    }

    computeVolume(widthCm: number, heightCm: number, depthCm: number): number {
        return widthCm * heightCm * depthCm;
    }
}
