<?php
/**
 * Symfony-style DI Container Configuration.
 *
 * This file defines service bindings for the payment service's
 * message broker publishers and consumers. Each service key maps
 * to a physical RabbitMQ routing key / exchange.
 *
 * This is the canonical source of truth for DI → physical name resolution.
 */

use Symfony\Component\DependencyInjection\ContainerBuilder;
use PhpAmqpLib\Connection\AMQPStreamConnection;

return function (ContainerBuilder $container) {
    // ── RabbitMQ Connection ─────────────────────────────────────────────
    $container->register('amqp.connection', AMQPStreamConnection::class)
        ->addArgument(getenv('RABBITMQ_HOST') ?: 'localhost')
        ->addArgument(getenv('RABBITMQ_PORT') ?: 5672)
        ->addArgument(getenv('RABBITMQ_USER') ?: 'guest')
        ->addArgument(getenv('RABBITMQ_PASS') ?: 'guest');

    // ── Publishers ──────────────────────────────────────────────────────
    $container->register('payment.completed.publisher', PaymentEventPublisher::class)
        ->addArgument('%amqp.connection%')
        ->addTag('messenger.publisher', [
            'exchange' => 'payments_exchange',
            'routing_key' => 'payment.completed.v2',
        ]);

    $container->register('refund.initiated.publisher', RefundEventPublisher::class)
        ->addArgument('%amqp.connection%')
        ->addTag('messenger.publisher', [
            'exchange' => 'payments_exchange',
            'routing_key' => 'refund.initiated',
        ]);

    $container->register('notredeemable.publisher', NotRedeemablePublisher::class)
        ->addArgument('%amqp.connection%')
        ->addTag('messenger.publisher', [
            'exchange' => 'loyalty_exchange',
            'routing_key' => 'loyalty.not_redeemable',
        ]);

    // ── Consumers ───────────────────────────────────────────────────────
    $container->register('order.events.consumer', OrderEventsConsumer::class)
        ->addArgument('%amqp.connection%')
        ->addTag('messenger.consumer', [
            'queue' => 'payment_order_queue',
            'routing_key' => 'order.confirmed',
        ]);
};
// cache buster
