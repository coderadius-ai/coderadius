import { Injectable } from '@nestjs/common';
import { ConduitHandler } from '@acme-corp/conduit-consumer';
import { Connection } from 'mongoose';
import { InjectConnection } from '@nestjs/mongoose';

/**
 * Fat consumer: has enough logic that tree-sitter produces method chunks.
 * This consumer should work without the rescue mechanism.
 *
 * The routing key 'platform.order.result.preferred' should be extracted
 * from the @ConduitHandler decorator.
 */
@ConduitHandler({
    routingKey: 'platform.order.result.preferred',
    queue: 'preferred-result-queue',
})
@Injectable()
export class PreferredResultConsumer {
    constructor(
        @InjectConnection()
        private readonly connection: Connection,
        private readonly resultRepository: any,
    ) {}

    async handleEvent(data: { orderId: string; resultId: string; preferred: boolean }): Promise<void> {
        await this.connection.transaction(async (session) => {
            const existing = await this.resultRepository.findOne(
                { orderId: data.orderId },
                { session },
            );

            if (!existing) {
                throw new Error(`Result not found for order ${data.orderId}`);
            }

            await this.resultRepository.updateOne(
                { orderId: data.orderId },
                { $set: { preferred: data.preferred, resultId: data.resultId } },
                { session },
            );
        });
    }
}
