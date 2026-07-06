import { Injectable, Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import ConduitConfig from '../config/Conduit.config';

/**
 * Dispatches domain events to the Conduit relay via the outbox pattern.
 *
 * This file exercises three regression scenarios:
 *   1. Default import: `import Config from '../config/...'` (kind=default)
 *   2. Cross-file constant resolution: `this.relayConfig.cdtChannelSave`
 *      must resolve to 'Platform-OrderSave' from the registerAs factory
 *   3. SDK wrapper pattern: `this.outboxService.publish(...)` hides the
 *      physical channel name behind a service method call
 */
@Injectable()
export class ConduitPublisher {
    constructor(
        @Inject(ConduitConfig.KEY)
        private readonly relayConfig: ConfigType<typeof ConduitConfig>,
        @InjectConnection()
        private readonly connection: Connection,
        private readonly outboxService: any,
    ) {}

    /**
     * Dispatches an order-save event through the outbox collection.
     * The channel name comes from this.relayConfig.cdtChannelSave → 'Platform-OrderSave'.
     */
    async publishOrderSave(orderId: string, payload: Record<string, unknown>): Promise<void> {
        await this.connection.transaction(async (session) => {
            await this.outboxService.publish({
                topic: this.relayConfig.cdtChannelSave,
                data: { orderId, ...payload },
                timestamp: new Date().toISOString(),
            }, session);
        });
    }

    /**
     * Dispatches an order-bundle event through the outbox collection.
     * The channel name comes from this.relayConfig.cdtChannelBundle → 'Platform-OrderBundle'.
     */
    async publishOrderBundle(orderId: string, bundleData: unknown): Promise<void> {
        await this.connection.transaction(async (session) => {
            await this.outboxService.publish({
                topic: this.relayConfig.cdtChannelBundle,
                data: bundleData,
            }, session);
        });
    }
}
