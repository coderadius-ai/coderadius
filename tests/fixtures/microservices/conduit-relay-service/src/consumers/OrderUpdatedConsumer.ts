import { Injectable } from '@nestjs/common';
import { ConduitHandler } from '@acme-corp/conduit-consumer';

/**
 * Thin consumer: has a class-level @ConduitHandler decorator but the handler
 * method is so small that tree-sitter chunking produces 0 function chunks.
 *
 * This exercises the 'consumer rescue' regression (Fix 4 / Gate 6):
 *   - chunk-extraction.ts must inject a __consumer_entrypoint synthetic chunk
 *   - heuristic-filter.ts Gate 6 must auto-pass the synthetic chunk
 *   - The routing key 'platform.order.updated' must be extracted
 */
@ConduitHandler({
    routingKey: 'platform.order.updated',
    queue: 'order-updated-queue',
})
@Injectable()
export class OrderUpdatedConsumer {
    async handleEvent(data: unknown): Promise<void> {
        console.log('Order updated event received', data);
    }
}
