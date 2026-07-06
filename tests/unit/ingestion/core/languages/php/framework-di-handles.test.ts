import { describe, it, expect } from 'vitest';
import { phpRecognizesFrameworkDiHandle } from '../../../../../../src/ingestion/core/languages/php/framework-di-handles.js';
import { PHPPlugin } from '../../../../../../src/ingestion/core/languages/php.js';

// ═════════════════════════════════════════════════════════════════════════════
// PHP framework DI-handle recognition (plugin-owned grammar)
//
// Published Symfony/Doctrine/Laminas conventions: a dotted id whose first
// segment is a framework DI namespace (`doctrine.entitymanager.orm_default`),
// a Laminas RabbitMqModule service alias (`rabbitmq.producer.<name>`), or a
// Symfony Messenger transport handle (`email_direct_transport`) is a DI
// HANDLE, never a physical channel/table.
//
// This knowledge is PHP-ecosystem grammar and lives HERE, not in the
// language-agnostic name-safety module: a Node.js service may legitimately
// own a Kafka topic named `messenger.events.dispatched` or a table named
// `shipment_transport` — only the PHP plugin may reject these shapes.
// ═════════════════════════════════════════════════════════════════════════════

describe('phpRecognizesFrameworkDiHandle — framework DI namespaces (both kinds)', () => {
    it.each([
        'doctrine.entitymanager.orm_default',
        'doctrine.authenticationservice.orm_default',
        'messenger.bus.command',
        'messenger.transport.async',
        'cache.provider.default',
        'serializer.normalizer.object',
    ])('recognizes framework DI id %s as channel AND container', (n) => {
        expect(phpRecognizesFrameworkDiHandle(n, 'channel')).toBe(true);
        expect(phpRecognizesFrameworkDiHandle(n, 'container')).toBe(true);
    });

    it.each([
        'inventory.orders',               // schema-qualified table
        'order.events',                   // Mongo collection / routing key
        'acme.catalog.delete.request',    // domain routing key
        'doctrine',                       // single token, no namespace evidence
        'cache_acl',                      // underscore, not a dotted DI namespace
        'ha.messenger_normal',            // real exchange, "messenger" not first segment
    ])('keeps non-framework name %s for both kinds', (n) => {
        expect(phpRecognizesFrameworkDiHandle(n, 'channel')).toBe(false);
        expect(phpRecognizesFrameworkDiHandle(n, 'container')).toBe(false);
    });
});

describe('phpRecognizesFrameworkDiHandle — channel-only module conventions', () => {
    it.each([
        'rabbitmq.producer.calls',
        'rabbitmq.consumer.import_shipments',
        'RabbitMQ.Producer.orders', // module aliases are case-insensitive
    ])('recognizes Laminas RabbitMqModule alias %s as channel', (n) => {
        expect(phpRecognizesFrameworkDiHandle(n, 'channel')).toBe(true);
    });

    it.each([
        'email_direct_transport',
        'email_queue_transport',
        'async_transport',
    ])('recognizes Messenger transport handle %s as channel', (n) => {
        expect(phpRecognizesFrameworkDiHandle(n, 'channel')).toBe(true);
    });

    it('does NOT reject *_transport as container (shipment_transport is a plausible table)', () => {
        expect(phpRecognizesFrameworkDiHandle('shipment_transport', 'container')).toBe(false);
        expect(phpRecognizesFrameworkDiHandle('email_direct_transport', 'container')).toBe(false);
    });

    it('does NOT reject rabbitmq module aliases as container (channel-scoped convention)', () => {
        expect(phpRecognizesFrameworkDiHandle('rabbitmq.producer.calls', 'container')).toBe(false);
    });
});

describe('phpRecognizesFrameworkDiHandle — container-only Doctrine handle segments', () => {
    it.each([
        'inventory.entitymanager',
        'orders.documentmanager',
        'archive.mongodb.documentmanager',
    ])('recognizes Doctrine accessor key %s as container handle', (n) => {
        expect(phpRecognizesFrameworkDiHandle(n, 'container')).toBe(true);
    });

    it('does NOT apply Doctrine handle segments to channels or bare tokens', () => {
        expect(phpRecognizesFrameworkDiHandle('inventory.entitymanager', 'channel')).toBe(false);
        expect(phpRecognizesFrameworkDiHandle('entitymanager', 'container')).toBe(false); // bare brand → GENERIC_INFRA_NAMES territory
        expect(phpRecognizesFrameworkDiHandle('inventory.orders', 'container')).toBe(false);
    });
});

describe('PHPPlugin wiring', () => {
    it('exposes recognizesFrameworkDiHandle delegating to the predicate', () => {
        const plugin = new PHPPlugin();
        expect(plugin.recognizesFrameworkDiHandle?.('doctrine.entitymanager.orm_default', 'container')).toBe(true);
        expect(plugin.recognizesFrameworkDiHandle?.('acme_orders', 'container')).toBe(false);
        expect(plugin.recognizesFrameworkDiHandle?.('email_direct_transport', 'channel')).toBe(true);
    });
});
