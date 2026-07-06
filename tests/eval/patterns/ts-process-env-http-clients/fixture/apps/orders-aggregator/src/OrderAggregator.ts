export class OrderAggregator {
    async quote(sku: string, quantity: number): Promise<void> {
        const ordersUrl = process.env.ORDERS_URL!;
        const paymentBaseUrl = process.env.PAYMENT_BASE_URL!;
        const inventoryHost = process.env.INVENTORY_HOST!;
        const notificationsEndpoint = process.env.NOTIFICATIONS_ENDPOINT!;

        await fetch(`${ordersUrl}/quote`, {
            method: 'POST',
            body: JSON.stringify({ sku, quantity }),
        });
        await fetch(`${paymentBaseUrl}/authorize`, { method: 'POST' });
        await fetch(`https://${inventoryHost}/level/${sku}`);
        await fetch(`${notificationsEndpoint}/notify`, { method: 'POST' });
    }
}
