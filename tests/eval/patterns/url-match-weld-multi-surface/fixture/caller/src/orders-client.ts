/**
 * Acme orders consumer service.
 *
 * Reads `ORDERS_API_URL` from environment and POSTs to /orders on the
 * provider's public API surface.
 */
export class OrdersClient {
    private readonly baseUrl = process.env.ORDERS_API_URL!;

    async createOrder(payload: { sku: string; qty: number }): Promise<{ id: string }> {
        const res = await fetch(`${this.baseUrl}/orders`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        return res.json();
    }
}
