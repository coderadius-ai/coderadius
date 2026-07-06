import { Injectable } from '@nestjs/common';

/**
 * Emits domain events onto the message broker via a thin wrapper.
 *
 * This file exercises the 'emitEvent wrapper' regression:
 *   The routing key string literal ('order.save.created') is in the function body
 *   as an argument to this.messageEmitterService.emitEvent(), but the LLM
 *   treats it as a parameter to another service rather than extractable infrastructure.
 *
 * Expected result: the MessageChannel 'order.save.created' should be extracted
 * as PUBLISHES_TO from emitOrderCreatedEvent.
 */
@Injectable()
export class OrderEventEmitter {
    constructor(
        private readonly messageEmitterService: any,
    ) {}

    async emitOrderCreatedEvent(orderId: string): Promise<void> {
        await this.messageEmitterService.emitEvent({
            eventName: 'order.save.created',
            routingKey: ['order.save.created'],
            data: { orderId },
        });
    }

    async emitOrderUpdatedEvent(orderId: string, changes: Record<string, unknown>): Promise<void> {
        await this.messageEmitterService.emitEvent({
            eventName: 'order.save.updated',
            routingKey: ['order.save.updated'],
            data: { orderId, changes },
        });
    }

    async emitOrderRequestedEvent(orderId: string): Promise<void> {
        await this.messageEmitterService.emitEvent({
            eventName: 'order.save.requested',
            routingKey: ['order.save.requested'],
            data: { orderId },
        });
    }
}
