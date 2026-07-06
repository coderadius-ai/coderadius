import { ConduitClient } from './ConduitClient';

export class OrderService {
    constructor(private relay: ConduitClient) {}

    public async finalizeOrder(orderId: string, payload: any) {
        // Tainted by relay.dispatch - should extract Platform-OrderCreated
        await this.relay.dispatch('Platform-OrderCreated', { orderId, ...payload }, 'com.acme.events');
    }

    public calculateDiscount(amount: number) {
        return amount * 0.1;
    }
}
