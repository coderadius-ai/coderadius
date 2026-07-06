import { Injectable } from '@nestjs/common';
import { ConduitHandler } from '@acme-corp/conduit-consumer';

/**
 * Another thin consumer — only a handleEvent that delegates.
 * Same consumer rescue pattern as OrderUpdatedConsumer.
 */
@ConduitHandler({
    routingKey: 'platform.order.save.ready',
    queue: 'order-save-ready-queue',
})
@Injectable()
export class OrderSaveReadyConsumer {
    constructor(
        private readonly useCase: any,
    ) {}

    async handleEvent(data: unknown): Promise<void> {
        await this.useCase.handle(data);
    }
}
