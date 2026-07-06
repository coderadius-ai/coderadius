import { describe, it, expect } from 'vitest';
import { extractSymfonyMessengerSymbols } from '../../../../../../src/ingestion/core/languages/php/symfony-messenger-symbols.js';

// Anonymised Symfony ContainerBuilder DI config (acme/inventory vocabulary):
// the canonical "DI key -> physical RabbitMQ routing key / queue" source of
// truth that the deterministic extractor must parse without the LLM.
const SERVICES = `<?php
use Symfony\\Component\\DependencyInjection\\ContainerBuilder;
use PhpAmqpLib\\Connection\\AMQPStreamConnection;

return function (ContainerBuilder $container) {
    $container->register('amqp.connection', AMQPStreamConnection::class)
        ->addArgument(getenv('RABBITMQ_HOST') ?: 'localhost');

    $container->register('order.created.publisher', OrderEventPublisher::class)
        ->addArgument('%amqp.connection%')
        ->addTag('messenger.publisher', [
            'exchange' => 'orders_exchange',
            'routing_key' => 'order.created.v2',
        ]);

    $container->register('inventory.events.consumer', InventoryConsumer::class)
        ->addArgument('%amqp.connection%')
        ->addTag('messenger.consumer', [
            'queue' => 'inventory_order_queue',
            'routing_key' => 'order.confirmed',
        ]);
};`;

describe('extractSymfonyMessengerSymbols', () => {
    it('maps a publisher DI key to its routing_key (no queue present)', () => {
        const out = extractSymfonyMessengerSymbols(SERVICES);
        const pub = out.find(b => b.diKey === 'order.created.publisher');
        expect(pub, 'publisher binding must be extracted').toBeDefined();
        expect(pub!.physicalName).toBe('order.created.v2');
        expect(pub!.category).toBe('di_service');
        expect(pub!.technology).toBe('rabbitmq');
        expect(pub!.boundComponent).toBe('OrderEventPublisher');
    });

    it('maps a consumer DI key to its queue (queue preferred over routing_key)', () => {
        const out = extractSymfonyMessengerSymbols(SERVICES);
        const con = out.find(b => b.diKey === 'inventory.events.consumer');
        expect(con, 'consumer binding must be extracted').toBeDefined();
        // Schema rule: when both queue and routing_key are present, prefer queue.
        expect(con!.physicalName).toBe('inventory_order_queue');
        expect(con!.category).toBe('di_service');
    });

    it('does NOT emit the exchange name as a physical name', () => {
        const out = extractSymfonyMessengerSymbols(SERVICES);
        expect(out.some(b => b.physicalName === 'orders_exchange')).toBe(false);
    });

    it('ignores plain (non-messenger) service registrations', () => {
        const out = extractSymfonyMessengerSymbols(SERVICES);
        expect(out.find(b => b.diKey === 'amqp.connection')).toBeUndefined();
    });

    it('returns nothing for a file without messenger tags', () => {
        expect(extractSymfonyMessengerSymbols('<?php return [];')).toEqual([]);
    });
});
