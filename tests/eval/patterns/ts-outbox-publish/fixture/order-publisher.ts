import { Injectable, Inject } from '@nestjs/common';

/**
 * Transactional Outbox Service — generic outbox pattern abstraction.
 * Writes to a MongoDB outbox collection, then a relay daemon publishes
 * to the configured message broker topic.
 */
@Injectable()
export class OrderPublisher {
    constructor(
        @Inject('OUTBOX_SERVICE') private readonly outboxService: any,
        @Inject('TOPIC_CONFIG') private readonly topicConfig: {
            orderCreatedTopic: string;
        },
    ) {}

    /**
     * Publish an order-created event via the transactional outbox.
     * The outboxService.publish() writes to the outbox collection,
     * and a relay daemon publishes to the configured PubSub topic.
     */
    async publishOrderCreated(order: { orderId: string; customerId: string; amount: number }) {
        await this.outboxService.publish(
            this.topicConfig.orderCreatedTopic,
            {
                orderId: order.orderId,
                customerId: order.customerId,
                amount: order.amount,
                publishedAt: new Date().toISOString(),
            },
        );
    }
}
