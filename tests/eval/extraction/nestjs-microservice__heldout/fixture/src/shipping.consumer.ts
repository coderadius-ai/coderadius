import { Controller } from '@nestjs/common';
import { MessagePattern, EventPattern, Payload } from '@nestjs/microservices';
import { Processor, Process } from '@nestjs/bull';

// Method-scope consumers: string-literal channels.
@Controller()
export class ShippingEventsConsumer {
    @EventPattern('shipping.dispatched')
    onDispatched(@Payload() data: unknown): void {
        void data;
    }

    @MessagePattern('inventory.restocked')
    onRestocked(@Payload() data: unknown): void {
        void data;
    }
}

// Class-scope consumer: @Processor binds the whole class to a queue; @Process
// marks the handler method.
@Processor('notification-dispatch')
export class NotificationProcessor {
    @Process()
    handle(@Payload() data: unknown): void {
        void data;
    }
}
