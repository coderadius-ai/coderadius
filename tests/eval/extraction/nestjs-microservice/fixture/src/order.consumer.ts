import { Controller } from '@nestjs/common';
import { MessagePattern, EventPattern, Payload } from '@nestjs/microservices';

// NestJS microservice consumer: message-handler decorators bind a method to a
// named channel (command pattern or event topic). The channel name is the
// string argument — order.created / payment.processed / order.cancelled.
@Controller()
export class OrderConsumer {
    @MessagePattern('order.created')
    handleOrderCreated(@Payload() data: unknown): void {
        void data;
    }

    @EventPattern('payment.processed')
    handlePaymentProcessed(@Payload() data: unknown): void {
        void data;
    }

    @MessagePattern('order.cancelled')
    handleOrderCancelled(@Payload() data: unknown): void {
        void data;
    }
}
