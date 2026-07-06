import { ApiGateway } from './CustomHttpWrapper.js';

/**
 * Manages fulfillment operations by delegating to external services
 * via the internal ApiGateway abstraction.
 *
 * IMPORTANT: This file has ZERO direct I/O imports (no axios, no fetch, no pg).
 * The heuristic regex filter will NOT detect I/O in any of these functions.
 * Only the Taint Analysis + DI Alias Mapping can detect that `this.api`
 * is an alias for ApiGateway, which is tainted because it imports axios.
 */
export class FulfillmentController {
    private api: ApiGateway;

    constructor(api: ApiGateway) {
        this.api = api;
    }

    /**
     * Dispatches a fulfillment request to the warehouse service.
     * Uses the injected ApiGateway — no direct HTTP library reference.
     */
    async dispatchToWarehouse(orderId: string, items: Array<{ sku: string; quantity: number }>) {
        const payload = {
            orderId,
            items,
            priority: items.length > 10 ? 'high-priority-test' : 'normal',
            requestedAt: new Date().toISOString(),
        };

        const result = await this.api.post('/api/warehouse/dispatch', payload);
        console.log(`[FulfillmentController] Dispatched order ${orderId} to warehouse`);
        return result;
    }

    /**
     * Queries the shipping provider for tracking information.
     * Again, uses `this.api` which the regex filter cannot detect as I/O.
     */
    async getShipmentTracking(trackingId: string) {
        const tracking = await this.api.get(`/api/shipping/track/${trackingId}`);
        return tracking;
    }

    /**
     * Pure business logic — should still be filtered OUT by the heuristic filter
     * even with taint analysis enabled, because it doesn't reference this.api.
     */
    calculateShippingCost(weight: number, distance: number): number {
        const baseCost = 5.99;
        const weightFactor = weight * 0.15;
        const distanceFactor = distance * 0.02;
        return Math.round((baseCost + weightFactor + distanceFactor) * 100) / 100;
    }

    /**
     * Another pure function — validates address format.
     * Must NOT pass through to LLM even though the class is tainted.
     */
    isValidAddress(address: { street: string; city: string; zip: string }): boolean {
        return address.street.length > 0 && address.city.length > 0 && address.zip.length >= 5;
    }
}
// dummy comment to bust cache
