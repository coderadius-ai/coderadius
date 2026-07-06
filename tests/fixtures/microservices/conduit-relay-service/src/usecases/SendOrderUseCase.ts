import { Injectable } from '@nestjs/common';

/**
 * UseCase that delegates to the ConduitPublisher.
 *
 * This file is an FP bait for the MessageChannel sanitizer:
 *   - The LLM may extract 'SendOrderToConduitUseCase' or 'OrderCreated'
 *     as a MessageChannel name (pure PascalCase without separators).
 *   - The sanitizer PascalCase guard (Fix 1) must drop these.
 */
@Injectable()
export class SendOrderToConduitUseCase {
    constructor(
        private readonly publisher: any,
    ) {}

    async handle(orderId: string, payload: Record<string, unknown>): Promise<void> {
        await this.publisher.publishOrderSave(orderId, payload);
    }
}
